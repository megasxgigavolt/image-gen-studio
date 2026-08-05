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
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import scene_grouping_engine as engine

FPS_DEFAULT = 30
MAX_ENCODE_WORKERS = 4

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
    rather than a static image — it carries a `videoPath` instead of an
    `imagePath` and no motion/Ken-Burns settings."""
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


# These 4 transitions need both neighboring clips' pixel data blended
# together, unlike cut/fade/dip-to-white which only ever touch one segment's
# own frames — see `expand_join_transitions`. Mapped onto ffmpeg's `xfade`
# filter's built-in transition catalog rather than hand-built filter_complex
# graphs per type, since xfade already covers all of these reliably.
JOIN_TRANSITIONS = {"cross-fade", "slide-left", "slide-right", "zoom-blur"}
_XFADE_TRANSITION_NAMES = {
    "cross-fade": "fade",
    "slide-left": "slideleft",
    "slide-right": "slideright",
    # xfade has no literal "zoom + motion blur" preset; "zoomin" (the
    # incoming clip zooms in while cross-dissolving) is the closest built-in
    # analog and reads as a zoom-blur at typical transition speeds.
    "zoom-blur": "zoomin",
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
    clip continuing past its nominal end — safe for a still image, since its
    Ken-Burns motion formulas are just math with no footage limit — blended
    against the incoming clip's own first N frames. The incoming clip's own
    independent segment then starts N frames later (skipping the head that
    now plays inside the transition instead). Net effect: nominal_a + N +
    (nominal_b - N) == nominal_a + nominal_b, so total output length (and
    narration sync) is exactly preserved.

    This only works when the outgoing side is a still image — a "video"
    (Veo/imported) clip has no footage beyond what it was trimmed to for its
    own slot, so extending it isn't possible; a join transition into/out of
    a "video" segment, a "black" gap, or the very edge of the timeline
    silently renders as a hard cut instead, same as how the true first/last
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
            or segment["kind"] != "image"
            or next_segment is None
            or next_segment["kind"] not in ("image", "video")
        ):
            continue
        duration_a = segment["end"] - segment["start"]
        duration_b = next_segment["end"] - next_segment["start"]
        transition_seconds = max(0.2, min(0.75, min(duration_a, duration_b) / 3))
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


def build_image_filter(
    motion: str, transition_in: str, transition_out: str, intensity: float,
    width: int, height: int, fps: int, duration: float, frames: int,
    subject_x: float = 0.5, subject_y: float = 0.5,
    color_filter: str = "none", color_filter_intensity: float = 50.0,
    cut_index: int = 0,
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

    fade_in_duration = max(0.15, min(duration / 2, duration * 0.08))
    fade_out_duration = max(0.15, min(duration / 2, duration * 0.08))
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
        pre_scale = max(width, height) * 8
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
        # sub-pixel headroom before that rounding happens. Measured (a
        # reference vertical line's tracked position across frames, std dev
        # of frame-to-frame deltas — lower is smoother): 3x ~0.29, 6x ~0.17,
        # 8x ~0.12, 10x ~0.10. 8x is the point past which further headroom
        # stops paying for the added scale/encode cost.
        pre_scale = max(width, height) * 8
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


def build_video_filter(
    transition_in: str, transition_out: str, width: int, height: int, fps: int, duration: float,
    color_filter: str = "none", color_filter_intensity: float = 50.0,
) -> str:
    """Scale/pad a generated animation clip onto the target canvas, same as a
    still's `build_image_filter` but with no Ken-Burns zoompan — Veo output
    already has real motion, it just needs to fit the export frame."""
    fades = []
    if transition_in in ("fade", "dip-to-white"):
        fade_in_duration = max(0.15, min(duration / 2, duration * 0.08))
        in_color = "white" if transition_in == "dip-to-white" else "black"
        fades.append(f"fade=t=in:st=0:d={fade_in_duration:.3f}:color={in_color}")
    if transition_out in ("fade", "dip-to-white"):
        fade_out_duration = max(0.15, min(duration / 2, duration * 0.08))
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


# services/motion-engine — the parameterized Remotion project that actually
# renders the 7 SOP motion-graphic treatments (Ken Burns, Sequential Panel
# Reveal, Speed Pan & Motion Blur, Ominous Push-In, Candlelight Flicker,
# Focus Pull, Iris Reveal). Sibling of python-engine under services/.
MOTION_ENGINE_DIR = Path(__file__).resolve().parents[2] / "motion-engine"


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


def _ensure_motion_engine_ready() -> None:
    """One-time `npm install` for services/motion-engine, mirroring this
    module's own `_check_deps()`-style self-installing philosophy — a fresh
    checkout/install shouldn't need a manual setup step before AI motion
    graphics can render for the first time."""
    if (MOTION_ENGINE_DIR / "node_modules").exists():
        return
    result = subprocess.run(
        [_resolve_node_bin("npm"), "install"], cwd=str(MOTION_ENGINE_DIR),
        capture_output=True, text=True, **_subprocess_kwargs(),
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"Could not install the motion-graphics render engine: {result.stderr[-2000:]}"
        )


def _render_motion_graphic(
    image_path: str, effect: str, settings: dict,
    frames: int, fps: int, width: int, height: int, out_path: Path,
) -> None:
    """Renders one clip's AI-assigned (or manually overridden) SOP treatment
    via services/motion-engine's generalized `MotionClip` composition,
    writing a plain MP4 to `out_path` — the caller (`_encode_segment_to_path`)
    still applies this segment's own color filter / transition fades and the
    exact output frame count on top of this in a second, ordinary ffmpeg
    pass, same as every other segment kind. `--public-dir` points Remotion's
    headless Chromium at the still's own folder so `staticFile(imagePath)`
    inside the composition can load it — Chromium refuses to load `file://`
    URLs outside a folder it's been told is servable."""
    _ensure_motion_engine_ready()
    image_file = Path(image_path)
    props = {
        "imagePath": image_file.name,
        "effect": effect,
        "settings": settings,
        "durationInFrames": max(1, frames),
        "fps": fps,
        "width": width,
        "height": height,
    }
    props_path = out_path.with_suffix(".props.json")
    props_path.write_text(json.dumps(props), encoding="utf-8")
    try:
        result = subprocess.run(
            [
                _resolve_node_bin("npx"), "remotion", "render", "src/index.ts", "MotionClip", str(out_path),
                f"--props={props_path}",
                f"--public-dir={image_file.parent}",
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
    trim_start_frames = segment.get("_trimStartFrames", 0)
    if segment["kind"] == "image" and segment.get("motionGraphicEffect") and segment.get("motionGraphicSettings"):
        # AI-assigned (or manually overridden) SOP treatment: render the real
        # effect via services/motion-engine instead of approximating it with
        # a zoompan preset, then apply this segment's own color filter and
        # transition fades on top in an ordinary second ffmpeg pass — same
        # post-processing every other segment kind already gets.
        raw_path = out_path.with_suffix(".raw.mp4")
        _render_motion_graphic(
            segment["path"], segment["motionGraphicEffect"], segment["motionGraphicSettings"],
            original_frames, fps, width, height, raw_path,
        )
        vf_parts = []
        color_vf = build_color_filter_vf(
            segment.get("colorFilter", "none"), segment.get("colorFilterIntensity", 50.0)
        )
        if color_vf:
            vf_parts.append(color_vf)
        fade_in_duration = max(0.15, min(duration / 2, duration * 0.08))
        fade_out_duration = max(0.15, min(duration / 2, duration * 0.08))
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
        if trim_start_frames > 0:
            vf_parts.insert(0, f"trim=start_frame={trim_start_frames}:end_frame={original_frames},setpts=PTS-STARTPTS")
        vf = ",".join(vf_parts) if vf_parts else "null"
        try:
            run_ffmpeg([
                "-y", "-i", str(raw_path),
                "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
                "-r", str(fps), "-frames:v", str(output_frames), str(out_path),
            ])
        finally:
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
            segment.get("cutIndex", 0),
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
    for why) — its own independent segment elsewhere is untouched."""
    transition_frames = segment["frames"]
    segment_a = segment["segmentA"]
    segment_b = segment["segmentB"]
    tail_path = work_dir / f"seg_{index:04d}_a.ts"
    head_path = work_dir / f"seg_{index:04d}_b.ts"
    nominal_a_frames = segment_a["_originalFrames"]
    tail_segment = {
        **segment_a,
        "end": segment_a["end"] + transition_frames / fps,
        "frames": transition_frames,
        "_originalFrames": nominal_a_frames + transition_frames,
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
    _encode_segment_to_path(tail_segment, tail_path, width, height, fps)
    _encode_segment_to_path(head_segment, head_path, width, height, fps)
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
_BUNDLED_FONTS_DIR = Path(__file__).resolve().parent / "fonts"


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


def _scaled_font_size(style: dict, height: int) -> float:
    raw = float(_style_value(style, "fontSizePx", 22) or 22)
    return max(14.0, (raw / 22.0) * height * 0.045)


def _scaled_outline_width(style: dict, font_size: float) -> float:
    raw = float(_style_value(style, "outlineWidthPx", 2) or 0)
    return max(0.0, (raw / 2.0) * font_size * 0.16)


def _resolve_shadow(style: dict, height: int) -> tuple[float, float, int, str, int]:
    """Maps our {enabled, color, opacity, blur%, distance, angle} shadow shape
    onto ASS's independent \\xshad/\\yshad offsets (computed from distance +
    angle, unlike classic ASS's single diagonal \\shad depth) plus a \\blur
    softness and a shadow color/alpha for \\4c/\\4a. Distance and blur scale
    with height the same way font size does (see _scaled_font_size), so a
    shadow tuned in preview stays proportionally the same size at any export
    resolution instead of shrinking to nothing at 1080p/1920px. Returns
    (xshad, yshad, blur, shadow_color_hex, shadow_alpha_byte)."""
    shadow = _style_value(style, "shadow", {}) or {}
    if not shadow.get("enabled"):
        return 0.0, 0.0, 0, "#000000", 255
    scale = height / _REFERENCE_CAPTION_HEIGHT
    distance = float(shadow.get("distance", 2) or 0) * scale
    angle_rad = math.radians(float(shadow.get("angle", 90) or 0))
    xshad = round(distance * math.cos(angle_rad), 2)
    yshad = round(distance * math.sin(angle_rad), 2)
    # ASS's \blur is a small softness radius, not a percentage — this keeps
    # the same practical 0-4 range (at the reference height) the export was
    # already tuned against, just fed from a 0-100% slider instead of a raw
    # 0-12 unit value.
    blur = max(0, min(4, round((float(shadow.get("blur", 30) or 0) / 100) * 8 * scale)))
    shadow_alpha = _opacity_to_alpha_byte(shadow.get("opacity", 70))
    return xshad, yshad, blur, shadow.get("color") or "#000000", shadow_alpha


def _ass_override_tags(style: dict, height: int) -> str:
    font_family = _style_value(style, "fontFamily", "Arial Black")
    font_size = round(_scaled_font_size(style, height))
    bold = 1 if _style_value(style, "bold", True) else 0
    blend_alpha = _opacity_to_alpha_byte(_style_value(style, "opacity", 100))
    color = _to_ass_color(_style_value(style, "color", "#FFFFFF"), blend_alpha)
    outline_color = _to_ass_color(_style_value(style, "outlineColor", "#000000"), blend_alpha)
    outline_width = round(_scaled_outline_width(style, font_size), 2)
    alignment = _ASS_ALIGNMENT.get(_style_value(style, "position", "bottom"), 2)
    xshad, yshad, blur, shadow_color, shadow_alpha = _resolve_shadow(style, height)
    shadow_color_ass = _to_ass_color(shadow_color, shadow_alpha)
    tags = (
        f"\\fn{font_family}\\fs{font_size}\\b{bold}\\c{color}\\3c{outline_color}\\4c{shadow_color_ass}"
        f"\\bord{outline_width}\\xshad{xshad}\\yshad{yshad}\\an{alignment}"
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
        lines.append(f"Dialogue: 0,{to_ass_ts(seg_start)},{to_ass_ts(seg_end)},Default,,0,0,0,,{text}\n")
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
    default_size = round(_scaled_font_size(default_style, height))
    default_bold = 1 if _style_value(default_style, "bold", True) else 0
    default_blend_alpha = _opacity_to_alpha_byte(_style_value(default_style, "opacity", 100))
    default_color = _to_ass_color(_style_value(default_style, "color", "#FFFFFF"), default_blend_alpha)
    default_outline_color = _to_ass_color(_style_value(default_style, "outlineColor", "#000000"), default_blend_alpha)
    default_outline_width = round(_scaled_outline_width(default_style, default_size), 2)
    default_alignment = _ASS_ALIGNMENT.get(_style_value(default_style, "position", "bottom"), 2)
    # The base [V4+ Styles] entry only supports a single diagonal shadow
    # depth (no separate X/Y) — irrelevant in practice since every Dialogue
    # line below always carries its own full \xshad/\yshad override anyway.
    default_xshad, default_yshad, _, _, _ = _resolve_shadow(default_style, height)
    default_shadow_depth = round((abs(default_xshad) + abs(default_yshad)) / 2)

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {width}\n"
        f"PlayResY: {height}\n"
        "ScaledBorderAndShadow: yes\n"
        "\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,{default_font},{default_size},{default_color},&H000000FF&,"
        f"{default_outline_color},&H00000000&,{default_bold},0,0,0,100,100,0,0,1,"
        f"{default_outline_width},{default_shadow_depth},{default_alignment},10,10,10,1\n"
        "\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    lines = [header]
    for chunk in captions:
        style = chunk.get("style") or {}
        word_highlight = _style_value(style, "wordHighlight", {}) or {}
        words = chunk.get("words") or []
        if word_highlight.get("enabled") and words:
            base_tags = _ass_override_tags(style, height)
            blend_alpha = _opacity_to_alpha_byte(_style_value(style, "opacity", 100))
            base_color = _to_ass_color(_style_value(style, "color", "#FFFFFF"), blend_alpha)
            highlight_color = _to_ass_color(word_highlight.get("color", "#FFEB3B"), blend_alpha)
            lines.extend(_karaoke_dialogue_lines(chunk, style, base_tags, base_color, highlight_color))
        else:
            text = _ass_override_tags(style, height) + _escape_ass_text(chunk["text"])
            lines.append(
                f"Dialogue: 0,{to_ass_ts(chunk['start'])},{to_ass_ts(chunk['end'])},Default,,0,0,0,,{text}\n"
            )
    out_path.write_text("".join(lines), encoding="utf-8")


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
    # Only the single baked video gets blended join transitions — the
    # asset-bundle export (see below) hands each clip to another editor as
    # its own separate file, where a cross-fade/slide/zoom-blur has nothing
    # meaningful to mean.
    segments = expand_join_transitions(segments, fps)

    engine.report_progress(5, "Preparing export", f"{len(segments)} segments to render")
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
                percent = 5 + round((completed / len(segments)) * 65)
                engine.report_progress(percent, "Rendering stills", f"Segment {completed}/{len(segments)}")

        for future in futures:
            future.add_done_callback(_on_done)
        segment_paths: list[Path] = [future.result() for future in futures]

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
    final_args = ["-y", "-f", "concat", "-safe", "0", "-i", str(segments_list_path)]

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
    graph_parts.insert(0, f"[0:v]{video_filter}[v]" if video_filter else "[0:v]copy[v]")

    final_args += audio_input_args
    final_args += ["-filter_complex", ";".join(graph_parts), "-map", "[v]"]
    if final_audio_label:
        final_args += ["-map", final_audio_label]
    final_args += ["-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p", "-r", str(fps)]
    final_args += ["-c:a", "aac", "-b:a", "192k"] if final_audio_label else ["-an"]
    # Video's own length is exact and authoritative (see assign_frame_counts);
    # `-t` here is a safety net in case the mixed/padded audio ever overruns
    # it, not something that should ever actually need to trim the picture.
    final_args += [
        "-t", f"{duration_seconds:.3f}", "-movflags", "+faststart",
        "-progress", "pipe:1", "-nostats", str(output_path),
    ]
    run_final_pass(final_args, duration_seconds)

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
                     "or stretch/trim a generated animation clip to a target duration (--mode retime).",
    )
    parser.add_argument("manifest", help="Path to the timeline export manifest JSON, or a media file path for --mode probe/retime")
    parser.add_argument("--output", metavar="PATH", help="Output video path, or destination folder for --mode bundle (unused for --mode probe)")
    parser.add_argument("--mode", choices=["video", "bundle", "probe", "retime", "detect-subject"], default="video", help="'video' bakes one MP4 (default); 'bundle' exports separate clip/audio/caption assets; 'probe' reports a media file's real duration; 'retime' stretches/trims a clip to a target duration; 'detect-subject' locates a still's automatic zoom-anchor point")
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


if __name__ == "__main__":
    cli_parser = build_parser()
    if len(sys.argv) == 1:
        cli_parser.print_help()
        sys.exit(0)
    args = cli_parser.parse_args()
    if args.mode not in ("probe", "detect-subject") and not args.output:
        cli_parser.error("--output is required for --mode video/bundle")
    try:
        if args.mode == "probe":
            run_probe(Path(args.manifest).expanduser().resolve())
        elif args.mode == "detect-subject":
            run_detect_subject(Path(args.manifest).expanduser().resolve())
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
