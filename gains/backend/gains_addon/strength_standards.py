"""Static, offline strength-standard reference data for the Progress tab's
Strength Score.

Not AI-generated and not fetched from anywhere -- a deterministic
bodyweight-multiplier table, the same shape published strength-standards
sites (e.g. Symmetric Strength-style data) use, adjusted by a simple age
curve. These numbers are a rough population-average approximation for an
unspecified general population, not sports-science-verified per-cohort
research -- advisory context for the athlete, the same way
logic.build_ai_system_prompt's sizing guidance is advisory rather than
authoritative. Kept as its own module (not logic.py) so the data table
stays easy to scan/tune separately from the scoring functions that use it,
mirroring exercises.py being its own module rather than folded into
logic.py.
"""

from __future__ import annotations

MUSCLE_GROUPS: dict[str, dict[str, object]] = {
    "chest": {
        "label": "Chest",
        "exercises": ["barbell_bench_press", "dumbbell_bench_press", "incline_barbell_bench_press"],
    },
    "back": {
        "label": "Back",
        "exercises": ["barbell_row", "dumbbell_row", "t_bar_row"],
    },
    "shoulders": {
        "label": "Shoulders",
        "exercises": ["overhead_press", "dumbbell_shoulder_press"],
    },
    "biceps": {
        "label": "Biceps",
        "exercises": ["barbell_curl", "dumbbell_curl"],
    },
    "triceps": {
        "label": "Triceps",
        "exercises": ["close_grip_bench_press", "skull_crusher"],
    },
    "quads": {
        "label": "Quads",
        "exercises": ["barbell_back_squat", "leg_press"],
    },
    "hamstrings": {
        "label": "Hamstrings",
        "exercises": ["romanian_deadlift", "barbell_deadlift"],
    },
    "glutes": {
        "label": "Glutes",
        "exercises": ["hip_thrust", "barbell_back_squat"],
    },
}
"""One entry per major muscle group scored on the Progress tab -- deliberately
just the "major exercises" per group (a handful of well-known loaded barbell/
dumbbell lifts with an established weight, not every library exercise that
happens to touch the muscle), matching how the group's score is meant to be a
grade averaged from those lifts specifically."""

# Bodyweight multiplier for an "average" (population-average, roughly
# intermediate) lifter -- score 100 means the athlete's estimated one-rep
# max exactly matches bodyweight * this multiplier. Per-dumbbell exercises
# use a per-hand multiplier since that's what gets logged as the set's
# weight (matches how the rest of the app already treats dumbbell weight
# as the number entered, not doubled for "both hands").
EXERCISE_BODYWEIGHT_MULTIPLIERS: dict[str, float] = {
    "barbell_bench_press": 1.0,
    "dumbbell_bench_press": 0.4,
    "incline_barbell_bench_press": 0.85,
    "barbell_row": 0.9,
    "dumbbell_row": 0.4,
    "t_bar_row": 0.8,
    "overhead_press": 0.6,
    "dumbbell_shoulder_press": 0.3,
    "barbell_curl": 0.4,
    "dumbbell_curl": 0.2,
    "close_grip_bench_press": 0.85,
    "skull_crusher": 0.35,
    "barbell_back_squat": 1.25,
    "leg_press": 2.5,
    "romanian_deadlift": 1.1,
    "barbell_deadlift": 1.5,
    "hip_thrust": 1.5,
}

# (low, high, factor) age brackets, high is exclusive except the last.
# Strength is commonly cited as peaking roughly in the late 20s/early 30s
# and gradually declining outside that window; this is a simple, coarse
# approximation of that curve, not a per-exercise researched figure.
_AGE_BRACKETS: tuple[tuple[int, int, float], ...] = (
    (0, 18, 0.75),
    (18, 25, 0.95),
    (25, 40, 1.0),
    (40, 50, 0.9),
    (50, 60, 0.8),
    (60, 200, 0.7),
)
DEFAULT_AGE_FACTOR = 1.0
"""Used when the athlete hasn't set an age -- assumes prime-age rather than
blocking the score on a profile field most people won't fill in right away."""

DEFAULT_BODYWEIGHT_LB = 170.0
"""Used when the athlete hasn't set a bodyweight -- a rough general-population
average adult, again so a missing profile field doesn't block the score."""

# score = 100 * actual_1rm / population_average_1rm; tier boundaries below
# are just labels for that ratio, not independently researched cutoffs.
_TIERS: tuple[tuple[int, str], ...] = (
    (250, "Elite"),
    (180, "Advanced"),
    (120, "Experienced"),
    (80, "Novice"),
    (0, "Beginner"),
)


def age_factor(age: int | None) -> float:
    if age is None:
        return DEFAULT_AGE_FACTOR
    for low, high, factor in _AGE_BRACKETS:
        if low <= age < high:
            return factor
    return DEFAULT_AGE_FACTOR


def tier_for_score(score: int) -> str:
    for threshold, label in _TIERS:
        if score >= threshold:
            return label
    return "Beginner"


def population_average_one_rep_max(
    exercise_id: str, bodyweight: float | None, age: int | None
) -> float | None:
    """None if exercise_id has no strength-standard multiplier (i.e. isn't
    one of MUSCLE_GROUPS' major exercises)."""
    multiplier = EXERCISE_BODYWEIGHT_MULTIPLIERS.get(exercise_id)
    if multiplier is None:
        return None
    effective_bodyweight = bodyweight if bodyweight and bodyweight > 0 else DEFAULT_BODYWEIGHT_LB
    return effective_bodyweight * multiplier * age_factor(age)


def exercise_strength_score(
    exercise_id: str, actual_one_rep_max: float, bodyweight: float | None, age: int | None
) -> int | None:
    """None if exercise_id isn't scoreable (no strength standard)."""
    average = population_average_one_rep_max(exercise_id, bodyweight, age)
    if average is None or average <= 0:
        return None
    return round(100 * actual_one_rep_max / average)
