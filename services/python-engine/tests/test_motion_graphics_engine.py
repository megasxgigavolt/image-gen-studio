"""
motion_graphics_engine.py is invoked as a standalone script (its own
directory added to sys.path at run time by Python, matching how
video_export_engine.py already imports scene_grouping_engine.py flatly) —
tests import it the same way rather than as a dotted `auto_gen_engine.*`
package submodule, both to exercise the real production import shape and
because scene_grouping_engine.py (which it imports for report_progress) runs
dependency/ffmpeg discovery at module import time that only behaves
correctly when its own directory is on sys.path, not when loaded as a
package submodule.
"""

import json
import sys
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).parents[1] / "auto_gen_engine"
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

import motion_graphics_engine as mg  # noqa: E402


def _analysis(clip_id: str, effect: str, **fields) -> mg.ClipMotionAnalysis:
    return mg.ClipMotionAnalysis(clip_id=clip_id, effect=effect, reason="test", **fields)


def test_settings_from_analysis_ken_burns_fills_defaults_when_model_omits_fields():
    analysis = _analysis("c1", "Ken Burns")
    settings = mg.settings_from_analysis(analysis)
    assert settings == {"scaleFrom": 1.08, "scaleTo": 1.28, "panX": -4.0, "panY": 2.0}


def test_settings_from_analysis_uses_model_provided_values_when_present():
    analysis = _analysis("c1", "Speed Pan & Motion Blur", scale_from=1.2, scale_to=1.35, pan_x_from=10.0, pan_x_to=-5.0)
    settings = mg.settings_from_analysis(analysis)
    assert settings == {"scaleFrom": 1.2, "scaleTo": 1.35, "panXFrom": 10.0, "panXTo": -5.0}


def test_settings_from_analysis_sequential_panel_reveal_serializes_panels():
    analysis = _analysis(
        "c1",
        "Sequential Panel Reveal",
        hold_start_frames=15.0,
        crop_padding=1.1,
        panels=[mg.PanelRect(x=0.0, y=0.0, w=0.5, h=0.5), mg.PanelRect(x=0.5, y=0.0, w=0.5, h=0.5)],
    )
    settings = mg.settings_from_analysis(analysis)
    assert settings["panels"] == [
        {"x": 0.0, "y": 0.0, "w": 0.5, "h": 0.5},
        {"x": 0.5, "y": 0.0, "w": 0.5, "h": 0.5},
    ]


def test_settings_from_analysis_covers_every_catalog_effect():
    for effect in mg.EFFECT_NAMES:
        settings = mg.settings_from_analysis(_analysis("c1", effect))
        assert isinstance(settings, dict) and len(settings) > 0


def test_diversity_context_reflects_prior_tally():
    tally = {name: 0 for name in mg.EFFECT_NAMES}
    tally["Ken Burns"] = 3
    context = mg._prior_context(tally, ["Ken Burns", "Ken Burns", "Ken Burns"])
    assert "Ken Burns: 3" in context
    assert "Ken Burns, Ken Burns, Ken Burns" in context


def test_run_batches_clips_and_carries_tally_across_batches(tmp_path, monkeypatch):
    """End-to-end through `run()` with the OpenAI call stubbed out — proves
    manifest parsing, batching (batch_size=2 over 3 clips -> 2 batches),
    per-clip settings mapping, and the running-tally handoff between batches
    all work together, without hitting the network."""

    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps({
        "clips": [
            {"clipId": "c1", "imagePath": "a.jpg", "mime": "image/jpeg", "base64Data": "AA==",
             "narration": "The king enters the hall.", "startSeconds": 0.0, "endSeconds": 4.0},
            {"clipId": "c2", "imagePath": "b.jpg", "mime": "image/jpeg", "base64Data": "AA==",
             "narration": "Riders gallop across the desert.", "startSeconds": 4.0, "endSeconds": 8.0},
            {"clipId": "c3", "imagePath": "c.jpg", "mime": "image/jpeg", "base64Data": "AA==",
             "narration": "A candle flickers in the dark.", "startSeconds": 8.0, "endSeconds": 12.0},
        ]
    }), encoding="utf-8")

    captured_batches = []

    def fake_analyze_batch(openai_client, gemini_client, gemini_client_error, ai_model, clips, tally, last_effects):
        captured_batches.append((list(clips), dict(tally), list(last_effects)))
        fixtures = {
            "c1": mg.ClipMotionAnalysis(clip_id="c1", effect="Ken Burns", reason="dialogue scene"),
            "c2": mg.ClipMotionAnalysis(
                clip_id="c2", effect="Speed Pan & Motion Blur", reason="riders in motion",
                pan_x_from=6.0, pan_x_to=-10.0,
            ),
            "c3": mg.ClipMotionAnalysis(
                clip_id="c3", effect="Candlelight Flicker", reason="visible flame",
                glow_x=0.5, glow_y=0.2,
            ),
        }
        return mg.BatchMotionResult(analyses=[fixtures[c["clipId"]] for c in clips])

    monkeypatch.setattr(mg, "get_openai_client", lambda: object())
    monkeypatch.setattr(mg, "analyze_batch", fake_analyze_batch)

    results = mg.run(manifest_path, ai_model="gpt-5.4", batch_size=2)

    assert len(captured_batches) == 2
    assert [clip["clipId"] for clip in captured_batches[0][0]] == ["c1", "c2"]
    assert [clip["clipId"] for clip in captured_batches[1][0]] == ["c3"]
    # Second batch must see the first batch's picks in its running tally/history.
    assert captured_batches[1][1]["Ken Burns"] == 1
    assert captured_batches[1][1]["Speed Pan & Motion Blur"] == 1
    assert captured_batches[1][2] == ["Ken Burns", "Speed Pan & Motion Blur"]

    assert [r["clipId"] for r in results] == ["c1", "c2", "c3"]
    assert results[0]["effect"] == "Ken Burns"
    assert results[1]["settings"]["panXFrom"] == 6.0
    assert results[2]["settings"]["glowY"] == 0.2


def test_run_returns_empty_list_for_no_clips(tmp_path):
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps({"clips": []}), encoding="utf-8")
    assert mg.run(manifest_path, ai_model="gpt-5.4", batch_size=8) == []


def test_analyze_batch_rejects_out_of_order_or_missing_clip_ids(monkeypatch):
    clips = [
        {"clipId": "c1", "narration": "x", "startSeconds": 0.0, "endSeconds": 1.0, "mime": "image/jpeg", "base64Data": "AA=="},
        {"clipId": "c2", "narration": "y", "startSeconds": 1.0, "endSeconds": 2.0, "mime": "image/jpeg", "base64Data": "AA=="},
    ]
    wrong_order = mg.BatchMotionResult(analyses=[
        mg.ClipMotionAnalysis(clip_id="c2", effect="Ken Burns", reason="x"),
        mg.ClipMotionAnalysis(clip_id="c1", effect="Ken Burns", reason="y"),
    ])
    monkeypatch.setattr(mg, "parse_structured_vision", lambda **kwargs: wrong_order)
    with pytest.raises(RuntimeError, match="coverage is invalid"):
        mg.analyze_batch(object(), None, None, "gpt-5.4", clips, {name: 0 for name in mg.EFFECT_NAMES}, [])
