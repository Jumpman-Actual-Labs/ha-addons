"""History-derived readiness estimate, never a measured physiological score.

Each working set adds 6 fatigue points, scaled by volume, relative intensity
and effort. Secondary muscles receive 40%. Fatigue has a 24-hour half-life;
residual fatigue below 0.5 points is considered recovered. Recomputed from
history so editing/deleting logs cannot double count stored fatigue.
"""
from __future__ import annotations

from datetime import UTC, datetime
from math import isfinite

from .exercises import EXERCISE_LIBRARY
from .models import Workout
from .muscles import MUSCLE_DICTIONARY, MUSCLES_BY_EXERCISE

HALF_LIFE_HOURS = 24.0
_TIMED = {e["id"] for e in EXERCISE_LIBRARY if e.get("is_timed")}


def _time(value: str | None) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(value or "")
        return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)
    except (ValueError, TypeError):
        return None


def _positive(value: float | None, default: float) -> float:
    return float(value) if value is not None and isfinite(value) and value > 0 else default


def muscle_recovery(workouts: list[Workout], profile_id: str,
                    at: datetime | None = None) -> dict:
    """Include completed sets in active/finished sessions; never prescriptions.

    Undated legacy completed sets use session completion/start/creation time.
    Unusable/future dates are ignored. Missing reps/load/effort use neutral
    defaults. Relative load uses only this athlete's prior estimated 1RM,
    avoiding comparisons of raw kg/lb or loads across different exercises.
    """
    at = at or datetime.now(UTC)
    at = at.replace(tzinfo=UTC) if at.tzinfo is None else at.astimezone(UTC)
    events = []
    for workout in workouts:
        if workout.profile_id != profile_id or workout.status not in {"active", "completed"}:
            continue
        for exercise in workout.exercises:
            if exercise.exercise_id not in MUSCLES_BY_EXERCISE:
                continue
            for item in exercise.sets:
                if not item.completed or item.set_type == 'warmup':
                    continue
                stamp = next((t for v in (item.recorded_at, workout.completed_at,
                                          workout.started_at, workout.created_at)
                              if (t := _time(v)) is not None), None)
                if stamp is not None and stamp <= at:
                    events.append((stamp, exercise, item))
    events.sort(key=lambda event: event[0])
    fatigue = dict.fromkeys(MUSCLE_DICTIONARY, 0.0)
    last = dict.fromkeys(MUSCLE_DICTIONARY, None)
    best = {}
    for stamp, exercise, item in events:
        timed = exercise.exercise_id in _TIMED
        reps = _positive(item.actual_reps, 30 if timed else 10)
        weight = _positive(item.actual_weight, 0)
        volume = max(0.5, min(2.0, reps / (30 if timed else 10))) ** 0.5
        previous = best.get(exercise.exercise_id, 0)
        intensity = max(0.6, min(1.3, weight / previous / 0.7)) if previous and weight else 1.0
        effort = {"easy": 0.6, "moderate": 0.85, "hard": 1.1, "max": 1.3}.get(
            exercise.effort, 1.0)
        if item.rpe is not None and isfinite(item.rpe) and 1 <= item.rpe <= 10:
            effort = 0.5 + item.rpe * 0.08
        points = 6 * volume * intensity * effort
        roles = MUSCLES_BY_EXERCISE[exercise.exercise_id]
        for muscle in set(roles["primary"] + roles["secondary"]):
            if muscle not in fatigue:
                continue
            if last[muscle] is not None:
                hours = (stamp - last[muscle]).total_seconds() / 3600
                fatigue[muscle] *= 2 ** (-hours / HALF_LIFE_HOURS)
            role = 1.0 if muscle in roles["primary"] else 0.4
            fatigue[muscle] = min(100.0, fatigue[muscle] + points * role)
            last[muscle] = stamp
        if weight and not timed:
            best[exercise.exercise_id] = max(previous, weight * (1 + min(reps, 30) / 30))
    muscles = {}
    for muscle in fatigue:
        stamp = last[muscle]
        hours = (at - stamp).total_seconds() / 3600 if stamp else 0
        remaining = fatigue[muscle] * 2 ** (-hours / HALF_LIFE_HOURS)
        if remaining < 0.5:
            remaining = 0.0
        muscles[muscle] = {"recovery_percent": round(100 - remaining, 1),
                           "last_trained_at": stamp.isoformat() if stamp else None}
    return {"model_version": 1, "calculated_at": at.isoformat(),
            "half_life_hours": HALF_LIFE_HOURS, "muscles": muscles}
