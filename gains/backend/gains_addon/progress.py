"""Pure functions behind the Progress tab -- Strength Score and Activity.

No Home Assistant imports, kept separate from logic.py the same way
training.py is its own module: this is a self-contained new feature area,
not a couple of helper functions bolted onto the existing grab-bag.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Any

from . import strength_standards
from .exercises import get_exercise
from .models import AthleteProfile, Workout
from .muscles import MUSCLES_BY_EXERCISE

PRIMARY_MUSCLE_TO_GROUP: dict[str, str] = {
    "pectoralis_major": "chest",
    "latissimus_dorsi": "back",
    "trapezius": "back",
    "rhomboids": "back",
    "erector_spinae": "back",
    "anterior_deltoid": "shoulders",
    "lateral_deltoid": "shoulders",
    "posterior_deltoid": "shoulders",
    "biceps_brachii": "biceps",
    "triceps_brachii": "triceps",
    "forearms": "biceps",
    "rectus_abdominis": "core",
    "obliques": "core",
    "quadriceps": "quads",
    "hip_adductors": "quads",
    "hamstrings": "hamstrings",
    "gluteals": "glutes",
    "calves": "calves",
}
"""Maps muscles.json's granular anatomy down to the broader "major muscle
group" labels the Progress tab's Activity chart counts by -- deliberately
wider than strength_standards.MUSCLE_GROUPS (which only scores lifts with a
known bodyweight standard); this covers every exercise the athlete actually
did, not just the curated major lifts."""

MUSCLE_GROUP_LABELS: dict[str, str] = {
    "chest": "Chest",
    "back": "Back",
    "shoulders": "Shoulders",
    "biceps": "Biceps",
    "triceps": "Triceps",
    "quads": "Quads",
    "hamstrings": "Hamstrings",
    "glutes": "Glutes",
    "core": "Core",
    "calves": "Calves",
}


def strength_score_state(profile: AthleteProfile) -> dict[str, Any]:
    """The whole Strength Score card + Breakdown list -- derived entirely
    from profile.personal_records (never recomputed from raw workout
    history; personal_records is already the maintained best-estimated-1RM
    per exercise) and profile.bodyweight/age."""
    groups: list[dict[str, Any]] = []
    group_scores: list[int] = []
    for key, meta in strength_standards.MUSCLE_GROUPS.items():
        exercises: list[dict[str, Any]] = []
        for exercise_id in meta["exercises"]:
            best = profile.personal_records.get(exercise_id)
            if best is None:
                continue
            score = strength_standards.exercise_strength_score(
                exercise_id, best, profile.bodyweight, profile.age
            )
            if score is None:
                continue
            definition = get_exercise(exercise_id)
            exercises.append(
                {
                    "exercise_id": exercise_id,
                    "exercise_name": definition["name"] if definition else exercise_id,
                    "score": score,
                    "tier": strength_standards.tier_for_score(score),
                    "one_rep_max": round(best, 1),
                }
            )
        if not exercises:
            groups.append(
                {
                    "muscle_group": key,
                    "label": meta["label"],
                    "score": None,
                    "tier": None,
                    "exercises": [],
                }
            )
            continue
        group_score = round(sum(e["score"] for e in exercises) / len(exercises))
        group_scores.append(group_score)
        groups.append(
            {
                "muscle_group": key,
                "label": meta["label"],
                "score": group_score,
                "tier": strength_standards.tier_for_score(group_score),
                "exercises": sorted(exercises, key=lambda e: e["score"], reverse=True),
            }
        )
    overall_score = round(sum(group_scores) / len(group_scores)) if group_scores else None
    return {
        "overall_score": overall_score,
        "overall_tier": strength_standards.tier_for_score(overall_score)
        if overall_score is not None
        else None,
        "groups": groups,
    }


def _parse_datetime(value: str | None) -> datetime | None:
    """Naive (tzinfo stripped) so every comparison in this module -- against
    each other or against a plain datetime(year, month, 1) -- just works,
    without every call site having to remember to normalize first."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value).replace(tzinfo=None)
    except ValueError:
        return None


def workout_streak(workouts: list[Workout], today: date) -> int:
    """Consecutive days (ending today or yesterday) with at least one
    completed workout -- doesn't break just because today's workout hasn't
    happened yet, same as any habit-tracker streak."""
    completed_dates: set[date] = set()
    for w in workouts:
        if w.status != "completed":
            continue
        completed_at = _parse_datetime(w.completed_at)
        if completed_at is not None:
            completed_dates.add(completed_at.date())

    day = today
    if day not in completed_dates:
        day -= timedelta(days=1)
    streak = 0
    while day in completed_dates:
        streak += 1
        day -= timedelta(days=1)
    return streak


def _muscle_groups_for_exercise(exercise_id: str) -> set[str]:
    primary = MUSCLES_BY_EXERCISE.get(exercise_id, {}).get("primary", [])
    return {PRIMARY_MUSCLE_TO_GROUP[m] for m in primary if m in PRIMARY_MUSCLE_TO_GROUP}


def _best_one_rep_max_by_exercise(
    workouts: list[Workout], start: datetime | None, end: datetime | None
) -> dict[str, float]:
    """Best estimated 1RM per exercise_id among completed sets whose
    recorded_at falls in [start, end) -- either bound may be None (open)."""
    from . import logic

    best: dict[str, float] = {}
    for w in workouts:
        for exercise in w.exercises:
            for s in exercise.sets:
                if not s.completed or s.actual_reps is None or s.actual_weight is None:
                    continue
                recorded_at = _parse_datetime(s.recorded_at)
                if recorded_at is None:
                    continue
                if start is not None and recorded_at < start:
                    continue
                if end is not None and recorded_at >= end:
                    continue
                estimated = logic.estimate_one_rep_max(s.actual_weight, s.actual_reps)
                if estimated > best.get(exercise.exercise_id, 0):
                    best[exercise.exercise_id] = estimated
    return best


def monthly_report(workouts: list[Workout], year: int, month: int) -> dict[str, Any]:
    """Everything the Activity section's "this month" drill-down needs --
    counts/duration/volume/sets, top-5 most-improved exercises (by
    projected 1RM vs. each exercise's best before this month), and a
    muscle-group frequency breakdown, all scoped to workouts *completed*
    within the given calendar month."""
    month_start = datetime(year, month, 1)
    month_end = datetime(year + 1, 1, 1) if month == 12 else datetime(year, month + 1, 1)

    in_month = [
        w
        for w in workouts
        if w.status == "completed"
        and (completed_at := _parse_datetime(w.completed_at)) is not None
        and month_start <= completed_at < month_end
    ]

    duration_minutes = 0
    volume = 0.0
    total_sets = 0
    days_by_group: dict[str, int] = {}
    sets_by_group: dict[str, int] = {}

    for w in in_month:
        started_at = _parse_datetime(w.started_at)
        completed_at = _parse_datetime(w.completed_at)
        if started_at is not None and completed_at is not None:
            duration_minutes += max(
                0, round((completed_at - started_at).total_seconds() / 60)
            )

        groups_today: set[str] = set()
        for exercise in w.exercises:
            exercise_groups = _muscle_groups_for_exercise(exercise.exercise_id)
            for s in exercise.sets:
                if not s.completed:
                    continue
                total_sets += 1
                if s.actual_reps is not None and s.actual_weight is not None:
                    volume += s.actual_reps * s.actual_weight
                for group in exercise_groups:
                    sets_by_group[group] = sets_by_group.get(group, 0) + 1
            if exercise_groups and any(s.completed for s in exercise.sets):
                groups_today |= exercise_groups
        for group in groups_today:
            days_by_group[group] = days_by_group.get(group, 0) + 1

    prior_best = _best_one_rep_max_by_exercise(workouts, None, month_start)
    current_best = _best_one_rep_max_by_exercise(workouts, month_start, month_end)
    improved = []
    for exercise_id, current in current_best.items():
        previous = prior_best.get(exercise_id)
        if not previous or previous <= 0 or current <= previous:
            continue
        definition = get_exercise(exercise_id)
        improved.append(
            {
                "exercise_id": exercise_id,
                "exercise_name": definition["name"] if definition else exercise_id,
                "from_one_rep_max": round(previous, 1),
                "to_one_rep_max": round(current, 1),
                "percent_improved": round(100 * (current - previous) / previous),
            }
        )
    improved.sort(key=lambda e: e["percent_improved"], reverse=True)

    muscle_breakdown = sorted(
        (
            {
                "muscle_group": group,
                "label": MUSCLE_GROUP_LABELS.get(group, group),
                "days": days_by_group.get(group, 0),
                "sets": sets_by_group.get(group, 0),
            }
            for group in set(days_by_group) | set(sets_by_group)
        ),
        key=lambda g: g["sets"],
        reverse=True,
    )

    return {
        "year": year,
        "month": month,
        "workouts_completed": len(in_month),
        "duration_minutes": duration_minutes,
        "volume": round(volume, 1),
        "sets": total_sets,
        "most_improved": improved[:5],
        "muscle_breakdown": muscle_breakdown,
    }


def progress_state(profile: AthleteProfile, workouts: list[Workout], today: date) -> dict[str, Any]:
    """Combines Strength Score + Activity into the one payload
    gains.progress_state returns."""
    return {
        "strength_score": strength_score_state(profile),
        "streak_days": workout_streak(workouts, today),
        "this_month": monthly_report(workouts, today.year, today.month),
    }
