from __future__ import annotations

import difflib
import re
from dataclasses import asdict, dataclass

SENTENCE_SPLIT_RE = re.compile(r'(?<=[.!?])(?:[”’"\')\]]*)\s+')
NORMALIZE_RE = re.compile(r"[^\w\s]", re.UNICODE)
TTS_TAG_RE = re.compile(r"<#[\d.]+#>")


@dataclass(frozen=True)
class WordTiming:
    word: str
    start: float
    end: float


@dataclass(frozen=True)
class TimedSentence:
    id: str
    ordinal: int
    text: str
    start: float
    end: float


class EngineDependencyError(RuntimeError):
    pass


def split_script(script: str) -> list[str]:
    cleaned = TTS_TAG_RE.sub("", script).strip()
    if not cleaned:
        raise ValueError("Script is empty.")
    paragraphs = [part.strip() for part in re.split(r"\n\s*\n", cleaned) if part.strip()]
    sentences: list[str] = []
    for paragraph in paragraphs:
        compact = re.sub(r"\s+", " ", paragraph)
        sentences.extend(part.strip() for part in SENTENCE_SPLIT_RE.split(compact) if part.strip())
    return sentences


def tts_pause_seconds(script: str) -> float:
    return sum(float(value) for value in re.findall(r"<#([\d.]+)#>", script))


def normalize(text: str) -> list[str]:
    return NORMALIZE_RE.sub(" ", text.lower().replace("’", "'")).split()


def align_sentences(script: str, words: list[WordTiming]) -> list[TimedSentence]:
    sentence_texts = split_script(script)
    script_tokens: list[str] = []
    ranges: list[tuple[int, int]] = []
    for text in sentence_texts:
        tokens = normalize(text) or ["empty"]
        start = len(script_tokens)
        script_tokens.extend(tokens)
        ranges.append((start, len(script_tokens) - 1))

    if not words:
        return estimate_sentence_timings(script, max(1.0, len(script_tokens) * 0.4))

    whisper_tokens = [" ".join(normalize(word.word)) or "empty" for word in words]
    matcher = difflib.SequenceMatcher(a=script_tokens, b=whisper_tokens, autojunk=False)
    mapped: dict[int, int] = {}
    for block in matcher.get_matching_blocks():
        for offset in range(block.size):
            mapped[block.a + offset] = block.b + offset

    anchors = sorted(mapped)
    for index in range(len(script_tokens)):
        if index in mapped:
            continue
        before = max((anchor for anchor in anchors if anchor < index), default=None)
        after = min((anchor for anchor in anchors if anchor > index), default=None)
        if before is None:
            mapped[index] = 0
        elif after is None:
            mapped[index] = len(words) - 1
        else:
            ratio = (index - before) / (after - before)
            mapped[index] = round(mapped[before] + ratio * (mapped[after] - mapped[before]))

    result: list[TimedSentence] = []
    for ordinal, (text, (first, last)) in enumerate(zip(sentence_texts, ranges), start=1):
        start_word = words[max(0, min(mapped[first], len(words) - 1))]
        end_word = words[max(0, min(mapped[last], len(words) - 1))]
        result.append(TimedSentence(f"s{ordinal}", ordinal, text, start_word.start, end_word.end))
    return result


def estimate_sentence_timings(script: str, duration: float) -> list[TimedSentence]:
    texts = split_script(script)
    duration += tts_pause_seconds(script)
    weights = [max(1, len(normalize(text))) for text in texts]
    total = sum(weights)
    cursor = 0.0
    result: list[TimedSentence] = []
    for ordinal, (text, weight) in enumerate(zip(texts, weights), start=1):
        end = duration if ordinal == len(texts) else cursor + duration * weight / total
        result.append(TimedSentence(f"s{ordinal}", ordinal, text, cursor, end))
        cursor = end
    return result


def group_sentences(sentences: list[TimedSentence], target_seconds: float = 8.0) -> list[dict]:
    groups: list[dict] = []
    pending: list[TimedSentence] = []
    for sentence in sentences:
        pending.append(sentence)
        duration = pending[-1].end - pending[0].start
        if duration >= target_seconds:
            groups.append(_group(len(groups) + 1, pending))
            pending = []
    if pending:
        if groups and pending[-1].end - pending[0].start < target_seconds * 0.45:
            groups[-1]["sentenceIds"].extend(sentence.id for sentence in pending)
            groups[-1]["end"] = pending[-1].end
        else:
            groups.append(_group(len(groups) + 1, pending))
    return groups


def _group(ordinal: int, sentences: list[TimedSentence]) -> dict:
    return {
        "id": f"g{ordinal}",
        "ordinal": ordinal,
        "label": f"Scene {ordinal}",
        "kind": "establishing" if ordinal == 1 else "subject",
        "sentenceIds": [sentence.id for sentence in sentences],
        "start": sentences[0].start,
        "end": sentences[-1].end,
    }


def build_plan(script: str, target_seconds: float, duration: float | None = None) -> dict:
    sentences = estimate_sentence_timings(
        script,
        duration if duration and duration > 0 else max(1.0, len(normalize(script)) * 0.4),
    )
    return {
        "sentences": [asdict(sentence) for sentence in sentences],
        "groups": group_sentences(sentences, target_seconds),
        "timingSource": "estimated",
    }


def transcribe_words(media_path: str, model_name: str = "base") -> list[WordTiming]:
    try:
        import whisper
    except ImportError as error:
        raise EngineDependencyError(
            "Local Whisper is not installed. Install the engine 'whisper' extra."
        ) from error
    model = whisper.load_model(model_name, device="cpu")
    result = model.transcribe(
        media_path,
        word_timestamps=True,
        verbose=False,
        fp16=False,
    )
    words = [
        WordTiming(str(item["word"]).strip(), float(item["start"]), float(item["end"]))
        for segment in result.get("segments", [])
        for item in segment.get("words", [])
        if str(item.get("word", "")).strip()
    ]
    if not words:
        raise RuntimeError("Whisper returned no word timestamps.")
    return words
