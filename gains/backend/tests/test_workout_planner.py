"""Regression tests for metadata-driven Geoffrey workout planning."""
from __future__ import annotations

from types import SimpleNamespace

from gains_addon.exercises import EXERCISE_LIBRARY
from gains_addon.workout_planner import focus_name, select_exercises


def test_focus_mapping():
    assert focus_name("Chest and Triceps") == "chest/triceps"
    assert focus_name("Back and Biceps") == "back/biceps"
    assert focus_name("Upper Body") == "upper"
    assert focus_name("Full Body") == "full body"


def test_selection_is_deterministic_and_unique():
    allowed = {item["id"] for item in EXERCISE_LIBRARY}
    first = select_exercises(EXERCISE_LIBRARY, allowed, [], "Upper body", 6)
    assert len(first) == 6
    assert first == select_exercises(EXERCISE_LIBRARY, allowed, [], "Upper body", 6)
    assert len(set(first)) == len(first)


def test_selection_honors_equipment_filter():
    allowed = {
        item["id"] for item in EXERCISE_LIBRARY
        if item["equipment"] == "bodyweight"
    }
    ids = select_exercises(EXERCISE_LIBRARY, allowed, [], "full body", 6)
    assert ids
    assert set(ids) <= allowed


def test_selection_penalizes_recent_exercise_repetition():
    allowed = {item["id"] for item in EXERCISE_LIBRARY}
    baseline = select_exercises(EXERCISE_LIBRARY, allowed, [], "push", 6)
    recent = [
        SimpleNamespace(
            status="completed",
            completed_at="2026-10-12",
            exercises=[
                SimpleNamespace(exercise_id=exercise_id, sets=[SimpleNamespace(completed=True)])
                for exercise_id in baseline
            ],
        )
        for _ in range(8)
    ]
    rotated = select_exercises(EXERCISE_LIBRARY, allowed, recent, "push", 6)
    assert rotated != baseline


def test_empty_inventory_never_invents_exercises():
    assert select_exercises(EXERCISE_LIBRARY, set(), [], "pull", 6) == []
