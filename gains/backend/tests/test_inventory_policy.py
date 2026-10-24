"""Regression coverage for replacement and recommendation inventory boundaries."""

import copy

import pytest

from gains_addon.exercises import get_exercise
from gains_addon.load_policy import exercise_availability, load_ladder, snap_load
from gains_addon.models import GainsData, WorkoutSet
from gains_addon.prescription_engine import prescribe
from tests.inventory_fixtures import equip
from tests.test_coordinator import coordinator as base_coordinator
from tests.test_engine_equipment import athlete


@pytest.fixture(name="coordinator")
async def inventory_coordinator():
    return await base_coordinator.__wrapped__()


def test_dumbbell_ladder_quantity_and_reported_case():
    p, data = athlete({"dumbbells": [20, 20, 25, 25, 30, 30]}, units="metric")
    ladder = load_ladder(get_exercise("dumbbell_bench_press"), p, data)
    assert ladder == [20, 25, 30]
    assert snap_load(25, ladder, lower=True) == 20
    data.gym_profiles[0].equipment["dumbbells"].remove(20)
    assert load_ladder(get_exercise("dumbbell_bench_press"), p, data) == [25, 30]


def test_no_gym_or_unknown_units_never_verified():
    p, data = athlete({"dumbbells": [5, 5]})
    data.gym_profiles[0].inventory_units = None
    assert not exercise_availability(get_exercise("dumbbell_bench_press"), p, data)["feasible"]
    assert load_ladder(get_exercise("dumbbell_curl"), p, data) == []
    assert exercise_availability(get_exercise("push_up"), p, GainsData())["feasible"]
    assert not exercise_availability(get_exercise("pull_up"), p, GainsData())["feasible"]


def test_all_of_bench_rack_and_alternative_bar():
    p, data = athlete({"short_bar": [10], "plates": [5, 5], "power_rack": [None]})
    e = get_exercise("barbell_bench_press")
    assert "Missing Flat Bench or Incline Bench" in exercise_availability(e, p, data)["reasons"]
    data.gym_profiles[0].equipment["flat_bench"] = [None]
    assert exercise_availability(e, p, data)["feasible"]


def test_machine_stack_and_attachments_are_separate_requirements():
    p, data = athlete(
        {"cable_tower": [None]},
        {"cable_tower": {"load_type": "weight_stack", "stack_increment": 5, "stack_max": 20}},
    )
    e = get_exercise("lat_pulldown")
    assert not exercise_availability(e, p, data)["feasible"]
    data.gym_profiles[0].equipment["lat_bar"] = [None]
    assert exercise_availability(e, p, data)["feasible"]
    assert load_ladder(e, p, data) == [5, 10, 15, 20]


def test_dual_cables_and_handle_quantities():
    p, data = athlete(
        {"cable_tower": [None], "cable_handle": [None]},
        {"cable_tower": {"load_type": "weight_stack", "stack_increment": 5, "stack_max": 20}},
    )
    e = get_exercise("cable_fly")
    assert not exercise_availability(e, p, data)["feasible"]
    data.gym_profiles[0].equipment["cable_tower"].append(None)
    data.gym_profiles[0].equipment["cable_handle"].append(None)
    assert exercise_availability(e, p, data)["feasible"]


@pytest.mark.parametrize("points,expected", [
    (1, [0, 2.5, 5, 10, 12.5, 15, 20, 22.5, 25]), (2, [0, 5, 20, 25]),
])
def test_plate_loaded_machine_explicit_settings(points, expected):
    p, data = athlete(
        {"leg_press_machine": [None], "plates": [10, 2.5]},
        {
            "leg_press_machine": {
                "load_type": "plate_loaded",
                "base_weight": 0,
                "loading_points": points,
            }
        },
    )
    assert load_ladder(get_exercise("leg_press"), p, data) == expected
    data.gym_profiles[0].equipment_config["leg_press_machine"].pop("loading_points")
    assert load_ladder(get_exercise("leg_press"), p, data) == []


def test_selected_bar_and_converted_weights():
    p, data = athlete({"olympic_barbell": [20], "short_bar": [10], "plates": [5, 5, 2.5]})
    e = get_exercise("barbell_row")
    assert load_ladder(e, p, data, {"equipment_id": "short_bar", "weight": 10}) == [
        10, 15, 20, 25, 30, 35,
    ]
    assert load_ladder(e, p, data, {"equipment_id": "trap_bar", "weight": 10}) == []
    p.units = "imperial"
    assert load_ladder(e, p, data)[0] == pytest.approx(44.09, abs=0.01)


def test_unverified_prescriptions_fail_but_explicit_manual_targets_survive():
    p, data = athlete({})
    planned = {"sets": [{"reps": 8, "weight": 22.5}]}
    with pytest.raises(ValueError, match="verified inventory"):
        prescribe(get_exercise("dumbbell_curl"), copy.deepcopy(planned), p, data, "hypertrophy")
    assert (
        prescribe(
            get_exercise("dumbbell_curl"),
            copy.deepcopy(planned),
            p,
            data,
            "hypertrophy",
            preserve_unknown_targets=True,
        )[0]
        == planned
    )


async def test_direct_service_cannot_bypass_eligibility_and_does_not_mutate(coordinator):
    await coordinator.async_ensure_profile("u", "Athlete")
    w = await coordinator.async_create_workout(
        "u", "Workout", [{"exercise_id": "push_up", "sets": [{"reps": 8}]}]
    )
    original = copy.deepcopy(w.to_dict())
    with pytest.raises(ValueError, match="Missing"):
        await coordinator.async_replace_exercise("u", w.id, 0, "barbell_bench_press")
    assert w.to_dict() == original


async def test_coach_uses_athlete_gym_and_cannot_borrow_coach_inventory(coordinator):
    coach = await coordinator.async_ensure_profile("c", "Coach")
    athlete_profile = await coordinator.async_ensure_profile("a", "Athlete")
    equip(coach, coordinator.data)
    w = await coordinator.async_create_workout(
        "a", "Workout", [{"exercise_id": "push_up", "sets": [{"reps": 8}]}]
    )
    with pytest.raises(ValueError):
        await coordinator.async_replace_exercise(
            "c", w.id, 0, "goblet_squat", target_profile_id=athlete_profile.id
        )
    await coordinator.async_set_coach_permissions("a", coach.id, {"coach_workouts": True})
    with pytest.raises(ValueError, match="Missing"):
        await coordinator.async_replace_exercise(
            "c", w.id, 0, "goblet_squat", target_profile_id=athlete_profile.id
        )
    equip(athlete_profile, coordinator.data)
    state = await coordinator.async_training_state("c", athlete_profile.id)
    assert state["attributes"]["inventory_policy"]["goblet_squat"]["feasible"]
    await coordinator.async_replace_exercise(
        "c", w.id, 0, "goblet_squat", target_profile_id=athlete_profile.id
    )
    assert w.exercises[0].exercise_id == "goblet_squat"


def test_manual_weight_round_trip():
    s = WorkoutSet(planned_weight=22.5, manual_weight=True)
    assert WorkoutSet.from_dict(s.to_dict()).manual_weight


def test_offset_stack_settings_and_kettlebell_exact_weights():
    p, data = athlete(
        {"leg_press_machine": [None], "kettlebells": [6, 10, 16]},
        {
            "leg_press_machine": {
                "load_type": "weight_stack",
                "stack_min": 7.5,
                "stack_increment": 5,
                "stack_max": 23,
            }
        },
    )
    assert load_ladder(get_exercise("leg_press"), p, data) == [7.5, 12.5, 17.5, 22.5]
    assert load_ladder(get_exercise("kettlebell_swing"), p, data) == [6, 10, 16]


def test_progression_snaps_impossible_historical_load_without_changing_history():
    from gains_addon.models import Workout, WorkoutExercise

    p, data = athlete({"dumbbells": [20, 20, 25, 25, 30, 30]})
    data.workouts.append(
        Workout(
            id="w",
            profile_id=p.id,
            name="Previous",
            status="completed",
            completed_at="2026-01-01T00:00:00+00:00",
            exercises=[
                WorkoutExercise(
                    exercise_id="dumbbell_curl",
                    effort="hard",
                    sets=[
                        WorkoutSet(
                            planned_reps=8, actual_reps=8, actual_weight=22.5, completed=True
                        )
                    ],
                )
            ],
        )
    )
    original = copy.deepcopy(data.to_dict())
    result, _ = prescribe(
        get_exercise("dumbbell_curl"),
        {"sets": [{"reps": 8, "weight": 22.5}]},
        p,
        data,
        "hypertrophy",
    )
    assert result["sets"][0]["weight"] == 20
    assert data.to_dict() == original


def test_child_uses_own_verified_light_weights_not_adult_defaults():
    p, data = athlete({"dumbbells": [1, 1, 2, 2, 20, 20]})
    p.experience_level = "kids"
    result, _ = prescribe(
        get_exercise("dumbbell_curl"),
        {"sets": [{"reps": 8, "weight": None}]},
        p,
        data,
        "hypertrophy",
    )
    assert result["sets"][0]["weight"] == 2
    assert exercise_availability(get_exercise("dumbbell_curl"), p, data)["feasible"]



async def test_replacement_with_owned_equipment_and_unknown_loads(coordinator):
    profile = await coordinator.async_ensure_profile('u', 'Athlete')
    equip(profile, coordinator.data)
    gym = coordinator.data.gym_profiles[0]
    gym.inventory_units = None
    available = exercise_availability(get_exercise('stiff_leg_deadlift'), profile, coordinator.data)
    assert available['selectable']
    assert not available['feasible']
    workout = await coordinator.async_create_workout(
        'u', 'Workout', [{'exercise_id': 'push_up', 'sets': [{'reps': 8}]}]
    )
    await coordinator.async_replace_exercise('u', workout.id, 0, 'stiff_leg_deadlift')
    assert workout.exercises[0].exercise_id == 'stiff_leg_deadlift'
    assert all(s.planned_weight is None for s in workout.exercises[0].sets)


def test_reported_plate_pairs_make_150_lb_squat_without_exceeding_inventory():
    p, data = athlete({
        "olympic_barbell": [45], "power_rack": [None],
        "plates": [2.5, 5, 5, 10, 10, 10, 15, 25, 35, 45],
    }, units="imperial")
    data.gym_profiles[0].inventory_units = "imperial"
    ladder = load_ladder(get_exercise("barbell_back_squat"), p, data)
    assert 150 in ladder
    assert max(ladder) == 45 + 2 * sum(data.gym_profiles[0].equipment["plates"])
