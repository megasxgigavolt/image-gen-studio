"""
visual_plan_generator.py

Transcribes an audio or video file with the same local Whisper package used by
caption_generator.py, detects sentence timestamps, asks an OpenAI model to
identify the hook and group sentences into faceless-video visual spans, then
exports an Excel workbook with exactly these columns:

    Start Timestamp
    End Timestamp
    Duration(s)
    Sentences
    Type

Type is "animation" during the hook and "still" after the hook.

Install:
    pip install openai-whisper openai pydantic xlsxwriter

FFmpeg must also be available on PATH.

Set the OpenAI key securely before running:

Windows Command Prompt:
    setx OPENAI_API_KEY "YOUR_NEW_KEY"

macOS or Linux:
    export OPENAI_API_KEY="YOUR_NEW_KEY"

Usage:
    python visual_plan_generator.py voiceover.mp3
    python visual_plan_generator.py video.mp4 --model medium --preview
    python visual_plan_generator.py audio.wav --ai-model gpt-5.4-mini
    python visual_plan_generator.py audio.mp3 --output-dir ./plans
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import textwrap
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass


# Keep the same Windows FFmpeg discovery behaviour as the uploaded script.
_FFMPEG_WINGET = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/WinGet/Packages"
for _candidate in _FFMPEG_WINGET.glob("Gyan.FFmpeg_*/*/bin"):
    if str(_candidate) not in os.environ.get("PATH", ""):
        os.environ["PATH"] = str(_candidate) + os.pathsep + os.environ.get("PATH", "")


SENTENCE_END_RE = re.compile(r"[.!?]+[\"'”’)]*$")
SPACE_BEFORE_PUNCTUATION_RE = re.compile(r"\s+([,.;:!?])")


@dataclass(frozen=True)
class TimedSentence:
    sentence_id: int
    start: float
    end: float
    text: str

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


@dataclass(frozen=True)
class VisualRow:
    start: float
    end: float
    duration: float
    sentences: str
    visual_type: str
    animation_slot: int | None = None


def snap_animation_duration(duration: float) -> int:
    """Return the smallest multiple of 4, 6, or 8 that is >= duration."""
    best = None
    for base in (4, 6, 8):
        candidate = base * math.ceil(duration / base)
        if best is None or candidate < best:
            best = candidate
    return best


# -----------------------------------------------------------------------------
# Timestamp helpers
# -----------------------------------------------------------------------------


def format_timestamp(seconds: float) -> str:
    """Convert seconds to HH:MM:SS.mmm without millisecond rollover errors."""
    total_ms = max(0, int(round(seconds * 1000)))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d}.{milliseconds:03d}"


def clean_joined_words(words: list[str]) -> str:
    text = " ".join(word.strip() for word in words if word.strip())
    text = SPACE_BEFORE_PUNCTUATION_RE.sub(r"\1", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


# -----------------------------------------------------------------------------
# Whisper transcription and sentence extraction
# -----------------------------------------------------------------------------


def transcribe(
    media_path: Path,
    model_name: str,
    language: str | None = None,
) -> tuple[list[dict], str | None]:
    try:
        import whisper
    except ImportError:
        print("\n  Error: openai-whisper is not installed.")
        print("  Run: pip install openai-whisper\n")
        sys.exit(1)

    print(f"\n  Loading local Whisper model: {model_name}")
    model = whisper.load_model(model_name)

    print(f"  Transcribing: {media_path.name}")
    options: dict = {
        "word_timestamps": True,
        "verbose": False,
        "condition_on_previous_text": True,
    }
    if language:
        options["language"] = language

    result = model.transcribe(str(media_path), **options)

    words: list[dict] = []
    for segment in result.get("segments", []):
        for word in segment.get("words", []):
            token = str(word.get("word", "")).strip()
            if not token:
                continue
            words.append(
                {
                    "word": token,
                    "start": float(word["start"]),
                    "end": float(word["end"]),
                }
            )

    if not words:
        print("\n  Error: Whisper returned no word timestamps.")
        print("  Try a larger Whisper model and check that the media contains speech.\n")
        sys.exit(1)

    detected_language = result.get("language")
    print(
        f"  Transcribed {len(words)} words"
        + (f" | language: {detected_language}" if detected_language else "")
    )
    return words, detected_language


def words_to_sentences(
    word_data: list[dict],
    pause_boundary: float = 1.0,
    max_sentence_duration: float = 20.0,
    min_words_before_pause_split: int = 4,
) -> list[TimedSentence]:
    """
    Create sentence-level timestamps from Whisper word timestamps.

    Primary boundary: punctuation produced by Whisper.
    Fallback boundaries: a meaningful pause or an unusually long sentence.
    """
    sentences: list[TimedSentence] = []
    current_words: list[str] = []
    current_start: float | None = None
    current_end: float | None = None

    def flush() -> None:
        nonlocal current_words, current_start, current_end
        if not current_words or current_start is None or current_end is None:
            return

        text = clean_joined_words(current_words)
        if text:
            sentences.append(
                TimedSentence(
                    sentence_id=len(sentences) + 1,
                    start=current_start,
                    end=current_end,
                    text=text,
                )
            )

        current_words = []
        current_start = None
        current_end = None

    previous_end: float | None = None

    for item in word_data:
        word = str(item["word"]).strip()
        start = float(item["start"])
        end = float(item["end"])

        if not word:
            continue

        gap = 0.0 if previous_end is None else max(0.0, start - previous_end)
        should_split_on_pause = (
            bool(current_words)
            and len(current_words) >= min_words_before_pause_split
            and gap >= pause_boundary
        )

        if should_split_on_pause:
            flush()

        if current_start is None:
            current_start = start

        current_words.append(word)
        current_end = end
        previous_end = end

        reached_punctuation = bool(SENTENCE_END_RE.search(word))
        reached_duration_limit = (
            current_start is not None
            and current_end - current_start >= max_sentence_duration
        )

        if reached_punctuation or reached_duration_limit:
            flush()

    flush()
    return sentences


# -----------------------------------------------------------------------------
# AI visual planning
# -----------------------------------------------------------------------------


def build_visual_plan_with_ai(
    sentences: list[TimedSentence],
    ai_model: str,
    max_attempts: int = 3,
) -> tuple[int, list[dict]]:
    try:
        from openai import OpenAI
        from pydantic import BaseModel, Field
    except ImportError:
        print("\n  Error: openai and pydantic are required.")
        print("  Run: pip install openai pydantic\n")
        sys.exit(1)

    if not os.environ.get("OPENAI_API_KEY"):
        print("\n  Error: OPENAI_API_KEY is not set.")
        print("  Store a newly rotated key in that environment variable, then rerun.\n")
        sys.exit(1)

    class VisualGroup(BaseModel):
        start_sentence_id: int = Field(
            description="First included sentence ID, inclusive"
        )
        end_sentence_id: int = Field(
            description="Last included sentence ID, inclusive"
        )
        type: Literal["animation", "still"]

    class VisualPlan(BaseModel):
        hook_end_sentence_id: int = Field(
            description="The final sentence ID belonging to the opening hook"
        )
        groups: list[VisualGroup]

    transcript_payload = []
    for i, sentence in enumerate(sentences):
        entry = {
            "id": sentence.sentence_id,
            "start_seconds": round(sentence.start, 3),
            "end_seconds": round(sentence.end, 3),
            "duration_seconds": round(sentence.duration, 3),
            "text": sentence.text,
        }
        # Show how long the group would be if this sentence were combined with
        # the previous one — helps the model apply the 12s rule explicitly.
        if i > 0:
            prev = sentences[i - 1]
            entry["duration_if_merged_with_prev"] = round(sentence.end - prev.start, 3)
        transcript_payload.append(entry)

    system_prompt = """
You are a senior faceless YouTube video editor creating a visual plan for a
voiceover script. You will receive an ordered list of sentences with IDs,
timestamps, and durations. Your job is to group consecutive sentences into
visual rows where each row represents one image or clip on screen.

════════════════════════════════════════════════════════
STEP 1 — READ THE FULL SCRIPT FIRST
════════════════════════════════════════════════════════
Read every sentence before making any decisions.
Understand the full narrative arc, topics, and pacing.

════════════════════════════════════════════════════════
STEP 2 — IDENTIFY THE HOOK
════════════════════════════════════════════════════════
The hook is the opening section that grabs attention: a mystery, surprising
claim, emotional setup, or bold promise. It ends the moment the main body
(numbered points, explanations, story payoff) clearly begins. Detect this
from the narrative, NOT from a fixed duration.

════════════════════════════════════════════════════════
STEP 3 — GROUP INTO VISUAL ROWS
════════════════════════════════════════════════════════

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANIMATION rows  (hook only)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• The hook must produce EXACTLY 4 to 5 animation rows — no more, no fewer.
• Divide hook sentences evenly across those 4–5 rows by visual beat.
• No group may cross the hook boundary.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STILL rows  (body only)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DURATION RULES — these are ABSOLUTE HARD LIMITS, not guidelines:

  ✦ HARD MAXIMUM: 12 seconds. A still row MUST NOT exceed 12.0 seconds.
  ✦ HARD MINIMUM: 2 seconds. A still row MUST NOT be shorter than 2.0 seconds.
  ✦ TARGET average: 7–9 seconds per still.

HOW TO BUILD EACH STILL GROUP (follow this algorithm exactly):
  1. Start a new group at the current sentence.
  2. Check: would adding the NEXT sentence push the group past 12 seconds?
       • YES → close the current group NOW. Start a new group at the next sentence.
       • NO  → add the next sentence to the current group. Continue.
  3. Also consider visual coherence: start a NEW group when the subject,
     scene, action, or emotional tone clearly changes — even if duration
     allows combining.
  4. NEVER combine sentences just to hit a duration target if they don't
     share the same visual moment.

IMPORTANT EDGE CASES:
  • If a SINGLE sentence alone exceeds 12 seconds, it gets its own row.
    Do NOT try to merge it with a neighbor to "fix" it — that would only
    make a longer violation. The post-processor handles oversized single
    sentences at the word level.
  • Never create a still shorter than 2 seconds UNLESS it is the final
    sentence in the script (no other choice).

════════════════════════════════════════════════════════
STEP 4 — FINAL SELF-CHECK (mandatory before returning)
════════════════════════════════════════════════════════
Go through every group you created and verify:
  □ Every sentence ID appears exactly once, in order, with no gaps.
  □ Groups are contiguous from sentence 1 to the final sentence.
  □ No group crosses the hook boundary.
  □ Hook has exactly 4–5 animation rows.
  □ EVERY still row is between 2.0 and 12.0 seconds (sum the duration_seconds
    for each sentence in the group to verify before returning).
  □ No still row exceeds 12 seconds — if any does, split it NOW.

Return only the structured result requested by the schema.
""".strip()

    client = OpenAI()
    last_validation_error = ""

    for attempt in range(1, max_attempts + 1):
        user_content = {
            "task": "Detect the hook and group sentences into visual spans.",
            "sentences": transcript_payload,
        }
        if last_validation_error:
            user_content["correction"] = (
                "The previous plan was invalid. Correct this issue: "
                + last_validation_error
            )

        print(f"  Building visual plan with {ai_model} | attempt {attempt}")
        response = client.responses.parse(
            model=ai_model,
            input=[
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": json.dumps(user_content, ensure_ascii=False),
                },
            ],
            text_format=VisualPlan,
        )

        parsed = response.output_parsed
        if parsed is None:
            last_validation_error = "The model returned no parsed visual plan."
            continue

        groups = [group.model_dump() for group in parsed.groups]

        # Auto-fix duration violations before validating so a single oversized
        # group doesn't burn retries that the post-processor would resolve anyway.
        groups = enforce_still_duration(sentences, groups, max_duration=12.0, min_duration=2.0)

        validation_error = validate_visual_plan(
            sentence_count=len(sentences),
            hook_end_sentence_id=parsed.hook_end_sentence_id,
            groups=groups,
            sentences=sentences,
        )
        if validation_error is None:
            return parsed.hook_end_sentence_id, groups

        last_validation_error = validation_error

    raise RuntimeError(
        "The AI could not produce a valid visual plan after "
        f"{max_attempts} attempts. Last issue: {last_validation_error}"
    )


def validate_visual_plan(
    sentence_count: int,
    hook_end_sentence_id: int,
    groups: list[dict],
    sentences: list[TimedSentence] | None = None,
    max_still_duration: float = 12.0,
    min_still_duration: float = 2.0,
) -> str | None:
    if sentence_count < 1:
        return "There are no sentences to group."

    if not 1 <= hook_end_sentence_id <= sentence_count:
        return (
            f"hook_end_sentence_id must be between 1 and {sentence_count}, "
            f"but was {hook_end_sentence_id}."
        )

    if not groups:
        return "The groups array is empty."

    expected_start = 1

    for index, group in enumerate(groups, start=1):
        start_id = int(group["start_sentence_id"])
        end_id = int(group["end_sentence_id"])
        visual_type = str(group["type"])

        if start_id != expected_start:
            return (
                f"Group {index} must start at sentence {expected_start}, "
                f"but starts at {start_id}."
            )
        if end_id < start_id:
            return f"Group {index} ends before it starts."
        if end_id > sentence_count:
            return f"Group {index} ends after the final sentence."

        if start_id <= hook_end_sentence_id < end_id:
            return f"Group {index} crosses the hook boundary."

        expected_type = "animation" if end_id <= hook_end_sentence_id else "still"
        if visual_type != expected_type:
            return (
                f"Group {index} must have type {expected_type}, "
                f"but has type {visual_type}."
            )

        # Duration checks for still rows when sentence data is available.
        if visual_type == "still" and sentences is not None:
            selected = sentences[start_id - 1 : end_id]
            if selected:
                dur = selected[-1].end - selected[0].start
                # Single-sentence groups that exceed the limit cannot be split
                # further — enforce_still_duration keeps them with a warning.
                if dur > max_still_duration and end_id > start_id:
                    return (
                        f"Group {index} (sentences {start_id}–{end_id}) is "
                        f"{dur:.2f}s which exceeds the hard maximum of "
                        f"{max_still_duration}s. Split it into shorter groups."
                    )

        expected_start = end_id + 1

    if expected_start != sentence_count + 1:
        return (
            f"The plan does not end at sentence {sentence_count}. "
            f"The next expected sentence is {expected_start}."
        )

    return None


def enforce_still_duration(
    sentences: list[TimedSentence],
    groups: list[dict],
    max_duration: float = 12.0,
    min_duration: float = 2.0,
) -> list[dict]:
    """
    Post-processing pass that enforces hard duration limits on still rows.

    Pass 1 — split:  Any still group (or single sentence) exceeding max_duration
    is split at sentence boundaries.  If a single sentence alone exceeds
    max_duration it is kept as its own row (the AI cannot fix it here; a
    word-level note is printed for the user).

    Pass 2 — merge:  Any still row that is shorter than min_duration is merged
    forward into the next still row (or, if it is the last row, merged backward).
    Animation rows are never touched.
    """
    # ── Pass 1: split oversized groups ──────────────────────────────────────
    split_result: list[dict] = []

    for group in groups:
        visual_type = str(group["type"])
        start_id = int(group["start_sentence_id"])
        end_id = int(group["end_sentence_id"])
        selected = sentences[start_id - 1 : end_id]

        if visual_type == "animation":
            split_result.append(group)
            continue

        group_dur = selected[-1].end - selected[0].start
        if group_dur <= max_duration:
            split_result.append(group)
            continue

        # Split greedily: keep adding sentences until the next one would push
        # past max_duration, then close and open a new batch.
        current_batch: list[TimedSentence] = []
        for sentence in selected:
            if not current_batch:
                current_batch.append(sentence)
                continue
            projected = sentence.end - current_batch[0].start
            if projected > max_duration:
                # Close the current batch.
                split_result.append({
                    "start_sentence_id": current_batch[0].sentence_id,
                    "end_sentence_id": current_batch[-1].sentence_id,
                    "type": visual_type,
                })
                current_batch = [sentence]
            else:
                current_batch.append(sentence)

        if current_batch:
            leftover_dur = current_batch[-1].end - current_batch[0].start
            if leftover_dur > max_duration:
                # Single sentence exceeds limit — keep as own row and warn.
                print(
                    f"  Warning: sentence {current_batch[0].sentence_id} is "
                    f"{leftover_dur:.1f}s — exceeds the {max_duration}s limit "
                    f"but cannot be split at the sentence level. "
                    f"Consider breaking this sentence in your script."
                )
            split_result.append({
                "start_sentence_id": current_batch[0].sentence_id,
                "end_sentence_id": current_batch[-1].sentence_id,
                "type": visual_type,
            })

    # ── Pass 2: merge undersized still rows ─────────────────────────────────
    # Collect (start_id, end_id, type) tuples and merge short stills forward.
    merged: list[dict] = list(split_result)  # work on a copy
    changed = True
    while changed:
        changed = False
        new_merged: list[dict] = []
        i = 0
        while i < len(merged):
            row = merged[i]
            if row["type"] == "still":
                s_id = int(row["start_sentence_id"])
                e_id = int(row["end_sentence_id"])
                selected = sentences[s_id - 1 : e_id]
                dur = selected[-1].end - selected[0].start
                if dur < min_duration and i + 1 < len(merged) and merged[i + 1]["type"] == "still":
                    # Merge this row into the next still row.
                    next_row = merged[i + 1]
                    new_merged.append({
                        "start_sentence_id": s_id,
                        "end_sentence_id": int(next_row["end_sentence_id"]),
                        "type": "still",
                    })
                    i += 2
                    changed = True
                    continue
            new_merged.append(row)
            i += 1
        merged = new_merged

    return merged


def heuristic_visual_plan(sentences: list[TimedSentence]) -> tuple[int, list[dict]]:
    """Emergency fallback used only when the AI request fails and fallback is enabled."""
    hook_end = 1
    for sentence in sentences:
        hook_end = sentence.sentence_id
        if sentence.end >= 12.0 or sentence.sentence_id >= 4:
            break

    groups: list[dict] = []

    # Hook: short animation beats.
    group_start = 1
    running_start = sentences[0].start
    for sentence in sentences[:hook_end]:
        if sentence.end - running_start >= 4.0:
            groups.append(
                {
                    "start_sentence_id": group_start,
                    "end_sentence_id": sentence.sentence_id,
                    "type": "animation",
                }
            )
            group_start = sentence.sentence_id + 1
            if group_start <= hook_end:
                running_start = sentences[group_start - 1].start

    if group_start <= hook_end:
        groups.append(
            {
                "start_sentence_id": group_start,
                "end_sentence_id": hook_end,
                "type": "animation",
            }
        )

    # Body: bundle stills to roughly 7 seconds.
    if hook_end < len(sentences):
        group_start = hook_end + 1
        running_start = sentences[group_start - 1].start
        for sentence in sentences[hook_end:]:
            if sentence.end - running_start >= 7.0:
                groups.append(
                    {
                        "start_sentence_id": group_start,
                        "end_sentence_id": sentence.sentence_id,
                        "type": "still",
                    }
                )
                group_start = sentence.sentence_id + 1
                if group_start <= len(sentences):
                    running_start = sentences[group_start - 1].start

        if group_start <= len(sentences):
            groups.append(
                {
                    "start_sentence_id": group_start,
                    "end_sentence_id": len(sentences),
                    "type": "still",
                }
            )

    return hook_end, groups


def groups_to_rows(
    sentences: list[TimedSentence],
    groups: list[dict],
) -> list[VisualRow]:
    rows: list[VisualRow] = []

    for group in groups:
        start_id = int(group["start_sentence_id"])
        end_id = int(group["end_sentence_id"])
        selected = sentences[start_id - 1 : end_id]

        start = selected[0].start
        end = selected[-1].end
        audio_dur = max(0.0, end - start)
        combined_text = " ".join(sentence.text for sentence in selected).strip()
        visual_type = str(group["type"])

        rows.append(
            VisualRow(
                start=start,
                end=end,
                duration=round(audio_dur, 3),
                sentences=combined_text,
                visual_type=visual_type,
                animation_slot=snap_animation_duration(audio_dur) if visual_type == "animation" else None,
            )
        )

    return rows


# -----------------------------------------------------------------------------
# Excel writer
# -----------------------------------------------------------------------------


def write_excel(rows: list[VisualRow], output_path: Path) -> None:
    try:
        import xlsxwriter
    except ImportError:
        print("\n  Error: xlsxwriter is not installed.")
        print("  Run: pip install xlsxwriter\n")
        sys.exit(1)

    workbook = xlsxwriter.Workbook(str(output_path))
    worksheet = workbook.add_worksheet("Visual Plan")

    header_format = workbook.add_format(
        {
            "bold": True,
            "font_color": "#FFFFFF",
            "bg_color": "#1F4E78",
            "align": "center",
            "valign": "vcenter",
            "border": 1,
        }
    )
    timestamp_format = workbook.add_format(
        {"align": "center", "valign": "vcenter", "border": 1}
    )
    duration_format = workbook.add_format(
        {
            "num_format": "0.000",
            "align": "center",
            "valign": "vcenter",
            "border": 1,
        }
    )
    sentence_format = workbook.add_format(
        {"text_wrap": True, "valign": "top", "border": 1}
    )
    type_format = workbook.add_format(
        {"align": "center", "valign": "vcenter", "border": 1, "bold": True}
    )
    animation_format = workbook.add_format(
        {"bg_color": "#FFF2CC", "font_color": "#7F6000"}
    )
    still_format = workbook.add_format(
        {"bg_color": "#DDEBF7", "font_color": "#1F4E78"}
    )

    slot_format = workbook.add_format(
        {
            "num_format": "0",
            "align": "center",
            "valign": "vcenter",
            "border": 1,
            "bold": True,
        }
    )

    headers = [
        "Start Timestamp",
        "End Timestamp",
        "Duration(s)",
        "Sentences",
        "Type",
        "Animation Slot (s)",
    ]
    worksheet.write_row(0, 0, headers, header_format)

    for row_index, row in enumerate(rows, start=1):
        worksheet.write_string(row_index, 0, format_timestamp(row.start), timestamp_format)
        worksheet.write_string(row_index, 1, format_timestamp(row.end), timestamp_format)
        worksheet.write_number(row_index, 2, row.duration, duration_format)
        worksheet.write_string(row_index, 3, row.sentences, sentence_format)
        worksheet.write_string(row_index, 4, row.visual_type, type_format)
        if row.animation_slot is not None:
            worksheet.write_number(row_index, 5, row.animation_slot, slot_format)

    last_row = max(1, len(rows))
    worksheet.autofilter(0, 0, last_row, 5)
    worksheet.freeze_panes(1, 0)
    worksheet.set_column("A:B", 19)
    worksheet.set_column("C:C", 13)
    worksheet.set_column("D:D", 85)
    worksheet.set_column("E:E", 14)
    worksheet.set_column("F:F", 18)
    worksheet.set_row(0, 26)

    if rows:
        worksheet.conditional_format(
            1,
            4,
            len(rows),
            4,
            {
                "type": "text",
                "criteria": "containing",
                "value": "animation",
                "format": animation_format,
            },
        )
        worksheet.conditional_format(
            1,
            4,
            len(rows),
            4,
            {
                "type": "text",
                "criteria": "containing",
                "value": "still",
                "format": still_format,
            },
        )

    workbook.close()
    print(f"  Excel created: {output_path}")


# -----------------------------------------------------------------------------
# Preview and pipeline
# -----------------------------------------------------------------------------


def preview_rows(rows: list[VisualRow]) -> None:
    print("\n" + "=" * 120)
    print(f"{'#':<4} {'START':<13} {'END':<13} {'SEC':>7} {'SLOT':>5} {'TYPE':<10} SENTENCES")
    print("=" * 120)
    for index, row in enumerate(rows, start=1):
        sentence_preview = textwrap.shorten(row.sentences, width=62, placeholder="...")
        slot_str = str(row.animation_slot) if row.animation_slot is not None else ""
        print(
            f"{index:<4} {format_timestamp(row.start):<13} "
            f"{format_timestamp(row.end):<13} {row.duration:>7.3f} "
            f"{slot_str:>5} {row.visual_type:<10} {sentence_preview}"
        )
    print("=" * 120 + "\n")


def run(args: argparse.Namespace) -> None:
    media_path = Path(args.input).expanduser().resolve()
    if not media_path.exists():
        print(f"\n  Error: file not found: {media_path}\n")
        sys.exit(1)

    output_dir = (
        Path(args.output_dir).expanduser().resolve()
        if args.output_dir
        else media_path.parent
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    output_path = (
        Path(args.output).expanduser().resolve()
        if args.output
        else output_dir / f"{media_path.stem}_visual_plan.xlsx"
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)

    word_data, _ = transcribe(
        media_path=media_path,
        model_name=args.model,
        language=args.language,
    )

    sentences = words_to_sentences(
        word_data=word_data,
        pause_boundary=args.pause_boundary,
        max_sentence_duration=args.max_sentence_duration,
    )

    if not sentences:
        print("\n  Error: no sentences could be created from the transcription.\n")
        sys.exit(1)

    print(f"  Detected {len(sentences)} timestamped sentences")

    try:
        hook_end_sentence_id, groups = build_visual_plan_with_ai(
            sentences=sentences,
            ai_model=args.ai_model,
            max_attempts=2,
        )
    except Exception as exc:
        if not args.fallback_on_ai_error:
            raise
        print(f"\n  Warning: AI visual planning failed: {exc}")
        print("  Using the duration-based emergency fallback instead.")
        hook_end_sentence_id, groups = heuristic_visual_plan(sentences)

    groups = enforce_still_duration(sentences, groups, max_duration=12.0, min_duration=2.0)
    rows = groups_to_rows(sentences, groups)

    print(
        f"  Hook ends at sentence {hook_end_sentence_id} "
        f"({format_timestamp(sentences[hook_end_sentence_id - 1].end)})"
    )
    print(f"  Created {len(rows)} visual spans")

    if args.preview:
        preview_rows(rows)

    write_excel(rows, output_path)
    print("\n  Done.\n")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="visual_plan_generator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description=textwrap.dedent(
            """
            Create an AI-assisted faceless-video visual plan from audio or video.

            Whisper creates sentence timestamps. An OpenAI model detects the
            hook and decides how many consecutive sentences can share each
            animation or still visual. The result is exported to Excel.
            """
        ),
        epilog=textwrap.dedent(
            """
            Examples:
              python visual_plan_generator.py voiceover.mp3
              python visual_plan_generator.py video.mp4 --model medium --preview
              python visual_plan_generator.py audio.wav --language en
              python visual_plan_generator.py audio.mp3 --output plan.xlsx
            """
        ),
    )

    parser.add_argument("input", help="Path to an audio or video file")
    parser.add_argument(
        "--model",
        "-m",
        default="base",
        choices=["tiny", "base", "small", "medium", "large", "large-v2", "large-v3"],
        help="Local Whisper model, matching the original script. Default: base",
    )
    parser.add_argument(
        "--ai-model",
        default="gpt-5.4-mini",
        help="OpenAI model used for hook detection and visual grouping",
    )
    parser.add_argument(
        "--language",
        default=None,
        help="Optional Whisper language code, such as en or ur",
    )
    parser.add_argument(
        "--pause-boundary",
        type=float,
        default=1.0,
        metavar="SECONDS",
        help="Fallback pause length used as a sentence boundary. Default: 1.0",
    )
    parser.add_argument(
        "--max-sentence-duration",
        type=float,
        default=20.0,
        metavar="SECONDS",
        help="Fallback maximum sentence duration. Default: 20.0",
    )
    parser.add_argument(
        "--output-dir",
        "-o",
        default=None,
        metavar="DIR",
        help="Output folder. Default: same folder as the media file",
    )
    parser.add_argument(
        "--output",
        default=None,
        metavar="FILE.xlsx",
        help="Exact output Excel path",
    )
    parser.add_argument(
        "--preview",
        action="store_true",
        help="Print the generated visual spans in the terminal",
    )
    parser.add_argument(
        "--fallback-on-ai-error",
        action="store_true",
        help="Create a heuristic plan if the OpenAI request fails",
    )
    return parser


if __name__ == "__main__":
    cli_parser = build_parser()
    if len(sys.argv) == 1:
        cli_parser.print_help()
        sys.exit(0)
    run(cli_parser.parse_args())