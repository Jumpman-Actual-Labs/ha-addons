"""One generated-session boundary, shared by wizard, chat and programs."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime

from .exercise_metadata import METADATA, movement_slots
from .exercises import EXERCISE_LIBRARY
from .models import AthleteProfile, GainsData
from .planning_contracts import ENGINE_VERSION, PlanningError, PlanningIntent, SessionSpec
from .workout_planner import (
    exercise_family,
    focus_constraints,
    focus_name,
    select_exercises,
)


def plan_session(
    intent: PlanningIntent,
    profile: AthleteProfile,
    data: GainsData,
    allowed: set[str],
    *,
    at: datetime | None = None,
    reservations: set[str] | None = None,
) -> dict:
    at = at or datetime.now(UTC)
    focus = focus_name(intent.focus)
    targets, roles = focus_constraints(intent.focus)
    from .load_policy import feasible_ids, gym_for

    original_allowed = set(allowed)
    allowed = feasible_ids(EXERCISE_LIBRARY, allowed, profile, data)
    spec = SessionSpec(
        focus,
        focus,
        tuple(sorted(targets)),
        "strength"
        if "hypertrophy" not in intent.focus.lower()
        and ("strong" in intent.goal.lower() or "power" in intent.focus.lower())
        else "hypertrophy",
        movement_slots(focus),
    )
    ids = select_exercises(
        EXERCISE_LIBRARY,
        allowed,
        [w for w in data.workouts if w.profile_id == profile.id],
        intent.focus,
        as_of=at,
        seed=intent.seed,
        variety=intent.variety,
        reservations=reservations,
        required=intent.required,
        excluded=intent.excluded,
        preferred=intent.preferred,
    )
    catalog = {e["id"]: e for e in EXERCISE_LIBRARY}
    missing = [
        sorted(role)
        for role in roles
        if not any(set(catalog[i]["muscles"]["primary"]) & role for i in ids)
    ]
    if missing:
        raise PlanningError('missing_session_roles', missing)
    for slot in spec.movements:
        if not any(METADATA[i]['movement'] == slot for i in ids):
            raise PlanningError('missing_movement_slot', slot)
    reps = 5 if spec.policy == "strength" else 10
    rest = max(profile.rest_timer_seconds, 120 if spec.policy == "strength" else 60)
    from .recovery import muscle_recovery

    recovery = muscle_recovery(data.workouts, profile.id, at)
    fatigued = any(recovery["muscles"][m]["recovery_percent"] < 40 for m in spec.targets)
    set_count = (
        2
        if fatigued or intent.intensity.lower() == "light" or profile.experience_level == "kids"
        else 3
    )
    exercises = [
        {
            "exercise_id": i,
            "rest_seconds": rest,
            "sets": [
                {
                    "reps": 30
                    if catalog[i].get("is_timed")
                    else 1
                    if catalog[i]["category"] == "carry"
                    else 10
                    if METADATA[i]["isolation"]
                    else reps,
                    "weight": None,
                    "set_type": "working",
                }
                for _ in range(set_count)
            ],
        }
        for i in ids
    ]
    from .prescription_engine import prescribe

    load_reasons = {}
    for e in exercises:
        _, load_reasons[e["exercise_id"]] = prescribe(
            catalog[e["exercise_id"]],
            e,
            profile,
            data,
            "hypertrophy" if 'main' not in METADATA[e['exercise_id']]['roles'] else spec.policy,
            at,
        )
    minimum = {i for i in intent.required}
    for role in roles:
        match = next(i for i in ids if set(catalog[i]["muscles"]["primary"]) & role)
        minimum.add(match)
    for slot in spec.movements:
        minimum.add(next(i for i in ids if METADATA[i]['movement'] == slot))

    def minutes() -> float:
        # Five minutes warmup, one minute transitions, three seconds per repetition.
        return round(
            5
            + sum(
                60
                + sum(
                    (s["reps"] if catalog[e["exercise_id"]].get("is_timed") else s["reps"] * 3)
                    for s in e["sets"]
                )
                + max(0, len(e["sets"]) - 1) * e["rest_seconds"]
                for e in exercises
            )
            / 60,
            1,
        )

    while minutes() > intent.duration_minutes:
        optional = next((e for e in reversed(exercises) if e["exercise_id"] not in minimum), None)
        if optional:
            exercises.remove(optional)
        elif any(len(e["sets"]) > 1 for e in exercises):
            next(e for e in reversed(exercises) if len(e["sets"]) > 1)["sets"].pop()
        else:
            raise PlanningError('duration_budget', intent.duration_minutes)
    return {
        "name": intent.focus + " Training",
        "exercises": exercises,
        "planning": {
            "engine_version": ENGINE_VERSION,
            "session_spec": spec.to_dict(),
            "intent": intent.to_dict(),
            "reasons": {
                e["exercise_id"]: [
                    "target_eligible",
                    f"family:{exercise_family(catalog[e['exercise_id']])}",
                ]
                + load_reasons[e["exercise_id"]]
                for e in exercises
            },
            "seed": intent.seed,
            "candidate_count": len(allowed & set(METADATA)),
            "rejected_candidates": {
                "equipment_or_load": len(original_allowed - allowed),
                "metadata_unreviewed": len(allowed - set(METADATA)),
            },
            "unmet_preferences": [
                i for i in intent.preferred if i not in {e["exercise_id"] for e in exercises}
            ],
            "variety": intent.variety,
            "estimated_duration_minutes": minutes(),
            "recovery": recovery,
            "warnings": (["inventory_not_configured"] if gym_for(profile, data) is None else [])
            + (
                ["recovery_conflict"]
                if any(recovery["muscles"][m]["recovery_percent"] < 40 for m in spec.targets)
                else []
            ),
        },
    }


def with_focus(intent: PlanningIntent, focus: str) -> PlanningIntent:
    return replace(intent, focus=focus)
