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
