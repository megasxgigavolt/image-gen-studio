"""
Auto Gen Studio internal caption engine.

Generates short-form, sentence-aware SRT captions from narration audio and its
authoritative script. Reuses the local Whisper transcription already wired up
in scene_grouping_engine.py (model caching, ffmpeg discovery, dependency
auto-install) and reconciles Whisper's word text against the script so
homophones and mis-heard words never reach the screen, while keeping
Whisper's timestamps.

Chunking rules (priority order):
  1. Comma or sentence-ending punctuation  -> flush the caption immediately.
  2. The rolling window exceeds --interval -> flush whatever was said.

Usage:
  python caption_engine.py narration.mp3 script.txt
  python caption_engine.py narration.mp3 script.txt --interval 0.8 --output captions.srt
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from pathlib import Path

import scene_grouping_engine as engine

CAPTION_INTERVAL = 1.0

_SENTENCE_END_RE = re.compile(r"[.!?]")
_BREAK_RE = re.compile(r"[.,!?]")
_PAUSE_TAG_RE = re.compile(r"<#[^>]*#>")
_WORD_CLEAN_RE = re.compile(r"[^\w']+", re.UNICODE)


def _normalize(token: str) -> str:
    return _WORD_CLEAN_RE.sub("", token.strip().lower())


def to_srt_ts(seconds: float) -> str:
    ms = int(round((seconds % 1) * 1000))
    whole = int(seconds)
    m, s = divmod(whole, 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def load_script_words(script_path: Path) -> list[str]:
    """Split the script into word tokens, stripping TTS pause tags like <#0.5#>."""
    raw = _PAUSE_TAG_RE.sub(" ", script_path.read_text(encoding="utf-8-sig"))
    return [token for token in raw.split() if _normalize(token)]


def _pair_with_timing(script_slice: list[str], whisper_slice: list[dict]) -> list[dict]:
    if not script_slice or not whisper_slice:
        return []
    if len(script_slice) == len(whisper_slice):
        return [
            {"word": word, "start": w["start"], "end": w["end"]}
            for word, w in zip(script_slice, whisper_slice)
        ]
    # Mismatched counts inside one replace block (rare) — spread Whisper's
    # timing for the block evenly across the script words instead of
    # guessing a word-to-word mapping.
    start, end = whisper_slice[0]["start"], whisper_slice[-1]["end"]
    step = max(end - start, 1e-3) / len(script_slice)
    return [
        {"word": word, "start": start + i * step, "end": start + (i + 1) * step}
        for i, word in enumerate(script_slice)
    ]


def _interpolate_missing(
    script_slice: list[str],
    aligned_so_far: list[dict],
    word_data: list[dict],
    next_whisper_index: int,
) -> list[dict]:
    if not script_slice:
        return []
    lower = aligned_so_far[-1]["end"] if aligned_so_far else 0.0
    upper = (
        word_data[next_whisper_index]["start"]
        if next_whisper_index < len(word_data)
        else lower + 0.3 * len(script_slice)
    )
    upper = max(upper, lower + 0.05 * len(script_slice))
    step = (upper - lower) / len(script_slice)
    return [
        {"word": word, "start": lower + i * step, "end": lower + (i + 1) * step}
        for i, word in enumerate(script_slice)
    ]


def reconcile_with_script(
    word_data: list[dict], script_words: list[str]
) -> tuple[list[dict], dict[str, int]]:
    """
    Corrects Whisper's word text against the authoritative script (fixing
    homophones such as "peace" vs "piece") while keeping Whisper's timestamps.
    """
    whisper_norm = [_normalize(item["word"]) for item in word_data]
    script_norm = [_normalize(w) for w in script_words]

    matcher = difflib.SequenceMatcher(a=script_norm, b=whisper_norm, autojunk=False)
    aligned: list[dict] = []
    stats = {"corrected": 0, "missing_in_audio": 0, "extra_in_audio": 0}

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        script_slice = script_words[i1:i2]
        whisper_slice = word_data[j1:j2]

        if tag == "equal":
            aligned.extend(_pair_with_timing(script_slice, whisper_slice))
        elif tag == "replace":
            overlap = min(len(script_slice), len(whisper_slice))
            stats["corrected"] += overlap
            stats["missing_in_audio"] += len(script_slice) - overlap
            stats["extra_in_audio"] += len(whisper_slice) - overlap
            aligned.extend(_pair_with_timing(script_slice, whisper_slice))
        elif tag == "delete":
            stats["missing_in_audio"] += len(script_slice)
            aligned.extend(_interpolate_missing(script_slice, aligned, word_data, j1))
        elif tag == "insert":
            stats["extra_in_audio"] += len(whisper_slice)
            # Whisper heard words that aren't in the script — drop them.

    return aligned, stats


def chunk_words(word_data: list[dict], interval: float = CAPTION_INTERVAL) -> list[dict]:
    chunks: list[dict] = []
    buf_words: list[dict] = []
    buf_start: float | None = None
    buf_end: float | None = None
    sentence_start = True

    def flush(end_time: float) -> None:
        nonlocal buf_words, buf_start, buf_end, sentence_start
        if buf_words:
            last = buf_words[-1]["word"]
            chunks.append({
                "text": " ".join(w["word"] for w in buf_words),
                "start": buf_start,
                "end": end_time,
                "sentence_start": sentence_start,
                # Whisper's own per-word timestamps, kept alongside the
                # aggregate chunk so the app can highlight the exact word
                # being spoken (karaoke-style) instead of just the whole line.
                "words": list(buf_words),
            })
            sentence_start = bool(_SENTENCE_END_RE.search(last))
            buf_words = []
            buf_start = None
            buf_end = None

    for item in word_data:
        word = item["word"].strip()
        start = item["start"]
        end = item["end"]
        if not word:
            continue
        if buf_start is None:
            buf_start = start
        buf_words.append({"word": word, "start": start, "end": end})
        buf_end = end
        is_break = bool(_BREAK_RE.search(word))
        if is_break or (end - buf_start) >= interval:
            flush(end)

    if buf_words:
        flush(buf_end)

    return chunks


def format_caption_text(text: str, sentence_start: bool = True) -> str:
    # Words are already correctly cased by reconcile_with_script() (proper nouns,
    # channel names, etc. come straight from the authoritative script) — only
    # strip caption punctuation and fix genuine sentence-start capitalization,
    # never blanket-lowercase the line.
    text = re.sub(r"[,.]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if sentence_start and text:
        text = text[0].upper() + text[1:]
    return text


def format_caption_words(words: list[dict], sentence_start: bool = True) -> list[dict]:
    """Per-word counterpart of format_caption_text — same punctuation
    stripping and sentence-start capitalization, applied word by word so
    each word keeps its own timestamp for karaoke-style highlighting."""
    cleaned = []
    for w in words:
        text = re.sub(r"[,.]", "", w["word"]).strip()
        if not text:
            continue
        cleaned.append({"text": text, "start": round(w["start"], 3), "end": round(w["end"], 3)})
    if sentence_start and cleaned and cleaned[0]["text"]:
        first = cleaned[0]["text"]
        cleaned[0]["text"] = first[0].upper() + first[1:]
    for w in cleaned:
        if w["text"].lower() == "i":
            w["text"] = "I"
    return cleaned


def write_srt(chunks: list[dict], out_path: Path) -> None:
    lines = []
    for i, c in enumerate(chunks, 1):
        lines.append(str(i))
        lines.append(f"{to_srt_ts(c['start'])} --> {to_srt_ts(c['end'])}")
        lines.append(format_caption_text(c["text"], c.get("sentence_start", True)))
        lines.append("")
    out_path.write_text("\n".join(lines), encoding="utf-8")


def write_json(chunks: list[dict], out_path: Path) -> None:
    exportable = [
        {
            "index": i + 1,
            "text": format_caption_text(c["text"], c.get("sentence_start", True)),
            "start": round(c["start"], 3),
            "end": round(c["end"], 3),
            "words": format_caption_words(c.get("words", []), c.get("sentence_start", True)),
        }
        for i, c in enumerate(chunks)
    ]
    out_path.write_text(
        json.dumps(exportable, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def run(args: argparse.Namespace) -> None:
    engine.report_progress(2, "Preparing captions", "Validating source files")
    media_path = Path(args.media).expanduser().resolve()
    script_path = Path(args.script).expanduser().resolve()

    if not media_path.exists():
        raise FileNotFoundError(f"Media file not found: {media_path}")
    if not script_path.exists():
        raise FileNotFoundError(f"Script file not found: {script_path}")
    if args.interval <= 0:
        raise ValueError("Caption interval must be greater than 0.")

    output_dir = (
        Path(args.output_dir).expanduser().resolve()
        if args.output_dir
        else media_path.parent
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    output_srt = (
        Path(args.output).expanduser().resolve()
        if args.output
        else output_dir / f"{media_path.stem}_captions.srt"
    )
    output_json = output_srt.with_suffix(".json")

    script_words = load_script_words(script_path)
    print(f"Read {len(script_words)} script words", flush=True)
    engine.report_progress(5, "Preparing captions", f"{len(script_words)} script words")

    whisper_words, _ = engine.transcribe_words(
        media_path=media_path,
        model_name=args.whisper_model,
        language=args.language,
    )
    word_data = [
        {"word": w.word, "start": w.start, "end": w.end} for w in whisper_words
    ]

    if script_words:
        engine.report_progress(
            55, "Reconciling transcript", "Correcting mis-heard words against the script"
        )
        aligned, stats = reconcile_with_script(word_data, script_words)
        if aligned:
            word_data = aligned
            print(
                "Verified transcript against script "
                f"({stats['corrected']} corrected, "
                f"{stats['missing_in_audio']} added from script, "
                f"{stats['extra_in_audio']} dropped as not in script)",
                flush=True,
            )

    engine.report_progress(70, "Building caption chunks", f"{args.interval:g}s window")
    chunks = chunk_words(word_data, interval=args.interval)
    print(f"{len(chunks)} caption chunks ({args.interval:g}s interval)", flush=True)

    if args.preview:
        print("\n" + "-" * 58)
        for i, c in enumerate(chunks, 1):
            start = to_srt_ts(c["start"]).replace(",", ".")
            end = to_srt_ts(c["end"]).replace(",", ".")
            text = format_caption_text(c["text"], c.get("sentence_start", True))
            print(f"  {i:<5} {start:>12} {end:>12}  {text}")
        print("-" * 58)

    engine.report_progress(92, "Saving captions", f"{len(chunks)} caption chunks")
    write_srt(chunks, output_srt)
    write_json(chunks, output_json)

    print(f"SRT: {output_srt}", flush=True)
    print(f"JSON: {output_json}", flush=True)
    engine.report_progress(100, "Captions ready", f"{len(chunks)} caption chunks")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="caption_engine",
        description="Generate sentence-aware SRT captions from narration audio and its script.",
    )
    parser.add_argument("media", help="Path to the narration audio or video file")
    parser.add_argument("script", help="Path to the matching UTF-8 script file")
    parser.add_argument(
        "--interval",
        type=float,
        default=CAPTION_INTERVAL,
        metavar="SEC",
        help=f"Caption window in seconds (default: {CAPTION_INTERVAL})",
    )
    parser.add_argument(
        "--whisper-model",
        default="base",
        choices=["tiny", "base", "small", "medium", "large", "large-v2", "large-v3"],
        help="Local Whisper model. Default: base",
    )
    parser.add_argument(
        "--language", default=None, help="Optional Whisper language code, such as en"
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        metavar="DIR",
        help="Output folder. Default: media file folder",
    )
    parser.add_argument(
        "--output", default=None, metavar="FILE.srt", help="Exact SRT output path"
    )
    parser.add_argument(
        "--preview", action="store_true", help="Print caption chunks to the terminal"
    )
    return parser


if __name__ == "__main__":
    cli_parser = build_parser()
    if len(sys.argv) == 1:
        cli_parser.print_help()
        sys.exit(0)
    try:
        run(cli_parser.parse_args())
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(130)
    except Exception as error:
        print(f"\nError: {error}\n")
        sys.exit(1)
