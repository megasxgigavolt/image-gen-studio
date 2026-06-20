from pathlib import Path


def test_internal_grouping_engine_contains_extracted_pipeline():
    source = (
        Path(__file__).parents[1]
        / "auto_gen_engine"
        / "scene_grouping_engine.py"
    ).read_text(encoding="utf-8")

    required_pipeline = [
        "def align_script_to_words(",
        "def analyze_sentences_pass1(",
        "def score_boundaries_pass2(",
        "def _batch_score_boundaries_pass2(",
        "def normalize_groups(",
        "def split_oversized_groups(",
        "def merge_short_groups(",
        "def optimize_durations(",
        "def validate_groups(",
    ]
    for function in required_pipeline:
        assert function in source
