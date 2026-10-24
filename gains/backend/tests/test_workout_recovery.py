"""Tests for recovery-aware planning heuristics."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

from gains_addon.workout_planner import recovery_penalties


def test_recent_completed_session_penalizes_trained_muscles():
    now = datetime(2026, 10, 12, 12, tzinfo=UTC)
    from gains_addon.models import Workout, WorkoutExercise, WorkoutSet
    recent = [
        Workout(
            id="w",
            profile_id="a",
            name="Chest",
            status="completed",
            completed_at=(now - timedelta(hours=12)).isoformat(),
            exercises=[
                WorkoutExercise(
                    exercise_id="barbell_bench_press",
                    sets=[WorkoutSet(completed=True, actual_reps=10, actual_weight=20)],
                )
            ],
        )
    ]
    from gains_addon.recovery import muscle_recovery
    penalties = recovery_penalties([], recent, now)
    snapshot = muscle_recovery(recent, "a", now)
    assert (
        penalties["pectoralis_major"]
        == 100 - snapshot["muscles"]["pectoralis_major"]["recovery_percent"]
    )
    assert penalties['triceps_brachii'] > 0  # secondary work agrees with UI estimate
    recent[0].completed_at = (now - timedelta(hours=48)).isoformat()
    assert recovery_penalties([], recent, now)['pectoralis_major'] < penalties['pectoralis_major']


def test_incomplete_workouts_and_missing_timestamps_do_not_imply_fatigue():
    now = datetime(2026, 10, 12, tzinfo=UTC)
    catalog = [
        {"id": "squat", "muscles": {"primary": ["quadriceps"]}}
    ]
    recent = [
        SimpleNamespace(
            status="active",
            completed_at=now.isoformat(),
            exercises=[SimpleNamespace(exercise_id="squat")],
        ),
        SimpleNamespace(
            status="completed",
            completed_at=None,
            exercises=[SimpleNamespace(exercise_id="squat")],
        ),
    ]
    assert not recovery_penalties(catalog, recent, now)
