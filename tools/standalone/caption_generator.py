"""
caption_generator.py
────────────────────
Generates short-form captions (≤ N words per chunk) from any audio/video file.

Chunking rules (in priority order):
  1. Emphasized word  → shown ALONE as its own caption (detected via long pause
                        before it, or unusually slow/stretched pronunciation)
  2. Sentence end     → flush buffer immediately (1, 2, or 3 words — whatever
                        is left), never carry words across a sentence boundary
  3. Max-words limit  → flush when buffer reaches N words (default 3)

Case: Title Case (not ALL CAPS).

Exports:  .srt  |  .vtt  |  .json  |  terminal preview
Optional: burn captions into video via FFmpeg

Install:
  pip install openai-whisper
  # ffmpeg binary in PATH  (only needed for --burn-in)

Usage:
  python caption_generator.py clip.mp4
  python caption_generator.py reel.mp4 --words 2 --format vtt --preview
  python caption_generator.py talk.wav --model medium --format all
  python caption_generator.py video.mp4 --burn-in --preview
  python caption_generator.py audio.mp3 --output-dir ./captions
"""

import argparse
import json
import os
import re
import sys
import textwrap
from pathlib import Path

# Ensure ffmpeg installed via winget is on PATH
_FFMPEG_WINGET = (
    Path(os.environ.get("LOCALAPPDATA", ""))
    / "Microsoft/WinGet/Packages"
)
for _candidate in _FFMPEG_WINGET.glob("Gyan.FFmpeg_*/*/bin"):
    if str(_candidate) not in os.environ.get("PATH", ""):
        os.environ["PATH"] = str(_candidate) + os.pathsep + os.environ.get("PATH", "")

# ──────────────────────────────────────────────────────────────────────────────
# Timestamp helpers
# ──────────────────────────────────────────────────────────────────────────────

def to_srt_ts(seconds: float) -> str:
    ms = int(round((seconds % 1) * 1000))
    s  = int(seconds)
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

def to_vtt_ts(seconds: float) -> str:
    return to_srt_ts(seconds).replace(",", ".")


CAPTION_INTERVAL = 1.0   # seconds per caption chunk

# ──────────────────────────────────────────────────────────────────────────────
# Core chunker
# ──────────────────────────────────────────────────────────────────────────────

_SENTENCE_END_RE = re.compile(r"[.!?]")

def chunk_words(
    word_data: list[dict],
    interval: float = CAPTION_INTERVAL,
    **_,
) -> list[dict]:
    chunks: list[dict] = []
    buf_words: list[str] = []
    buf_start: float | None = None
    buf_end:   float | None = None
    sentence_start = True

    def flush(end_time: float) -> None:
        nonlocal buf_words, buf_start, buf_end, sentence_start
        if buf_words:
            last = buf_words[-1]
            chunks.append({
                "text":           " ".join(buf_words),
                "start":          buf_start,
                "end":            end_time,
                "sentence_start": sentence_start,
            })
            sentence_start = bool(_SENTENCE_END_RE.search(last))
            buf_words = []
            buf_start = None
            buf_end   = None

    for item in word_data:
        word  = item["word"].strip()
        start = item["start"]
        end   = item["end"]
        if not word:
            continue
        if buf_start is None:
            buf_start = start
        buf_words.append(word)
        buf_end = end
        is_sent_end = bool(_SENTENCE_END_RE.search(word))
        if is_sent_end or (end - buf_start) >= interval:
            flush(end)

    if buf_words:
        flush(buf_end)

    return chunks


# ──────────────────────────────────────────────────────────────────────────────
# Formatting
# ──────────────────────────────────────────────────────────────────────────────

def format_caption_text(text: str, sentence_start: bool = True) -> str:
    text = text.strip().lower()
    if sentence_start and text:
        text = text[0].upper() + text[1:]
    return re.sub(r'\bi\b', 'I', text)


# ──────────────────────────────────────────────────────────────────────────────
# Writers
# ──────────────────────────────────────────────────────────────────────────────

def write_srt(chunks: list[dict], out_path: Path) -> None:
    lines = []
    for i, c in enumerate(chunks, 1):
        lines.append(str(i))
        lines.append(f"{to_srt_ts(c['start'])} --> {to_srt_ts(c['end'])}")
        lines.append(format_caption_text(c["text"], c.get("sentence_start", True)))
        lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"  ✔  SRT  →  {out_path}")


def write_vtt(chunks: list[dict], out_path: Path) -> None:
    lines = ["WEBVTT", ""]
    for i, c in enumerate(chunks, 1):
        lines.append(f"cue-{i}")
        lines.append(f"{to_vtt_ts(c['start'])} --> {to_vtt_ts(c['end'])}")
        lines.append(format_caption_text(c["text"], c.get("sentence_start", True)))
        lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"  ✔  VTT  →  {out_path}")


def write_json(chunks: list[dict], out_path: Path) -> None:
    exportable = [
        {
            "index": i + 1,
            "text":  format_caption_text(c["text"], c.get("sentence_start", True)),
            "start": round(c["start"], 3),
            "end":   round(c["end"],   3),
        }
        for i, c in enumerate(chunks)
    ]
    out_path.write_text(
        json.dumps(exportable, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    print(f"  ✔  JSON →  {out_path}")


def preview_terminal(chunks: list[dict]) -> None:
    print("\n" + "─" * 58)
    print(f"  {'#':<5}  {'START':>12}  {'END':>12}  TEXT")
    print("─" * 58)
    for i, c in enumerate(chunks, 1):
        s   = to_srt_ts(c["start"]).replace(",", ".")
        e   = to_srt_ts(c["end"]).replace(",", ".")
        txt = format_caption_text(c["text"], c.get("sentence_start", True))
        print(f"  {i:<5}  {s:>12}  {e:>12}  {txt}")
    print("─" * 58)
    print(f"  Chunks: {len(chunks)}\n")


# ──────────────────────────────────────────────────────────────────────────────
# Optional burn-in
# ──────────────────────────────────────────────────────────────────────────────

def burn_captions_into_video(video_path: Path, srt_path: Path, out_path: Path) -> None:
    import subprocess

    srt_escaped = str(srt_path).replace("\\", "/").replace(":", "\\:")
    cmd = [
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-vf",
        (
            f"subtitles='{srt_escaped}'"
            ":force_style='FontName=Arial Black,FontSize=22,Bold=1,"
            "Alignment=2,PrimaryColour=&H00FFFFFF&,"
            "OutlineColour=&H00000000&,BorderStyle=1,Outline=2'"
        ),
        "-c:a", "copy",
        str(out_path),
    ]
    print(f"\n  ⚙  Burning captions → {out_path}  (this may take a moment…)")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print("  ✘  FFmpeg error:\n", result.stderr[-800:])
        sys.exit(1)
    print(f"  ✔  Burned video  →  {out_path}")


# ──────────────────────────────────────────────────────────────────────────────
# Transcription
# ──────────────────────────────────────────────────────────────────────────────

def transcribe(audio_path: Path, model_name: str) -> list[dict]:
    try:
        import whisper
    except ImportError:
        print("\n  ✘  openai-whisper not installed.\n     pip install openai-whisper\n")
        sys.exit(1)

    print(f"\n  ⚙  Loading Whisper model '{model_name}'…")
    model = whisper.load_model(model_name)

    print(f"  ⚙  Transcribing '{audio_path.name}'…")
    result = model.transcribe(str(audio_path), word_timestamps=True, verbose=False)

    words = []
    for segment in result.get("segments", []):
        for w in segment.get("words", []):
            words.append({"word": w["word"], "start": w["start"], "end": w["end"]})

    if not words:
        print("  ✘  No word-level timestamps returned.")
        print("     Use Whisper ≥ 20230306 and a non-tiny model.")
        sys.exit(1)

    print(f"  ✔  Transcribed {len(words)} words  ({len(result['segments'])} segments)\n")
    return words


# ──────────────────────────────────────────────────────────────────────────────
# Pipeline
# ──────────────────────────────────────────────────────────────────────────────

def run(args: argparse.Namespace) -> None:
    audio_path = Path(args.input)
    if not audio_path.exists():
        print(f"\n  ✘  File not found: {audio_path}\n")
        sys.exit(1)

    stem    = audio_path.stem
    out_dir = Path(args.output_dir) if args.output_dir else audio_path.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1. Transcribe
    words = transcribe(audio_path, args.model)

    # 2. Chunk
    chunks = chunk_words(words, interval=args.interval)

    print(f"  ✔  {len(chunks)} caption chunks  ({args.interval}s interval)\n")

    # 3. Preview
    if args.preview:
        preview_terminal(chunks)

    # 4. Write
    fmt = args.format.lower()
    if fmt in ("srt", "all"):
        write_srt(chunks, out_dir / f"{stem}_captions.srt")
    if fmt in ("vtt", "all"):
        write_vtt(chunks, out_dir / f"{stem}_captions.vtt")
    if fmt in ("json", "all"):
        write_json(chunks, out_dir / f"{stem}_captions.json")

    # 5. Burn-in
    if args.burn_in:
        srt_path = out_dir / f"{stem}_captions.srt"
        if not srt_path.exists():
            write_srt(chunks, srt_path)
        burn_captions_into_video(audio_path, srt_path, out_dir / f"{stem}_captioned.mp4")

    print("\n  ✅  Done!\n")


# ──────────────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="caption_generator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description=textwrap.dedent("""\
            Short-form caption generator — time-based, sentence-aware.

            Chunking rules:
              1. Sentence ends  →  flush immediately
              2. Interval elapses  →  flush whatever words were spoken

            Case: sentence case. Standalone "I" always capitalised.
        """),
        epilog=textwrap.dedent("""\
            Examples:
              python caption_generator.py clip.mp4
              python caption_generator.py reel.mp4 --interval 0.8 --format vtt --preview
              python caption_generator.py talk.wav  --model medium --format all
              python caption_generator.py video.mp4 --burn-in
              python caption_generator.py audio.mp3 --output-dir ./captions
        """),
    )

    p.add_argument("input",
                   help="Path to audio or video file (mp3/wav/mp4/mov/…)")

    p.add_argument("--interval", "-i",
                   type=float, default=CAPTION_INTERVAL, metavar="SEC",
                   help=f"Caption window in seconds (default: {CAPTION_INTERVAL})")

    p.add_argument("--model", "-m",
                   default="base",
                   choices=["tiny","base","small","medium","large","large-v2","large-v3"],
                   help="Whisper model (default: base)")

    p.add_argument("--format", "-f",
                   default="srt", choices=["srt","vtt","json","all"],
                   help="Output format (default: srt)")

    p.add_argument("--output-dir", "-o",
                   default=None, metavar="DIR",
                   help="Output directory (default: same folder as input)")

    p.add_argument("--preview",
                   action="store_true",
                   help="Print all caption chunks to the terminal")

    p.add_argument("--burn-in",
                   action="store_true",
                   help="Burn captions into video via FFmpeg")

    return p


if __name__ == "__main__":
    parser = build_parser()
    if len(sys.argv) == 1:
        parser.print_help()
        sys.exit(0)
    run(parser.parse_args())
