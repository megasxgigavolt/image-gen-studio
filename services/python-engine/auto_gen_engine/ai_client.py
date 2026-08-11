"""
Shared OpenAI/Gemini/Claude-CLI client + structured-output parsing helpers.

Extracted out of scene_grouping_engine.py so motion_graphics_engine.py (and
any future AI-pass engine) doesn't duplicate this — both need the same
"get an authenticated client, then parse a Pydantic response model out of
the Responses API (falling back to the older structured Chat Completions
parser for compatible openai package versions)" logic.

Gemini support exists purely as a fallback for when OpenAI itself is down
(rate-limited, exhausted billing credits) — mirrors the same OpenAI-primary/
Gemini-last-resort pattern used throughout the Rust side (see projects.rs).

Claude CLI support (`parse_structured_vision_claude_cli` below) is a third,
different kind of provider: it doesn't call a billed API at all. It shells
out to a locally installed, already-authenticated `claude` binary (Claude
Code) and rides whatever Claude subscription is already logged into it on
this machine — no ANTHROPIC_API_KEY, no separate bill. Deliberately never
passes `--bare` to the CLI, since bare mode requires its own API key and
refuses to read the OAuth/subscription session, which would defeat the
entire point of using it instead of paying for API access again.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path


def get_openai_client():
    try:
        from openai import OpenAI
    except ImportError as error:
        raise RuntimeError(
            "OpenAI is not installed. Run: pip install openai"
        ) from error

    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError(
            "OPENAI_API_KEY is not configured. Add it in Auto Gen Studio settings."
        )

    return OpenAI(timeout=120.0, max_retries=1)


def parse_structured(
    client,
    model: str,
    system_prompt: str,
    user_payload: dict | list,
    response_model,
    temperature: float | None = None,
):
    """
    Prefer the current Responses API parser. Fall back to the older structured
    Chat Completions parser for compatible openai package versions.

    `temperature` is only forwarded when set — reasoning-style models (o1/o3/
    etc.) reject the parameter entirely, so callers targeting one of those
    should simply leave it as None rather than this helper guessing per model
    name.
    """
    input_messages = [
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": json.dumps(user_payload, ensure_ascii=False),
        },
    ]

    responses_api = getattr(client, "responses", None)
    if responses_api is not None and hasattr(responses_api, "parse"):
        kwargs: dict = {"model": model, "input": input_messages, "text_format": response_model}
        if temperature is not None:
            kwargs["temperature"] = temperature
        response = responses_api.parse(**kwargs)
        parsed = getattr(response, "output_parsed", None)
        if parsed is None:
            raise RuntimeError("OpenAI returned no parsed structured output.")
        return parsed

    beta = getattr(client, "beta", None)
    if beta is not None:
        kwargs = {"model": model, "messages": input_messages, "response_format": response_model}
        if temperature is not None:
            kwargs["temperature"] = temperature
        response = beta.chat.completions.parse(**kwargs)
        parsed = response.choices[0].message.parsed
        if parsed is None:
            raise RuntimeError("OpenAI returned no parsed structured output.")
        return parsed

    raise RuntimeError(
        "The installed openai package does not support structured parsing. "
        "Upgrade it with: pip install --upgrade openai"
    )


def parse_structured_vision(
    client,
    model: str,
    system_prompt: str,
    content_blocks: list[dict],
    response_model,
    temperature: float | None = None,
):
    """
    Same as `parse_structured`, but for a single user turn built from mixed
    text/image content blocks (Responses API's `input_text`/`input_image`
    parts) instead of one JSON-serialized payload — what a vision call needs.
    """
    input_messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": content_blocks},
    ]

    responses_api = getattr(client, "responses", None)
    if responses_api is not None and hasattr(responses_api, "parse"):
        kwargs: dict = {"model": model, "input": input_messages, "text_format": response_model}
        if temperature is not None:
            kwargs["temperature"] = temperature
        response = responses_api.parse(**kwargs)
        parsed = getattr(response, "output_parsed", None)
        if parsed is None:
            raise RuntimeError("OpenAI returned no parsed structured output.")
        return parsed

    raise RuntimeError(
        "Vision structured parsing requires the Responses API "
        "(client.responses.parse) — upgrade the openai package."
    )


# Gemini's own image-generation-tuned models (e.g. gemini-3.1-flash-image) tend to
# narrate/describe rather than reliably return structured JSON for a task like this —
# same issue found on the Rust side (see gemini_text_model's comment in projects.rs).
# This is a plain analysis/JSON task, so a real text-and-vision model is what actually
# works here. "gemini-2.0-flash" (used on the Rust ApiKey path) is NOT available on
# every Vertex project — confirmed by directly probing this app's own configured Vertex
# project, which 404s on it — so this uses "gemini-2.5-flash" instead, confirmed
# available on both the Gemini API-key path and this app's actual Vertex project.
DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"


def get_gemini_client():
    """
    Mirrors the Rust side's `gemini_auth()` (see projects.rs) — prefer a plain API key,
    fall back to Vertex. The Vertex case is handled differently than a from-scratch ADC
    lookup would be: Rust already resolves Vertex auth successfully for every other
    Gemini call in this app (via a service-account JWT exchange), so rather than this
    engine independently re-deriving credentials from a file path it may not reliably
    have (relative paths, working-directory differences between processes), the Rust
    caller does that resolution once and hands over the *outcome* directly — either
    GEMINI_API_KEY, or a short-lived GEMINI_VERTEX_ACCESS_TOKEN + GEMINI_VERTEX_PROJECT_ID
    pair. The token is only valid for about an hour, but that comfortably covers one
    analysis run.
    """
    try:
        from google import genai
    except ImportError as error:
        raise RuntimeError(
            "google-genai is not installed. Run: pip install google-genai"
        ) from error

    api_key = os.environ.get("GEMINI_API_KEY")
    if api_key:
        return genai.Client(api_key=api_key)

    access_token = os.environ.get("GEMINI_VERTEX_ACCESS_TOKEN")
    project_id = os.environ.get("GEMINI_VERTEX_PROJECT_ID")
    if access_token and project_id:
        from google.oauth2.credentials import Credentials

        return genai.Client(
            vertexai=True,
            project=project_id,
            location="global",
            credentials=Credentials(token=access_token),
        )

    # Rust's own gemini_auth() call failed (e.g. Vertex OAuth exchange error) — that
    # reason is forwarded here rather than discarded, so this doesn't look identical to
    # "Gemini just isn't configured" when it's actually a specific, fixable problem.
    auth_error = os.environ.get("GEMINI_AUTH_ERROR")
    if auth_error:
        raise RuntimeError(f"Gemini authentication failed: {auth_error}")

    raise RuntimeError(
        "Configure a Gemini API key (or Vertex credentials) to use Gemini as a fallback."
    )


def parse_structured_vision_gemini(
    client,
    model: str,
    system_prompt: str,
    content_blocks: list[dict],
    response_model,
    temperature: float | None = None,
):
    """
    Gemini equivalent of `parse_structured_vision` — same content_blocks shape in
    (OpenAI Responses API's `input_text`/`input_image` parts), translated to Gemini's
    `Part` objects, with the same Pydantic `response_model` reused directly as Gemini's
    `response_schema` (the google-genai SDK parses it back out via `response.parsed`,
    same idea as OpenAI's `output_parsed`).
    """
    from google.genai import types

    parts = []
    for block in content_blocks:
        if block["type"] == "input_text":
            parts.append(types.Part.from_text(text=block["text"]))
        elif block["type"] == "input_image":
            header, _, b64data = block["image_url"].partition(",")
            mime_type = header.removeprefix("data:").split(";")[0]
            parts.append(types.Part.from_bytes(data=base64.b64decode(b64data), mime_type=mime_type))

    config_kwargs: dict = {
        "system_instruction": system_prompt,
        "response_mime_type": "application/json",
        "response_schema": response_model,
    }
    if temperature is not None:
        config_kwargs["temperature"] = temperature

    response = client.models.generate_content(
        model=model,
        contents=parts,
        config=types.GenerateContentConfig(**config_kwargs),
    )
    parsed = getattr(response, "parsed", None)
    if parsed is None:
        raise RuntimeError("Gemini returned no parsed structured output.")
    return parsed


def parse_structured_claude_cli(
    claude_path: str,
    system_prompt: str,
    user_payload: dict | list,
    response_model,
    timeout: float = 300.0,
    effort: str | None = "high",
    model: str | None = "sonnet",
):
    """
    Text-only counterpart to `parse_structured_vision_claude_cli`, matching
    `parse_structured`'s calling shape (a JSON-serializable payload, not
    content_blocks) for text-only passes like scene_grouping_engine.py's.
    The CLI has no separate "structured payload" concept distinct from the
    prompt text, so this just wraps `user_payload` as the one input_text
    block the vision helper already knows how to handle.
    """
    return parse_structured_vision_claude_cli(
        claude_path=claude_path,
        system_prompt=system_prompt,
        content_blocks=[
            {"type": "input_text", "text": json.dumps(user_payload, ensure_ascii=False)}
        ],
        response_model=response_model,
        timeout=timeout,
        effort=effort,
        model=model,
    )


def parse_structured_with_fallback(
    system_prompt: str,
    user_payload: dict | list,
    response_model,
    ai_model: str,
    claude_cli_path: str | None = None,
    temperature: float | None = None,
):
    """
    Provider order for text-only structured passes: a locally logged-in
    Claude Code CLI is tried first (no metered cost, rides an existing
    Claude subscription — same reasoning and order as motion_graphics_
    engine.py's vision passes), OpenAI is the fallback if the CLI isn't
    installed/logged in or the call fails. `claude_cli_path` is resolved
    automatically (one cheap `shutil.which` call) when not supplied — callers
    doing many batched calls per run may still pass a pre-resolved path to
    skip repeating that lookup, but it's optional.

    Raises with both failures reported (not just the last one) so it's clear
    which provider is actually worth fixing when neither works.
    """
    if claude_cli_path is None:
        claude_cli_path = get_claude_cli_path()

    claude_cli_error: Exception | None = None
    if claude_cli_path is not None:
        try:
            return parse_structured_claude_cli(
                claude_path=claude_cli_path,
                system_prompt=system_prompt,
                user_payload=user_payload,
                response_model=response_model,
            )
        except Exception as error:  # noqa: BLE001 - genuinely any failure should fall back
            claude_cli_error = error

    try:
        return parse_structured(
            client=get_openai_client(),
            model=ai_model,
            system_prompt=system_prompt,
            user_payload=user_payload,
            response_model=response_model,
            temperature=temperature,
        )
    except Exception as openai_error:
        failure_notes = []
        if claude_cli_error is not None:
            failure_notes.append(f"Claude CLI: {claude_cli_error}")
        failure_notes.append(f"OpenAI: {openai_error}")
        raise RuntimeError(
            "No AI provider succeeded for this pass (" + "; ".join(failure_notes) + ")."
        ) from openai_error


def get_claude_cli_path() -> str | None:
    """Locates the Claude Code CLI binary on PATH, if any. Returns None (not
    an exception) when it's missing — unlike the OpenAI/Gemini client
    getters, "not installed" is an ordinary, expected state on most machines
    and should just fall through to whatever other providers are configured,
    not surface as a scary error."""
    return shutil.which("claude")


def parse_structured_vision_claude_cli(
    claude_path: str,
    system_prompt: str,
    content_blocks: list[dict],
    response_model,
    timeout: float = 300.0,
    effort: str | None = "high",
    model: str | None = "sonnet",
):
    """
    Claude Code CLI equivalent of `parse_structured_vision`/`_gemini`. Unlike
    those, this doesn't hold an API client — it shells out to `claude -p`
    per call, using whatever account is already logged into the CLI on this
    machine (subscription usage), not a metered API key.

    The CLI has no way to attach an inline image the way the OpenAI/Gemini
    SDKs do, so each base64 image block is decoded out to a temp file first
    and referenced by path in the prompt text; the only tool granted to the
    session (`Read`) is what actually loads it off disk on Claude's side.
    `--json-schema` (built directly from the Pydantic response_model, via
    `.model_json_schema()`) constrains the reply to a parseable shape,
    surfaced back here in the CLI's own `structured_output` response field.

    `effort` ("low"/"medium"/"high"/"xhigh"/"max", or None for the CLI's own
    default) is worth spending on this call specifically — motion-graphics
    selection is a real spatial/compositional judgment call (what's in the
    frame, where the subject actually is, what won't get cropped out by a
    given move), not a quick lookup, and it draws no metered cost here the
    way it would through a billed API, so there's no reason to default to a
    cheap pass.

    `model` is pinned to "sonnet" (the latest Claude Sonnet) rather than left
    to whatever the CLI session's own default happens to be — this call
    should always get a specific, known-good model regardless of what the
    user has their interactive CLI sessions set to elsewhere.
    """
    schema = response_model.model_json_schema()

    with tempfile.TemporaryDirectory(prefix="claude-cli-vision-") as tmp_dir:
        prompt_parts: list[str] = []
        for block in content_blocks:
            if block["type"] == "input_text":
                prompt_parts.append(block["text"])
            elif block["type"] == "input_image":
                header, _, b64data = block["image_url"].partition(",")
                mime_type = header.removeprefix("data:").split(";")[0]
                extension = mime_type.split("/")[-1] or "png"
                image_path = Path(tmp_dir) / f"{uuid.uuid4().hex}.{extension}"
                image_path.write_bytes(base64.b64decode(b64data))
                prompt_parts.append(f"[image: {image_path}]")

        args = [
            claude_path,
            "-p", "\n\n".join(prompt_parts),
            "--output-format", "json",
            "--tools", "Read",
            "--allowedTools", "Read",
            "--add-dir", tmp_dir,
            "--system-prompt", system_prompt,
            "--json-schema", json.dumps(schema),
            "--no-session-persistence",
        ]
        if effort:
            args += ["--effort", effort]
        if model:
            args += ["--model", model]

        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="utf-8",
        )

        if result.returncode != 0:
            raise RuntimeError(
                "Claude CLI exited with code "
                f"{result.returncode}: {(result.stderr or result.stdout).strip()[:500]}"
            )

        try:
            payload = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            raise RuntimeError(
                f"Claude CLI returned non-JSON output: {result.stdout[:500]}"
            ) from error

        if payload.get("is_error"):
            raise RuntimeError(f"Claude CLI reported an error: {payload.get('result')}")

        structured = payload.get("structured_output")
        if structured is None:
            # Older/edge-case runs can land the JSON back in `result` (a plain
            # string) instead of the dedicated field — still worth parsing
            # rather than treating as a hard failure.
            raw_result = payload.get("result")
            if isinstance(raw_result, str):
                try:
                    structured = json.loads(raw_result)
                except json.JSONDecodeError:
                    structured = None
        if structured is None:
            raise RuntimeError("Claude CLI returned no structured output.")

        return response_model.model_validate(structured)
