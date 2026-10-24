"""Pure-function tests for progress.py and strength_standards.py -- no HA,
no coordinator, no storage."""

from __future__ import annotations

from datetime import date

from gains_addon import progress, strength_standards
from gains_addon.models import AthleteProfile, Workout, WorkoutExercise, WorkoutSet


def _profile(**kwargs) -> AthleteProfile:
    defaults = dict(id="p1", ha_user_id="u1", display_name="Jordan")
    defaults.update(kwargs)
    return AthleteProfile(**defaults)


def _workout(
    workout_id: str,
    status: str,
    exercises: list[WorkoutExercise],
    started_at: str = "",
    completed_at: str | None = None,
) -> Workout:
    return Workout(
        id=workout_id,
        profile_id="p1",
        name="Session",
        status=status,
        exercises=exercises,
        started_at=started_at,
        completed_at=completed_at,
    )


def _set(reps, weight, completed=True, recorded_at="") -> WorkoutSet:
    return WorkoutSet(
        planned_reps=reps,
        planned_weight=weight,
        actual_reps=reps,
        actual_weight=weight,
        completed=completed,
        recorded_at=recorded_at,
    )


# -- strength_standards.py --


def test_age_factor_prime_age_bracket_is_full_strength():
    assert strength_standards.age_factor(30) == 1.0


def test_age_factor_falls_back_to_default_when_unset():
    assert strength_standards.age_factor(None) == strength_standards.DEFAULT_AGE_FACTOR


def test_age_factor_older_bracket_is_discounted():
    assert strength_standards.age_factor(65) < strength_standards.age_factor(30)


def test_tier_for_score_boundaries():
    assert strength_standards.tier_for_score(0) == "Beginner"
    assert strength_standards.tier_for_score(80) == "Novice"
    assert strength_standards.tier_for_score(120) == "Experienced"
    assert strength_standards.tier_for_score(180) == "Advanced"
    assert strength_standards.tier_for_score(250) == "Elite"


def test_population_average_uses_default_bodyweight_when_unset():
    average = strength_standards.population_average_one_rep_max("barbell_bench_press", None, None)
    assert average == strength_standards.DEFAULT_BODYWEIGHT_LB * 1.0


def test_population_average_none_for_unscored_exercise():
    assert strength_standards.population_average_one_rep_max("push_up", 180, 30) is None


def test_exercise_strength_score_100_at_exact_average():
    average = strength_standards.population_average_one_rep_max("barbell_bench_press", 180, 30)
    score = strength_standards.exercise_strength_score("barbell_bench_press", average, 180, 30)
    assert score == 100


def test_exercise_strength_score_scales_with_ratio_to_average():
    average = strength_standards.population_average_one_rep_max("barbell_bench_press", 180, 30)
    score = strength_standards.exercise_strength_score(
        "barbell_bench_press", average * 1.5, 180, 30
    )
    assert score == 150


# -- progress.strength_score_state --


def test_strength_score_state_with_no_personal_records_has_no_scores():
    result = progress.strength_score_state(_profile())
    assert result["overall_score"] is None
    assert all(g["score"] is None for g in result["groups"])


def test_strength_score_state_averages_group_exercises_and_overall():
    profile = _profile(
        bodyweight=180,
        age=30,
        personal_records={
            "barbell_bench_press": 180,  # average -> score 100
            "dumbbell_bench_press": 72 * 1.5,  # 1.5x average -> score 150
        },
    )
    result = progress.strength_score_state(profile)
    chest = next(g for g in result["groups"] if g["muscle_group"] == "chest")
    assert chest["score"] == 125
    assert chest["tier"] == "Experienced"
    assert {e["exercise_id"] for e in chest["exercises"]} == {
        "barbell_bench_press",
        "dumbbell_bench_press",
    }
    assert result["overall_score"] == 125


def test_strength_score_state_skips_exercises_without_a_personal_record():
    profile = _profile(bodyweight=180, age=30, personal_records={"barbell_bench_press": 180})
    result = progress.strength_score_state(profile)
    chest = next(g for g in result["groups"] if g["muscle_group"] == "chest")
    assert len(chest["exercises"]) == 1
    assert chest["score"] == 100


# -- progress.workout_streak --


def test_workout_streak_counts_consecutive_completed_days_ending_today():
    today = date(2026, 9, 21)
    workouts = [
        _workout("w1", "completed", [], completed_at="2026-09-21T10:00:00+00:00"),
        _workout("w2", "completed", [], completed_at="2026-09-20T10:00:00+00:00"),
        _workout("w3", "completed", [], completed_at="2026-09-19T10:00:00+00:00"),
        _workout("w4", "completed", [], completed_at="2026-09-17T10:00:00+00:00"),  # gap
    ]
    assert progress.workout_streak(workouts, today) == 3


def test_workout_streak_still_counts_yesterday_if_today_has_no_workout_yet():
    today = date(2026, 9, 21)
    workouts = [_workout("w1", "completed", [], completed_at="2026-09-20T10:00:00+00:00")]
    assert progress.workout_streak(workouts, today) == 1


def test_workout_streak_zero_with_no_completed_workouts():
    assert progress.workout_streak([], date(2026, 9, 21)) == 0


def test_workout_streak_ignores_planned_and_active_workouts():
    today = date(2026, 9, 21)
    workouts = [_workout("w1", "active", [], completed_at=None)]
    assert progress.workout_streak(workouts, today) == 0


# -- progress.monthly_report --


def test_monthly_report_totals_duration_volume_and_sets():
    workouts = [
        _workout(
            "w1",
            "completed",
            [
                WorkoutExercise(
                    exercise_id="barbell_bench_press",
                    sets=[
                        _set(5, 135, recorded_at="2026-09-05T10:05:00+00:00"),
                        _set(5, 135, recorded_at="2026-09-05T10:10:00+00:00"),
                    ],
                )
            ],
            started_at="2026-09-05T10:00:00+00:00",
            completed_at="2026-09-05T10:30:00+00:00",
        ),
    ]
    report = progress.monthly_report(workouts, 2026, 9)
    assert report["workouts_completed"] == 1
    assert report["duration_minutes"] == 30
    assert report["sets"] == 2
    assert report["volume"] == 5 * 135 * 2


def test_monthly_report_excludes_workouts_outside_the_month():
    workouts = [
        _workout(
            "w1", "completed", [], started_at="2026-08-31T10:00:00+00:00",
            completed_at="2026-08-31T11:00:00+00:00",
        ),
        _workout(
            "w2", "completed", [], started_at="2026-10-01T10:00:00+00:00",
            completed_at="2026-10-01T11:00:00+00:00",
        ),
    ]
    report = progress.monthly_report(workouts, 2026, 9)
    assert report["workouts_completed"] == 0


def test_monthly_report_excludes_uncompleted_workouts():
    workouts = [
        _workout(
            "w1",
            "active",
            [
                WorkoutExercise(
                    exercise_id="barbell_bench_press",
                    sets=[_set(5, 135, recorded_at="2026-09-05T10:00:00+00:00")],
                )
            ],
            started_at="2026-09-05T10:00:00+00:00",
        ),
    ]
    report = progress.monthly_report(workouts, 2026, 9)
    assert report["workouts_completed"] == 0
    assert report["sets"] == 0


def test_monthly_report_most_improved_compares_to_best_before_the_month():
    workouts = [
        _workout(
            "w1",
            "completed",
            [
                WorkoutExercise(
                    exercise_id="barbell_curl",
                    sets=[_set(8, 50, recorded_at="2026-08-01T10:00:00+00:00")],
                )
            ],
            completed_at="2026-08-01T11:00:00+00:00",
        ),
        _workout(
            "w2",
            "completed",
            [
                WorkoutExercise(
                    exercise_id="barbell_curl",
                    sets=[_set(8, 60, recorded_at="2026-09-10T10:00:00+00:00")],
                )
            ],
            completed_at="2026-09-10T11:00:00+00:00",
        ),
    ]
    report = progress.monthly_report(workouts, 2026, 9)
    assert len(report["most_improved"]) == 1
    entry = report["most_improved"][0]
    assert entry["exercise_id"] == "barbell_curl"
    assert entry["percent_improved"] == 20  # 50 -> 60 is +20%


def test_monthly_report_most_improved_skips_exercises_with_no_prior_baseline():
    workouts = [
        _workout(
            "w1",
            "completed",
            [
                WorkoutExercise(
                    exercise_id="barbell_curl",
                    sets=[_set(8, 60, recorded_at="2026-09-10T10:00:00+00:00")],
                )
            ],
            completed_at="2026-09-10T11:00:00+00:00",
        ),
    ]
    report = progress.monthly_report(workouts, 2026, 9)
    assert report["most_improved"] == []


def test_monthly_report_most_improved_caps_at_five_sorted_descending():
    exercises = [
        "barbell_curl",
        "barbell_bench_press",
        "barbell_row",
        "overhead_press",
        "barbell_back_squat",
        "romanian_deadlift",
    ]
    workouts = []
    for i, exercise_id in enumerate(exercises):
        before = 100 + i
        after = before * (2 + i)  # distinct, increasing improvement percentages
        workouts.append(
            _workout(
                f"before-{i}",
                "completed",
                [
                    WorkoutExercise(
                        exercise_id=exercise_id,
                        sets=[_set(1, before, recorded_at="2026-08-01T10:00:00+00:00")],
                    )
                ],
                completed_at="2026-08-01T11:00:00+00:00",
            )
        )
        workouts.append(
            _workout(
                f"after-{i}",
                "completed",
                [
                    WorkoutExercise(
                        exercise_id=exercise_id,
                        sets=[_set(1, after, recorded_at="2026-09-01T10:00:00+00:00")],
                    )
                ],
                completed_at="2026-09-01T11:00:00+00:00",
            )
        )
    report = progress.monthly_report(workouts, 2026, 9)
    assert len(report["most_improved"]) == 5
    percents = [e["percent_improved"] for e in report["most_improved"]]
    assert percents == sorted(percents, reverse=True)


def test_monthly_report_muscle_breakdown_counts_days_and_sets_per_group():
    workouts = [
        _workout(
            "w1",
            "completed",
            [
                WorkoutExercise(
                    exercise_id="barbell_bench_press",
                    sets=[
                        _set(5, 135, recorded_at="2026-09-05T10:00:00+00:00"),
                        _set(5, 135, recorded_at="2026-09-05T10:05:00+00:00"),
                    ],
                ),
                WorkoutExercise(
                    exercise_id="barbell_curl",
                    sets=[_set(8, 50, recorded_at="2026-09-05T10:10:00+00:00")],
                ),
            ],
            completed_at="2026-09-05T11:00:00+00:00",
        ),
        _workout(
            "w2",
            "completed",
            [
                WorkoutExercise(
                    exercise_id="barbell_bench_press",
                    sets=[_set(5, 135, recorded_at="2026-09-12T10:00:00+00:00")],
                ),
            ],
            completed_at="2026-09-12T11:00:00+00:00",
        ),
    ]
    report = progress.monthly_report(workouts, 2026, 9)
    breakdown = {g["muscle_group"]: g for g in report["muscle_breakdown"]}
    assert breakdown["chest"]["days"] == 2
    assert breakdown["chest"]["sets"] == 3
    assert breakdown["biceps"]["days"] == 1
    assert breakdown["biceps"]["sets"] == 1
    # Sorted by sets descending.
    assert report["muscle_breakdown"][0]["muscle_group"] == "chest"


def test_monthly_report_muscle_breakdown_ignores_incomplete_sets():
    workouts = [
        _workout(
            "w1",
            "completed",
            [
                WorkoutExercise(
                    exercise_id="barbell_bench_press",
                    sets=[_set(5, 135, completed=False, recorded_at="2026-09-05T10:00:00+00:00")],
                ),
            ],
            completed_at="2026-09-05T11:00:00+00:00",
        ),
    ]
    report = progress.monthly_report(workouts, 2026, 9)
    assert report["muscle_breakdown"] == []


def test_progress_state_combines_strength_score_streak_and_month():
    profile = _profile(bodyweight=180, age=30, personal_records={"barbell_bench_press": 180})
    workouts = [
        _workout("w1", "completed", [], completed_at="2026-09-21T10:00:00+00:00"),
    ]
    result = progress.progress_state(profile, workouts, date(2026, 9, 21))
    assert result["strength_score"]["overall_score"] == 100
    assert result["streak_days"] == 1
    assert result["this_month"]["workouts_completed"] == 1
