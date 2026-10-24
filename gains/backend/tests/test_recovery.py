"""Recovery model behavior and legacy log compatibility."""
from datetime import UTC, datetime, timedelta

import pytest

from gains_addon.models import AthleteProfile, Workout, WorkoutExercise, WorkoutSet
from gains_addon.recovery import muscle_recovery

NOW = datetime(2026, 10, 8, 12, tzinfo=UTC)


def session(sets=3, effort=None, **kwargs):
    return Workout(id="w", profile_id="p", name="Push", status="completed",
                   completed_at=NOW.isoformat(), exercises=[WorkoutExercise(
                       exercise_id="barbell_bench_press", effort=effort,
                       sets=[WorkoutSet(completed=True, actual_reps=10,
                                        actual_weight=100, **kwargs) for _ in range(sets)])])


def score(workouts, muscle="pectoralis_major", at=NOW):
    return muscle_recovery(workouts, "p", at)["muscles"][muscle]["recovery_percent"]


def test_accumulation_roles_and_effort():
    assert score([]) == 100
    assert score([session(6)]) < score([session(3)]) < score([session(1)])
    assert score([session()], "triceps_brachii") > score([session()], "pectoralis_major")
    assert score([session(effort="max")]) < score([session(effort="easy")])
    assert score([session(rpe=10)]) < score([session(rpe=5)])
    assert score([session(), session()]) < score([session()])
    assert 0 <= score([session(100)]) <= 100


def test_decay_and_full_recovery():
    workout = session()
    initial = score([workout])
    later = score([workout], at=NOW + timedelta(hours=24))
    assert later == pytest.approx(100 - (100 - initial) / 2, abs=0.1)
    assert initial < later < score([workout], at=NOW + timedelta(hours=48))
    assert score([workout], at=NOW + timedelta(days=14)) == 100


def test_ignore_prescriptions_other_profiles_future_and_unmapped():
    workout = session()
    workout.exercises[0].sets[0].completed = False
    assert score([workout]) > score([session()])
    workout.status = "planned"
    assert score([workout]) == 100
    workout.status = "completed"
    workout.profile_id = "someone_else"
    assert score([workout]) == 100
    workout.profile_id = "p"
    workout.completed_at = (NOW + timedelta(days=1)).isoformat()
    assert score([workout]) == 100
    workout.completed_at = NOW.isoformat()
    workout.exercises[0].exercise_id = "unknown"
    assert score([workout]) == 100


def test_legacy_defaults_and_roundtrip():
    workout = session()
    for item in workout.exercises[0].sets:
        item.actual_reps = item.actual_weight = None
    assert score([workout]) < 100
    workout.completed_at = "bad date"
    workout.created_at = NOW.replace(tzinfo=None).isoformat()
    assert score([workout]) < 100
    item = WorkoutSet.from_dict({"completed": True, "rpe": 8})
    assert WorkoutSet.from_dict(item.to_dict()).rpe == 8
    assert WorkoutSet.from_dict({}).rpe is None


def test_logged_timestamp_and_relative_load():
    old = session(1)
    old.exercises[0].sets[0].recorded_at = (NOW - timedelta(days=1)).isoformat()
    assert score([old]) > score([session(1)])
    light = session(1)
    light.exercises[0].sets[0].actual_weight = 50
    assert score([old, light]) > score([old, session(1)])
    high_reps = session(1)
    high_reps.exercises[0].sets[0].actual_reps = 20
    assert score([high_reps]) < score([session(1)])


def test_profile_api_exposes_recovery():
    from gains_addon.logic import profile_extra_attributes
    profile = AthleteProfile(id="p", ha_user_id="u", display_name="P")
    state = profile_extra_attributes(profile, [], [])
    assert state["muscle_recovery"]["model_version"] == 1
    assert state["muscle_recovery"]["muscles"]["pectoralis_major"]["recovery_percent"] == 100



def test_active_sets_timed_holds_and_invalid_rpe():
    workout = session(1)
    workout.status = "active"
    assert score([workout]) < 100
    assert score([session(rpe=float("nan"))]) == score([session()])
    assert score([session(rpe=20)]) == score([session()])
    workout.exercises[0].exercise_id = "plank"
    workout.exercises[0].sets[0].actual_reps = 30
    workout.exercises[0].sets[0].actual_weight = 0
    baseline = score([workout], "rectus_abdominis")
    workout.exercises[0].sets[0].actual_reps = 60
    assert score([workout], "rectus_abdominis") < baseline < 100
