"""Semantic roadmap regressions against synthetic, public Gains inputs."""

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from gains_addon import training
from gains_addon.exercises import EXERCISE_LIBRARY
from gains_addon.models import AthleteProfile, GainsData
from gains_addon.training_splits import custom_split_focuses, normalize_split
from gains_addon.workout_planner import select_exercises
from tests.inventory_fixtures import equip

CATALOG = {e["id"]: e for e in EXERCISE_LIBRARY}
CLOCK = datetime(2026, 10, 14, tzinfo=UTC)


@pytest.mark.parametrize(
    "focus,muscles",
    [
        ("Chest/Triceps", {"pectoralis_major", "triceps_brachii"}),
        ("Back/Biceps", {"latissimus_dorsi", "rhomboids", "biceps_brachii"}),
        ("Chest/Biceps Isolation", {"pectoralis_major", "biceps_brachii"}),
        ("Biceps", {"biceps_brachii"}),
        ("Triceps", {"triceps_brachii"}),
        ("Core", {"rectus_abdominis", "obliques"}),
    ],
)
def test_d1_d2_primary_targets_are_hard_constraints(focus, muscles):
    ids = select_exercises(EXERCISE_LIBRARY, set(CATALOG), [], focus, as_of=CLOCK)
    assert ids
    assert all(set(CATALOG[i]["muscles"]["primary"]) & muscles for i in ids)


def test_d3_planned_work_is_not_realized_exposure():
    baseline = select_exercises(EXERCISE_LIBRARY, set(CATALOG), [], "push", as_of=CLOCK)
    planned = [
        SimpleNamespace(
            status="planned", exercises=[SimpleNamespace(exercise_id=i) for i in baseline]
        )
        for _ in range(12)
    ]
    assert (
        select_exercises(EXERCISE_LIBRARY, set(CATALOG), planned, "push", as_of=CLOCK) == baseline
    )


def test_d4_full_body_phrase_and_unknown_split():
    assert custom_split_focuses("Full Body | Core", 2) == ["Full Body", "Core"]
    with pytest.raises(ValueError, match="split"):
        normalize_split("Unknown authored split", 5)


def test_d5_explicit_duration_changes_workload():
    profile = AthleteProfile(id="athlete", ha_user_id="u", display_name="Synthetic")
    data = GainsData(profiles=[profile])
    equip(profile, data)

    def plan(minutes):
        return training.fallback_workout(
            {"answers": {"focus": "Chest", "duration": minutes}}, profile, data
        )

    assert sum(len(e["sets"]) for e in plan(15)["exercises"]) < sum(
        len(e["sets"]) for e in plan(90)["exercises"]
    )


def test_d9_null_weeks_and_count_mismatch_are_validation_errors():
    profile = AthleteProfile(id="athlete", ha_user_id="u", display_name="Synthetic")
    with pytest.raises(ValueError):
        training.normalize_generated("program", {"weeks": None}, profile, GainsData())
    with pytest.raises(ValueError, match="sessions"):
        training.normalize_generated(
            "program", {"weeks": [{"sessions": None}]}, profile, GainsData()
        )
    with pytest.raises(ValueError, match="count"):
        training.enforce_week_workouts(
            {"sessions": [{}, {}]}, profile, GainsData(), {"sessions": [{}]}
        )


@pytest.mark.runs_enabled
def test_run_duration_keeps_existing_range_and_optional_seed_defaults():
    request = training.build_request({
        "type": "run", "source": "wizard", "answers": {"duration": "240.5", "seed": None}
    })
    assert request["answers"]["duration"] == 240.5
    assert request["answers"].get("seed", 0) == 0


def test_d9_other_numbers_are_normalized_before_custom_split():
    request = training.build_request(
        {
            "type": "program",
            "source": "wizard",
            "answers": {
                "lifting_days": "Other",
                "lifting_days_other": "2",
                "split": "Custom Split",
                "custom_split_days": "Chest | Back",
            },
        }
    )
    assert request["answers"]["lifting_days"] == 2
