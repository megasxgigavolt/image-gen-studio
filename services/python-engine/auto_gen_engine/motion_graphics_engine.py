"""
Auto Gen Studio internal motion-graphics selection engine.

Assigns each timeline clip one of the 7 catalog motion-graphic treatments
(see services/motion-engine for the Remotion components that actually render
them, and SOPs/Motion_Graphics_SOP_v1.md for the full effect reference) using
a single OpenAI vision-capable model call per batch of clips.

Design goals this engine exists to satisfy (see git history / SOP for the
"why"): the previous per-clip, image-only, single-call-with-no-shared-context
implementation converged heavily onto "Ken Burns" because (a) the prompt
named it the default, (b) it never saw the clip's own narration, and (c) it
had no idea what any other clip in the same video had already been assigned.
This engine batches clips together, sends each clip's image *and* its
narration text together, and carries a running tally of effects already used
so far in the video into every subsequent batch's prompt so the model can
actively avoid over-repeating one treatment.

Install:

    pip install openai pydantic python-dotenv

Environment:

    OPENAI_API_KEY=your_key

Usage:

    python motion_graphics_engine.py manifest.json --output results.json
    python motion_graphics_engine.py manifest.json --output results.json --ai-model gpt-5.4 --batch-size 8
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Literal, Optional

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

from ai_client import (
    DEFAULT_GEMINI_MODEL,
    get_gemini_client,
    get_openai_client,
    parse_structured_vision,
    parse_structured_vision_gemini,
)
from scene_grouping_engine import report_progress

# Vision calls are token-heavy (one image per clip in the batch) — this stays
# small enough that a batch still completes in a handful of seconds, while
# still being large enough for the running-tally diversity mechanism (see
# module docstring) to have enough clips in view to actually balance across.
DEFAULT_BATCH_SIZE = 8

DEFAULT_MODEL = "gpt-5.4"

EffectName = Literal[
    "Ken Burns",
    "Sequential Panel Reveal",
    "Speed Pan & Motion Blur",
    "Ominous Push-In",
    "Candlelight Flicker",
    "Focus Pull",
    "Iris Reveal",
]

EFFECT_NAMES: tuple[str, ...] = (
    "Ken Burns",
    "Sequential Panel Reveal",
    "Speed Pan & Motion Blur",
    "Ominous Push-In",
    "Candlelight Flicker",
    "Focus Pull",
    "Iris Reveal",
)


def _import_pydantic():
    try:
        from pydantic import BaseModel, Field
    except ImportError:
        print("\nError: pydantic is not installed.")
        print("Run: pip install pydantic\n")
        sys.exit(1)
    return BaseModel, Field


BaseModel, Field = _import_pydantic()


class PanelRect(BaseModel):
    x: float = Field(ge=0, le=1)
    y: float = Field(ge=0, le=1)
    w: float = Field(ge=0, le=1)
    h: float = Field(ge=0, le=1)


class ClipMotionAnalysis(BaseModel):
    """
    Flat, all-fields-present shape rather than a discriminated union — OpenAI
    structured outputs' strict mode requires every property to be present in
    `required` (optionality comes from unioning with null, via `Optional`),
    and a polymorphic settings object per effect is much less reliable to
    parse correctly under strict mode than one flat shape where irrelevant
    fields for a given effect are simply left null. `settings_from_analysis`
    below picks out only the fields the assigned effect actually uses.
    """

    clip_id: str
    effect: EffectName
    reason: str

    # Ken Burns / Speed Pan & Motion Blur (also used as generic scale range
    # for Focus Pull / Iris Reveal's accompanying push)
    scale_from: Optional[float] = None
    scale_to: Optional[float] = None
    pan_x: Optional[float] = None
    pan_y: Optional[float] = None
    pan_x_from: Optional[float] = None
    pan_x_to: Optional[float] = None

    # Sequential Panel Reveal
    hold_start_frames: Optional[float] = None
    crop_padding: Optional[float] = None
    panels: Optional[list[PanelRect]] = None

    # Ominous Push-In / Candlelight Flicker / Focus Pull (subject anchor)
    transform_origin_x: Optional[float] = None
    transform_origin_y: Optional[float] = None
    glow_color: Optional[str] = None
    glow_x: Optional[float] = None
    glow_y: Optional[float] = None
    flicker_amplitude: Optional[float] = None

    # Focus Pull
    start_blur_px: Optional[float] = None
    end_blur_px: Optional[float] = None
    mask_radius: Optional[float] = None

    # Iris Reveal
    reveal_x: Optional[float] = None
    reveal_y: Optional[float] = None
    start_radius: Optional[float] = None
    end_radius: Optional[float] = None
    hold_before_frames: Optional[float] = None


class BatchMotionResult(BaseModel):
    analyses: list[ClipMotionAnalysis]


SYSTEM_PROMPT_TEMPLATE = """You are selecting a camera-movement treatment for a batch of stills that will \
become short video clips in the same faceless YouTube video. For EACH clip you are given \
its still image AND the narration sentence(s) that will play while it's on screen \
— use both together. The image tells you what's physically in frame; the narration tells you \
the tone, pacing, and emotional weight of the moment. The same image (e.g. a calm portrait) \
can call for a different treatment depending on whether the narration over it is expository \
and calm versus tense and dramatic.

THE 7 TREATMENTS

1. Ken Burns — push-in + diagonal pan. Fits: dialogue/two-subject scenes, calm expository \
narration, any shot with clear foreground/background separation and no stronger reason below \
to pick something else.
   fields: scale_from (~1.0-1.2), scale_to (~1.2-1.5, > scale_from), pan_x (percent, -4 to 4), \
pan_y (percent, -3 to 3)

2. Sequential Panel Reveal — snap-zooms between sub-panels of a single grid/contact-sheet \
image. ONLY pick this if the image is ITSELF a grid of multiple distinct smaller scenes \
(a recap montage, a contact sheet) — never for a normal single-scene photo/illustration. You \
must also return `panels`: the bounding box of each sub-panel in the grid, in reading order \
(left-to-right, top-to-bottom), as fractions (0-1) of the full image's width/height.
   fields: hold_start_frames (~10-30), crop_padding (~1.05-1.2), panels (list of {{x,y,w,h}} \
fractions, one per sub-panel)

3. Speed Pan & Motion Blur — fast horizontal drift with directional blur and ghost trails. \
Fits: riders/runners/marching subjects, chases, urgent/fast-paced narration, anything with an \
implied direction of travel. The pan direction must match the subject's facing/travel \
direction — sign encodes direction (positive-to-negative pan_x_from/to is left-to-right).
   fields: scale_from (~1.1-1.2), scale_to (~1.2-1.4), pan_x_from (percent), pan_x_to (percent)

4. Ominous Push-In — slow push-in with desaturation and a warm/red pulsing glow. Fits: single \
dramatic/mysterious portraits, masked/obscured figures, tense or foreboding narration, a \
character study moment.
   fields: scale_from (~1.1-1.2), scale_to (~1.35-1.45), transform_origin_x (percent 0-100, \
subject's face, horizontal), transform_origin_y (percent 0-100, vertical), glow_color (css \
rgba string tuned to the image's palette, e.g. "rgba(196,84,79,0.55)")

5. Candlelight Flicker — near-static framing with an organic warm-light flicker anchored at a \
fixed point. ONLY pick this if a flame or clearly motivated warm point-light source (candle, \
torch, hearth) is actually visible in the image — never as a generic "cozy" pick.
   fields: glow_x (fraction 0-1, the light source's position), glow_y (fraction 0-1), \
scale_from (~1.03-1.08), scale_to (~1.1-1.2), transform_origin_x (percent 0-100), \
transform_origin_y (percent 0-100), flicker_amplitude (~0.1-0.2)

6. Focus Pull — a soft, blurred wide view racks into sharp focus on the subject (depth-of-field \
push, no cutout needed). Fits: a moment of realization, a detail being called out by the \
narration, "and then I noticed..." beats, introducing a specific character/object within a \
busier scene.
   fields: transform_origin_x (percent 0-100, subject position), transform_origin_y (percent \
0-100), start_blur_px (~10-20, how blurred the wide view starts), end_blur_px (~0-2, sharp by \
the end), mask_radius (~0.2-0.45, fraction of the frame diagonal the sharp circle grows to), \
scale_from (~1.02-1.08), scale_to (~1.08-1.18)

7. Iris Reveal — a circular wipe opens over the subject, revealing the frame from a point \
outward. Fits: an unveiling/presentation beat ("behold...", an object or place being shown \
off), a dramatic entrance, a reveal the narration is building toward — NOT a default/neutral \
choice, only when the moment is genuinely a reveal.
   fields: reveal_x (fraction 0-1, iris center), reveal_y (fraction 0-1), start_radius \
(~0-0.05, fraction of frame diagonal), end_radius (~0.75-1.0), hold_before_frames (~5-15), \
scale_from (~1.0-1.05), scale_to (~1.05-1.15)

OUTPUT DISCIPLINE

Judge every clip independently on its own image + narration content — there is no default or \
"safest" treatment among the 7; pick whichever one the content actually calls for. Only fill \
in the fields that belong to the effect you actually chose for that clip; leave every other \
field null. `reason` is one short sentence citing BOTH the visual content and the narration \
tone that led to this pick.

DIVERSITY

{diversity_context}

A good video mixes treatments according to what each moment actually calls for. Repeating the \
same treatment for many consecutive clips reads as repetitive and lazy — if two consecutive \
clips could plausibly take more than one treatment, prefer the one that hasn't been used \
recently over the one that has, but never force a treatment that doesn't fit just to hit a \
quota. Return exactly one analysis per clip_id you were given, in the same order."""


def _no_prior_context() -> str:
    return (
        "This is the first batch of clips for this video — no treatments have been assigned "
        "yet, so there is nothing to balance against yet."
    )


def _prior_context(tally: dict[str, int], last_effects: list[str]) -> str:
    counted = ", ".join(f"{name}: {count}" for name, count in tally.items() if count > 0)
    counted = counted or "none yet"
    recent = ", ".join(last_effects[-4:]) or "none yet"
    return (
        f"Treatments already assigned earlier in this same video so far — counts: {counted}. "
        f"Most recent clips (oldest to newest): {recent}. Take this into account so the overall "
        "mix across the whole video reflects genuine content fit rather than convenience."
    )


def _clip_content_blocks(clips: list[dict]) -> list[dict]:
    blocks: list[dict] = []
    for clip in clips:
        narration = clip.get("narration", "").strip() or "(no narration text available)"
        start = clip.get("startSeconds", 0.0)
        end = clip.get("endSeconds", 0.0)
        blocks.append({
            "type": "input_text",
            "text": (
                f"Clip {clip['clipId']} (t={start:.1f}s-{end:.1f}s). "
                f"Narration playing during this clip: \"{narration}\""
            ),
        })
        blocks.append({
            "type": "input_image",
            "image_url": f"data:{clip['mime']};base64,{clip['base64Data']}",
        })
    return blocks


def analyze_batch(
    openai_client,
    gemini_client,
    gemini_client_error: Exception | None,
    ai_model: str,
    clips: list[dict],
    tally: dict[str, int],
    last_effects: list[str],
) -> BatchMotionResult:
    diversity_context = (
        _no_prior_context() if not last_effects else _prior_context(tally, last_effects)
    )
    system_prompt = SYSTEM_PROMPT_TEMPLATE.format(diversity_context=diversity_context)

    header = {
        "type": "input_text",
        "text": (
            f"{len(clips)} clips follow, each as one text block (its id, narration, timing) "
            "immediately followed by its image."
        ),
    }
    content_blocks = [header, *_clip_content_blocks(clips)]

    # OpenAI is preferred (see module docstring for why); Gemini is the last resort,
    # only reached if OpenAI itself is unconfigured or its call fails (rate limit,
    # exhausted billing credits) — mirrors the same pattern used throughout the Rust
    # side (projects.rs) for exactly the same reason.
    openai_error: Exception | None = None
    if openai_client is not None:
        try:
            result = parse_structured_vision(
                client=openai_client,
                model=ai_model,
                system_prompt=system_prompt,
                content_blocks=content_blocks,
                response_model=BatchMotionResult,
                temperature=0.9,
            )
            return _validate_batch_coverage(result, clips)
        except Exception as error:  # noqa: BLE001 - genuinely any failure should fall back
            openai_error = error

    if gemini_client is not None:
        try:
            result = parse_structured_vision_gemini(
                client=gemini_client,
                model=DEFAULT_GEMINI_MODEL,
                system_prompt=system_prompt,
                content_blocks=content_blocks,
                response_model=BatchMotionResult,
                temperature=0.9,
            )
            return _validate_batch_coverage(result, clips)
        except Exception as error:  # noqa: BLE001
            if openai_error is not None:
                raise RuntimeError(
                    f"{openai_error} (Gemini fallback also failed: {error})"
                ) from error
            raise

    assert openai_error is not None  # only reachable if openai_client was set and failed, with no Gemini configured
    if gemini_client_error is not None:
        # This is the case that was previously a silent dead end: Gemini never got a
        # chance to even try because building its client failed, and the reason why
        # was being swallowed in run() — so a real, fixable Gemini-side problem looked
        # identical to "Gemini isn't configured at all".
        raise RuntimeError(
            f"{openai_error} (Gemini fallback unavailable: {gemini_client_error})"
        ) from openai_error
    raise openai_error


def _validate_batch_coverage(result: BatchMotionResult, clips: list[dict]) -> BatchMotionResult:
    expected_ids = [clip["clipId"] for clip in clips]
    returned_ids = [item.clip_id for item in result.analyses]
    if returned_ids != expected_ids:
        raise RuntimeError(
            f"Motion-graphics batch coverage is invalid. Expected {expected_ids}, "
            f"received {returned_ids}."
        )
    return result


def settings_from_analysis(analysis: ClipMotionAnalysis) -> dict:
    """Picks out only the camelCase fields the assigned effect actually uses,
    matching the settings shape services/motion-engine's Remotion components
    and apps/desktop's MOTION_GRAPHIC_EFFECTS metadata expect."""
    effect = analysis.effect
    if effect == "Ken Burns":
        return {
            "scaleFrom": analysis.scale_from if analysis.scale_from is not None else 1.08,
            "scaleTo": analysis.scale_to if analysis.scale_to is not None else 1.28,
            "panX": analysis.pan_x if analysis.pan_x is not None else -4.0,
            "panY": analysis.pan_y if analysis.pan_y is not None else 2.0,
        }
    if effect == "Sequential Panel Reveal":
        return {
            "holdStartFrames": analysis.hold_start_frames if analysis.hold_start_frames is not None else 20.0,
            "cropPadding": analysis.crop_padding if analysis.crop_padding is not None else 1.12,
            "panels": [panel.model_dump() for panel in (analysis.panels or [])],
        }
    if effect == "Speed Pan & Motion Blur":
        return {
            "scaleFrom": analysis.scale_from if analysis.scale_from is not None else 1.15,
            "scaleTo": analysis.scale_to if analysis.scale_to is not None else 1.3,
            "panXFrom": analysis.pan_x_from if analysis.pan_x_from is not None else 6.0,
            "panXTo": analysis.pan_x_to if analysis.pan_x_to is not None else -10.0,
        }
    if effect == "Ominous Push-In":
        return {
            "scaleFrom": analysis.scale_from if analysis.scale_from is not None else 1.15,
            "scaleTo": analysis.scale_to if analysis.scale_to is not None else 1.4,
            "transformOriginX": analysis.transform_origin_x if analysis.transform_origin_x is not None else 50.0,
            "transformOriginY": analysis.transform_origin_y if analysis.transform_origin_y is not None else 38.0,
            "glowColor": analysis.glow_color or "rgba(196,84,79,0.55)",
        }
    if effect == "Candlelight Flicker":
        return {
            "glowX": analysis.glow_x if analysis.glow_x is not None else 0.5,
            "glowY": analysis.glow_y if analysis.glow_y is not None else 0.2,
            "scaleFrom": analysis.scale_from if analysis.scale_from is not None else 1.05,
            "scaleTo": analysis.scale_to if analysis.scale_to is not None else 1.16,
            "transformOriginX": analysis.transform_origin_x if analysis.transform_origin_x is not None else 50.0,
            "transformOriginY": analysis.transform_origin_y if analysis.transform_origin_y is not None else 50.0,
            "flickerAmplitude": analysis.flicker_amplitude if analysis.flicker_amplitude is not None else 0.15,
        }
    if effect == "Focus Pull":
        return {
            "transformOriginX": analysis.transform_origin_x if analysis.transform_origin_x is not None else 50.0,
            "transformOriginY": analysis.transform_origin_y if analysis.transform_origin_y is not None else 50.0,
            "startBlurPx": analysis.start_blur_px if analysis.start_blur_px is not None else 14.0,
            "endBlurPx": analysis.end_blur_px if analysis.end_blur_px is not None else 0.0,
            "maskRadius": analysis.mask_radius if analysis.mask_radius is not None else 0.3,
            "scaleFrom": analysis.scale_from if analysis.scale_from is not None else 1.05,
            "scaleTo": analysis.scale_to if analysis.scale_to is not None else 1.14,
        }
    if effect == "Iris Reveal":
        return {
            "revealX": analysis.reveal_x if analysis.reveal_x is not None else 0.5,
            "revealY": analysis.reveal_y if analysis.reveal_y is not None else 0.5,
            "startRadius": analysis.start_radius if analysis.start_radius is not None else 0.02,
            "endRadius": analysis.end_radius if analysis.end_radius is not None else 0.9,
            "holdBeforeFrames": analysis.hold_before_frames if analysis.hold_before_frames is not None else 8.0,
            "scaleFrom": analysis.scale_from if analysis.scale_from is not None else 1.02,
            "scaleTo": analysis.scale_to if analysis.scale_to is not None else 1.08,
        }
    raise RuntimeError(f"Unhandled effect: {effect}")


def run(manifest_path: Path, ai_model: str, batch_size: int) -> list[dict]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    clips: list[dict] = manifest["clips"]
    if not clips:
        return []

    openai_client = None
    openai_client_error: Exception | None = None
    try:
        openai_client = get_openai_client()
    except Exception as error:  # noqa: BLE001 - missing key/package should not be fatal if Gemini works
        openai_client_error = error

    gemini_client = None
    gemini_client_error: Exception | None = None
    try:
        gemini_client = get_gemini_client()
    except Exception as error:  # noqa: BLE001 - Gemini is optional; OpenAI alone is a valid setup
        gemini_client_error = error

    if openai_client is None and gemini_client is None:
        raise openai_client_error or gemini_client_error or RuntimeError(
            "Configure an OpenAI or Gemini API key to use Motion Graphics analysis."
        )

    batches = [clips[i : i + batch_size] for i in range(0, len(clips), batch_size)]

    tally: dict[str, int] = {name: 0 for name in EFFECT_NAMES}
    last_effects: list[str] = []
    output: list[dict] = []

    for batch_number, batch in enumerate(batches, start=1):
        report_progress(
            round(10 + 85 * (batch_number - 1) / len(batches)),
            "Analyzing motion graphics",
            f"Batch {batch_number} of {len(batches)} ({len(batch)} clips)",
        )
        result = analyze_batch(openai_client, gemini_client, gemini_client_error, ai_model, batch, tally, last_effects)
        for analysis in result.analyses:
            tally[analysis.effect] = tally.get(analysis.effect, 0) + 1
            last_effects.append(analysis.effect)
            output.append({
                "clipId": analysis.clip_id,
                "effect": analysis.effect,
                "settings": settings_from_analysis(analysis),
                "reason": analysis.reason,
            })

    report_progress(100, "Motion graphics analysis complete", f"{len(output)} clips assigned")
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description="Auto Gen Studio motion-graphics selection engine")
    parser.add_argument("manifest", type=Path, help="JSON manifest: {\"clips\": [...]}")
    parser.add_argument("--output", type=Path, required=True, help="Where to write the results JSON")
    parser.add_argument("--ai-model", default=DEFAULT_MODEL, help=f"Default: {DEFAULT_MODEL}")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    args = parser.parse_args()

    results = run(args.manifest, args.ai_model, args.batch_size)
    args.output.write_text(json.dumps({"analyses": results}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {len(results)} motion-graphic analyses to {args.output}", flush=True)


if __name__ == "__main__":
    main()
