"""
Auto Gen Studio internal video export engine.

Composites a timeline arrangement (stills stretched to their durations,
an optional burned-in caption track, and the narration audio) into a single
MP4. Uses a concat-demuxer strategy rather than one large filter_complex
graph: each still (or gap) is first encoded to a short intermediate segment,
then every segment is concatenated in one final pass that also muxes the
narration audio and burns in the caption track. This keeps the ffmpeg command
lines short and robust regardless of how many stills are on the timeline.

Reuses scene_grouping_engine's ffmpeg discovery (imageio_ffmpeg fallback,
winget fallback) and its AUTOGEN_PROGRESS reporting convention.

Usage:
  python video_export_engine.py manifest.json --output output.mp4
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import scene_grouping_engine as engine

FPS_DEFAULT = 30
MAX_ENCODE_WORKERS = 4


def _remotion_concurrency() -> int:
    """Per-process browser-tab concurrency for one `_render_motion_graphic`
    call, sized so that up to MAX_ENCODE_WORKERS of these can run at once
    (via the segment ThreadPoolExecutor) without collectively oversubscribing
    the machine's CPU — see the call site's comment for why an explicit cap
    matters here specifically."""
    return max(1, (os.cpu_count() or MAX_ENCODE_WORKERS) // MAX_ENCODE_WORKERS)

# "cuts" motion preset: a still is split into this many hard-cut static
# crops instead of one continuous pan/zoom — see build_segments()'s "cuts"
# branch and build_image_filter's cut_index handling.
CUTS_SEGMENT_COUNT = 3

# Fallback caption look if a manifest is ever missing captionDefaultStyle
# (e.g. one written before per-clip caption styling existed) — matches what
# used to be the single hardcoded ASS style for every export.
_FALLBACK_CAPTION_STYLE = {
    "fontFamily": "Rubik",
    "fontSizePx": 22,
    "bold": True,
    "color": "#FFFFFF",
    "opacity": 100,
    "outlineColor": "#000000",
    "outlineWidthPx": 2,
    "shadow": {"enabled": False, "color": "#000000", "opacity": 70, "blur": 30, "distance": 2, "angle": 90},
    "position": "bottom",
}

_ASS_ALIGNMENT = {"bottom": 2, "middle": 5, "top": 8}


def _subprocess_kwargs() -> dict:
    if os.name == "nt":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


def to_srt_ts(seconds: float) -> str:
    ms = int(round((seconds % 1) * 1000))
    whole = int(seconds)
    m, s = divmod(whole, 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def build_segments(stills: list[dict], duration_seconds: float) -> list[dict]:
    """Fills any uncovered time range between/around stills with black
    segments so the whole [0, duration_seconds] range is covered. A still
    entry with `"kind": "video"` is a generated animation clip (Veo output)
    or an imported video file rather than a static image — it carries a
    `videoPath` instead of an `imagePath`. It can still carry a motion-
    graphic recipe (a still replaced by a clip keeps whatever Camera Effect
    was set on it) — see `_encode_segment_to_path`'s "video" branch, which
    renders it via Remotion the same way an "image" segment with a recipe
    does."""
    ordered = sorted(stills, key=lambda item: item["start"])
    segments: list[dict] = []
    cursor = 0.0
    for still in ordered:
        start = max(0.0, still["start"])
        end = min(duration_seconds, still["end"])
        if end <= start:
            continue
        if start > cursor + 1e-6:
            segments.append({"kind": "black", "start": cursor, "end": start})
        if still.get("kind") == "video":
            segments.append({
                "kind": "video", "path": still["videoPath"], "start": start, "end": end,
                "sourceDurationSeconds": still.get("sourceDurationSeconds"),
                "transitionIn": still.get("transitionIn", "cut"),
                "transitionOut": still.get("transitionOut", "cut"),
                "transitionIntensity": still.get("transitionIntensity", 50.0),
                "colorFilter": still.get("colorFilter", "none"),
                "colorFilterIntensity": still.get("colorFilterIntensity", 50.0),
                # A still that had a Camera Effect assigned keeps it once
                # replaced by an animation/imported clip — see
                # _encode_segment_to_path's "video" branch.
                "motionGraphicEffect": still.get("motionGraphicEffect"),
                "motionGraphicSettings": still.get("motionGraphicSettings"),
            })
        elif still.get("motion") == "cuts":
            # Hard cuts between CUTS_SEGMENT_COUNT static crops of the same
            # image, instead of one continuous pan/zoom — evenly split this
            # still's time range into that many consecutive sub-segments,
            # each its own independent encode (see build_image_filter's
            # cut_index handling). assign_frame_counts() needs no changes:
            # it already computes cumulative-frame-accurate counts per
            # segment regardless of how many segments one still becomes, as
            # long as each sub-segment's "end" is set correctly here.
            count = CUTS_SEGMENT_COUNT
            span = (end - start) / count
            for cut_index in range(count):
                cut_start = start + span * cut_index
                cut_end = end if cut_index == count - 1 else start + span * (cut_index + 1)
                segments.append({
                    "kind": "image", "path": still["imagePath"], "start": cut_start, "end": cut_end,
                    "motion": "cuts", "cutIndex": cut_index, "cutCount": count,
                    "subjectX": still.get("subjectX", 0.5), "subjectY": still.get("subjectY", 0.5),
                    # Only the whole still's own transitionIn/Out apply to
                    # its first/last sub-segment — the cuts between
                    # sub-segments are always hard cuts, not user-chosen.
                    "transitionIn": still.get("transitionIn", "cut") if cut_index == 0 else "cut",
                    "transitionOut": still.get("transitionOut", "cut") if cut_index == count - 1 else "cut",
                    "transitionIntensity": still.get("transitionIntensity", 50.0),
                    "colorFilter": still.get("colorFilter", "none"),
                    "colorFilterIntensity": still.get("colorFilterIntensity", 50.0),
                })
        else:
            segments.append({
                "kind": "image", "path": still["imagePath"], "start": start, "end": end,
                "motion": still.get("motion", "none"),
                "motionIntensity": still.get("motionIntensity", 0.22),
                "transitionIn": still.get("transitionIn", "cut"),
                "transitionOut": still.get("transitionOut", "cut"),
                "transitionIntensity": still.get("transitionIntensity", 50.0),
                # These were previously dropped here despite the manifest
                # already carrying them (Rust always sends them per still) —
                # meant color filters and subject-anchored zoom silently
                # never reached the real export, only the live preview.
                "subjectX": still.get("subjectX", 0.5), "subjectY": still.get("subjectY", 0.5),
                "colorFilter": still.get("colorFilter", "none"),
                "colorFilterIntensity": still.get("colorFilterIntensity", 50.0),
                # An AI-assigned (or manually overridden) SOP motion-graphic
                # treatment takes priority over the plain `motion` zoompan
                # preset above when present — see _encode_segment_to_path's
                # "image" branch. `motion` above still travels through as the
                # fallback for stills that were never assigned one.
                "motionGraphicEffect": still.get("motionGraphicEffect"),
                "motionGraphicSettings": still.get("motionGraphicSettings"),
            })
        cursor = max(cursor, end)
    if cursor < duration_seconds - 1e-6:
        segments.append({"kind": "black", "start": cursor, "end": duration_seconds})
    return segments


def assign_frame_counts(segments: list[dict], fps: int) -> None:
    """Assigns each segment's exact output frame count in place, using a
    running cumulative frame position rather than rounding each segment's own
    duration independently. Rounding each segment in isolation loses up to
    half a frame per segment; with dozens of stills those small errors
    accumulate into a growing drift between the picture track and the
    narration/captions that becomes clearly visible by the end of a long
    video — even though each individual clip's own duration looks correct.
    Computing each cut point from the ABSOLUTE, cumulative frame position
    instead means the errors cancel out: the total frames across every
    segment always exactly equals round(total_duration * fps)."""
    cumulative_frame = 0
    for segment in segments:
        end_frame = round(segment["end"] * fps)
        segment["frames"] = max(1, end_frame - cumulative_frame)
        cumulative_frame += segment["frames"]


# These 6 transitions need both neighboring clips' pixel data blended
# together, unlike cut/fade/dip-to-white which only ever touch one segment's
# own frames — see `expand_join_transitions`. Mapped onto ffmpeg's `xfade`
# filter's built-in transition catalog rather than hand-built filter_complex
# graphs per type, since xfade already covers all of these reliably. Also
# the set of Tier-3 "transitionOut" values the motion-graphics AI (see
# motion_graphics_engine.py) can pick between clips — "whip-pan" and
# "blur-transition" both approximate their look with ffmpeg's `hblur`
# (there's no true isotropic/gaussian blur transition built into xfade),
# distinguished only by duration (see JOIN_TRANSITION_SECONDS below): a
# short, snappy hblur reads as a whip-pan; a longer one reads as a softer
# blur dissolve. Documented as an approximation, not exact optical blur.
JOIN_TRANSITIONS = {"cross-fade", "slide-left", "slide-right", "zoom-blur", "whip-pan", "blur-transition"}
_XFADE_TRANSITION_NAMES = {
    # Root cause for "the cross fade transition when rendered shows a jitter
    # on the screen ... I don't see it in the preview". This used to map to
    # xfade's "dissolve" on the belief that it was "a direct A-to-B blend"
    # and therefore a truer cross-dissolve than xfade's "fade". That is
    # backwards: ffmpeg's `dissolve` is a RANDOM PER-PIXEL dissolve — every
    # pixel independently flips from A to B against a random threshold — so
    # each frame of the blend is a fresh field of static, and the transition
    # crawls with full-screen noise. Measured by xfading two FLAT solid
    # colours: at the midpoint `fade` produces exactly 1 distinct colour
    # (a clean 50/50 blend) while `dissolve` produces 98,542 distinct
    # colours with a per-channel std of ~91. On the user's own real export
    # the per-frame high-frequency energy ran 1.8 -> 146.7 (56x baseline)
    # across the 13 blended frames, peaking at the midpoint exactly as a
    # random dissolve does. Both have the same MEAN brightness, which is why
    # a brightness-over-time check reads as a perfectly smooth ramp and
    # misses it entirely.
    #
    # xfade's "fade" is the plain linear cross-dissolve, which is exactly
    # what the canvas preview does (`ctx.globalAlpha = progress` over clip A
    # in drawJoinTransitionFrame). Confusingly named next to the unrelated
    # per-clip fade-to-black transition elsewhere in this module, but it is
    # the correct filter. Every other mapping below was verified clean by
    # the same flat-colour test (high-frequency energy ~0).
    "cross-fade": "fade",
    "slide-left": "slideleft",
    "slide-right": "slideright",
    # xfade has no literal "zoom + motion blur" preset; "zoomin" (the
    # incoming clip zooms in while cross-dissolving) is the closest built-in
    # analog and reads as a zoom-blur at typical transition speeds.
    "zoom-blur": "zoomin",
    "whip-pan": "hblur",
    "blur-transition": "hblur",
}
# Per-type (min, max) transition duration bounds, in seconds — overrides the
# generic default in `expand_join_transitions` for the two transitions that
# share an xfade filter name (see above) and rely entirely on duration to
# read as different things: short and snappy for a whip-pan, longer and
# softer for a blur dissolve.
_JOIN_TRANSITION_SECONDS = {
    "whip-pan": (0.12, 0.25),
    "blur-transition": (0.4, 0.7),
}


def expand_join_transitions(segments: list[dict], fps: int) -> list[dict]:
    """Splices a short blended "transition segment" between two adjacent
    segments wherever the earlier one's `transitionOut` is a join transition.

    A real crossfade/slide/zoom-blur overlaps the outgoing clip's tail with
    the incoming clip's head — playing 2N frames' worth of source over only
    N frames of output. Simply carving that overlap out of both clips' own
    on-screen time would shrink the total exported duration by N frames per
    transition, drifting picture out of sync with the fixed-length narration
    track after every single one. Instead, the outgoing clip's own segment
    is left completely untouched (still its full nominal length) and the
    *transition segment* renders N extra "virtual" frames of the outgoing
    clip continuing past its nominal end, blended against the incoming
    clip's own first N frames. The incoming clip's own independent segment
    then starts N frames later (skipping the head that now plays inside the
    transition instead). Net effect: nominal_a + N + (nominal_b - N) ==
    nominal_a + nominal_b, so total output length (and narration sync) is
    exactly preserved.

    The outgoing side can be a still image OR a video (Veo animation /
    imported clip) — for a still, the "extra virtual frames" are just more
    Ken-Burns math with no footage limit; for a video, `_encode_segment_to_path`'s
    existing stale-asset safety net (`tpad=stop_mode=clone`, see both its
    "video" branches) kicks in automatically once the virtually-extended
    window's requested duration exceeds the clip's real `sourceDurationSeconds`,
    holding a frozen last frame for the extra time (or, if the source
    actually has unused footage beyond its nominal slot, that real footage
    plays instead — either way a valid tail window comes out). A join
    transition into/out of a "black" gap or the very edge of the timeline
    still silently renders as a hard cut, same as how the true first/last
    segment's fade already gets ignored."""
    for segment in segments:
        segment["_originalFrames"] = segment["frames"]

    expanded: list[dict] = []
    for index, segment in enumerate(segments):
        expanded.append(segment)
        transition_type = segment.get("transitionOut", "cut")
        next_segment = segments[index + 1] if index + 1 < len(segments) else None
        if (
            transition_type not in JOIN_TRANSITIONS
            or segment["kind"] not in ("image", "video")
            or next_segment is None
            or next_segment["kind"] not in ("image", "video")
        ):
            continue
        duration_a = segment["end"] - segment["start"]
        duration_b = next_segment["end"] - next_segment["start"]
        seconds_lo, seconds_hi = _JOIN_TRANSITION_SECONDS.get(transition_type, (0.2, 0.75))
        # The transition-intensity slider (0-100%, see timeline_clips.transition_intensity)
        # scales linearly within this transition type's own (lo, hi) duration
        # bounds — 0% is the snappiest the type ever gets, 100% the longest —
        # then the existing 1/3-of-the-shorter-clip safety cap still applies
        # on top, so an aggressive intensity on two very short adjacent clips
        # can never eat more of either one than before.
        intensity_fraction = max(0.0, min(100.0, segment.get("transitionIntensity", 50.0))) / 100.0
        desired_seconds = seconds_lo + (seconds_hi - seconds_lo) * intensity_fraction
        transition_seconds = max(0.05, min(desired_seconds, min(duration_a, duration_b) / 3))
        transition_frames = max(1, min(round(transition_seconds * fps), next_segment["frames"] - 1))
        next_segment["frames"] -= transition_frames
        next_segment["_trimStartFrames"] = next_segment.get("_trimStartFrames", 0) + transition_frames
        expanded.append({
            "kind": "transition",
            "transitionType": transition_type,
            "frames": transition_frames,
            "segmentA": segment,
            "segmentB": next_segment,
        })
    return expanded


def strip_recipe_fade_envelope(segments: list[dict]) -> None:
    """Zeroes every clip's `fadeInFrames`/`fadeOutFrames` for the single
    baked video, in place.

    Root cause for "there is some extra transition which I never set". Every
    MotionRecipe carries a fade-in/out opacity envelope, defaulting to 14
    frames at BOTH ends (see services/motion-engine/src/types.ts and
    projects-client.ts). MotionClip.tsx ramps the clip's opacity over Remotion's
    implicit black backdrop, and `build_recipe_zoompan_filter` reproduces that
    natively with `fade=` — so on the timeline every clip fades to black at
    its own end and back up from black at the next clip's start. The Timeline
    canvas preview renders NO such envelope: `applyMotionRecipe` returns only
    a rect and a blur, and `fadeOverlay` fades only for an explicit
    transitionIn/Out of "fade"/"dip-to-white".

    Measured on the user's own completed export (per-frame YAVG through
    ffmpeg's signalstats): at a clip boundary the user had set to a plain
    CUT, brightness ran 49.7 -> 0.5 -> 51.1 over ~0.4s — a full dip to black
    where the preview hard-cuts. At a boundary set to cross-fade it was
    worse: the outgoing clip faded to black (91.7 -> 6.4), hard-popped back
    to full brightness, and only then cross-faded — because the clip's own
    segment and the transition's virtually-extended tail window (see
    `expand_join_transitions`) each run the envelope over their own separate
    frame timeline.

    Clip boundaries in the baked video are governed by transitionIn/
    transitionOut alone — exactly the model the preview implements — so the
    envelope is dropped here. An explicit "fade"/"dip-to-white" transition
    still fades, through `_scaled_fade_seconds`, and still shows in preview.
    Applied to segments (not to the manifest's stills) so the asset-bundle
    export, which hands each clip to another editor as its own standalone
    file, is left untouched."""
    for segment in segments:
        settings = segment.get("motionGraphicSettings")
        if not settings:
            continue
        if not (settings.get("fadeInFrames") or settings.get("fadeOutFrames")):
            continue
        segment["motionGraphicSettings"] = {**settings, "fadeInFrames": 0, "fadeOutFrames": 0}


def close_gaps(stills: list[dict], duration_seconds: float) -> list[dict]:
    """Stretches each still to cover through to the next one's start (and the
    first/last still out to the timeline's edges), so no silence gap is left
    uncovered. Used only for the asset-bundle export — a separate black clip
    file for a pause reads as a broken asset handed to another editor, not as
    an intentional cut the way it can in the single-file baked video."""
    ordered = sorted((dict(item) for item in stills), key=lambda item: item["start"])
    if not ordered:
        return ordered
    ordered[0]["start"] = 0.0
    for i in range(len(ordered) - 1):
        ordered[i]["end"] = ordered[i + 1]["start"]
    ordered[-1]["end"] = max(ordered[-1]["end"], duration_seconds)
    return ordered


REFERENCE_DURATION = 5.0  # seconds — `intensity` is calibrated as the total
# zoom/pan amount reached over this many seconds, then applied as a constant
# per-second rate to every clip so the same intensity feels equally fast
# regardless of how long an individual still is on screen.
MAX_SCALE_REFERENCE_DURATION = 60.0  # only bounds pathological cases; must
# stay well beyond any realistic still duration so zoom never visibly freezes
# mid-clip (the old `1 + amount*3` cap froze zoom at exactly 15s elapsed).

# How far every zoompan preset below (and build_recipe_zoompan_filter's own)
# upscales its source before cropping — see each call site's own comment for
# why any upscale at all: zoompan crops at integer-pixel granularity in its
# source's coordinate space, so a slow zoom/pan at output resolution moves
# less than one pixel per frame, rounding most frames to the exact same crop
# and producing a "still, still, jump" stutter instead of steady motion.
# Previously 8 — reduced after measuring the ACTUAL cost, not just the
# smoothness benefit, of that value: a real 4K still through this exact
# filter chain (scale then zoompan, `-loop 1` re-running the scale on every
# repeated frame — there is only one real source frame, but nothing dedupes
# across the loop) ran at 8x=5fps, 6x=9.4fps, 5x=13fps, 4x=19fps, 3x=27fps —
# roughly the quadratic cost you'd expect from a 2D upscale (8x has 64x the
# pixels of 1x; 3x has 9x). On a real project export (87 clips, all
# ffmpeg-native, zero needing Remotion) this was measured as THE dominant
# remaining cost behind a 10-minute video taking 30-40 minutes to export —
# bigger than the Remotion/vignette fix and the final-pass hardware
# encode/decode work combined. The original tuning comment's own measured
# sub-pixel-drift standard deviation (lower = smoother: 3x~0.29, 6x~0.17,
# 8x~0.12, 10x~0.10) shows sharply diminishing returns well before 8x; 4x
# keeps most of that smoothness (extrapolating the same curve, meaningfully
# closer to 6x's 0.17 than to 3x's 0.29) for roughly a 4x speedup.
_ZOOMPAN_PRE_SCALE_FACTOR = 4


# Matches TimelineView.tsx's COLOR_FILTER_TARGETS exactly (brightness
# additive to line up with ffmpeg eq's -1..1 range, contrast/saturation
# multiplicative around 1) so the canvas preview and this ffmpeg filter agree.
COLOR_FILTER_TARGETS: dict[str, tuple[float, float, float]] = {
    "warm": (0.03, 1.05, 1.25),
    "cool": (-0.02, 1.05, 0.9),
    "cinematic": (-0.05, 1.15, 0.85),
    "bright": (0.12, 1.02, 1.08),
    "muted": (0.02, 0.95, 0.55),
    "dark": (-0.18, 1.12, 0.9),
}


def build_color_filter_vf(preset: str, intensity_percent: float) -> str:
    """Returns an ffmpeg `eq=` filter node for a color preset, or "" for
    'none'/unrecognized presets (nothing to append to the -vf chain)."""
    target = COLOR_FILTER_TARGETS.get(preset)
    if not target:
        return ""
    brightness_target, contrast_target, saturation_target = target
    t = max(0.0, min(100.0, intensity_percent)) / 100.0
    brightness = brightness_target * t
    contrast = 1 + (contrast_target - 1) * t
    saturation = 1 + (saturation_target - 1) * t
    return f"eq=brightness={brightness:.4f}:contrast={contrast:.4f}:saturation={saturation:.4f}"


def _scaled_fade_seconds(duration: float, transition_intensity: float) -> float:
    """Fade-to-black/white duration for a 'fade'/'dip-to-white' transition,
    scaled by the transition-intensity slider (0-100%, see
    timeline_clips.transition_intensity). Proportional to the clip's own
    duration, same shape as the original fixed formula, but the proportion
    itself now ranges from a snappy ~2% at intensity=0 up to a lingering
    ~15% at intensity=100 (the old fixed value was a flat 8%, i.e.
    intensity=50 on this scale — see MIGRATION_044's doc comment in
    projects.rs for why that's the default). Floored at 0.15s so even a
    intensity=0 fade stays perceptible, capped at half the duration so
    in+out fades on a short clip never overlap — both unchanged from before
    this was user-adjustable."""
    fraction = 0.02 + (0.15 - 0.02) * (max(0.0, min(100.0, transition_intensity)) / 100.0)
    return max(0.15, min(duration / 2, duration * fraction))


def build_image_filter(
    motion: str, transition_in: str, transition_out: str, intensity: float,
    width: int, height: int, fps: int, duration: float, frames: int,
    subject_x: float = 0.5, subject_y: float = 0.5,
    color_filter: str = "none", color_filter_intensity: float = 50.0,
    cut_index: int = 0, transition_intensity: float = 50.0,
) -> str:
    """Ken Burns camera-movement presets via ffmpeg's zoompan filter, plus
    optional fade-from/to-black "transitions" at the start and/or end.
    `frames` is the segment's cumulative-frame-accurate output length (see
    `assign_frame_counts`) — using it here instead of re-deriving frame count
    from `duration` keeps the zoompan animation's length exactly matching
    what the output is actually trimmed to. `subject_x`/`subject_y` (fractions
    0-1 of image width/height) anchor the "-subject" presets; ignored by all
    other presets."""
    frames = max(1, frames)
    amount = max(0.02, min(0.6, intensity))
    rate = amount / REFERENCE_DURATION
    max_scale = 1 + amount * (MAX_SCALE_REFERENCE_DURATION / REFERENCE_DURATION)
    peak = 1 + amount
    half_duration = duration / 2
    mid_scale = min(max_scale, 1 + rate * half_duration)

    fade_in_duration = _scaled_fade_seconds(duration, transition_intensity)
    fade_out_duration = _scaled_fade_seconds(duration, transition_intensity)
    fades = []
    if transition_in in ("fade", "dip-to-white"):
        in_color = "white" if transition_in == "dip-to-white" else "black"
        fades.append(f"fade=t=in:st=0:d={fade_in_duration:.3f}:color={in_color}")
    if transition_out in ("fade", "dip-to-white"):
        out_color = "white" if transition_out == "dip-to-white" else "black"
        fades.append(f"fade=t=out:st={max(0.0, duration - fade_out_duration):.3f}:d={fade_out_duration:.3f}:color={out_color}")
    fade = "".join(f",{f}" for f in fades)
    color_vf = build_color_filter_vf(color_filter, color_filter_intensity)
    color_node = f",{color_vf}" if color_vf else ""

    def anchored_xy(sx: float, sy: float) -> str:
        return f"x='(iw-iw/zoom)*{sx:.5f}':y='(ih-ih/zoom)*{sy:.5f}'"

    # Matches the canvas preview's applyMotion(): when no subject point was
    # ever saved for this render, subject_x/y arrive as the generic (0.5,
    # 0.5) default — Ken Burns overrides that specific case with its own
    # off-center starting point so it still pans instead of zooming in place.
    kb_start_x = subject_x if (subject_x, subject_y) != (0.5, 0.5) else 0.35
    kb_start_y = subject_y if (subject_x, subject_y) != (0.5, 0.5) else 0.35

    zoompan_presets = {
        "zoom-in": (
            f"z='min({max_scale:.5f},1+{rate:.6f}*on/{fps})':"
            f"{anchored_xy(0.5, 0.5)}"
        ),
        "zoom-out": (
            f"z='min({max_scale:.5f},1+{rate:.6f}*({duration:.3f}-on/{fps}))':"
            f"{anchored_xy(0.5, 0.5)}"
        ),
        "zoom-pulse": (
            f"z='if(lt(on/{fps},{half_duration:.3f}),"
            f"min({max_scale:.5f},1+{rate:.6f}*on/{fps}),"
            f"max(1,{mid_scale:.5f}-{rate:.6f}*(on/{fps}-{half_duration:.3f})))':"
            f"{anchored_xy(0.5, 0.5)}"
        ),
        "zoom-in-subject": (
            f"z='min({max_scale:.5f},1+{rate:.6f}*on/{fps})':"
            f"{anchored_xy(subject_x, subject_y)}"
        ),
        "zoom-out-subject": (
            f"z='min({max_scale:.5f},1+{rate:.6f}*({duration:.3f}-on/{fps}))':"
            f"{anchored_xy(subject_x, subject_y)}"
        ),
        "pan-left": (
            f"z='{peak:.5f}':"
            f"x='(iw-iw/zoom)*(1-min(1,(on/{fps})/{REFERENCE_DURATION}))':y='(ih-ih/zoom)/2'"
        ),
        "pan-right": (
            f"z='{peak:.5f}':"
            f"x='(iw-iw/zoom)*min(1,(on/{fps})/{REFERENCE_DURATION})':y='(ih-ih/zoom)/2'"
        ),
        "ken-burns": (
            f"z='min({max_scale:.5f},1+{rate:.6f}*on/{fps})':"
            f"x='(iw-iw/zoom)*({kb_start_x:.5f}+({0.5 - kb_start_x:.5f})*min(1,(on/{fps})/{REFERENCE_DURATION}))':"
            f"y='(ih-ih/zoom)*({kb_start_y:.5f}+({0.5 - kb_start_y:.5f})*min(1,(on/{fps})/{REFERENCE_DURATION}))'"
        ),
    }
    if motion == "cuts":
        # Hard-cut motion preset: each sub-segment holds one FIXED crop for
        # its whole duration (no z= animation over time) — the "cut" is
        # produced by concatenating independently-encoded segments (see
        # build_segments), not by anything in this filter itself. Sequence
        # reads as wide establishing shot -> push to the detected subject ->
        # push to the complementary corner, rather than 3 arbitrary crops.
        cut_anchors = [
            (0.5, 0.5, 1.0),
            (subject_x, subject_y, min(max_scale, peak + 0.3)),
            (1 - subject_x, 1 - subject_y, min(max_scale, peak + 0.3)),
        ]
        cx, cy, cscale = cut_anchors[cut_index % len(cut_anchors)]
        pre_scale = max(width, height) * _ZOOMPAN_PRE_SCALE_FACTOR
        return (
            f"scale={pre_scale}:-2,zoompan=z='{cscale:.5f}':"
            f"{anchored_xy(cx, cy)}:"
            f"d={frames}:s={width}x{height}:fps={fps}{color_node}{fade}"
        )
    if motion in zoompan_presets:
        # zoompan crops at integer-pixel granularity in its source's coordinate
        # space; a slow zoom (low intensity) moves less than one pixel per
        # frame at that resolution, so most frames round to the exact same
        # crop and the motion stalls until the accumulated sub-pixel drift
        # finally crosses a whole pixel — producing a "still, still, jump"
        # stutter rather than steady motion. Scaling the source up well
        # beyond the output resolution first gives each frame far more
        # sub-pixel headroom before that rounding happens — see
        # `_ZOOMPAN_PRE_SCALE_FACTOR`'s own comment for the speed/smoothness
        # tradeoff behind its exact value.
        pre_scale = max(width, height) * _ZOOMPAN_PRE_SCALE_FACTOR
        return (
            f"scale={pre_scale}:-2,zoompan={zoompan_presets[motion]}:"
            f"d={frames}:s={width}x{height}:fps={fps}{color_node}{fade}"
        )
    # Cover-crop (not letterbox): scales up until the frame fully covers the
    # target canvas, then crops the overflow, centered. Matches the editor
    # preview's cover-fill (see TimelineView's drawStillClipContent) and the
    # zoompan-based motion presets above, which are already crop-based by
    # construction — this keeps the "none"-motion path consistent with them
    # instead of the only one leaving black pillar/letterbox bars.
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},setsar=1,fps={fps}{color_node}{fade}"
    )


def _ease_expr(easing: str, t_expr: str) -> str:
    """FFmpeg expression computing the eased 0-1 progress from a raw 0-1
    progress expression `t_expr` — used by `build_recipe_zoompan_filter`.
    Mirrors timeline-rendering.ts's `easeMotionProgress`: plain quadratic
    ease-in/out, and smoothstep standing in for "ease"/"cubic" — close
    enough to Remotion's real `Easing.in/out/inOut(ease/cubic)` curves that
    the difference isn't perceptible at typical camera-move durations,
    since this only ever gets evaluated once per OUTPUT FRAME either way
    (neither renderer is sub-frame-accurate). "elastic" (the one curve that
    visibly overshoots and settles back) has no reasonable monotonic
    approximation — recipes using it are excluded from this fast path
    entirely (see `_is_ffmpeg_native_recipe`), not approximated here."""
    if easing == "linear":
        return t_expr
    if easing == "easeIn":
        return f"(({t_expr})*({t_expr}))"
    if easing == "easeOut":
        return f"(1-(1-({t_expr}))*(1-({t_expr})))"
    # "ease" / "cubic" (and any future default) — smoothstep.
    return f"(({t_expr})*({t_expr})*(3-2*({t_expr})))"


# Every field here left at its neutral/off value is what makes a MotionRecipe
# eligible for `build_recipe_zoompan_filter` — see `_is_ffmpeg_native_recipe`.
# `fadeInFrames`/`fadeOutFrames` are deliberately NOT in this dict even
# though they're real, commonly-nonzero fields — the AI applies them
# broadly (an "always-on unless disabled" envelope, not an optional accent
# like Tier 2/4/5), so requiring them at exactly 0 used to route almost
# every real clip through Remotion regardless of anything else. Reproduced
# exactly via a plain `fade=` filter (see build_recipe_zoompan_filter), so
# it's checked and handled there instead of disqualifying the fast path.
#
# `vignette` is deliberately NOT in this dict (i.e. no longer disqualifying)
# despite motion_graphics_engine.py's Pydantic model historically defaulting
# it to 0.15 on every recipe (now 0.0 — see MotionRecipe's own comment) — an
# earlier attempt at a native ffmpeg equivalent was reverted after live
# testing against a real export used ffmpeg's own built-in `vignette` filter:
# a full-frame radial lens model with no parameter combination that
# reproduces MotionClip.tsx's real rendering (a thin inset box-shadow, edges
# only) — it either did nothing or produced a dramatically stronger,
# wrong-shaped effect that read as pillarboxing on a 16:9 frame. This time
# it's handled correctly, as its own dedicated compositing step in
# `_apply_vignette_filter` (see that function's own comment for the exact
# geometry) rather than by ffmpeg's `vignette` filter at all — any vignette
# value, including a dramatic one, can now take this fast path.
_FFMPEG_NATIVE_NEUTRAL_RECIPE = {
    "depthEffect": "none", "storyEffect": "none", "environmentEffect": "none",
    "maskShape": "none", "motionBlurStrength": 0.0, "shakeAmount": 0.0,
    "speedCurve": "linear_pace", "saturationFrom": 1.0, "saturationTo": 1.0,
}


def _is_ffmpeg_native_recipe(recipe: dict) -> bool:
    """Whether a MotionRecipe uses ONLY Tier 1 (camera move — see
    Motion_Graphics_SOP_v1.md's tier catalog), plus optionally a fade-in/out
    envelope (has a native, exact ffmpeg equivalent — see
    `build_recipe_zoompan_filter`), and can therefore render via that
    function — plain ffmpeg, no Remotion/Chromium involved at all — instead
    of the real Remotion composition. This is a pure opt-in fast path, never
    a capability regression: any field below left at other than its
    neutral/off default routes the clip through Remotion exactly as before,
    unchanged. Deliberately conservative — Tier 2 (depth), Tier 4 (story),
    Tier 5 (environment), masks, glow, rotation, motion blur/shake, and
    'elastic' easing (see `_ease_expr`) all still need the real render.
    Vignette is NOT in that list — any value renders correctly via
    `_apply_vignette_filter`'s own compositing step, layered on top of
    whatever this function returns (see its own doc comment).
    `environmentIntensity` is deliberately never checked here — it's inert
    whenever `environmentEffect` is "none" (already required above), exactly
    like a mask's own sub-fields (maskFromRadius/maskSoftness/...) are never
    checked once maskShape=="none" already disqualifies nothing on its own."""
    for key, neutral in _FFMPEG_NATIVE_NEUTRAL_RECIPE.items():
        value = recipe.get(key, neutral)
        if isinstance(neutral, str):
            if value != neutral:
                return False
        elif float(value or 0.0) != neutral:
            return False
    if recipe.get("glowColor"):
        return False
    if recipe.get("pathPoints"):
        return False
    if recipe.get("easing", "ease") == "elastic":
        return False
    if float(recipe.get("rotationFromDeg", 0.0)) != float(recipe.get("rotationToDeg", 0.0)):
        return False
    return True


def build_recipe_zoompan_filter(
    recipe: dict, width: int, height: int, fps: int, duration: float, frames: int,
    color_filter: str = "none", color_filter_intensity: float = 50.0,
    transition_in: str = "cut", transition_out: str = "cut", transition_intensity: float = 50.0,
    zoompan_hold_frames: int | None = None, motion_frames: int | None = None,
) -> str:
    """FFmpeg-native equivalent of a Tier-1-only MotionRecipe — mathematically
    derived from timeline-rendering.ts's `applyMotionRecipe` (translate-then-
    scale around `originX/Y`, in canvas space) converted into zoompan's
    crop-window model, under the same assumption this module's other
    zoompan presets already make (the source image's aspect ratio matches
    the export target — true for AI-generated stills, produced at the
    export's own aspect ratio). The two representations are mathematically
    equivalent; as a sanity check, this reduces to the existing
    `anchored_xy` formula (`(iw-iw/zoom)*sx`) exactly when there's no pan.
    Only reached for a clip `_is_ffmpeg_native_recipe` has already approved
    — lets that clip skip the Remotion/Chromium render entirely, which by
    clip *count* is most of them (Tier 1 is required on every recipe; Tiers
    2/4/5 are optional accents per the SOP's own diversity guidance, not
    the default shape).

    `zoompan_hold_frames` controls zoompan's own `d=` option — how many
    output frames it holds each incoming source frame for. Left `None`
    (the default), it's `frames`: correct for an "image" segment, whose
    input is a single still fed through `-loop 1`, so zoompan itself has to
    stretch that one real input frame across the whole clip. A "video"
    segment's input is already a real, already-moving video stream at one
    input frame per output frame — holding each of ITS frames for `frames`
    output frames would replay the same source frame `frames` times over
    (freezing the video, and blowing up the frame count to roughly
    frames**2). The `video`-segment call site passes `zoompan_hold_frames=1`
    so each source frame maps to exactly one (zoomed/panned) output frame,
    same as any ordinary ffmpeg filter on a video stream.

    `recipe["fadeInFrames"]`/`["fadeOutFrames"]` are also handled natively
    here rather than disqualifying the clip (see `_FFMPEG_NATIVE_NEUTRAL_
    RECIPE`'s own comment on why — an "always on unless disabled" default on
    a real recipe, not a rare accent): MotionClip.tsx ramps this clip's own
    opacity 0->1->1->0 over the given frame counts at each end, composited
    onto Remotion's implicit black backdrop — i.e. exactly a fade-to-black
    envelope, reproduced exactly (not an approximation) via the same `fade=`
    filter every other fade in this module already uses, timed in frames
    (this recipe's own natural timeline) rather than the segment's trimmed
    output duration — same clamp-to-half-the-clip rule as MotionClip.tsx's
    own `fadeIn`/`fadeOut` to match its behavior exactly. `recipe["vignette"]`
    is deliberately NOT handled here — see `_FFMPEG_NATIVE_NEUTRAL_RECIPE`'s
    own comment on the reverted native attempt; any nonzero vignette still
    disqualifies the whole clip from this function being reached at all."""
    frames = max(1, frames)
    # How many frames the camera move normalises its 0->1 progress over, when
    # that differs from how many frames actually get rendered. Only a join
    # transition's tail window sets this (see `_transition_tail_head_segments`);
    # everywhere else it is exactly `frames`, i.e. unchanged behavior. The
    # `min(1, ...)` clamp means the extra rendered frames hold at the
    # fully-eased end pose instead of running a stretched, slower curve.
    motion_span = max(1, (motion_frames if motion_frames else frames) - 1)
    t_expr = f"min(1,on/{motion_span})"
    eased = _ease_expr(recipe.get("easing", "ease"), t_expr)
    scale_from = float(recipe.get("scaleFrom", 1.0))
    scale_to = float(recipe.get("scaleTo", 1.0))
    static_zoom = float(recipe.get("staticZoomPercent", 0.0))
    z_expr = (
        f"(({scale_from:.6f}+({scale_to:.6f}-{scale_from:.6f})*{eased})"
        f"*(1+{static_zoom:.6f}/100))"
    )
    sx = float(recipe.get("originX", 50.0)) / 100
    sy = float(recipe.get("originY", 50.0)) / 100
    pan_x_from = float(recipe.get("panXFrom", 0.0)) / 100
    pan_x_to = float(recipe.get("panXTo", 0.0)) / 100
    pan_y_from = float(recipe.get("panYFrom", 0.0)) / 100
    pan_y_to = float(recipe.get("panYTo", 0.0)) / 100
    px_expr = f"({pan_x_from:.6f}+({pan_x_to:.6f}-{pan_x_from:.6f})*{eased})"
    py_expr = f"({pan_y_from:.6f}+({pan_y_to:.6f}-{pan_y_from:.6f})*{eased})"
    x_expr = f"(iw-iw/zoom)*{sx:.6f}-(iw/zoom)*{px_expr}"
    y_expr = f"(ih-ih/zoom)*{sy:.6f}-(ih/zoom)*{py_expr}"

    # The recipe's own fade-in/out opacity envelope (see this function's own
    # doc comment) — timed against `frames` (this recipe's natural
    # timeline), independent of `duration`/the transitionIn/Out fades below.
    # Same half-the-clip clamp as MotionClip.tsx's `fadeIn`/`fadeOut`.
    fades: list[str] = []
    fade_in_frames = max(0.0, min(float(recipe.get("fadeInFrames", 0.0) or 0.0), frames / 2))
    fade_out_frames = max(0.0, min(float(recipe.get("fadeOutFrames", 0.0) or 0.0), frames / 2))
    if fade_in_frames > 0:
        fades.append(f"fade=t=in:st=0:d={fade_in_frames / fps:.3f}:color=black")
    if fade_out_frames > 0:
        envelope_fade_out_start = max(0.0, frames / fps - fade_out_frames / fps)
        fades.append(f"fade=t=out:st={envelope_fade_out_start:.3f}:d={fade_out_frames / fps:.3f}:color=black")

    # Same fade-to-black/white handling as build_image_filter, and the same
    # transition-intensity scaling (_scaled_fade_seconds) every other
    # segment kind already gets — a Tier-1-only recipe still has its own
    # transitionIn/Out like any other still.
    fade_in_duration = _scaled_fade_seconds(duration, transition_intensity)
    fade_out_duration = _scaled_fade_seconds(duration, transition_intensity)
    if transition_in in ("fade", "dip-to-white"):
        in_color = "white" if transition_in == "dip-to-white" else "black"
        fades.append(f"fade=t=in:st=0:d={fade_in_duration:.3f}:color={in_color}")
    if transition_out in ("fade", "dip-to-white"):
        out_color = "white" if transition_out == "dip-to-white" else "black"
        fades.append(f"fade=t=out:st={max(0.0, duration - fade_out_duration):.3f}:d={fade_out_duration:.3f}:color={out_color}")
    fade = "".join(f",{f}" for f in fades)

    # Same pre-scale sub-pixel-stutter fix as every other zoompan preset
    # above — see `_ZOOMPAN_PRE_SCALE_FACTOR`'s own comment for the measured
    # speed/smoothness rationale behind its exact value.
    pre_scale = max(width, height) * _ZOOMPAN_PRE_SCALE_FACTOR
    color_vf = build_color_filter_vf(color_filter, color_filter_intensity)
    color_node = f",{color_vf}" if color_vf else ""
    hold = frames if zoompan_hold_frames is None else max(1, zoompan_hold_frames)
    # zoompan's own `fps=` option only sets the OUTPUT timebase/pacing for
    # `on`'s time math — with `d=1` (a real video source, one output frame
    # per real input frame) it does NOT resample the stream, unlike the
    # image-loop case where zoompan's `d={frames}` already fully controls
    # frame count independent of any source rate. A real source clip's own
    # native fps very often differs from the export's target fps (confirmed
    # against a real Veo-generated clip: 24fps/185 frames feeding a 30fps/
    # 260-frame slot) — without resampling first, zoompan just runs out of
    # real input frames early, silently emitting fewer output frames than
    # `-frames:v` asked for and desyncing every segment after it in the
    # final concat. An explicit `fps=` FILTER (not zoompan's option) before
    # scale/zoompan forces the real resample, exactly like build_video_filter
    # already does for a video with no recipe at all.
    fps_resample_node = f"fps={fps}," if zoompan_hold_frames is not None else ""
    return (
        f"{fps_resample_node}scale={pre_scale}:-2,zoompan=z='{z_expr}':x='{x_expr}':y='{y_expr}':"
        f"d={hold}:s={width}x{height}:fps={fps}{color_node}{fade}"
    )


# Generation resolution (long edge, px) for the cached vignette mask built by
# `_ensure_vignette_mask` — a smooth, position-only gradient loses nothing
# visible at this size, and generating it once here (then letting a cheap
# `scale`+`blend` upsample/apply it to every real output frame) is what keeps
# this fast. Measured on a real 4K zoompan clip: computing the exact same
# per-pixel expression directly on every full-resolution output frame via
# `geq` ran at ~1.7fps (a ~45x slowdown vs. ~78fps with no vignette at all —
# i.e. reintroducing the exact "hours to export" problem this whole fast path
# exists to avoid); this two-stage approach measured identical to the
# no-vignette baseline (~79fps).
_VIGNETTE_MASK_LONG_EDGE = 480


def _vignette_mask_geometry(width: int, height: int, vignette: float) -> tuple[int, int, str]:
    """Computes the small mask's own pixel dimensions and the `geq` luma
    expression that renders it: the exact greyscale "keep factor" (0-255,
    255 = untouched) for MotionClip.tsx's own vignette overlay —
    `boxShadow: inset 0 0 {blurPx}px {blurPx*0.55}px rgba(0,0,0,0.7)` where
    `blurPx = interpolate(vignette, [0,1], [0,190])` (see
    services/motion-engine/src/MotionClip.tsx) — composited onto opaque
    content. `rgba(0,0,0,a)` painted over any opaque color C reduces to
    `C*(1-a)` (black contributes nothing), so the whole effect is just a
    per-pixel multiply by `(1-a)` — computed here as a reusable greyscale
    mask instead of carrying a real alpha channel through the pipeline.

    CSS inset box-shadow geometry: `spread` shrinks the (invisible) shadow
    rectangle inward from each edge by `spread` px before blurring; that hard
    step — zero shadow outside the shrunk rect, full shadow color inside —
    is then Gaussian-blurred by `blur`. Approximated here, like every eased
    camera-move curve elsewhere in this module (see `_ease_expr`'s own
    comment on why that's fine for a soft, position-only visual with no hard
    edge to get wrong), with a plain smoothstep instead of a true Gaussian.
    `edge0`/`edge1` bracket that smoothstep symmetrically around the spread
    boundary, `blur`-px wide (roughly a Gaussian's own effective falloff
    width), clamped so it never starts before the true frame edge (`d=0`).

    Distance-to-nearest-edge — `min` of both axes independently, never a
    radial/elliptical falloff — is what keeps this a true rectangular
    vignette at any aspect ratio, unlike ffmpeg's own built-in `vignette`
    filter (a full-frame radial lens model whose only prior use here read as
    pillarboxing on a 16:9 frame; see `_FFMPEG_NATIVE_NEUTRAL_RECIPE`'s own
    comment on that reverted attempt)."""
    aspect = width / height
    if width >= height:
        mask_w = _VIGNETTE_MASK_LONG_EDGE
        mask_h = max(2, round(_VIGNETTE_MASK_LONG_EDGE / aspect))
    else:
        mask_h = _VIGNETTE_MASK_LONG_EDGE
        mask_w = max(2, round(_VIGNETTE_MASK_LONG_EDGE * aspect))
    # Downscaled by the same factor the mask itself is downsized by, so the
    # blur/spread band's width in real OUTPUT pixels (after the per-clip
    # `scale` back up to `width`x`height`) matches MotionClip.tsx's own
    # px math exactly, not `mask_w`-relative.
    scale = mask_w / width
    blur_px = max(0.0, min(1.0, vignette)) * 190.0 * scale
    spread_px = blur_px * 0.55
    edge0 = max(0.0, spread_px - blur_px / 2)
    span = max((spread_px + blur_px / 2) - edge0, 1e-3)
    distance_to_edge = "min(min(X,W-1-X),min(Y,H-1-Y))"
    progress = f"clip(({distance_to_edge}-{edge0:.4f})/{span:.4f},0,1)"
    smoothstep = f"({progress}*{progress}*(3-2*({progress})))"
    keep_expr = f"(255*(1-0.7*(1-{smoothstep})))"
    return mask_w, mask_h, keep_expr


def _ensure_vignette_mask(mask_dir: Path, width: int, height: int, vignette: float) -> Path:
    """Materializes (or reuses an already-cached) small greyscale PNG for
    `_vignette_mask_geometry`'s own keep-factor mask, generated once via a
    single-frame `geq` pass — cheap regardless of `geq`'s own slow per-pixel
    evaluator (see `_VIGNETTE_MASK_LONG_EDGE`'s own comment), since it only
    ever runs at that fixed low resolution, exactly once per distinct
    (aspect ratio, vignette value) pair across a whole export — every later
    clip sharing that pair reuses the same cached file in `mask_dir`, keyed
    by filename. See `_apply_vignette_filter` for how each clip applies it."""
    mask_w, mask_h, keep_expr = _vignette_mask_geometry(width, height, vignette)
    mask_path = mask_dir / f"_vignette_mask_{mask_w}x{mask_h}_{max(0.0, min(1.0, vignette)):.3f}.png"
    if not mask_path.exists():
        subprocess.run(
            [
                "ffmpeg", "-y", "-f", "lavfi", "-i", f"color=c=white:s={mask_w}x{mask_h}:d=1",
                "-vf", f"format=gray,geq=lum='{keep_expr}'", "-frames:v", "1", str(mask_path),
            ],
            capture_output=True, text=True, **_subprocess_kwargs(),
        )
    return mask_path


def _apply_vignette_filter(
    vf: str, vignette: float, width: int, height: int, duration_bound: float, mask_dir: Path,
) -> tuple[list[str], list[str]]:
    """Wraps an existing single-input `-vf` chain (as built by
    `build_recipe_zoompan_filter`) so its output also gets this recipe's own
    vignette multiplied on top, when it has one. Returns
    `(extra_input_args, video_output_args)`:
    - When `vignette <= 0` (the common case — most clips carry no vignette at
      all, see `MotionRecipe.vignette`'s own comment): `([], ["-vf", vf])`,
      i.e. completely unchanged behavior.
    - Otherwise: `extra_input_args` is a real second `-i` for a generated
      mask file that the CALLER must splice into its own ffmpeg command's
      input args, immediately after its one real source `-i` (so it lands at
      input index 1 — this function's own filtergraph assumes exactly that
      layout), and `video_output_args` switches from `-vf` to
      `-filter_complex`/`-map` to combine the two. `-vf`'s own single-input
      "simple filtergraph" parser rejects a second, unconnected source filter
      — confirmed empirically: even a source-only `movie=` node with no `-i`
      of its own errors with "expected exactly 1 input and 1 output" — so a
      real filter_complex is unavoidable here, unlike the plain `-vf` chains
      used everywhere else in this module.

    The mask input is `-loop 1`-ed the same way an ordinary still image
    already is elsewhere in this module, bounded by `duration_bound` (the
    caller's own longest possible real frame count in seconds, WITH
    headroom — must cover at least as much as `vf`'s own output can ever
    produce, e.g. a join-transition tail's motion-extended frame count, not
    just the segment's nominal duration) so `blend`'s own `shortest=1` never
    truncates the real clip early by running out of mask frames first."""
    if vignette <= 0:
        return [], ["-vf", vf]
    mask_path = _ensure_vignette_mask(mask_dir, width, height, vignette)
    extra_input_args = ["-loop", "1", "-t", f"{duration_bound:.3f}", "-i", str(mask_path)]
    filter_complex = (
        f"[0:v]{vf}[_vgz];"
        f"[1:v]scale={width}:{height}:flags=bicubic,format=yuv420p[_vgm];"
        f"[_vgz][_vgm]blend=all_mode=multiply:shortest=1,format=yuv420p[_vgout]"
    )
    return extra_input_args, ["-filter_complex", filter_complex, "-map", "[_vgout]"]


def build_video_filter(
    transition_in: str, transition_out: str, width: int, height: int, fps: int, duration: float,
    color_filter: str = "none", color_filter_intensity: float = 50.0,
    transition_intensity: float = 50.0,
) -> str:
    """Scale/pad a generated animation clip onto the target canvas, same as a
    still's `build_image_filter` but with no Ken-Burns zoompan — Veo output
    already has real motion, it just needs to fit the export frame."""
    fades = []
    if transition_in in ("fade", "dip-to-white"):
        fade_in_duration = _scaled_fade_seconds(duration, transition_intensity)
        in_color = "white" if transition_in == "dip-to-white" else "black"
        fades.append(f"fade=t=in:st=0:d={fade_in_duration:.3f}:color={in_color}")
    if transition_out in ("fade", "dip-to-white"):
        fade_out_duration = _scaled_fade_seconds(duration, transition_intensity)
        out_color = "white" if transition_out == "dip-to-white" else "black"
        fades.append(f"fade=t=out:st={max(0.0, duration - fade_out_duration):.3f}:d={fade_out_duration:.3f}:color={out_color}")
    fade = "".join(f",{f}" for f in fades)
    color_vf = build_color_filter_vf(color_filter, color_filter_intensity)
    color_node = f",{color_vf}" if color_vf else ""
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},setsar=1,fps={fps}{color_node}{fade}"
    )


def run_ffmpeg(args: list[str]) -> None:
    result = subprocess.run(
        ["ffmpeg", *args], capture_output=True, text=True, **_subprocess_kwargs()
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr[-2000:]}")


def _without_extended_path_prefix(path: Path) -> Path:
    """Windows' `Path.resolve()` can hand back an extended-length
    (`\\\\?\\...`) path depending on the install drive/filesystem driver —
    confirmed happening for at least one real install (a deeply nested
    custom install directory on a `D:` drive). `cmd.exe` (which `npm.cmd`/
    `npx.cmd` — themselves plain batch files — always shell out through)
    flatly refuses to use an extended-length path as its starting
    directory: it silently falls back to `%SystemRoot%` (`C:\\Windows`)
    instead, where it then has no write permission — surfacing as a
    baffling `npm error ... EPERM ... C:\\Windows\\package-lock.json`, with
    no obvious link back to the real cause. Stripping the prefix keeps the
    exact same real filesystem location while staying something cmd.exe can
    actually chdir into. A plain (non-UNC, non-extended) path passes through
    unchanged."""
    text = str(path)
    if text.startswith("\\\\?\\UNC\\"):
        return Path("\\\\" + text[8:])
    if text.startswith("\\\\?\\"):
        return Path(text[4:])
    return path


# services/motion-engine — the Remotion project that renders whatever
# free-form "motion recipe" motion_graphics_engine.py composed for a clip (see
# that module's docstring — there's no fixed catalog of named treatments
# anymore, just a shared vocabulary of independent primitives). Sibling of
# python-engine under services/.
MOTION_ENGINE_DIR = _without_extended_path_prefix(Path(__file__).resolve().parents[2] / "motion-engine")


def _resolve_node_bin(name: str) -> str:
    """`shutil.which` (unlike a bare `subprocess.run(["npm", ...])`) correctly
    follows PATHEXT on Windows, where npm/npx are `.cmd` shims rather than
    `.exe` files — `subprocess.run` without `shell=True` can't find those by
    bare name and fails with WinError 2."""
    resolved = shutil.which(name)
    if not resolved:
        raise RuntimeError(
            f"'{name}' was not found on PATH. Rendering AI-assigned motion-graphic "
            "treatments requires Node.js — install it from nodejs.org and try again."
        )
    return resolved


def _motion_engine_installed() -> bool:
    """Whether services/motion-engine's `npm install`/`npm ci` actually
    produced a usable `remotion` CLI — checking that `node_modules` merely
    *exists* (the old check) was too weak: an install interrupted partway
    (network drop, disk space, antivirus interference, npm itself crashing)
    can leave a `node_modules` folder behind that's missing the `remotion`
    package's bin entirely, and that folder's mere existence then
    permanently short-circuits every future install attempt too — the exact
    shape of a real user's report: 'npx: could not determine executable to
    run', which is npm's confusing way of saying it couldn't find `remotion`
    locally and didn't know what registry package to fall back to. Checking
    for the concrete file the render step actually depends on catches a
    broken partial install and triggers a real (re)install instead of
    silently trusting a folder that's there but empty/incomplete. This app
    only ships for Windows (see CLAUDE.md), so the `.cmd` shim is the only
    variant that matters here."""
    return (MOTION_ENGINE_DIR / "node_modules" / ".bin" / "remotion.cmd").exists()


def _robust_rmtree(path: Path, attempts: int = 5, delay_seconds: float = 1.0) -> None:
    """Windows can transiently hold a lock on a file somewhere inside a large
    `node_modules` tree (antivirus scanning it, the search indexer, a handle
    left open by a just-exited process) just long enough that a single
    delete attempt fails — confirmed by a real user's report where `npm ci`'s
    own internal "delete node_modules first" step hit exactly this
    (`ENOTEMPTY: directory not empty, rmdir ...\\node_modules\\remotion\\dist\\cjs`),
    left the tree in a broken partial state, and then the install that
    followed failed too (`ENOENT ... Cannot cd into ...\\node_modules\\webpack`)
    — a second plain `npm ci`/`npm install` attempt alone doesn't fix this,
    it just hits the same partial state again. Retrying the delete with a
    short backoff is usually enough for a transient lock to clear."""
    last_error: OSError | None = None
    for _ in range(attempts):
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            return
        except OSError as error:
            last_error = error
            time.sleep(delay_seconds)
    if path.exists() and last_error is not None:
        raise last_error


def _ensure_remotion_browser_downloaded() -> None:
    """Explicitly verifies (and downloads if missing) the headless Chromium
    Remotion's renderer needs, via `@remotion/renderer`'s own `ensureBrowser`
    — root-cause fix for a real user's export crash:
    'ENOENT ... node_modules\\.remotion\\chrome-headless-shell\\chrome-headless-shell-win64.zip',
    an unhandled promise rejection from deep inside Remotion's own lazy,
    on-first-render download path, surfaced as a raw Node stack trace with
    no indication of what actually went wrong or how to fix it. Calling this
    proactively (from `_ensure_motion_engine_ready`, i.e. before the first
    render *and* self-healingly on every subsequent one) turns a silent or
    partial download failure into one clear, actionable error instead."""
    result = subprocess.run(
        [
            _resolve_node_bin("node"), "-e",
            "require('@remotion/renderer').ensureBrowser()"
            ".then(() => process.exit(0))"
            ".catch((e) => { console.error(String(e && e.stack || e)); process.exit(1); });",
        ],
        cwd=str(MOTION_ENGINE_DIR), capture_output=True, text=True, **_subprocess_kwargs(),
    )
    if result.returncode != 0:
        raise RuntimeError(
            "Could not prepare the motion-graphics render engine's headless "
            f"Chromium: {result.stderr[-2000:] or result.stdout[-2000:]}\n"
            "This usually means the download was interrupted or blocked (antivirus, "
            "network) — try the export again; if it keeps happening, check your "
            "internet connection and antivirus settings, or reinstall Auto Gen Studio."
        )


def _ensure_motion_engine_ready() -> None:
    """One-time (or self-healing) `npm ci`/`npm install` for
    services/motion-engine, mirroring this module's own `_check_deps()`-style
    self-installing philosophy — a fresh checkout/install shouldn't need a
    manual setup step before AI motion graphics can render for the first
    time. Prefers `npm ci` over `npm install` whenever the bundled
    `package-lock.json` resource is present: besides being the deterministic,
    lockfile-exact install, `npm ci` always deletes any existing
    `node_modules` first — which is exactly what turns a broken partial
    install (see `_motion_engine_installed`'s doc comment) into a clean one
    on the very next export attempt, with no manual intervention needed.
    That delete-first step can itself fail on Windows though (see
    `_robust_rmtree`'s doc comment) — this retries through that specific
    failure before giving up. Also verifies the actual headless-Chromium
    download Remotion needs at render time, not just the npm packages (see
    `_ensure_remotion_browser_downloaded`)."""
    if not MOTION_ENGINE_DIR.is_dir():
        # `cwd=` below only ever raises the cryptic OS-level
        # `[WinError 267] The directory name is invalid` if this is missing —
        # give a message that actually points at the fix (a packaging bug:
        # the motion-engine sidecar wasn't bundled as an app resource) rather
        # than let that opaque error surface to the user.
        raise RuntimeError(
            f"The motion-graphics render engine is missing from this install "
            f"(expected at {MOTION_ENGINE_DIR}). Reinstall Auto Gen Studio; if "
            "this keeps happening, the app package is missing the motion-engine "
            "resource."
        )
    if not _motion_engine_installed():
        npm = _resolve_node_bin("npm")
        install_args = ["ci"] if (MOTION_ENGINE_DIR / "package-lock.json").exists() else ["install"]
        result = subprocess.run(
            [npm, *install_args], cwd=str(MOTION_ENGINE_DIR),
            capture_output=True, text=True, **_subprocess_kwargs(),
        )
        if result.returncode != 0:
            node_modules = MOTION_ENGINE_DIR / "node_modules"
            if node_modules.exists():
                try:
                    _robust_rmtree(node_modules)
                except OSError:
                    pass  # best-effort — the error below still fires if this didn't help
                retry = subprocess.run(
                    [npm, "install"], cwd=str(MOTION_ENGINE_DIR),
                    capture_output=True, text=True, **_subprocess_kwargs(),
                )
                if retry.returncode == 0:
                    result = retry
        if result.returncode != 0:
            raise RuntimeError(
                f"Could not install the motion-graphics render engine: {result.stderr[-2000:]}"
            )
        if not _motion_engine_installed():
            raise RuntimeError(
                "The motion-graphics render engine installed but 'remotion' still "
                f"isn't available at {MOTION_ENGINE_DIR}\\node_modules\\.bin\\remotion.cmd — "
                "try the export again; if this keeps happening, reinstall Auto Gen Studio."
            )
    _ensure_remotion_browser_downloaded()


def _render_motion_graphic(
    media_path: str, source_kind: str, effect: str, settings: dict,
    frames: int, fps: int, width: int, height: int, out_path: Path,
    motion_frames: int | None = None,
) -> None:
    """Renders one clip's AI-composed (or manually overridden) motion recipe
    via services/motion-engine's generalized `MotionClip` composition,
    writing a plain MP4 to `out_path` — the caller (`_encode_segment_to_path`)
    still applies this segment's own color filter / transition fades and the
    exact output frame count on top of this in a second, ordinary ffmpeg
    pass, same as every other segment kind. `--public-dir` points Remotion's
    headless Chromium at the media file's own folder so `staticFile(mediaPath)`
    inside the composition can load it — Chromium refuses to load `file://`
    URLs outside a folder it's been told is servable. This same mechanism
    works identically for a video source (`source_kind="video"` — a still
    replaced by an animation/imported clip keeps whatever Camera Effect was
    set on it, see build_segments) as for the original static-image case —
    `MotionClip.tsx` picks `<OffthreadVideo>` vs `<Img>` based on `sourceKind`
    but the same transform math (an ancestor `<AbsoluteFill>`'s CSS
    transform, never the media element itself) applies to either.

    `effect` (the free-text treatment label, kept as its own DB column for
    quick display/debugging — see projects.rs) is only used here for the
    error message; the composition itself reads everything it needs — label
    included — from `settings`, forwarded whole as the single `recipe` prop
    (see services/motion-engine/src/types.ts's `MotionRecipe`)."""
    _ensure_motion_engine_ready()
    media_file = Path(media_path)
    props = {
        "mediaPath": media_file.name,
        "sourceKind": source_kind,
        "recipe": settings,
        "durationInFrames": max(1, frames),
        # Omitted unless it actually differs — MotionClip falls back to
        # durationInFrames, i.e. unchanged behavior for every ordinary clip.
        **({"motionDurationInFrames": max(1, motion_frames)}
           if motion_frames and motion_frames != frames else {}),
        "fps": fps,
        "width": width,
        "height": height,
    }
    props_path = out_path.with_suffix(".props.json")
    props_path.write_text(json.dumps(props), encoding="utf-8")
    try:
        result = subprocess.run(
            [
                # `--no-install` (npx's own flag, not Remotion's): never fall
                # back to an ad-hoc registry install if `remotion` isn't
                # resolved locally — `_ensure_motion_engine_ready` above is
                # what's responsible for that; if it's somehow still missing
                # here, fail with a clear "not found" instead of npx's
                # confusing "could not determine executable to run".
                _resolve_node_bin("npx"), "--no-install", "remotion", "render", "src/index.ts", "MotionClip", str(out_path),
                f"--props={props_path}",
                f"--public-dir={media_file.parent}",
                # This clip's own audio is never used downstream — every
                # caller of _render_motion_graphic re-encodes the output with
                # its own `-an` (video kind) or simply never maps an audio
                # stream from it at all (image kind); the export's real audio
                # comes entirely from narration/music mixed separately in the
                # final pass. `--muted` skips Remotion's own audio encode
                # pass for free (confirmed via a real render: it's the
                # difference between the "audio: Encoding progress" step
                # running at all).
                "--muted",
                # Caps how many browser tabs THIS one render uses internally.
                # Segments (including motion-graphic ones) already run up to
                # MAX_ENCODE_WORKERS at a time via the outer ThreadPoolExecutor
                # — without an explicit cap here, each concurrent Remotion
                # process independently defaults to using most of the
                # machine's cores, so several running at once oversubscribe
                # the CPU (N processes x each trying to use ~all cores) and
                # can end up slower than if they'd shared cleanly. Dividing
                # available cores across the worker slots keeps total
                # concurrent tab usage roughly bounded regardless of how many
                # motion-graphic clips land in the same batch.
                f"--concurrency={_remotion_concurrency()}",
                "--log=error",
            ],
            cwd=str(MOTION_ENGINE_DIR), capture_output=True, text=True, **_subprocess_kwargs(),
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"Motion-graphics render failed for {effect!r}: {result.stderr[-2000:]}"
            )
    finally:
        props_path.unlink(missing_ok=True)


def _encode_segment_to_path(
    segment: dict, out_path: Path, width: int, height: int, fps: int,
) -> None:
    """Core per-kind ffmpeg invocation for an image/video/black segment,
    factored out of `encode_segment` so `_build_transition_segment` can reuse
    it to render the tail/head windows a join transition blends together.
    `_originalFrames` (full untrimmed length, used for motion-rate math and
    as the trim filter's upper bound) defaults to `frames` when absent — the
    common case, since only segments touched by `expand_join_transitions`
    ever set it explicitly. `_trimStartFrames` skips that many frames off the
    segment's own head (needed when a preceding join transition consumed
    them) via ffmpeg's `trim` filter — cheap for the common case of 0."""
    # `duration` (seconds) only bounds the input source (loop/color generator)
    # with headroom to spare — the segment's actual output length is fixed by
    # `-frames:v`, using the cumulative-frame-accurate count `assign_frame_counts`
    # already computed, not by re-deriving it from a time value. Trimming
    # output by `-t` instead would round each segment independently, which is
    # exactly the per-clip rounding error that used to accumulate into a
    # growing drift across many stills.
    duration = max(0.05, segment["end"] - segment["start"])
    output_frames = segment["frames"]
    original_frames = segment.get("_originalFrames", output_frames)
    # Normally identical to `original_frames`; only a join transition's tail
    # window renders MORE frames than the clip's camera move is normalised
    # over (see `_transition_tail_head_segments`).
    motion_frames = segment.get("_motionFrames", original_frames)
    trim_start_frames = segment.get("_trimStartFrames", 0)
    if (
        segment["kind"] in ("image", "video")
        and segment.get("motionGraphicEffect") and segment.get("motionGraphicSettings")
        and _is_ffmpeg_native_recipe(segment["motionGraphicSettings"])
    ):
        # Tier-1-only recipe (see _is_ffmpeg_native_recipe) — one plain
        # ffmpeg pass via build_recipe_zoompan_filter, no Remotion/Chromium
        # involved at all. Originally "image"-only; a "video" segment
        # (an animation/imported clip carrying nothing beyond the mandatory
        # Tier-1 camera move — the common case, since Tiers 2/4/5 are
        # optional accents) qualifies exactly the same way and used to fall
        # through to the Remotion branch below unconditionally regardless of
        # how simple its recipe was — the dominant cost of a real export on
        # any timeline built mostly from animation clips, each paying
        # Remotion's per-clip render even for a plain push-in.
        if segment["kind"] == "image":
            # Mirrors the plain "image" branch below exactly (same -loop 1
            # input, same trim handling) with the recipe-derived zoompan
            # filter standing in for build_image_filter's discrete presets.
            vf = build_recipe_zoompan_filter(
                segment["motionGraphicSettings"], width, height, fps, duration, original_frames,
                segment.get("colorFilter", "none"), segment.get("colorFilterIntensity", 50.0),
                segment.get("transitionIn", "cut"), segment.get("transitionOut", "cut"),
                segment.get("transitionIntensity", 50.0),
                motion_frames=motion_frames,
            )
            if trim_start_frames > 0:
                vf = f"{vf},trim=start_frame={trim_start_frames}:end_frame={original_frames},setpts=PTS-STARTPTS"
            vignette_inputs, video_args = _apply_vignette_filter(
                vf, float(segment["motionGraphicSettings"].get("vignette", 0.0) or 0.0),
                width, height, max(duration, original_frames / fps) + 1.0, out_path.parent,
            )
            run_ffmpeg([
                "-y", "-loop", "1", "-t", f"{duration + 1:.3f}", "-i", segment["path"],
                *vignette_inputs, *video_args,
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
                "-r", str(fps), "-frames:v", str(output_frames), str(out_path),
            ])
        else:
            # "video" source — already a real, moving video stream (one
            # input frame per output frame), unlike the "image" branch's
            # `-loop 1` single still. `zoompan_hold_frames=1` tells zoompan
            # to hold each incoming frame for exactly one output frame
            # instead of stretching a single source frame across the whole
            # clip (see build_recipe_zoompan_filter's own doc comment).
            vf = build_recipe_zoompan_filter(
                segment["motionGraphicSettings"], width, height, fps, duration, original_frames,
                segment.get("colorFilter", "none"), segment.get("colorFilterIntensity", 50.0),
                segment.get("transitionIn", "cut"), segment.get("transitionOut", "cut"),
                segment.get("transitionIntensity", 50.0),
                zoompan_hold_frames=1, motion_frames=motion_frames,
            )
            # Same stale-asset safety net + trim handling as the plain
            # (no-recipe) "video" branch below — see its own comments.
            source_duration = segment.get("sourceDurationSeconds")
            if source_duration is not None and source_duration < duration - 0.05:
                vf = f"tpad=stop_mode=clone:stop_duration={duration - source_duration:.3f},{vf}"
            if trim_start_frames > 0:
                vf = f"{vf},trim=start_frame={trim_start_frames}:end_frame={original_frames},setpts=PTS-STARTPTS"
            vignette_inputs, video_args = _apply_vignette_filter(
                vf, float(segment["motionGraphicSettings"].get("vignette", 0.0) or 0.0),
                width, height, max(duration, original_frames / fps) + 1.0, out_path.parent,
            )
            run_ffmpeg([
                "-y", "-i", segment["path"],
                *vignette_inputs, *video_args, "-an",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
                "-r", str(fps), "-frames:v", str(output_frames), str(out_path),
            ])
    elif segment["kind"] in ("image", "video") and segment.get("motionGraphicEffect") and segment.get("motionGraphicSettings"):
        # AI-composed (or manually overridden) motion recipe that actually
        # needs Tier 2/4/5 (depth/story/environment/mask/glow/rotation/
        # elastic easing — see _is_ffmpeg_native_recipe): render the real
        # thing via services/motion-engine instead of approximating it with
        # a zoompan preset, then apply this segment's own color filter and
        # transition fades on top in an ordinary second ffmpeg pass — same
        # post-processing every other segment kind already gets. A "video"
        # segment goes through the exact same Remotion render as an "image"
        # one — just with a video source (`source_kind="video"`, see
        # `_render_motion_graphic`) instead of a static one. A Tier-1-only
        # recipe on either kind is handled entirely by the branch above and
        # never reaches here.
        # `run()` pre-renders every motion-graphic clip it can up front, in
        # one batched Node process that bundles once and reuses one browser
        # across all of them (see `_batch_render_motion_graphics`) — far
        # cheaper than this falling back to spawning a whole fresh
        # Node/webpack/Chromium process per clip via `_render_motion_graphic`
        # below (measured at ~30s of pure startup overhead per clip). Only
        # segments the batch step didn't cover (or that failed there) still
        # take that slower path — e.g. a join-transition's tail/head window,
        # synthesized after the batch step already ran.
        pre_rendered = segment.get("_preRenderedRawPath")
        if pre_rendered and Path(pre_rendered).exists():
            raw_path = Path(pre_rendered)
            cleanup_raw_path = False
        else:
            raw_path = out_path.with_suffix(".raw.mp4")
            cleanup_raw_path = True
            _render_motion_graphic(
                segment["path"], "video" if segment["kind"] == "video" else "image",
                segment["motionGraphicEffect"], segment["motionGraphicSettings"],
                original_frames, fps, width, height, raw_path, motion_frames,
            )
        vf_parts = []
        color_vf = build_color_filter_vf(
            segment.get("colorFilter", "none"), segment.get("colorFilterIntensity", 50.0)
        )
        if color_vf:
            vf_parts.append(color_vf)
        segment_transition_intensity = segment.get("transitionIntensity", 50.0)
        fade_in_duration = _scaled_fade_seconds(duration, segment_transition_intensity)
        fade_out_duration = _scaled_fade_seconds(duration, segment_transition_intensity)
        transition_in = segment.get("transitionIn", "cut")
        transition_out = segment.get("transitionOut", "cut")
        if transition_in in ("fade", "dip-to-white"):
            in_color = "white" if transition_in == "dip-to-white" else "black"
            vf_parts.append(f"fade=t=in:st=0:d={fade_in_duration:.3f}:color={in_color}")
        if transition_out in ("fade", "dip-to-white"):
            out_color = "white" if transition_out == "dip-to-white" else "black"
            vf_parts.append(
                f"fade=t=out:st={max(0.0, duration - fade_out_duration):.3f}:d={fade_out_duration:.3f}:color={out_color}"
            )
        if segment["kind"] == "video":
            # Same stale-asset safety net the plain (no-recipe) "video"
            # branch below applies — Remotion's rendered output can end up
            # shorter than the timeline slot if the source clip itself is
            # (e.g. the slot was resized after the last "Adjust animation to
            # duration" click): clone the last frame to fill the remainder
            # rather than let ffmpeg emit fewer frames than `-frames:v` asks
            # for.
            source_duration = segment.get("sourceDurationSeconds")
            if source_duration is not None and source_duration < duration - 0.05:
                vf_parts.insert(0, f"tpad=stop_mode=clone:stop_duration={duration - source_duration:.3f}")
        if trim_start_frames > 0:
            vf_parts.insert(0, f"trim=start_frame={trim_start_frames}:end_frame={original_frames},setpts=PTS-STARTPTS")
        vf = ",".join(vf_parts) if vf_parts else "null"
        try:
            run_ffmpeg([
                "-y", "-i", str(raw_path),
                "-vf", vf, *(["-an"] if segment["kind"] == "video" else []),
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
                "-r", str(fps), "-frames:v", str(output_frames), str(out_path),
            ])
        finally:
            if cleanup_raw_path:
                raw_path.unlink(missing_ok=True)
    elif segment["kind"] == "image":
        vf = build_image_filter(
            segment.get("motion", "none"),
            segment.get("transitionIn", "cut"),
            segment.get("transitionOut", "cut"),
            segment.get("motionIntensity", 0.22),
            width, height, fps, duration, original_frames,
            segment.get("subjectX", 0.5), segment.get("subjectY", 0.5),
            segment.get("colorFilter", "none"), segment.get("colorFilterIntensity", 50.0),
            segment.get("cutIndex", 0), segment.get("transitionIntensity", 50.0),
        )
        if trim_start_frames > 0:
            vf = f"{vf},trim=start_frame={trim_start_frames}:end_frame={original_frames},setpts=PTS-STARTPTS"
        run_ffmpeg([
            "-y", "-loop", "1", "-t", f"{duration + 1:.3f}", "-i", segment["path"],
            # Intermediate segments are re-encoded again in the final concat
            # pass, so a low-quality intermediate compounds into a visibly
            # blurrier/blockier final export (double generation loss). A high
            # CRF here keeps this first pass close to lossless — the disk
            # cost is temporary, these files are deleted after the final pass.
            "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
            "-r", str(fps), "-frames:v", str(output_frames), str(out_path),
        ])
    elif segment["kind"] == "video":
        vf = build_video_filter(
            segment.get("transitionIn", "cut"),
            segment.get("transitionOut", "cut"),
            width, height, fps, duration,
            segment.get("colorFilter", "none"), segment.get("colorFilterIntensity", 50.0),
            segment.get("transitionIntensity", 50.0),
        )
        # Safety net for a stale asset (the slot was resized after the last
        # "Adjust animation to duration" click): if the stored clip is
        # shorter than the slot now needs, clone its last frame to fill the
        # remainder rather than let ffmpeg silently emit fewer frames than
        # `-frames:v` asked for. If it's longer, `-frames:v` below simply
        # truncates it — no special-casing needed for that direction.
        source_duration = segment.get("sourceDurationSeconds")
        if source_duration is not None and source_duration < duration - 0.05:
            vf = f"tpad=stop_mode=clone:stop_duration={duration - source_duration:.3f},{vf}"
        if trim_start_frames > 0:
            vf = f"{vf},trim=start_frame={trim_start_frames}:end_frame={original_frames},setpts=PTS-STARTPTS"
        run_ffmpeg([
            "-y", "-i", segment["path"],
            "-vf", vf, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
            "-r", str(fps), "-frames:v", str(output_frames), str(out_path),
        ])
    else:
        run_ffmpeg([
            "-y", "-f", "lavfi", "-t", f"{duration + 1:.3f}",
            "-i", f"color=c=black:s={width}x{height}:r={fps}",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
            "-frames:v", str(output_frames), str(out_path),
        ])


def _transition_tail_head_segments(segment: dict, fps: int) -> tuple[dict, dict]:
    """Builds the two synthetic segments a join transition renders and blends
    (see `_build_transition_segment`): a `tail_segment` covering the last
    `transition_frames` of the outgoing clip's own motion timeline (from a
    virtually-extended copy — see `expand_join_transitions` for why) and a
    `head_segment` covering the first `transition_frames` of the incoming
    clip's. Factored out so `run()` can compute the exact same shapes to
    fold their Remotion renders into the upfront batch pre-render (see its
    own call site) — the transition-encoding path itself doesn't care
    whether `_encode_segment_to_path` reaches Remotion via a pre-rendered
    raw clip or its own per-clip fallback, only that the segment shapes it
    encodes are exactly these."""
    transition_frames = segment["frames"]
    segment_a = segment["segmentA"]
    segment_b = segment["segmentB"]
    nominal_a_frames = segment_a["_originalFrames"]
    tail_segment = {
        **segment_a,
        "end": segment_a["end"] + transition_frames / fps,
        "frames": transition_frames,
        "_originalFrames": nominal_a_frames + transition_frames,
        # Root-cause coverage for a visible pop at the instant every join
        # transition starts. The tail is rendered LONGER than the clip's own
        # segment (it continues past the nominal end so the blend has
        # footage), and the camera move used to normalise its 0->1 progress
        # over that longer length — so the same clip ran a DIFFERENT, slower
        # curve inside the transition than it did in its own segment, and the
        # picture jumped backwards at the join. Measured on a real 4K export:
        # the transition's first frame is pure clip A (xfade progress 0, no
        # blending at all) yet differed from the preceding frame by 13.7x the
        # local per-frame motion; across the 87-still project's 86
        # transitions the implied jump was a median 3.6px and up to 8.8px of
        # edge displacement. Pinning the motion to the clip's real length
        # makes the tail the exact continuation of its own segment; because
        # the progress interpolation clamps at 1, the extra frames hold at
        # the fully-eased end pose. `_originalFrames` above still governs the
        # RENDER length, so a video source keeps playing real footage here
        # rather than freezing.
        "_motionFrames": nominal_a_frames,
        "_trimStartFrames": nominal_a_frames,
        "transitionIn": "cut", "transitionOut": "cut",
    }
    head_segment = {
        **segment_b,
        "frames": transition_frames,
        "_originalFrames": segment_b["_originalFrames"],
        "_trimStartFrames": 0,
        "transitionIn": "cut", "transitionOut": "cut",
    }
    return tail_segment, head_segment


def _build_transition_segment(
    segment: dict, index: int, width: int, height: int, fps: int, work_dir: Path, out_path: Path,
) -> None:
    """Renders a join transition (cross-fade/slide-left/slide-right/
    zoom-blur) as an `xfade` blend of the outgoing clip's tail window and the
    incoming clip's head window — each rendered as its own short clip first
    (reusing `_encode_segment_to_path` with the trim/frame-count tricks that
    give exactly the tail or head of that clip's own motion timeline), then
    combined in one more ffmpeg pass. The "tail window" is rendered from a
    virtually-extended copy of the outgoing clip (see `expand_join_transitions`
    for why) — its own independent segment elsewhere is untouched.

    `segment["_preRenderedTailRawPath"]`/`_preRenderedHeadRawPath`, when
    present (set by `run()`'s upfront batch pre-render — see its own call
    site), are forwarded onto the tail/head segment's `_preRenderedRawPath`
    so `_encode_segment_to_path`'s existing pre-render-reuse branch picks
    them up instead of falling back to a fresh per-clip Remotion render."""
    tail_path = work_dir / f"seg_{index:04d}_a.ts"
    head_path = work_dir / f"seg_{index:04d}_b.ts"
    tail_segment, head_segment = _transition_tail_head_segments(segment, fps)
    if segment.get("_preRenderedTailRawPath"):
        tail_segment["_preRenderedRawPath"] = segment["_preRenderedTailRawPath"]
    if segment.get("_preRenderedHeadRawPath"):
        head_segment["_preRenderedRawPath"] = segment["_preRenderedHeadRawPath"]
    _encode_segment_to_path(tail_segment, tail_path, width, height, fps)
    _encode_segment_to_path(head_segment, head_path, width, height, fps)
    transition_frames = segment["frames"]
    xfade_name = _XFADE_TRANSITION_NAMES.get(segment["transitionType"], "fade")
    transition_seconds = transition_frames / fps
    try:
        run_ffmpeg([
            "-y", "-i", str(tail_path), "-i", str(head_path),
            "-filter_complex",
            f"[0:v]format=yuv420p,setsar=1[a];[1:v]format=yuv420p,setsar=1[b];"
            f"[a][b]xfade=transition={xfade_name}:duration={transition_seconds:.3f}:offset=0[outv]",
            "-map", "[outv]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
            "-r", str(fps), "-frames:v", str(transition_frames), str(out_path),
        ])
    finally:
        tail_path.unlink(missing_ok=True)
        head_path.unlink(missing_ok=True)


def encode_segment(
    segment: dict, index: int, width: int, height: int, fps: int, work_dir: Path
) -> Path:
    out_path = work_dir / f"seg_{index:04d}.ts"
    if segment["kind"] == "transition":
        _build_transition_segment(segment, index, width, height, fps, work_dir, out_path)
    else:
        _encode_segment_to_path(segment, out_path, width, height, fps)
    return out_path


def retime_clip(source_path: Path, source_duration: float, target_duration: float, output_path: Path) -> None:
    """Adjusts a generated animation clip to exactly fill its timeline slot.
    Only ever stretches (slows down, via `setpts`) — never speeds up — per
    product decision: a clip shorter than its slot is stretched to match; a
    clip already at or beyond the target is simply trimmed. Audio is always
    dropped (`-an`) since these are silent B-roll clips layered under
    separate narration."""
    if target_duration <= 0 or source_duration <= 0:
        raise ValueError("Clip and target durations must both be positive.")
    factor = target_duration / source_duration
    if factor > 1.0:
        run_ffmpeg([
            "-y", "-i", str(source_path), "-vf", f"setpts={factor:.6f}*PTS", "-an",
            "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-pix_fmt", "yuv420p",
            str(output_path),
        ])
    else:
        run_ffmpeg([
            "-y", "-i", str(source_path), "-t", f"{target_duration:.3f}", "-an",
            "-c:v", "libx264", "-preset", "fast", "-crf", "16", "-pix_fmt", "yuv420p",
            str(output_path),
        ])


def write_captions_srt(captions: list[dict], out_path: Path) -> None:
    lines = []
    for i, chunk in enumerate(captions, 1):
        lines.append(str(i))
        lines.append(f"{to_srt_ts(chunk['start'])} --> {to_srt_ts(chunk['end'])}")
        lines.append(chunk["text"])
        lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")


def escape_subtitles_path(path: Path) -> str:
    return str(path).replace("\\", "/").replace(":", "\\:")


# "Rubik" (the caption default font) isn't a built-in OS font — bundling it
# here and pointing libass at this folder via the ass filter's `fontsdir`
# lets it render correctly without needing a system-wide font install.
# Same extended-length-path defense as MOTION_ENGINE_DIR above — libass's
# own path parsing inside an ffmpeg filter string is just as unlikely to
# understand a `\\?\`-prefixed path as cmd.exe is.
_BUNDLED_FONTS_DIR = _without_extended_path_prefix(Path(__file__).resolve().parent / "fonts")


def _read_font_metrics(path: Path) -> tuple[str, int, int, int] | None:
    """Reads (family_name_lowercased, unitsPerEm, usWinAscent, usWinDescent)
    straight out of a TrueType/OpenType file's `head`, `OS/2` and `name`
    tables. Deliberately hand-rolled rather than pulling in fontTools: these
    are three fixed-offset reads from a table directory, and the export
    engine's dependency set is intentionally small. Returns None for
    anything that isn't a font we can parse — every caller treats that as
    "apply no correction", i.e. exactly the pre-existing behavior."""
    try:
        with path.open("rb") as handle:
            header = handle.read(12)
            if len(header) < 12:
                return None
            if header[:4] == b"ttcf":  # font collection — use its first face
                handle.seek(12)
                first_offset = int.from_bytes(handle.read(4), "big")
                handle.seek(first_offset)
                header = handle.read(12)
                table_base = first_offset + 12
            else:
                table_base = 12
            if header[:4] not in (b"\x00\x01\x00\x00", b"OTTO", b"true"):
                return None
            table_count = int.from_bytes(header[4:6], "big")
            handle.seek(table_base)
            directory = handle.read(16 * table_count)
            tables: dict[bytes, int] = {}
            for i in range(table_count):
                record = directory[i * 16:(i + 1) * 16]
                if len(record) < 16:
                    break
                tables[record[:4]] = int.from_bytes(record[8:12], "big")
            if not {b"head", b"OS/2", b"name"} <= tables.keys():
                return None

            handle.seek(tables[b"head"] + 18)
            units_per_em = int.from_bytes(handle.read(2), "big")
            # usWinAscent/usWinDescent live at a fixed offset in every OS/2
            # table version (they were present from version 0 onward).
            handle.seek(tables[b"OS/2"] + 74)
            win_ascent = int.from_bytes(handle.read(2), "big")
            win_descent = int.from_bytes(handle.read(2), "big")

            name_offset = tables[b"name"]
            handle.seek(name_offset)
            _format, record_count, strings_offset = (
                int.from_bytes(handle.read(2), "big") for _ in range(3)
            )
            records = handle.read(12 * record_count)
            family = ""
            for i in range(record_count):
                record = records[i * 12:(i + 1) * 12]
                if len(record) < 12:
                    break
                platform_id = int.from_bytes(record[0:2], "big")
                name_id = int.from_bytes(record[6:8], "big")
                if name_id != 1:  # 1 == font family name
                    continue
                length = int.from_bytes(record[8:10], "big")
                offset = int.from_bytes(record[10:12], "big")
                handle.seek(name_offset + strings_offset + offset)
                raw = handle.read(length)
                decoded = raw.decode("utf-16-be" if platform_id == 3 else "latin-1", "ignore")
                if decoded:
                    family = decoded
                    if platform_id == 3:  # prefer the Windows/Unicode record
                        break
            if not family or units_per_em <= 0:
                return None
            return family.strip().lower(), units_per_em, win_ascent, win_descent
    except (OSError, ValueError):
        return None


def _font_search_dirs() -> list[Path]:
    """Bundled fonts first — those are the ones libass is explicitly pointed
    at via the `ass` filter's `fontsdir` — then the OS font directories that
    supply everything in CAPTION_FONT_OPTIONS other than Rubik."""
    dirs = [_BUNDLED_FONTS_DIR]
    system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR")
    if system_root:
        dirs.append(Path(system_root) / "Fonts")
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        dirs.append(Path(local_app_data) / "Microsoft" / "Windows" / "Fonts")
    return dirs


_FONT_METRICS_CACHE: dict[str, tuple[int, int, int]] | None = None


def _font_metrics_index() -> dict[str, tuple[int, int, int]]:
    """family_lowercased -> (unitsPerEm, usWinAscent, usWinDescent), built
    once per process. Bundled fonts win over identically-named system ones,
    matching libass's own precedence when handed a `fontsdir`."""
    global _FONT_METRICS_CACHE
    if _FONT_METRICS_CACHE is not None:
        return _FONT_METRICS_CACHE
    index: dict[str, tuple[int, int, int]] = {}
    for directory in _font_search_dirs():
        try:
            entries = sorted(directory.iterdir())
        except OSError:
            continue
        for entry in entries:
            if entry.suffix.lower() not in (".ttf", ".otf", ".ttc"):
                continue
            parsed = _read_font_metrics(entry)
            if not parsed:
                continue
            family, units_per_em, win_ascent, win_descent = parsed
            index.setdefault(family, (units_per_em, win_ascent, win_descent))
    _FONT_METRICS_CACHE = index
    return index


def _font_metrics(font_family: str) -> tuple[int, int, int] | None:
    return _font_metrics_index().get((font_family or "").strip().lower())


# Root-cause coverage for "the caption in the export looks nothing like the
# preview — even the style looks different".
#
# A Canvas2D `ctx.font = "66px Rubik"` sets the EM SQUARE to 66 device
# pixels. ASS's `\fs66` does NOT mean the same thing: libass reproduces
# VSFilter's historical sizing convention (see libass's own
# `ass_face_set_size`), which scales the requested size by
# `(hheaAscender - hheaDescender) / (usWinAscent + usWinDescent)` and then
# asks FreeType for a REAL_DIM size — one where ascender+descender, not the
# em square, equals the request. Those two steps collapse to
#
#     rendered_em_px == fs * unitsPerEm / (usWinAscent + usWinDescent)
#
# For the bundled Rubik (unitsPerEm 1000, usWinAscent 1066, usWinDescent
# 466) that factor is 0.653, so a caption tuned in the preview burned in
# roughly 35% too small at every resolution. Measured on real burns of the
# real project's own captions.ass: at `\fs66` the rendered line is 439px
# wide where the canvas preview draws 671px; multiplying \fs by the
# reciprocal below lands the burn at 671px — an exact match.
#
# Every OTHER ASS quantity (\bord, \xshad/\yshad, \blur, margins) is in
# plain script units == pixels and must NOT be scaled by this, which is why
# the correction is applied only where \fs / Fontsize are emitted, and
# `_scaled_font_size` keeps returning the canvas-space pixel size that the
# outline/shadow formulas are calibrated against.
def _libass_font_size_scale(font_family: str) -> float:
    metrics = _font_metrics(font_family)
    if not metrics:
        return 1.0
    units_per_em, win_ascent, win_descent = metrics
    win_total = win_ascent + win_descent
    if units_per_em <= 0 or win_total <= 0:
        return 1.0
    return win_total / units_per_em


# drawCaptionText places a bottom-aligned block's last baseline at
# `height - margin - lineHeight*0.2`, and lineHeight is `fontSize * 1.25` —
# i.e. it reserves exactly 0.25 * fontSize of descent below the last
# baseline. libass instead reserves the font's own `usWinDescent`, which for
# Rubik is 0.466 em — so an `\an2` line sits ~0.216 * fontSize higher in the
# frame than the same caption does in preview (a measured 15px at 1080p with
# the default style). Correcting MarginV by the difference lines the two up
# to within a pixel across every font size tested.
_CANVAS_BOTTOM_DESCENT_FRACTION = 0.25
# drawCaptionText's top-aligned baseline is `margin + lineHeight*0.8`, i.e.
# it reserves exactly 1.0 * fontSize of ascent above the first baseline,
# against libass's own `usWinAscent`.
_CANVAS_TOP_ASCENT_FRACTION = 1.0


def _libass_margin_v_correction(font_family: str, position: str, font_size: float) -> float:
    """Pixels to subtract from the nominal 5%-of-height caption margin so an
    ASS `\\an2`/`\\an8` line lands where the canvas preview draws it."""
    metrics = _font_metrics(font_family)
    if not metrics:
        return 0.0
    units_per_em, win_ascent, win_descent = metrics
    if units_per_em <= 0:
        return 0.0
    if position == "top":
        return (win_ascent / units_per_em - _CANVAS_TOP_ASCENT_FRACTION) * font_size
    if position == "middle":
        return 0.0  # \an5 centres vertically and ignores MarginV entirely
    return (win_descent / units_per_em - _CANVAS_BOTTOM_DESCENT_FRACTION) * font_size


def to_ass_ts(seconds: float) -> str:
    """ASS timestamp: H:MM:SS.cc (centiseconds) — distinct from SRT's
    HH:MM:SS,mmm, hours is not zero-padded to a fixed width."""
    total_centis = int(round(max(0.0, seconds) * 100))
    centis = total_centis % 100
    total_seconds = total_centis // 100
    s = total_seconds % 60
    total_minutes = total_seconds // 60
    m = total_minutes % 60
    h = total_minutes // 60
    return f"{h}:{m:02d}:{s:02d}.{centis:02d}"


def _to_ass_color(hex_color: str, alpha: int = 0) -> str:
    """Converts a #RRGGBB CSS-style hex color to ASS's &HAABBGGRR& form
    (byte-reversed, alpha 0 = fully opaque)."""
    hex_color = (hex_color or "").lstrip("#")
    if len(hex_color) != 6:
        hex_color = "FFFFFF"
    r, g, b = hex_color[0:2], hex_color[2:4], hex_color[4:6]
    return f"&H{alpha:02X}{b.upper()}{g.upper()}{r.upper()}&"


def _style_value(style: dict, key: str, default):
    value = style.get(key)
    return default if value is None else value


def _opacity_to_alpha_byte(opacity_percent) -> int:
    """ASS alpha is inverted transparency (00 = opaque, FF = fully
    transparent), the reverse of our 0-100 "opacity" sliders."""
    opacity = max(0.0, min(100.0, float(opacity_percent) if opacity_percent is not None else 100.0))
    return round((1 - opacity / 100) * 255)


# The Timeline's canvas preview renders caption text at
# `(fontSizePx/22) * canvasHeight * 0.045` canvas px, so a still/caption
# looks the same proportion of the frame regardless of the video's actual
# resolution. The export previously used fontSizePx literally as the ASS
# \fs value — correct-looking only by coincidence when PlayResY happened to
# be small, and tiny at any real 1080p/1920px export. This reference height
# is the canvas's own default preview size, so the same formula reproduces
# the exact on-screen proportion at whatever the export's real height is.
_REFERENCE_CAPTION_HEIGHT = 540.0

# What a default style (fontSizePx 22) produces at _scaled_font_size,
# evaluated at _REFERENCE_CAPTION_HEIGHT — used to scale shadow distance/blur
# proportionally to font_size (see _resolve_shadow) rather than to height
# directly, so it stays correct for BOTH portrait and landscape exports (a
# height-only reference silently assumed 540 meant "the landscape preview
# canvas", which isn't true for a 9:16 project's own, taller, preview
# canvas). Matches timeline-rendering.ts's `REFERENCE_FONT_SIZE_PX` exactly.
_REFERENCE_FONT_SIZE_PX = _REFERENCE_CAPTION_HEIGHT * 0.045

# The canvas shadowBlur (px) that the 0-100% "Blur" slider maps to at 100% —
# mirrors timeline-rendering.ts's `MAX_SHADOW_BLUR_PX` exactly.
MAX_SHADOW_BLUR_PX = 20.0


def _scaled_font_size(style: dict, height: int) -> float:
    raw = float(_style_value(style, "fontSizePx", 22) or 22)
    return max(14.0, (raw / 22.0) * height * 0.045)


def _scaled_outline_width(style: dict, font_size: float) -> float:
    """Root-cause coverage for "the caption outline is way bolder than what I
    picked": timeline-rendering.ts's canvas preview draws the outline with
    `ctx.lineWidth` — a CENTERED stroke, so only half of that width is
    actually visible outside the glyph fill (the other half is painted over
    by the fill). ASS's `\\bord` is a different convention: libass paints the
    full value as an outward-only border with nothing centered over the
    fill — confirmed empirically (burned a real ASS file at this formula's
    un-corrected value next to a halved one; the un-corrected one is
    visibly, roughly 2x heavier). The `* 0.5` here corrects specifically for
    that renderer difference — it does NOT exist in timeline-rendering.ts's
    matching formula, and must not be added there; canvas already needs no
    correction since its stroke is centered to begin with."""
    raw = float(_style_value(style, "outlineWidthPx", 2) or 0)
    return max(0.0, (raw / 2.0) * font_size * 0.16 * 0.5)


# The Timeline's canvas preview keeps captions a fixed 5% of the canvas's own
# height away from whichever edge `position` (top/bottom) implies — see
# `drawCaptionText`'s `margin = height * 0.05` — and constrains line-wrap
# width to 86% of the canvas, i.e. 7% margin on each side. The export
# previously hardcoded MarginV/MarginL/MarginR to a flat 10 ASS units
# regardless of PlayResY/PlayResX — barely visible at 1080p+ (10px against a
# 1080px-tall frame is under 1% of the height), so captions rendered hugging
# the very bottom edge, well below where the same style sits in preview. Same
# root cause `_scaled_font_size` above already fixed for font size — margin
# was simply missed at the time.
def _scaled_caption_margins(width: int, height: int) -> tuple[int, int, int]:
    margin_v = round(height * 0.05)
    margin_lr = round(width * 0.07)
    return margin_lr, margin_lr, margin_v


def _resolve_shadow(style: dict, font_size: float) -> tuple[float, float, int, str, int]:
    """Maps our {enabled, color, opacity, blur%, distance, angle} shadow shape
    onto ASS's independent \\xshad/\\yshad offsets (computed from distance +
    angle, unlike classic ASS's single diagonal \\shad depth) plus a \\blur
    softness and a shadow color/alpha for \\4c/\\4a. Distance and blur scale
    with font_size (see _scaled_font_size) — the SAME quantity
    timeline-rendering.ts's canvas preview now also scales its own shadow by
    (previously the canvas left shadow completely unscaled while this
    scaled it by height/540, so the export always rendered a stronger,
    differently-sized shadow than what preview showed) — so a shadow tuned
    in preview matches what actually gets burned in, at any resolution or
    aspect ratio. Returns (xshad, yshad, blur, shadow_color_hex, shadow_alpha_byte)."""
    shadow = _style_value(style, "shadow", {}) or {}
    if not shadow.get("enabled"):
        return 0.0, 0.0, 0.0, "#000000", 255
    scale = font_size / _REFERENCE_FONT_SIZE_PX
    distance = float(shadow.get("distance", 2) or 0) * scale
    angle_rad = math.radians(float(shadow.get("angle", 90) or 0))
    xshad = round(distance * math.cos(angle_rad), 2)
    yshad = round(distance * math.sin(angle_rad), 2)
    # timeline-rendering.ts sets `ctx.shadowBlur` to
    # `(blur%/100) * MAX_SHADOW_BLUR_PX(20) * scale` — and per the canvas
    # spec `shadowBlur` is TWICE the gaussian standard deviation, whereas
    # libass's `\blur` IS that standard deviation. Halving converts between
    # the two conventions; confirmed by burning the real style at a sweep of
    # \blur values and picking the one closest to the canvas render (the
    # error curve is flat between 5 and 8, and this lands at 8.15).
    blur = round((float(shadow.get("blur", 30) or 0) / 100) * (MAX_SHADOW_BLUR_PX / 2) * scale, 2)
    shadow_alpha = _opacity_to_alpha_byte(shadow.get("opacity", 70))
    return xshad, yshad, blur, shadow.get("color") or "#000000", shadow_alpha


def _ass_line_geometry(style: dict, width: int, height: int) -> tuple[str, int, int, int, int]:
    """(base_tags, ass_font_size, alignment, margin_lr, margin_v) shared by a
    caption's text layer and its shadow layer, so the two always lay out
    identically and overlay exactly."""
    font_family = _style_value(style, "fontFamily", "Arial Black")
    font_size = _scaled_font_size(style, height)              # canvas-space px
    ass_font_size = max(1, round(font_size * _libass_font_size_scale(font_family)))
    bold = 1 if _style_value(style, "bold", True) else 0
    position = _style_value(style, "position", "bottom")
    alignment = _ASS_ALIGNMENT.get(position, 2)
    outline_width = round(_scaled_outline_width(style, font_size), 2)
    margin_lr, _, nominal_margin_v = _scaled_caption_margins(width, height)
    margin_v = max(
        1, round(nominal_margin_v - _libass_margin_v_correction(font_family, position, font_size))
    )
    base = f"\\fn{font_family}\\fs{ass_font_size}\\b{bold}\\bord{outline_width}\\an{alignment}"
    return base, ass_font_size, alignment, margin_lr, margin_v


def _ass_override_tags(style: dict, height: int, width: int = 1920) -> str:
    """Override block for a caption's TEXT layer — sharp glyphs, no shadow.

    The shadow moves to its own lower Dialogue layer (see
    `_ass_shadow_layer_tags`): ASS's `\\blur` softens the whole rendered
    glyph — fill AND outline — whereas the canvas preview's `ctx.shadowBlur`
    softens ONLY the drop shadow and leaves the text razor-sharp. Emitting
    `\\blur` on the text itself (what this used to do) visibly fuzzed the
    outline in every export, which is a large part of "the caption looks
    different than the preview". `\\shad0` here guarantees the text layer
    never draws a shadow of its own on top of the dedicated shadow layer."""
    base, *_ = _ass_line_geometry(style, width, height)
    blend_alpha = _opacity_to_alpha_byte(_style_value(style, "opacity", 100))
    color = _to_ass_color(_style_value(style, "color", "#FFFFFF"), blend_alpha)
    outline_color = _to_ass_color(_style_value(style, "outlineColor", "#000000"), blend_alpha)
    return "{" + base + f"\\c{color}\\3c{outline_color}\\shad0" + "}"


def _ass_shadow_layer_tags(style: dict, height: int, width: int = 1920) -> str | None:
    """Override block for a caption's SHADOW layer, or None when the style
    has no shadow. Fill and outline are made fully transparent (`\\1a`/`\\3a`
    at &HFF&) so only the offset, blurred shadow copy renders — reproducing
    the canvas's "sharp text + soft shadow" exactly, which single-layer ASS
    cannot express."""
    font_size = _scaled_font_size(style, height)
    xshad, yshad, blur, shadow_color, shadow_alpha = _resolve_shadow(style, font_size)
    if not (xshad or yshad or blur):
        return None
    base, *_ = _ass_line_geometry(style, width, height)
    shadow_color_ass = _to_ass_color(shadow_color, 0)
    tags = (
        base
        + "\\1a&HFF&\\3a&HFF&"
        + f"\\4a&H{shadow_alpha:02X}&\\4c{shadow_color_ass}\\xshad{xshad}\\yshad{yshad}"
    )
    if blur:
        tags += f"\\blur{blur}"
    return "{" + tags + "}"


def _escape_ass_text(text: str) -> str:
    # Braces open/close an ASS override block unconditionally — there's no
    # in-band escape for a literal brace, so swap them for lookalikes rather
    # than let user-edited caption text corrupt the line's styling.
    return text.replace("{", "(").replace("}", ")").replace("\n", "\\N")


def _karaoke_dialogue_lines(
    chunk: dict, style: dict, base_tags: str, base_color: str, highlight_color: str,
    margin_l: int, margin_v: int,
) -> list[str]:
    """One Dialogue event per word-window, each showing the FULL caption text
    with only that window's word colored as the highlight — unlike classic
    ASS \\k karaoke (which is cumulative, staying highlighted once "sung"),
    this keeps exactly one word lit at a time, matching a live word-by-word
    follow effect rather than a progressive sing-along."""
    words = chunk.get("words") or []
    clip_start, clip_end = chunk["start"], chunk["end"]
    lines: list[str] = []
    for i, word in enumerate(words):
        seg_start = max(word["start"], clip_start)
        seg_end = words[i + 1]["start"] if i + 1 < len(words) else clip_end
        seg_end = min(seg_end, clip_end)
        if seg_end <= seg_start:
            continue
        segments = [
            f"{{\\c{highlight_color if j == i else base_color}}}{_escape_ass_text(w['text'])}"
            for j, w in enumerate(words)
        ]
        text = base_tags + " ".join(segments)
        lines.append(
            f"Dialogue: 1,{to_ass_ts(seg_start)},{to_ass_ts(seg_end)},Default,,"
            f"{margin_l},{margin_l},{margin_v},,{text}\n"
        )
    return lines


def write_captions_ass(
    captions: list[dict], out_path: Path, width: int, height: int, default_style: dict,
) -> None:
    """Writes an .ass subtitle file with one Dialogue line per caption, each
    prefixed with its own fully-resolved inline style override — this is how
    per-clip caption styling (set on the Timeline) reaches the final export,
    while a video-level Default style still covers the (rare) case of a line
    with no override at all."""
    default_style = default_style or _FALLBACK_CAPTION_STYLE
    default_font = _style_value(default_style, "fontFamily", "Arial Black")
    default_canvas_size = _scaled_font_size(default_style, height)
    default_size = max(1, round(default_canvas_size * _libass_font_size_scale(default_font)))
    default_bold = 1 if _style_value(default_style, "bold", True) else 0
    default_blend_alpha = _opacity_to_alpha_byte(_style_value(default_style, "opacity", 100))
    default_color = _to_ass_color(_style_value(default_style, "color", "#FFFFFF"), default_blend_alpha)
    default_outline_color = _to_ass_color(_style_value(default_style, "outlineColor", "#000000"), default_blend_alpha)
    default_outline_width = round(_scaled_outline_width(default_style, default_canvas_size), 2)
    default_alignment = _ASS_ALIGNMENT.get(_style_value(default_style, "position", "bottom"), 2)
    margin_l, margin_r, margin_v = _scaled_caption_margins(width, height)

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {width}\n"
        f"PlayResY: {height}\n"
        "ScaledBorderAndShadow: yes\n"
        # WrapStyle 1 == greedy end-of-line wrapping. libass's DEFAULT is
        # WrapStyle 0, "smart" wrapping that balances a wrapped caption into
        # roughly equal-length lines — but drawCaptionText wraps greedily
        # (fill each line to 86% of the frame, then break). Measured on a
        # real two-line caption: libass's default broke it 1235px/1221px
        # where the canvas breaks it 1492px/951px, i.e. visibly different
        # line breaks for the same text. WrapStyle 1 reproduces the canvas's
        # own breaks to within a few pixels.
        "WrapStyle: 1\n"
        "\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        # Shadow depth is a flat 0 here: shadows are drawn by their own
        # dedicated Dialogue layer (see _ass_shadow_layer_tags), never by
        # the style entry or the text layer.
        f"Style: Default,{default_font},{default_size},{default_color},&H000000FF&,"
        f"{default_outline_color},&H00000000&,{default_bold},0,0,0,100,100,0,0,1,"
        f"{default_outline_width},0,{default_alignment},{margin_l},{margin_r},{margin_v},1\n"
        "\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    lines = [header]
    for chunk in captions:
        style = chunk.get("style") or {}
        word_highlight = _style_value(style, "wordHighlight", {}) or {}
        words = chunk.get("words") or []
        _, _, _, line_margin_l, line_margin_v = _ass_line_geometry(style, width, height)
        karaoke = bool(word_highlight.get("enabled")) and bool(words)
        # The shadow is the same shape for the whole chunk regardless of
        # which word is currently highlighted, so one Layer-0 event spanning
        # the chunk covers every karaoke window underneath. It has to be laid
        # out from the SAME string the text layer builds, or the two layers
        # would wrap differently and the shadow would sit under the wrong
        # glyphs — the karaoke path joins `words`, which is not guaranteed to
        # reproduce `chunk["text"]` verbatim.
        shadow_text = (
            " ".join(_escape_ass_text(w["text"]) for w in words)
            if karaoke else _escape_ass_text(chunk["text"])
        )
        shadow_tags = _ass_shadow_layer_tags(style, height, width)
        if shadow_tags:
            lines.append(
                f"Dialogue: 0,{to_ass_ts(chunk['start'])},{to_ass_ts(chunk['end'])},Default,,"
                f"{line_margin_l},{line_margin_l},{line_margin_v},,"
                f"{shadow_tags}{shadow_text}\n"
            )
        if karaoke:
            base_tags = _ass_override_tags(style, height, width)
            blend_alpha = _opacity_to_alpha_byte(_style_value(style, "opacity", 100))
            base_color = _to_ass_color(_style_value(style, "color", "#FFFFFF"), blend_alpha)
            highlight_color = _to_ass_color(word_highlight.get("color", "#FFEB3B"), blend_alpha)
            lines.extend(_karaoke_dialogue_lines(
                chunk, style, base_tags, base_color, highlight_color, line_margin_l, line_margin_v,
            ))
        else:
            text = _ass_override_tags(style, height, width) + _escape_ass_text(chunk["text"])
            lines.append(
                f"Dialogue: 1,{to_ass_ts(chunk['start'])},{to_ass_ts(chunk['end'])},Default,,"
                f"{line_margin_l},{line_margin_l},{line_margin_v},,{text}\n"
            )
    out_path.write_text("".join(lines), encoding="utf-8")


# (encoder name, extra args for the tiny real probe encode in
# `_detect_hardware_encoder`) in priority order — NVIDIA NVENC first (fastest,
# most broadly reliable of the three), then Intel Quick Sync, then AMD AMF.
_HW_ENCODER_CANDIDATES: list[tuple[str, list[str]]] = [
    ("h264_nvenc", ["-preset", "p4"]),
    ("h264_qsv", []),
    ("h264_amf", []),
]
_HW_ENCODER_NAMES = {name for name, _ in _HW_ENCODER_CANDIDATES}
# Human-readable label per `video_encode_args[1]` value (the codec name,
# whatever `_final_pass_video_routing` chose) — surfaced in the "Rendering
# video" progress detail (see its own call site) purely so a user watching
# an export can tell which of the three paths it actually took, since
# they otherwise look identical from the progress bar alone.
_ENCODER_LABELS = {
    "copy": "no re-encode needed",
    "libx264": "CPU",
    "h264_nvenc": "hardware: NVIDIA",
    "h264_qsv": "hardware: Intel Quick Sync",
    "h264_amf": "hardware: AMD",
}
# `None` = not probed yet this process; `{}` = probed, nothing usable (or
# disabled after a real failure — see `_disable_hardware_encoder`);
# otherwise `{"name": <encoder>}`.
_hw_encoder_cache: dict | None = None


def _detect_hardware_encoder() -> str | None:
    """Probes, once per process, for a working hardware H.264 encoder ffmpeg
    can actually use on this machine, trying `_HW_ENCODER_CANDIDATES` in
    order and returning the first that actually works — or `None`, meaning
    "use libx264", if none do.

    Being listed in `ffmpeg -encoders` does NOT mean usable: confirmed on a
    real dev machine with no discrete GPU, `h264_amf` is listed but fails the
    moment it's actually asked to open a device ("DLL amfrt64.dll failed to
    open"). So this runs a real, tiny encode instead of trusting the encoder
    list — same "verify it actually works, not just that it's present"
    approach `_ensure_motion_engine_ready`/`_ensure_remotion_browser_
    downloaded` already take for the Remotion toolchain.

    Deliberately scoped to the FINAL export pass only (its one call site,
    inside `run()`) — never the many-way-concurrent per-segment encodes in
    `_encode_segment_to_path`. Consumer GPUs cap how many simultaneous
    hardware encode sessions they'll run at all (commonly ~2-5 sessions on
    stock NVIDIA drivers before new ones start failing outright); the final
    pass is always exactly one process for the whole export, so it can never
    hit that ceiling, but handing every one of `MAX_ENCODE_WORKERS` concurrent
    per-segment workers the same hardware encoder could silently serialize or
    start failing well before that. Measured on a real (Intel iGPU, no
    discrete GPU) dev machine: a 4K final pass at matched quality went from
    ~20fps on libx264 "fast" to ~83fps on Quick Sync — independent of, and
    compounding with, the Remotion/vignette fast-path fix above; either one
    alone can be the difference between an export finishing in minutes vs.
    hours."""
    global _hw_encoder_cache
    if _hw_encoder_cache is not None:
        return _hw_encoder_cache.get("name")
    for name, probe_args in _HW_ENCODER_CANDIDATES:
        try:
            result = subprocess.run(
                [
                    "ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=0.2",
                    "-frames:v", "3", "-c:v", name, *probe_args, "-f", "null", "-",
                ],
                capture_output=True, text=True, timeout=15, **_subprocess_kwargs(),
            )
            if result.returncode == 0:
                _hw_encoder_cache = {"name": name}
                return name
        except Exception:
            continue
    _hw_encoder_cache = {}
    return None


def _disable_hardware_encoder() -> None:
    """Called when the final pass's REAL hardware-encoded attempt fails at
    runtime despite passing `_detect_hardware_encoder`'s own tiny probe (the
    probe only proves the encoder can open at all, not that it handles this
    export's actual resolution/settings) — permanently falls back to libx264
    for the rest of this process rather than re-probing (and likely
    re-failing) the same way again."""
    global _hw_encoder_cache
    _hw_encoder_cache = {}


def _final_pass_video_encode_args(preset: str, crf: int) -> list[str]:
    """`-c:v ...` args for the final muxing pass: a detected hardware
    encoder's own equivalent quality/rate-control flags for `crf` when one's
    available (see `_detect_hardware_encoder`), else the same plain libx264
    args this used unconditionally before. `crf`'s 0-51 (lower = higher
    quality) scale is reused as-is for NVENC's `-cq` and (offset slightly,
    empirically closer at matched settings) QSV's `-global_quality` — both
    are documented as the same ICQ-style scale libx264's own CRF uses, so
    this isn't an exact perceptual match across encoders, but is a reasonable
    default a user can already retune via the existing quality dropdown
    (see `quality_crf_preset` in projects.rs)."""
    hw = _detect_hardware_encoder()
    if hw == "h264_nvenc":
        return ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", str(crf), "-b:v", "0", "-pix_fmt", "yuv420p"]
    if hw == "h264_qsv":
        return ["-c:v", "h264_qsv", "-global_quality", str(crf + 2), "-pix_fmt", "nv12"]
    if hw == "h264_amf":
        return ["-c:v", "h264_amf", "-rc", "cqp", "-qp_i", str(crf), "-qp_p", str(crf), "-quality", "quality", "-pix_fmt", "nv12"]
    return ["-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p"]


def _final_pass_video_routing(video_filter: str | None, preset: str, crf: int, fps: int) -> tuple[list[str], list[str]]:
    """Returns `(video_map_args, video_encode_args)` for the final concat
    pass's own video stream — factored out of `run()` so the "skip the
    re-encode entirely when there's nothing to filter" decision is directly
    testable. `video_filter is None` (no caption burn-in, and no other
    global video filter exists yet) means every segment's own already-exact
    fps/pix_fmt (see `_encode_segment_to_path`'s `-r`/`-pix_fmt` on each one)
    can be stream-copied straight through with `-map 0:v -c:v copy` — a real,
    bit-for-bit-exact skip of a full second full-resolution decode+encode
    pass over the entire video, not an approximation. Otherwise, routes the
    concat's `[0:v]` through `video_filter` into `[v]` and encodes it for
    real (hardware-accelerated when available — see
    `_final_pass_video_encode_args`)."""
    if video_filter:
        return ["-map", "[v]"], _final_pass_video_encode_args(preset, crf) + ["-r", str(fps)]
    return ["-map", "0:v"], ["-c:v", "copy"]


# `None` = not probed yet this process; otherwise `True`/`False`. Separate
# from `_hw_encoder_cache` — see `_detect_hwaccel_decode`'s own comment on
# why decode acceleration is worth trying independently of whether an
# encoder is also available.
_hwaccel_decode_cache: bool | None = None


def _detect_hwaccel_decode() -> bool:
    """Probes, once per process, whether this machine can actually decode
    H.264 via D3D11VA. Worth trying independently of `_detect_hardware_
    encoder`: unlike a hardware ENCODER (real hardware AND a specific SDK/
    driver stack both have to line up), D3D11-accelerated H.264 DECODE is
    close to universal on Windows — works with essentially any GPU driver
    from the last decade, on a machine that may have no usable hardware
    ENCODER at all (an integrated GPU with old/minimal drivers, a VM with
    partial GPU passthrough, etc.). Applying it is a pure decode-side
    offload with zero effect on the encoded output — same libx264 encode,
    same CRF/preset, same bytes out — it only exists to free CPU cycles that
    would otherwise go to software H.264 decode, leaving more for the encode
    itself. Measured on a real (Intel iGPU, no discrete GPU, CPU-only
    encode) dev machine: the exact same libx264 encode at the exact same
    settings went from ~24fps to ~64fps at 4K purely from this.

    Needs a real (tiny) H.264 file to decode, unlike the encoder probe
    (which can encode from a synthetic `color=` source directly) —
    `-hwaccel` has nothing to accelerate against a raw generated frame, only
    a real decode."""
    global _hwaccel_decode_cache
    if _hwaccel_decode_cache is not None:
        return _hwaccel_decode_cache
    _hwaccel_decode_cache = False
    try:
        with tempfile.TemporaryDirectory() as tmp_dir:
            probe_input = Path(tmp_dir) / "probe.mp4"
            encode = subprocess.run(
                [
                    "ffmpeg", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=0.2",
                    "-c:v", "libx264", "-preset", "ultrafast", str(probe_input),
                ],
                capture_output=True, text=True, timeout=15, **_subprocess_kwargs(),
            )
            if encode.returncode != 0 or not probe_input.exists():
                return False
            decode = subprocess.run(
                [
                    "ffmpeg", "-y", "-hwaccel", "d3d11va", "-hwaccel_output_format", "d3d11",
                    "-i", str(probe_input), "-vf", "hwdownload,format=nv12", "-f", "null", "-",
                ],
                capture_output=True, text=True, timeout=15, **_subprocess_kwargs(),
            )
            _hwaccel_decode_cache = decode.returncode == 0
    except Exception:
        _hwaccel_decode_cache = False
    return _hwaccel_decode_cache


def _disable_hwaccel_decode() -> None:
    """Same pattern as `_disable_hardware_encoder` — called when the final
    pass's REAL attempt fails at runtime despite passing the tiny probe."""
    global _hwaccel_decode_cache
    _hwaccel_decode_cache = False


def _final_pass_input_hwaccel_args(needs_decode: bool) -> tuple[list[str], str]:
    """`-hwaccel` args to insert before the final pass's concat `-i`, plus
    the `-vf` prefix that must come before any content filter (`ass=`, which
    needs software pixel data — libass can't operate on hardware frames) to
    bring decoded frames back to normal software frames first. Returns
    `([], "")` unchanged when there's nothing to filter at all
    (`needs_decode=False` — the `-c:v copy` path from `_final_pass_video_
    routing`, which never decodes a single frame) or when hardware-
    accelerated decode isn't available (see `_detect_hwaccel_decode`)."""
    if not needs_decode or not _detect_hwaccel_decode():
        return [], ""
    return ["-hwaccel", "d3d11va", "-hwaccel_output_format", "d3d11"], "hwdownload,format=nv12,format=yuv420p,"


def run_final_pass(args: list[str], duration_seconds: float) -> None:
    process = subprocess.Popen(
        ["ffmpeg", *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        **_subprocess_kwargs(),
    )
    stderr_lines: list[str] = []

    def drain_stderr() -> None:
        if process.stderr is None:
            return
        for line in process.stderr:
            stderr_lines.append(line)

    stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
    stderr_thread.start()

    assert process.stdout is not None
    for line in process.stdout:
        match = re.match(r"out_time_ms=(\d+)", line.strip())
        if match:
            out_seconds = int(match.group(1)) / 1_000_000
            percent = 72 + min(1.0, out_seconds / max(duration_seconds, 0.001)) * 28
            engine.report_progress(
                round(percent), "Rendering video", f"{out_seconds:.1f}s / {duration_seconds:.1f}s"
            )

    process.wait()
    stderr_thread.join(timeout=5)
    if process.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {''.join(stderr_lines)[-2000:]}")


def _common_public_dir(media_paths: list[str]) -> Path | None:
    """Longest common ancestor directory across every motion-graphic clip's
    own source file — the one `publicDir` a batched Remotion render needs
    (see `_batch_render_motion_graphics`), since `staticFile()` inside the
    composition resolves every clip's `mediaPath` relative to it. Every
    asset for one video already lives under one shared
    `Projects/<channel>/<video>/` root (see CLAUDE.md), so this succeeds for
    any real export; returns `None` only in a genuinely pathological case
    (e.g. paths spread across different drives), which just means the batch
    step is skipped for this export — every clip still renders correctly,
    one at a time, via the older per-clip `_render_motion_graphic` path."""
    try:
        parents = [str(Path(p).resolve().parent) for p in media_paths]
        return Path(os.path.commonpath(parents))
    except (ValueError, OSError):
        return None


def _batch_render_motion_graphics(items: list[dict], public_dir: Path, work_dir: Path) -> dict[str, str]:
    """Pre-renders every item (each already carrying its own `outPath`) in
    one batched Node process (`services/motion-engine/src/batch-render.mjs`)
    that bundles services/motion-engine and launches headless Chromium only
    once, reusing both across every clip — versus the old approach of
    `_render_motion_graphic` spawning a whole fresh Node/webpack/Chromium
    process per clip, measured at ~30s of pure startup overhead each time,
    the dominant cost of an export for any timeline with Camera Effects
    applied. See that script's own docstring for the render-per-item detail.

    Returns a dict of `id -> error message` for every item that did NOT
    render successfully (empty if everything succeeded, including when
    `items` itself is empty). The caller leaves a failed (or entirely
    un-batched, if this whole step raised) item's `_preRenderedRawPath`
    unset, so `_encode_segment_to_path` silently falls back to the slower
    but already-proven per-clip path for just that one clip instead of
    failing the whole export.

    Streams the child process's stdout rather than blocking on it as one
    lump (`subprocess.run(capture_output=True)`, the previous approach):
    batch-render.mjs prints one `PROGRESS <done> <total>` line per clip as
    it finishes (see that script), which turns into `engine.report_progress`
    calls across export's 5%-10% band — without this, a timeline with
    several Tier 2/4/5 clips in a row reports nothing for the whole batch's
    wall-clock time, reading as the export hanging."""
    if not items:
        return {}
    _ensure_motion_engine_ready()
    batch_path = work_dir / "motion_batch_spec.json"
    results_path = work_dir / "motion_batch_results.json"
    batch_path.write_text(json.dumps([
        {
            "id": item["id"], "mediaPath": item["mediaPath"], "sourceKind": item["sourceKind"],
            "recipe": item["recipe"], "durationInFrames": item["durationInFrames"],
            "motionDurationInFrames": item.get("motionDurationInFrames", item["durationInFrames"]),
            "fps": item["fps"],
            "width": item["width"], "height": item["height"], "outPath": item["outPath"],
        }
        for item in items
    ]), encoding="utf-8")
    try:
        process = subprocess.Popen(
            [
                _resolve_node_bin("node"), "src/batch-render.mjs",
                str(batch_path), str(results_path), str(public_dir),
            ],
            cwd=str(MOTION_ENGINE_DIR),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            **_subprocess_kwargs(),
        )
        stderr_lines: list[str] = []

        def drain_stderr() -> None:
            if process.stderr is None:
                return
            for line in process.stderr:
                stderr_lines.append(line)

        stderr_thread = threading.Thread(target=drain_stderr, daemon=True)
        stderr_thread.start()

        assert process.stdout is not None
        for line in process.stdout:
            match = re.match(r"PROGRESS (\d+) (\d+)", line.strip())
            if match:
                done, total = int(match.group(1)), max(1, int(match.group(2)))
                percent = 5 + round((done / total) * 5)
                engine.report_progress(
                    percent, "Preparing export", f"Pre-rendering motion-graphic clip {done}/{total}"
                )

        process.wait()
        stderr_thread.join(timeout=5)
        if process.returncode != 0 or not results_path.exists():
            # The whole batch process itself failed to run (not an
            # individual clip within it) — every item falls back.
            message = "".join(stderr_lines)[-500:] or "the batch render process did not run"
            return {item["id"]: message for item in items}
        raw_results = json.loads(results_path.read_text(encoding="utf-8"))
        errors: dict[str, str] = {}
        seen_ids: set[str] = set()
        for entry in raw_results:
            seen_ids.add(entry["id"])
            if not entry.get("ok"):
                errors[entry["id"]] = str(entry.get("error", "unknown error"))
        for item in items:
            if item["id"] not in seen_ids:
                errors[item["id"]] = "the batch render process did not report a result for this clip"
        return errors
    finally:
        batch_path.unlink(missing_ok=True)
        results_path.unlink(missing_ok=True)


def run(manifest_path: Path, output_path: Path) -> None:
    engine.report_progress(2, "Preparing export", "Reading timeline manifest")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    width = int(manifest["width"])
    height = int(manifest["height"])
    fps = int(manifest.get("fps", FPS_DEFAULT))
    duration_seconds = float(manifest["durationSeconds"])
    stills = manifest.get("stills", [])
    captions = manifest.get("captions", [])
    narration_audio_path = manifest["narrationAudioPath"]
    narration_offset_seconds = max(0.0, float(manifest.get("narrationOffsetSeconds", 0.0)))

    if duration_seconds <= 0:
        raise ValueError("Timeline has no duration to export.")

    work_dir = manifest_path.parent
    segments = build_segments(stills, duration_seconds)
    if not segments:
        raise ValueError("Nothing to export — the timeline has no stills.")
    assign_frame_counts(segments, fps)

    # A fade-in/out at the two hard edges of the whole export has nothing to
    # fade from/to — it just opens or closes on black — so ignore it there
    # even if it was applied to every still via a bulk "apply to all" action.
    # Only the true tail end counts for the closing fade: a fade-out into an
    # actual trailing black gap further down the timeline is still legitimate.
    if segments[0]["kind"] == "image":
        segments[0]["transitionIn"] = "cut"
    if segments[-1]["kind"] == "image":
        segments[-1]["transitionOut"] = "cut"
    # Drop each recipe's own fade-to-black envelope before anything derives
    # further segments from these — the join-transition tail/head windows
    # below are shallow copies, so doing it here covers them too, and every
    # consumer (the native `fade=` path and the Remotion props alike) reads
    # `motionGraphicSettings` from the segment. See its own doc comment.
    strip_recipe_fade_envelope(segments)
    # Only the single baked video gets blended join transitions — the
    # asset-bundle export (see below) hands each clip to another editor as
    # its own separate file, where a cross-fade/slide/zoom-blur has nothing
    # meaningful to mean.
    segments = expand_join_transitions(segments, fps)

    # Pre-render every motion-graphic clip this early scan can see in one
    # batched pass — see `_batch_render_motion_graphics`'s doc comment for
    # why this exists. Skipped entirely (silently, same per-clip fallback)
    # if the motion engine isn't ready yet or the common-public-dir
    # computation fails — neither should ever actually block an export that
    # would have worked before this batching existed.
    # A Tier-1-only recipe never reaches Remotion at all now, on either an
    # "image" or a "video" segment (see _is_ffmpeg_native_recipe /
    # build_recipe_zoompan_filter in _encode_segment_to_path) — excluded
    # here so the batch below isn't spent on clips that don't need it. This
    # is the common case for "video" segments specifically: Tier 1 (camera
    # move) is mandatory on every recipe per the SOP, so an animation/
    # imported clip with no Tier 2/4/5 accent applied — the majority, since
    # those are optional diversity accents, not the default shape — used to
    # be sent through Remotion unconditionally regardless of how simple its
    # recipe was.
    motion_graphic_segments = [
        (index, segment) for index, segment in enumerate(segments)
        if segment["kind"] in ("image", "video")
        and segment.get("motionGraphicEffect") and segment.get("motionGraphicSettings")
        and not _is_ffmpeg_native_recipe(segment["motionGraphicSettings"])
    ]
    # A join transition's tail/head window (see _transition_tail_head_segments)
    # used to be entirely excluded from this batch — always falling back to
    # `_render_motion_graphic`'s own fresh Node/webpack/Chromium cold start,
    # ONE PER WINDOW, run concurrently (up to MAX_ENCODE_WORKERS at a time)
    # alongside every other segment in the ThreadPoolExecutor loop below.
    # On a timeline with many transitions between recipe-bearing clips (the
    # common case — Tier 1 is mandatory on every recipe), that meant dozens
    # of simultaneous full Chromium processes: the dominant cost behind
    # exports that never seemed to move past a low percent, and — under
    # enough concurrent memory/handle pressure — an occasional truncated
    # render (a corrupt intermediate .ts ffmpeg then can't even open).
    # Folding these into the same one-bundle-one-browser batch as everything
    # else removes both problems at once.
    transition_segments = [
        (index, segment) for index, segment in enumerate(segments) if segment["kind"] == "transition"
    ]
    transition_tail_heads: dict[int, tuple[dict, dict]] = {
        index: _transition_tail_head_segments(segment, fps) for index, segment in transition_segments
    }
    transition_motion_items: list[tuple[int, str, dict]] = []
    for index, (tail_segment, head_segment) in transition_tail_heads.items():
        if (
            tail_segment.get("motionGraphicEffect") and tail_segment.get("motionGraphicSettings")
            and not _is_ffmpeg_native_recipe(tail_segment["motionGraphicSettings"])
        ):
            transition_motion_items.append((index, "tail", tail_segment))
        if (
            head_segment.get("motionGraphicEffect") and head_segment.get("motionGraphicSettings")
            and not _is_ffmpeg_native_recipe(head_segment["motionGraphicSettings"])
        ):
            transition_motion_items.append((index, "head", head_segment))

    pre_rendered_paths: list[Path] = []
    if motion_graphic_segments or transition_motion_items:
        total_items = len(motion_graphic_segments) + len(transition_motion_items)
        engine.report_progress(
            5, "Preparing export",
            f"Pre-rendering {total_items} motion-graphic clip{'s' if total_items != 1 else ''}",
        )
        all_source_paths = [segment["path"] for _, segment in motion_graphic_segments] + [
            segment["path"] for _, _, segment in transition_motion_items
        ]
        public_dir = _common_public_dir(all_source_paths)
        try:
            if public_dir is not None:
                batch_items = []
                for index, segment in motion_graphic_segments:
                    raw_path = work_dir / f"motion_pre_{index}.raw.mp4"
                    media_path = Path(segment["path"]).resolve().relative_to(public_dir)
                    batch_items.append({
                        "id": str(index),
                        "mediaPath": str(media_path).replace("\\", "/"),
                        "sourceKind": "video" if segment["kind"] == "video" else "image",
                        "recipe": segment["motionGraphicSettings"],
                        "durationInFrames": segment.get("_originalFrames", segment["frames"]),
                        # Differs only for a join transition's tail window —
                        # see `_transition_tail_head_segments`.
                        "motionDurationInFrames": segment.get(
                            "_motionFrames", segment.get("_originalFrames", segment["frames"])
                        ),
                        "fps": fps, "width": width, "height": height,
                        "outPath": str(raw_path),
                    })
                for index, side, segment in transition_motion_items:
                    item_id = f"t{index}{side[0]}"  # "t3t" (tail) / "t3h" (head) — distinct from plain int ids
                    raw_path = work_dir / f"motion_pre_{item_id}.raw.mp4"
                    media_path = Path(segment["path"]).resolve().relative_to(public_dir)
                    batch_items.append({
                        "id": item_id,
                        "mediaPath": str(media_path).replace("\\", "/"),
                        "sourceKind": "video" if segment["kind"] == "video" else "image",
                        "recipe": segment["motionGraphicSettings"],
                        "durationInFrames": segment.get("_originalFrames", segment["frames"]),
                        # Differs only for a join transition's tail window —
                        # see `_transition_tail_head_segments`.
                        "motionDurationInFrames": segment.get(
                            "_motionFrames", segment.get("_originalFrames", segment["frames"])
                        ),
                        "fps": fps, "width": width, "height": height,
                        "outPath": str(raw_path),
                    })
                errors = _batch_render_motion_graphics(batch_items, public_dir, work_dir)
                item_index = 0
                for _, segment in motion_graphic_segments:
                    item = batch_items[item_index]
                    item_index += 1
                    if item["id"] not in errors:
                        segment["_preRenderedRawPath"] = item["outPath"]
                        pre_rendered_paths.append(Path(item["outPath"]))
                for index, side, _ in transition_motion_items:
                    item = batch_items[item_index]
                    item_index += 1
                    if item["id"] not in errors:
                        transition_segment = segments[index]
                        key = "_preRenderedTailRawPath" if side == "tail" else "_preRenderedHeadRawPath"
                        transition_segment[key] = item["outPath"]
                        pre_rendered_paths.append(Path(item["outPath"]))
        except Exception as error:  # noqa: BLE001 - batching is a pure optimization, never fatal
            engine.report_progress(
                5, "Preparing export",
                f"Motion-graphics pre-render skipped ({error}) — rendering per clip instead",
            )

    engine.report_progress(10, "Preparing export", f"{len(segments)} segments to render")
    # Each segment is an independent ffmpeg process (its own frame range,
    # nothing shared with its neighbors), so encoding them concurrently
    # instead of one-at-a-time is a straightforward, safe way to cut export
    # wall-clock time on multi-still timelines.
    worker_count = min(len(segments), max(1, os.cpu_count() or 1), MAX_ENCODE_WORKERS)
    completed = 0
    completed_lock = threading.Lock()
    with ThreadPoolExecutor(max_workers=worker_count) as pool:
        futures = [
            pool.submit(encode_segment, segment, index, width, height, fps, work_dir)
            for index, segment in enumerate(segments, start=1)
        ]

        def _on_done(_future: object) -> None:
            nonlocal completed
            with completed_lock:
                completed += 1
                percent = 10 + round((completed / len(segments)) * 60)
                engine.report_progress(percent, "Rendering stills", f"Segment {completed}/{len(segments)}")

        for future in futures:
            future.add_done_callback(_on_done)
        segment_paths: list[Path] = [future.result() for future in futures]

    # Pre-rendered motion-graphic raw clips (see above) are each consumed by
    # exactly one segment above and never reused — `_encode_segment_to_path`
    # deliberately leaves them on disk (unlike its own per-clip raw_path,
    # which it always cleans up itself) so a batch failure partway through
    # still leaves every successfully pre-rendered clip usable; cleaned up
    # here instead, once every segment that could need one has run.
    for raw_path in pre_rendered_paths:
        raw_path.unlink(missing_ok=True)

    segments_list_path = work_dir / "segments.txt"
    segments_list_path.write_text(
        "\n".join(f"file '{path.name}'" for path in segment_paths), encoding="utf-8"
    )

    music = manifest.get("music", [])
    include_narration = bool(manifest.get("includeNarration", True))
    narration_volume_percent = float(manifest.get("narrationVolumePercent", 100.0))
    narration_trim_start = max(0.0, float(manifest.get("narrationTrimStartSeconds", 0.0)))
    narration_trim_end = max(0.0, float(manifest.get("narrationTrimEndSeconds", 0.0)))
    burn_captions = bool(manifest.get("burnCaptions", True))
    write_srt = bool(manifest.get("writeSrt", False))
    crf = int(manifest.get("crf", 18))
    preset = str(manifest.get("preset", "fast"))

    if write_srt and captions:
        write_captions_srt(captions, work_dir / "captions.srt")

    ass_path = work_dir / "captions.ass"
    has_captions = bool(captions) and burn_captions
    if has_captions:
        default_style = manifest.get("captionDefaultStyle") or _FALLBACK_CAPTION_STYLE
        write_captions_ass(captions, ass_path, width, height, default_style)

    engine.report_progress(72, "Rendering video", "Muxing audio and captions")

    # Every audio source (narration + each music clip) becomes its own ffmpeg
    # input and its own labeled filter chain (trim/fade/volume/delay), then
    # all of them are mixed with `amix` — a timeline with neither narration
    # nor music included just exports silent (-an). `apad` on the mixed
    # result guards against the audio ending before the video does (video's
    # own length is always authoritative, fixed by the segments' exact frame
    # count — narration/music simply go quiet for whatever's left over).
    audio_input_args: list[str] = []
    graph_parts: list[str] = []
    next_input_index = 1
    audio_labels: list[str] = []

    if include_narration:
        audio_input_args += ["-i", narration_audio_path]
        narration_index = next_input_index
        next_input_index += 1
        chain = f"[{narration_index}:a]"
        if narration_trim_start > 0 or narration_trim_end > 0:
            narration_duration = float(manifest.get("narrationDurationSeconds", duration_seconds))
            trim_end = max(narration_trim_start + 0.05, narration_duration - narration_trim_end)
            chain += f"atrim=start={narration_trim_start:.3f}:end={trim_end:.3f},asetpts=PTS-STARTPTS,"
        if narration_offset_seconds > 0:
            delay_ms = round(narration_offset_seconds * 1000)
            chain += f"adelay={delay_ms}|{delay_ms},"
        volume_mult = max(0.0, narration_volume_percent) / 100.0
        chain += f"volume={volume_mult:.4f}[narr]"
        graph_parts.append(chain)
        audio_labels.append("[narr]")

    for i, clip in enumerate(music):
        clip_duration = max(0.05, float(clip["end"]) - float(clip["start"]))
        if clip.get("loopEnabled"):
            audio_input_args += ["-stream_loop", "-1", "-i", clip["path"]]
        else:
            audio_input_args += ["-i", clip["path"]]
        clip_index = next_input_index
        next_input_index += 1
        chain = f"[{clip_index}:a]atrim=start=0:end={clip_duration:.3f},asetpts=PTS-STARTPTS"
        fade_in = max(0.0, float(clip.get("fadeInSeconds", 0.0))) if clip.get("fadeInEnabled") else 0.0
        if fade_in > 0:
            chain += f",afade=t=in:st=0:d={fade_in:.3f}"
        fade_out = max(0.0, float(clip.get("fadeOutSeconds", 0.0))) if clip.get("fadeOutEnabled") else 0.0
        if fade_out > 0:
            chain += f",afade=t=out:st={max(0.0, clip_duration - fade_out):.3f}:d={fade_out:.3f}"
        volume_mult = max(0.0, float(clip.get("volumePercent", 100.0))) / 100.0
        chain += f",volume={volume_mult:.4f}"
        delay_ms = round(float(clip["start"]) * 1000)
        if delay_ms > 0:
            chain += f",adelay={delay_ms}|{delay_ms}"
        duck_start, duck_end = clip.get("duckOverlapStart"), clip.get("duckOverlapEnd")
        if duck_start is not None and duck_end is not None:
            duck_multiplier = max(0.0, float(clip.get("duckMultiplier", 1.0)))
            chain += (
                f",volume=enable='between(t\\,{float(duck_start):.3f}\\,{float(duck_end):.3f})'"
                f":volume={duck_multiplier:.4f}"
            )
        label = f"m{i}"
        graph_parts.append(f"{chain}[{label}]")
        audio_labels.append(f"[{label}]")

    final_audio_label = None
    if audio_labels:
        if len(audio_labels) > 1:
            graph_parts.append(
                f"{''.join(audio_labels)}amix=inputs={len(audio_labels)}:duration=longest:dropout_transition=0[mixed]"
            )
            mixed_label = "[mixed]"
        else:
            mixed_label = audio_labels[0]
        graph_parts.append(f"{mixed_label}apad[aout]")
        final_audio_label = "[aout]"

    video_filter = f"ass='{escape_subtitles_path(ass_path)}':fontsdir='{escape_subtitles_path(_BUNDLED_FONTS_DIR)}'" if has_captions else None
    # No caption burn-in (and no other global video filter exists yet): every
    # segment was already encoded at this export's own exact fps/pix_fmt (see
    # `_encode_segment_to_path`'s own `-r fps`/`-pix_fmt yuv420p` on each
    # one), so the concatenated video stream needs no further processing at
    # all — a real `-c:v copy` here is bit-for-bit exact, not an
    # approximation, and skips a full second full-resolution decode+encode
    # pass over the ENTIRE video for nothing. Previously this went through
    # `[0:v]copy[v]` in the filtergraph regardless — a no-op *filter*, but
    # still one that forces `-c:v libx264` to fully decode and re-encode
    # every frame right after `_encode_segment_to_path` already encoded it
    # once, on every single export.
    audio_graph_parts = graph_parts

    def _build_and_run_final_pass() -> None:
        """Builds the full final-pass command fresh and runs it — factored
        into its own closure (rather than a plain one-shot list build) so a
        hardware-acceleration failure (see the `except` block below) can
        simply disable whichever cache(s) were involved and call this again:
        every hardware decision below re-reads `_detect_hardware_encoder`/
        `_detect_hwaccel_decode`, so a second call after disabling one
        naturally rebuilds as a fully plain CPU command instead of needing
        to surgically patch the previous argument list."""
        hwaccel_input_args, hwaccel_filter_prefix = _final_pass_input_hwaccel_args(bool(video_filter))
        video_map_args, video_encode_args = _final_pass_video_routing(video_filter, preset, crf, fps)
        # Visible confirmation of which paths this export actually took —
        # otherwise there's no way for a user comparing export times across
        # machines/settings to tell "no re-encode needed" from "hardware
        # encoder" from "plain CPU", or whether decode acceleration kicked
        # in, just by watching the progress bar.
        detail = f"Encoding ({_ENCODER_LABELS.get(video_encode_args[1], video_encode_args[1])}"
        detail += ", hardware-accelerated decode)" if hwaccel_input_args else ")"
        engine.report_progress(72, "Rendering video", detail)

        args = ["-y", *hwaccel_input_args, "-f", "concat", "-safe", "0", "-i", str(segments_list_path)]
        args += audio_input_args
        parts = list(audio_graph_parts)
        if video_filter:
            parts.insert(0, f"[0:v]{hwaccel_filter_prefix}{video_filter}[v]")
        if parts:
            args += ["-filter_complex", ";".join(parts)]
        args += video_map_args
        if final_audio_label:
            args += ["-map", final_audio_label]
        args += video_encode_args
        args += ["-c:a", "aac", "-b:a", "192k"] if final_audio_label else ["-an"]
        # Video's own length is exact and authoritative (see
        # assign_frame_counts); `-t` here is a safety net in case the
        # mixed/padded audio ever overruns it, not something that should
        # ever actually need to trim the picture.
        args += [
            "-t", f"{duration_seconds:.3f}", "-movflags", "+faststart",
            "-progress", "pipe:1", "-nostats", str(output_path),
        ]
        run_final_pass(args, duration_seconds)

    try:
        _build_and_run_final_pass()
    except RuntimeError:
        # A hardware encoder and/or hardware-accelerated decode passed its
        # own tiny probe but failed on this export's real resolution/
        # settings/media — disable whichever of the two were actually in
        # play and retry ONCE on a fully plain CPU pass, rather than fail
        # the whole export over an optimization. If neither was in play
        # (already plain CPU, e.g. the `-c:v copy` path, or both already
        # disabled from an earlier segment/export in this same process),
        # retrying would just fail identically — re-raise instead.
        used_hw_encoder = bool(_hw_encoder_cache and _hw_encoder_cache.get("name"))
        used_hwaccel_decode = bool(_hwaccel_decode_cache)
        if not used_hw_encoder and not used_hwaccel_decode:
            raise
        if used_hw_encoder:
            _disable_hardware_encoder()
        if used_hwaccel_decode:
            _disable_hwaccel_decode()
        engine.report_progress(72, "Rendering video", "Hardware acceleration failed - retrying on plain CPU")
        _build_and_run_final_pass()

    for path in segment_paths:
        path.unlink(missing_ok=True)
    segments_list_path.unlink(missing_ok=True)

    print(f"Output: {output_path}", flush=True)
    engine.report_progress(100, "Export ready", str(output_path))


def _encode_and_remux(segment: dict, index: int, width: int, height: int, fps: int, clips_dir: Path) -> Path:
    """Same per-still/gap encode as the single-file export, remuxed from the
    intermediate .ts container to .mp4 (a fast stream copy, no re-encode) —
    editors like CapCut recognize .mp4 far more reliably than .ts."""
    ts_path = encode_segment(segment, index, width, height, fps, clips_dir)
    mp4_path = ts_path.with_suffix(".mp4")
    run_ffmpeg(["-y", "-i", str(ts_path), "-c", "copy", "-movflags", "+faststart", str(mp4_path)])
    ts_path.unlink(missing_ok=True)
    return mp4_path


def run_bundle(manifest_path: Path, destination_dir: Path) -> None:
    """Exports the timeline as separate, editor-ready assets instead of one
    baked MP4: every still becomes its own short clip file, stretched to
    close any silence gap (no separate black clip files) and already trimmed
    to exactly the duration it occupies in the master timeline — importing
    them in filename order and placing them back-to-back on a track
    reproduces the whole timeline with no manual trimming needed. Narration
    audio and captions are copied out as their own separate files for their
    own tracks, since both already carry the correct absolute timestamps for
    the master timeline."""
    engine.report_progress(2, "Preparing export", "Reading timeline manifest")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    width = int(manifest["width"])
    height = int(manifest["height"])
    fps = int(manifest.get("fps", FPS_DEFAULT))
    duration_seconds = float(manifest["durationSeconds"])
    stills = close_gaps(manifest.get("stills", []), duration_seconds)
    captions = manifest.get("captions", [])
    narration_audio_path = Path(manifest["narrationAudioPath"])
    narration_offset_seconds = max(0.0, float(manifest.get("narrationOffsetSeconds", 0.0)))

    if duration_seconds <= 0:
        raise ValueError("Timeline has no duration to export.")

    segments = build_segments(stills, duration_seconds)
    if not segments:
        raise ValueError("Nothing to export — the timeline has no stills.")
    if segments[0]["kind"] == "image":
        segments[0]["transitionIn"] = "cut"
    if segments[-1]["kind"] == "image":
        segments[-1]["transitionOut"] = "cut"
    assign_frame_counts(segments, fps)

    destination_dir.mkdir(parents=True, exist_ok=True)
    clips_dir = destination_dir / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)

    engine.report_progress(5, "Preparing export", f"{len(segments)} clips to render")
    worker_count = min(len(segments), max(1, os.cpu_count() or 1), MAX_ENCODE_WORKERS)
    completed = 0
    completed_lock = threading.Lock()
    with ThreadPoolExecutor(max_workers=worker_count) as pool:
        futures = [
            pool.submit(_encode_and_remux, segment, index, width, height, fps, clips_dir)
            for index, segment in enumerate(segments, start=1)
        ]

        def _on_done(_future: object) -> None:
            nonlocal completed
            with completed_lock:
                completed += 1
                percent = 5 + round((completed / len(segments)) * 70)
                engine.report_progress(percent, "Rendering clips", f"Clip {completed}/{len(segments)}")

        for future in futures:
            future.add_done_callback(_on_done)
        clip_paths: list[Path] = [future.result() for future in futures]

    timing_lines = [
        f"{clip_path.name}\t{segment['kind']}\t{segment['start']:.3f}s - {segment['end']:.3f}s\t"
        f"({segment['end'] - segment['start']:.3f}s)"
        for clip_path, segment in zip(clip_paths, segments)
    ]
    narration_note = (
        f"Start narration audio at {narration_offset_seconds:.3f}s on its track, not at 0 — "
        "the timeline's narration was shifted from its default start.\n\n"
        if narration_offset_seconds > 0
        else "Narration audio starts at 0 on its track and needs no further alignment.\n\n"
    )
    (destination_dir / "timing.txt").write_text(
        "Import the files in clips/ in numeric filename order onto a video track, placed back-to-back "
        "(select all and drop them in — most editors, including CapCut, keep multi-selected clips in the "
        "order you select them). Each still is already stretched to close any silence gap and its own "
        "duration matches its exact slot in the original timeline, so no manual trimming is needed.\n\n"
        + narration_note
        + "Import captions.srt onto its own separate track — it already carries the correct absolute "
        "timestamps and needs no further alignment.\n\n"
        + "\n".join(timing_lines) + "\n",
        encoding="utf-8",
    )

    engine.report_progress(80, "Exporting assets", "Copying narration audio")
    audio_dest = destination_dir / f"narration{narration_audio_path.suffix or '.wav'}"
    shutil.copy2(narration_audio_path, audio_dest)

    if captions:
        engine.report_progress(90, "Exporting assets", "Writing captions")
        write_captions_srt(captions, destination_dir / "captions.srt")

    print(f"Output: {destination_dir}", flush=True)
    engine.report_progress(100, "Export ready", str(destination_dir))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="video_export_engine",
        description="Composite a timeline arrangement of stills, captions, and narration audio into a final MP4, "
                     "or export it as separate editor-ready assets (--mode bundle), "
                     "or just report a media file's real duration (--mode probe), "
                     "or stretch/trim a generated animation clip to a target duration (--mode retime), "
                     "or remove steady-state background noise from an audio file (--mode denoise).",
    )
    parser.add_argument("manifest", help="Path to the timeline export manifest JSON, or a media file path for --mode probe/retime/denoise")
    parser.add_argument("--output", metavar="PATH", help="Output video path, or destination folder for --mode bundle, or cleaned audio path for --mode denoise (unused for --mode probe)")
    parser.add_argument("--mode", choices=["video", "bundle", "probe", "retime", "detect-subject", "denoise"], default="video", help="'video' bakes one MP4 (default); 'bundle' exports separate clip/audio/caption assets; 'probe' reports a media file's real duration; 'retime' stretches/trims a clip to a target duration; 'detect-subject' locates a still's automatic zoom-anchor point; 'denoise' removes steady-state background noise from an audio file")
    parser.add_argument("--source-duration", type=float, help="The input clip's real duration in seconds (required for --mode retime)")
    parser.add_argument("--target-duration", type=float, help="The desired output duration in seconds (required for --mode retime)")
    return parser


def run_probe(audio_path: Path) -> None:
    """Prints the audio file's real ffmpeg-measured duration (seconds) to
    stdout. Browser-side duration measurements (Web Audio API, <audio>
    element) can each disagree with ffmpeg's own duration for compressed
    audio by tens to a hundred-plus milliseconds — this is the single
    authoritative value the app uses everywhere duration matters (export and
    "Extrapolate stills to fill gaps"), so the two can never disagree."""
    # `ffmpeg -i` with no output always exits non-zero (nothing to encode to) —
    # that's expected here, we only need the "Duration: HH:MM:SS.ss" line it
    # prints to stderr regardless of exit status.
    result = subprocess.run(
        ["ffmpeg", "-i", str(audio_path), "-hide_banner"],
        capture_output=True, text=True, **_subprocess_kwargs(),
    )
    match = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", result.stderr)
    if not match:
        raise RuntimeError(f"Could not determine audio duration: {result.stderr[-500:]}")
    hours, minutes, seconds = match.groups()
    total_seconds = int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    print(f"{total_seconds:.6f}", flush=True)


def run_detect_subject(image_path: Path) -> None:
    """Prints the still's automatic zoom-anchor point as JSON (`{"x":..,
    "y":..}`, fractions of width/height) to stdout, for the "-subject"
    motion presets."""
    x, y = engine.detect_subject_point(str(image_path))
    print(json.dumps({"x": x, "y": y}), flush=True)


def run_denoise(source_path: Path, output_path: Path) -> None:
    """Reduces steady-state background noise (hiss, hum, fan/AC static) in a
    narration or imported audio file. Filter chain: a highpass at 80Hz drops
    sub-bass rumble that doesn't carry voice; `afftdn` is an FFT-based noise
    gate that estimates and subtracts the broadband noise floor without
    needing a separate noise-only sample; a lowpass at 15kHz trims hiss
    above the range speech energy lives in; `loudnorm` renormalizes loudness
    afterward since denoising can otherwise leave the file perceptibly
    quieter than the source."""
    run_ffmpeg([
        "-y", "-i", str(source_path),
        "-af", "highpass=f=80,afftdn=nf=-25,lowpass=f=15000,loudnorm=I=-16:TP=-1.5:LRA=11",
        str(output_path),
    ])


if __name__ == "__main__":
    cli_parser = build_parser()
    if len(sys.argv) == 1:
        cli_parser.print_help()
        sys.exit(0)
    args = cli_parser.parse_args()
    if args.mode not in ("probe", "detect-subject") and not args.output:
        cli_parser.error("--output is required for --mode video/bundle/retime/denoise")
    try:
        if args.mode == "probe":
            run_probe(Path(args.manifest).expanduser().resolve())
        elif args.mode == "detect-subject":
            run_detect_subject(Path(args.manifest).expanduser().resolve())
        elif args.mode == "denoise":
            run_denoise(Path(args.manifest).expanduser().resolve(), Path(args.output).expanduser().resolve())
            print(f"Output: {args.output}", flush=True)
        elif args.mode == "retime":
            if args.source_duration is None or args.target_duration is None:
                cli_parser.error("--source-duration and --target-duration are required for --mode retime")
            retime_clip(
                Path(args.manifest).expanduser().resolve(), args.source_duration, args.target_duration,
                Path(args.output).expanduser().resolve(),
            )
            print(f"Output: {args.output}", flush=True)
        elif args.mode == "bundle":
            run_bundle(Path(args.manifest).expanduser().resolve(), Path(args.output).expanduser().resolve())
        else:
            run(Path(args.manifest).expanduser().resolve(), Path(args.output).expanduser().resolve())
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(130)
    except Exception as error:
        print(f"\nError: {error}\n")
        sys.exit(1)
