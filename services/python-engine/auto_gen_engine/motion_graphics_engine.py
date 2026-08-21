"""
Auto Gen Studio internal motion-graphics selection engine.

This engine composes the FIRST pass automatically, from a FIXED catalog
of named effects grouped into 5 tiers (camera, depth, transitions,
storytelling, environment — see SYSTEM_PROMPT_TEMPLATE for the full list),
and then checks its own work: every composed clip is actually rendered and
shown back to a vision pass (`_validate_and_revise`) that either passes it or
sends it back for a targeted revision, up to MAX_VALIDATION_ROUNDS times,
before it's accepted. This replaced an earlier version that let the AI
compose an unbounded free-form combination of primitives with no fixed
vocabulary and no way to check its own output — see git history on
`SYSTEM_PROMPT_TEMPLATE` and the old `treatment_name` free-text field if you
need that behavior for reference.

The composed recipe (`motion_graphic_settings_json`) can also be hand-edited
afterward per still, from the Timeline editor's Motion panel (see
`MotionSettingsPanel.tsx`) — a dropdown per categorical tier plus one shared
intensity slider. A manual edit only ever touches the stored recipe directly
and never re-runs through this module, so it skips the vision-QA loop above
by design (the same tradeoff the per-still image-settings dropdowns already
make elsewhere in the app).

For EACH clip, the composition pass sees its still image AND the narration
sentence(s) that play while it's on screen — the image tells you what's
physically in frame, the narration tells you tone/pacing/emotional weight.
Clips are batched together (see DEFAULT_BATCH_SIZE) with a running history of
what's already been composed earlier in the same video, so the mix varies
across a whole export instead of converging on one favorite effect.

Provider order: a locally logged-in Claude Code CLI is tried FIRST (see
`ai_client.parse_structured_vision_claude_cli`) — it rides an existing Claude
subscription instead of a metered API key, so this is the only one of the
three providers with no per-call cost. OpenAI is the fallback if the CLI
isn't installed/logged in or its call fails, and Gemini is the last resort
after that. The same order is used for the validator pass. scene_grouping_
engine.py's text-only passes use the same Claude-CLI-first, OpenAI-fallback
order (see `ai_client.parse_structured_with_fallback`), just without a Gemini
rung — there's no text-only Gemini structured-output helper yet.

Install:

    pip install openai pydantic python-dotenv

Environment (only needed as a fallback — see provider order above):

    OPENAI_API_KEY=your_key

Usage:

    python motion_graphics_engine.py manifest.json --output results.json
    python motion_graphics_engine.py manifest.json --output results.json --ai-model gpt-5.4 --batch-size 8
"""

from __future__ import annotations

import argparse
import base64
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Literal, Optional

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

from ai_client import (
    DEFAULT_GEMINI_MODEL,
    get_claude_cli_path,
    get_gemini_client,
    get_openai_client,
    parse_structured_vision,
    parse_structured_vision_claude_cli,
    parse_structured_vision_gemini,
)
from scene_grouping_engine import report_progress
from video_export_engine import MOTION_ENGINE_DIR, _ensure_motion_engine_ready, _resolve_node_bin, _subprocess_kwargs

# Vision calls are token-heavy (one image per clip in the batch) — kept small
# so each clip gets real, undiluted attention rather than being one of a
# crowd competing for the same response budget (a smaller batch measurably
# produces more varied, less "samey" results), while still being large enough
# for the diversity mechanism (see module docstring) to have recent history
# to actually vary against.
DEFAULT_BATCH_SIZE = 5

DEFAULT_MODEL = "gpt-5.4"

# How many extra composition attempts a clip gets after failing the validator
# once (see `_validate_and_revise`) — 2 means up to 3 total attempts (the
# original composition plus 2 targeted revisions) before whatever's on hand
# is accepted regardless, so one stubborn clip can't stall the whole run.
MAX_VALIDATION_ROUNDS = 2

Easing = Literal["linear", "ease", "easeIn", "easeOut", "cubic", "elastic"]
MaskShape = Literal["none", "circle", "linear-h", "linear-v"]
SpeedCurve = Literal["linear_pace", "punch_in_hold", "slow_fast_slow", "fast_start_ease_out"]

# Tier 1 — Core Camera Motion. One of these is picked for essentially every
# clip; "Motion Blur" and "Easy Ease/Spring" from the source list are
# realized as modifiers on top of whichever of these 7 is picked (the
# `motionBlurStrength`/`easing` fields below), not as their own effect names.
CameraEffect = Literal[
    "position_pan", "zoom_in", "zoom_out", "push_in", "pull_out",
    "camera_drift", "dynamic_reframing",
]
# Tier 2 — Depth & Realism. "none" is a completely valid, common choice —
# most clips don't need a depth effect on top of their camera move.
DepthEffect = Literal["none", "parallax_3d", "subject_separation", "depth_blur", "focus_shift", "motion_tracking"]
# Tier 3 — Scene Transitions. How THIS clip hands off to whatever plays next
# — matches services/motion-engine's sibling `apps/desktop/src-tauri/src/
# projects.rs`'s VALID_TRANSITIONS strings exactly (see that file) so no
# translation layer is needed between this engine's output and storage.
TransitionOut = Literal["cut", "fade", "cross-fade", "whip-pan", "zoom-blur", "blur-transition"]
# Tier 4 — Storytelling Effects. "none" is the common case — these are for
# a clip whose moment specifically calls for one, not a per-clip default.
StoryEffect = Literal["none", "speed_ramp", "freeze_frame", "mask_reveal", "track_matte", "path_animation"]
# Tier 5 — Environmental Effects. "none" is the common case.
EnvironmentEffect = Literal[
    "none", "dust", "smoke", "fog", "rain", "snow", "fire_embers", "floating_particles", "light_rays",
]


def _import_pydantic():
    try:
        from pydantic import BaseModel, ConfigDict, Field
        from pydantic.alias_generators import to_camel
    except ImportError:
        print("\nError: pydantic is not installed.")
        print("Run: pip install pydantic\n")
        sys.exit(1)
    return BaseModel, ConfigDict, Field, to_camel


BaseModel, ConfigDict, Field, to_camel = _import_pydantic()

# Every model below aliases its snake_case Python field names to the camelCase
# names services/motion-engine/src/types.ts and the desktop app's DB layer
# actually use — `.model_dump(by_alias=True)` (see `run()`) hands back exactly
# the JSON shape both of those already expect, with no hand-written
# snake->camel mapping table to keep in sync.
_CAMEL_CONFIG = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class PanPoint(BaseModel):
    """One waypoint of a Tier-4 `path_animation` route — same unit system as
    `panXFrom`/`panYFrom` (percent of frame, signed), just more than 2 of
    them instead of a single straight interpolation."""
    model_config = _CAMEL_CONFIG
    x: float
    y: float


class MotionRecipe(BaseModel):
    """
    One clip's full motion treatment: a required Tier-1 camera move plus
    optional Tier 2/4/5 effects layered on top, and a required Tier-3
    transition describing how the clip hands off to the next one. Every named
    effect is realized through a small set of continuous numeric dials
    (scale/pan/rotation/blur/mask/color/etc.) rather than a bespoke
    hand-coded component per effect — see services/motion-engine/src/
    MotionClip.tsx for exactly how each dial renders. This keeps the render
    engine small while still giving the AI a fixed, named vocabulary to
    select from (unlike the old free-form "compose anything" version — see
    module docstring).
    """

    model_config = _CAMEL_CONFIG

    clip_id: str
    reason: str = Field(
        description="One short sentence citing both the visual content and the narration tone that "
        "justifies the effect choices below."
    )

    # --- Tier 1: camera move (required) ---
    camera_effect: CameraEffect = "push_in"
    scale_from: float = 1.05
    scale_to: float = 1.2
    pan_x_from: float = 0.0
    pan_x_to: float = 0.0
    pan_y_from: float = 0.0
    pan_y_to: float = 0.0
    rotation_from_deg: float = 0.0
    rotation_to_deg: float = 0.0
    origin_x: float = 50.0
    origin_y: float = 50.0
    easing: Easing = "ease"
    motion_blur_strength: float = 0.0
    shake_amount: float = 0.0
    # A constant extra zoom-in, held flat for the whole clip (no
    # interpolation) — unlike camera_effect/scale_from/scale_to above, which
    # are always a MOVE over time. Multiplies on top of whatever the dynamic
    # camera move computes each frame (see MotionClip.tsx), so the two
    # compose: e.g. a 20% static zoom under a zoom_in that already goes
    # 1.0->1.1 reads as 1.2->1.32. 0 = no static zoom (the default — Auto
    # Motion never sets this itself today, it's a manual per-still dial in
    # MotionSettingsPanel).
    static_zoom_percent: float = 0.0

    # --- Subject anchor: always marked (not just when a depth effect is
    # used) — a fractional bounding box around the actual main subject/focal
    # point, informing origin/pan choices and, when a depth effect is active,
    # which pixels get cut out into the foreground layer. ---
    subject_region_x: float = 0.3
    subject_region_y: float = 0.25
    subject_region_w: float = 0.4
    subject_region_h: float = 0.5

    # --- Tier 2: depth & realism (optional) ---
    depth_effect: DepthEffect = "none"
    fg_scale_from: float = 1.0
    fg_scale_to: float = 1.0
    fg_pan_x_from: float = 0.0
    fg_pan_x_to: float = 0.0
    fg_pan_y_from: float = 0.0
    fg_pan_y_to: float = 0.0
    bg_blur_from_px: float = 0.0
    bg_blur_to_px: float = 0.0
    subject_mask_softness: float = 0.35
    blur_from_px: float = 0.0  # whole-frame focus pull — also used by Tier-4 focus_shift
    blur_to_px: float = 0.0

    # --- Tier 3: transition out (required — how this clip hands off) ---
    transition_out: TransitionOut = "cut"
    whip_direction: Literal["left", "right"] = "left"

    # --- Tier 4: storytelling (optional) ---
    story_effect: StoryEffect = "none"
    mask_shape: MaskShape = "none"
    mask_from_radius: float = 0.0
    mask_to_radius: float = 1.0
    mask_x: float = 0.5
    mask_y: float = 0.5
    mask_hold_frames: float = 0.0
    mask_softness: float = 0.3
    freeze_at_progress: float = 0.5
    freeze_hold_frames: float = 20.0
    path_points: Optional[list[PanPoint]] = None
    speed_curve: SpeedCurve = "linear_pace"

    # --- Tier 5: environment (optional) ---
    environment_effect: EnvironmentEffect = "none"
    environment_intensity: float = 0.35

    # --- Color / light ---
    saturation_from: float = 1.0
    saturation_to: float = 1.0
    glow_color: Optional[str] = None
    glow_x: float = 0.5
    glow_y: float = 0.5
    glow_opacity: float = 0.0
    glow_flicker: float = 0.0
    vignette: float = 0.15

    # --- Envelope ---
    fade_in_frames: float = 14.0
    fade_out_frames: float = 14.0


class BatchMotionResult(BaseModel):
    analyses: list[MotionRecipe]


class MotionValidation(BaseModel):
    """The validator's verdict on one rendered clip — see
    VALIDATOR_SYSTEM_PROMPT for exactly what it's checking for."""
    model_config = _CAMEL_CONFIG
    valid: bool
    issues: list[str] = Field(default_factory=list)
    revision_instructions: str = ""


SYSTEM_PROMPT_TEMPLATE = """You are composing a camera-movement treatment for a batch of stills that will \
become short video clips in the same faceless YouTube video. For EACH clip you are given its still \
image AND the narration sentence(s) that will play while it's on screen — use both together. The \
image tells you what's physically in frame; the narration tells you the tone, pacing, and emotional \
weight of the moment.

You choose from a FIXED catalog of named effects, grouped into 5 tiers. Tier 1 is required for every \
clip; Tiers 2, 4, and 5 default to "none" and should stay "none" unless a clip genuinely calls for \
them; Tier 3 is required (it says how this clip hands off to the next one).

TIER 1 — CAMERA MOVE (cameraEffect, required, pick exactly one):
As a default assumption keep the scale delta (|scaleTo - scaleFrom|) modest — roughly 0.03-0.15 reads \
as a calm, subtle push/pull that matches ordinary B-roll; only reach for something larger when the \
narration genuinely calls for a dramatic move (and even then, stay well under the hard ceiling).
- "position_pan": a lateral move across the frame — panXFrom/To and/or panYFrom/To carry the motion, \
scale stays close to flat (a small scale bump is fine, just don't let it dominate).
- "zoom_in": scaleFrom < scaleTo, pan mostly flat — a simple, steady push toward the subject.
- "zoom_out": scaleFrom > scaleTo (e.g. 1.12 -> 1.0), pan mostly flat — a pull-back reveal. Use this a \
fair amount of the time, not just zoom_in by default.
- "push_in": like zoom_in but a bit stronger, combined with a small pan toward wherever the subject \
actually is (originX/Y anchored on the subject region below) — reads more deliberate/purposeful than \
a plain zoom_in.
- "pull_out": like zoom_out but starting tighter and pulling back further — reads like a reveal of \
context the viewer didn't have yet.
- "camera_drift": very slow, small scale+pan movement with no strong single direction — for a quiet, \
ambient beat that still shouldn't be frozen.
- "dynamic_reframing": a meaningful pan AND scale change together, ending with the subject recentered \
differently than where it started — reads like the camera is actively recomposing the shot, not just \
zooming.
Always set: panXFrom/To, panYFrom/To (percent of frame, signed), rotationFromDeg/To (keep small, a few \
degrees, unless a dramatic tilt genuinely fits), originX/Y (percent 0-100 — the pivot point; anchor \
this ON the subject region below, not blindly at 50/50), easing (linear/ease/easeIn/easeOut/cubic/ \
elastic — "Easy Ease/Spring" from the brief; pick something other than the plain default when the \
pacing calls for it). motionBlurStrength (0 = none; >0 adds directional blur + faint ghost-trail \
layers peaking mid-move — the brief's "Motion Blur," a modifier on top of any of the 7 moves above, \
fits riders/runners/chases/urgent narration) and shakeAmount (0 = none; >0 subtle handheld jitter) are \
optional modifiers on top of whichever move you picked, not effects of their own.

FRAMING SAFETY — a strong scale+pan combination can push the subject outside the visible frame by the \
end of the move; this is a real failure, not a stylistic choice. If pushing in a lot (scaleTo above \
roughly 1.3), keep panning modest. If panning a meaningful distance, keep the zoom generous rather than \
close to 1.0 — a big pan at a small scale runs the source image off the edge of the frame partway \
through, which looks like the picture got cut off. The renderer nudges scale up automatically as a \
last-resort net if a combination would do this, but a well-chosen recipe shouldn't need to rely on \
that. Look at where the subject actually is before choosing origin/pan/subjectRegion — never let the \
combination end with the subject cropped out or pushed to the very edge of frame.

SUBJECT REGION (subjectRegionX/Y/W/H, always set, fractional 0-1 of the full image): a bounding box \
around the actual main subject or focal point of THIS image. Set this even when you're not using a \
Tier-2 depth effect — it's what "look at where the subject actually is" above means concretely, and it \
directly feeds Tier 2 below when you do use one.

TIER 2 — DEPTH & REALISM (depthEffect, optional, default "none" — most clips should leave this "none"; \
reach for one when the shot has an actual foreground subject distinct from its background):
- "none": skip this tier entirely (still set the subject region above regardless).
- "parallax_3d": the foreground subject moves/scales at a noticeably DIFFERENT rate than the \
background, simulating depth. Set fgScaleFrom/To and fgPanXFrom/To/fgPanYFrom/To to a clearly \
different rate than the base scale/pan above (e.g. background moves ~60% as much as the foreground, or \
vice versa) — the difference is what reads as depth, not the direction.
- "subject_separation": similar to parallax but subtler — a small fg/bg differential plus a touch of \
bgBlurFromPx/To to visually pop the subject off the background.
- "depth_blur": fg and bg share the SAME base camera move (leave fgScale/fgPan equal to the base scale/ \
pan above), but bgBlurFromPx/To ramps the background out of focus while the subject stays sharp — a \
shallow-depth-of-field look.
- "focus_shift": no fg/bg split needed — use blurFromPx/blurToPx (whole-frame) to rack focus in or out \
over the clip.
- "motion_tracking": keep the subject essentially locked in the same on-screen position throughout — \
choose originX/Y at the subject region's center and keep panXFrom/To, panYFrom/To close together (the \
move should be mostly a scale change, not a drift) so the subject doesn't wander across frame even as \
the camera moves.
subjectMaskSoftness (0-1, default 0.35) softens the foreground cutout edge for parallax_3d/ \
subject_separation/depth_blur — keep it generous (0.3+) since this is an approximate cutout, not true \
segmentation; a hard edge reads as an obvious rectangle.

TIER 3 — TRANSITION OUT (transitionOut, required — how THIS clip hands off to the NEXT clip in the \
video; the very last clip's value is ignored automatically):
- "cut": a hard cut, no blending. The default, most common choice — use this unless there's a specific \
reason for something softer or more dramatic.
- "fade": this clip fades to black at its own end (and the next fades in from black) — a clean beat \
break, good between distinct sections/topics.
- "cross-fade": the two clips visually dissolve into each other — good when consecutive clips are the \
same scene/subject continuing, or a smooth mood-preserving handoff.
- "whip-pan": a fast, energetic blur-pan handoff — for a high-energy, quick-cut moment; overusing this \
reads as frantic, so reach for it rarely.
- "zoom-blur": the incoming clip zooms in while dissolving — a punchy, attention-grabbing handoff for a \
reveal or a beat change.
- "blur-transition": a softer, slower blur dissolve — good for a dreamy/contemplative scene change.
Across a whole video, "cut" and "fade" should be the large majority — the other four are accents for \
moments that specifically call for them, not a rotation to cycle through. whipDirection ("left"/ \
"right") only matters when transitionOut is "whip-pan".

TIER 4 — STORYTELLING EFFECTS (storyEffect, optional, default "none" — only use one when the specific \
moment calls for it, most clips should be "none"):
- "none": skip this tier.
- "mask_reveal": a shape wipes the image into (or out of) view — set maskShape ("circle"/"linear-h"/ \
"linear-v"), maskFromRadius/To, maskX/Y (circle center, fraction 0-1), maskHoldFrames, maskSoftness (0 \
= hard iris-wipe edge, good for an unveiling/"behold" beat; 1 = fully feathered, good for a softer \
"and then I noticed..." beat).
- "track_matte": same mechanism as mask_reveal, but bias maskSoftness low (a more deliberate, harder- \
edged unveiling) — use for a beat that's specifically about revealing one exact detail.
- "freeze_frame": hold the motion completely still at one moment mid-clip, for a "let this sink in" \
beat the narration explicitly calls for. Set freezeAtProgress (0-1, where in the move to hold) and \
freezeHoldFrames (how long) — keep the hold modest; motion must still be visibly present before and \
after the hold, this isn't a way to make the whole clip static.
- "path_animation": the camera follows a multi-point route instead of one straight line — set \
pathPoints to 2-4 waypoints (each {{x, y}} in the same percent units as panXFrom/panYFrom) for a \
scanning/exploring beat across an image with multiple things worth passing over.
- "speed_ramp": a non-linear pace to the move — set speedCurve: "punch_in_hold" (fast initial move then \
holds), "slow_fast_slow" (eases through a fast middle), or "fast_start_ease_out" (quick start, gentle \
finish) — for a beat with a specific rhythm the narration's own pacing calls for.

TIER 5 — ENVIRONMENTAL EFFECTS (environmentEffect, optional, default "none" — most clips should be \
"none"; only pick one when the scene's own content or mood genuinely supports it):
"dust" (sunbeam/interior with visible light), "smoke", "fog" (moody/mysterious atmosphere), "rain", \
"snow" (only if the shot's own weather/setting already shows it), "fire_embers" (near visible fire/ \
embers), "floating_particles" (a generic ambient dreamy touch, usable more loosely than the others), \
"light_rays" (dramatic god-ray lighting already implied by the shot). Never force one onto a scene that \
doesn't call for it — a plain, neutrally-lit shot should stay "none". environmentIntensity (0-1, \
default 0.35) controls how strong/dense it reads.

COLOR / LIGHT: saturationFrom/To (1 = normal; push down for something ominous/somber, up for vivid), \
glowColor (a css rgba string, or leave unset for none), glowX/Y (fraction 0-1), glowOpacity, \
glowFlicker (0 = steady glow, >0 = organic flicker — good for firelight or any moody atmospheric shot, \
but don't put it on a bright, neutral, plainly-lit image), vignette (0-1, higher for tense/dramatic, \
lower/near-0 for bright/neutral).

ENVELOPE: fadeInFrames/fadeOutFrames — how long this clip's opacity takes to fade in/out at its own \
edges (independent of the Tier-3 transitionOut, which is about the handoff between clips). Leave at \
the default unless there's a specific reason to hold longer or cut in faster.

HARD RULES (these are non-negotiable — the validator will reject and send back for revision anything \
that breaks them):
1. The main subject must never be cropped out, cut off, or pushed to the very edge of frame at ANY \
point during the move — not at the start, not at the end, not in between.
2. The clip must never look completely static — Tier 1's camera move should be doing something for the \
ENTIRE clip duration (small is fine for a quiet beat, zero is not), and a freeze_frame hold must be \
brief with real motion on both sides of it, never the whole clip.
3. The result must look like natural, intentional camera work that supports the narration — never an \
extreme, random, or maximal combination of values with no visual or narrative reason behind it. It \
should never read as an outlier compared to ordinary calm B-roll motion.
4. The transition into the next clip (Tier 3) should feel like a natural continuation of the video, not \
a jarring interruption — match the transition's energy to what's actually changing between the two \
clips.

VARIETY

{diversity_context}

A good video's treatments feel varied because each one was actually chosen for its own moment — not \
because you're rotating through a checklist. Watch for a specific failure mode: reaching for "push_in, \
always the same modest scale" as a safe default for every clip. Vary genuinely: mix push/pull/zoom-in/ \
zoom-out/pan/drift/reframing across Tier 1, bring in a Tier 2/4/5 effect when a clip actually earns it, \
vary pan direction and easing. If you notice you've composed something very close to what a recent clip \
already got and this clip doesn't have a strong reason to match it, lean toward a genuinely different \
combination instead. But never force variety that fights the content — a run of calm, similar shots can \
legitimately call for similar quiet treatments in a row, and Tiers 2/4/5 staying "none" on most clips is \
correct, not a failure to be varied. Return exactly one analysis per clip_id you were given, in the \
same order."""


VALIDATOR_SYSTEM_PROMPT = """You are the quality gate for one short video clip's camera-movement \
treatment in a faceless YouTube video. You are shown frames actually sampled from the RENDERED clip \
(its start, then progressively later, ending at its final frame) — not just the numbers — plus the \
narration that plays during it and the treatment's own declared settings. Your job is to catch real, \
visible problems a viewer would notice, not to nitpick taste.

REJECT (valid: false) only if one of these concrete problems is actually visible in the sampled frames:
1. The main subject is cropped out, pushed to the very edge of frame, or otherwise cut off in any of \
the sampled frames — the frame should never look like an incomplete/cut-off picture.
2. The image looks completely static/frozen across all sampled frames when it shouldn't (no visible \
zoom, pan, or other change between the first and last frame) — a still should never look like a plain \
photograph with no motion at all, unless the settings show a deliberate, brief freeze_frame hold with \
motion visible on both sides of it.
3. The motion looks broken, glitchy, or physically nonsensical (e.g. empty/black space visible at an \
edge, an overlay or mask that reads as a rendering artifact rather than an intentional effect).
4. The treatment obviously contradicts the narration's tone (e.g. heavy dramatic shake/glow on a calm, \
neutral informational line), or the visible result doesn't match what the declared settings say it \
should be doing (i.e. it wasn't properly implemented).
5. The move is so aggressive (extreme zoom, fast rotation, heavy shake, an environmental effect way too \
dense) that it reads as an outlier/jarring moment compared to ordinary calm B-roll motion, when nothing \
about the narration calls for that intensity.

Do NOT reject for subjective style preferences alone (e.g. "a push-in would have looked nicer than a \
pan") — only reject for one of the 5 concrete problems above. Most well-formed treatments should pass.

If you reject, `revisionInstructions` must be a short, concrete, actionable instruction (e.g. "pull the \
pan back so the subject's face stays fully in frame the whole time" or "add a slow zoom, this is \
completely static right now") that another pass at composing this exact clip could directly act on. \
`issues` should list the specific problems found, each one sentence."""


def _no_prior_context() -> str:
    return (
        "This is the first batch of clips for this video — nothing has been composed yet, so "
        "there is nothing to vary against yet."
    )


def _prior_context(treatment_history: list[str]) -> str:
    recent = ", ".join(f'"{name}"' for name in treatment_history[-6:]) or "none yet"
    return (
        f"Treatments already composed earlier in this same video, most recent last: {recent}. "
        "Take this into account so the overall mix across the whole video feels genuinely varied "
        "rather than a handful of combinations reused with minor tweaks."
    )


def _clip_content_blocks(clips: list[dict]) -> list[dict]:
    blocks: list[dict] = []
    for clip in clips:
        narration = clip.get("narration", "").strip() or "(no narration text available)"
        start = clip.get("startSeconds", 0.0)
        end = clip.get("endSeconds", 0.0)
        text = (
            f"Clip {clip['clipId']} (t={start:.1f}s-{end:.1f}s). "
            f"Narration playing during this clip: \"{narration}\""
        )
        # Both are only ever present when the validator (`_revise_recipe`) is
        # re-composing one clip after a rejected attempt — a normal first
        # pass never sets either.
        prior_recipe = clip.get("priorRecipe")
        if prior_recipe:
            text += f" This clip currently has this recipe assigned: {json.dumps(prior_recipe)}."
        feedback = clip.get("feedback")
        if feedback:
            text += (
                f" This specific revision is required: \"{feedback}\" — treat this as a direct "
                "instruction to satisfy, not just one more consideration to weigh against everything "
                "else. Keep whatever it doesn't mention as-is from the current recipe if it's still a "
                "good fit, rather than changing everything."
            )
        blocks.append({"type": "input_text", "text": text})
        blocks.append({
            "type": "input_image",
            "image_url": f"data:{clip['mime']};base64,{clip['base64Data']}",
        })
    return blocks


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _clamp_recipe(recipe: MotionRecipe) -> MotionRecipe:
    """Defense-in-depth against a provider proposing a move extreme enough to
    push important content out of frame (a runaway scale+pan combo, an
    absurd blur/vignette value), independent of how well the prompt's own
    guidance happens to be followed on a given call. Also neutralizes fields
    that belong to a tier the recipe didn't actually select (e.g. leftover
    fg/bg values when depthEffect is "none"), so a stray provider value can't
    silently apply. Clamps in place and returns the same instance.

    The scale ceiling (0.85-1.35) is deliberately tighter than the other
    dials here — it's a taste calibration, not just a safety rail, keeping
    the worst-case zoom on the subtle side even when the prompt's own
    guidance isn't followed. Pan (+/-15%) and rotation (+/-10deg) aren't
    similarly oversized, so they're left at their prior, wider bounds."""
    recipe.scale_from = _clamp(recipe.scale_from, 0.85, 1.35)
    recipe.scale_to = _clamp(recipe.scale_to, 0.85, 1.35)
    recipe.pan_x_from = _clamp(recipe.pan_x_from, -15.0, 15.0)
    recipe.pan_x_to = _clamp(recipe.pan_x_to, -15.0, 15.0)
    recipe.pan_y_from = _clamp(recipe.pan_y_from, -15.0, 15.0)
    recipe.pan_y_to = _clamp(recipe.pan_y_to, -15.0, 15.0)
    recipe.rotation_from_deg = _clamp(recipe.rotation_from_deg, -10.0, 10.0)
    recipe.rotation_to_deg = _clamp(recipe.rotation_to_deg, -10.0, 10.0)
    recipe.origin_x = _clamp(recipe.origin_x, 0.0, 100.0)
    recipe.origin_y = _clamp(recipe.origin_y, 0.0, 100.0)
    recipe.motion_blur_strength = _clamp(recipe.motion_blur_strength, 0.0, 1.0)
    recipe.shake_amount = _clamp(recipe.shake_amount, 0.0, 1.0)
    recipe.static_zoom_percent = _clamp(recipe.static_zoom_percent, 0.0, 100.0)

    recipe.subject_region_x = _clamp(recipe.subject_region_x, 0.0, 1.0)
    recipe.subject_region_y = _clamp(recipe.subject_region_y, 0.0, 1.0)
    recipe.subject_region_w = _clamp(recipe.subject_region_w, 0.05, 1.0)
    recipe.subject_region_h = _clamp(recipe.subject_region_h, 0.05, 1.0)

    recipe.fg_scale_from = _clamp(recipe.fg_scale_from, 0.9, 1.8)
    recipe.fg_scale_to = _clamp(recipe.fg_scale_to, 0.9, 1.8)
    recipe.fg_pan_x_from = _clamp(recipe.fg_pan_x_from, -15.0, 15.0)
    recipe.fg_pan_x_to = _clamp(recipe.fg_pan_x_to, -15.0, 15.0)
    recipe.fg_pan_y_from = _clamp(recipe.fg_pan_y_from, -15.0, 15.0)
    recipe.fg_pan_y_to = _clamp(recipe.fg_pan_y_to, -15.0, 15.0)
    recipe.bg_blur_from_px = _clamp(recipe.bg_blur_from_px, 0.0, 30.0)
    recipe.bg_blur_to_px = _clamp(recipe.bg_blur_to_px, 0.0, 30.0)
    recipe.subject_mask_softness = _clamp(recipe.subject_mask_softness, 0.0, 1.0)
    recipe.blur_from_px = _clamp(recipe.blur_from_px, 0.0, 30.0)
    recipe.blur_to_px = _clamp(recipe.blur_to_px, 0.0, 30.0)
    if recipe.depth_effect == "none":
        recipe.fg_scale_from = recipe.scale_from
        recipe.fg_scale_to = recipe.scale_to
        recipe.fg_pan_x_from = recipe.pan_x_from
        recipe.fg_pan_x_to = recipe.pan_x_to
        recipe.fg_pan_y_from = recipe.pan_y_from
        recipe.fg_pan_y_to = recipe.pan_y_to
        recipe.bg_blur_from_px = 0.0
        recipe.bg_blur_to_px = 0.0

    recipe.mask_from_radius = _clamp(recipe.mask_from_radius, 0.0, 1.5)
    recipe.mask_to_radius = _clamp(recipe.mask_to_radius, 0.0, 1.5)
    recipe.mask_x = _clamp(recipe.mask_x, 0.0, 1.0)
    recipe.mask_y = _clamp(recipe.mask_y, 0.0, 1.0)
    recipe.mask_hold_frames = _clamp(recipe.mask_hold_frames, 0.0, 200.0)
    recipe.mask_softness = _clamp(recipe.mask_softness, 0.0, 1.0)
    recipe.freeze_at_progress = _clamp(recipe.freeze_at_progress, 0.05, 0.95)
    recipe.freeze_hold_frames = _clamp(recipe.freeze_hold_frames, 0.0, 90.0)
    if recipe.story_effect not in ("mask_reveal", "track_matte"):
        recipe.mask_shape = "none"
    if recipe.story_effect != "freeze_frame":
        recipe.freeze_hold_frames = 0.0
    if recipe.story_effect != "path_animation":
        recipe.path_points = None
    elif not recipe.path_points or len(recipe.path_points) < 2:
        # A path effect with no usable path is meaningless — fall back to a
        # plain 2-point path matching whatever pan was already authored.
        recipe.path_points = [
            PanPoint(x=recipe.pan_x_from, y=recipe.pan_y_from),
            PanPoint(x=recipe.pan_x_to, y=recipe.pan_y_to),
        ]
    else:
        recipe.path_points = recipe.path_points[:6]
        for point in recipe.path_points:
            point.x = _clamp(point.x, -15.0, 15.0)
            point.y = _clamp(point.y, -15.0, 15.0)
    if recipe.story_effect != "speed_ramp":
        recipe.speed_curve = "linear_pace"

    recipe.environment_intensity = _clamp(recipe.environment_intensity, 0.0, 1.0)
    if recipe.environment_effect == "none":
        recipe.environment_intensity = 0.0

    recipe.saturation_from = _clamp(recipe.saturation_from, 0.0, 1.6)
    recipe.saturation_to = _clamp(recipe.saturation_to, 0.0, 1.6)
    recipe.glow_x = _clamp(recipe.glow_x, 0.0, 1.0)
    recipe.glow_y = _clamp(recipe.glow_y, 0.0, 1.0)
    recipe.glow_opacity = _clamp(recipe.glow_opacity, 0.0, 1.0)
    recipe.glow_flicker = _clamp(recipe.glow_flicker, 0.0, 1.0)
    recipe.vignette = _clamp(recipe.vignette, 0.0, 1.0)
    recipe.fade_in_frames = _clamp(recipe.fade_in_frames, 0.0, 90.0)
    recipe.fade_out_frames = _clamp(recipe.fade_out_frames, 0.0, 90.0)

    # A clip should never end up completely motionless (see the system
    # prompt's hard rule #2) — this is the backstop for the rare case a
    # provider leaves scale/pan/rotation/path all neutral anyway.
    has_scale_move = abs(recipe.scale_to - recipe.scale_from) > 0.005
    has_pan_move = (
        abs(recipe.pan_x_to - recipe.pan_x_from) > 0.3
        or abs(recipe.pan_y_to - recipe.pan_y_from) > 0.3
    )
    has_rotation_move = abs(recipe.rotation_to_deg - recipe.rotation_from_deg) > 0.3
    has_path_move = recipe.story_effect == "path_animation" and bool(recipe.path_points) and len(recipe.path_points) >= 2
    if not (has_scale_move or has_pan_move or has_rotation_move or has_path_move):
        recipe.scale_from = 1.03
        recipe.scale_to = 1.1

    return recipe


def analyze_batch(
    claude_cli_path: str | None,
    openai_client,
    gemini_client,
    gemini_client_error: Exception | None,
    ai_model: str,
    clips: list[dict],
    treatment_history: list[str],
) -> BatchMotionResult:
    diversity_context = (
        _no_prior_context() if not treatment_history else _prior_context(treatment_history)
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

    # Claude CLI first (see module docstring — no metered cost, rides an existing
    # subscription); OpenAI next; Gemini last resort. Each rung is only reached if
    # every rung before it was either unavailable or actually failed.
    claude_cli_error: Exception | None = None
    if claude_cli_path is not None:
        try:
            result = parse_structured_vision_claude_cli(
                claude_path=claude_cli_path,
                system_prompt=system_prompt,
                content_blocks=content_blocks,
                response_model=BatchMotionResult,
            )
            return _validate_batch_coverage(result, clips)
        except Exception as error:  # noqa: BLE001 - genuinely any failure should fall back
            claude_cli_error = error

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

    gemini_error: Exception | None = None
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
            gemini_error = error

    # Every rung that was actually reachable has now failed or was unavailable.
    # Report all of them rather than just the last one — with three possible
    # providers, silently collapsing to one message would make it much harder to
    # tell which of them is actually the one worth fixing.
    failure_notes: list[str] = []
    if claude_cli_error is not None:
        failure_notes.append(f"Claude CLI: {claude_cli_error}")
    if openai_error is not None:
        failure_notes.append(f"OpenAI: {openai_error}")
    if gemini_error is not None:
        failure_notes.append(f"Gemini: {gemini_error}")
    elif gemini_client_error is not None:
        failure_notes.append(f"Gemini unavailable: {gemini_client_error}")
    if not failure_notes:
        raise RuntimeError("No motion-graphics provider (Claude CLI, OpenAI, Gemini) is configured.")
    raise RuntimeError(" | ".join(failure_notes))


def _validate_batch_coverage(result: BatchMotionResult, clips: list[dict]) -> BatchMotionResult:
    expected_ids = [clip["clipId"] for clip in clips]
    returned_ids = [item.clip_id for item in result.analyses]
    if returned_ids != expected_ids:
        raise RuntimeError(
            f"Motion-graphics batch coverage is invalid. Expected {expected_ids}, "
            f"received {returned_ids}."
        )
    for analysis in result.analyses:
        _clamp_recipe(analysis)
    return result


def _label_for_recipe(recipe: MotionRecipe) -> str:
    """Short display/diversity-history label built purely from which named
    effects this recipe actually landed on — there's no free-text treatment
    name anymore (see module docstring), so this is the closest equivalent,
    used both for the DB's `motion_graphic_effect` column and as what the
    diversity mechanism shows future batches."""
    parts = [recipe.camera_effect.replace("_", " ")]
    if recipe.depth_effect != "none":
        parts.append(recipe.depth_effect.replace("_", " "))
    if recipe.story_effect != "none":
        parts.append(recipe.story_effect.replace("_", " "))
    if recipe.environment_effect != "none":
        parts.append(recipe.environment_effect.replace("_", " "))
    if recipe.transition_out != "cut":
        parts.append(f"-> {recipe.transition_out}")
    return " + ".join(parts)


def _validation_content_blocks(narration: str, recipe: MotionRecipe, frame_bytes: list[bytes]) -> list[dict]:
    settings_summary = recipe.model_dump(by_alias=True, exclude={"clip_id", "reason"})
    header = {
        "type": "input_text",
        "text": (
            f"Narration playing during this clip: \"{narration.strip() or '(no narration text available)'}\"\n\n"
            f"This clip's full declared settings: {json.dumps(settings_summary)}\n\n"
            f"{len(frame_bytes)} frames follow, sampled in order from the actual rendered clip "
            "(starting frame first, ending frame last)."
        ),
    }
    blocks: list[dict] = [header]
    for data in frame_bytes:
        blocks.append({
            "type": "input_image",
            "image_url": f"data:image/png;base64,{base64.b64encode(data).decode('ascii')}",
        })
    return blocks


def _validate_clip(
    claude_cli_path: str | None,
    openai_client,
    gemini_client,
    gemini_client_error: Exception | None,
    ai_model: str,
    narration: str,
    recipe: MotionRecipe,
    frame_bytes: list[bytes],
) -> MotionValidation:
    content_blocks = _validation_content_blocks(narration, recipe, frame_bytes)

    claude_cli_error: Exception | None = None
    if claude_cli_path is not None:
        try:
            return parse_structured_vision_claude_cli(
                claude_path=claude_cli_path,
                system_prompt=VALIDATOR_SYSTEM_PROMPT,
                content_blocks=content_blocks,
                response_model=MotionValidation,
            )
        except Exception as error:  # noqa: BLE001
            claude_cli_error = error

    openai_error: Exception | None = None
    if openai_client is not None:
        try:
            return parse_structured_vision(
                client=openai_client,
                model=ai_model,
                system_prompt=VALIDATOR_SYSTEM_PROMPT,
                content_blocks=content_blocks,
                response_model=MotionValidation,
                temperature=0.4,
            )
        except Exception as error:  # noqa: BLE001
            openai_error = error

    gemini_error: Exception | None = None
    if gemini_client is not None:
        try:
            return parse_structured_vision_gemini(
                client=gemini_client,
                model=DEFAULT_GEMINI_MODEL,
                system_prompt=VALIDATOR_SYSTEM_PROMPT,
                content_blocks=content_blocks,
                response_model=MotionValidation,
                temperature=0.4,
            )
        except Exception as error:  # noqa: BLE001
            gemini_error = error

    # No validator provider actually worked — a soft failure, not a fatal
    # one: accept the clip as-is rather than blocking the whole run over the
    # QA pass itself being unavailable, but say why in `issues` so it's
    # visible if someone goes looking.
    notes = [str(error) for error in (claude_cli_error, openai_error, gemini_error, gemini_client_error) if error]
    return MotionValidation(valid=True, issues=[f"Validator unavailable: {'; '.join(notes) or 'no provider configured'}"])


def _revise_recipe(
    claude_cli_path: str | None,
    openai_client,
    gemini_client,
    gemini_client_error: Exception | None,
    ai_model: str,
    clip: dict,
    prior_recipe: MotionRecipe,
    feedback: str,
    treatment_history: list[str],
) -> MotionRecipe:
    """Re-composes ONE clip with the validator's own rejection reason handed
    to the AI as a direct instruction — the same `priorRecipe`+`feedback`
    mechanism the old manual "Suggest motion" UI used to carry a human's
    notes (see module docstring), just driven by the validator instead of a
    person."""
    revised_clip = {
        **clip,
        "priorRecipe": prior_recipe.model_dump(by_alias=True, exclude={"clip_id", "reason"}),
        "feedback": feedback,
    }
    result = analyze_batch(
        claude_cli_path, openai_client, gemini_client, gemini_client_error,
        ai_model, [revised_clip], treatment_history,
    )
    return result.analyses[0]


def _render_validation_frames(
    image_bytes: bytes, mime: str, recipe: MotionRecipe,
    duration_frames: int, fps: int, width: int, height: int,
) -> list[bytes]:
    """Renders up to 3 representative PNG frames (start / roughly middle /
    end) of a CANDIDATE recipe via Remotion's `still` command — what the
    validator actually looks at, rather than trusting the numbers alone. Not
    the final export (see video_export_engine.py's `_render_motion_graphic`
    for that) — this only needs to look close enough for a QA pass, so it
    always renders at a fixed reasonable canvas size (see `run()`) regardless
    of the eventual export resolution: every recipe field is fraction/ \
percent-based, not absolute-pixel, except the small blur-in-px fields, which
    don't meaningfully change look at typical export sizes."""
    _ensure_motion_engine_ready()
    duration_frames = max(1, duration_frames)
    sample_frames = sorted({0, duration_frames // 2, max(0, duration_frames - 1)})
    extension = (mime.split("/")[-1] or "png").split("+")[0]
    settings = recipe.model_dump(by_alias=True, exclude={"clip_id", "reason"})

    with tempfile.TemporaryDirectory(prefix="motion-validate-") as tmp_dir:
        tmp_path = Path(tmp_dir)
        image_name = f"source.{extension}"
        (tmp_path / image_name).write_bytes(image_bytes)
        props = {
            "imagePath": image_name, "recipe": settings,
            "durationInFrames": duration_frames, "fps": fps, "width": width, "height": height,
        }
        props_path = tmp_path / "props.json"
        props_path.write_text(json.dumps(props), encoding="utf-8")

        frames: list[bytes] = []
        for index, frame_number in enumerate(sample_frames):
            out_path = tmp_path / f"frame_{index}.png"
            result = subprocess.run(
                [
                    _resolve_node_bin("npx"), "remotion", "still", "src/index.ts", "MotionClip", str(out_path),
                    f"--props={props_path}", f"--public-dir={tmp_path}", f"--frame={frame_number}", "--log=error",
                ],
                cwd=str(MOTION_ENGINE_DIR), capture_output=True, text=True, **_subprocess_kwargs(),
            )
            if result.returncode != 0:
                raise RuntimeError(f"Motion-graphics validation render failed: {result.stderr[-1500:]}")
            frames.append(out_path.read_bytes())
        return frames


def _validate_and_revise(
    claude_cli_path: str | None,
    openai_client,
    gemini_client,
    gemini_client_error: Exception | None,
    ai_model: str,
    clip: dict,
    recipe: MotionRecipe,
    fps: int,
    width: int,
    height: int,
    treatment_history: list[str],
) -> tuple[MotionRecipe, str]:
    """Renders the candidate recipe, has a vision pass judge it against the
    concrete checklist in VALIDATOR_SYSTEM_PROMPT, and — if rejected —
    re-composes just this one clip with the validator's own revision
    instructions, re-rendering and re-checking each time, up to
    MAX_VALIDATION_ROUNDS extra attempts. Returns (final_recipe, warning) —
    warning is "" if it ultimately passed clean."""
    image_bytes = base64.b64decode(clip["base64Data"])
    mime = clip["mime"]
    duration_frames = max(1, round((clip.get("endSeconds", 0.0) - clip.get("startSeconds", 0.0)) * fps))

    current = recipe
    for attempt in range(MAX_VALIDATION_ROUNDS + 1):
        try:
            frames = _render_validation_frames(image_bytes, mime, current, duration_frames, fps, width, height)
        except Exception as error:  # noqa: BLE001 - a validation-render failure shouldn't sink the clip
            return current, f"Validation render failed, accepted unvalidated: {error}"

        verdict = _validate_clip(
            claude_cli_path, openai_client, gemini_client, gemini_client_error, ai_model,
            clip.get("narration", ""), current, frames,
        )
        if verdict.valid:
            return current, ""
        if attempt == MAX_VALIDATION_ROUNDS:
            unresolved = "; ".join(verdict.issues) or verdict.revision_instructions or "no details given"
            return current, f"Unresolved after {MAX_VALIDATION_ROUNDS} revisions: {unresolved}"

        feedback = verdict.revision_instructions or "; ".join(verdict.issues) or "Revise this clip's motion to fix the issues found."
        try:
            current = _revise_recipe(
                claude_cli_path, openai_client, gemini_client, gemini_client_error, ai_model,
                clip, current, feedback, treatment_history,
            )
        except Exception as error:  # noqa: BLE001
            return current, f"Revision attempt failed, accepted last draft: {error}"
    return current, ""  # unreachable — the loop above always returns


def run(manifest_path: Path, ai_model: str, batch_size: int) -> list[dict]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    clips: list[dict] = manifest["clips"]
    if not clips:
        return []

    # Used for the validator's render-and-check pass — see
    # `_render_validation_frames`'s docstring for why the exact resolution
    # doesn't need to match the eventual real export. Defaults (a common
    # vertical-shorts canvas) only matter for a manifest that predates these
    # keys or an ad-hoc test manifest.
    fps = int(manifest.get("fps", 30))
    width = int(manifest.get("width", 1080))
    height = int(manifest.get("height", 1920))

    # Claude CLI is resolved first and, if present, is what actually gets used per
    # batch (see module docstring) — but OpenAI/Gemini clients are still built
    # regardless so they're ready as fallbacks if the CLI is missing or a call
    # through it fails partway through a run.
    claude_cli_path = get_claude_cli_path()

    openai_client = None
    openai_client_error: Exception | None = None
    try:
        openai_client = get_openai_client()
    except Exception as error:  # noqa: BLE001 - missing key/package should not be fatal if another provider works
        openai_client_error = error

    gemini_client = None
    gemini_client_error: Exception | None = None
    try:
        gemini_client = get_gemini_client()
    except Exception as error:  # noqa: BLE001 - Gemini is optional; any one provider alone is a valid setup
        gemini_client_error = error

    if claude_cli_path is None and openai_client is None and gemini_client is None:
        raise openai_client_error or gemini_client_error or RuntimeError(
            "Configure an OpenAI or Gemini API key, or log into the Claude Code CLI, "
            "to use Motion Graphics analysis."
        )

    batches = [clips[i : i + batch_size] for i in range(0, len(clips), batch_size)]

    # Seeded from the manifest when the caller already has treatments composed
    # for earlier clips in this same video (see auto_gen_engine's Rust side,
    # `analyze_motion_graphics_batch`, which now calls this once per batch of
    # the whole video rather than once for all of it — treatment_history used
    # to simply accumulate across batches within that one longer call, so it
    # has to be handed in explicitly now instead of always starting empty).
    treatment_history: list[str] = list(manifest.get("treatmentHistory", []))
    composed: list[tuple[dict, MotionRecipe]] = []

    for batch_number, batch in enumerate(batches, start=1):
        report_progress(
            round(5 + 40 * (batch_number - 1) / len(batches)),
            "Composing motion treatments",
            f"Batch {batch_number} of {len(batches)} ({len(batch)} clips)",
        )
        result = analyze_batch(
            claude_cli_path, openai_client, gemini_client, gemini_client_error,
            ai_model, batch, treatment_history,
        )
        for clip, analysis in zip(batch, result.analyses):
            treatment_history.append(_label_for_recipe(analysis))
            composed.append((clip, analysis))

    output: list[dict] = []
    for index, (clip, recipe) in enumerate(composed, start=1):
        report_progress(
            round(45 + 50 * (index - 1) / max(1, len(composed))),
            "Validating motion treatments",
            f"Clip {index} of {len(composed)}",
        )
        final_recipe, warning = _validate_and_revise(
            claude_cli_path, openai_client, gemini_client, gemini_client_error, ai_model,
            clip, recipe, fps, width, height, treatment_history,
        )
        reason = final_recipe.reason
        if warning:
            reason = f"{reason} [{warning}]"
        settings = final_recipe.model_dump(
            by_alias=True, exclude={"clip_id", "reason"}, exclude_none=False,
        )
        output.append({
            "clipId": final_recipe.clip_id,
            "effect": _label_for_recipe(final_recipe),
            "settings": settings,
            "reason": reason,
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
