"""
Auto Gen Studio internal scene-grouping engine.

Extracted from the read-only visual scene segmenter reference. Creates a visual
plan for a faceless YouTube video from:

1. An audio or video file
2. The authoritative script text file

Pipeline:

1. Local Whisper extracts word timestamps.
2. Script sentences are aligned to Whisper timestamps.
3. AI Pass 1 extracts sentence level visual metadata.
4. AI Pass 2 evaluates every consecutive transition with Scene Boundary
   Strength scoring and builds visual groups.
5. Deterministic validation and duration optimization repair coverage,nd the moment your shadow crosses the glass, your fish is already there.
   ordering, minimum duration, and maximum duration.
6. Excel and JSON audit files are exported.

Install:

    pip install openai-whisper openai pydantic python-dotenv xlsxwriter

FFmpeg must be available on PATH.

Environment:

    OPENAI_API_KEY=your_key

Example:

    python visual_scene_segmenter.py voiceover.mp3 script.txt
    python visual_scene_segmenter.py voiceover.mp3 script.txt --preview
    python visual_scene_segmenter.py voiceover.mp3 script.txt --min-duration 5 --max-duration 15
    python visual_scene_segmenter.py voiceover.mp3 script.txt --ai-model gpt-5.4-mini
"""

from __future__ import annotations

import warnings
warnings.filterwarnings("ignore")  # suppress FP16/CPU and other torch/whisper noise

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import difflib
import hashlib
import json
import math
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


# Fail immediately if required packages are missing so we don't waste time
# running whisper for minutes before hitting an import error at the write step.
def _check_deps():
    missing = []
    for pkg, mod in [("openai", "openai"), ("pydantic", "pydantic"),
                     ("xlsxwriter", "xlsxwriter"), ("imageio-ffmpeg", "imageio_ffmpeg")]:
        try:
            __import__(mod)
        except ImportError:
            missing.append(pkg)
    if missing:
        print(f"Error: Missing required packages. Run:\npip install {' '.join(missing)}", flush=True)
        sys.exit(1)

_check_deps()


# FFmpeg discovery: imageio-ffmpeg → winget fallback → system PATH
# imageio-ffmpeg ships a versioned binary (e.g. ffmpeg-win64-v7.1.exe), NOT
# ffmpeg.exe, so we copy it once to a stable location named ffmpeg.exe and
# add that directory to PATH so whisper can find it.
import shutil as _shutil
if not _shutil.which("ffmpeg"):
    try:
        import imageio_ffmpeg as _imageio_ffmpeg
        _ffmpeg_src = Path(_imageio_ffmpeg.get_ffmpeg_exe())
        _ffmpeg_bin = Path(os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))) / "AutoGenStudio" / "bin"
        _ffmpeg_bin.mkdir(parents=True, exist_ok=True)
        _ffmpeg_exe = _ffmpeg_bin / "ffmpeg.exe"
        if not _ffmpeg_exe.exists():
            _shutil.copy2(str(_ffmpeg_src), str(_ffmpeg_exe))
        os.environ["PATH"] = str(_ffmpeg_bin) + os.pathsep + os.environ.get("PATH", "")
    except Exception:
        # Fallback: winget install locations
        _winget_base = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/WinGet/Packages"
        for _candidate in _winget_base.glob("Gyan.FFmpeg_*/*/bin"):
            os.environ["PATH"] = str(_candidate) + os.pathsep + os.environ.get("PATH", "")
            break


SENTENCE_END_RE = re.compile(r'[.!?]+[“\’”’)]*$')
SCRIPT_SENTENCE_RE = re.compile(r'(?<=[.!?])(?:[“\’”’)]*)\s+')
SPACE_BEFORE_PUNCTUATION_RE = re.compile(r"\s+([,.;:!?])")
NORMALIZE_RE = re.compile(r"[^\w\s]", re.UNICODE)

PASS2_BATCH_SIZE = 30
PASS2_CONTEXT = 5
PASS1_BATCH_SIZE = 60
AI_BATCH_WORKERS = 3

TTS_TAG_RE = re.compile(r"<#[\d.]+#>")
PROGRESS_PREFIX = "AUTOGEN_PROGRESS "


def report_progress(percent: int, stage: str, detail: str = "") -> None:
    print(
        PROGRESS_PREFIX
        + json.dumps(
            {
                "percent": max(0, min(100, int(percent))),
                "stage": stage,
                "detail": detail,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


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


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def format_timestamp(seconds: float) -> str:
    total_ms = max(0, int(round(seconds * 1000)))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d}.{milliseconds:03d}"


def normalize_text(text: str) -> str:
    text = text.lower().replace("’", "'")
    text = NORMALIZE_RE.sub(" ", text)
    return re.sub(r"\s+", " ", text).strip()


def clean_joined_words(words: Sequence[str]) -> str:
    text = " ".join(word.strip() for word in words if word.strip())
    text = SPACE_BEFORE_PUNCTUATION_RE.sub(r"\1", text)
    return re.sub(r"\s+", " ", text).strip()


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

        # Handle a paragraph with no conventional punctuation as one sentence.
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


def transcribe_words(
    media_path: Path,
    model_name: str,
    language: str | None,
) -> tuple[list[WhisperWord], str | None]:
    cache_path = media_path.with_suffix(media_path.suffix + ".whisper-words.json")
    media_stat = media_path.stat()
    if cache_path.exists():
        try:
            cache = json.loads(cache_path.read_text(encoding="utf-8"))
            if (
                cache.get("media_size") == media_stat.st_size
                and cache.get("media_mtime_ns") == media_stat.st_mtime_ns
                and cache.get("model") == model_name
                and cache.get("language") == language
            ):
                words = [
                    WhisperWord(
                        word=item["word"],
                        start=float(item["start"]),
                        end=float(item["end"]),
                    )
                    for item in cache.get("words", [])
                ]
                if words:
                    detected_language = cache.get("detected_language")
                    report_progress(
                        48,
                        "Using cached transcription",
                        f"{len(words)} timed words loaded",
                    )
                    return words, detected_language
        except (OSError, ValueError, KeyError, TypeError):
            pass

    try:
        import whisper
        import importlib
        import subprocess
        import tqdm as tqdm_package
    except ImportError:
        print("\nError: openai-whisper is not installed.")
        print("Run: pip install openai-whisper\n")
        sys.exit(1)

    report_progress(8, "Loading Whisper", f"Loading the {model_name} model")
    print(f"\nLoading local Whisper model: {model_name}", flush=True)
    model = whisper.load_model(model_name)

    transcribe_module = importlib.import_module("whisper.transcribe")
    audio_module = importlib.import_module("whisper.audio")
    original_tqdm = transcribe_module.tqdm.tqdm
    original_audio_run = audio_module.run

    class ProgressTqdm(tqdm_package.tqdm):
        def update(self, amount=1):
            displayed = super().update(amount)
            if self.total:
                ratio = min(1.0, self.n / self.total)
                report_progress(
                    18 + round(ratio * 29),
                    "Transcribing narration",
                    f"{round(ratio * 100)}% of audio analyzed",
                )
            return displayed

    def hidden_subprocess_run(*args, **kwargs):
        if os.name == "nt":
            kwargs["creationflags"] = (
                int(kwargs.get("creationflags", 0)) | subprocess.CREATE_NO_WINDOW
            )
        return original_audio_run(*args, **kwargs)

    options: dict = {
        "word_timestamps": True,
        "verbose": False,
        "condition_on_previous_text": True,
    }
    if language:
        options["language"] = language

    report_progress(18, "Transcribing narration", media_path.name)
    print(f"Transcribing: {media_path.name}", flush=True)
    transcribe_module.tqdm.tqdm = ProgressTqdm
    audio_module.run = hidden_subprocess_run
    try:
        result = model.transcribe(str(media_path), **options)
    finally:
        transcribe_module.tqdm.tqdm = original_tqdm
        audio_module.run = original_audio_run

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
    report_progress(
        48,
        "Transcription complete",
        f"{len(words)} timed words"
        + (f" · {detected_language}" if detected_language else ""),
    )
    print(
        f"Transcribed {len(words)} words"
        + (f" | language: {detected_language}" if detected_language else "")
    )
    try:
        cache_path.write_text(
            json.dumps(
                {
                    "media_size": media_stat.st_size,
                    "media_mtime_ns": media_stat.st_mtime_ns,
                    "model": model_name,
                    "language": language,
                    "detected_language": detected_language,
                    "words": [asdict(word) for word in words],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
    except OSError:
        pass
    return words, detected_language


def align_script_to_words(
    script_sentences: list[ScriptSentence],
    whisper_words: list[WhisperWord],
) -> list[TimedSentence]:
    """
    Align authoritative script sentences to Whisper words.

    The method builds one normalized script token sequence and one normalized
    Whisper token sequence, then uses SequenceMatcher anchors to map script
    token positions onto audio token positions. Missing positions are filled
    by monotonic interpolation.
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

    # Ensure no accidental negative or overlapping timing ranges.
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


def get_openai_client():
    try:
        from openai import OpenAI
    except ImportError as error:
        raise RuntimeError(
            "OpenAI is not installed. Run: pip install openai"
        ) from error

    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError(
            "OPENAI_API_KEY is not configured. Add it in Auto Gen Studio settings."
        )

    return OpenAI(timeout=120.0, max_retries=1)


def parse_structured(
    client,
    model: str,
    system_prompt: str,
    user_payload: dict,
    response_model,
):
    """
    Prefer the current Responses API parser. Fall back to the older structured
    Chat Completions parser for compatible openai package versions.
    """
    input_messages = [
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": json.dumps(user_payload, ensure_ascii=False),
        },
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


def analyze_sentences_pass1(
    sentences: list[TimedSentence],
    ai_model: str,
    cache_path: Path | None = None,
):
    try:
        from pydantic import BaseModel, Field
    except ImportError:
        print("\nError: pydantic is not installed.")
        print("Run: pip install pydantic\n")
        sys.exit(1)

    StoryBeat = Literal[
        "hook",
        "setup",
        "development",
        "explanation",
        "conflict",
        "escalation",
        "climax",
        "resolution",
        "lesson",
        "cta",
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

    cache_fingerprint = hashlib.sha256(
        json.dumps(
            {
                "model": ai_model,
                "sentences": [
                    {
                        "id": sentence.sentence_id,
                        "paragraph": sentence.paragraph_id,
                        "start": round(sentence.start, 3),
                        "end": round(sentence.end, 3),
                        "text": sentence.text,
                    }
                    for sentence in sentences
                ],
            },
            ensure_ascii=False,
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    if cache_path and cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            if cached.get("fingerprint") == cache_fingerprint:
                result = Pass1Result.model_validate(cached["result"])
                expected_ids = [sentence.sentence_id for sentence in sentences]
                if [item.sentence_id for item in result.analyses] == expected_ids:
                    report_progress(
                        67,
                        "Using cached visual analysis",
                        f"{len(result.analyses)} sentence analyses loaded",
                    )
                    return result
        except (OSError, ValueError, KeyError, TypeError):
            pass

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

    batches = [
        sentences[index : index + PASS1_BATCH_SIZE]
        for index in range(0, len(sentences), PASS1_BATCH_SIZE)
    ]
    def analyze_batch(batch_number: int, batch: list[TimedSentence]):
        payload = {
            "script_context": {
                "total_sentences": len(sentences),
                "batch_number": batch_number,
                "batch_count": len(batches),
            },
            "sentences": [
                {
                    "sentence_id": sentence.sentence_id,
                    "paragraph_id": sentence.paragraph_id,
                    "start_seconds": round(sentence.start, 3),
                    "end_seconds": round(sentence.end, 3),
                    "duration_seconds": round(sentence.duration, 3),
                    "text": sentence.text,
                }
                for sentence in batch
            ],
        }
        result = parse_structured(
            client=get_openai_client(),
            model=ai_model,
            system_prompt=system_prompt,
            user_payload=payload,
            response_model=Pass1Result,
        )
        expected_batch_ids = [sentence.sentence_id for sentence in batch]
        returned_batch_ids = [item.sentence_id for item in result.analyses]
        if returned_batch_ids != expected_batch_ids:
            raise RuntimeError(
                f"Pass 1 batch {batch_number} coverage is invalid. "
                f"Expected {expected_batch_ids}, received {returned_batch_ids}."
            )
        return batch_number, result

    results: dict[int, Pass1Result] = {}
    completed = 0
    with ThreadPoolExecutor(
        max_workers=min(AI_BATCH_WORKERS, len(batches))
    ) as executor:
        futures = [
            executor.submit(analyze_batch, batch_number, batch)
            for batch_number, batch in enumerate(batches, start=1)
        ]
        for future in as_completed(futures):
            batch_number, batch_result = future.result()
            results[batch_number] = batch_result
            completed += 1
            report_progress(
                58 + round(9 * completed / max(1, len(batches))),
                "Analyzing visual meaning",
                f"{completed} of {len(batches)} batches complete",
            )

    analyses: list[SentenceAnalysis] = []
    for batch_number in range(1, len(batches) + 1):
        analyses.extend(results[batch_number].analyses)
    hook_end_sentence_id = results[1].hook_end_sentence_id

    result = Pass1Result(
        hook_end_sentence_id=hook_end_sentence_id,
        analyses=analyses,
    )

    expected_ids = [sentence.sentence_id for sentence in sentences]
    returned_ids = [item.sentence_id for item in result.analyses]
    if returned_ids != expected_ids:
        raise RuntimeError(
            f"Pass 1 sentence coverage is invalid. Expected {expected_ids}, "
            f"received {returned_ids}."
        )

    if cache_path:
        try:
            cache_path.write_text(
                json.dumps(
                    {
                        "fingerprint": cache_fingerprint,
                        "result": result.model_dump(),
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
        except OSError:
            pass
    return result


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
        "merge",
        "strong_merge",
        "ambiguous",
        "lean_split",
        "split",
        "hard_split",
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

    def score_batch(batch_num: int, batch_start: int):
        context_start = max(0, batch_start - PASS2_CONTEXT)
        batch_end = min(batch_start + PASS2_BATCH_SIZE, len(sentences))
        # Include one extra sentence so the boundary transition is computable.
        chunk_end = min(batch_end + 1, len(sentences))

        chunk_sentences = sentences[context_start:chunk_end]
        chunk_pass1 = _Pass1Slice(
            hook_end_sentence_id=pass1_result.hook_end_sentence_id,
            analyses=pass1_result.analyses[context_start:chunk_end],
        )

        chunk_result = score_boundaries_pass2(
            sentences=chunk_sentences,
            pass1_result=chunk_pass1,
            ai_model=ai_model,
            min_duration=min_duration,
            max_duration=max_duration,
        )
        return batch_num, batch_start, batch_end, chunk_result

    batch_results = []
    completed = 0
    with ThreadPoolExecutor(
        max_workers=min(AI_BATCH_WORKERS, total_batches)
    ) as executor:
        futures = [
            executor.submit(score_batch, batch_num, batch_start)
            for batch_num, batch_start in enumerate(batch_starts, start=1)
        ]
        for future in as_completed(futures):
            batch_results.append(future.result())
            completed += 1
            report_progress(
                68 + round(18 * completed / total_batches),
                "Scoring scene boundaries",
                f"{completed} of {total_batches} batches complete",
            )

    for batch_num, batch_start, batch_end, chunk_result in sorted(batch_results):
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


def transition_map(pass2_result) -> dict[int, object]:
    """
    Key is the sentence ID before the boundary.
    Boundary 3 means transition sentence 3 to sentence 4.
    """
    return {
        item.from_sentence_id: item
        for item in pass2_result.transitions
    }


def normalize_groups(
    sentences: list[TimedSentence],
    pass2_result,
) -> list[VisualGroup]:
    if not sentences:
        return []

    transitions = transition_map(pass2_result)
    proposed_by_start = {
        group.start_sentence_id: group
        for group in pass2_result.groups
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
            hard_before = bool(
                previous_transition and previous_transition.hard_boundary
            )

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


def group_duration(
    group: VisualGroup,
    sentences: list[TimedSentence],
) -> float:
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

            # Prefer highest SBS. If no transition exists, choose duration midpoint.
            best_boundary = max(
                candidate_boundaries,
                key=lambda boundary: (
                    getattr(transitions.get(boundary), "final_sbs", 0),
                    -abs(
                        (
                            sentences[boundary - 1].end
                            - sentences[current.start_sentence_id - 1].start
                        )
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

            # Right side begins at the repaired boundary.
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
                # Fallback: retry without the max_duration constraint.
                # Hard boundaries remain inviolable; a slightly-over-max merged
                # group is preferable to leaving a group below minimum duration.
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
                continue  # Truly isolated by hard boundaries on both sides.

            _, neighbor_index, _ = min(choices, key=lambda item: item[0])

            if neighbor_index < index:
                left = groups[neighbor_index]
                merged = VisualGroup(
                    group_id=0,
                    start_sentence_id=left.start_sentence_id,
                    end_sentence_id=group.end_sentence_id,
                    scene_type=left.scene_type,
                    visual_anchor=left.visual_anchor,
                    scene_description=(
                        left.scene_description + " " + group.scene_description
                    ).strip(),
                    confidence="medium",
                    reason=(
                        "Merged during minimum duration repair across the "
                        "lowest available non hard boundary."
                    ),
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
                    scene_description=(
                        group.scene_description + " " + right.scene_description
                    ).strip(),
                    confidence="medium",
                    reason=(
                        "Merged during minimum duration repair across the "
                        "lowest available non hard boundary."
                    ),
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
        groups=groups,
        sentences=sentences,
        pass2_result=pass2_result,
        max_duration=max_duration,
    )
    groups = merge_short_groups(
        groups=groups,
        sentences=sentences,
        pass2_result=pass2_result,
        min_duration=min_duration,
        max_duration=max_duration,
    )
    # Merging short groups can create a new oversized group. Re-apply the
    # maximum repair so the frontend's upper pacing bound remains authoritative.
    groups = split_oversized_groups(
        groups=groups,
        sentences=sentences,
        pass2_result=pass2_result,
        max_duration=max_duration,
    )
    return groups


def validate_groups(
    groups: list[VisualGroup],
    sentences: list[TimedSentence],
) -> None:
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
    ranges: list[tuple[int, int]] = []
    start_index = 0

    for index, sentence in enumerate(sentences):
        if index == start_index:
            continue
        duration_with_sentence = sentence.end - sentences[start_index].start
        duration_without_sentence = sentences[index - 1].end - sentences[start_index].start
        paragraph_changed = sentence.paragraph_id != sentences[index - 1].paragraph_id

        if duration_with_sentence > max_duration and duration_without_sentence > 0:
            ranges.append((start_index, index - 1))
            start_index = index
        elif paragraph_changed and duration_without_sentence >= min_duration:
            ranges.append((start_index, index - 1))
            start_index = index

    ranges.append((start_index, len(sentences) - 1))

    # Repair a short trailing group by merging it backward when the maximum
    # allows it. Minimum duration is preferred; maximum duration is strict
    # unless one indivisible sentence is itself longer than the maximum.
    if len(ranges) > 1:
        last_start, last_end = ranges[-1]
        last_duration = sentences[last_end].end - sentences[last_start].start
        previous_start, _ = ranges[-2]
        merged_duration = sentences[last_end].end - sentences[previous_start].start
        if last_duration < min_duration and merged_duration <= max_duration:
            ranges[-2] = (previous_start, last_end)
            ranges.pop()

    groups: list[VisualGroup] = []
    for start_index, end_index in ranges:
        included = sentences[start_index : end_index + 1]
        groups.append(
            VisualGroup(
                group_id=len(groups) + 1,
                start_sentence_id=included[0].sentence_id,
                end_sentence_id=included[-1].sentence_id,
                scene_type="still",
                visual_anchor=included[0].text,
                scene_description=" ".join(item.text for item in included),
                confidence="low",
                reason=(
                    f"Whisper-timed fallback using the requested "
                    f"{min_duration:g}-{max_duration:g}s pacing range."
                ),
            )
        )
    return groups


def write_outputs(
    output_xlsx: Path,
    output_json: Path,
    sentences: list[TimedSentence],
    pass1_result,
    pass2_result,
    groups: list[VisualGroup],
) -> None:
    try:
        import xlsxwriter
    except ImportError:
        print("\nError: xlsxwriter is not installed.")
        print("Run: pip install xlsxwriter\n")
        sys.exit(1)

    workbook = xlsxwriter.Workbook(str(output_xlsx))

    header = workbook.add_format(
        {
            "bold": True,
            "bg_color": "#D9EAF7",
            "border": 1,
            "text_wrap": True,
            "valign": "top",
        }
    )
    body = workbook.add_format(
        {
            "border": 1,
            "text_wrap": True,
            "valign": "top",
        }
    )
    decimal = workbook.add_format(
        {
            "border": 1,
            "num_format": "0.000",
            "valign": "top",
        }
    )

    visual_sheet = workbook.add_worksheet("Visual Plan")
    visual_headers = [
        "Group",
        "Start Timestamp",
        "End Timestamp",
        "Duration(s)",
        "Sentence IDs",
        "Sentences",
        "Scene Type",
        "Visual Anchor",
        "Scene Description",
        "Confidence",
        "Reason",
    ]
    visual_sheet.write_row(0, 0, visual_headers, header)

    for row_index, group in enumerate(groups, start=1):
        included = sentences[
            group.start_sentence_id - 1 : group.end_sentence_id
        ]
        start = included[0].start
        end = included[-1].end
        values = [
            group.group_id,
            format_timestamp(start),
            format_timestamp(end),
            end - start,
            f"{group.start_sentence_id}-{group.end_sentence_id}",
            " ".join(item.text for item in included),
            group.scene_type,
            group.visual_anchor,
            group.scene_description,
            group.confidence,
            group.reason,
        ]
        for column, value in enumerate(values):
            visual_sheet.write(
                row_index,
                column,
                value,
                decimal if column == 3 else body,
            )

    visual_sheet.freeze_panes(1, 0)
    visual_sheet.autofilter(0, 0, len(groups), len(visual_headers) - 1)
    visual_sheet.set_column("A:A", 8)
    visual_sheet.set_column("B:C", 16)
    visual_sheet.set_column("D:D", 12)
    visual_sheet.set_column("E:E", 14)
    visual_sheet.set_column("F:F", 70)
    visual_sheet.set_column("G:G", 16)
    visual_sheet.set_column("H:I", 48)
    visual_sheet.set_column("J:J", 12)
    visual_sheet.set_column("K:K", 60)

    sentence_sheet = workbook.add_worksheet("Sentence Analysis")
    sentence_headers = [
        "Sentence ID",
        "Paragraph ID",
        "Start",
        "End",
        "Duration(s)",
        "Text",
        "Visual Anchor",
        "Dominant Subject",
        "Environment",
        "Time Context",
        "Action",
        "Emotion",
        "Story Beat",
        "Visual Density",
        "Narrative Energy",
        "Abstraction Level",
        "Visual Importance",
        "Hard Boundary Before",
        "Hard Boundary Reason",
    ]
    sentence_sheet.write_row(0, 0, sentence_headers, header)

    for row_index, (sentence, analysis) in enumerate(
        zip(sentences, pass1_result.analyses),
        start=1,
    ):
        values = [
            sentence.sentence_id,
            sentence.paragraph_id,
            format_timestamp(sentence.start),
            format_timestamp(sentence.end),
            sentence.duration,
            sentence.text,
            analysis.visual_anchor,
            analysis.dominant_subject,
            analysis.environment,
            analysis.time_context,
            analysis.action,
            analysis.emotion,
            analysis.story_beat,
            analysis.visual_density,
            analysis.narrative_energy,
            analysis.abstraction_level,
            analysis.visual_importance,
            analysis.hard_boundary_before,
            analysis.hard_boundary_reason,
        ]
        for column, value in enumerate(values):
            sentence_sheet.write(
                row_index,
                column,
                value,
                decimal if column == 4 else body,
            )

    sentence_sheet.freeze_panes(1, 0)
    sentence_sheet.autofilter(
        0,
        0,
        len(sentences),
        len(sentence_headers) - 1,
    )
    sentence_sheet.set_column("A:B", 12)
    sentence_sheet.set_column("C:E", 14)
    sentence_sheet.set_column("F:F", 70)
    sentence_sheet.set_column("G:L", 35)
    sentence_sheet.set_column("M:M", 16)
    sentence_sheet.set_column("N:Q", 17)
    sentence_sheet.set_column("R:R", 20)
    sentence_sheet.set_column("S:S", 50)

    transition_sheet = workbook.add_worksheet("Boundary Audit")
    transition_headers = [
        "From",
        "To",
        "Subject",
        "Environment",
        "Time",
        "Action",
        "Emotion",
        "Narrative",
        "Composition",
        "Raw SBS",
        "VRI",
        "VRI Mod",
        "Dominance Mod",
        "Abstraction Mod",
        "Energy Mod",
        "Storyboard Vote",
        "Camera Vote",
        "Editor Vote",
        "Perspective Mod",
        "Confidence Damp",
        "Momentum Mod",
        "Arc Mod",
        "Practicality Mod",
        "Final SBS",
        "Zone",
        "Hard Boundary",
        "Action",
        "Reasoning",
    ]
    transition_sheet.write_row(0, 0, transition_headers, header)

    for row_index, transition in enumerate(pass2_result.transitions, start=1):
        values = [
            transition.from_sentence_id,
            transition.to_sentence_id,
            transition.subject_shift,
            transition.environment_shift,
            transition.temporal_shift,
            transition.action_shift,
            transition.emotional_shift,
            transition.narrative_function_shift,
            transition.visual_composition_shift,
            transition.raw_sbs,
            transition.visual_replaceability_index,
            transition.vri_modifier,
            transition.visual_dominance_modifier,
            transition.abstraction_modifier,
            transition.energy_modifier,
            transition.perspective_votes.storyboard_artist,
            transition.perspective_votes.cinematographer,
            transition.perspective_votes.narrative_editor,
            transition.perspective_modifier,
            transition.confidence_dampener,
            transition.momentum_modifier,
            transition.narrative_arc_modifier,
            transition.image_practicality_modifier,
            transition.final_sbs,
            transition.zone,
            transition.hard_boundary,
            transition.final_action,
            transition.dynamic_reasoning,
        ]
        for column, value in enumerate(values):
            transition_sheet.write(row_index, column, value, body)

    transition_sheet.freeze_panes(1, 0)
    transition_sheet.autofilter(
        0,
        0,
        len(pass2_result.transitions),
        len(transition_headers) - 1,
    )
    transition_sheet.set_column("A:B", 8)
    transition_sheet.set_column("C:O", 13)
    transition_sheet.set_column("P:R", 16)
    transition_sheet.set_column("S:Z", 14)
    transition_sheet.set_column("AA:AA", 70)

    workbook.close()

    payload = {
        "hook_end_sentence_id": pass1_result.hook_end_sentence_id,
        "sentences": [
            {
                **asdict(sentence),
                "duration": sentence.duration,
                "analysis": analysis.model_dump(),
            }
            for sentence, analysis in zip(sentences, pass1_result.analyses)
        ],
        "transitions": [
            transition.model_dump()
            for transition in pass2_result.transitions
        ],
        "groups": [
            {
                **asdict(group),
                "start_timestamp": format_timestamp(
                    sentences[group.start_sentence_id - 1].start
                ),
                "end_timestamp": format_timestamp(
                    sentences[group.end_sentence_id - 1].end
                ),
                "duration": group_duration(group, sentences),
            }
            for group in groups
        ],
    }
    output_json.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def preview_groups(
    groups: list[VisualGroup],
    sentences: list[TimedSentence],
) -> None:
    print("\nVISUAL PLAN")
    print("=" * 120)
    for group in groups:
        included = sentences[
            group.start_sentence_id - 1 : group.end_sentence_id
        ]
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


def run(args: argparse.Namespace) -> None:
    report_progress(
        2,
        "Preparing visual plan",
        f"Validating source files · target {args.min_duration:g}–{args.max_duration:g}s",
    )
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

    output_xlsx = (
        Path(args.output).expanduser().resolve()
        if args.output
        else output_dir / f"{media_path.stem}_visual_plan.xlsx"
    )
    output_json = output_xlsx.with_suffix(".json")

    script_sentences = read_script(script_path)
    print(f"Read {len(script_sentences)} script sentences", flush=True)
    report_progress(
        5,
        "Preparing visual plan",
        f"{len(script_sentences)} script sentences · target {args.min_duration:g}–{args.max_duration:g}s",
    )

    whisper_words, _ = transcribe_words(
        media_path=media_path,
        model_name=args.whisper_model,
        language=args.language,
    )

    sentences = align_script_to_words(
        script_sentences=script_sentences,
        whisper_words=whisper_words,
    )
    print(f"Aligned {len(sentences)} sentences to audio", flush=True)
    report_progress(
        55,
        "Aligning timestamps",
        f"{len(sentences)} sentences aligned to Whisper words",
    )

    try:
        report_progress(58, "Analyzing visual meaning", "AI pass 1 of 2")
        print("\nAI Pass 1: extracting sentence visual metadata", flush=True)
        pass1_result = analyze_sentences_pass1(
            sentences=sentences,
            ai_model=args.ai_model,
            cache_path=output_dir / "visual-plan-pass1-cache.json",
        )

        report_progress(68, "Scoring scene boundaries", "AI pass 2 of 2")
        print("AI Pass 2: scoring scene boundaries and proposing groups", flush=True)
        pass2_result = _batch_score_boundaries_pass2(
            sentences=sentences,
            pass1_result=pass1_result,
            ai_model=args.ai_model,
            min_duration=args.min_duration,
            max_duration=args.max_duration,
        )

        groups = normalize_groups(
            sentences=sentences,
            pass2_result=pass2_result,
        )
        report_progress(
            88,
            "Optimizing scene durations",
            "Applying pacing limits and repairing coverage",
        )
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

        print(f"\nWarning: AI segmentation failed: {exc}", flush=True)
        print("Using emergency duration and paragraph based fallback.", flush=True)
        report_progress(
            82,
            "Using fallback grouping",
            "AI grouping failed; preserving Whisper timestamps",
        )

        # Minimal objects for output consistency.
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
                FallbackAnalysis(
                    sentence_id=sentence.sentence_id,
                    visual_anchor=sentence.text,
                )
                for sentence in sentences
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

    report_progress(94, "Saving visual plan", f"{len(groups)} visual scenes")
    write_outputs(
        output_xlsx=output_xlsx,
        output_json=output_json,
        sentences=sentences,
        pass1_result=pass1_result,
        pass2_result=pass2_result,
        groups=groups,
    )

    print(f"\nExcel plan: {output_xlsx}", flush=True)
    print(f"JSON audit: {output_json}", flush=True)
    report_progress(100, "Visual plan ready", f"{len(groups)} scenes created")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="visual_scene_segmenter",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description=textwrap.dedent(
            """
            Generate an AI assisted visual scene plan from narration audio and
            its authoritative script.

            The system aligns script sentences to Whisper timestamps, performs
            2 AI passes, scores every scene boundary, applies duration repair,
            and exports a visual plan plus full audit information.
            """
        ),
        epilog=textwrap.dedent(
            """
            Examples:

              python visual_scene_segmenter.py voiceover.mp3 script.txt

              python visual_scene_segmenter.py voiceover.mp3 script.txt \
                --min-duration 5 --max-duration 15 --preview

              python visual_scene_segmenter.py video.mp4 script.txt \
                --whisper-model medium --language en
            """
        ),
    )

    parser.add_argument("media", help="Path to the audio or video file")
    parser.add_argument("script", help="Path to the matching UTF-8 script file")
    parser.add_argument(
        "--whisper-model",
        default="base",
        choices=[
            "tiny",
            "base",
            "small",
            "medium",
            "large",
            "large-v2",
            "large-v3",
        ],
        help="Local Whisper model. Default: base",
    )
    parser.add_argument(
        "--ai-model",
        default="gpt-5.4-mini",
        help="OpenAI model used for both analysis passes",
    )
    parser.add_argument(
        "--language",
        default=None,
        help="Optional Whisper language code, such as en or ur",
    )
    parser.add_argument(
        "--min-duration",
        type=float,
        default=5.0,
        metavar="SECONDS",
        help="Preferred minimum still duration. Default: 5",
    )
    parser.add_argument(
        "--max-duration",
        type=float,
        default=12.0,
        metavar="SECONDS",
        help="Maximum still duration. Default: 15",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        metavar="DIR",
        help="Output folder. Default: media file folder",
    )
    parser.add_argument(
        "--output",
        default=None,
        metavar="FILE.xlsx",
        help="Exact Excel output path",
    )
    parser.add_argument(
        "--preview",
        action="store_true",
        help="Print final visual groups in the terminal",
    )
    parser.add_argument(
        "--fallback-on-ai-error",
        action="store_true",
        help="Use a duration and paragraph fallback if an AI call fails",
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
