"""Cross-stage invariants for independent Gains policies."""

from datetime import UTC, datetime

from gains_addon import training
from gains_addon.exercises import EXERCISE_LIBRARY
from gains_addon.models import (
    AthleteProfile,
    GainsData,
    Workout,
    WorkoutExercise,
    WorkoutSet,
)
from gains_addon.workout_planner import FOCUS_MUSCLES, focus_name, select_exercises
from tests.inventory_fixtures import equip

CLOCK = datetime(2026, 10, 14, tzinfo=UTC)
CATALOG = {e["id"]: e for e in EXERCISE_LIBRARY}


def test_seeded_accessories_preserve_targets_and_staples():
    selections = []
    for seed in range(30):
        ids = select_exercises(
            EXERCISE_LIBRARY, set(CATALOG), [], "Chest/Triceps", seed=seed, as_of=CLOCK
        )
        assert ids[0] == "barbell_bench_press"
        assert len(set(ids)) == len(ids)
        assert all(
            set(CATALOG[i]["muscles"]["primary"]) & FOCUS_MUSCLES[focus_name("Chest/Triceps")]
            for i in ids
        )
        assert ids == select_exercises(
            EXERCISE_LIBRARY, set(CATALOG), [], "Chest/Triceps", seed=seed, as_of=CLOCK
        )
        selections.append(tuple(ids))
    assert len(set(selections)) > 1


def test_duration_budget_and_working_set_history():
    p = AthleteProfile(id="a", ha_user_id="u", display_name="Synthetic")
    data = GainsData(profiles=[p])
    equip(p, data)
    result = training.fallback_workout({"answers": {"focus": "Chest", "duration": 15}}, p, data)
    assert result["planning"]["estimated_duration_minutes"] <= 15
    logged = Workout(
        id="w",
        profile_id=p.id,
        name="Chest",
        status="completed",
        completed_at="2026-10-13T12:00:00+00:00",
        exercises=[
            WorkoutExercise(
                exercise_id="barbell_bench_press",
                effort="easy",
                sets=[
                    WorkoutSet(planned_reps=10, actual_reps=12, actual_weight=100, completed=True)
                    for _ in range(3)
                ],
            )
        ],
    )
    # This test uses a metric inventory so 100 is an achievable total.
    p.units = "metric"
    data.gym_profiles[0].inventory_units = "metric"
    data.gym_profiles[0].equipment["olympic_barbell"] = [20]
    data.workouts.append(logged)
    next_plan = training.fallback_workout({"answers": {"focus": "Chest"}}, p, data)
    bench = next(e for e in next_plan["exercises"] if e["exercise_id"] == "barbell_bench_press")
    assert (
        bench["sets"][0]["weight"] == 102
    )  # progress to the next verified load, never invent increments
    assert bench["sets"][0]["reps"] == 8


def test_explicit_additional_muscles_survive_the_session_contract():
    p = AthleteProfile(id='a', ha_user_id='u', display_name='Synthetic')
    data = GainsData(profiles=[p])
    equip(p, data)
    plan = training.fallback_workout({"answers": {"focus": "Chest/Triceps/Shoulders"}}, p, data)
    primaries = set().union(
        *(CATALOG[e["exercise_id"]]["muscles"]["primary"] for e in plan["exercises"])
    )
    assert 'pectoralis_major' in primaries and 'triceps_brachii' in primaries
    assert primaries & {'anterior_deltoid', 'lateral_deltoid', 'posterior_deltoid'}
