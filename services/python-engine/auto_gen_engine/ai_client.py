"""
Shared OpenAI/Gemini client + structured-output parsing helpers.

Extracted out of scene_grouping_engine.py so motion_graphics_engine.py (and
any future AI-pass engine) doesn't duplicate this — both need the same
"get an authenticated client, then parse a Pydantic response model out of
the Responses API (falling back to the older structured Chat Completions
parser for compatible openai package versions)" logic.

Gemini support exists purely as a fallback for when OpenAI itself is down
(rate-limited, exhausted billing credits) — mirrors the same OpenAI-primary/
Gemini-last-resort pattern used throughout the Rust side (see projects.rs).
"""

from __future__ import annotations

import base64
import json
import os


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
