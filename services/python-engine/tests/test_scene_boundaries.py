"""
Regression coverage for the scene-boundary logic (normalize_groups/
normalize_scenes) added by the Visual Scene Segmentor feature.

Real bug this guards against: normalize_scenes originally used Pass 2's
`hard_boundary` field as the sole scene-boundary signal, but the prompt gave
the AI no explicit criteria for when to set it — in practice it came back
false for almost every transition, collapsing an entire video into a single
scene. The fix added a dedicated, explicitly-scoped `narrative_scene_
boundary` field with concrete criteria (subject/location/time/topic change,
or a new numbered list item). These tests exercise the deterministic
boundary-building logic in isolation (no AI call), using lightweight stand-
ins for Pass 2's transition/result shape rather than the real Pydantic
models, matching test_video_export_engine.py's import convention.
"""

import sys
from pathlib import Path
from types import SimpleNamespace

ENGINE_DIR = Path(__file__).parents[1] / "auto_gen_engine"
if str(ENGINE_DIR) not in sys.path:
    sys.path.insert(0, str(ENGINE_DIR))

from scene_grouping_engine import TimedSentence, normalize_groups, normalize_scenes  # noqa: E402


def _sentence(sentence_id: int) -> TimedSentence:
    return TimedSentence(
        sentence_id=sentence_id,
        paragraph_id=1,
        start=float(sentence_id),
        end=float(sentence_id) + 1.0,
        text=f"Sentence {sentence_id}.",
    )


def _transition(
    from_id: int,
    to_id: int,
    final_action: str = "merge",
    hard_boundary: bool = False,
    narrative_scene_boundary: bool = False,
) -> SimpleNamespace:
    return SimpleNamespace(
        from_sentence_id=from_id,
        to_sentence_id=to_id,
        final_action=final_action,
        hard_boundary=hard_boundary,
        narrative_scene_boundary=narrative_scene_boundary,
        dynamic_reasoning="test",
    )


def test_normalize_scenes_ignores_ordinary_still_splits():
    """A plain still-level split (final_action="split", nothing else set)
    must not, by itself, also start a new scene — otherwise scenes would be
    exactly as fine-grained as stills, defeating the point of the layer."""
    sentences = [_sentence(i) for i in range(1, 5)]
    transitions = [
        _transition(1, 2, final_action="split"),
        _transition(2, 3, final_action="split"),
        _transition(3, 4, final_action="split"),
    ]
    pass2_result = SimpleNamespace(transitions=transitions, groups=[])

    scenes = normalize_scenes(sentences, pass2_result)

    assert len(scenes) == 1
    assert (scenes[0].start_sentence_id, scenes[0].end_sentence_id) == (1, 4)


def test_normalize_scenes_splits_on_narrative_scene_boundary_or_hard_boundary():
    sentences = [_sentence(i) for i in range(1, 8)]
    transitions = [
        _transition(1, 2, final_action="split"),
        _transition(2, 3, narrative_scene_boundary=True),
        _transition(3, 4),
        _transition(4, 5, hard_boundary=True),
        _transition(5, 6, final_action="split"),
        _transition(6, 7),
    ]
    pass2_result = SimpleNamespace(transitions=transitions, groups=[])

    scenes = normalize_scenes(sentences, pass2_result)

    assert [(scene.start_sentence_id, scene.end_sentence_id) for scene in scenes] == [
        (1, 2),
        (3, 4),
        (5, 7),
    ]


def test_a_still_can_never_straddle_a_scene_boundary():
    """Every scene boundary normalize_scenes produces must also be a still
    boundary normalize_groups produces — otherwise a single still's sentence
    range could span two scenes."""
    sentences = [_sentence(i) for i in range(1, 8)]
    transitions = [
        _transition(1, 2, final_action="split"),
        _transition(2, 3, narrative_scene_boundary=True),
        _transition(3, 4),
        _transition(4, 5, hard_boundary=True),
        _transition(5, 6, final_action="split"),
        _transition(6, 7),
    ]
    pass2_result = SimpleNamespace(transitions=transitions, groups=[])

    groups = normalize_groups(sentences, pass2_result)
    scenes = normalize_scenes(sentences, pass2_result)

    group_boundaries = {group.end_sentence_id for group in groups[:-1]}
    scene_boundaries = {scene.end_sentence_id for scene in scenes[:-1]}

    assert scene_boundaries.issubset(group_boundaries)
    assert scene_boundaries == {2, 4}
    assert group_boundaries == {1, 2, 4, 5}
