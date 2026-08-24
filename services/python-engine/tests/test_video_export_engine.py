"""
video_export_engine.py is invoked as a standalone script (its own directory
added to sys.path at run time by Python) and itself does a flat
`import scene_grouping_engine as engine` — tests import it the same way,
matching test_motion_graphics_engine.py's approach, both to exercise the
real production import shape and because scene_grouping_engine.py runs
ffmpeg discovery at module import time that only behaves correctly with its
own directory on sys.path.
"""

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ENGINE_DIR = Path(__file__).parents[1] / "auto_gen_engine"
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

import video_export_engine as export_engine  # noqa: E402


# Root-cause coverage for "captions appear way too low in the exported
# video, whereas in the preview they are not that low": write_captions_ass
# used to hardcode MarginV (and MarginL/MarginR) to a flat 10 ASS units
# regardless of the export's actual resolution — under 1% of a 1080p-tall
# frame, so captions rendered hugging the very bottom edge. The canvas
# preview (drawCaptionText in timeline-rendering.ts) has always kept a
# proportional 5%-of-height gap from the edge; these tests pin the export
# to that same proportion.
def test_scaled_caption_margins_match_preview_proportions():
    margin_l, margin_r, margin_v = export_engine._scaled_caption_margins(1920, 1080)
    assert margin_v == round(1080 * 0.05)
    assert margin_l == margin_r == round(1920 * 0.07)


def test_scaled_caption_margins_scale_with_resolution_not_fixed():
    _, _, margin_v_1080p = export_engine._scaled_caption_margins(1920, 1080)
    _, _, margin_v_4k = export_engine._scaled_caption_margins(3840, 2160)
    # A fixed literal (the old bug) would leave this unchanged at 4K —
    # the fix must scale it up alongside the taller frame.
    assert margin_v_4k > margin_v_1080p
    assert margin_v_1080p > 10  # old hardcoded value — must be well above it now


def test_write_captions_ass_uses_scaled_margin_not_hardcoded_ten(tmp_path):
    out_path = tmp_path / "captions.ass"
    captions = [{"start": 0.0, "end": 1.0, "text": "Hello", "style": None}]
    export_engine.write_captions_ass(captions, out_path, 1920, 1080, export_engine._FALLBACK_CAPTION_STYLE)

    ass_text = out_path.read_text(encoding="utf-8")
    style_line = next(line for line in ass_text.splitlines() if line.startswith("Style: Default,"))
    fields = style_line.split(",")
    # Format: Name, Fontname, Fontsize, ..., Alignment, MarginL, MarginR, MarginV, Encoding
    margin_v = int(fields[-2])
    assert margin_v == round(1080 * 0.05)
    assert margin_v != 10


# Root-cause coverage for "captions have a stronger shadow ... than what the
# preview shows": _resolve_shadow used to scale distance/blur by
# height/540 while the canvas preview (drawCaptionText in
# timeline-rendering.ts) applied NO scaling to shadow at all — a real,
# unrelated-formula mismatch, not just an approximation gap. Both sides now
# scale by the same quantity (font_size, relative to _REFERENCE_FONT_SIZE_PX)
# so a shadow tuned in preview matches what's actually burned in.
def test_resolve_shadow_disabled_returns_zeros():
    style = {"shadow": {"enabled": False}}
    assert export_engine._resolve_shadow(style, 24.3) == (0.0, 0.0, 0, "#000000", 255)


def test_resolve_shadow_unchanged_at_the_reference_font_size():
    style = {"shadow": {"enabled": True, "distance": 4.0, "angle": 0, "blur": 25, "opacity": 70, "color": "#000000"}}
    xshad, yshad, blur, color, alpha = export_engine._resolve_shadow(style, export_engine._REFERENCE_FONT_SIZE_PX)
    assert xshad == 4.0  # angle=0 -> pure X offset, scale=1 at the reference size
    assert yshad == 0.0


def test_resolve_shadow_scales_with_font_size_not_a_fixed_height():
    style = {"shadow": {"enabled": True, "distance": 4.0, "angle": 0, "blur": 25, "opacity": 70, "color": "#000000"}}
    small_xshad, *_ = export_engine._resolve_shadow(style, export_engine._REFERENCE_FONT_SIZE_PX)
    large_xshad, *_ = export_engine._resolve_shadow(style, export_engine._REFERENCE_FONT_SIZE_PX * 2)
    assert large_xshad == pytest.approx(small_xshad * 2)


# Root-cause coverage for "the caption outline is way bolder than what I
# picked": timeline-rendering.ts's canvas preview strokes the outline with
# `ctx.lineWidth` — a CENTERED stroke, only half of it visible outside the
# glyph fill — but ASS's `\bord` paints the full value as an outward-only
# border. Confirmed empirically (a real ASS burn at the un-corrected value
# next to a halved one — the un-corrected one is roughly 2x heavier). The
# extra 0.5x here is ASS-specific and must never be mirrored into the
# canvas preview's own (already-centered, needs-no-correction) formula.
def test_scaled_outline_width_applies_the_ass_outward_border_correction():
    style = {"outlineWidthPx": 2}
    # (2/2)*100*0.16*0.5 — the *0.5 is the correction; without it this would be 16.0.
    assert export_engine._scaled_outline_width(style, 100.0) == pytest.approx(8.0)


def test_scaled_outline_width_zero_stays_zero():
    assert export_engine._scaled_outline_width({"outlineWidthPx": 0}, 100.0) == 0.0


# Root-cause coverage for "motion effect only applies on stills — once a
# still is replaced with an animation/imported clip, the Camera Effect
# setting does nothing": build_segments used to only forward
# motionGraphicEffect/motionGraphicSettings (and colorFilter) for "image"
# kind stills, silently dropping them for "video" kind ones even though
# Rust's manifest already includes them for every clip kind. These pin the
# fix: a "video" still's segment carries the same fields through so
# _encode_segment_to_path's motion-graphic branch (image OR video kind, see
# its gate) actually receives them.
def test_build_segments_forwards_motion_graphic_fields_for_video_stills():
    stills = [{
        "kind": "video", "videoPath": "/tmp/clip.mp4", "start": 0.0, "end": 3.0,
        "sourceDurationSeconds": 3.0, "transitionIn": "cut", "transitionOut": "cut",
        "colorFilter": "warm", "colorFilterIntensity": 65.0,
        "motionGraphicEffect": "Manual: Zoom In",
        "motionGraphicSettings": {"cameraEffect": "zoom_in"},
    }]
    segments = export_engine.build_segments(stills, 3.0)
    video_segments = [s for s in segments if s["kind"] == "video"]
    assert len(video_segments) == 1
    segment = video_segments[0]
    assert segment["path"] == "/tmp/clip.mp4"
    assert segment["motionGraphicEffect"] == "Manual: Zoom In"
    assert segment["motionGraphicSettings"] == {"cameraEffect": "zoom_in"}
    assert segment["colorFilter"] == "warm"
    assert segment["colorFilterIntensity"] == 65.0


def test_build_segments_video_still_without_motion_graphic_has_none_fields():
    stills = [{
        "kind": "video", "videoPath": "/tmp/clip.mp4", "start": 0.0, "end": 3.0,
    }]
    segments = export_engine.build_segments(stills, 3.0)
    segment = next(s for s in segments if s["kind"] == "video")
    assert segment["motionGraphicEffect"] is None
    assert segment["motionGraphicSettings"] is None


# Root-cause coverage for the export-side half of the same fix:
# _encode_segment_to_path's motion-graphic branch used to only trigger for
# `segment["kind"] == "image"` — a "video" segment carrying a recipe fell
# through to the plain (no zoom) ffmpeg-only branch instead. Exercises just
# the gate/branch-selection logic via monkeypatching the actual render/ffmpeg
# calls, since those require a live Remotion/ffmpeg environment.
def test_encode_segment_routes_video_with_recipe_through_motion_graphic_render(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(export_engine, "_render_motion_graphic", lambda *args, **kwargs: calls.append(("motion_graphic", args)))
    monkeypatch.setattr(export_engine, "run_ffmpeg", lambda args: calls.append(("ffmpeg", args)))

    segment = {
        "kind": "video", "path": "/tmp/clip.mp4", "start": 0.0, "end": 2.0, "frames": 48,
        "motionGraphicEffect": "Manual: Zoom In",
        # A Tier 2 accent (depthEffect) on top of the camera move — not
        # Tier-1-only, so this must still take the real Remotion render (see
        # the ffmpeg-native-video test below for the Tier-1-only case).
        "motionGraphicSettings": {"cameraEffect": "zoom_in", "depthEffect": "parallax_3d"},
        "sourceDurationSeconds": 2.0, "transitionIn": "cut", "transitionOut": "cut",
    }
    export_engine._encode_segment_to_path(segment, tmp_path / "out.ts", 1920, 1080, 24)

    assert calls[0][0] == "motion_graphic"
    # (media_path, source_kind, effect, settings, frames, fps, width, height, out_path)
    assert calls[0][1][1] == "video"
    assert calls[1][0] == "ffmpeg"


def test_encode_segment_video_without_recipe_skips_motion_graphic_render(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(export_engine, "_render_motion_graphic", lambda *args, **kwargs: calls.append("motion_graphic"))
    monkeypatch.setattr(export_engine, "run_ffmpeg", lambda args: calls.append("ffmpeg"))

    segment = {
        "kind": "video", "path": "/tmp/clip.mp4", "start": 0.0, "end": 2.0, "frames": 48,
        "sourceDurationSeconds": 2.0, "transitionIn": "cut", "transitionOut": "cut",
    }
    export_engine._encode_segment_to_path(segment, tmp_path / "out.ts", 1920, 1080, 24)

    assert "motion_graphic" not in calls
    assert calls == ["ffmpeg"]


# Root-cause coverage for the "Remotion is heavy for simple zoom/pan clips"
# fix: _is_ffmpeg_native_recipe gates which MotionRecipes can skip
# Remotion/Chromium entirely (see build_recipe_zoompan_filter) — every field
# below must independently disqualify a recipe when set to something other
# than its neutral/off default, since any one of them means the clip
# actually needs the real Remotion composition.
def _neutral_recipe(**overrides):
    base = {
        "cameraEffect": "push_in", "scaleFrom": 1.05, "scaleTo": 1.2,
        "panXFrom": 0, "panXTo": 0, "panYFrom": 0, "panYTo": 0,
        "rotationFromDeg": 0, "rotationToDeg": 0, "originX": 50, "originY": 50,
        "easing": "ease", "staticZoomPercent": 0,
        "depthEffect": "none", "storyEffect": "none", "environmentEffect": "none",
        "environmentIntensity": 0, "maskShape": "none", "vignette": 0,
        "fadeInFrames": 0, "fadeOutFrames": 0, "motionBlurStrength": 0, "shakeAmount": 0,
        "speedCurve": "linear_pace", "saturationFrom": 1, "saturationTo": 1,
        "glowColor": None, "pathPoints": None,
    }
    base.update(overrides)
    return base


def test_is_ffmpeg_native_recipe_true_for_a_fully_neutral_recipe():
    assert export_engine._is_ffmpeg_native_recipe(_neutral_recipe()) is True


def test_is_ffmpeg_native_recipe_true_with_only_camera_move_customized():
    # The whole point: scale/pan/origin/easing/staticZoom freely varying is
    # still "Tier 1 only" as long as every other tier stays at its default.
    recipe = _neutral_recipe(
        scaleFrom=1.0, scaleTo=1.4, panXFrom=-10, panXTo=20, panYFrom=5, panYTo=-5,
        originX=30, originY=70, easing="easeOut", staticZoomPercent=15,
    )
    assert export_engine._is_ffmpeg_native_recipe(recipe) is True


@pytest.mark.parametrize("overrides", [
    {"depthEffect": "parallax_3d"},
    {"storyEffect": "freeze_frame"},
    {"environmentEffect": "snow"},
    {"maskShape": "circle"},
    {"motionBlurStrength": 0.4},
    {"shakeAmount": 0.2},
    {"speedCurve": "punch_in_hold"},
    {"saturationFrom": 0.5},
    {"saturationTo": 1.5},
    {"glowColor": "#FFEB3B"},
    {"pathPoints": [{"x": 0, "y": 0}, {"x": 10, "y": 10}]},
    {"easing": "elastic"},
    {"rotationFromDeg": 0, "rotationToDeg": 15},
])
def test_is_ffmpeg_native_recipe_false_when_any_higher_tier_field_is_active(overrides):
    assert export_engine._is_ffmpeg_native_recipe(_neutral_recipe(**overrides)) is False


# Root-cause coverage for "why is it pushing all stills into Remotion for no
# reason": the AI applies fadeInFrames/fadeOutFrames broadly as an "always
# on" envelope, not a rare accent — so requiring them at exactly 0 used to
# disqualify nearly every real clip from the ffmpeg-native fast path
# regardless of anything else. Has a native, EXACT ffmpeg equivalent (see
# build_recipe_zoompan_filter) and must NOT disqualify the fast path on its
# own.
@pytest.mark.parametrize("overrides", [
    {"fadeInFrames": 12},
    {"fadeOutFrames": 12},
    {"fadeInFrames": 12, "fadeOutFrames": 12},
])
def test_is_ffmpeg_native_recipe_true_for_fade_envelope(overrides):
    assert export_engine._is_ffmpeg_native_recipe(_neutral_recipe(**overrides)) is True


# Root-cause coverage for the OTHER half of "why is it pushing all stills
# into Remotion for no reason": vignette used to disqualify the fast path
# unconditionally (an earlier attempt at a native ffmpeg equivalent, using
# ffmpeg's own built-in `vignette` filter, was reverted after it produced a
# dramatically wrong-shaped/wrong-strength effect — a full-frame radial lens
# model standing in for MotionClip.tsx's real thin edge-only inset
# box-shadow). It's now handled correctly via `_apply_vignette_filter`'s own
# compositing step instead (see its tests below), so ANY vignette value must
# no longer disqualify the fast path on its own.
@pytest.mark.parametrize("overrides", [{"vignette": 0.15}, {"vignette": 1.0}])
def test_is_ffmpeg_native_recipe_true_for_any_vignette(overrides):
    assert export_engine._is_ffmpeg_native_recipe(_neutral_recipe(**overrides)) is True


# environmentIntensity is inert whenever environmentEffect=="none" (already
# required for the fast path) — a nonzero leftover/default intensity value
# with no effect selected must not disqualify the clip. A real
# environmentEffect still does (covered by the parametrized test above).
def test_is_ffmpeg_native_recipe_true_with_inert_environment_intensity():
    assert export_engine._is_ffmpeg_native_recipe(_neutral_recipe(environmentIntensity=0.35)) is True


def test_build_recipe_zoompan_filter_produces_a_zoompan_chain():
    vf = export_engine.build_recipe_zoompan_filter(_neutral_recipe(), 1920, 1080, 24, 3.0, 72)
    assert "zoompan=" in vf
    assert "d=72" in vf
    assert "s=1920x1080" in vf
    assert "fps=24" in vf


# Root-cause coverage for "even with zero clips needing Remotion, a 10-minute
# 4K video still takes 30-40 minutes to export": every zoompan filter here
# pre-scales its source before cropping (see `_ZOOMPAN_PRE_SCALE_FACTOR`'s
# own comment for why any upscale is needed at all), and `-loop 1` re-runs
# that scale on every one of a still's repeated output frames, not once —
# the pre-scale factor was 8x, uncovered as the actual dominant cost on a
# real project export via direct measurement (8x=5fps, 4x=19fps, roughly the
# quadratic cost a 2D upscale would predict). Pinned at a small value here so
# a future "let's improve smoothness a bit" tweak can't silently reintroduce
# a ~4x-or-worse regression — that tradeoff needs to be made with the actual
# render-time cost in view, not just the smoothness benefit.
def test_zoompan_pre_scale_factor_stays_small():
    assert export_engine._ZOOMPAN_PRE_SCALE_FACTOR <= 4


def test_build_recipe_zoompan_filter_includes_fade_when_transition_requests_it():
    vf = export_engine.build_recipe_zoompan_filter(
        _neutral_recipe(), 1920, 1080, 24, 3.0, 72,
        transition_in="fade", transition_out="dip-to-white",
    )
    assert "fade=t=in" in vf
    assert "color=black" in vf
    assert "fade=t=out" in vf
    assert "color=white" in vf


def test_build_recipe_zoompan_filter_reduces_to_the_existing_anchor_formula_with_no_pan():
    # Sanity check on the derivation itself (see the function's own doc
    # comment): with panX/Y at 0, the x/y expressions must reduce to
    # exactly the same shape as anchored_xy's proven `(iw-iw/zoom)*sx` —
    # not just "close", structurally identical.
    vf = export_engine.build_recipe_zoompan_filter(
        _neutral_recipe(originX=35, originY=65, panXFrom=0, panXTo=0, panYFrom=0, panYTo=0),
        1920, 1080, 24, 3.0, 72,
    )
    assert "(iw-iw/zoom)*0.350000-(iw/zoom)*(0.000000+" in vf
    assert "(ih-ih/zoom)*0.650000-(ih/zoom)*(0.000000+" in vf


def test_build_recipe_zoompan_filter_omits_envelope_fade_when_off():
    vf = export_engine.build_recipe_zoompan_filter(_neutral_recipe(), 1920, 1080, 24, 3.0, 72)
    # build_recipe_zoompan_filter never renders vignette itself — that's a
    # separate compositing step layered on top by _apply_vignette_filter,
    # not ffmpeg's own (wrong-shaped, for this) `vignette` filter.
    assert "vignette=" not in vf
    assert "fade=" not in vf


def test_build_recipe_zoompan_filter_adds_fade_envelope_timed_in_frames():
    # 72 frames @ 24fps = 3.0s clip; fadeInFrames=24 -> 1.0s fade-in from t=0,
    # fadeOutFrames=12 -> 0.5s fade-out starting at (72-12)/24 = 2.5s. Timed
    # off `frames`/fps (this recipe's own timeline), not the segment's
    # `duration` param — pass a different duration to prove that.
    vf = export_engine.build_recipe_zoompan_filter(
        _neutral_recipe(fadeInFrames=24, fadeOutFrames=12), 1920, 1080, 24, 999.0, 72,
    )
    assert "fade=t=in:st=0:d=1.000:color=black" in vf
    assert "fade=t=out:st=2.500:d=0.500:color=black" in vf


def test_build_recipe_zoompan_filter_clamps_envelope_fade_to_half_the_clip():
    # fadeInFrames requesting more than half of a 72-frame clip clamps to 36.
    vf = export_engine.build_recipe_zoompan_filter(
        _neutral_recipe(fadeInFrames=1000), 1920, 1080, 24, 3.0, 72,
    )
    assert f"fade=t=in:st=0:d={36 / 24:.3f}:color=black" in vf


# Root-cause coverage for the branch-selection half: an eligible "image"
# segment must skip Remotion/_render_motion_graphic entirely and go
# straight to a single run_ffmpeg call using the zoompan filter — this is
# what actually removes the Chromium cold-start for these clips, not just a
# helper function existing unused.
def test_encode_segment_routes_a_simple_image_recipe_through_ffmpeg_native(tmp_path, monkeypatch):
    monkeypatch.setattr(export_engine, "_render_motion_graphic", lambda *a, **k: (_ for _ in ()).throw(AssertionError("should not call Remotion")))
    calls = []
    monkeypatch.setattr(export_engine, "run_ffmpeg", lambda args: calls.append(args))

    segment = {
        "kind": "image", "path": "/tmp/still.png", "start": 0.0, "end": 3.0, "frames": 72,
        "motionGraphicEffect": "Manual: Push In", "motionGraphicSettings": _neutral_recipe(),
        "transitionIn": "cut", "transitionOut": "cut",
    }
    export_engine._encode_segment_to_path(segment, tmp_path / "out.ts", 1920, 1080, 24)

    assert len(calls) == 1
    vf = calls[0][calls[0].index("-vf") + 1]
    assert "zoompan=" in vf


# Root-cause coverage for the "export stuck at 5% for ages" fix: Tier 1
# (camera move) is mandatory on every AI-composed recipe per the SOP, so
# every animation/imported-clip ("video" kind) segment used to be sent
# through the slow, sequential, Chromium-backed Remotion batch pre-render
# unconditionally — even a plain push-in with nothing else set. A "video"
# segment must get the exact same ffmpeg-native fast-path treatment an
# "image" segment already does whenever its recipe is Tier-1-only.
def test_encode_segment_routes_a_simple_video_recipe_through_ffmpeg_native(tmp_path, monkeypatch):
    monkeypatch.setattr(export_engine, "_render_motion_graphic", lambda *a, **k: (_ for _ in ()).throw(AssertionError("should not call Remotion")))
    calls = []
    monkeypatch.setattr(export_engine, "run_ffmpeg", lambda args: calls.append(args))

    segment = {
        "kind": "video", "path": "/tmp/clip.mp4", "start": 0.0, "end": 3.0, "frames": 72,
        "motionGraphicEffect": "Manual: Push In", "motionGraphicSettings": _neutral_recipe(),
        "sourceDurationSeconds": 3.0, "transitionIn": "cut", "transitionOut": "cut",
    }
    export_engine._encode_segment_to_path(segment, tmp_path / "out.ts", 1920, 1080, 24)

    assert len(calls) == 1
    args = calls[0]
    assert "-loop" not in args  # real video stream, not a looped still
    assert "-an" in args  # this clip's own audio is never used, same as the plain (no-recipe) video branch
    vf = args[args.index("-vf") + 1]
    assert "zoompan=" in vf
    assert "d=1:" in vf  # one output frame per real input frame, not "hold for the whole clip"


# Root-cause coverage for the OTHER half of "why is Remotion still running
# for a clip whose recipe is nothing but a plain push-in": vignette used to
# unconditionally disqualify the whole recipe from this fast path even
# though the AI used to attach a small vignette to nearly every real clip by
# default. A recipe with a vignette on top of an otherwise Tier-1-only
# camera move must still take this fast path, with the vignette applied as
# its own extra compositing stage instead of sending the whole clip through
# Remotion (see _apply_vignette_filter's own tests for that stage itself).
def test_encode_segment_applies_vignette_via_filter_complex_on_ffmpeg_native_path(tmp_path, monkeypatch):
    monkeypatch.setattr(export_engine, "_render_motion_graphic", lambda *a, **k: (_ for _ in ()).throw(AssertionError("should not call Remotion")))
    monkeypatch.setattr(export_engine, "_ensure_vignette_mask", lambda mask_dir, width, height, vignette: mask_dir / "mask.png")
    calls = []
    monkeypatch.setattr(export_engine, "run_ffmpeg", lambda args: calls.append(args))

    segment = {
        "kind": "image", "path": "/tmp/still.png", "start": 0.0, "end": 3.0, "frames": 72,
        "motionGraphicEffect": "Manual: Push In", "motionGraphicSettings": _neutral_recipe(vignette=0.2),
        "transitionIn": "cut", "transitionOut": "cut",
    }
    export_engine._encode_segment_to_path(segment, tmp_path / "out.ts", 1920, 1080, 24)

    assert len(calls) == 1
    args = calls[0]
    # Two real inputs now: the still, and the (mocked) vignette mask.
    assert args.count("-i") == 2
    assert "-vf" not in args
    filter_graph = args[args.index("-filter_complex") + 1]
    assert "zoompan=" in filter_graph
    assert "blend=all_mode=multiply" in filter_graph
    assert args[args.index("-map") + 1] == "[_vgout]"


def test_encode_segment_ffmpeg_native_path_skips_vignette_wrapping_when_absent(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(export_engine, "run_ffmpeg", lambda args: calls.append(args))

    segment = {
        "kind": "image", "path": "/tmp/still.png", "start": 0.0, "end": 3.0, "frames": 72,
        "motionGraphicEffect": "Manual: Push In", "motionGraphicSettings": _neutral_recipe(),
        "transitionIn": "cut", "transitionOut": "cut",
    }
    export_engine._encode_segment_to_path(segment, tmp_path / "out.ts", 1920, 1080, 24)

    args = calls[0]
    assert "-vf" in args
    assert "-filter_complex" not in args
    assert args.count("-i") == 1


def test_vignette_mask_geometry_matches_aspect_ratio():
    long_edge = export_engine._VIGNETTE_MASK_LONG_EDGE
    mask_w, mask_h, _ = export_engine._vignette_mask_geometry(3840, 2160, 0.4)
    assert mask_w == long_edge
    assert mask_h == round(long_edge * 2160 / 3840)

    # Portrait (9:16) — long edge tracks height instead, never a radial/
    # aspect-agnostic mask (see _vignette_mask_geometry's own comment on why
    # that's what avoids the previous ffmpeg `vignette`-filter's pillarboxing).
    mask_w2, mask_h2, _ = export_engine._vignette_mask_geometry(1080, 1920, 0.4)
    assert mask_h2 == long_edge
    assert mask_w2 == round(long_edge * 1080 / 1920)


def test_vignette_mask_geometry_higher_vignette_widens_the_falloff_band():
    # Larger vignette -> larger blur/spread -> the smoothstep's own
    # denominator ("span") grows, i.e. the darkened band reaches further in
    # from the edge — the correct (monotonic) direction, unlike the previous
    # ffmpeg `vignette`-filter attempt, which read backwards.
    import re

    def _span(vignette):
        _, _, expr = export_engine._vignette_mask_geometry(1920, 1080, vignette)
        return float(re.search(r"/([0-9.]+),0,1\)", expr).group(1))

    assert _span(0.8) > _span(0.1) > 0


def test_apply_vignette_filter_returns_plain_vf_unchanged_when_no_vignette(tmp_path):
    extra_inputs, video_args = export_engine._apply_vignette_filter("zoompan=z=1", 0.0, 1920, 1080, 4.0, tmp_path)
    assert extra_inputs == []
    assert video_args == ["-vf", "zoompan=z=1"]


def test_apply_vignette_filter_builds_a_second_input_and_filter_complex(tmp_path, monkeypatch):
    monkeypatch.setattr(export_engine, "_ensure_vignette_mask", lambda mask_dir, width, height, vignette: tmp_path / "mask.png")

    extra_inputs, video_args = export_engine._apply_vignette_filter("zoompan=z=1", 0.3, 1920, 1080, 4.0, tmp_path)

    assert extra_inputs == ["-loop", "1", "-t", "4.000", "-i", str(tmp_path / "mask.png")]
    assert video_args[0] == "-filter_complex"
    assert "[0:v]zoompan=z=1[_vgz]" in video_args[1]
    assert "[1:v]scale=1920:1080" in video_args[1]
    assert "blend=all_mode=multiply:shortest=1" in video_args[1]
    assert video_args[2:] == ["-map", "[_vgout]"]


def test_ensure_vignette_mask_reuses_a_cached_file_across_calls(tmp_path, monkeypatch):
    calls = []

    def fake_run(args, **kwargs):
        calls.append(args)
        Path(args[-1]).write_bytes(b"fake-png")
        return SimpleNamespace(returncode=0)

    monkeypatch.setattr(export_engine.subprocess, "run", fake_run)

    first = export_engine._ensure_vignette_mask(tmp_path, 1920, 1080, 0.25)
    second = export_engine._ensure_vignette_mask(tmp_path, 1920, 1080, 0.25)

    assert first == second
    assert len(calls) == 1  # second call reused the cached file — no repeat ffmpeg invocation


def test_encode_segment_routes_a_complex_video_recipe_through_remotion_as_before(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(export_engine, "_render_motion_graphic", lambda *args, **kwargs: calls.append("motion_graphic"))
    monkeypatch.setattr(export_engine, "run_ffmpeg", lambda args: calls.append("ffmpeg"))

    segment = {
        "kind": "video", "path": "/tmp/clip.mp4", "start": 0.0, "end": 3.0, "frames": 72,
        "motionGraphicEffect": "Manual: Snow",
        "motionGraphicSettings": _neutral_recipe(environmentEffect="snow", environmentIntensity=0.5),
        "sourceDurationSeconds": 3.0, "transitionIn": "cut", "transitionOut": "cut",
    }
    export_engine._encode_segment_to_path(segment, tmp_path / "out.ts", 1920, 1080, 24)

    assert calls[0] == "motion_graphic"


def test_encode_segment_video_ffmpeg_native_pads_a_stale_short_source(tmp_path, monkeypatch):
    # Same stale-asset tpad safety net as the plain (no-recipe) "video"
    # branch — a source clip shorter than its timeline slot (e.g. the slot
    # was resized after the last "Adjust animation to duration" click) must
    # still get its last frame cloned to fill the remainder.
    calls = []
    monkeypatch.setattr(export_engine, "run_ffmpeg", lambda args: calls.append(args))

    segment = {
        "kind": "video", "path": "/tmp/clip.mp4", "start": 0.0, "end": 3.0, "frames": 72,
        "motionGraphicEffect": "Manual: Push In", "motionGraphicSettings": _neutral_recipe(),
        "sourceDurationSeconds": 2.0, "transitionIn": "cut", "transitionOut": "cut",
    }
    export_engine._encode_segment_to_path(segment, tmp_path / "out.ts", 1920, 1080, 24)

    vf = calls[0][calls[0].index("-vf") + 1]
    assert "tpad=stop_mode=clone:stop_duration=1.000" in vf


def test_build_recipe_zoompan_filter_holds_one_frame_when_source_is_already_a_video():
    vf = export_engine.build_recipe_zoompan_filter(
        _neutral_recipe(), 1920, 1080, 24, 3.0, 72, zoompan_hold_frames=1,
    )
    assert "d=1:" in vf


# Root-cause coverage for a real bug found via a live repro against an
# actual 24fps/185-frame Veo-generated clip feeding a 30fps/260-frame slot:
# zoompan's own `fps=` OPTION only sets the pacing zoompan itself uses for
# `on` — with `d=1` (real video source, not an image loop) it does NOT
# resample the incoming stream, so without an explicit `fps=` FILTER first,
# the real (24fps) source simply ran out of frames before reaching the
# requested output count, silently truncating the segment and desyncing
# everything after it in the final concat.
def test_build_recipe_zoompan_filter_resamples_fps_explicitly_for_a_video_source():
    vf = export_engine.build_recipe_zoompan_filter(
        _neutral_recipe(), 1920, 1080, 30, 3.0, 72, zoompan_hold_frames=1,
    )
    assert vf.startswith("fps=30,")


def test_build_recipe_zoompan_filter_image_loop_has_no_fps_resample_filter():
    # The image-loop case doesn't need it — zoompan's own d={frames} already
    # fully controls output frame count independent of any source rate, and
    # an `-loop 1` input has no "native fps" to mismatch against anyway.
    vf = export_engine.build_recipe_zoompan_filter(_neutral_recipe(), 1920, 1080, 30, 3.0, 72)
    assert not vf.startswith("fps=30,")
    assert ",fps=30," not in vf


def test_encode_segment_routes_a_complex_image_recipe_through_remotion_as_before(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(export_engine, "_render_motion_graphic", lambda *args, **kwargs: calls.append("motion_graphic"))
    monkeypatch.setattr(export_engine, "run_ffmpeg", lambda args: calls.append("ffmpeg"))

    segment = {
        "kind": "image", "path": "/tmp/still.png", "start": 0.0, "end": 3.0, "frames": 72,
        "motionGraphicEffect": "Manual: Snow", "motionGraphicSettings": _neutral_recipe(environmentEffect="snow", environmentIntensity=0.5),
        "transitionIn": "cut", "transitionOut": "cut",
    }
    export_engine._encode_segment_to_path(segment, tmp_path / "out.ts", 1920, 1080, 24)

    assert calls[0] == "motion_graphic"


# Root-cause coverage for the render-speed fix: a segment carrying a
# pre-rendered raw clip (written by run()'s upfront batch pre-render — see
# _batch_render_motion_graphics) must reuse it directly instead of calling
# _render_motion_graphic again, which would silently throw away the whole
# point of batching (one bundle/browser for the entire export instead of a
# fresh cold Node/webpack/Chromium process per clip).
def test_encode_segment_reuses_a_pre_rendered_raw_path_when_present(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(export_engine, "_render_motion_graphic", lambda *args, **kwargs: calls.append("motion_graphic"))
    monkeypatch.setattr(export_engine, "run_ffmpeg", lambda args: calls.append(args))

    # "video" kind with a Tier 2 accent (depthEffect), so it's still routed
    # through the Remotion pre-render/fallback machinery rather than the
    # Tier-1-only ffmpeg-native fast path (see _is_ffmpeg_native_recipe's
    # call site) — this test is about the pre-render reuse, not about which
    # path a plain camera-move recipe takes.
    pre_rendered = tmp_path / "pre.raw.mp4"
    pre_rendered.write_bytes(b"fake-video")
    segment = {
        "kind": "video", "path": "/tmp/clip.mp4", "start": 0.0, "end": 2.0, "frames": 48,
        "motionGraphicEffect": "Manual: Push In",
        "motionGraphicSettings": {"cameraEffect": "push_in", "depthEffect": "parallax_3d"},
        "transitionIn": "cut", "transitionOut": "cut", "_preRenderedRawPath": str(pre_rendered),
    }
    export_engine._encode_segment_to_path(segment, tmp_path / "out.ts", 1920, 1080, 24)

    assert "motion_graphic" not in calls  # never re-rendered
    ffmpeg_call = next(c for c in calls if isinstance(c, list))
    assert str(pre_rendered) in ffmpeg_call  # fed the pre-rendered file straight into ffmpeg
    assert pre_rendered.exists()  # _encode_segment_to_path itself never deletes a shared pre-rendered file


def test_encode_segment_falls_back_to_render_when_pre_rendered_path_is_missing(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(export_engine, "_render_motion_graphic", lambda *args, **kwargs: calls.append("motion_graphic"))
    monkeypatch.setattr(export_engine, "run_ffmpeg", lambda args: calls.append(args))

    segment = {
        "kind": "video", "path": "/tmp/clip.mp4", "start": 0.0, "end": 2.0, "frames": 48,
        "motionGraphicEffect": "Manual: Push In",
        "motionGraphicSettings": {"cameraEffect": "push_in", "depthEffect": "parallax_3d"},
        "transitionIn": "cut", "transitionOut": "cut",
        "_preRenderedRawPath": str(tmp_path / "does-not-exist.mp4"),
    }
    export_engine._encode_segment_to_path(segment, tmp_path / "out.ts", 1920, 1080, 24)

    assert calls[0] == "motion_graphic"  # fell back since the pre-rendered file wasn't actually there


# Root-cause coverage for _common_public_dir, the shared serving root a
# batched Remotion render needs (staticFile() resolves every clip's
# mediaPath relative to it) — every asset for one video already lives under
# one shared Projects/<channel>/<video>/ root in real use, so this should
# normally succeed; a pathological failure (e.g. cross-drive paths) must
# degrade to None, not raise, so the caller can just skip batching instead
# of failing the whole export.
def test_common_public_dir_finds_the_shared_ancestor(tmp_path):
    (tmp_path / "renders" / "g1").mkdir(parents=True)
    (tmp_path / "animations" / "g2").mkdir(parents=True)
    a = tmp_path / "renders" / "g1" / "still.png"
    b = tmp_path / "animations" / "g2" / "clip.mp4"
    a.write_bytes(b"x")
    b.write_bytes(b"x")
    assert export_engine._common_public_dir([str(a), str(b)]) == tmp_path


def test_common_public_dir_returns_none_on_a_pathological_failure(monkeypatch):
    monkeypatch.setattr(export_engine.os.path, "commonpath", lambda paths: (_ for _ in ()).throw(ValueError("no common path")))
    assert export_engine._common_public_dir(["/a/b.png", "/c/d.png"]) is None


# Root-cause coverage for _batch_render_motion_graphics's three outcomes:
# empty input, a clean success, and the batch PROCESS itself failing to run
# (as opposed to an individual clip within it failing — see the next test)
# — the caller relies on the returned per-id error dict to decide which
# segments keep their pre-render and which fall back to the older,
# already-proven per-clip path.
def test_batch_render_motion_graphics_returns_empty_dict_for_no_items(tmp_path):
    assert export_engine._batch_render_motion_graphics([], tmp_path, tmp_path) == {}


# _batch_render_motion_graphics streams the child process's stdout/stderr
# via subprocess.Popen (rather than blocking on subprocess.run) so it can
# turn batch-render.mjs's per-clip "PROGRESS n total" lines into export
# progress — see that function's own doc comment. This fake stands in for
# the Popen handle: `stdout`/`stderr` are plain iterators (matching how the
# real code only ever iterates them line-by-line), and results_path is
# written eagerly in the constructor since nothing in these tests needs to
# distinguish "process started" from "process finished".
class _FakeBatchProcess:
    def __init__(self, args, returncode=0, stdout_lines=(), stderr_lines=(), write_results=None):
        if write_results is not None:
            Path(args[3]).write_text(json.dumps(write_results), encoding="utf-8")
        self.stdout = iter(stdout_lines)
        self.stderr = iter(stderr_lines)
        self.returncode = returncode

    def wait(self):
        pass


def test_batch_render_motion_graphics_reports_no_errors_on_full_success(tmp_path, monkeypatch):
    monkeypatch.setattr(export_engine, "_ensure_motion_engine_ready", lambda: None)
    monkeypatch.setattr(export_engine, "_resolve_node_bin", lambda name: f"/fake/{name}")
    monkeypatch.setattr(
        export_engine.subprocess, "Popen",
        lambda args, **kwargs: _FakeBatchProcess(
            args, stdout_lines=["PROGRESS 1 2\n", "PROGRESS 2 2\n"],
            write_results=[{"id": "0", "ok": True}, {"id": "1", "ok": True}],
        ),
    )
    items = [
        {"id": "0", "mediaPath": "a.png", "sourceKind": "image", "recipe": {}, "durationInFrames": 10, "fps": 24, "width": 1920, "height": 1080, "outPath": str(tmp_path / "0.mp4")},
        {"id": "1", "mediaPath": "b.png", "sourceKind": "image", "recipe": {}, "durationInFrames": 10, "fps": 24, "width": 1920, "height": 1080, "outPath": str(tmp_path / "1.mp4")},
    ]
    assert export_engine._batch_render_motion_graphics(items, tmp_path, tmp_path) == {}
    # Scratch files are cleaned up regardless of outcome.
    assert not (tmp_path / "motion_batch_spec.json").exists()
    assert not (tmp_path / "motion_batch_results.json").exists()


def test_batch_render_motion_graphics_reports_progress_as_clips_complete(tmp_path, monkeypatch):
    # Root-cause coverage for the "stuck at 5% for ages" fix: each
    # "PROGRESS done total" line from the child process must turn into an
    # engine.report_progress call, not just get silently consumed — this is
    # what keeps a batch of genuinely Remotion-bound clips (Tier 2/4/5)
    # visibly moving instead of parking the export bar at a fixed percent
    # for the whole batch's wall-clock time.
    monkeypatch.setattr(export_engine, "_ensure_motion_engine_ready", lambda: None)
    monkeypatch.setattr(export_engine, "_resolve_node_bin", lambda name: f"/fake/{name}")
    monkeypatch.setattr(
        export_engine.subprocess, "Popen",
        lambda args, **kwargs: _FakeBatchProcess(
            args, stdout_lines=["PROGRESS 1 2\n", "PROGRESS 2 2\n"],
            write_results=[{"id": "0", "ok": True}, {"id": "1", "ok": True}],
        ),
    )
    reported = []
    monkeypatch.setattr(export_engine.engine, "report_progress", lambda percent, *a: reported.append(percent))
    items = [
        {"id": "0", "mediaPath": "a.png", "sourceKind": "image", "recipe": {}, "durationInFrames": 10, "fps": 24, "width": 1920, "height": 1080, "outPath": str(tmp_path / "0.mp4")},
        {"id": "1", "mediaPath": "b.png", "sourceKind": "image", "recipe": {}, "durationInFrames": 10, "fps": 24, "width": 1920, "height": 1080, "outPath": str(tmp_path / "1.mp4")},
    ]
    export_engine._batch_render_motion_graphics(items, tmp_path, tmp_path)
    assert reported == [7, 10]  # 5 + round((1/2)*5), 5 + round((2/2)*5)


def test_batch_render_motion_graphics_all_items_fall_back_when_the_process_itself_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(export_engine, "_ensure_motion_engine_ready", lambda: None)
    monkeypatch.setattr(export_engine, "_resolve_node_bin", lambda name: f"/fake/{name}")
    monkeypatch.setattr(
        export_engine.subprocess, "Popen",
        lambda args, **kwargs: _FakeBatchProcess(args, returncode=1, stderr_lines=["node crashed\n"]),
    )

    items = [{"id": "0", "mediaPath": "a.png", "sourceKind": "image", "recipe": {}, "durationInFrames": 10, "fps": 24, "width": 1920, "height": 1080, "outPath": str(tmp_path / "0.mp4")}]
    errors = export_engine._batch_render_motion_graphics(items, tmp_path, tmp_path)
    assert "0" in errors


def test_batch_render_motion_graphics_reports_only_the_items_that_actually_failed(tmp_path, monkeypatch):
    monkeypatch.setattr(export_engine, "_ensure_motion_engine_ready", lambda: None)
    monkeypatch.setattr(export_engine, "_resolve_node_bin", lambda name: f"/fake/{name}")
    monkeypatch.setattr(
        export_engine.subprocess, "Popen",
        lambda args, **kwargs: _FakeBatchProcess(
            args,
            # id "1" never reported at all (crashed mid-batch) — must still
            # surface as a failure for that one item, not silently trusted.
            write_results=[{"id": "0", "ok": True}, {"id": "2", "ok": False, "error": "render failed"}],
        ),
    )
    items = [
        {"id": "0", "mediaPath": "a.png", "sourceKind": "image", "recipe": {}, "durationInFrames": 10, "fps": 24, "width": 1920, "height": 1080, "outPath": str(tmp_path / "0.mp4")},
        {"id": "1", "mediaPath": "b.png", "sourceKind": "image", "recipe": {}, "durationInFrames": 10, "fps": 24, "width": 1920, "height": 1080, "outPath": str(tmp_path / "1.mp4")},
        {"id": "2", "mediaPath": "c.png", "sourceKind": "image", "recipe": {}, "durationInFrames": 10, "fps": 24, "width": 1920, "height": 1080, "outPath": str(tmp_path / "2.mp4")},
    ]
    errors = export_engine._batch_render_motion_graphics(items, tmp_path, tmp_path)
    assert set(errors.keys()) == {"1", "2"}


# Root-cause coverage for the other half of the "clip-to-clip transitions
# don't apply" fix: once expand_join_transitions is willing to build a
# virtually-extended tail window for a video-kind outgoing segment (see the
# tests above), _encode_segment_to_path must actually be able to render that
# window — its existing stale-asset tpad safety net (previously only
# exercised by a resized/mismatched "Adjust animation to duration" slot)
# needs to engage here too, holding the source's last real frame for
# whatever time the requested window runs past the clip's own real
# duration, since real footage can't be extended any other way.
def test_encode_segment_pads_a_virtually_extended_video_tail_with_a_cloned_last_frame(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(export_engine, "run_ffmpeg", lambda args: calls.append(args))

    fps = 24
    transition_frames = 12  # 0.5s virtual extension past the real 4.0s clip
    tail_segment = {
        "kind": "video", "path": "/tmp/clip.mp4",
        "start": 0.0, "end": 4.0 + transition_frames / fps,
        "frames": transition_frames, "_originalFrames": 96 + transition_frames, "_trimStartFrames": 96,
        "sourceDurationSeconds": 4.0, "transitionIn": "cut", "transitionOut": "cut",
    }
    export_engine._encode_segment_to_path(tail_segment, tmp_path / "seg_a.ts", 1920, 1080, fps)

    assert len(calls) == 1
    vf = calls[0][calls[0].index("-vf") + 1]
    assert "tpad=stop_mode=clone" in vf
    assert calls[0][calls[0].index("-frames:v") + 1] == str(transition_frames)


# Root-cause coverage for a real crash: "Error opening input file
# ...seg_0002_a.ts ... Invalid data found when processing input". On a
# timeline with many recipe-bearing clips, every join transition's tail/head
# window used to fall back to `_render_motion_graphic`'s own fresh Node/
# webpack/Chromium cold start, all running concurrently (one per
# ThreadPoolExecutor worker) alongside every other segment — dozens of
# simultaneous Chromium processes on a real multi-clip export, occasionally
# producing a truncated (invalid) intermediate file under the resulting
# memory/handle pressure. Folding transition tail/head windows into the same
# upfront batch as every other motion-graphic clip (see run()'s own comment)
# removes the concurrency entirely; these two tests cover the two new pieces
# that make that possible.
def test_transition_tail_head_segments_matches_the_shapes_build_transition_segment_encodes():
    fps = 24
    transition_frames = 12
    segment_a = {
        "kind": "video", "path": "/tmp/a.mp4", "start": 0.0, "end": 4.0,
        "frames": 96, "_originalFrames": 96, "sourceDurationSeconds": 4.0,
        "motionGraphicEffect": "Manual: Push In", "motionGraphicSettings": {"cameraEffect": "push_in"},
    }
    segment_b = {
        "kind": "image", "path": "/tmp/b.png", "start": 4.0, "end": 7.0,
        "frames": 60, "_originalFrames": 72, "_trimStartFrames": 12,
        "motionGraphicEffect": "Manual: Zoom Out", "motionGraphicSettings": {"cameraEffect": "zoom_out"},
    }
    transition = {
        "kind": "transition", "frames": transition_frames, "transitionType": "cross-fade",
        "segmentA": segment_a, "segmentB": segment_b,
    }
    tail, head = export_engine._transition_tail_head_segments(transition, fps)
    assert tail["end"] == 4.0 + transition_frames / fps
    assert tail["frames"] == transition_frames
    assert tail["_originalFrames"] == 96 + transition_frames
    assert tail["_trimStartFrames"] == 96
    assert tail["motionGraphicSettings"] is segment_a["motionGraphicSettings"]
    assert head["frames"] == transition_frames
    assert head["_originalFrames"] == 72
    assert head["_trimStartFrames"] == 0
    assert head["motionGraphicSettings"] is segment_b["motionGraphicSettings"]


def test_build_transition_segment_reuses_pre_rendered_tail_and_head_raw_paths(tmp_path, monkeypatch):
    monkeypatch.setattr(
        export_engine, "_render_motion_graphic",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("should not fall back to a per-clip Remotion render")),
    )
    calls = []
    monkeypatch.setattr(export_engine, "run_ffmpeg", lambda args: calls.append(args))

    fps = 24
    tail_raw = tmp_path / "tail.raw.mp4"
    head_raw = tmp_path / "head.raw.mp4"
    tail_raw.write_bytes(b"fake-tail")
    head_raw.write_bytes(b"fake-head")
    segment_a = {
        "kind": "video", "path": "/tmp/a.mp4", "start": 0.0, "end": 4.0,
        "frames": 96, "_originalFrames": 96, "sourceDurationSeconds": 4.0,
        "colorFilter": "none", "colorFilterIntensity": 50.0,
        "motionGraphicEffect": "Manual: Push In", "motionGraphicSettings": {"cameraEffect": "push_in", "depthEffect": "parallax_3d"},
    }
    segment_b = {
        "kind": "image", "path": "/tmp/b.png", "start": 4.0, "end": 7.0,
        "frames": 60, "_originalFrames": 72, "_trimStartFrames": 0,
        "colorFilter": "none", "colorFilterIntensity": 50.0,
        "motionGraphicEffect": "Manual: Zoom Out", "motionGraphicSettings": {"cameraEffect": "zoom_out", "depthEffect": "parallax_3d"},
    }
    transition = {
        "kind": "transition", "frames": 12, "transitionType": "cross-fade",
        "segmentA": segment_a, "segmentB": segment_b,
        "_preRenderedTailRawPath": str(tail_raw), "_preRenderedHeadRawPath": str(head_raw),
    }
    out_path = tmp_path / "seg_0002.ts"
    export_engine._build_transition_segment(transition, 2, 1920, 1080, fps, tmp_path, out_path)

    # Both intermediate encodes (tail + head) fed straight from the
    # pre-rendered raw clips into ffmpeg, plus the final xfade combine call.
    assert len(calls) == 3
    assert str(tail_raw) in calls[0]
    assert str(head_raw) in calls[1]


# Root-cause coverage for a real user's export failure: "Could not install
# the motion-graphics render engine: ... UNC paths are not supported.
# Defaulting to Windows directory. npm error ... EPERM ...
# C:\Windows\package-lock.json". On that install, Path.resolve() handed back
# an extended-length (\\?\...) path for MOTION_ENGINE_DIR; cmd.exe (which
# npm.cmd/npx.cmd always shell out through) can't use one as a starting
# directory and silently falls back to C:\Windows instead, where npm then
# has no write permission — a confusing failure with no obvious link back to
# the real cause. _without_extended_path_prefix strips it so the same real
# location survives being handed to cmd.exe as `cwd=`.
def test_without_extended_path_prefix_strips_the_win32_prefix():
    stripped = export_engine._without_extended_path_prefix(Path("\\\\?\\D:\\Rahim\\Business\\YouTube\\Auto Gen Studio\\motion-engine"))
    assert str(stripped) == "D:\\Rahim\\Business\\YouTube\\Auto Gen Studio\\motion-engine"


def test_without_extended_path_prefix_strips_the_unc_variant():
    stripped = export_engine._without_extended_path_prefix(Path("\\\\?\\UNC\\server\\share\\motion-engine"))
    assert str(stripped) == "\\\\server\\share\\motion-engine"


def test_without_extended_path_prefix_leaves_a_plain_path_unchanged():
    plain = Path("D:\\Rahim\\Business\\YouTube\\Auto Gen Studio\\motion-engine")
    assert export_engine._without_extended_path_prefix(plain) == plain


# Root-cause coverage for another real user's export failure: "Motion-graphics
# render failed ... npm error could not determine executable to run". The old
# readiness check only asked whether MOTION_ENGINE_DIR/node_modules *existed*
# — an install interrupted partway (network drop, disk space, antivirus) can
# leave that folder behind without the `remotion` package actually in it,
# and its mere existence then permanently skipped every future (re)install
# attempt too, so the broken state never healed on its own.
def test_motion_engine_installed_is_false_when_node_modules_missing_entirely(tmp_path, monkeypatch):
    monkeypatch.setattr(export_engine, "MOTION_ENGINE_DIR", tmp_path)
    assert export_engine._motion_engine_installed() is False


def test_motion_engine_installed_is_false_for_a_broken_partial_install(tmp_path, monkeypatch):
    # node_modules exists (the old check's entire signal) but the actual
    # remotion bin never got written into it — exactly the shape of an
    # interrupted npm install.
    (tmp_path / "node_modules").mkdir()
    monkeypatch.setattr(export_engine, "MOTION_ENGINE_DIR", tmp_path)
    assert export_engine._motion_engine_installed() is False


def test_motion_engine_installed_is_true_once_the_remotion_bin_exists(tmp_path, monkeypatch):
    bin_dir = tmp_path / "node_modules" / ".bin"
    bin_dir.mkdir(parents=True)
    (bin_dir / "remotion.cmd").write_text("@echo off", encoding="utf-8")
    monkeypatch.setattr(export_engine, "MOTION_ENGINE_DIR", tmp_path)
    assert export_engine._motion_engine_installed() is True


def _mark_installed(tmp_path: Path) -> None:
    bin_dir = tmp_path / "node_modules" / ".bin"
    bin_dir.mkdir(parents=True)
    (bin_dir / "remotion.cmd").write_text("@echo off", encoding="utf-8")


def test_ensure_motion_engine_ready_skips_install_when_already_healthy(tmp_path, monkeypatch):
    _mark_installed(tmp_path)
    monkeypatch.setattr(export_engine, "MOTION_ENGINE_DIR", tmp_path)
    monkeypatch.setattr(export_engine.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(AssertionError("should not run npm")))
    monkeypatch.setattr(export_engine, "_ensure_remotion_browser_downloaded", lambda: None)
    export_engine._ensure_motion_engine_ready()  # no exception == no (re)install attempted


def test_ensure_motion_engine_ready_prefers_npm_ci_when_lockfile_bundled(tmp_path, monkeypatch):
    (tmp_path / "package-lock.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(export_engine, "MOTION_ENGINE_DIR", tmp_path)
    monkeypatch.setattr(export_engine, "_resolve_node_bin", lambda name: f"/fake/{name}")
    monkeypatch.setattr(export_engine, "_ensure_remotion_browser_downloaded", lambda: None)
    calls = []

    def fake_run(args, **kwargs):
        calls.append(args)
        _mark_installed(tmp_path)  # simulate npm actually installing it
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(export_engine.subprocess, "run", fake_run)
    export_engine._ensure_motion_engine_ready()
    assert calls == [["/fake/npm", "ci"]]


def test_ensure_motion_engine_ready_falls_back_to_npm_install_without_a_lockfile(tmp_path, monkeypatch):
    monkeypatch.setattr(export_engine, "MOTION_ENGINE_DIR", tmp_path)
    monkeypatch.setattr(export_engine, "_resolve_node_bin", lambda name: f"/fake/{name}")
    monkeypatch.setattr(export_engine, "_ensure_remotion_browser_downloaded", lambda: None)
    calls = []

    def fake_run(args, **kwargs):
        calls.append(args)
        _mark_installed(tmp_path)
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(export_engine.subprocess, "run", fake_run)
    export_engine._ensure_motion_engine_ready()
    assert calls == [["/fake/npm", "install"]]


def test_ensure_motion_engine_ready_raises_a_clear_error_when_npm_itself_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(export_engine, "MOTION_ENGINE_DIR", tmp_path)
    monkeypatch.setattr(export_engine, "_resolve_node_bin", lambda name: f"/fake/{name}")
    monkeypatch.setattr(export_engine.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=1, stderr="network error"))
    with pytest.raises(RuntimeError, match="Could not install"):
        export_engine._ensure_motion_engine_ready()


# Root-cause coverage for a real user's report: `npm ci`'s own internal
# "delete node_modules first" step hit a transient Windows file lock
# (ENOTEMPTY), left node_modules in a broken partial state, and the install
# that followed failed too (ENOENT trying to cd into node_modules/webpack) —
# a second plain retry alone doesn't fix this, it hits the same partial
# state again. _ensure_motion_engine_ready must clean up itself and retry.
def test_ensure_motion_engine_ready_cleans_up_and_retries_after_a_broken_npm_ci(tmp_path, monkeypatch):
    (tmp_path / "package-lock.json").write_text("{}", encoding="utf-8")
    stale_node_modules = tmp_path / "node_modules"
    (stale_node_modules / "webpack").mkdir(parents=True)  # left-behind partial state
    monkeypatch.setattr(export_engine, "MOTION_ENGINE_DIR", tmp_path)
    monkeypatch.setattr(export_engine, "_resolve_node_bin", lambda name: f"/fake/{name}")
    monkeypatch.setattr(export_engine, "_ensure_remotion_browser_downloaded", lambda: None)
    calls = []

    def fake_run(args, **kwargs):
        calls.append(list(args))
        if args == ["/fake/npm", "ci"]:
            return SimpleNamespace(returncode=1, stderr="npm error enoent ENOENT: Cannot cd into node_modules/webpack")
        if args == ["/fake/npm", "install"]:
            _mark_installed(tmp_path)
            return SimpleNamespace(returncode=0, stderr="")
        raise AssertionError(f"unexpected npm invocation: {args}")

    monkeypatch.setattr(export_engine.subprocess, "run", fake_run)
    export_engine._ensure_motion_engine_ready()  # no exception == recovered
    assert calls == [["/fake/npm", "ci"], ["/fake/npm", "install"]]
    assert not stale_node_modules.exists() or (stale_node_modules / ".bin" / "remotion.cmd").exists()


def test_robust_rmtree_retries_through_a_transient_failure(tmp_path, monkeypatch):
    target = tmp_path / "node_modules"
    (target / "pkg").mkdir(parents=True)
    attempts = {"count": 0}
    real_rmtree = export_engine.shutil.rmtree

    def flaky_rmtree(path):
        attempts["count"] += 1
        if attempts["count"] < 3:
            raise OSError("ENOTEMPTY: directory not empty")
        real_rmtree(path)

    monkeypatch.setattr(export_engine.shutil, "rmtree", flaky_rmtree)
    monkeypatch.setattr(export_engine.time, "sleep", lambda *_: None)
    export_engine._robust_rmtree(target)
    assert attempts["count"] == 3
    assert not target.exists()


def test_robust_rmtree_raises_the_last_error_after_exhausting_attempts(tmp_path, monkeypatch):
    target = tmp_path / "node_modules"
    target.mkdir()
    monkeypatch.setattr(export_engine.shutil, "rmtree", lambda path: (_ for _ in ()).throw(OSError("still locked")))
    monkeypatch.setattr(export_engine.time, "sleep", lambda *_: None)
    with pytest.raises(OSError, match="still locked"):
        export_engine._robust_rmtree(target, attempts=3, delay_seconds=0)


# Root-cause coverage for a second real user's crash: Remotion's own lazy,
# on-first-render Chromium download failed
# ('ENOENT ... chrome-headless-shell-win64.zip') as an unhandled promise
# rejection with a raw Node stack trace and no indication of what to do.
def test_ensure_remotion_browser_downloaded_succeeds_quietly(tmp_path, monkeypatch):
    monkeypatch.setattr(export_engine, "MOTION_ENGINE_DIR", tmp_path)
    monkeypatch.setattr(export_engine, "_resolve_node_bin", lambda name: f"/fake/{name}")
    monkeypatch.setattr(export_engine.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=0, stderr="", stdout=""))
    export_engine._ensure_remotion_browser_downloaded()  # no exception == success


def test_ensure_remotion_browser_downloaded_raises_a_clear_actionable_error(tmp_path, monkeypatch):
    monkeypatch.setattr(export_engine, "MOTION_ENGINE_DIR", tmp_path)
    monkeypatch.setattr(export_engine, "_resolve_node_bin", lambda name: f"/fake/{name}")
    monkeypatch.setattr(
        export_engine.subprocess, "run",
        lambda *a, **k: SimpleNamespace(returncode=1, stderr="ENOENT ... chrome-headless-shell-win64.zip", stdout=""),
    )
    with pytest.raises(RuntimeError, match="headless Chromium"):
        export_engine._ensure_remotion_browser_downloaded()


def test_ensure_motion_engine_ready_raises_when_npm_reports_success_but_bin_still_missing(tmp_path, monkeypatch):
    # A successful npm exit code that somehow still didn't produce a usable
    # remotion bin (e.g. a registry/optional-dependency quirk) must not be
    # silently trusted — it should surface as an actionable error rather
    # than letting a later render fail with the confusing npx error again.
    monkeypatch.setattr(export_engine, "MOTION_ENGINE_DIR", tmp_path)
    monkeypatch.setattr(export_engine, "_resolve_node_bin", lambda name: f"/fake/{name}")
    monkeypatch.setattr(export_engine.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=0, stderr=""))
    with pytest.raises(RuntimeError, match="isn't available"):
        export_engine._ensure_motion_engine_ready()


def test_render_motion_graphic_passes_no_install_to_npx_so_failures_are_clear(tmp_path, monkeypatch):
    monkeypatch.setattr(export_engine, "_ensure_motion_engine_ready", lambda: None)
    monkeypatch.setattr(export_engine, "_resolve_node_bin", lambda name: f"/fake/{name}")
    monkeypatch.setattr(export_engine, "MOTION_ENGINE_DIR", tmp_path)
    calls = []

    def fake_run(args, **kwargs):
        calls.append(args)
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(export_engine.subprocess, "run", fake_run)
    media = tmp_path / "still.png"
    media.write_bytes(b"fake")
    export_engine._render_motion_graphic(str(media), "image", "Manual: Push In", {}, 48, 24, 1920, 1080, tmp_path / "out.mp4")

    assert calls[0][0] == "/fake/npx"
    assert "--no-install" in calls[0]
    assert calls[0].index("--no-install") < calls[0].index("remotion")


# Root-cause coverage for two render-speed fixes: this clip's own audio is
# never used downstream (confirmed by reading every caller of
# _render_motion_graphic — video kind always re-encodes with its own -an,
# image kind never maps an audio stream from it at all), so --muted skips
# Remotion's own audio encode pass for free; and an explicit --concurrency
# keeps N concurrent Remotion processes (one per ThreadPoolExecutor worker)
# from each independently trying to use most of the machine's cores and
# oversubscribing the CPU collectively.
def test_render_motion_graphic_passes_muted_and_bounded_concurrency(tmp_path, monkeypatch):
    monkeypatch.setattr(export_engine, "_ensure_motion_engine_ready", lambda: None)
    monkeypatch.setattr(export_engine, "_resolve_node_bin", lambda name: f"/fake/{name}")
    monkeypatch.setattr(export_engine, "MOTION_ENGINE_DIR", tmp_path)
    calls = []
    monkeypatch.setattr(export_engine.subprocess, "run", lambda args, **k: (calls.append(args), SimpleNamespace(returncode=0, stderr=""))[1])

    media = tmp_path / "still.png"
    media.write_bytes(b"fake")
    export_engine._render_motion_graphic(str(media), "image", "Manual: Push In", {}, 48, 24, 1920, 1080, tmp_path / "out.mp4")

    assert "--muted" in calls[0]
    assert any(arg.startswith("--concurrency=") for arg in calls[0])


def test_remotion_concurrency_divides_cores_across_encode_workers(monkeypatch):
    monkeypatch.setattr(export_engine.os, "cpu_count", lambda: 16)
    assert export_engine._remotion_concurrency() == 16 // export_engine.MAX_ENCODE_WORKERS


def test_remotion_concurrency_never_drops_below_one_on_a_low_core_machine(monkeypatch):
    monkeypatch.setattr(export_engine.os, "cpu_count", lambda: 2)
    assert export_engine._remotion_concurrency() == 1


def test_remotion_concurrency_falls_back_when_cpu_count_is_unknown(monkeypatch):
    monkeypatch.setattr(export_engine.os, "cpu_count", lambda: None)
    assert export_engine._remotion_concurrency() >= 1


# Root-cause coverage for the new "transition intensity" slider (global
# Motion tool + per-still Motion panel): build_segments used to always drop
# transitionIntensity on the floor even though transitionIn/transitionOut
# were already forwarded — these pin that it now travels through for every
# still shape the way transitionIn/Out already do.
def test_build_segments_forwards_transition_intensity_for_image_stills():
    stills = [{"kind": "image", "imagePath": "/tmp/a.png", "start": 0.0, "end": 3.0, "transitionIntensity": 80.0}]
    segment = export_engine.build_segments(stills, 3.0)[0]
    assert segment["transitionIntensity"] == 80.0


def test_build_segments_defaults_transition_intensity_to_fifty():
    stills = [{"kind": "image", "imagePath": "/tmp/a.png", "start": 0.0, "end": 3.0}]
    segment = export_engine.build_segments(stills, 3.0)[0]
    assert segment["transitionIntensity"] == 50.0


def test_build_segments_forwards_transition_intensity_for_video_stills():
    stills = [{"kind": "video", "videoPath": "/tmp/clip.mp4", "start": 0.0, "end": 3.0, "transitionIntensity": 12.0}]
    segment = next(s for s in export_engine.build_segments(stills, 3.0) if s["kind"] == "video")
    assert segment["transitionIntensity"] == 12.0


# Root-cause coverage for the fade duration itself actually scaling with the
# slider, not just being carried as inert metadata — _scaled_fade_seconds
# backs both build_image_filter's and build_video_filter's fade-in/out
# windows and the motion-graphic branch of _encode_segment_to_path.
def test_scaled_fade_seconds_grows_with_intensity():
    low = export_engine._scaled_fade_seconds(10.0, 0.0)
    mid = export_engine._scaled_fade_seconds(10.0, 50.0)
    high = export_engine._scaled_fade_seconds(10.0, 100.0)
    assert low < mid < high
    assert low == 0.2  # 10 * 0.02, above the 0.15s floor
    assert high == 1.5  # 10 * 0.15


def test_scaled_fade_seconds_floors_short_clips_regardless_of_intensity():
    # The proportion never exceeds 15% of the clip's own duration, so
    # duration*fraction is always well under the 0.15s floor for a clip this
    # short — the floor is what actually protects it, at any intensity.
    assert export_engine._scaled_fade_seconds(0.5, 0.0) == 0.15
    assert export_engine._scaled_fade_seconds(0.5, 100.0) == 0.15


# Root-cause coverage for expand_join_transitions actually respecting the
# slider (previously the join-transition window was purely a function of the
# two clips' own durations, with no user-adjustable knob at all).
def test_expand_join_transitions_scales_within_type_bounds_by_intensity():
    fps = 24
    segments = [
        {"kind": "image", "start": 0.0, "end": 5.0, "frames": 120, "transitionOut": "cross-fade", "transitionIntensity": 0.0},
        {"kind": "image", "start": 5.0, "end": 10.0, "frames": 120},
    ]
    low = export_engine.expand_join_transitions([dict(s) for s in segments], fps)
    transition_low = next(s for s in low if s["kind"] == "transition")

    segments[0]["transitionIntensity"] = 100.0
    high = export_engine.expand_join_transitions([dict(s) for s in segments], fps)
    transition_high = next(s for s in high if s["kind"] == "transition")

    assert transition_low["frames"] < transition_high["frames"]
    # cross-fade has no per-type override, so it uses the generic (0.2, 0.75)
    # bounds — well under the 1/3-of-5s safety cap either way.
    assert transition_low["frames"] == round(0.2 * fps)
    assert transition_high["frames"] == round(0.75 * fps)


def test_expand_join_transitions_intensity_still_capped_by_short_clip_safety_net():
    fps = 24
    # Both clips only 1s long: 1/3 of that is well below cross-fade's 0.75s
    # max-intensity bound, so the cap (not the slider) should win.
    segments = [
        {"kind": "image", "start": 0.0, "end": 1.0, "frames": 24, "transitionOut": "cross-fade", "transitionIntensity": 100.0},
        {"kind": "image", "start": 1.0, "end": 2.0, "frames": 24},
    ]
    expanded = export_engine.expand_join_transitions(segments, fps)
    transition = next(s for s in expanded if s["kind"] == "transition")
    assert transition["frames"] == round((1.0 / 3) * fps)


# Root-cause coverage for "transitions aren't applied to clips or
# animations, only stills": expand_join_transitions used to require the
# OUTGOING segment to be kind == "image" — a "video" (Veo animation /
# imported clip) segment could never be the one transitioning OUT via a join
# transition (cross-fade/slide/zoom-blur/whip-pan/blur), silently falling
# back to a hard cut, even though _encode_segment_to_path's existing
# stale-asset tpad safety net already makes a video-kind tail window
# renderable. These pin that a "transition" segment now gets created
# regardless of which side(s) are video.
def test_expand_join_transitions_creates_a_transition_for_video_outgoing_into_still():
    fps = 24
    segments = [
        {
            "kind": "video", "path": "/tmp/clip.mp4", "start": 0.0, "end": 4.0, "frames": 96,
            "transitionOut": "cross-fade", "sourceDurationSeconds": 4.0,
        },
        {"kind": "image", "start": 4.0, "end": 8.0, "frames": 96},
    ]
    expanded = export_engine.expand_join_transitions(segments, fps)
    transition = next((s for s in expanded if s["kind"] == "transition"), None)
    assert transition is not None
    assert transition["segmentA"]["kind"] == "video"
    assert transition["segmentB"]["kind"] == "image"


def test_expand_join_transitions_creates_a_transition_for_video_to_video():
    fps = 24
    segments = [
        {
            "kind": "video", "path": "/tmp/a.mp4", "start": 0.0, "end": 4.0, "frames": 96,
            "transitionOut": "whip-pan", "sourceDurationSeconds": 4.0,
        },
        {"kind": "video", "path": "/tmp/b.mp4", "start": 4.0, "end": 8.0, "frames": 96, "sourceDurationSeconds": 4.0},
    ]
    expanded = export_engine.expand_join_transitions(segments, fps)
    transition = next((s for s in expanded if s["kind"] == "transition"), None)
    assert transition is not None
    assert transition["segmentA"]["kind"] == "video"
    assert transition["segmentB"]["kind"] == "video"
    assert transition["transitionType"] == "whip-pan"


# Root-cause coverage for "there is some extra transition which I never set".
# Every MotionRecipe carries a fade-in/out opacity envelope that defaults to
# 14 frames at BOTH ends, and the export applied it (natively via `fade=`,
# and through MotionClip.tsx's opacity ramp over Remotion's black backdrop)
# while the Timeline canvas preview renders no such thing — applyMotionRecipe
# returns only a rect+blur, and fadeOverlay fades only for an explicit
# "fade"/"dip-to-white" transition. Measured on the user's own completed
# export with ffmpeg signalstats: a boundary set to a plain CUT ran
# YAVG 49.7 -> 0.5 -> 51.1 (a full dip to black), and a cross-fade boundary
# faded to black, popped back to full brightness, and only then cross-faded.
# Clip boundaries in the baked video are governed by transitionIn/Out alone.
def test_strip_recipe_fade_envelope_zeroes_both_ends():
    segments = [{
        "kind": "image",
        "motionGraphicSettings": {"fadeInFrames": 14, "fadeOutFrames": 14, "scaleTo": 1.2},
    }]
    export_engine.strip_recipe_fade_envelope(segments)
    settings = segments[0]["motionGraphicSettings"]
    assert settings["fadeInFrames"] == 0
    assert settings["fadeOutFrames"] == 0
    # Everything else about the recipe must survive untouched.
    assert settings["scaleTo"] == 1.2


def test_strip_recipe_fade_envelope_leaves_segments_without_a_recipe_alone():
    segments = [{"kind": "black"}, {"kind": "image", "motionGraphicSettings": None}]
    export_engine.strip_recipe_fade_envelope(segments)  # must not raise
    assert segments[0].get("motionGraphicSettings") is None
    assert segments[1]["motionGraphicSettings"] is None


def test_strip_recipe_fade_envelope_does_not_mutate_the_callers_dict():
    # build_segments forwards the manifest still's own settings dict by
    # reference; the asset-bundle export must not inherit this stripping.
    original = {"fadeInFrames": 14, "fadeOutFrames": 14}
    segments = [{"kind": "image", "motionGraphicSettings": original}]
    export_engine.strip_recipe_fade_envelope(segments)
    assert original == {"fadeInFrames": 14, "fadeOutFrames": 14}


def test_build_recipe_zoompan_filter_emits_no_envelope_fade_once_stripped():
    recipe = {"scaleFrom": 1.0, "scaleTo": 1.2, "fadeInFrames": 0, "fadeOutFrames": 0}
    vf = export_engine.build_recipe_zoompan_filter(recipe, 1920, 1080, 30, 4.0, 120)
    assert "fade=t=in" not in vf
    assert "fade=t=out" not in vf


# Root-cause coverage for "the caption looks different than the preview —
# even the style looks different". A Canvas2D `Npx` font sets the EM SQUARE
# to N px; ASS's `\fs N` does not, because libass reproduces VSFilter's
# sizing convention and ends up drawing glyphs at
# `fs * unitsPerEm / (usWinAscent + usWinDescent)` px. For the bundled Rubik
# that factor is 0.653, so captions burned in ~35% smaller than preview at
# every resolution. Measured on real burns of the real project's captions.ass:
# \fs66 rendered a 439px-wide line where the canvas draws 671px; scaling
# \fs by the reciprocal lands it at 671px exactly.
def test_libass_font_size_scale_matches_the_bundled_rubik_metrics():
    metrics = export_engine._font_metrics("Rubik")
    assert metrics is not None, "the bundled Rubik-Bold.ttf must be readable"
    assert metrics == (1000, 1066, 466)
    assert export_engine._libass_font_size_scale("Rubik") == pytest.approx(1532 / 1000)


def test_libass_font_size_scale_is_a_noop_for_an_unresolvable_font():
    # Never silently mis-size a font we cannot measure — fall back to the
    # pre-fix behavior rather than guessing.
    assert export_engine._libass_font_size_scale("NoSuchFontFamilyAnywhere") == 1.0


def test_write_captions_ass_scales_fs_up_by_the_libass_font_metric(tmp_path):
    out_path = tmp_path / "captions.ass"
    style = {"fontFamily": "Rubik", "fontSizePx": 30, "bold": True, "position": "bottom"}
    captions = [{"start": 0.0, "end": 1.0, "text": "Hello", "style": style}]
    export_engine.write_captions_ass(captions, out_path, 1920, 1080, style)

    ass_text = out_path.read_text(encoding="utf-8")
    # Canvas draws this style at (30/22)*1080*0.045 == 66px.
    canvas_px = export_engine._scaled_font_size(style, 1080)
    assert round(canvas_px) == 66
    expected = round(canvas_px * export_engine._libass_font_size_scale("Rubik"))
    assert expected == 102
    assert "\\fs{}".format(expected) in ass_text
    assert "\\fs66" not in ass_text  # the un-corrected value that burned in too small


# Root-cause coverage for the same report's line-break half: libass defaults
# to WrapStyle 0 ("smart" wrapping, which balances a wrapped caption into
# roughly equal-length lines), but drawCaptionText wraps greedily. Measured
# on a real two-line caption: libass's default broke it 1235px/1221px where
# the canvas breaks it 1492px/951px. WrapStyle 1 is greedy end-of-line
# wrapping and reproduces the canvas's own breaks to within a few pixels.
def test_write_captions_ass_requests_greedy_wrapping(tmp_path):
    out_path = tmp_path / "captions.ass"
    captions = [{"start": 0.0, "end": 1.0, "text": "Hello there", "style": None}]
    export_engine.write_captions_ass(captions, out_path, 1920, 1080, export_engine._FALLBACK_CAPTION_STYLE)
    assert "WrapStyle: 1" in out_path.read_text(encoding="utf-8")


# Root-cause coverage for the same report's "the style looks different"
# half: ASS's `\blur` softens the WHOLE rendered glyph (fill and outline),
# whereas the canvas preview's ctx.shadowBlur softens only the drop shadow
# and leaves the text razor-sharp. Emitting `\blur` on the text layer
# visibly fuzzed the outline in every export. The shadow now gets its own
# lower Dialogue layer with the fill/outline made fully transparent, so the
# blur only ever touches the shadow.
def test_write_captions_ass_keeps_the_text_layer_sharp_and_shadow_on_its_own_layer(tmp_path):
    out_path = tmp_path / "captions.ass"
    style = {
        "fontFamily": "Rubik", "fontSizePx": 30, "bold": True, "position": "bottom",
        "shadow": {"enabled": True, "color": "#000000", "opacity": 70, "blur": 30, "distance": 2, "angle": 90},
    }
    captions = [{"start": 0.0, "end": 1.0, "text": "Hello", "style": style}]
    export_engine.write_captions_ass(captions, out_path, 1920, 1080, style)

    events = [line for line in out_path.read_text(encoding="utf-8").splitlines() if line.startswith("Dialogue:")]
    shadow_line = next(line for line in events if line.startswith("Dialogue: 0,"))
    text_line = next(line for line in events if line.startswith("Dialogue: 1,"))
    # The shadow layer carries the blur and hides its own fill/outline.
    assert "\\blur" in shadow_line
    assert "\\1a&HFF&" in shadow_line and "\\3a&HFF&" in shadow_line
    # The text layer must be sharp, and must not double-draw a shadow.
    assert "\\blur" not in text_line
    assert "\\shad0" in text_line


def test_write_captions_ass_emits_no_shadow_layer_when_shadow_is_disabled(tmp_path):
    out_path = tmp_path / "captions.ass"
    style = {"fontFamily": "Rubik", "fontSizePx": 30, "shadow": {"enabled": False}}
    captions = [{"start": 0.0, "end": 1.0, "text": "Hello", "style": style}]
    export_engine.write_captions_ass(captions, out_path, 1920, 1080, style)

    events = [line for line in out_path.read_text(encoding="utf-8").splitlines() if line.startswith("Dialogue:")]
    assert len(events) == 1
    assert events[0].startswith("Dialogue: 1,")


# Root-cause coverage for the caption sitting higher in the export than in
# preview: drawCaptionText reserves exactly 0.25 * fontSize of descent below
# a bottom-aligned block's last baseline (lineHeight is fontSize * 1.25, and
# it offsets by lineHeight * 0.2), while libass reserves the font's own
# usWinDescent — 0.466 em for Rubik. That put an \an2 line a measured 15px
# too high at 1080p with the default style; correcting MarginV by the
# difference lines the two up to within a pixel.
def test_libass_margin_v_correction_lifts_a_bottom_caption_by_the_descent_difference():
    correction = export_engine._libass_margin_v_correction("Rubik", "bottom", 66.0)
    assert correction == pytest.approx((466 / 1000 - 0.25) * 66.0)
    assert round(correction) == 14


def test_libass_margin_v_correction_is_zero_for_middle_and_unknown_fonts():
    # \an5 centres vertically and ignores MarginV entirely.
    assert export_engine._libass_margin_v_correction("Rubik", "middle", 66.0) == 0.0
    assert export_engine._libass_margin_v_correction("NoSuchFont", "bottom", 66.0) == 0.0


def test_write_captions_ass_emits_the_corrected_margin_on_each_dialogue(tmp_path):
    out_path = tmp_path / "captions.ass"
    style = {"fontFamily": "Rubik", "fontSizePx": 30, "position": "bottom", "shadow": {"enabled": False}}
    captions = [{"start": 0.0, "end": 1.0, "text": "Hello", "style": style}]
    export_engine.write_captions_ass(captions, out_path, 1920, 1080, style)

    text_line = next(
        line for line in out_path.read_text(encoding="utf-8").splitlines() if line.startswith("Dialogue: 1,")
    )
    # Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
    margin_v = int(text_line.split(",")[7])
    nominal = round(1080 * 0.05)
    assert margin_v == round(nominal - export_engine._libass_margin_v_correction("Rubik", "bottom", 66.0))
    assert margin_v < nominal


# Root-cause coverage for "the cross fade transition when rendered shows a
# jitter on the screen as well ... I don't see it in the preview it only
# happens in the fully rendered video". "cross-fade" used to map onto
# ffmpeg's xfade "dissolve", on the (backwards) belief that it was a truer
# A-to-B blend than xfade's "fade". ffmpeg's `dissolve` is a RANDOM
# PER-PIXEL dissolve — each pixel independently flips from A to B against a
# random threshold — so every blended frame is a fresh field of static and
# the transition crawls with full-screen noise. Measured by xfading two FLAT
# solid colours: at the midpoint `fade` yields exactly 1 distinct colour
# where `dissolve` yields 98,542 (per-channel std ~91); on the user's real
# export, per-frame high-frequency energy ran 1.8 -> 146.7 across the 13
# blended frames. Both have the same MEAN brightness, which is why a
# brightness-over-time check reads as a smooth ramp and misses it entirely.
# The canvas preview cross-fades with `ctx.globalAlpha = progress`
# (drawJoinTransitionFrame), i.e. a plain linear blend == xfade's "fade".
def test_cross_fade_maps_to_the_linear_xfade_not_the_random_dissolve():
    assert export_engine._XFADE_TRANSITION_NAMES["cross-fade"] == "fade"
    # "dissolve" is ffmpeg's randomised noise dissolve — it must never be
    # what a user-facing "cross-fade" resolves to.
    assert "dissolve" not in export_engine._XFADE_TRANSITION_NAMES.values()


def test_every_join_transition_has_an_xfade_mapping():
    # A missing entry silently falls back to `_build_transition_segment`'s
    # own default, which would quietly render the wrong transition.
    for transition in export_engine.JOIN_TRANSITIONS:
        assert transition in export_engine._XFADE_TRANSITION_NAMES


# Root-cause coverage for the second half of "the cross fade transition when
# rendered shows a jitter on the screen": a join transition renders the
# outgoing clip virtually extended past its nominal end so the blend has
# footage (see expand_join_transitions), and the camera move used to
# normalise its 0->1 progress over that LONGER length. The same clip
# therefore ran a different, slower curve inside the transition than in its
# own segment, and the picture jumped backwards at the join. Measured on a
# real 4K export: the transition's first frame is pure clip A (xfade
# progress 0, no blending at all) yet differed from the frame before it by
# 13.7x the local per-frame motion; across the 87-still project's 86
# transitions the implied jump was a median 3.6px and up to 8.8px of edge
# displacement. The render length (_originalFrames) still has to stay
# extended so a video source keeps playing real footage instead of freezing;
# only the motion normalisation (_motionFrames) pins to the clip's own length.
def test_transition_tail_pins_motion_to_the_clips_own_length():
    fps = 30
    segments = [
        {"kind": "image", "start": 0.0, "end": 10.0, "frames": 300, "transitionOut": "cross-fade"},
        {"kind": "image", "start": 10.0, "end": 20.0, "frames": 300},
    ]
    expanded = export_engine.expand_join_transitions(segments, fps)
    transition = next(s for s in expanded if s["kind"] == "transition")
    tail, head = export_engine._transition_tail_head_segments(transition, fps)
    t_frames = transition["frames"]
    # The render window still runs past the nominal end...
    assert tail["_originalFrames"] == 300 + t_frames
    # ...but the camera move stays normalised to the clip's real length, so
    # the tail is the exact continuation of the clip's own segment.
    assert tail["_motionFrames"] == 300
    # The incoming side was always correct — it re-uses its own clip's real
    # length — and must stay that way.
    assert head["_originalFrames"] == 300
    assert head.get("_motionFrames", 300) == 300


def test_build_recipe_zoompan_filter_normalises_progress_to_motion_frames():
    recipe = {"scaleFrom": 1.0, "scaleTo": 1.2}
    # Rendering 314 frames but normalising the move over the clip's real 300.
    vf = export_engine.build_recipe_zoompan_filter(
        recipe, 1920, 1080, 30, 10.47, 314, motion_frames=300
    )
    assert "min(1,on/299)" in vf
    assert "min(1,on/313)" not in vf  # the stretched curve that caused the pop
    # zoompan must still emit the full rendered length.
    assert "d=314" in vf


def test_build_recipe_zoompan_filter_defaults_motion_frames_to_the_render_length():
    recipe = {"scaleFrom": 1.0, "scaleTo": 1.2}
    plain = export_engine.build_recipe_zoompan_filter(recipe, 1920, 1080, 30, 10.0, 300)
    explicit = export_engine.build_recipe_zoompan_filter(
        recipe, 1920, 1080, 30, 10.0, 300, motion_frames=300
    )
    assert plain == explicit
    assert "min(1,on/299)" in plain


# --- Hardware-accelerated final pass + the no-caption stream-copy skip -----
# Root-cause coverage for "even without Remotion, a 4K high-quality export
# takes hours": the final concat pass always fully decoded+re-encoded the
# WHOLE video via CPU libx264, even when there was nothing to filter.
# Measured on a real (no discrete GPU) dev machine: a matched-quality 4K
# final pass went from ~20fps on libx264 "fast" to ~83fps on Quick Sync.


@pytest.fixture(autouse=True)
def _reset_hardware_encoder_cache():
    """`_hw_encoder_cache`/`_hwaccel_decode_cache` are process-lifetime
    caches (see `_detect_hardware_encoder`/`_detect_hwaccel_decode`'s own
    comments on why) — reset them around every test in this module so one
    test's monkeypatched probe result can never leak into another's."""
    export_engine._hw_encoder_cache = None
    export_engine._hwaccel_decode_cache = None
    yield
    export_engine._hw_encoder_cache = None
    export_engine._hwaccel_decode_cache = None


def test_detect_hardware_encoder_returns_the_first_working_candidate(monkeypatch):
    def fake_run(args, **kwargs):
        return SimpleNamespace(returncode=0 if "h264_qsv" in args else 1)

    monkeypatch.setattr(export_engine.subprocess, "run", fake_run)
    assert export_engine._detect_hardware_encoder() == "h264_qsv"


def test_detect_hardware_encoder_caches_the_result(monkeypatch):
    calls = []

    def fake_run(args, **kwargs):
        calls.append(args)
        return SimpleNamespace(returncode=0 if "h264_nvenc" in args else 1)

    monkeypatch.setattr(export_engine.subprocess, "run", fake_run)
    assert export_engine._detect_hardware_encoder() == "h264_nvenc"
    calls_after_first_probe = len(calls)
    assert export_engine._detect_hardware_encoder() == "h264_nvenc"
    assert len(calls) == calls_after_first_probe  # no re-probe on the second call


def test_detect_hardware_encoder_returns_none_when_every_candidate_fails(monkeypatch):
    monkeypatch.setattr(export_engine.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=1))
    assert export_engine._detect_hardware_encoder() is None


def test_detect_hardware_encoder_treats_an_exception_as_unusable(monkeypatch):
    # A candidate LISTED in `ffmpeg -encoders` can still fail at the actual
    # subprocess level (confirmed on a real machine: h264_amf raised past its
    # own "DLL failed to open" error) — must be treated the same as a clean
    # non-zero exit, not propagate and abort the whole probe.
    monkeypatch.setattr(export_engine.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(OSError("no such device")))
    assert export_engine._detect_hardware_encoder() is None


def test_disable_hardware_encoder_forces_libx264_for_the_rest_of_the_process(monkeypatch):
    monkeypatch.setattr(export_engine.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=0))
    assert export_engine._detect_hardware_encoder() is not None
    export_engine._disable_hardware_encoder()
    assert export_engine._detect_hardware_encoder() is None


def test_final_pass_video_encode_args_uses_libx264_when_no_hardware(monkeypatch):
    monkeypatch.setattr(export_engine, "_detect_hardware_encoder", lambda: None)
    assert export_engine._final_pass_video_encode_args("fast", 18) == [
        "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
    ]


def test_final_pass_video_encode_args_uses_nvenc_constant_quality_when_detected(monkeypatch):
    monkeypatch.setattr(export_engine, "_detect_hardware_encoder", lambda: "h264_nvenc")
    args = export_engine._final_pass_video_encode_args("fast", 18)
    assert args[:2] == ["-c:v", "h264_nvenc"]
    assert args[args.index("-cq") + 1] == "18"


def test_final_pass_video_encode_args_uses_qsv_global_quality_when_detected(monkeypatch):
    monkeypatch.setattr(export_engine, "_detect_hardware_encoder", lambda: "h264_qsv")
    args = export_engine._final_pass_video_encode_args("fast", 18)
    assert args[:2] == ["-c:v", "h264_qsv"]
    assert "nv12" in args


def test_final_pass_video_routing_stream_copies_when_theres_nothing_to_filter(monkeypatch):
    monkeypatch.setattr(export_engine, "_detect_hardware_encoder", lambda: None)
    video_map_args, video_encode_args = export_engine._final_pass_video_routing(None, "fast", 18, 30)
    assert video_map_args == ["-map", "0:v"]
    assert video_encode_args == ["-c:v", "copy"]


def test_final_pass_video_routing_filters_and_encodes_when_captions_are_burned_in(monkeypatch):
    monkeypatch.setattr(export_engine, "_detect_hardware_encoder", lambda: None)
    video_map_args, video_encode_args = export_engine._final_pass_video_routing(
        "ass='captions.ass'", "fast", 18, 30
    )
    assert video_map_args == ["-map", "[v]"]
    assert video_encode_args[:2] == ["-c:v", "libx264"]
    assert video_encode_args[-2:] == ["-r", "30"]


# --- Memory-exhaustion resilience (run_ffmpeg's retry/backpressure) --------
# Root-cause coverage for a real export crash: `x264 [error]: malloc of size
# 26453440 failed` on a live 4K export, ~39 minutes into a run at the normal
# 4-worker concurrency — a small allocation that only fails once the whole
# system is already critically low on memory, which sustained concurrent 4K
# encoding can build up to over a long export.


def test_wait_for_memory_headroom_returns_immediately_when_plenty_available(monkeypatch):
    monkeypatch.setattr(export_engine, "_available_memory_bytes", lambda: 8_000_000_000)
    sleeps = []
    monkeypatch.setattr(export_engine.time, "sleep", lambda s: sleeps.append(s))
    export_engine._wait_for_memory_headroom()
    assert sleeps == []


def test_wait_for_memory_headroom_returns_immediately_when_unreadable(monkeypatch):
    # Can't be read at all (e.g. non-Windows) -> must never block on it.
    monkeypatch.setattr(export_engine, "_available_memory_bytes", lambda: None)
    sleeps = []
    monkeypatch.setattr(export_engine.time, "sleep", lambda s: sleeps.append(s))
    export_engine._wait_for_memory_headroom()
    assert sleeps == []


def test_wait_for_memory_headroom_polls_until_memory_frees_up(monkeypatch):
    readings = iter([100_000_000, 100_000_000, 8_000_000_000])
    monkeypatch.setattr(export_engine, "_available_memory_bytes", lambda: next(readings))
    sleeps = []
    monkeypatch.setattr(export_engine.time, "sleep", lambda s: sleeps.append(s))
    export_engine._wait_for_memory_headroom()
    assert sleeps == [1.0, 1.0]  # polled twice before the third reading freed it up


def test_wait_for_memory_headroom_gives_up_after_the_max_wait(monkeypatch):
    monkeypatch.setattr(export_engine, "_available_memory_bytes", lambda: 0)
    sleeps = []
    monkeypatch.setattr(export_engine.time, "sleep", lambda s: sleeps.append(s))
    export_engine._wait_for_memory_headroom()
    assert len(sleeps) == int(export_engine._LOW_MEMORY_MAX_WAIT_SECONDS)


def test_run_ffmpeg_retries_once_on_a_real_oom_failure_then_succeeds(monkeypatch):
    monkeypatch.setattr(export_engine, "_wait_for_memory_headroom", lambda: None)
    monkeypatch.setattr(export_engine.time, "sleep", lambda s: None)
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        if len(calls) == 1:
            return SimpleNamespace(returncode=1, stderr="x264 [error]: malloc of size 26453440 failed")
        return SimpleNamespace(returncode=0, stderr="")

    monkeypatch.setattr(export_engine.subprocess, "run", fake_run)
    export_engine.run_ffmpeg(["-y", "-i", "in.mp4", "out.mp4"])  # must not raise
    assert len(calls) == 2


def test_run_ffmpeg_gives_up_after_exhausting_its_retries(monkeypatch):
    monkeypatch.setattr(export_engine, "_wait_for_memory_headroom", lambda: None)
    monkeypatch.setattr(export_engine.time, "sleep", lambda s: None)
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return SimpleNamespace(returncode=1, stderr="x264 [error]: malloc of size 26453440 failed")

    monkeypatch.setattr(export_engine.subprocess, "run", fake_run)
    with pytest.raises(RuntimeError):
        export_engine.run_ffmpeg(["-y", "-i", "in.mp4", "out.mp4"])
    assert len(calls) == 3  # first attempt + 2 retries, then it actually raises


def test_run_ffmpeg_does_not_retry_an_unrelated_failure(monkeypatch):
    monkeypatch.setattr(export_engine, "_wait_for_memory_headroom", lambda: None)
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return SimpleNamespace(returncode=1, stderr="Invalid argument")

    monkeypatch.setattr(export_engine.subprocess, "run", fake_run)
    with pytest.raises(RuntimeError):
        export_engine.run_ffmpeg(["-y", "-i", "in.mp4", "out.mp4"])
    assert len(calls) == 1  # a real (non-OOM) failure must surface immediately, not retry


# --- Hardware-accelerated DECODE for the final pass -------------------
# Root-cause coverage for "I have no [discrete] GPU, CPU export is still too
# slow": decode acceleration (D3D11VA) is close to universal on Windows even
# on machines with no usable hardware ENCODER — a pure decode-side offload
# with zero effect on the encoded output, worth trying independently of
# _detect_hardware_encoder. Measured on a real (Intel iGPU, no discrete GPU)
# dev machine: the same CPU libx264 encode, same settings, went from ~24fps
# to ~64fps at 4K purely from this.


def _fake_run_writing_probe_file(args, **kwargs):
    """Stands in for `subprocess.run` in `_detect_hwaccel_decode` tests: the
    first call is the probe's own tiny libx264 encode, which must actually
    create the output file (`_detect_hwaccel_decode` checks `.exists()`, not
    just the exit code) for a mocked "success" to read as real."""
    if "-c:v" in args and "libx264" in args:
        Path(args[-1]).write_bytes(b"fake-mp4")
    return SimpleNamespace(returncode=0)


def test_detect_hwaccel_decode_true_when_probe_encode_and_decode_both_succeed(monkeypatch):
    monkeypatch.setattr(export_engine.subprocess, "run", _fake_run_writing_probe_file)
    assert export_engine._detect_hwaccel_decode() is True


def test_detect_hwaccel_decode_false_when_the_probe_encode_itself_fails(monkeypatch):
    monkeypatch.setattr(export_engine.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=1))
    assert export_engine._detect_hwaccel_decode() is False


def test_detect_hwaccel_decode_false_when_decode_fails_but_encode_succeeds(monkeypatch):
    def fake_run(args, **kwargs):
        if "-c:v" in args and "libx264" in args:
            Path(args[-1]).write_bytes(b"fake-mp4")
            return SimpleNamespace(returncode=0)
        return SimpleNamespace(returncode=1)  # the real d3d11va decode attempt

    monkeypatch.setattr(export_engine.subprocess, "run", fake_run)
    assert export_engine._detect_hwaccel_decode() is False


def test_detect_hwaccel_decode_treats_an_exception_as_unusable(monkeypatch):
    monkeypatch.setattr(export_engine.subprocess, "run", lambda *a, **k: (_ for _ in ()).throw(OSError("no such device")))
    assert export_engine._detect_hwaccel_decode() is False


def test_detect_hwaccel_decode_caches_the_result(monkeypatch):
    calls = []

    def fake_run(args, **kwargs):
        calls.append(args)
        return _fake_run_writing_probe_file(args)

    monkeypatch.setattr(export_engine.subprocess, "run", fake_run)
    assert export_engine._detect_hwaccel_decode() is True
    calls_after_first_probe = len(calls)
    assert export_engine._detect_hwaccel_decode() is True
    assert len(calls) == calls_after_first_probe  # no re-probe on the second call


def test_disable_hwaccel_decode_forces_false_for_the_rest_of_the_process(monkeypatch):
    monkeypatch.setattr(export_engine.subprocess, "run", _fake_run_writing_probe_file)
    assert export_engine._detect_hwaccel_decode() is True
    export_engine._disable_hwaccel_decode()
    assert export_engine._detect_hwaccel_decode() is False


def test_final_pass_input_hwaccel_args_empty_when_nothing_to_decode(monkeypatch):
    monkeypatch.setattr(export_engine, "_detect_hwaccel_decode", lambda: True)
    assert export_engine._final_pass_input_hwaccel_args(False) == ([], "")


def test_final_pass_input_hwaccel_args_empty_when_unavailable(monkeypatch):
    monkeypatch.setattr(export_engine, "_detect_hwaccel_decode", lambda: False)
    assert export_engine._final_pass_input_hwaccel_args(True) == ([], "")


def test_final_pass_input_hwaccel_args_when_available_and_needed(monkeypatch):
    monkeypatch.setattr(export_engine, "_detect_hwaccel_decode", lambda: True)
    extra_input_args, filter_prefix = export_engine._final_pass_input_hwaccel_args(True)
    assert extra_input_args == ["-hwaccel", "d3d11va", "-hwaccel_output_format", "d3d11"]
    assert filter_prefix == "hwdownload,format=nv12,format=yuv420p,"
