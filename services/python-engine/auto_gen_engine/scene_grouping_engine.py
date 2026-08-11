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
   Strength scoring and builds visual groups (stills). Duration/pacing is
   NOT part of this decision — see 5 below.
5. Deterministic validation and duration optimization repair coverage,
   ordering, minimum duration, and maximum duration.
6. Scenes (a coarser partition of the same sentences, one or more stills
   each) are derived from Pass 2's own narrative_scene_boundary transitions
   (a dedicated, explicitly-scoped field — see score_boundaries_pass2's
   NARRATIVE SCENE BOUNDARY prompt section), then AI Pass 3 summarizes each
   scene's narrative content.
7. Excel and JSON audit files are exported.

Provider order for all three AI passes: a locally logged-in Claude Code CLI
is tried first (see `ai_client.parse_structured_with_fallback`) — it rides an
existing Claude subscription instead of a metered API key, so this is the
only provider with no per-call cost. OpenAI is the fallback if the CLI isn't
installed/logged in or its call fails. Same order motion_graphics_engine.py
uses for its vision passes.

Install:

    pip install openai-whisper openai pydantic python-dotenv xlsxwriter

FFmpeg must be available on PATH.

Environment (only needed as a fallback — see provider order above):

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
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Literal, Sequence

from ai_client import parse_structured_with_fallback

try:
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass


# Check required packages. If any are missing, auto-install them using the
# exact Python that's running this script (sys.executable) so we always
# install to the right environment regardless of how Python was set up.
# whisper is excluded here — it's a large optional install handled by setup.
def _check_deps():
    import subprocess as _sp
    _required = [("openai", "openai"), ("pydantic", "pydantic"),
                 ("xlsxwriter", "xlsxwriter"), ("imageio-ffmpeg", "imageio_ffmpeg"),
                 ("opencv-python-headless", "cv2")]
    missing = []
    for pkg, mod in _required:
        try:
            __import__(mod)
        except ImportError:
            missing.append(pkg)
    if missing:
        print(f"Auto-installing missing packages: {' '.join(missing)}", flush=True)
        result = _sp.run(
            [sys.executable, "-m", "pip", "install", "--quiet"] + missing,
            capture_output=True, text=True
        )
        if result.returncode != 0:
            print(f"Error: Could not install required packages.\nRun manually: pip install {' '.join(missing)}", flush=True)
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
PASS3_BATCH_SIZE = 25
AI_BATCH_WORKERS = 3

TTS_TAG_RE = re.compile(r"<#[\d.]+#>")
PROGRESS_PREFIX = "AUTOGEN_PROGRESS "

# Shared story-beat vocabulary: Pass 1 tags every sentence with one of these,
# Pass 3 tags every scene with one of these too, so a scene's narrative role
# and its member sentences' story beats are always drawn from the same set.
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


@dataclass(frozen=True)
class VisualScene:
    """
    A larger narrative/visual unit that can span several VisualGroups
    (stills). Boundaries come from normalize_scenes (Pass 2's hard_boundary
    transitions only); the context fields below are filled in afterward by
    analyze_scene_context (Pass 3) and are empty until then.
    """

    scene_id: int
    start_sentence_id: int
    end_sentence_id: int
    title: str = ""
    narrative_role: str = ""
    core_idea: str = ""
    emotional_state: str = ""
    visual_opportunities: list[str] = field(default_factory=list)


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
        result = parse_structured_with_fallback(
            system_prompt=system_prompt,
            user_payload=payload,
            response_model=Pass1Result,
            ai_model=ai_model,
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

        # Independent of every still-level score above — see the NARRATIVE
        # SCENE BOUNDARY prompt section. A still boundary (zone/final_action)
        # fires on almost every transition; this must fire rarely, only at
        # genuine scene changes, or the whole video collapses into one scene.
        narrative_scene_boundary: bool
        narrative_scene_boundary_reason: str

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

    system_prompt = """
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

NARRATIVE SCENE BOUNDARY

Separate from every score above, and from the still (zone/final_action)
decision for this same transition. A SCENE is a much larger unit than a
still: it is the narrative/visual unit the stills above live inside, and a
typical video should contain several scenes, each usually made of several
stills.

Decide narrative_scene_boundary independently of zone/final_action. Set it
true only when sentence B begins a genuinely new scene, meaning at least one
of:

1. The dominant subject changes to a different subject, not a continuation,
   elaboration, or different angle on the same subject.
2. The environment or setting changes to a different physical or conceptual
   place.
3. A real time jump occurs, not "a moment later."
4. Sentence B opens a new numbered item, reason, step, or section, such as
   "Number 9," "Reason 8," "The next step is," or "Here's why."
5. The topic or argument itself moves on, not just the story beat. A story
   beat changing on the exact same topic is not enough by itself.

A hard_boundary transition is always also a narrative_scene_boundary. The
reverse is not required: a new scene does not need a visual hard cut.

Most transitions are still boundaries only, inside the same scene. Expect a
new scene roughly every several stills in a typical video, not one per still
and not only a single scene for the whole video. Set
narrative_scene_boundary_reason to a short phrase, such as "new countdown
item," "same topic continues," or "location moves from office to street."

NARRATIVE COMPRESSION

Count visual ideas, not sentences. Several sentences describing the same
subject, event, mechanism, or emotional moment may share one image.

Make every boundary decision on visual/narrative grounds alone. Duration and
pacing are handled entirely by a separate deterministic pass downstream — do
not merge or split anything because of how long a group would run.

OUTPUT REQUIREMENTS

1. Return exactly one transition for each consecutive sentence pair.
2. Return contiguous groups covering every sentence exactly once.
3. Groups must appear in sentence order.
4. Never cross a hard boundary.
5. Use sentence metadata from Pass 1 as evidence.
6. Scene descriptions must describe one practical still image.
7. narrative_scene_boundary must be true somewhere in a typical video unless
   the whole video is genuinely one continuous scene — do not leave it false
   for every single transition by default.
"""

    payload = {
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

    result = parse_structured_with_fallback(
        system_prompt=system_prompt,
        user_payload=payload,
        response_model=Pass2Result,
        ai_model=ai_model,
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


def build_ranges_from_boundaries(
    sentences: list[TimedSentence],
    boundary_ids: set[int],
) -> list[tuple[int, int]]:
    """
    Turns a set of "a group/scene closes right after this sentence id" ids
    into contiguous (start_sentence_id, end_sentence_id) ranges covering
    every sentence exactly once. Shared by normalize_groups (still
    boundaries: every split or hard boundary) and normalize_scenes (the
    strictly coarser hard-boundary-only partition) so the two levels can
    never disagree about where a range starts or ends.
    """
    if not sentences:
        return []

    ranges: list[tuple[int, int]] = []
    start_id = sentences[0].sentence_id
    final_id = sentences[-1].sentence_id

    for sentence_id in range(start_id, final_id + 1):
        closes_here = sentence_id in boundary_ids or sentence_id == final_id
        if not closes_here:
            continue
        ranges.append((start_id, sentence_id))
        start_id = sentence_id + 1

    return ranges


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

    # narrative_scene_boundary is included here too (not just in
    # normalize_scenes) so a still boundary always exists wherever a scene
    # boundary does — otherwise a still could straddle two scenes.
    boundaries = {
        transition.from_sentence_id
        for transition in pass2_result.transitions
        if transition.final_action == "split"
        or transition.hard_boundary
        or transition.narrative_scene_boundary
    }

    groups: list[VisualGroup] = []
    for start_id, sentence_id in build_ranges_from_boundaries(sentences, boundaries):
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

    return groups


def normalize_scenes(
    sentences: list[TimedSentence],
    pass2_result,
) -> list["VisualScene"]:
    """
    The coarser partition: a scene boundary is a transition Pass 2 explicitly
    flagged narrative_scene_boundary (see that field's prompt section — a
    genuinely new subject/location/time/topic, not just a new still), or
    hard_boundary as a safety net (a visual hard cut is always also a scene
    change even if the model forgot to also flag narrative_scene_boundary).
    normalize_groups includes the same two fields in its own boundary set, so
    every scene boundary is guaranteed to also be a still boundary — a still
    can never straddle two scenes.
    """
    if not sentences:
        return []

    boundaries = {
        transition.from_sentence_id
        for transition in pass2_result.transitions
        if transition.narrative_scene_boundary or transition.hard_boundary
    }

    return [
        VisualScene(scene_id=index, start_sentence_id=start_id, end_sentence_id=end_id)
        for index, (start_id, end_id) in enumerate(
            build_ranges_from_boundaries(sentences, boundaries), start=1
        )
    ]


def analyze_scene_context(
    sentences: list[TimedSentence],
    pass1_result,
    scenes: list[VisualScene],
    ai_model: str,
) -> list[VisualScene]:
    """
    Pass 3: boundaries are already decided (normalize_scenes) — this only
    summarizes what each scene is about, for a storyboard artist who will
    illustrate it as several still images. Uses each scene's member
    sentences and their Pass 1 analyses as evidence, the same evidence
    Pass 2 already sees.
    """
    if not scenes:
        return []

    try:
        from pydantic import BaseModel
    except ImportError:
        print("\nError: pydantic is not installed.")
        print("Run: pip install pydantic\n")
        sys.exit(1)

    class SceneAnalysis(BaseModel):
        scene_id: int
        title: str
        narrative_role: StoryBeat
        core_idea: str
        emotional_state: str
        visual_opportunities: list[str]

    class Pass3Result(BaseModel):
        analyses: list[SceneAnalysis]

    system_prompt = """
You are Pass 3 of an advanced visual scene segmentation engine for faceless
YouTube video production.

Scene boundaries have already been decided. Your only job is to summarize
what each scene is about, for a storyboard artist who will illustrate it as
several still images.

For every scene, read its member sentences and their Pass 1 analyses (the
dominant subject, environment, emotion, and story beat already extracted for
each sentence), then produce:

Title:
A short, human-readable label for the scene, 3 to 8 words, specific enough to
tell this scene apart from its neighbors.

Narrative role:
hook, setup, development, explanation, conflict, escalation, climax,
resolution, lesson, or cta - whichever single story beat this scene is
primarily doing.

Core idea:
One sentence naming the single idea, situation, event, argument, or story
beat this scene expresses.

Emotional state:
The dominant emotional tone of the scene, 1 to 4 words.

Visual opportunities:
2 to 5 short phrases naming concrete or conceptual visuals this scene could
be illustrated with across its stills. These are options for a downstream
visual director, not a shot list - do not number them or tie them to
specific sentences.

Return exactly one analysis for every supplied scene ID.
"""

    batches = [
        scenes[index : index + PASS3_BATCH_SIZE]
        for index in range(0, len(scenes), PASS3_BATCH_SIZE)
    ]

    def analyze_batch(batch_number: int, batch: list[VisualScene]):
        payload = {
            "script_context": {
                "total_scenes": len(scenes),
                "batch_number": batch_number,
                "batch_count": len(batches),
            },
            "scenes": [
                {
                    "scene_id": scene.scene_id,
                    "sentences": [
                        {
                            "sentence_id": sentence.sentence_id,
                            "text": sentence.text,
                            "analysis": pass1_result.analyses[sentence.sentence_id - 1].model_dump(),
                        }
                        for sentence in sentences[scene.start_sentence_id - 1 : scene.end_sentence_id]
                    ],
                }
                for scene in batch
            ],
        }
        result = parse_structured_with_fallback(
            system_prompt=system_prompt,
            user_payload=payload,
            response_model=Pass3Result,
            ai_model=ai_model,
        )
        expected_batch_ids = [scene.scene_id for scene in batch]
        returned_batch_ids = [item.scene_id for item in result.analyses]
        if returned_batch_ids != expected_batch_ids:
            raise RuntimeError(
                f"Pass 3 batch {batch_number} coverage is invalid. "
                f"Expected {expected_batch_ids}, received {returned_batch_ids}."
            )
        return batch_number, result

    results: dict[int, Pass3Result] = {}
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
                95 + round(4 * completed / max(1, len(batches))),
                "Summarizing scenes",
                f"{completed} of {len(batches)} batches complete",
            )

    analyses: dict[int, SceneAnalysis] = {}
    for batch_number in range(1, len(batches) + 1):
        for analysis in results[batch_number].analyses:
            analyses[analysis.scene_id] = analysis

    expected_ids = [scene.scene_id for scene in scenes]
    if sorted(analyses.keys()) != sorted(expected_ids):
        raise RuntimeError(
            f"Pass 3 scene coverage is invalid. Expected {expected_ids}, "
            f"received {sorted(analyses.keys())}."
        )

    return [
        replace(
            scene,
            title=analyses[scene.scene_id].title,
            narrative_role=analyses[scene.scene_id].narrative_role,
            core_idea=analyses[scene.scene_id].core_idea,
            emotional_state=analyses[scene.scene_id].emotional_state,
            visual_opportunities=list(analyses[scene.scene_id].visual_opportunities),
        )
        for scene in scenes
    ]


def group_duration(
    group: VisualGroup,
    sentences: list[TimedSentence],
) -> float:
    start = sentences[group.start_sentence_id - 1].start
    end = sentences[group.end_sentence_id - 1].end
    return max(0.0, end - start)


def scene_duration(
    scene: VisualScene,
    sentences: list[TimedSentence],
) -> float:
    start = sentences[scene.start_sentence_id - 1].start
    end = sentences[scene.end_sentence_id - 1].end
    return max(0.0, end - start)


def scene_for_sentence(sentence_id: int, scenes: list[VisualScene]) -> VisualScene | None:
    """The scene whose sentence range contains this sentence id, if any.
    Every still's group.start_sentence_id is looked up this way to assign
    that still its scene_id — safe because scene ranges are a coarser,
    non-overlapping partition of the same sentence sequence groups use."""
    for scene in scenes:
        if scene.start_sentence_id <= sentence_id <= scene.end_sentence_id:
            return scene
    return None


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


def paragraph_scenes(sentences: list[TimedSentence]) -> list[VisualScene]:
    """
    A cheap, AI-free scene partition used by the per-sentence pacing mode and
    the AI-error fallback path, neither of which has Pass 1/2 data available
    to derive a hard_boundary set from: one scene per paragraph, matching how
    paragraph breaks are already treated elsewhere as a real structural
    signal. Context fields (title, narrative_role, etc.) are left empty — the
    UI shows a "no detailed scene analysis available" note for these instead
    of an extra AI call these modes explicitly exist to avoid.
    """
    if not sentences:
        return []

    boundaries: set[int] = set()
    for previous, current in zip(sentences, sentences[1:]):
        if current.paragraph_id != previous.paragraph_id:
            boundaries.add(previous.sentence_id)

    return [
        VisualScene(scene_id=index, start_sentence_id=start_id, end_sentence_id=end_id)
        for index, (start_id, end_id) in enumerate(
            build_ranges_from_boundaries(sentences, boundaries), start=1
        )
    ]


def per_sentence_grouping(sentences: list[TimedSentence]) -> list[VisualGroup]:
    """One VisualGroup per sentence, no AI calls and no duration merging —
    the literal "every sentence becomes its own still" pacing mode. Modeled
    on heuristic_fallback's group-construction shape, just without any of
    its range-building logic."""
    return [
        VisualGroup(
            group_id=index + 1,
            start_sentence_id=sentence.sentence_id,
            end_sentence_id=sentence.sentence_id,
            scene_type="still",
            visual_anchor=sentence.text,
            scene_description=sentence.text,
            confidence="low",
            reason="Per-sentence pacing: every sentence is its own still by request.",
        )
        for index, sentence in enumerate(sentences)
    ]


def write_outputs(
    output_xlsx: Path,
    output_json: Path,
    sentences: list[TimedSentence],
    pass1_result,
    pass2_result,
    groups: list[VisualGroup],
    scenes: list[VisualScene],
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
        "Scene Boundary",
        "Scene Boundary Reason",
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
            transition.narrative_scene_boundary,
            transition.narrative_scene_boundary_reason,
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
    transition_sheet.set_column("AC:AC", 14)
    transition_sheet.set_column("AD:AD", 45)

    scene_sheet = workbook.add_worksheet("Scenes")
    scene_headers = [
        "Scene",
        "Start Timestamp",
        "End Timestamp",
        "Duration(s)",
        "Sentence IDs",
        "Title",
        "Narrative Role",
        "Core Idea",
        "Emotional State",
        "Visual Opportunities",
    ]
    scene_sheet.write_row(0, 0, scene_headers, header)

    for row_index, scene in enumerate(scenes, start=1):
        start = sentences[scene.start_sentence_id - 1].start
        end = sentences[scene.end_sentence_id - 1].end
        values = [
            scene.scene_id,
            format_timestamp(start),
            format_timestamp(end),
            end - start,
            f"{scene.start_sentence_id}-{scene.end_sentence_id}",
            scene.title,
            scene.narrative_role,
            scene.core_idea,
            scene.emotional_state,
            ", ".join(scene.visual_opportunities),
        ]
        for column, value in enumerate(values):
            scene_sheet.write(
                row_index,
                column,
                value,
                decimal if column == 3 else body,
            )

    scene_sheet.freeze_panes(1, 0)
    scene_sheet.autofilter(0, 0, len(scenes), len(scene_headers) - 1)
    scene_sheet.set_column("A:A", 8)
    scene_sheet.set_column("B:C", 16)
    scene_sheet.set_column("D:D", 12)
    scene_sheet.set_column("E:E", 14)
    scene_sheet.set_column("F:F", 30)
    scene_sheet.set_column("G:G", 16)
    scene_sheet.set_column("H:J", 45)

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
                "scene_id": (
                    scene_for_sentence(group.start_sentence_id, scenes).scene_id
                    if scene_for_sentence(group.start_sentence_id, scenes)
                    else None
                ),
            }
            for group in groups
        ],
        "scenes": [
            {
                **asdict(scene),
                "start_timestamp": format_timestamp(
                    sentences[scene.start_sentence_id - 1].start
                ),
                "end_timestamp": format_timestamp(
                    sentences[scene.end_sentence_id - 1].end
                ),
                "duration": scene_duration(scene, sentences),
            }
            for scene in scenes
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


def detect_subject_point(image_path: str) -> tuple[float, float]:
    """Automatically locates the visual "subject" of a still, for anchoring
    subject-aware Ken Burns zoom presets. Returns (x, y) as fractions (0-1)
    of the image's width/height. Frontal-face detection (fast, offline,
    ships with opencv's own data files) is tried first since faces are the
    most reliable subject signal; when none is found, falls back to the
    centroid of the image's strongest edge-energy region (a cheap proxy for
    "the visually busiest part of the frame", without a second ML
    dependency). Never raises — any failure degrades to frame-center (0.5,
    0.5), which is exactly today's fixed-center behavior."""
    import cv2
    import numpy as np

    image = cv2.imread(image_path)
    if image is None:
        return (0.5, 0.5)
    height, width = image.shape[:2]
    if width <= 0 or height <= 0:
        return (0.5, 0.5)

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    cascade_path = os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml")
    cascade = cv2.CascadeClassifier(cascade_path)
    faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(int(width * 0.05), int(height * 0.05)))
    if len(faces) > 0:
        fx, fy, fw, fh = max(faces, key=lambda f: f[2] * f[3])
        return (clamp((fx + fw / 2) / width, 0.0, 1.0), clamp((fy + fh / 2) / height, 0.0, 1.0))

    edges = np.abs(cv2.Laplacian(gray, cv2.CV_32F))
    threshold = np.percentile(edges, 85)
    mask = edges >= threshold
    if not mask.any():
        return (0.5, 0.5)
    ys, xs = np.nonzero(mask)
    weights = edges[ys, xs]
    cx = float(np.average(xs, weights=weights))
    cy = float(np.average(ys, weights=weights))
    return (clamp(cx / width, 0.0, 1.0), clamp(cy / height, 0.0, 1.0))


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

    if args.per_sentence:
        print("\nPer-sentence pacing requested — skipping AI grouping entirely.", flush=True)
        report_progress(70, "Building per-sentence plan", f"{len(sentences)} stills (1 per sentence)")

        # Minimal objects for output consistency, matching the AI-error
        # fallback branch below's shape (write_outputs expects these).
        # analyses must have one entry per sentence — write_outputs and the
        # JSON audit payload both zip(sentences, pass1_result.analyses), so
        # a short/empty analyses list silently drops sentences from the
        # audit JSON that the Rust side reads back.
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
            hard_boundary_reason: str = "Per-sentence pacing"

        class FallbackPass1(BaseModel):
            hook_end_sentence_id: int = 1
            analyses: list[FallbackAnalysis] = []

        class FallbackPass2(BaseModel):
            transitions: list = []

        pass1_result = FallbackPass1(
            analyses=[
                FallbackAnalysis(
                    sentence_id=sentence.sentence_id,
                    visual_anchor=sentence.text,
                )
                for sentence in sentences
            ],
        )
        pass2_result = FallbackPass2()
        groups = per_sentence_grouping(sentences)
        validate_groups(groups, sentences)
        scenes = paragraph_scenes(sentences)

    else:
        try:
            report_progress(58, "Analyzing visual meaning", "AI pass 1 of 3")
            print("\nAI Pass 1: extracting sentence visual metadata", flush=True)
            pass1_result = analyze_sentences_pass1(
                sentences=sentences,
                ai_model=args.ai_model,
                cache_path=output_dir / "visual-plan-pass1-cache.json",
            )

            report_progress(68, "Scoring scene boundaries", "AI pass 2 of 3")
            print("AI Pass 2: scoring scene boundaries and proposing groups", flush=True)
            pass2_result = _batch_score_boundaries_pass2(
                sentences=sentences,
                pass1_result=pass1_result,
                ai_model=args.ai_model,
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

            report_progress(92, "Summarizing scenes", "AI pass 3 of 3")
            print("AI Pass 3: summarizing scene context", flush=True)
            scenes = normalize_scenes(sentences=sentences, pass2_result=pass2_result)
            scenes = analyze_scene_context(
                sentences=sentences,
                pass1_result=pass1_result,
                scenes=scenes,
                ai_model=args.ai_model,
            )

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
            scenes = paragraph_scenes(sentences)

    if args.preview:
        preview_groups(groups, sentences)

    report_progress(94, "Saving visual plan", f"{len(groups)} stills across {len(scenes)} scenes")
    write_outputs(
        output_xlsx=output_xlsx,
        output_json=output_json,
        sentences=sentences,
        pass1_result=pass1_result,
        pass2_result=pass2_result,
        groups=groups,
        scenes=scenes,
    )

    print(f"\nExcel plan: {output_xlsx}", flush=True)
    print(f"JSON audit: {output_json}", flush=True)
    report_progress(100, "Visual plan ready", f"{len(groups)} stills across {len(scenes)} scenes")


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
    parser.add_argument(
        "--per-sentence",
        action="store_true",
        help="Skip AI grouping entirely; every sentence becomes its own still",
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
