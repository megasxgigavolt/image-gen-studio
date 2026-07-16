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

# Fallback caption look if a manifest is ever missing captionDefaultStyle
# (e.g. one written before per-clip caption styling existed) — matches what
# used to be the single hardcoded ASS style for every export.
_FALLBACK_CAPTION_STYLE = {
    "fontFamily": "Arial Black",
    "fontSizePx": 22,
    "bold": True,
    "color": "#FFFFFF",
    "outlineColor": "#000000",
    "outlineWidthPx": 2,
    "shadow": {"enabled": False, "blur": 4, "offsetX": 0, "offsetY": 2},
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
        else:
            segments.append({
                "kind": "image", "path": still["imagePath"], "start": start, "end": end,
                "motion": still.get("motion", "none"),
                "motionIntensity": still.get("motionIntensity", 0.22),
                "transitionIn": still.get("transitionIn", "cut"),
                "transitionOut": still.get("transitionOut", "cut"),
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


def build_image_filter(
    motion: str, transition_in: str, transition_out: str, intensity: float,
    width: int, height: int, fps: int, duration: float, frames: int,
    subject_x: float = 0.5, subject_y: float = 0.5,
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
    if transition_in == "fade":
        fades.append(f"fade=t=in:st=0:d={fade_in_duration:.3f}:color=black")
    if transition_out == "fade":
        fades.append(f"fade=t=out:st={max(0.0, duration - fade_out_duration):.3f}:d={fade_out_duration:.3f}:color=black")
    fade = "".join(f",{f}" for f in fades)

    def anchored_xy(sx: float, sy: float) -> str:
        return f"x='(iw-iw/zoom)*{sx:.5f}':y='(ih-ih/zoom)*{sy:.5f}'"

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
    }
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
            f"d={frames}:s={width}x{height}:fps={fps}{fade}"
        )
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps}{fade}"
    )


def build_video_filter(
    transition_in: str, transition_out: str, width: int, height: int, fps: int, duration: float,
) -> str:
    """Scale/pad a generated animation clip onto the target canvas, same as a
    still's `build_image_filter` but with no Ken-Burns zoompan — Veo output
    already has real motion, it just needs to fit the export frame."""
    fades = []
    if transition_in == "fade":
        fade_in_duration = max(0.15, min(duration / 2, duration * 0.08))
        fades.append(f"fade=t=in:st=0:d={fade_in_duration:.3f}:color=black")
    if transition_out == "fade":
        fade_out_duration = max(0.15, min(duration / 2, duration * 0.08))
        fades.append(f"fade=t=out:st={max(0.0, duration - fade_out_duration):.3f}:d={fade_out_duration:.3f}:color=black")
    fade = "".join(f",{f}" for f in fades)
    return (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={fps}{fade}"
    )


def run_ffmpeg(args: list[str]) -> None:
    result = subprocess.run(
        ["ffmpeg", *args], capture_output=True, text=True, **_subprocess_kwargs()
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {result.stderr[-2000:]}")


def encode_segment(
    segment: dict, index: int, width: int, height: int, fps: int, work_dir: Path
) -> Path:
    # `duration` (seconds) only bounds the input source (loop/color generator)
    # with headroom to spare — the segment's actual output length is fixed by
    # `-frames:v`, using the cumulative-frame-accurate count `assign_frame_counts`
    # already computed, not by re-deriving it from a time value. Trimming
    # output by `-t` instead would round each segment independently, which is
    # exactly the per-clip rounding error that used to accumulate into a
    # growing drift across many stills.
    duration = max(0.05, segment["end"] - segment["start"])
    frames = segment["frames"]
    out_path = work_dir / f"seg_{index:04d}.ts"
    if segment["kind"] == "image":
        vf = build_image_filter(
            segment.get("motion", "none"),
            segment.get("transitionIn", "cut"),
            segment.get("transitionOut", "cut"),
            segment.get("motionIntensity", 0.22),
            width, height, fps, duration, frames,
            segment.get("subjectX", 0.5), segment.get("subjectY", 0.5),
        )
        run_ffmpeg([
            "-y", "-loop", "1", "-t", f"{duration + 1:.3f}", "-i", segment["path"],
            # Intermediate segments are re-encoded again in the final concat
            # pass, so a low-quality intermediate compounds into a visibly
            # blurrier/blockier final export (double generation loss). A high
            # CRF here keeps this first pass close to lossless — the disk
            # cost is temporary, these files are deleted after the final pass.
            "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
            "-r", str(fps), "-frames:v", str(frames), str(out_path),
        ])
    elif segment["kind"] == "video":
        vf = build_video_filter(
            segment.get("transitionIn", "cut"),
            segment.get("transitionOut", "cut"),
            width, height, fps, duration,
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
        run_ffmpeg([
            "-y", "-i", segment["path"],
            "-vf", vf, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
            "-r", str(fps), "-frames:v", str(frames), str(out_path),
        ])
    else:
        run_ffmpeg([
            "-y", "-f", "lavfi", "-t", f"{duration + 1:.3f}",
            "-i", f"color=c=black:s={width}x{height}:r={fps}",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
            "-frames:v", str(frames), str(out_path),
        ])
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


def _resolve_shadow(style: dict) -> tuple[int, int]:
    """Maps our {enabled, blur, offsetX, offsetY} shadow shape onto ASS's
    single \\shad depth (plus an optional \\blur softness) — classic ASS has
    no separate per-axis offset or blur-radius concept for shadows, so this
    is a pragmatic approximation, not a literal translation."""
    shadow = _style_value(style, "shadow", {}) or {}
    if not shadow.get("enabled"):
        return 0, 0
    offset_x = float(shadow.get("offsetX", 0) or 0)
    offset_y = float(shadow.get("offsetY", 2) or 0)
    depth = max(1, round((abs(offset_x) + abs(offset_y)) / 2))
    blur = max(0, min(4, round(float(shadow.get("blur", 0) or 0) / 2)))
    return depth, blur


def _ass_override_tags(style: dict) -> str:
    font_family = _style_value(style, "fontFamily", "Arial Black")
    font_size = int(_style_value(style, "fontSizePx", 22))
    bold = 1 if _style_value(style, "bold", True) else 0
    color = _to_ass_color(_style_value(style, "color", "#FFFFFF"))
    outline_color = _to_ass_color(_style_value(style, "outlineColor", "#000000"))
    outline_width = _style_value(style, "outlineWidthPx", 2)
    alignment = _ASS_ALIGNMENT.get(_style_value(style, "position", "bottom"), 2)
    shadow_depth, blur = _resolve_shadow(style)
    tags = (
        f"\\fn{font_family}\\fs{font_size}\\b{bold}\\c{color}\\3c{outline_color}"
        f"\\bord{outline_width}\\shad{shadow_depth}\\an{alignment}"
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
    default_size = int(_style_value(default_style, "fontSizePx", 22))
    default_bold = 1 if _style_value(default_style, "bold", True) else 0
    default_color = _to_ass_color(_style_value(default_style, "color", "#FFFFFF"))
    default_outline_color = _to_ass_color(_style_value(default_style, "outlineColor", "#000000"))
    default_outline_width = _style_value(default_style, "outlineWidthPx", 2)
    default_alignment = _ASS_ALIGNMENT.get(_style_value(default_style, "position", "bottom"), 2)
    default_shadow_depth, _ = _resolve_shadow(default_style)

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
            base_tags = _ass_override_tags(style)
            base_color = _to_ass_color(_style_value(style, "color", "#FFFFFF"))
            highlight_color = _to_ass_color(word_highlight.get("color", "#FFEB3B"))
            lines.extend(_karaoke_dialogue_lines(chunk, style, base_tags, base_color, highlight_color))
        else:
            text = _ass_override_tags(style) + _escape_ass_text(chunk["text"])
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

    ass_path = work_dir / "captions.ass"
    has_captions = bool(captions)
    if has_captions:
        default_style = manifest.get("captionDefaultStyle") or _FALLBACK_CAPTION_STYLE
        write_captions_ass(captions, ass_path, width, height, default_style)

    engine.report_progress(72, "Rendering video", "Muxing audio and captions")
    final_args = [
        "-y", "-f", "concat", "-safe", "0", "-i", str(segments_list_path),
        "-i", narration_audio_path,
    ]
    # Narration's start offset is applied as an audio delay in the same filter
    # graph as the caption overlay (rather than a second ffmpeg pass) so
    # export stays a single encode; `adelay` needs one value per channel,
    # hence the doubled `|`-joined pair for stereo.
    video_filter = f"ass='{escape_subtitles_path(ass_path)}'" if has_captions else None
    audio_filter = f"adelay={round(narration_offset_seconds * 1000)}|{round(narration_offset_seconds * 1000)}" if narration_offset_seconds > 0 else None
    if video_filter or audio_filter:
        graph = []
        graph.append(f"[0:v]{video_filter}[v]" if video_filter else "[0:v]copy[v]")
        graph.append(f"[1:a]{audio_filter}[a]" if audio_filter else "[1:a]anull[a]")
        final_args += ["-filter_complex", ";".join(graph), "-map", "[v]", "-map", "[a]"]
    else:
        final_args += ["-map", "0:v", "-map", "1:a"]
    final_args += [
        "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(fps),
        "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart",
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
