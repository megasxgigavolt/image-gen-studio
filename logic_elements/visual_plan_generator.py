"""
visual_plan_generator.py

Creates a visual plan for a faceless YouTube video from:

1. An audio or video file
2. The authoritative script text file

Pipeline:

1. Local Whisper extracts word timestamps.
2. Script sentences are aligned to Whisper timestamps.
3. AI Pass 1 extracts sentence-level visual metadata.
4. AI Pass 2 evaluates every consecutive transition with Scene Boundary
   Strength (SBS) scoring and builds visual groups.
5. Deterministic validation and duration optimisation repair coverage,
   ordering, minimum duration, and maximum duration.
6. A self-contained HTML + CSS report is written to disk.

Install:

    pip install openai-whisper openai pydantic python-dotenv

FFmpeg must be on PATH.

Environment:

    OPENAI_API_KEY=your_key

Examples:

    python visual_plan_generator.py voiceover.mp3 script.txt
    python visual_plan_generator.py voiceover.mp3 script.txt --preview
    python visual_plan_generator.py voiceover.mp3 script.txt --min-duration 5 --max-duration 12
    python visual_plan_generator.py voiceover.mp3 script.txt --ai-model gpt-4o-mini
    python visual_plan_generator.py voiceover.mp3 script.txt --fallback-on-ai-error
"""

from __future__ import annotations

import argparse
import difflib
import html as _html
import json
import os
import re
import sys
import textwrap
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal, Sequence

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass


# Windows FFmpeg discovery for common winget installations.
_FFMPEG_WINGET = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/WinGet/Packages"
for _candidate in _FFMPEG_WINGET.glob("Gyan.FFmpeg_*/*/bin"):
    if str(_candidate) not in os.environ.get("PATH", ""):
        os.environ["PATH"] = str(_candidate) + os.pathsep + os.environ.get("PATH", "")


SENTENCE_END_RE = re.compile(r'[.!?]+["‘’“”\')\]]*$')
SCRIPT_SENTENCE_RE = re.compile(r'(?<=[.!?])(?:["‘’“”\')\]]*)\s+')
SPACE_BEFORE_PUNCTUATION_RE = re.compile(r"\s+([,.;:!?])")
NORMALIZE_RE = re.compile(r"[^\w\s]", re.UNICODE)

PASS2_BATCH_SIZE = 30
PASS2_CONTEXT = 5

TTS_TAG_RE = re.compile(r"<#[\d.]+#>")

# ---------------------------------------------------------------------------
# Embedded stylesheet — the only rendering technology used for output.
# ---------------------------------------------------------------------------

_CSS = """
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
               "Helvetica Neue", Arial, sans-serif;
  background: #f4f4f5;
  color: #18181b;
  line-height: 1.5;
  font-size: 15px;
}

/* ── Header ──────────────────────────────────────────────────────────────── */
header {
  background: #ffffff;
  border-bottom: 1px solid #e4e4e7;
  padding: 20px 32px;
  position: sticky;
  top: 0;
  z-index: 10;
  box-shadow: 0 1px 3px rgba(0,0,0,.06);
}

.header-inner {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  flex-wrap: wrap;
}

.eyebrow {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #71717a;
  margin-bottom: 3px;
}

h1 {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.source-name {
  font-size: 12px;
  color: #71717a;
  margin-top: 3px;
}

.summary-stats {
  display: flex;
  gap: 28px;
  flex-wrap: wrap;
}

.stat {
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 56px;
}

.stat strong {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.stat span {
  font-size: 10px;
  color: #71717a;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 500;
}

/* ── Main layout ─────────────────────────────────────────────────────────── */
main {
  max-width: 1200px;
  margin: 0 auto;
  padding: 32px;
}

/* ── Plan list ───────────────────────────────────────────────────────────── */
.plan-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.plan-group-shell {
  position: relative;
}

.hard-boundary-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  font-weight: 700;
  color: #b91c1c;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  padding: 5px 0 3px 66px;
}

.hard-boundary-badge::before {
  content: "";
  display: inline-block;
  width: 16px;
  height: 2px;
  background: #b91c1c;
  border-radius: 1px;
}

.plan-row {
  background: #ffffff;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
  display: grid;
  grid-template-columns: 54px 140px 1fr 210px;
  overflow: hidden;
  transition: box-shadow 0.1s;
}

.plan-row:hover {
  box-shadow: 0 2px 8px rgba(0,0,0,.07);
}

/* Group index number */
.plan-index {
  background: #f4f4f5;
  border-right: 1px solid #e4e4e7;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 700;
  color: #71717a;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}

/* Timing column */
.timing {
  padding: 14px 13px;
  border-right: 1px solid #e4e4e7;
  display: flex;
  flex-direction: column;
  gap: 4px;
  justify-content: center;
}

.timing strong {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
}

.timing small {
  font-size: 11px;
  color: #71717a;
}

/* Sentences column */
.sentences {
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  border-right: 1px solid #e4e4e7;
}

.sentence {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 7px 10px;
  background: #fafafa;
  border: 1px solid #e4e4e7;
  border-radius: 6px;
}

.sentence span {
  flex: 1;
  font-size: 13px;
  line-height: 1.45;
}

.sentence small {
  font-size: 11px;
  color: #a1a1aa;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  padding-top: 2px;
}

/* Scene metadata column */
.scene-meta {
  padding: 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: hidden;
}

/* Scene type / kind badge */
.kind {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 2px 8px;
  border-radius: 4px;
  width: fit-content;
}

.kind.establishing, .kind.hook  { background: #dbeafe; color: #1d4ed8; }
.kind.subject                   { background: #dcfce7; color: #15803d; }
.kind.development               { background: #fef9c3; color: #854d0e; }
.kind.explanation               { background: #fef9c3; color: #854d0e; }
.kind.conflict                  { background: #fee2e2; color: #b91c1c; }
.kind.escalation                { background: #fee2e2; color: #b91c1c; }
.kind.climax                    { background: #fce7f3; color: #be185d; }
.kind.resolution                { background: #f3e8ff; color: #7c3aed; }
.kind.lesson                    { background: #f3e8ff; color: #7c3aed; }
.kind.cta                       { background: #ffedd5; color: #c2410c; }
.kind.setup                     { background: #f4f4f5; color: #52525b; }
.kind.still                     { background: #f4f4f5; color: #52525b; }

.scene-label {
  font-size: 11px;
  color: #71717a;
  font-weight: 500;
}

.visual-anchor {
  font-size: 12px;
  color: #3f3f46;
  font-style: italic;
  line-height: 1.4;
}

.confidence {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 4px;
  width: fit-content;
  text-transform: capitalize;
}

.confidence.high   { background: #dcfce7; color: #15803d; }
.confidence.medium { background: #fef9c3; color: #854d0e; }
.confidence.low    { background: #fee2e2; color: #b91c1c; }

.reason {
  font-size: 11px;
  color: #a1a1aa;
  line-height: 1.4;
}

/* ── Collapsible audit sections ──────────────────────────────────────────── */
.analysis-section {
  margin-top: 40px;
}

.analysis-section > summary {
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  padding: 14px 4px;
  border-top: 1px solid #e4e4e7;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 8px;
  user-select: none;
  color: #3f3f46;
}

.analysis-section > summary::-webkit-details-marker { display: none; }

.analysis-section > summary::before {
  content: "\25B6";
  font-size: 9px;
  color: #a1a1aa;
  transition: transform 0.15s;
  display: inline-block;
}

.analysis-section[open] > summary::before {
  transform: rotate(90deg);
}

.table-wrapper {
  overflow-x: auto;
  margin-top: 12px;
  border: 1px solid #e4e4e7;
  border-radius: 8px;
}

/* ── Tables ──────────────────────────────────────────────────────────────── */
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

thead tr { background: #f4f4f5; }

th {
  padding: 9px 12px;
  text-align: left;
  font-weight: 600;
  font-size: 10px;
  color: #71717a;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid #e4e4e7;
  white-space: nowrap;
}

td {
  padding: 8px 12px;
  border-bottom: 1px solid #f4f4f5;
  vertical-align: top;
  max-width: 280px;
}

tbody tr:last-child td { border-bottom: none; }
tbody tr:hover td { background: #fafafa; }

/* Zone labels */
.zone { font-weight: 700; font-size: 11px; }
.zone-merge        { color: #15803d; }
.zone-strong-merge { color: #16a34a; }
.zone-ambiguous    { color: #854d0e; }
.zone-lean-split   { color: #c2410c; }
.zone-split        { color: #b91c1c; }
.zone-hard-split   { color: #7f1d1d; }

.action-split  { color: #b91c1c; font-weight: 700; }
.action-merge  { color: #15803d; }

.hb-yes { color: #b91c1c; font-weight: 600; }
.hb-no  { color: #a1a1aa; }

.num { font-variant-numeric: tabular-nums; }

/* ── Footer ──────────────────────────────────────────────────────────────── */
footer {
  text-align: center;
  padding: 32px;
  color: #a1a1aa;
  font-size: 12px;
  border-top: 1px solid #e4e4e7;
  margin-top: 48px;
}
"""


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class WhisperWord:
    word: str
    start: float
    end: float


@dataclass(frozen=True)
class ScriptSentence:
    sentence_id: int
    paragraph_id: int
    text: str


@dataclass(frozen=True)
class TimedSentence:
    sentence_id: int
    paragraph_id: int
    start: float
    end: float
    text: str

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


@dataclass(frozen=True)
class VisualGroup:
    group_id: int
    start_sentence_id: int
    end_sentence_id: int
    scene_type: str
    visual_anchor: str
    scene_description: str
    confidence: str
    reason: str
    hard_boundary_before: bool = False


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------

def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def format_timestamp(seconds: float) -> str:
    """HH:MM:SS.mmm — used in tables."""
    total_ms = max(0, int(round(seconds * 1000)))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d}.{milliseconds:03d}"


def format_time_short(seconds: float) -> str:
    """M:SS — used in the visual plan display."""
    total = max(0, int(seconds))
    return f"{total // 60}:{total % 60:02d}"


def normalize_text(text: str) -> str:
    text = text.lower().replace("’", "'")
    text = NORMALIZE_RE.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def clean_joined_words(words: Sequence[str]) -> str:
    text = " ".join(word.strip() for word in words if word.strip())
    text = SPACE_BEFORE_PUNCTUATION_RE.sub(r"\1", text)
    return re.sub(r"\s+", " ", text).strip()


# ---------------------------------------------------------------------------
# Script reading
# ---------------------------------------------------------------------------

def read_script(script_path: Path) -> list[ScriptSentence]:
    raw = script_path.read_text(encoding="utf-8-sig").strip()
    if not raw:
        raise ValueError("The script file is empty.")

    raw = TTS_TAG_RE.sub("", raw)

    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", raw) if p.strip()]
    sentences: list[ScriptSentence] = []

    for paragraph_id, paragraph in enumerate(paragraphs, start=1):
        compact = re.sub(r"\s+", " ", paragraph).strip()
        parts = [part.strip() for part in SCRIPT_SENTENCE_RE.split(compact) if part.strip()]

        if not parts:
            parts = [compact]

        for part in parts:
            sentences.append(
                ScriptSentence(
                    sentence_id=len(sentences) + 1,
                    paragraph_id=paragraph_id,
                    text=part,
                )
            )

    if not sentences:
        raise ValueError("No sentences could be extracted from the script.")

    return sentences


# ---------------------------------------------------------------------------
# Audio transcription
# ---------------------------------------------------------------------------

def transcribe_words(
    media_path: Path,
    model_name: str,
    language: str | None,
) -> tuple[list[WhisperWord], str | None]:
    try:
        import whisper
    except ImportError:
        print("\nError: openai-whisper is not installed.")
        print("Run: pip install openai-whisper\n")
        sys.exit(1)

    print(f"\nLoading Whisper model: {model_name}")
    model = whisper.load_model(model_name)

    options: dict = {
        "word_timestamps": True,
        "verbose": False,
        "condition_on_previous_text": True,
    }
    if language:
        options["language"] = language

    print(f"Transcribing: {media_path.name}")
    result = model.transcribe(str(media_path), **options)

    words: list[WhisperWord] = []
    for segment in result.get("segments", []):
        for item in segment.get("words", []):
            token = str(item.get("word", "")).strip()
            if token:
                words.append(
                    WhisperWord(
                        word=token,
                        start=float(item["start"]),
                        end=float(item["end"]),
                    )
                )

    if not words:
        raise RuntimeError("Whisper returned no word timestamps.")

    detected_language = result.get("language")
    print(
        f"Transcribed {len(words)} words"
        + (f" | language: {detected_language}" if detected_language else "")
    )
    return words, detected_language


# ---------------------------------------------------------------------------
# Script-to-audio alignment
# ---------------------------------------------------------------------------

def align_script_to_words(
    script_sentences: list[ScriptSentence],
    whisper_words: list[WhisperWord],
) -> list[TimedSentence]:
    """
    Align authoritative script sentences to Whisper words.

    Builds one normalised script token sequence and one normalised Whisper
    token sequence, then uses SequenceMatcher anchors to map script token
    positions onto audio token positions. Unmatched positions are filled by
    monotonic linear interpolation between the nearest anchors.
    """
    script_tokens: list[str] = []
    sentence_token_ranges: list[tuple[int, int]] = []

    for sentence in script_sentences:
        tokens = normalize_text(sentence.text).split()
        if not tokens:
            tokens = ["empty"]
        start_index = len(script_tokens)
        script_tokens.extend(tokens)
        sentence_token_ranges.append((start_index, len(script_tokens) - 1))

    whisper_tokens = [normalize_text(word.word) for word in whisper_words]
    whisper_tokens = [token if token else "empty" for token in whisper_tokens]

    matcher = difflib.SequenceMatcher(
        a=script_tokens,
        b=whisper_tokens,
        autojunk=False,
    )

    mapped: dict[int, int] = {}
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            mapped[block.a + offset] = block.b + offset

    anchors = sorted(mapped.items())
    if not anchors:
        raise RuntimeError(
            "Script and audio transcription could not be aligned. "
            "Check that the supplied script matches the narration."
        )

    def estimate_audio_index(script_index: int) -> int:
        if script_index in mapped:
            return mapped[script_index]

        left = None
        right = None
        for anchor in anchors:
            if anchor[0] < script_index:
                left = anchor
            elif anchor[0] > script_index:
                right = anchor
                break

        if left and right:
            script_span = right[0] - left[0]
            audio_span = right[1] - left[1]
            ratio = (script_index - left[0]) / max(1, script_span)
            estimate = left[1] + ratio * audio_span
        elif left:
            estimate = left[1] + (script_index - left[0])
        elif right:
            estimate = right[1] - (right[0] - script_index)
        else:
            estimate = 0

        return int(clamp(round(estimate), 0, len(whisper_words) - 1))

    timed: list[TimedSentence] = []
    previous_end_index = 0

    for sentence, (script_start, script_end) in zip(
        script_sentences,
        sentence_token_ranges,
    ):
        audio_start_index = estimate_audio_index(script_start)
        audio_end_index = estimate_audio_index(script_end)

        audio_start_index = max(previous_end_index, audio_start_index)
        audio_end_index = max(audio_start_index, audio_end_index)
        audio_end_index = min(audio_end_index, len(whisper_words) - 1)

        start = whisper_words[audio_start_index].start
        end = whisper_words[audio_end_index].end

        timed.append(
            TimedSentence(
                sentence_id=sentence.sentence_id,
                paragraph_id=sentence.paragraph_id,
                start=start,
                end=end,
                text=sentence.text,
            )
        )
        previous_end_index = min(audio_end_index + 1, len(whisper_words) - 1)

    # Repair accidental negative or overlapping timing ranges.
    repaired: list[TimedSentence] = []
    for index, sentence in enumerate(timed):
        start = sentence.start
        end = sentence.end

        if repaired:
            start = max(start, repaired[-1].end)

        if end <= start:
            if index + 1 < len(timed):
                next_start = timed[index + 1].start
                end = max(start + 0.05, next_start)
            else:
                end = max(start + 0.05, whisper_words[-1].end)

        repaired.append(
            TimedSentence(
                sentence_id=sentence.sentence_id,
                paragraph_id=sentence.paragraph_id,
                start=start,
                end=end,
                text=sentence.text,
            )
        )

    return repaired


# ---------------------------------------------------------------------------
# OpenAI client helpers
# ---------------------------------------------------------------------------

def get_openai_client():
    try:
        from openai import OpenAI
    except ImportError:
        print("\nError: openai is not installed.")
        print("Run: pip install openai\n")
        sys.exit(1)

    if not os.environ.get("OPENAI_API_KEY"):
        print("\nError: OPENAI_API_KEY is not set.")
        sys.exit(1)

    return OpenAI()


def parse_structured(
    client,
    model: str,
    system_prompt: str,
    user_payload: dict,
    response_model,
):
    """
    Prefer the Responses API parser. Fall back to the structured Chat
    Completions parser for older openai package versions.
    """
    input_messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
    ]

    responses_api = getattr(client, "responses", None)
    if responses_api is not None and hasattr(responses_api, "parse"):
        response = responses_api.parse(
            model=model,
            input=input_messages,
            text_format=response_model,
        )
        parsed = getattr(response, "output_parsed", None)
        if parsed is None:
            raise RuntimeError("OpenAI returned no parsed structured output.")
        return parsed

    beta = getattr(client, "beta", None)
    if beta is not None:
        response = beta.chat.completions.parse(
            model=model,
            messages=input_messages,
            response_format=response_model,
        )
        parsed = response.choices[0].message.parsed
        if parsed is None:
            raise RuntimeError("OpenAI returned no parsed structured output.")
        return parsed

    raise RuntimeError(
        "The installed openai package does not support structured parsing. "
        "Upgrade it with: pip install --upgrade openai"
    )


# ---------------------------------------------------------------------------
# AI Pass 1 — sentence-level visual metadata
# ---------------------------------------------------------------------------

def analyze_sentences_pass1(
    sentences: list[TimedSentence],
    ai_model: str,
):
    try:
        from pydantic import BaseModel, Field
    except ImportError:
        print("\nError: pydantic is not installed.")
        print("Run: pip install pydantic\n")
        sys.exit(1)

    StoryBeat = Literal[
        "hook", "setup", "development", "explanation", "conflict",
        "escalation", "climax", "resolution", "lesson", "cta",
    ]

    class SentenceAnalysis(BaseModel):
        sentence_id: int
        visual_anchor: str
        dominant_subject: str
        environment: str
        time_context: str
        action: str
        emotion: str
        story_beat: StoryBeat
        visual_density: int = Field(ge=1, le=10)
        narrative_energy: int = Field(ge=1, le=10)
        abstraction_level: int = Field(ge=0, le=100)
        visual_importance: int = Field(ge=1, le=10)
        hard_boundary_before: bool
        hard_boundary_reason: str

    class Pass1Result(BaseModel):
        hook_end_sentence_id: int
        analyses: list[SentenceAnalysis]

    system_prompt = """
You are Pass 1 of an advanced visual scene segmentation engine for faceless
YouTube video production.

Read the entire script before labeling any sentence.

For every sentence, extract the dominant visual meaning that a storyboard
artist could represent. Do not segment sentences into groups yet.

Definitions:

Visual anchor:
The single strongest still image implied by the sentence.

Dominant subject:
The main person, animal, object, place, concept, or event.

Environment:
The physical setting. Use "same or unspecified" when the text does not establish
a new location.

Time context:
The story time, such as same moment, later that day, years earlier, or timeless.

Action:
The primary visible activity.

Emotion:
The dominant emotional tone.

Story beat:
hook, setup, development, explanation, conflict, escalation, climax,
resolution, lesson, or cta.

Visual density:
1 means almost entirely abstract or statistical.
10 means a vivid physical event with clear subjects and action.

Narrative energy:
1 means quiet background information.
10 means peak danger, revelation, or climax.

Abstraction level:
0 means fully concrete and physically visible.
100 means purely conceptual or philosophical.

Visual importance:
1 means minor supporting detail.
10 means a dominant event that should strongly influence the image.

Hard boundary before:
Use true only when the sentence clearly begins a fundamentally new visual scene,
including a major subject replacement, major location replacement, major time
jump, before and after transformation, major story beat change, or a completely
new dominant visual anchor.

Paragraph boundaries are evidence, not automatic hard boundaries.

The hook ends when the opening attention grabbing setup gives way to the main
body. Detect this narratively, not by fixed duration.

Return exactly one analysis for every supplied sentence ID, in the same order.
"""

    payload = {
        "sentences": [
            {
                "sentence_id": sentence.sentence_id,
                "paragraph_id": sentence.paragraph_id,
                "start_seconds": round(sentence.start, 3),
                "end_seconds": round(sentence.end, 3),
                "duration_seconds": round(sentence.duration, 3),
                "text": sentence.text,
            }
            for sentence in sentences
        ]
    }

    client = get_openai_client()
    result = parse_structured(
        client=client,
        model=ai_model,
        system_prompt=system_prompt,
        user_payload=payload,
        response_model=Pass1Result,
    )

    expected_ids = [sentence.sentence_id for sentence in sentences]
    returned_ids = [item.sentence_id for item in result.analyses]
    if returned_ids != expected_ids:
        raise RuntimeError(
            f"Pass 1 sentence coverage is invalid. Expected {expected_ids}, "
            f"received {returned_ids}."
        )

    return result


# ---------------------------------------------------------------------------
# AI Pass 2 — Scene Boundary Strength scoring
# ---------------------------------------------------------------------------

def score_boundaries_pass2(
    sentences: list[TimedSentence],
    pass1_result,
    ai_model: str,
    min_duration: float,
    max_duration: float,
):
    try:
        from pydantic import BaseModel, Field
    except ImportError:
        print("\nError: pydantic is not installed.")
        print("Run: pip install pydantic\n")
        sys.exit(1)

    Vote = Literal["merge", "neutral", "split"]
    Zone = Literal[
        "merge", "strong_merge", "ambiguous", "lean_split", "split", "hard_split",
    ]
    Decision = Literal["merge", "split"]

    class PerspectiveVotes(BaseModel):
        storyboard_artist: Vote
        cinematographer: Vote
        narrative_editor: Vote

    class TransitionAnalysis(BaseModel):
        from_sentence_id: int
        to_sentence_id: int
        subject_shift: int = Field(ge=0, le=25)
        environment_shift: int = Field(ge=0, le=15)
        temporal_shift: int = Field(ge=0, le=10)
        action_shift: int = Field(ge=0, le=15)
        emotional_shift: int = Field(ge=0, le=10)
        narrative_function_shift: int = Field(ge=0, le=15)
        visual_composition_shift: int = Field(ge=0, le=10)
        raw_sbs: int = Field(ge=0, le=100)
        visual_replaceability_index: int = Field(ge=0, le=100)
        vri_modifier: int = Field(ge=-20, le=20)
        visual_dominance_modifier: int = Field(ge=0, le=10)
        abstraction_modifier: int = Field(ge=0, le=10)
        energy_modifier: int = Field(ge=0, le=10)
        perspective_votes: PerspectiveVotes
        perspective_modifier: int = Field(ge=-20, le=20)
        confidence_dampener: int = Field(ge=-10, le=0)
        momentum_modifier: int = Field(ge=-5, le=5)
        narrative_arc_modifier: int = Field(ge=-10, le=15)
        image_practicality_modifier: int = Field(ge=0, le=15)
        final_sbs: int = Field(ge=0, le=150)
        zone: Zone
        hard_boundary: bool
        dynamic_reasoning: str
        final_action: Decision

    class ProposedGroup(BaseModel):
        start_sentence_id: int
        end_sentence_id: int
        scene_type: str
        visual_anchor: str
        scene_description: str
        confidence: Literal["high", "medium", "low"]
        reason: str

    class Pass2Result(BaseModel):
        transitions: list[TransitionAnalysis]
        groups: list[ProposedGroup]

    system_prompt = f"""
You are Pass 2 of an advanced Visual Scene Segmentation Engine for AI generated
video production.

You think simultaneously as:

1. A storyboard artist
2. A cinematographer
3. A narrative editor

Your purpose is to determine whether the viewer should continue seeing the
current still image or see a new one.

Core question:

"If the current image remained on screen while the next sentence was narrated,
would the viewer feel that the image still belongs to the narration?"

Evaluate every consecutive transition A to B.

PRIMARY SCENE BOUNDARY STRENGTH SIGNALS

Subject shift: 0 to 25
Environment shift: 0 to 15
Temporal shift: 0 to 10
Action shift: 0 to 15
Emotional shift: 0 to 10
Narrative function shift: 0 to 15
Visual composition shift: 0 to 10

raw_sbs must equal the sum of these 7 primary signals.

VISUAL REPLACEABILITY INDEX

100 means the current image remains perfectly suitable for sentence B.
0 means the current image becomes obviously wrong.

Modifier:

90 to 100: minus 20
70 to 89: minus 10
50 to 69: 0
30 to 49: plus 10
Below 30: plus 20

VISUAL DOMINANCE

Add 10 when sentence B introduces a visual element whose importance is at least
4 points above the current dominant visual.

ABSTRACTION SHIFT

Small: 0
Moderate: 5
Large: 10

ENERGY SHIFT

Small: 0
Moderate: 5
Large: 10

PERSPECTIVE VOTING

Storyboard artist asks:
Would one illustration naturally represent both sentences?

Cinematographer asks:
Would a camera cut feel natural here?

Narrative editor asks:
Has the story beat meaningfully changed?

3 split votes: plus 20
2 split votes: plus 10
2 merge votes: minus 10
3 merge votes: minus 20
Otherwise: 0

CONFIDENCE DAMPENER

Classify each of the 7 primary signals as:

Split-leaning: scores above 50% of its maximum value
  Subject shift above 12, Environment shift above 7, Temporal shift above 5,
  Action shift above 7, Emotional shift above 5, Narrative function shift above 7,
  Visual composition shift above 5.

Merge-leaning: scores at or below 25% of its maximum value
  Subject shift 0-6, Environment shift 0-3, Temporal shift 0-2,
  Action shift 0-3, Emotional shift 0-2, Narrative function shift 0-3,
  Visual composition shift 0-2.

If split-leaning count is 3 or more AND merge-leaning count is 2 or more: minus 10
If split-leaning count is 2 or more AND merge-leaning count is 3 or more: minus 10
Otherwise: 0

A split should be supported by a majority of signals. This dampener penalizes
decisions driven by one or two outlier signals while most others indicate no change.

MOMENTUM

If the previous 2 transitions were weak boundaries, use minus 5.
If the previous 2 transitions were strong boundaries, use plus 5.
Otherwise use 0.

NARRATIVE ARC

Hook: plus 10
Conflict: plus 10
Escalation: plus 10
Climax: plus 15
Development: minus 5
Explanation: minus 10
Resolution: minus 5
Lesson: minus 10
CTA: plus 5
Setup: 0

IMAGE GENERATION PRACTICALITY

Ask whether a single generated image can accurately satisfy both sides of the
transition. Add 15 if not.

FINAL SBS

final_sbs equals raw_sbs plus all modifiers (vri_modifier, visual_dominance_modifier,
abstraction_modifier, energy_modifier, perspective_modifier, confidence_dampener,
momentum_modifier, narrative_arc_modifier, image_practicality_modifier),
clamped to 0 through 150.

DECISION ZONES

0 to 25: merge
26 to 44: strong_merge
45 to 59: ambiguous
60 to 74: lean_split
75 to 100: split
Above 100: hard_split

A transition marked as a genuine hard boundary must be split regardless of
duration.

AMBIGUOUS ZONE

For 45 to 59 ask:

1. Would an illustrator require a second reference image?
2. Would viewers experience visual dissonance?
3. Does a cut improve or interrupt pacing?
4. Does a cut improve retention?
5. Would a cut create unnecessary visual churn?
6. Is the current image still semantically correct?

DYNAMIC DECISION

The formula is evidence, not a prison. You may override the default zone only
when the visual reasoning is strong. Explain the override.

NARRATIVE COMPRESSION

Count visual ideas, not sentences. Several sentences describing the same
subject, event, mechanism, or emotional moment may share one image.

DURATION TARGETS

Minimum group duration: {min_duration:.3f} seconds
Maximum group duration: {max_duration:.3f} seconds

First make visual decisions. Then consider duration.

A group below minimum should normally merge across the lowest available boundary
unless that boundary is hard or the merged image would be misleading.

A group above maximum should split at the highest SBS inside that group.

A single sentence longer than the maximum may remain alone.

OUTPUT REQUIREMENTS

1. Return exactly one transition for each consecutive sentence pair.
2. Return contiguous groups covering every sentence exactly once.
3. Groups must appear in sentence order.
4. Never cross a hard boundary.
5. Use sentence metadata from Pass 1 as evidence.
6. Scene descriptions must describe one practical still image.
"""

    payload = {
        "minimum_group_duration": min_duration,
        "maximum_group_duration": max_duration,
        "hook_end_sentence_id": pass1_result.hook_end_sentence_id,
        "sentences": [
            {
                "sentence_id": sentence.sentence_id,
                "paragraph_id": sentence.paragraph_id,
                "start_seconds": round(sentence.start, 3),
                "end_seconds": round(sentence.end, 3),
                "duration_seconds": round(sentence.duration, 3),
                "text": sentence.text,
                "analysis": pass1_result.analyses[index].model_dump(),
            }
            for index, sentence in enumerate(sentences)
        ],
    }

    client = get_openai_client()
    result = parse_structured(
        client=client,
        model=ai_model,
        system_prompt=system_prompt,
        user_payload=payload,
        response_model=Pass2Result,
    )

    expected_transitions = max(0, len(sentences) - 1)
    if len(result.transitions) != expected_transitions:
        raise RuntimeError(
            f"Pass 2 returned {len(result.transitions)} transitions; "
            f"expected {expected_transitions}."
        )

    for index, transition in enumerate(result.transitions):
        expected_from = sentences[index].sentence_id
        expected_to = sentences[index + 1].sentence_id
        if (
            transition.from_sentence_id != expected_from
            or transition.to_sentence_id != expected_to
        ):
            raise RuntimeError(
                "Pass 2 transition order is invalid at position "
                f"{index + 1}: expected {expected_from}->{expected_to}."
            )

    return result


# ---------------------------------------------------------------------------
# Batched Pass 2 for long scripts
# ---------------------------------------------------------------------------

class _Pass1Slice:
    def __init__(self, hook_end_sentence_id: int, analyses: list) -> None:
        self.hook_end_sentence_id = hook_end_sentence_id
        self.analyses = analyses


class _BatchedPass2Result:
    def __init__(self, transitions: list, groups: list) -> None:
        self.transitions = transitions
        self.groups = groups


def _batch_score_boundaries_pass2(
    sentences: list[TimedSentence],
    pass1_result,
    ai_model: str,
    min_duration: float,
    max_duration: float,
) -> _BatchedPass2Result:
    """
    Splits sentences into overlapping chunks and runs Pass 2 on each, then
    merges all transitions into a single result. Each chunk includes
    PASS2_CONTEXT preceding sentences for context, and covers PASS2_BATCH_SIZE
    core sentences. The boundary transition at the end of each core is captured
    by including one extra sentence in the chunk.
    """
    if len(sentences) <= PASS2_BATCH_SIZE + PASS2_CONTEXT + 1:
        return score_boundaries_pass2(
            sentences=sentences,
            pass1_result=pass1_result,
            ai_model=ai_model,
            min_duration=min_duration,
            max_duration=max_duration,
        )

    all_transitions: list = []
    all_groups: list = []
    seen_from_ids: set[int] = set()

    batch_starts = list(range(0, len(sentences), PASS2_BATCH_SIZE))
    total_batches = len(batch_starts)

    for batch_num, batch_start in enumerate(batch_starts, start=1):
        context_start = max(0, batch_start - PASS2_CONTEXT)
        batch_end = min(batch_start + PASS2_BATCH_SIZE, len(sentences))
        chunk_end = min(batch_end + 1, len(sentences))

        chunk_sentences = sentences[context_start:chunk_end]
        chunk_pass1 = _Pass1Slice(
            hook_end_sentence_id=pass1_result.hook_end_sentence_id,
            analyses=pass1_result.analyses[context_start:chunk_end],
        )

        print(
            f"  Pass 2 batch {batch_num}/{total_batches}: "
            f"sentences {chunk_sentences[0].sentence_id}-{chunk_sentences[-1].sentence_id}"
        )

        chunk_result = score_boundaries_pass2(
            sentences=chunk_sentences,
            pass1_result=chunk_pass1,
            ai_model=ai_model,
            min_duration=min_duration,
            max_duration=max_duration,
        )

        core_min_id = sentences[batch_start].sentence_id
        core_max_id = sentences[batch_end - 1].sentence_id

        for transition in chunk_result.transitions:
            if (
                core_min_id <= transition.from_sentence_id <= core_max_id
                and transition.from_sentence_id not in seen_from_ids
            ):
                all_transitions.append(transition)
                seen_from_ids.add(transition.from_sentence_id)

        all_groups.extend(chunk_result.groups)

    all_transitions.sort(key=lambda t: t.from_sentence_id)

    expected = len(sentences) - 1
    if len(all_transitions) != expected:
        raise RuntimeError(
            f"Batched Pass 2 collected {len(all_transitions)} transitions; "
            f"expected {expected}."
        )

    return _BatchedPass2Result(transitions=all_transitions, groups=all_groups)


# ---------------------------------------------------------------------------
# Group normalisation and duration repair
# ---------------------------------------------------------------------------

def transition_map(pass2_result) -> dict[int, object]:
    """Key is the sentence ID before the boundary."""
    return {item.from_sentence_id: item for item in pass2_result.transitions}


def normalize_groups(
    sentences: list[TimedSentence],
    pass2_result,
) -> list[VisualGroup]:
    if not sentences:
        return []

    transitions = transition_map(pass2_result)
    proposed_by_start = {
        group.start_sentence_id: group for group in pass2_result.groups
    }

    boundaries: set[int] = set()
    for transition in pass2_result.transitions:
        if transition.final_action == "split" or transition.hard_boundary:
            boundaries.add(transition.from_sentence_id)

    groups: list[VisualGroup] = []
    start_id = sentences[0].sentence_id
    final_id = sentences[-1].sentence_id

    for sentence_id in range(start_id, final_id + 1):
        closes_here = sentence_id in boundaries or sentence_id == final_id
        if not closes_here:
            continue

        proposed = proposed_by_start.get(start_id)
        if proposed and proposed.end_sentence_id == sentence_id:
            scene_type = proposed.scene_type
            visual_anchor = proposed.visual_anchor
            scene_description = proposed.scene_description
            confidence = proposed.confidence
            reason = proposed.reason
        else:
            included = sentences[start_id - 1 : sentence_id]
            visual_anchor = included[0].text
            scene_description = " ".join(item.text for item in included)
            scene_type = "still"
            confidence = "medium"
            boundary = transitions.get(sentence_id)
            reason = (
                boundary.dynamic_reasoning
                if boundary is not None
                else "Reconstructed from validated transition decisions."
            )

        hard_before = False
        if start_id > 1:
            previous_transition = transitions.get(start_id - 1)
            hard_before = bool(previous_transition and previous_transition.hard_boundary)

        groups.append(
            VisualGroup(
                group_id=len(groups) + 1,
                start_sentence_id=start_id,
                end_sentence_id=sentence_id,
                scene_type=scene_type,
                visual_anchor=visual_anchor,
                scene_description=scene_description,
                confidence=confidence,
                reason=reason,
                hard_boundary_before=hard_before,
            )
        )
        start_id = sentence_id + 1

    return groups


def group_duration(group: VisualGroup, sentences: list[TimedSentence]) -> float:
    start = sentences[group.start_sentence_id - 1].start
    end = sentences[group.end_sentence_id - 1].end
    return max(0.0, end - start)


def rebuild_group(
    old_group: VisualGroup,
    group_id: int,
    start_id: int,
    end_id: int,
    reason: str | None = None,
) -> VisualGroup:
    return VisualGroup(
        group_id=group_id,
        start_sentence_id=start_id,
        end_sentence_id=end_id,
        scene_type=old_group.scene_type,
        visual_anchor=old_group.visual_anchor,
        scene_description=old_group.scene_description,
        confidence=old_group.confidence,
        reason=reason or old_group.reason,
        hard_boundary_before=old_group.hard_boundary_before,
    )


def renumber_groups(groups: list[VisualGroup]) -> list[VisualGroup]:
    return [
        VisualGroup(
            group_id=index,
            start_sentence_id=group.start_sentence_id,
            end_sentence_id=group.end_sentence_id,
            scene_type=group.scene_type,
            visual_anchor=group.visual_anchor,
            scene_description=group.scene_description,
            confidence=group.confidence,
            reason=group.reason,
            hard_boundary_before=group.hard_boundary_before,
        )
        for index, group in enumerate(groups, start=1)
    ]


def split_oversized_groups(
    groups: list[VisualGroup],
    sentences: list[TimedSentence],
    pass2_result,
    max_duration: float,
) -> list[VisualGroup]:
    transitions = transition_map(pass2_result)
    output: list[VisualGroup] = []

    for group in groups:
        pending = [group]

        while pending:
            current = pending.pop(0)
            duration = group_duration(current, sentences)

            if duration <= max_duration or current.start_sentence_id == current.end_sentence_id:
                output.append(current)
                continue

            candidate_boundaries = list(
                range(current.start_sentence_id, current.end_sentence_id)
            )

            best_boundary = max(
                candidate_boundaries,
                key=lambda boundary: (
                    getattr(transitions.get(boundary), "final_sbs", 0),
                    -abs(
                        (sentences[boundary - 1].end - sentences[current.start_sentence_id - 1].start)
                        - duration / 2
                    ),
                ),
            )

            left = rebuild_group(
                current,
                group_id=0,
                start_id=current.start_sentence_id,
                end_id=best_boundary,
                reason="Split during deterministic maximum duration repair.",
            )
            right = rebuild_group(
                current,
                group_id=0,
                start_id=best_boundary + 1,
                end_id=current.end_sentence_id,
                reason="Split during deterministic maximum duration repair.",
            )
            right = VisualGroup(
                **{
                    **asdict(right),
                    "hard_boundary_before": bool(
                        transitions.get(best_boundary)
                        and transitions[best_boundary].hard_boundary
                    ),
                }
            )
            pending = [left, right] + pending

    return renumber_groups(output)


def merge_short_groups(
    groups: list[VisualGroup],
    sentences: list[TimedSentence],
    pass2_result,
    min_duration: float,
    max_duration: float,
) -> list[VisualGroup]:
    transitions = transition_map(pass2_result)
    groups = groups[:]
    changed = True

    while changed and len(groups) > 1:
        changed = False

        for index, group in enumerate(groups):
            if group_duration(group, sentences) >= min_duration:
                continue

            choices: list[tuple[int, int, float]] = []

            if index > 0 and not group.hard_boundary_before:
                left = groups[index - 1]
                merged_duration = (
                    sentences[group.end_sentence_id - 1].end
                    - sentences[left.start_sentence_id - 1].start
                )
                if merged_duration <= max_duration:
                    boundary = left.end_sentence_id
                    sbs = getattr(transitions.get(boundary), "final_sbs", 50)
                    choices.append((sbs, index - 1, merged_duration))

            if index + 1 < len(groups):
                right = groups[index + 1]
                boundary = group.end_sentence_id
                transition = transitions.get(boundary)
                hard = bool(transition and transition.hard_boundary)
                merged_duration = (
                    sentences[right.end_sentence_id - 1].end
                    - sentences[group.start_sentence_id - 1].start
                )
                if not hard and merged_duration <= max_duration:
                    sbs = getattr(transition, "final_sbs", 50)
                    choices.append((sbs, index + 1, merged_duration))

            if not choices:
                # Retry without the max_duration constraint; hard boundaries remain inviolable.
                if index > 0 and not group.hard_boundary_before:
                    left = groups[index - 1]
                    merged_duration = (
                        sentences[group.end_sentence_id - 1].end
                        - sentences[left.start_sentence_id - 1].start
                    )
                    boundary = left.end_sentence_id
                    sbs = getattr(transitions.get(boundary), "final_sbs", 50)
                    choices.append((sbs, index - 1, merged_duration))

                if index + 1 < len(groups):
                    right = groups[index + 1]
                    boundary = group.end_sentence_id
                    transition = transitions.get(boundary)
                    hard = bool(transition and transition.hard_boundary)
                    merged_duration = (
                        sentences[right.end_sentence_id - 1].end
                        - sentences[group.start_sentence_id - 1].start
                    )
                    if not hard:
                        sbs = getattr(transition, "final_sbs", 50)
                        choices.append((sbs, index + 1, merged_duration))

            if not choices:
                continue  # Isolated by hard boundaries on both sides.

            _, neighbor_index, _ = min(choices, key=lambda item: item[0])

            if neighbor_index < index:
                left = groups[neighbor_index]
                merged = VisualGroup(
                    group_id=0,
                    start_sentence_id=left.start_sentence_id,
                    end_sentence_id=group.end_sentence_id,
                    scene_type=left.scene_type,
                    visual_anchor=left.visual_anchor,
                    scene_description=(left.scene_description + " " + group.scene_description).strip(),
                    confidence="medium",
                    reason="Merged during minimum duration repair across the lowest available non hard boundary.",
                    hard_boundary_before=left.hard_boundary_before,
                )
                groups[neighbor_index : index + 1] = [merged]
            else:
                right = groups[neighbor_index]
                merged = VisualGroup(
                    group_id=0,
                    start_sentence_id=group.start_sentence_id,
                    end_sentence_id=right.end_sentence_id,
                    scene_type=group.scene_type,
                    visual_anchor=group.visual_anchor,
                    scene_description=(group.scene_description + " " + right.scene_description).strip(),
                    confidence="medium",
                    reason="Merged during minimum duration repair across the lowest available non hard boundary.",
                    hard_boundary_before=group.hard_boundary_before,
                )
                groups[index : neighbor_index + 1] = [merged]

            changed = True
            break

    return renumber_groups(groups)


def optimize_durations(
    groups: list[VisualGroup],
    sentences: list[TimedSentence],
    pass2_result,
    min_duration: float,
    max_duration: float,
) -> list[VisualGroup]:
    groups = split_oversized_groups(
        groups=groups, sentences=sentences, pass2_result=pass2_result, max_duration=max_duration,
    )
    groups = merge_short_groups(
        groups=groups, sentences=sentences, pass2_result=pass2_result,
        min_duration=min_duration, max_duration=max_duration,
    )
    return groups


def validate_groups(groups: list[VisualGroup], sentences: list[TimedSentence]) -> None:
    expected_id = 1
    for group in groups:
        if group.start_sentence_id != expected_id:
            raise RuntimeError(
                f"Group coverage gap or overlap before sentence {expected_id}."
            )
        if group.end_sentence_id < group.start_sentence_id:
            raise RuntimeError("A group has an invalid sentence range.")
        expected_id = group.end_sentence_id + 1

    if expected_id != len(sentences) + 1:
        raise RuntimeError("Final groups do not cover the entire script.")


def heuristic_fallback(
    sentences: list[TimedSentence],
    min_duration: float,
    max_duration: float,
) -> list[VisualGroup]:
    groups: list[VisualGroup] = []
    start_id = 1

    for sentence in sentences:
        current_duration = sentence.end - sentences[start_id - 1].start
        paragraph_changed = (
            sentence.sentence_id > start_id
            and sentence.paragraph_id != sentences[sentence.sentence_id - 2].paragraph_id
        )

        should_close_before = (
            sentence.sentence_id > start_id
            and (
                current_duration > max_duration
                or (
                    paragraph_changed
                    and (sentences[sentence.sentence_id - 2].end - sentences[start_id - 1].start)
                    >= min_duration
                )
            )
        )

        if should_close_before:
            end_id = sentence.sentence_id - 1
            groups.append(
                VisualGroup(
                    group_id=len(groups) + 1,
                    start_sentence_id=start_id,
                    end_sentence_id=end_id,
                    scene_type="still",
                    visual_anchor=sentences[start_id - 1].text,
                    scene_description=" ".join(
                        item.text for item in sentences[start_id - 1 : end_id]
                    ),
                    confidence="low",
                    reason="Duration and paragraph based emergency fallback.",
                )
            )
            start_id = sentence.sentence_id

    groups.append(
        VisualGroup(
            group_id=len(groups) + 1,
            start_sentence_id=start_id,
            end_sentence_id=len(sentences),
            scene_type="still",
            visual_anchor=sentences[start_id - 1].text,
            scene_description=" ".join(item.text for item in sentences[start_id - 1 :]),
            confidence="low",
            reason="Duration and paragraph based emergency fallback.",
        )
    )
    return groups


# ---------------------------------------------------------------------------
# HTML + CSS output
# ---------------------------------------------------------------------------

def _escape(text: str) -> str:
    return _html.escape(str(text))


def write_html(
    output_path: Path,
    sentences: list[TimedSentence],
    pass1_result,
    pass2_result,
    groups: list[VisualGroup],
    source_name: str,
) -> None:
    """Write a fully self-contained HTML + CSS visual plan report."""
    total_duration = sentences[-1].end if sentences else 0.0
    avg_duration = total_duration / len(groups) if groups else 0.0
    analysis_by_id = (
        {a.sentence_id: a for a in pass1_result.analyses}
        if pass1_result and hasattr(pass1_result, "analyses")
        else {}
    )

    parts: list[str] = []

    # ── Document head ──────────────────────────────────────────────────────
    parts.append(f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Visual Plan — {_escape(source_name)}</title>
  <style>{_CSS}</style>
</head>
<body>
""")

    # ── Sticky header ──────────────────────────────────────────────────────
    parts.append(f"""<header>
  <div class="header-inner">
    <div>
      <p class="eyebrow">Auto Gen Studio</p>
      <h1>Visual Plan</h1>
      <p class="source-name">{_escape(source_name)}</p>
    </div>
    <div class="summary-stats">
      <div class="stat">
        <strong>{len(groups)}</strong>
        <span>stills</span>
      </div>
      <div class="stat">
        <strong>{format_time_short(total_duration)}</strong>
        <span>total</span>
      </div>
      <div class="stat">
        <strong>{avg_duration:.1f}s</strong>
        <span>avg / still</span>
      </div>
      <div class="stat">
        <strong>{len(sentences)}</strong>
        <span>sentences</span>
      </div>
    </div>
  </div>
</header>
<main>
""")

    # ── Visual plan rows ───────────────────────────────────────────────────
    parts.append('<section class="plan-list">\n')

    for index, group in enumerate(groups):
        members = [
            sentences[i]
            for i in range(group.start_sentence_id - 1, group.end_sentence_id)
            if i < len(sentences)
        ]
        if not members:
            continue

        start_s = members[0].start
        end_s = members[-1].end
        duration_s = end_s - start_s
        kind_class = _escape(group.scene_type.lower().replace(" ", "-"))

        # Hard boundary marker
        hard_badge = ""
        if group.hard_boundary_before:
            hard_badge = (
                '<div class="hard-boundary-badge">Hard boundary</div>\n'
            )

        # Sentence chips
        sentence_chips = ""
        for sentence in members:
            sentence_chips += (
                f'        <div class="sentence">'
                f'<span>{_escape(sentence.text)}</span>'
                f'<small>{format_time_short(sentence.start)}</small>'
                f'</div>\n'
            )

        parts.append(
            f'  <div class="plan-group-shell">\n'
            f'{hard_badge}'
            f'    <article class="plan-row">\n'
            f'      <span class="plan-index">{str(index + 1).zfill(2)}</span>\n'
            f'      <div class="timing">'
            f'<strong>{format_time_short(start_s)} – {format_time_short(end_s)}</strong>'
            f'<small>{duration_s:.1f}&thinsp;s</small>'
            f'</div>\n'
            f'      <div class="sentences">\n{sentence_chips}      </div>\n'
            f'      <div class="scene-meta">\n'
            f'        <span class="kind {kind_class}">{_escape(group.scene_type)}</span>\n'
            f'        <small class="scene-label">Scene {group.group_id}</small>\n'
            f'        <p class="visual-anchor">{_escape(group.visual_anchor)}</p>\n'
            f'        <span class="confidence {_escape(group.confidence)}">'
            f'{_escape(group.confidence)}</span>\n'
            f'        <p class="reason">{_escape(group.reason)}</p>\n'
            f'      </div>\n'
            f'    </article>\n'
            f'  </div>\n'
        )

    parts.append('</section>\n')

    # ── Sentence analysis (collapsible) ────────────────────────────────────
    parts.append('<details class="analysis-section">\n')
    parts.append('  <summary>Sentence Analysis</summary>\n')
    parts.append('  <div class="table-wrapper"><table>\n')
    parts.append('    <thead><tr>')
    for col in [
        "ID", "Para", "Start", "End", "Dur&thinsp;s", "Text",
        "Visual Anchor", "Subject", "Environment", "Story Beat",
        "Density", "Energy", "Abstraction", "Importance", "Hard Boundary",
    ]:
        parts.append(f'<th>{col}</th>')
    parts.append('</tr></thead>\n    <tbody>\n')

    for sentence in sentences:
        analysis = analysis_by_id.get(sentence.sentence_id)
        parts.append('      <tr>')
        parts.append(f'<td class="num">{sentence.sentence_id}</td>')
        parts.append(f'<td class="num">{sentence.paragraph_id}</td>')
        parts.append(f'<td class="num">{format_timestamp(sentence.start)}</td>')
        parts.append(f'<td class="num">{format_timestamp(sentence.end)}</td>')
        parts.append(f'<td class="num">{sentence.duration:.3f}</td>')
        parts.append(f'<td>{_escape(sentence.text)}</td>')
        if analysis:
            parts.append(f'<td>{_escape(analysis.visual_anchor)}</td>')
            parts.append(f'<td>{_escape(analysis.dominant_subject)}</td>')
            parts.append(f'<td>{_escape(analysis.environment)}</td>')
            parts.append(f'<td>{_escape(analysis.story_beat)}</td>')
            parts.append(f'<td class="num">{analysis.visual_density}</td>')
            parts.append(f'<td class="num">{analysis.narrative_energy}</td>')
            parts.append(f'<td class="num">{analysis.abstraction_level}</td>')
            parts.append(f'<td class="num">{analysis.visual_importance}</td>')
            hb_class = "hb-yes" if analysis.hard_boundary_before else "hb-no"
            hb_label = "Yes" if analysis.hard_boundary_before else "No"
            parts.append(f'<td class="{hb_class}">{hb_label}</td>')
        else:
            parts.append('<td colspan="9">—</td>')
        parts.append('</tr>\n')

    parts.append('    </tbody>\n  </table></div>\n</details>\n')

    # ── Boundary audit (collapsible, shown only when AI ran) ───────────────
    has_transitions = (
        hasattr(pass2_result, "transitions") and pass2_result.transitions
    )
    if has_transitions:
        parts.append('<details class="analysis-section">\n')
        parts.append('  <summary>Boundary Audit &mdash; Scene Boundary Strength</summary>\n')
        parts.append('  <div class="table-wrapper"><table>\n')
        parts.append('    <thead><tr>')
        for col in [
            "From", "To", "Subject", "Env", "Time", "Action", "Emotion",
            "Narrative", "Composition", "Raw&thinsp;SBS", "VRI",
            "Final&thinsp;SBS", "Zone", "Hard", "Decision",
        ]:
            parts.append(f'<th>{col}</th>')
        parts.append('</tr></thead>\n    <tbody>\n')

        for t in pass2_result.transitions:
            zone_css = "zone zone-" + t.zone.replace("_", "-")
            action_css = "action-" + t.final_action
            hard_label = "⚠ Yes" if t.hard_boundary else "No"
            hard_class = "hb-yes" if t.hard_boundary else "hb-no"
            parts.append('      <tr>')
            parts.append(f'<td class="num">{t.from_sentence_id}</td>')
            parts.append(f'<td class="num">{t.to_sentence_id}</td>')
            parts.append(f'<td class="num">{t.subject_shift}</td>')
            parts.append(f'<td class="num">{t.environment_shift}</td>')
            parts.append(f'<td class="num">{t.temporal_shift}</td>')
            parts.append(f'<td class="num">{t.action_shift}</td>')
            parts.append(f'<td class="num">{t.emotional_shift}</td>')
            parts.append(f'<td class="num">{t.narrative_function_shift}</td>')
            parts.append(f'<td class="num">{t.visual_composition_shift}</td>')
            parts.append(f'<td class="num">{t.raw_sbs}</td>')
            parts.append(f'<td class="num">{t.visual_replaceability_index}</td>')
            parts.append(f'<td class="num"><strong>{t.final_sbs}</strong></td>')
            parts.append(f'<td class="{zone_css}">{_escape(t.zone)}</td>')
            parts.append(f'<td class="{hard_class}">{hard_label}</td>')
            parts.append(f'<td class="{action_css}">{_escape(t.final_action)}</td>')
            parts.append('</tr>\n')

        parts.append('    </tbody>\n  </table></div>\n</details>\n')

    # ── Footer ─────────────────────────────────────────────────────────────
    parts.append("""</main>
<footer>
  <p>Generated by Auto Gen Studio &middot; Visual Plan Generator</p>
</footer>
</body>
</html>
""")

    output_path.write_text("".join(parts), encoding="utf-8")


# ---------------------------------------------------------------------------
# Terminal preview
# ---------------------------------------------------------------------------

def preview_groups(
    groups: list[VisualGroup],
    sentences: list[TimedSentence],
) -> None:
    print("\nVISUAL PLAN")
    print("=" * 120)
    for group in groups:
        included = sentences[group.start_sentence_id - 1 : group.end_sentence_id]
        start = included[0].start
        end = included[-1].end
        sentence_text = " ".join(item.text for item in included)
        if len(sentence_text) > 75:
            sentence_text = sentence_text[:72] + "..."

        print(
            f"{group.group_id:>3} | "
            f"{format_timestamp(start)} -> {format_timestamp(end)} | "
            f"{end - start:>6.2f}s | "
            f"{group.start_sentence_id}-{group.end_sentence_id:<7} | "
            f"{group.confidence:<6} | {sentence_text}"
        )
    print("=" * 120)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def run(args: argparse.Namespace) -> None:
    media_path = Path(args.media).expanduser().resolve()
    script_path = Path(args.script).expanduser().resolve()

    if not media_path.exists():
        raise FileNotFoundError(f"Media file not found: {media_path}")
    if not script_path.exists():
        raise FileNotFoundError(f"Script file not found: {script_path}")
    if args.min_duration <= 0:
        raise ValueError("Minimum duration must be greater than 0.")
    if args.max_duration <= args.min_duration:
        raise ValueError("Maximum duration must be greater than minimum duration.")

    output_dir = (
        Path(args.output_dir).expanduser().resolve()
        if args.output_dir
        else media_path.parent
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    output_html = (
        Path(args.output).expanduser().resolve()
        if args.output
        else output_dir / f"{media_path.stem}_visual_plan.html"
    )

    script_sentences = read_script(script_path)
    print(f"Read {len(script_sentences)} script sentences")

    whisper_words, _ = transcribe_words(
        media_path=media_path,
        model_name=args.whisper_model,
        language=args.language,
    )

    sentences = align_script_to_words(
        script_sentences=script_sentences,
        whisper_words=whisper_words,
    )
    print(f"Aligned {len(sentences)} sentences to audio")

    try:
        print("\nAI Pass 1: extracting sentence visual metadata")
        pass1_result = analyze_sentences_pass1(
            sentences=sentences,
            ai_model=args.ai_model,
        )

        print("AI Pass 2: scoring scene boundaries and proposing groups")
        pass2_result = _batch_score_boundaries_pass2(
            sentences=sentences,
            pass1_result=pass1_result,
            ai_model=args.ai_model,
            min_duration=args.min_duration,
            max_duration=args.max_duration,
        )

        groups = normalize_groups(sentences=sentences, pass2_result=pass2_result)
        groups = optimize_durations(
            groups=groups,
            sentences=sentences,
            pass2_result=pass2_result,
            min_duration=args.min_duration,
            max_duration=args.max_duration,
        )
        validate_groups(groups, sentences)

    except Exception as exc:
        if not args.fallback_on_ai_error:
            raise

        print(f"\nWarning: AI segmentation failed: {exc}")
        print("Using emergency duration and paragraph based fallback.")

        from pydantic import BaseModel

        class FallbackAnalysis(BaseModel):
            sentence_id: int
            visual_anchor: str
            dominant_subject: str = "unknown"
            environment: str = "unspecified"
            time_context: str = "unspecified"
            action: str = "unspecified"
            emotion: str = "neutral"
            story_beat: str = "development"
            visual_density: int = 5
            narrative_energy: int = 5
            abstraction_level: int = 50
            visual_importance: int = 5
            hard_boundary_before: bool = False
            hard_boundary_reason: str = "Fallback mode"

        class FallbackPass1(BaseModel):
            hook_end_sentence_id: int
            analyses: list[FallbackAnalysis]

        class FallbackPass2(BaseModel):
            transitions: list = []

        pass1_result = FallbackPass1(
            hook_end_sentence_id=1,
            analyses=[
                FallbackAnalysis(sentence_id=s.sentence_id, visual_anchor=s.text)
                for s in sentences
            ],
        )
        pass2_result = FallbackPass2()
        groups = heuristic_fallback(
            sentences=sentences,
            min_duration=args.min_duration,
            max_duration=args.max_duration,
        )
        validate_groups(groups, sentences)

    if args.preview:
        preview_groups(groups, sentences)

    write_html(
        output_path=output_html,
        sentences=sentences,
        pass1_result=pass1_result,
        pass2_result=pass2_result,
        groups=groups,
        source_name=media_path.name,
    )

    print(f"\nHTML report: {output_html}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="visual_plan_generator",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description=textwrap.dedent(
            """
            Generate an AI-assisted visual scene plan from narration audio and
            its authoritative script.

            The system aligns script sentences to Whisper timestamps, performs
            two AI passes, scores every scene boundary, applies duration repair,
            and exports a self-contained HTML + CSS report.
            """
        ),
        epilog=textwrap.dedent(
            """
            Examples:

              python visual_plan_generator.py voiceover.mp3 script.txt

              python visual_plan_generator.py voiceover.mp3 script.txt \\
                --min-duration 5 --max-duration 12 --preview

              python visual_plan_generator.py video.mp4 script.txt \\
                --whisper-model medium --language en

              python visual_plan_generator.py voiceover.mp3 script.txt \\
                --fallback-on-ai-error --output my_plan.html
            """
        ),
    )

    parser.add_argument("media", help="Path to the audio or video file")
    parser.add_argument("script", help="Path to the matching UTF-8 script file")
    parser.add_argument(
        "--whisper-model",
        default="base",
        choices=["tiny", "base", "small", "medium", "large", "large-v2", "large-v3"],
        help="Local Whisper model size. Default: base",
    )
    parser.add_argument(
        "--ai-model",
        default="gpt-4o-mini",
        help="OpenAI model used for both AI passes. Default: gpt-4o-mini",
    )
    parser.add_argument(
        "--language",
        default=None,
        help="Optional Whisper language code, e.g. en or ur",
    )
    parser.add_argument(
        "--min-duration",
        type=float,
        default=5.0,
        metavar="SECONDS",
        help="Preferred minimum still duration in seconds. Default: 5",
    )
    parser.add_argument(
        "--max-duration",
        type=float,
        default=12.0,
        metavar="SECONDS",
        help="Maximum still duration in seconds. Default: 12",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        metavar="DIR",
        help="Output folder. Default: same folder as the media file",
    )
    parser.add_argument(
        "--output",
        default=None,
        metavar="FILE.html",
        help="Exact output path for the HTML report",
    )
    parser.add_argument(
        "--preview",
        action="store_true",
        help="Print a summary of final visual groups to the terminal",
    )
    parser.add_argument(
        "--fallback-on-ai-error",
        action="store_true",
        help="Use a duration and paragraph heuristic if an AI call fails",
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
