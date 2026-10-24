"""Sanity checks on the static seed exercise library."""
from __future__ import annotations

from gains_addon.exercises import EXERCISE_IDS, EXERCISE_LIBRARY, get_exercise


def test_exercise_ids_are_unique():
    ids = [e["id"] for e in EXERCISE_LIBRARY]
    assert len(ids) == len(set(ids))


def test_exercise_ids_matches_library_length():
    assert len(EXERCISE_IDS) == len(EXERCISE_LIBRARY)


def test_every_exercise_has_a_name_category_and_equipment():
    for exercise in EXERCISE_LIBRARY:
        assert exercise["name"]
        assert exercise["category"]
        assert exercise["equipment"]


def test_get_exercise_finds_known_id():
    exercise = get_exercise("barbell_back_squat")
    assert exercise is not None
    assert exercise["name"] == "Barbell Back Squat"


def test_get_exercise_returns_none_for_unknown_id():
    assert get_exercise("not_a_real_exercise") is None


def test_timed_holds_are_flagged_and_bodyweight():
    # is_timed exercises log seconds-held as "reps" -- they should all be
    # bodyweight (no default-weight fallback that could feed that number
    # into 1RM math) and cover the known isometric holds in the library.
    timed_ids = {e["id"] for e in EXERCISE_LIBRARY if e.get("is_timed")}
    assert timed_ids == {"wall_sit", "plank", "side_plank", "hollow_hold"}
    for exercise_id in timed_ids:
        assert get_exercise(exercise_id)["equipment"] == "bodyweight"
