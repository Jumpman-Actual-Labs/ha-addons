"""Physical feasibility and compatible history, independent of provider output."""
from datetime import UTC, datetime

import pytest

from gains_addon import training
from gains_addon.exercise_metadata import METADATA
from gains_addon.exercises import EXERCISE_LIBRARY
from gains_addon.load_policy import feasible_ids, load_ladder
from gains_addon.models import (
    AthleteProfile,
    GainsData,
    GymProfile,
    Workout,
    WorkoutExercise,
    WorkoutSet,
)
from gains_addon.prescription_engine import prescribe
from gains_addon.recovery import muscle_recovery

CATALOG = {e['id']: e for e in EXERCISE_LIBRARY}
CLOCK = datetime(2026, 10, 14, tzinfo=UTC)


def athlete(equipment, config=None, units="metric"):
    p = AthleteProfile(
        id="a", ha_user_id="u", display_name="Synthetic", units=units, gym_profile_id="g"
    )
    gym = GymProfile(
        id="g",
        name="Synthetic",
        equipment=equipment,
        equipment_config=config or {},
        inventory_units="metric",
    )
    return p, GainsData(profiles=[p], gym_profiles=[gym])


def test_reviewed_pool_uses_only_owned_ids():
    assert set(METADATA) <= set(CATALOG)


def test_bench_and_rack_are_all_of_requirements_and_floor_press_is_distinct():
    p, data = athlete({'olympic_barbell': [20], 'flat_bench': [None]})
    ids = feasible_ids(EXERCISE_LIBRARY, set(CATALOG), p, data)
    assert 'barbell_bench_press' not in ids
    assert 'floor_press' in ids
    data.gym_profiles[0].equipment['power_rack'] = [None]
    assert 'barbell_bench_press' in feasible_ids(EXERCISE_LIBRARY, set(CATALOG), p, data)


def test_saved_plate_pair_quantities_and_bar_minimum():
    p, data = athlete({'olympic_barbell': [20], 'plates': [10]})
    assert load_ladder(CATALOG['barbell_bench_press'], p, data) == [20, 40]
    data.gym_profiles[0].equipment['plates'].append(2.5)
    assert load_ladder(CATALOG['barbell_bench_press'], p, data) == [20, 25, 40, 45]


def test_pairs_stacks_and_shared_inventory_unit_conversion():
    p, data = athlete(
        {"dumbbells": [5, 10, 10], "lat_pulldown_cable": [None]},
        {
            "lat_pulldown_cable": {
                "load_type": "weight_stack",
                "stack_increment": 5,
                "stack_max": 20,
                "pulley_ratio": 2,
            }
        },
    )
    assert load_ladder(CATALOG['dumbbell_bench_press'], p, data) == [10]
    assert load_ladder(CATALOG['lat_pulldown'], p, data) == [5, 10, 15, 20]
    p.units = 'imperial'
    assert load_ladder(CATALOG['dumbbell_bench_press'], p, data)[0] == pytest.approx(22.0462)
    assert data.gym_profiles[0].equipment['dumbbells'] == [5, 10, 10]


def test_explicit_floor_press_required_and_blocked_ids():
    p, data = athlete({'dumbbells': [2, 5, 5]})
    plan = training.fallback_workout(
        {
            "answers": {
                "focus": "Chest/Biceps Isolation",
                "required_exercises": ["single_arm_dumbbell_floor_press"],
                "excluded_exercises": ["hammer_curl"],
            }
        },
        p,
        data,
    )
    assert 'single_arm_dumbbell_floor_press' in {e['exercise_id'] for e in plan['exercises']}
    assert 'hammer_curl' not in {e['exercise_id'] for e in plan['exercises']}


@pytest.mark.parametrize(
    "complete,effort,expected_load", [(True, "easy", 102), (True, "hard", 100), (False, "easy", 20)]
)
def test_only_successful_working_sets_support_load_progression(complete, effort, expected_load):
    p, data = athlete({'olympic_barbell': [20], 'plates': [20, 20, 20, 20, 1, 1]})
    data.workouts.append(
        Workout(
            id="w",
            profile_id="a",
            name="Chest",
            status="completed",
            completed_at="2026-10-13T12:00:00+00:00",
            exercises=[
                WorkoutExercise(
                    exercise_id="barbell_bench_press",
                    effort=effort,
                    sets=[
                        WorkoutSet(
                            planned_reps=10, actual_reps=12, actual_weight=100, completed=complete
                        )
                        for _ in range(3)
                    ],
                )
            ],
        )
    )
    raw = {'sets': [{'reps': 10, 'weight': None} for _ in range(3)]}
    result, _ = prescribe(CATALOG['barbell_bench_press'], raw, p, data, 'hypertrophy', CLOCK)
    assert result['sets'][0]['weight'] == expected_load


def test_active_completed_work_and_warmup_classification():
    p, data = athlete({})
    workout = Workout(
        id="w",
        profile_id="a",
        name="Chest",
        status="active",
        started_at=CLOCK.isoformat(),
        exercises=[
            WorkoutExercise(
                exercise_id="push_up",
                sets=[WorkoutSet(completed=True, actual_reps=10, set_type="warmup")],
            )
        ],
    )
    data.workouts.append(workout)
    assert (
        muscle_recovery(data.workouts, p.id, CLOCK)["muscles"]["pectoralis_major"][
            "recovery_percent"
        ]
        == 100
    )
    workout.exercises[0].sets[0].set_type = "working"
    assert (
        muscle_recovery(data.workouts, p.id, CLOCK)["muscles"]["pectoralis_major"][
            "recovery_percent"
        ]
        < 100
    )


def test_bodyweight_timed_and_assistance_modes():
    p, data = athlete(
        {"assisted_weight_machine": [None]},
        {
            "assisted_weight_machine": {
                "load_type": "weight_stack",
                "stack_increment": 2,
                "stack_max": 60,
            }
        },
    )
    for exercise_id, reps, weight in [
        ("push_up", 10, 0),
        ("plank", 30, 0),
        ("assisted_pull_up", 12, 50),
    ]:
        data.workouts.append(
            Workout(
                id=exercise_id,
                profile_id="a",
                name="Synthetic",
                status="completed",
                completed_at="2026-10-13T12:00:00+00:00",
                exercises=[
                    WorkoutExercise(
                        exercise_id=exercise_id,
                        effort="easy",
                        sets=[
                            WorkoutSet(
                                completed=True,
                                planned_reps=reps,
                                actual_reps=reps,
                                actual_weight=weight,
                            )
                        ],
                    )
                ],
            )
        )
        raw = {'sets': [{'reps': reps, 'weight': None}]}
        result, _ = prescribe(CATALOG[exercise_id], raw, p, data, 'hypertrophy', CLOCK)
        assert result["sets"][0]["weight"] == (48 if exercise_id == "assisted_pull_up" else 0)
        assert result["sets"][0]["reps"] == (
            35 if exercise_id == "plank" else 11 if exercise_id == "push_up" else 8
        )

