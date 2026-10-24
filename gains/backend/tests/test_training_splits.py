"""Enforcement of named lifting splits, including specialized second chest day."""
from __future__ import annotations

from gains_addon.training_splits import (
    custom_split_focuses,
    session_focus,
    split_focuses,
)
from gains_addon.workout_planner import FOCUS_CATEGORIES, focus_name


def test_powerlifting_hybrid_keeps_all_five_distinct_days():
    assert split_focuses("Powerlifting Hybrid", 5) == [
        "Chest/Triceps", "Back/Biceps", "Legs",
        "Chest/Biceps Isolation", "Arms/Forearms/Grip",
    ]


def test_hybrid_names_map_to_distinct_muscle_targets():
    assert session_focus("Chest/Triceps Training") == "chest/triceps"
    assert session_focus("Back/Biceps Training") == "back/biceps"
    assert session_focus("Chest/Biceps Isolation Training") == "chest/biceps isolation"
    assert session_focus("Arms/Forearms/Grip Training") == "arms/grip"
    assert "carry" in FOCUS_CATEGORIES[focus_name("Arms/Forearms/Grip")]
    assert "push" in FOCUS_CATEGORIES[focus_name("Chest/Biceps Isolation")]


def test_split_rotation_handles_nonmatching_weekly_frequency():
    assert split_focuses("Powerlifting Hybrid", 3, offset=3) == [
        "Chest/Biceps Isolation", "Arms/Forearms/Grip", "Chest/Triceps",
    ]
    assert split_focuses("PHUL", 4) == [
        "Power Upper", "Power Lower", "Hypertrophy Upper", "Hypertrophy Lower",
    ]


def test_custom_split_preserves_isolation_and_grip_day():
    assert custom_split_focuses(
        "Chest/Triceps | Back/Biceps | Legs | Chest/Biceps Isolation | Arms/Forearms/Grip",
        5,
    ) == [
        "Chest/Triceps", "Back/Biceps", "Legs",
        "Chest/Biceps Isolation", "Arms/Forearms/Grip",
    ]


def test_custom_split_rejects_missing_days_and_unknown_muscle():
    import pytest

    with pytest.raises(ValueError, match="one focus per lifting day"):
        custom_split_focuses("Chest | Legs", 3)
    with pytest.raises(ValueError, match="Unsupported custom split focus"):
        custom_split_focuses("Chest | Magic", 2)
