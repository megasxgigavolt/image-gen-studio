import sys
from pathlib import Path

ENGINE_DIR = Path(__file__).parents[1] / "auto_gen_engine"
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from scene_grouping_engine import build_parser  # noqa: E402


def test_internal_grouping_engine_contains_extracted_pipeline():
    source = (ENGINE_DIR / "scene_grouping_engine.py").read_text(encoding="utf-8")

    required_pipeline = [
        "def align_script_to_words(",
        "def analyze_sentences_pass1(",
        "def score_boundaries_pass2(",
        "def _batch_score_boundaries_pass2(",
        "def build_ranges_from_boundaries(",
        "def normalize_groups(",
        "def normalize_scenes(",
        "def analyze_scene_context(",
        "def paragraph_scenes(",
        "def split_oversized_groups(",
        "def merge_short_groups(",
        "def optimize_durations(",
        "def validate_groups(",
    ]
    for function in required_pipeline:
        assert function in source


def test_script_understanding_argument_is_optional_and_defaults_to_none():
    """--script-understanding (the whole-script context computed once on the
    Rust side and threaded into Pass 2/3, see score_boundaries_pass2 and
    analyze_scene_context) must stay optional so every existing caller that
    doesn't pass it keeps working unchanged."""
    parser = build_parser()

    without_it = parser.parse_args(["voiceover.mp3", "script.txt"])
    assert without_it.script_understanding is None

    with_it = parser.parse_args([
        "voiceover.mp3", "script.txt",
        "--script-understanding", "understanding.txt",
    ])
    assert with_it.script_understanding == "understanding.txt"
