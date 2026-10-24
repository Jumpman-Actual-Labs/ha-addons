"""Actual completed performance -> fixed ranges -> feasible next prescription."""

from __future__ import annotations

from datetime import UTC, datetime
from math import isfinite

from .load_policy import gym_for, load_bearing, load_ladder
from .models import AthleteProfile, GainsData


def prescribe(
    exercise: dict, planned: dict, profile: AthleteProfile, data: GainsData,
    policy: str, at: datetime | None = None,
    preserve_unknown_targets: bool = False,
) -> tuple[dict, list[str]]:
    at = at or datetime.now(UTC)
    sets = planned["sets"]
    ladder = load_ladder(exercise, profile, data)
    if not ladder and load_bearing(exercise):
        if preserve_unknown_targets:
            return planned, ["manual_override_inventory_unverified"]
        raise ValueError("Cannot recommend a load without verified inventory")
    zero_external = not load_bearing(exercise)
    comparable = []
    for workout in data.workouts:
        if workout.profile_id != profile.id or workout.status != "completed":
            continue
        try:
            ended = datetime.fromisoformat(workout.completed_at or "")
            if ended.tzinfo is None:
                ended = ended.replace(tzinfo=UTC)
            if ended > at:
                continue
        except (ValueError, TypeError):
            continue
        snapshot = getattr(workout, "load_context", {})
        if snapshot and (
            snapshot.get("units") != profile.units
            or snapshot.get("gym_id") != profile.gym_profile_id
        ):
            continue
        gym = gym_for(profile, data)
        if (snapshot.get('inventory') and gym and exercise['equipment'] in {'machine', 'cable'}
                and snapshot['inventory'].get('equipment_config', {}) != gym.equipment_config):
            continue
        for logged in workout.exercises:
            preferred_bar = profile.last_bar_by_exercise.get(exercise["id"], {})
            if (
                preferred_bar
                and logged.selected_bar_equipment_id
                and preferred_bar.get("equipment_id") != logged.selected_bar_equipment_id
            ):
                continue
            working = [s for s in logged.sets if s.set_type != "warmup"]
            if (
                logged.exercise_id == exercise["id"]
                and working
                and all(
                    s.completed
                    and s.actual_reps is not None
                    and isfinite(s.actual_reps) and s.actual_reps > 0
                    and (zero_external or s.actual_weight is not None
                         and isfinite(s.actual_weight) and s.actual_weight >= 0)
                    for s in working
                )
            ):
                comparable.append((ended, logged, working, bool(snapshot)))
    if comparable:
        _, logged, working, known = max(comparable, key=lambda entry: entry[0])
        load = 0 if zero_external else min(s.actual_weight for s in working)
        low, high = (
            (20, 60)
            if exercise.get("is_timed")
            else (1, 3)
            if exercise["category"] == "carry"
            else (3, 6)
            if policy == "strength"
            else (8, 12)
        )
        demanding = (logged.effort or "").lower() in {
            "hard",
            "very hard",
            "max",
            "maximal",
            "failure",
        } or any(s.rpe is not None and s.rpe >= 9 for s in working)
        easy = (logged.effort or "").lower() == "easy" or all(
            s.rpe is not None and s.rpe <= 7 for s in working
        )
        success = len(working) >= len(sets) and all(
            s.actual_reps >= (s.planned_reps or low) for s in working
        )
        realized = min(s.actual_reps for s in working)
        reps = max(
            1,
            min(
                high,
                realized
                if demanding or not success
                else realized + (5 if exercise.get("is_timed") else 1),
            ),
        )
        reasons = ["completed_performance", "known_context" if known else "legacy_context_unknown"]
        assistance = exercise["id"] == "assisted_pull_up"
        next_load = (
            None
            if zero_external
            else (
                next((v for v in reversed(ladder) if v < load - 0.01), None)
                if assistance
                else next((v for v in ladder if v > load + 0.01), None)
            )
        )
        if (
            success
            and easy
            and not demanding
            and realized >= high
            and next_load is not None
            and abs(next_load - load) <= load * 0.05
        ):
            load, reps = next_load, low
            reasons.append('reduced_assistance' if assistance else "feasible_load_progression")
        else:
            reasons.append(
                "hold_load_progress_reps"
                if success and not demanding
                else "hold_after_incomplete_or_hard"
            )
        if not zero_external and ladder and load not in ladder:
            feasible = [v for v in ladder if v <= load]
            if not feasible:
                raise ValueError(
                    "No feasible load: inventory minimum exceeds comparable performance"
                )
            load = max(feasible)
            reasons.append("inventory_adjusted")
    else:
        if preserve_unknown_targets:
            return planned, ['manual_override_no_performance']
        if zero_external:
            for s in sets:
                s["weight"] = 0
            return planned, [
                "timed_seconds" if exercise.get("is_timed") else "bodyweight_repetitions"
            ]
        # No all-time PR shortcut. Canonical conservative starting values are kg.
        kg = (
            2
            if profile.experience_level == "kids"
            else 10
            if exercise["equipment"] == "barbell"
            else 4
        )
        desired = kg if profile.units == "metric" else kg * 2.2046226218
        if ladder:
            feasible = [v for v in ladder if v <= desired]
            if not feasible and profile.experience_level == "kids":
                raise ValueError(
                    "No feasible child starting load: select lighter equipment "
                    "or an explicit reviewed target"
                )
            load = max(feasible) if feasible else min(ladder)
        else:
            load = round(desired, 2)
        reps = sets[0]["reps"]
        reasons = ["inventory_start" if ladder else "inferred_load_inventory_unknown"]
    for s in sets:
        s["reps"], s["weight"] = reps, load
    return planned, reasons
