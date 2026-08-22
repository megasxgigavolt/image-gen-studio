"""
video_export_engine.py is invoked as a standalone script (its own directory
added to sys.path at run time by Python) and itself does a flat
`import scene_grouping_engine as engine` — tests import it the same way,
matching test_motion_graphics_engine.py's approach, both to exercise the
real production import shape and because scene_grouping_engine.py runs
ffmpeg discovery at module import time that only behaves correctly with its
own directory on sys.path.
"""

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
        "motionGraphicEffect": "Manual: Zoom In", "motionGraphicSettings": {"cameraEffect": "zoom_in"},
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
