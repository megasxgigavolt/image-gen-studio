import pytest

from auto_gen_engine.visual_plan import (
    EngineDependencyError,
    build_plan,
    split_script,
    transcribe_words,
)


def test_splits_script_and_builds_contiguous_groups():
    script = "The ocean darkens. Lanternfish begin to glow. Predators wait below."
    result = build_plan(script, target_seconds=5, duration=18)

    assert split_script(script) == [
        "The ocean darkens.",
        "Lanternfish begin to glow.",
        "Predators wait below.",
    ]
    assert result["sentences"][0]["start"] == 0
    assert result["sentences"][-1]["end"] == 18
    assert [item for group in result["groups"] for item in group["sentenceIds"]] == [
        "s1", "s2", "s3"
    ]


def test_whisper_dependency_error_is_actionable(monkeypatch):
    monkeypatch.setitem(__import__("sys").modules, "whisper", None)
    with pytest.raises(EngineDependencyError, match="whisper"):
        transcribe_words("missing.wav")


def test_tts_pause_tags_are_hidden_but_extend_timing():
    script = "The ocean darkens. <#0.5#> Lanternfish glow."
    result = build_plan(script, target_seconds=5, duration=10)
    assert split_script(script) == ["The ocean darkens.", "Lanternfish glow."]
    assert result["sentences"][-1]["end"] == 10.5
