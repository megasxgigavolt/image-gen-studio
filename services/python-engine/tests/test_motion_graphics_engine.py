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

import base64
import json
import sys
from pathlib import Path

import pytest

ENGINE_DIR = Path(__file__).parents[1] / "auto_gen_engine"
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

import motion_graphics_engine as mg  # noqa: E402


def _recipe(clip_id: str, **fields) -> mg.MotionRecipe:
    fields.setdefault("reason", "test")
    return mg.MotionRecipe(clip_id=clip_id, **fields)


def _clip(clip_id: str, **overrides) -> dict:
    clip = {
        "clipId": clip_id, "narration": "x", "startSeconds": 0.0, "endSeconds": 2.0,
        "mime": "image/jpeg", "base64Data": base64.b64encode(b"fake-image-bytes").decode("ascii"),
    }
    clip.update(overrides)
    return clip


def _stub_validation_passes(monkeypatch):
    """Most `run()`-level tests care about composition/batching, not the
    render-and-validate pass — this makes every clip pass validation
    untouched, on its first try, with no real rendering or extra AI calls."""
    monkeypatch.setattr(mg, "_validate_and_revise", lambda *args, **kwargs: (args[6], ""))


# --- MotionRecipe shape ------------------------------------------------


def test_motion_recipe_dumps_camelcase_settings_with_defaults():
    """`run()` hands `model_dump(by_alias=True, ...)` straight to the desktop
    app/Remotion renderer — this is the contract that both of those actually
    depend on, so it's worth pinning directly rather than only exercising it
    indirectly through `run()`."""
    recipe = _recipe("c1", scale_from=1.1, scale_to=1.3, camera_effect="zoom_out")
    settings = recipe.model_dump(by_alias=True, exclude={"clip_id", "reason"})
    assert settings["scaleFrom"] == 1.1
    assert settings["scaleTo"] == 1.3
    assert settings["cameraEffect"] == "zoom_out"
    # Untouched primitives still come through at their neutral defaults rather
    # than being omitted — the renderer always receives a fully-populated recipe.
    assert settings["glowColor"] is None
    assert settings["depthEffect"] == "none"
    assert settings["storyEffect"] == "none"
    assert settings["environmentEffect"] == "none"
    assert settings["transitionOut"] == "cut"
    assert settings["pathPoints"] is None
    assert settings["vignette"] == 0.15


def test_motion_recipe_serializes_path_points():
    recipe = _recipe(
        "c1", story_effect="path_animation",
        path_points=[mg.PanPoint(x=-5.0, y=0.0), mg.PanPoint(x=0.0, y=3.0), mg.PanPoint(x=5.0, y=0.0)],
    )
    settings = recipe.model_dump(by_alias=True, exclude={"clip_id", "reason"})
    assert settings["pathPoints"] == [
        {"x": -5.0, "y": 0.0}, {"x": 0.0, "y": 3.0}, {"x": 5.0, "y": 0.0},
    ]


def test_label_for_recipe_combines_non_default_tiers():
    recipe = _recipe(
        "c1", camera_effect="pull_out", depth_effect="depth_blur",
        story_effect="none", environment_effect="fog", transition_out="cross-fade",
    )
    label = mg._label_for_recipe(recipe)
    assert "pull out" in label
    assert "depth blur" in label
    assert "fog" in label
    assert "cross-fade" in label
    assert "none" not in label  # story_effect left at "none" shouldn't appear


def test_label_for_recipe_is_just_the_camera_move_when_everything_else_is_default():
    recipe = _recipe("c1", camera_effect="camera_drift")
    assert mg._label_for_recipe(recipe) == "camera drift"


# --- Diversity context ---------------------------------------------------


def test_diversity_context_reflects_recent_treatment_history():
    context = mg._prior_context(["push in + fog", "zoom out -> cross-fade"])
    assert "push in + fog" in context
    assert "zoom out -> cross-fade" in context


# --- run() / batching ------------------------------------------------------


def test_run_batches_clips_and_carries_treatment_history_across_batches(tmp_path, monkeypatch):
    """End-to-end through `run()` with the OpenAI call and the validator both
    stubbed out — proves manifest parsing, batching (batch_size=2 over 3
    clips -> 2 batches), per-clip settings mapping, and the treatment-history
    handoff between batches all work together, without hitting the network
    or actually rendering anything."""

    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps({
        "width": 1080, "height": 1920, "fps": 30,
        "clips": [
            {"clipId": "c1", "mime": "image/jpeg", "base64Data": "AA==",
             "narration": "The king enters the hall.", "startSeconds": 0.0, "endSeconds": 4.0},
            {"clipId": "c2", "mime": "image/jpeg", "base64Data": "AA==",
             "narration": "Riders gallop across the desert.", "startSeconds": 4.0, "endSeconds": 8.0},
            {"clipId": "c3", "mime": "image/jpeg", "base64Data": "AA==",
             "narration": "A candle flickers in the dark.", "startSeconds": 8.0, "endSeconds": 12.0},
        ],
    }), encoding="utf-8")

    captured_batches = []

    def fake_analyze_batch(claude_cli_path, openai_client, gemini_client, gemini_client_error, ai_model, clips, treatment_history):
        captured_batches.append((list(clips), list(treatment_history)))
        fixtures = {
            "c1": _recipe("c1", camera_effect="push_in"),
            "c2": _recipe("c2", camera_effect="position_pan", pan_x_from=6.0, pan_x_to=-10.0, motion_blur_strength=0.8),
            "c3": _recipe("c3", camera_effect="camera_drift", glow_color="rgba(255,196,110,0.5)", glow_flicker=0.15),
        }
        return mg.BatchMotionResult(analyses=[fixtures[c["clipId"]] for c in clips])

    # Claude CLI availability is a real, machine-dependent fact (whether `claude` is
    # on PATH) — pinned to "not available" here so this test exercises the OpenAI
    # path deterministically regardless of what's installed on the machine running it.
    monkeypatch.setattr(mg, "get_claude_cli_path", lambda: None)
    monkeypatch.setattr(mg, "get_openai_client", lambda: object())
    monkeypatch.setattr(mg, "analyze_batch", fake_analyze_batch)
    _stub_validation_passes(monkeypatch)

    results = mg.run(manifest_path, ai_model="gpt-5.4", batch_size=2)

    assert len(captured_batches) == 2
    assert [clip["clipId"] for clip in captured_batches[0][0]] == ["c1", "c2"]
    assert [clip["clipId"] for clip in captured_batches[1][0]] == ["c3"]
    # Second batch must see the first batch's labels in its history.
    assert captured_batches[1][1] == ["push in", "position pan"]

    assert [r["clipId"] for r in results] == ["c1", "c2", "c3"]
    assert results[0]["effect"] == "push in"
    assert results[1]["settings"]["panXFrom"] == 6.0
    assert results[2]["settings"]["glowColor"] == "rgba(255,196,110,0.5)"


def test_run_appends_validation_warning_to_reason(tmp_path, monkeypatch):
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps({
        "clips": [{"clipId": "c1", "mime": "image/jpeg", "base64Data": "AA==",
                   "narration": "n", "startSeconds": 0.0, "endSeconds": 2.0}],
    }), encoding="utf-8")

    monkeypatch.setattr(mg, "get_claude_cli_path", lambda: None)
    monkeypatch.setattr(mg, "get_openai_client", lambda: object())
    monkeypatch.setattr(
        mg, "analyze_batch",
        lambda *a, **k: mg.BatchMotionResult(analyses=[_recipe("c1", reason="composed reason")]),
    )
    monkeypatch.setattr(
        mg, "_validate_and_revise",
        lambda *args, **kwargs: (args[6], "Unresolved after 2 revisions: subject cropped"),
    )

    results = mg.run(manifest_path, ai_model="gpt-5.4", batch_size=5)
    assert "composed reason" in results[0]["reason"]
    assert "Unresolved after 2 revisions" in results[0]["reason"]


def test_run_returns_empty_list_for_no_clips(tmp_path):
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(json.dumps({"clips": []}), encoding="utf-8")
    assert mg.run(manifest_path, ai_model="gpt-5.4", batch_size=8) == []


# --- analyze_batch / provider fallback --------------------------------------


def test_analyze_batch_rejects_out_of_order_or_missing_clip_ids(monkeypatch):
    clips = [_clip("c1"), _clip("c2")]
    wrong_order = mg.BatchMotionResult(analyses=[_recipe("c2"), _recipe("c1")])
    monkeypatch.setattr(mg, "parse_structured_vision", lambda **kwargs: wrong_order)
    with pytest.raises(RuntimeError, match="coverage is invalid"):
        mg.analyze_batch(None, object(), None, None, "gpt-5.4", clips, [])


def test_analyze_batch_prefers_claude_cli_over_openai_when_both_available(monkeypatch):
    """Claude CLI is provider #1 (see module docstring — no metered cost, rides an
    existing subscription) — OpenAI must not even be touched when it succeeds."""
    clips = [_clip("c1")]
    cli_result = mg.BatchMotionResult(analyses=[_recipe("c1", reason="cli pick")])

    def unexpected_openai_call(**kwargs):
        raise AssertionError("OpenAI should not be called when Claude CLI succeeds")

    monkeypatch.setattr(mg, "parse_structured_vision_claude_cli", lambda **kwargs: cli_result)
    monkeypatch.setattr(mg, "parse_structured_vision", unexpected_openai_call)

    result = mg.analyze_batch("C:/fake/claude.exe", object(), None, None, "gpt-5.4", clips, [])
    assert result.analyses[0].reason == "cli pick"


def test_analyze_batch_falls_back_to_openai_when_claude_cli_fails(monkeypatch):
    clips = [_clip("c1")]
    openai_result = mg.BatchMotionResult(analyses=[_recipe("c1", reason="openai pick")])

    def failing_cli_call(**kwargs):
        raise RuntimeError("claude CLI not logged in")

    monkeypatch.setattr(mg, "parse_structured_vision_claude_cli", failing_cli_call)
    monkeypatch.setattr(mg, "parse_structured_vision", lambda **kwargs: openai_result)

    result = mg.analyze_batch("C:/fake/claude.exe", object(), None, None, "gpt-5.4", clips, [])
    assert result.analyses[0].reason == "openai pick"


def test_analyze_batch_applies_clamp_to_extreme_provider_output(monkeypatch):
    """The clamp runs on every provider's output, not just a specific one —
    proven here by routing an extreme value through the Claude CLI path."""
    clips = [_clip("c1")]
    wild = mg.BatchMotionResult(analyses=[_recipe("c1", scale_to=9.0)])
    monkeypatch.setattr(mg, "parse_structured_vision_claude_cli", lambda **kwargs: wild)
    result = mg.analyze_batch("C:/fake/claude.exe", None, None, None, "gpt-5.4", clips, [])
    assert result.analyses[0].scale_to == 1.35


# --- _clamp_recipe -----------------------------------------------------------


def test_clamp_recipe_reins_in_extreme_values():
    recipe = _recipe(
        "c1", scale_from=1.0, scale_to=5.0, pan_x_from=-90.0, pan_x_to=90.0,
        vignette=3.0, glow_opacity=-1.0, environment_intensity=5.0, environment_effect="dust",
        bg_blur_to_px=999.0, depth_effect="depth_blur",
    )
    clamped = mg._clamp_recipe(recipe)
    assert clamped.scale_to == 1.35
    assert clamped.pan_x_from == -15.0
    assert clamped.pan_x_to == 15.0
    assert clamped.vignette == 1.0
    assert clamped.glow_opacity == 0.0
    assert clamped.environment_intensity == 1.0
    assert clamped.bg_blur_to_px == 30.0


def test_clamp_recipe_injects_motion_when_recipe_is_completely_static():
    recipe = _recipe(
        "c1", scale_from=1.1, scale_to=1.1, pan_x_from=2.0, pan_x_to=2.0,
        pan_y_from=-3.0, pan_y_to=-3.0, rotation_from_deg=0.0, rotation_to_deg=0.0,
    )
    clamped = mg._clamp_recipe(recipe)
    assert clamped.scale_from != clamped.scale_to


def test_clamp_recipe_leaves_genuine_motion_alone():
    # 1.3 is deliberately close to the 1.35 scale ceiling — this is the input
    # staying just under it, not a value that needs rounding down.
    recipe = _recipe("c1", scale_from=1.3, scale_to=1.05, pan_x_from=0.0, pan_x_to=0.0)
    clamped = mg._clamp_recipe(recipe)
    # A deliberate zoom-OUT (scaleFrom > scaleTo) is real motion and must survive
    # untouched — the "never motionless" backstop only fires on true stillness.
    assert clamped.scale_from == 1.3
    assert clamped.scale_to == 1.05


def test_clamp_recipe_never_forces_drift_onto_a_static_path_animation():
    recipe = _recipe(
        "c1", scale_from=1.0, scale_to=1.0, pan_x_from=0.0, pan_x_to=0.0,
        story_effect="path_animation",
        path_points=[mg.PanPoint(x=-5, y=0), mg.PanPoint(x=5, y=2), mg.PanPoint(x=0, y=-4)],
    )
    clamped = mg._clamp_recipe(recipe)
    # The path itself is the motion here — the static-camera-move backstop
    # must not also inject an unrelated forced scale drift on top of it.
    assert clamped.scale_from == 1.0
    assert clamped.scale_to == 1.0
    assert clamped.path_points is not None and len(clamped.path_points) == 3


def test_clamp_recipe_neutralizes_depth_fields_when_effect_is_none():
    recipe = _recipe(
        "c1", depth_effect="none", fg_scale_from=1.4, fg_scale_to=0.9,
        fg_pan_x_from=10.0, bg_blur_to_px=20.0,
        scale_from=1.1, scale_to=1.2, pan_x_from=0.0, pan_x_to=0.0,
    )
    clamped = mg._clamp_recipe(recipe)
    # A stray fg/bg value from the provider must not silently apply once
    # depthEffect is "none" — the renderer would otherwise render a two-layer
    # split for a clip that was never supposed to have one.
    assert clamped.fg_scale_from == clamped.scale_from
    assert clamped.fg_scale_to == clamped.scale_to
    assert clamped.bg_blur_to_px == 0.0


def test_clamp_recipe_falls_back_to_a_two_point_path_when_missing():
    recipe = _recipe(
        "c1", story_effect="path_animation", path_points=None,
        pan_x_from=-2.0, pan_x_to=6.0, pan_y_from=1.0, pan_y_to=-1.0,
    )
    clamped = mg._clamp_recipe(recipe)
    assert clamped.path_points is not None
    assert len(clamped.path_points) == 2
    assert clamped.path_points[0].x == -2.0
    assert clamped.path_points[1].x == 6.0


def test_clamp_recipe_clears_mask_shape_when_story_effect_does_not_use_one():
    recipe = _recipe("c1", story_effect="freeze_frame", mask_shape="circle")
    clamped = mg._clamp_recipe(recipe)
    assert clamped.mask_shape == "none"


# --- _clip_content_blocks -----------------------------------------------


def test_clip_content_blocks_includes_prior_recipe_and_feedback_when_present():
    clips = [_clip("c1", priorRecipe={"scaleFrom": 1.1, "scaleTo": 1.3}, feedback="make it slower and less zoomed in")]
    blocks = mg._clip_content_blocks(clips)
    text = blocks[0]["text"]
    assert "currently has this recipe assigned" in text
    assert "scaleFrom" in text
    assert "make it slower and less zoomed in" in text


def test_clip_content_blocks_omits_prior_recipe_and_feedback_when_absent():
    clips = [_clip("c1")]
    blocks = mg._clip_content_blocks(clips)
    text = blocks[0]["text"]
    assert "currently has this recipe assigned" not in text
    assert "direct instruction" not in text


# --- validator: _validate_clip provider fallback ----------------------------


def test_validate_clip_prefers_claude_cli(monkeypatch):
    verdict = mg.MotionValidation(valid=True)

    def unexpected_openai_call(**kwargs):
        raise AssertionError("OpenAI should not be called when Claude CLI succeeds")

    monkeypatch.setattr(mg, "parse_structured_vision_claude_cli", lambda **kwargs: verdict)
    monkeypatch.setattr(mg, "parse_structured_vision", unexpected_openai_call)
    result = mg._validate_clip("C:/fake/claude.exe", object(), None, None, "gpt-5.4", "narration", _recipe("c1"), [b"frame"])
    assert result.valid is True


def test_validate_clip_soft_fails_open_when_no_provider_is_configured():
    """A validator that can't run at all shouldn't sink the clip — it's
    treated as a pass, with the reason recorded in `issues` rather than
    raised as a fatal error."""
    result = mg._validate_clip(None, None, None, None, "gpt-5.4", "narration", _recipe("c1"), [b"frame"])
    assert result.valid is True
    assert any("Validator unavailable" in issue for issue in result.issues)


# --- validator: render-and-revise orchestration -----------------------------


def test_validate_and_revise_accepts_a_clip_that_passes_first_try(monkeypatch):
    monkeypatch.setattr(mg, "_render_validation_frames", lambda *a, **k: [b"frame0", b"frame1", b"frame2"])
    monkeypatch.setattr(mg, "_validate_clip", lambda *a, **k: mg.MotionValidation(valid=True))

    def unexpected_revise(*args, **kwargs):
        raise AssertionError("should not revise a clip that passed on the first try")

    monkeypatch.setattr(mg, "_revise_recipe", unexpected_revise)

    recipe = _recipe("c1", camera_effect="zoom_in")
    final, warning = mg._validate_and_revise(None, object(), None, None, "gpt-5.4", _clip("c1"), recipe, 30, 1080, 1920, [])
    assert final is recipe
    assert warning == ""


def test_validate_and_revise_revises_once_then_accepts(monkeypatch):
    verdicts = [
        mg.MotionValidation(valid=False, issues=["subject cropped"], revision_instructions="pull the pan back"),
        mg.MotionValidation(valid=True),
    ]
    monkeypatch.setattr(mg, "_render_validation_frames", lambda *a, **k: [b"frame"])
    monkeypatch.setattr(mg, "_validate_clip", lambda *a, **k: verdicts.pop(0))

    revised_recipe = _recipe("c1", camera_effect="camera_drift")
    captured_feedback = []

    def fake_revise(claude_cli_path, openai_client, gemini_client, gemini_client_error, ai_model, clip, prior_recipe, feedback, treatment_history):
        captured_feedback.append(feedback)
        return revised_recipe

    monkeypatch.setattr(mg, "_revise_recipe", fake_revise)

    original = _recipe("c1", camera_effect="zoom_in")
    final, warning = mg._validate_and_revise(None, object(), None, None, "gpt-5.4", _clip("c1"), original, 30, 1080, 1920, [])
    assert final is revised_recipe
    assert warning == ""
    assert captured_feedback == ["pull the pan back"]


def test_validate_and_revise_gives_up_after_max_rounds(monkeypatch):
    monkeypatch.setattr(mg, "_render_validation_frames", lambda *a, **k: [b"frame"])
    monkeypatch.setattr(
        mg, "_validate_clip",
        lambda *a, **k: mg.MotionValidation(valid=False, issues=["still cropped"]),
    )
    revision_count = {"n": 0}

    def fake_revise(*args, **kwargs):
        revision_count["n"] += 1
        return _recipe("c1", camera_effect="camera_drift", reason=f"revision {revision_count['n']}")

    monkeypatch.setattr(mg, "_revise_recipe", fake_revise)

    original = _recipe("c1", camera_effect="zoom_in")
    final, warning = mg._validate_and_revise(None, object(), None, None, "gpt-5.4", _clip("c1"), original, 30, 1080, 1920, [])
    assert revision_count["n"] == mg.MAX_VALIDATION_ROUNDS
    assert "Unresolved after" in warning
    assert "still cropped" in warning
    assert final.reason == f"revision {mg.MAX_VALIDATION_ROUNDS}"


def test_validate_and_revise_accepts_unvalidated_when_render_fails(monkeypatch):
    def failing_render(*args, **kwargs):
        raise RuntimeError("remotion crashed")

    monkeypatch.setattr(mg, "_render_validation_frames", failing_render)

    def unexpected_validate(*args, **kwargs):
        raise AssertionError("should not attempt to validate a frame that failed to render")

    monkeypatch.setattr(mg, "_validate_clip", unexpected_validate)

    original = _recipe("c1", camera_effect="zoom_in")
    final, warning = mg._validate_and_revise(None, object(), None, None, "gpt-5.4", _clip("c1"), original, 30, 1080, 1920, [])
    assert final is original
    assert "Validation render failed" in warning


# --- _render_validation_frames -----------------------------------------


def test_render_validation_frames_invokes_remotion_still_per_sample_frame(monkeypatch):
    calls = []

    class FakeCompletedProcess:
        returncode = 0
        stderr = ""

    def fake_run(args, cwd=None, capture_output=None, text=None, **kwargs):
        calls.append(args)
        out_path = Path(args[5])
        out_path.write_bytes(b"fake-png-bytes")
        return FakeCompletedProcess()

    monkeypatch.setattr(mg.subprocess, "run", fake_run)
    monkeypatch.setattr(mg, "_ensure_motion_engine_ready", lambda: None)
    monkeypatch.setattr(mg, "_resolve_node_bin", lambda name: name)

    frames = mg._render_validation_frames(b"source-bytes", "image/png", _recipe("c1"), duration_frames=60, fps=30, width=1080, height=1920)

    assert len(frames) == 3  # start, middle, end
    assert all(data == b"fake-png-bytes" for data in frames)
    frame_numbers = sorted(int(next(a for a in call if a.startswith("--frame=")).split("=")[1]) for call in calls)
    assert frame_numbers == [0, 30, 59]


def test_render_validation_frames_raises_on_remotion_failure(monkeypatch):
    class FakeCompletedProcess:
        returncode = 1
        stderr = "boom"

    monkeypatch.setattr(mg.subprocess, "run", lambda *a, **k: FakeCompletedProcess())
    monkeypatch.setattr(mg, "_ensure_motion_engine_ready", lambda: None)
    monkeypatch.setattr(mg, "_resolve_node_bin", lambda name: name)

    with pytest.raises(RuntimeError, match="validation render failed"):
        mg._render_validation_frames(b"source-bytes", "image/png", _recipe("c1"), duration_frames=30, fps=30, width=1080, height=1920)
