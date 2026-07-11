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
_SUBTITLE_STYLE = (
    "FontName=Arial Black,FontSize=22,Bold=1,Alignment=2,"
    "PrimaryColour=&H00FFFFFF&,OutlineColour=&H00000000&,BorderStyle=1,Outline=2"
)


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
    segments so the whole [0, duration_seconds] range is covered."""
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


def build_image_filter(
    motion: str, transition_in: str, transition_out: str, intensity: float,
    width: int, height: int, fps: int, duration: float,
) -> str:
    """Ken Burns camera-movement presets via ffmpeg's zoompan filter, plus
    optional fade-from/to-black "transitions" at the start and/or end."""
    frames = max(1, round(duration * fps))
    amount = max(0.02, min(0.6, intensity))
    rate = amount / REFERENCE_DURATION
    max_scale = 1 + amount * 3
    peak = 1 + amount

    fades = []
    if transition_in == "fade":
        fades.append(f"fade=t=in:st=0:d={min(0.5, duration / 2):.3f}:color=black")
    if transition_out == "fade":
        fade_out_duration = min(0.5, duration / 2)
        fades.append(f"fade=t=out:st={max(0.0, duration - fade_out_duration):.3f}:d={fade_out_duration:.3f}:color=black")
    fade = "".join(f",{f}" for f in fades)

    zoompan_presets = {
        "zoom-in": (
            f"z='min({max_scale:.5f},1+{rate:.6f}*on/{fps})':"
            f"x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2'"
        ),
        "zoom-out": (
            f"z='min({max_scale:.5f},1+{rate:.6f}*({duration:.3f}-on/{fps}))':"
            f"x='(iw-iw/zoom)/2':y='(ih-ih/zoom)/2'"
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
        # space; scaling the source up well beyond the output resolution first
        # gives each frame's crop far more sub-pixel headroom, which is what
        # actually removes the visible jitter/shake (a well-known zoompan
        # quirk) — a source scaled close to the output size looks noticeably
        # shakier than one scaled to several times the output size.
        pre_scale = max(width, height) * 3
        return (
            f"scale={pre_scale}:-2,zoompan={zoompan_presets[motion]}:"
            f"d={frames}:s={width}x{height}:fps={fps}{fade}"
        )
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
    duration = max(0.05, segment["end"] - segment["start"])
    out_path = work_dir / f"seg_{index:04d}.ts"
    if segment["kind"] == "image":
        vf = build_image_filter(
            segment.get("motion", "none"),
            segment.get("transitionIn", "cut"),
            segment.get("transitionOut", "cut"),
            segment.get("motionIntensity", 0.22),
            width, height, fps, duration,
        )
        run_ffmpeg([
            "-y", "-loop", "1", "-t", f"{duration:.3f}", "-i", segment["path"],
            # Intermediate segments are re-encoded again in the final concat
            # pass, so a low-quality intermediate compounds into a visibly
            # blurrier/blockier final export (double generation loss). A high
            # CRF here keeps this first pass close to lossless — the disk
            # cost is temporary, these files are deleted after the final pass.
            "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p",
            "-r", str(fps), "-t", f"{duration:.3f}", str(out_path),
        ])
    else:
        run_ffmpeg([
            "-y", "-f", "lavfi", "-t", f"{duration:.3f}",
            "-i", f"color=c=black:s={width}x{height}:r={fps}",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", str(out_path),
        ])
    return out_path


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

    if duration_seconds <= 0:
        raise ValueError("Timeline has no duration to export.")

    work_dir = manifest_path.parent
    segments = build_segments(stills, duration_seconds)
    if not segments:
        raise ValueError("Nothing to export — the timeline has no stills.")

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

    srt_path = work_dir / "captions.srt"
    has_captions = bool(captions)
    if has_captions:
        write_captions_srt(captions, srt_path)

    engine.report_progress(72, "Rendering video", "Muxing audio and captions")
    final_args = [
        "-y", "-f", "concat", "-safe", "0", "-i", str(segments_list_path),
        "-i", narration_audio_path,
    ]
    if has_captions:
        final_args += [
            "-vf",
            f"subtitles='{escape_subtitles_path(srt_path)}':force_style='{_SUBTITLE_STYLE}'",
        ]
    final_args += [
        "-map", "0:v", "-map", "1:a",
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

    if duration_seconds <= 0:
        raise ValueError("Timeline has no duration to export.")

    segments = build_segments(stills, duration_seconds)
    if not segments:
        raise ValueError("Nothing to export — the timeline has no stills.")
    if segments[0]["kind"] == "image":
        segments[0]["transitionIn"] = "cut"
    if segments[-1]["kind"] == "image":
        segments[-1]["transitionOut"] = "cut"

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
    (destination_dir / "timing.txt").write_text(
        "Import the files in clips/ in numeric filename order onto a video track, placed back-to-back "
        "(select all and drop them in — most editors, including CapCut, keep multi-selected clips in the "
        "order you select them). Each still is already stretched to close any silence gap and its own "
        "duration matches its exact slot in the original timeline, so no manual trimming is needed.\n\n"
        "Import narration audio and captions.srt onto their own separate tracks — both already carry the "
        "correct absolute timestamps and need no further alignment.\n\n"
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
                     "or just report an audio file's real duration (--mode probe).",
    )
    parser.add_argument("manifest", help="Path to the timeline export manifest JSON, or an audio file path for --mode probe")
    parser.add_argument("--output", metavar="PATH", help="Output video path, or destination folder for --mode bundle (unused for --mode probe)")
    parser.add_argument("--mode", choices=["video", "bundle", "probe"], default="video", help="'video' bakes one MP4 (default); 'bundle' exports separate clip/audio/caption assets; 'probe' reports an audio file's real duration")
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


if __name__ == "__main__":
    cli_parser = build_parser()
    if len(sys.argv) == 1:
        cli_parser.print_help()
        sys.exit(0)
    args = cli_parser.parse_args()
    if args.mode != "probe" and not args.output:
        cli_parser.error("--output is required for --mode video/bundle")
    try:
        if args.mode == "probe":
            run_probe(Path(args.manifest).expanduser().resolve())
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
