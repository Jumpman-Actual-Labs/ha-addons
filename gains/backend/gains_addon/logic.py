"""Pure business logic -- no Home Assistant imports.

Kept separate from coordinator.py so it stays unit-testable with plain
pytest, matching Cache's logic.py convention.
"""

from __future__ import annotations

import json
import re
from typing import Any

from .const import (
    ACTIVITY_LEVELS,
    ATTR_ACTIVITY_LEVEL,
    ATTR_AI_CONVERSATION,
    ATTR_CREATED_AT,
    ATTR_DISPLAY_NAME,
    ATTR_EXPERIENCE_LEVEL,
    ATTR_GYM_PROFILE_ID,
    ATTR_GYM_PROFILES,
    ATTR_HA_USER_ID,
    ATTR_INCOMING_SHARES,
    ATTR_IS_ADMIN,
    ATTR_LINKABLE_PROFILES,
    ATTR_LINKED_PROFILES,
    ATTR_ONBOARDING_COMPLETE,
    ATTR_PERSONAL_RECORDS,
    ATTR_PREFERRED_DURATION_MINUTES,
    ATTR_PROFILE_ID,
    ATTR_REST_TIMER_SECONDS,
    ATTR_RUNS,
    ATTR_SHARE_TARGETS,
    ATTR_UNITS,
    ATTR_UPDATED_AT,
    ATTR_WORKOUTS,
    EXPERIENCE_LEVELS,
    RUN_TYPES,
    UNITS,
)
from .equipment import get_equipment_item
from .inventory_units import gym_as_units as _gym_as_units
from .models import AthleteProfile, GymProfile, Run, ShareRequest, Workout

_JSON_FENCE_RE = re.compile(r"^```(?:json)?\s*(.*?)\s*```$", re.DOTALL)


def default_display_name(person_name: str | None, fallback_user_id: str) -> str:
    """Fall back to a short slice of the HA user id if no person name is known."""
    if person_name and person_name.strip():
        return person_name.strip()
    return f"Athlete {fallback_user_id[:8]}"


def new_profile_is_admin(existing_profiles: list[AthleteProfile]) -> bool:
    """The first profile created on a fresh instance is auto-granted admin."""
    return len(existing_profiles) == 0


def find_profile_by_user_id(
    profiles: list[AthleteProfile], ha_user_id: str
) -> AthleteProfile | None:
    for profile in profiles:
        if profile.ha_user_id == ha_user_id:
            return profile
    return None


def find_profile_by_id(profiles: list[AthleteProfile], profile_id: str) -> AthleteProfile | None:
    for profile in profiles:
        if profile.id == profile_id:
            return profile
    return None


def find_gym_profile_by_id(
    gym_profiles: list[GymProfile], gym_profile_id: str
) -> GymProfile | None:
    for gym in gym_profiles:
        if gym.id == gym_profile_id:
            return gym
    return None


def find_workout_by_id(workouts: list[Workout], workout_id: str) -> Workout | None:
    for workout in workouts:
        if workout.id == workout_id:
            return workout
    return None


def workouts_for_profile(workouts: list[Workout], profile_id: str) -> list[Workout]:
    return [w for w in workouts if w.profile_id == profile_id]


def find_run_by_id(runs: list[Run], run_id: str) -> Run | None:
    for run in runs:
        if run.id == run_id:
            return run
    return None


def runs_for_profile(runs: list[Run], profile_id: str) -> list[Run]:
    return [r for r in runs if r.profile_id == profile_id]


def estimate_one_rep_max(weight: float, reps: int) -> float:
    """Epley formula. A single-rep (or bodyweight/unknown-rep) set's
    estimated 1RM is just the weight itself."""
    if reps <= 1:
        return weight
    return weight * (1 + reps / 30)


def is_new_personal_record(
    personal_records: dict[str, float], exercise_id: str, estimated_one_rep_max: float
) -> bool:
    current_best = personal_records.get(exercise_id)
    return current_best is None or estimated_one_rep_max > current_best


def linked_profile_summaries(
    profile: AthleteProfile, all_profiles: list[AthleteProfile]
) -> list[dict[str, str]]:
    """{profile_id, display_name} for every profile this athlete has
    linked that still exists -- a stale id (the other profile was somehow
    removed) is silently dropped rather than surfaced as a broken entry."""
    by_id = {p.id: p for p in all_profiles}
    return [
        {"profile_id": pid, "display_name": by_id[pid].display_name}
        for pid in profile.linked_profile_ids
        if pid in by_id
    ]


def linkable_profile_summaries(
    profile: AthleteProfile, all_profiles: list[AthleteProfile]
) -> list[dict[str, str]]:
    """{profile_id, display_name} for every other profile on this instance
    not already linked -- who this athlete *could* link to. Being on the
    same Home Assistant instance already implies a shared-household trust
    level (matches how profile_count has always been visible instance-
    wide), so this is a convenience list, not a privacy boundary."""
    linked = set(profile.linked_profile_ids)
    return [
        {"profile_id": p.id, "display_name": p.display_name}
        for p in all_profiles
        if p.id != profile.id and p.id not in linked
    ]


def other_profile_summaries(
    profile: AthleteProfile, all_profiles: list[AthleteProfile]
) -> list[dict[str, str]]:
    """{profile_id, display_name} for every other profile on this Home
    Assistant instance, regardless of link status -- the share-target
    picker uses this so sharing a workout/run/program never requires
    linking first. Matches linkable_profile_summaries' own reasoning
    (same-instance already implies shared-household trust), just without
    the "not already linked" filter, since sharing isn't gated on linking
    at all."""
    return [
        {"profile_id": p.id, "display_name": p.display_name}
        for p in all_profiles
        if p.id != profile.id
    ]


def incoming_share_summaries(
    profile: AthleteProfile,
    share_requests: list[ShareRequest],
    all_profiles: list[AthleteProfile],
) -> list[dict[str, Any]]:
    """Pending shares offered TO this profile, newest first, with the
    sender's display name already resolved so the panel can render an
    accept/decline list without a second lookup."""
    by_id = {p.id: p for p in all_profiles}
    pending = [r for r in share_requests if r.to_profile_id == profile.id and r.status == "pending"]
    return [
        {
            "id": r.id,
            "kind": r.kind,
            "device_mode": r.payload.get("device_mode") if r.kind == "joint_workout" else None,
            "name": r.name,
            "from_profile_id": r.from_profile_id,
            "from_display_name": by_id[r.from_profile_id].display_name
            if r.from_profile_id in by_id
            else "Someone",
            "created_at": r.created_at,
        }
        for r in sorted(pending, key=lambda r: r.created_at, reverse=True)
    ]


def profile_extra_attributes(
    profile: AthleteProfile,
    workouts: list[Workout],
    runs: list[Run],
    all_profiles: list[AthleteProfile] | None = None,
    gym_profiles: list[GymProfile] | None = None,
    share_requests: list[ShareRequest] | None = None,
) -> dict[str, Any]:
    """Every field GainsAthleteProfileSensor exposes as an HA attribute.

    Pulled out of sensor.py so a future new AthleteProfile field forgotten
    here fails a plain pytest run instead of only surfacing as a frontend
    field that silently never updates (see the missing experience_level
    regression this function was added to guard against).
    """
    from .recovery import muscle_recovery

    all_profiles = all_profiles or [profile]
    gym_profiles = gym_profiles if gym_profiles is not None else []
    share_requests = share_requests if share_requests is not None else []
    return {
        "muscle_recovery": muscle_recovery(workouts, profile.id),
        ATTR_PROFILE_ID: profile.id,
        ATTR_HA_USER_ID: profile.ha_user_id,
        ATTR_DISPLAY_NAME: profile.display_name,
        ATTR_UNITS: profile.units,
        ATTR_EXPERIENCE_LEVEL: profile.experience_level,
        ATTR_ACTIVITY_LEVEL: profile.activity_level,
        ATTR_PREFERRED_DURATION_MINUTES: profile.preferred_duration_minutes,
        ATTR_REST_TIMER_SECONDS: profile.rest_timer_seconds,
        "preferred_sequencing_policy": profile.preferred_sequencing_policy,
        ATTR_IS_ADMIN: profile.is_admin,
        ATTR_ONBOARDING_COMPLETE: profile.onboarding_complete,
        ATTR_CREATED_AT: profile.created_at,
        ATTR_UPDATED_AT: profile.updated_at,
        ATTR_PERSONAL_RECORDS: profile.personal_records,
        ATTR_WORKOUTS: [w.to_dict() for w in workouts],
        ATTR_RUNS: [r.to_dict() for r in runs],
        ATTR_AI_CONVERSATION: [m.to_dict() for m in profile.ai_conversation],
        ATTR_GYM_PROFILE_ID: profile.gym_profile_id,
        ATTR_GYM_PROFILES: [_gym_as_units(g, profile.units) for g in gym_profiles],
        ATTR_LINKED_PROFILES: linked_profile_summaries(profile, all_profiles),
        ATTR_LINKABLE_PROFILES: linkable_profile_summaries(profile, all_profiles),
        ATTR_SHARE_TARGETS: other_profile_summaries(profile, all_profiles),
        ATTR_INCOMING_SHARES: incoming_share_summaries(profile, share_requests, all_profiles),
    }


def available_equipment_categories(
    profile: AthleteProfile, gym_profiles: list[GymProfile]
) -> set[str]:
    """The broad exercise-library equipment tags (barbell/dumbbell/
    kettlebell/machine/cable/bodyweight/bands/box/other) this athlete can
    actually use, derived from their selected GymProfile's checked
    equipment.EQUIPMENT_CATALOG items. bodyweight is always included -- no
    equipment is needed for it, so it's never gated on what's checked."""
    categories = {"bodyweight"}
    if profile.gym_profile_id is None:
        return categories
    gym = find_gym_profile_by_id(gym_profiles, profile.gym_profile_id)
    if gym is None:
        return categories
    for equipment_id in gym.equipment:
        item = get_equipment_item(equipment_id)
        if item:
            categories.add(item["equipment_category"])
    return categories


def build_strength_summary(profile: AthleteProfile, workouts: list[Workout]) -> str:
    """One line per exercise this athlete has actually logged data for,
    combining their last logged working set (actual reps/weight), the
    effort rating they gave that exercise afterward, and (once enough
    sets exist) an estimated one-rep max -- the same signals a human coach
    would use to decide whether to nudge next time's weight up, down, or
    hold it steady. Built from *this athlete's own* workouts only (never
    cross-athlete) via workouts_for_profile, matching every other read
    here. Returns "" if nothing has been logged yet."""
    own_workouts = workouts_for_profile(workouts, profile.id)
    latest: dict[str, dict[str, Any]] = {}
    for workout in own_workouts:
        for exercise in workout.exercises:
            completed_sets = [
                s
                for s in exercise.sets
                if s.completed and s.actual_weight is not None and s.actual_reps is not None
            ]
            if not completed_sets and not exercise.effort:
                continue
            entry = latest.setdefault(exercise.exercise_id, {})
            if completed_sets:
                last_set = completed_sets[-1]
                entry["reps"] = last_set.actual_reps
                entry["weight"] = last_set.actual_weight
            if exercise.effort:
                entry["effort"] = exercise.effort

    lines = []
    for exercise_id, entry in latest.items():
        parts = []
        if "weight" in entry:
            parts.append(f"last logged {entry['reps']} reps @ {entry['weight']}")
        if "effort" in entry:
            parts.append(f"felt {entry['effort']}")
        est_1rm = profile.personal_records.get(exercise_id)
        if est_1rm is not None:
            parts.append(f"est. 1RM {round(est_1rm, 1)}")
        if parts:
            lines.append(f"- {exercise_id}: {', '.join(parts)}")
    return "\n".join(lines)


_EXPERIENCE_GUIDANCE = {
    "kids": (
        "kids/youth athlete -- not a small adult. Normal strength movements "
        "are allowed, including external load, but keep loading conservative "
        "and technique-first. Prefer this athlete's own logged history and "
        "configured equipment; when no history exists use the lighter kids "
        "defaults rather than adult starting loads. Keep instructions simple "
        "and assume a parent or guardian is supervising"
    ),
    "beginner": (
        "beginner -- favor simple, well-known compound movements, keep "
        "technical complexity low (avoid olympic-category lifts), and "
        "leave more rest between sets"
    ),
    "novice": (
        "novice -- standard compound movements are fine, moderate "
        "volume, avoid the most technical olympic-category lifts"
    ),
    "intermediate": (
        "intermediate -- normal volume and exercise variety, olympic "
        "lifts and supersets are fine if relevant"
    ),
    "advanced": (
        "advanced -- higher volume/intensity is expected, full exercise "
        "library including olympic lifts is fair game"
    ),
}


def _estimate_exercise_count(duration_minutes: int | None) -> tuple[int, int]:
    """Rough exercise-count range to actually fill a workout of this
    length, assuming ~6-8 minutes per exercise including warm-up and rest
    between sets. Turns a vague "45 minutes" into a concrete, checkable
    instruction -- without this, nothing stops the model from proposing
    one weighted exercise plus two planks and calling it a 45-minute
    workout."""
    minutes = duration_minutes or 45
    low = max(3, round(minutes / 8))
    high = min(12, max(low + 1, round(minutes / 6)))
    return (low, high)


def build_ai_system_prompt(
    profile: AthleteProfile,
    exercise_library: list[dict[str, Any]],
    workouts: list[Workout] | None = None,
    gym_profiles: list[GymProfile] | None = None,
) -> str:
    """Everything the AI needs to onboard the athlete and propose a plan
    using only real exercise ids and run types, sized to the athlete's own
    experience level and preferred workout length. This only makes a
    valid, useful response *more likely* --
    parse_ai_reply/validate_proposed_workouts/validate_proposed_runs/
    sanitize_profile_updates still re-validate everything afterward, since
    the model can't be trusted to follow instructions perfectly (including
    the sizing guidance below, which is advisory, not something the
    deterministic validators can enforce)."""
    gym_profiles = gym_profiles or []
    selected_gym = (
        find_gym_profile_by_id(gym_profiles, profile.gym_profile_id)
        if profile.gym_profile_id
        else None
    )
    # Only gate the library by available equipment once the athlete has
    # actually selected a gym with something checked -- no gym selected
    # yet means "hasn't configured this yet," not "has nothing," so the
    # full library stays available until they do.
    if selected_gym is not None and selected_gym.equipment:
        allowed_categories = available_equipment_categories(profile, gym_profiles)
        usable_exercises = [
            e
            for e in exercise_library
            if e["equipment"] in allowed_categories
            and (
                "requires_equipment_id" not in e
                or e["requires_equipment_id"] in selected_gym.equipment
            )
        ]
    else:
        usable_exercises = exercise_library
    exercise_lines = "\n".join(
        f"- {e['id']}: {e['name']} ({e['category']}, {e['equipment']})"
        + (", timed hold -- prescribe seconds, not reps" if e.get("is_timed") else "")
        for e in usable_exercises
    )
    run_type_list = ", ".join(RUN_TYPES)
    duration = profile.preferred_duration_minutes
    low_count, high_count = _estimate_exercise_count(duration)
    experience_guidance = _EXPERIENCE_GUIDANCE.get(
        profile.experience_level or "", _EXPERIENCE_GUIDANCE["novice"]
    )
    profile_summary = (
        f"units={profile.units}, "
        f"experience_level={profile.experience_level or 'unset'}, "
        f"activity_level={profile.activity_level or 'unset'}, "
        f"preferred_duration_minutes={duration or 'unset'}"
    )
    equipment_setup_lines: list[str] = []
    bar_setup_lines: list[str] = []
    unit_label = "kg" if profile.units == "metric" else "lb"
    if selected_gym is not None:
        for equipment_id, config in selected_gym.equipment_config.items():
            item = get_equipment_item(equipment_id)
            if not item or not isinstance(config, dict):
                continue
            load_type = config.get("load_type")
            if load_type not in {"plate_loaded", "weight_stack"}:
                continue
            details = [
                str(load_type).replace("_", " "),
                f"pulley ratio {config.get('pulley_ratio', 1)}:1",
            ]
            if load_type == "weight_stack":
                if config.get("stack_max") is not None:
                    details.append(f"stack max {config['stack_max']} {unit_label}")
                if config.get("stack_increment") is not None:
                    details.append(f"increment {config['stack_increment']} {unit_label}")
            equipment_setup_lines.append(f"- {item['name']}: {', '.join(details)}")

        for equipment_id, configured_weights in selected_gym.equipment.items():
            item = get_equipment_item(equipment_id)
            if (
                not item
                or item.get("category") != "bars_and_plates"
                or item.get("equipment_category") != "barbell"
                or equipment_id in {"landmine", "plates"}
            ):
                continue
            weights = sorted(
                {
                    float(item["default_weight"] if value is None else value)
                    for value in configured_weights
                    if value is not None or item.get("default_weight") is not None
                }
            )
            if weights:
                bar_setup_lines.append(
                    f"- {item['name']}: "
                    + ", ".join(f"{weight:g} {unit_label}" for weight in weights)
                )
    equipment_setup_section = (
        "Configured machine loading (use this when reasoning about cable exercise "
        "weights; plate-loaded cable stations use the athlete's plates rather than "
        "a selectorized stack):\n"
        + "\n".join(equipment_setup_lines)
        + "\n\n"
        if equipment_setup_lines
        else ""
    )
    bar_setup_section = (
        "Configured bars. For barbell exercises, every prescribed set weight is "
        "TOTAL lifted weight including the bar. For a generic barbell exercise, "
        "assume the Olympic Barbell when one is configured unless the exercise "
        "requires a specific bar. Never prescribe a total below the assumed bar's "
        "own weight. The athlete can switch to another configured bar during the "
        "workout:\n"
        + "\n".join(bar_setup_lines)
        + "\n\n"
        if bar_setup_lines
        else ""
    )
    strength_summary = build_strength_summary(profile, workouts or [])
    strength_section = (
        "Known strength from this athlete's own logged sets (use it to "
        "recommend a sensible starting weight per exercise -- nudge the "
        "weight up if the last effort was easy/moderate, hold or reduce it "
        "if it was hard/max; for any exercise not listed, propose a "
        f"conservative estimate and let the athlete adjust):\n{strength_summary}\n\n"
        if strength_summary
        else ""
    )
    return (
        "You are Geoffrey, Gains' AI training assistant inside Home Assistant. "
        "You help with three things: (1) casual onboarding -- filling in "
        "missing profile fields (units, experience_level, activity_level, "
        "preferred_duration_minutes) through natural conversation, (2) "
        "proposing one or more strength workouts, built only from the "
        "exercise library below, and (3) proposing one or more runs. A "
        "multi-day plan (e.g. \"5 days a week\") should propose one entry "
        "per training day across proposed_workouts and proposed_runs "
        "together -- do not squeeze a whole week into a single workout.\n\n"
        f"Current profile: {profile_summary}\n\n"
        "You MUST size every proposed workout to this athlete's own "
        f"profile: preferred_duration_minutes is {duration or 'unset (assume 45)'} "
        f"minutes, which needs roughly {low_count}-{high_count} exercises "
        "(at 2-4 sets each) to actually fill that time -- a workout with "
        "only one or two exercises is too short regardless of how many "
        f"sets it has. This athlete's experience_level is {experience_guidance}.\n\n"
        f"{strength_section}"
        f"{equipment_setup_section}"
        f"{bar_setup_section}"
        "For every exercise that uses external load (barbell, dumbbell, "
        "kettlebell, machine, cable, or bands -- anything except "
        "bodyweight), you MUST propose a specific numeric weight for every "
        "set, never null -- the athlete sees this as a prefilled starting "
        "point they can adjust, so a blank field is a worse experience "
        "than an imperfect number. Base it on the known-strength summary "
        "above when that exercise appears there; otherwise estimate a "
        "conservative, experience_level-appropriate starting weight (e.g. "
        "an empty or lightly-loaded barbell for a beginner, moderate "
        "load for novice/intermediate, heavier for advanced) rather than "
        "leaving it blank. weight may stay null only for exercises with "
        "nothing to load (bodyweight, planks, holds).\n\n"
        "The exercise library below is already filtered to equipment this "
        "athlete has told Gains they have access to -- every exercise "
        "listed is fair game, and nothing outside this list should ever "
        "be proposed.\n\n"
        f"Exercise library (id: name (category, equipment)):\n{exercise_lines}\n\n"
        f"Run types: {run_type_list}. Runs are logged as a whole afterward "
        "(distance + duration), not set-by-set like a strength workout, so "
        "only give a run a name, run_type, and an optional target distance "
        "and/or target duration -- never exercises or sets.\n\n"
        "You do not have the authority to save anything yourself -- you only "
        "propose, and the athlete has to explicitly approve each item "
        "afterward. Respond with ONLY a single JSON object (no markdown "
        "fences, no prose outside it) shaped exactly like this:\n"
        '{"reply": "<what you say to the athlete>", '
        '"profile_updates": {"units": "imperial|metric", '
        '"experience_level": "beginner|novice|intermediate|advanced", '
        '"activity_level": "sedentary|lightly_active|active|very_active", '
        '"preferred_duration_minutes": <10-180>} or null if nothing to '
        "update (only include fields the athlete actually told you), "
        '"proposed_workouts": [{"name": "<workout name>", "exercises": '
        '[{"exercise_id": "<must be a real id from the library above>", '
        '"sets": [{"reps": <number or null>, "weight": <number or null>}, '
        '...]}, ...]}, ...] (empty list if no workout day was asked for), '
        '"proposed_runs": [{"name": "<run name>", '
        f'"run_type": "<one of {run_type_list}>", '
        '"target_distance": <number or null>, '
        '"target_duration_minutes": <number or null>}, ...] '
        "(empty list if no run day was asked for)}"
    )


def parse_ai_reply(raw_text: str) -> dict[str, Any]:
    """Parse the AI's raw text into
    {reply, profile_updates, proposed_workouts, proposed_runs}.

    Tolerant of markdown code fences and non-JSON replies -- if nothing
    parses as the expected shape, the whole raw_text becomes the reply so
    the conversation never breaks just because a model didn't follow the
    JSON-only instruction. Also tolerant of an older singular
    "proposed_workout" (a dict, not a list) in case a model ignores the
    plural-list instruction -- wrapped into a one-item list.
    """
    fallback = {
        "reply": raw_text.strip(),
        "profile_updates": None,
        "proposed_workouts": [],
        "proposed_runs": [],
    }

    candidate = raw_text.strip()
    fence_match = _JSON_FENCE_RE.match(candidate)
    if fence_match:
        candidate = fence_match.group(1)

    try:
        parsed = json.loads(candidate)
    except (json.JSONDecodeError, TypeError):
        return fallback

    if not isinstance(parsed, dict):
        return fallback

    reply = parsed.get("reply")
    if not isinstance(reply, str) or not reply.strip():
        reply = raw_text.strip()

    profile_updates = parsed.get("profile_updates")
    if not isinstance(profile_updates, dict):
        profile_updates = None

    proposed_workouts = parsed.get("proposed_workouts")
    if not isinstance(proposed_workouts, list):
        singular_workout = parsed.get("proposed_workout")
        proposed_workouts = [singular_workout] if isinstance(singular_workout, dict) else []
    proposed_workouts = [w for w in proposed_workouts if isinstance(w, dict)]

    proposed_runs = parsed.get("proposed_runs")
    proposed_runs = [r for r in proposed_runs if isinstance(r, dict)] if isinstance(
        proposed_runs, list
    ) else []

    return {
        "reply": reply,
        "profile_updates": profile_updates,
        "proposed_workouts": proposed_workouts,
        "proposed_runs": proposed_runs,
    }


def sanitize_profile_updates(updates: dict[str, Any] | None) -> dict[str, Any]:
    """Keep only known fields with valid enum values -- the same allow-list
    gains.update_profile's voluptuous schema enforces for a manual edit, so
    an AI proposal can't smuggle in an arbitrary field or an invalid value."""
    if not updates:
        return {}

    sanitized: dict[str, Any] = {}

    if updates.get("units") in UNITS:
        sanitized["units"] = updates["units"]
    if updates.get("experience_level") in EXPERIENCE_LEVELS:
        sanitized["experience_level"] = updates["experience_level"]
    if updates.get("activity_level") in ACTIVITY_LEVELS:
        sanitized["activity_level"] = updates["activity_level"]

    duration = updates.get("preferred_duration_minutes")
    if (
        isinstance(duration, int | float)
        and not isinstance(duration, bool)
        and 10 <= duration <= 180
    ):
        sanitized["preferred_duration_minutes"] = int(duration)

    display_name = updates.get("display_name")
    if isinstance(display_name, str) and display_name.strip():
        sanitized["display_name"] = display_name.strip()

    return sanitized


_DEFAULT_STARTING_WEIGHT = {
    "barbell": 45.0,
    "dumbbell": 20.0,
    "kettlebell": 20.0,
    "machine": 30.0,
    "cable": 20.0,
}

_KIDS_DEFAULT_STARTING_WEIGHT = {
    "barbell": 11.0,  # a youth technique/training bar, not a 45lb adult bar
    "dumbbell": 3.0,
    "kettlebell": 5.0,
    "machine": 10.0,
    "cable": 5.0,
}


def _default_weight_for_exercise(
    exercise_id: str, profile: AthleteProfile, equipment: str
) -> float | None:
    """Deterministic fallback for when the AI leaves a weighted set's
    weight null despite the system prompt's instruction not to -- prompt
    instructions are advisory, not enforceable, so the frontend's "prefill
    from the coach" promise needs a guarantee that doesn't depend on the
    model actually following them. Prefers the athlete's own estimated
    1RM (70% of it, rounded to the nearest 5) when known; otherwise a
    conservative equipment-appropriate starting point. Equipment with
    nothing to load (bodyweight, bands, box, other) intentionally has no
    entry here and stays null. A kids profile skips adult 1RM-based default
    loading and gets its own much lighter equipment defaults when no explicit
    weight was supplied -- weighted exercises are still allowed, but the
    fallback must not silently jump to an adult-sized starting load."""
    if profile.experience_level == "kids":
        return _KIDS_DEFAULT_STARTING_WEIGHT.get(equipment)
    estimated_1rm = profile.personal_records.get(exercise_id)
    if estimated_1rm is not None:
        working_weight = estimated_1rm * 0.7
        return round(working_weight / 5) * 5
    return _DEFAULT_STARTING_WEIGHT.get(equipment)


def _validate_one_proposed_workout(
    proposed: dict[str, Any],
    valid_exercise_ids: frozenset[str],
    equipment_by_id: dict[str, str],
    profile: AthleteProfile,
) -> dict[str, Any] | None:
    """Strip any exercise the AI hallucinated an id for. If nothing valid
    remains, drop the whole proposal rather than let the athlete accept an
    empty workout. Shape matches gains.create_workout's own schema so the
    frontend can hand an accepted proposal straight to that service."""
    name = proposed.get("name")
    if not isinstance(name, str) or not name.strip():
        name = "AI-Suggested Workout"

    raw_exercises = proposed.get("exercises")
    if not isinstance(raw_exercises, list):
        return None

    exercises: list[dict[str, Any]] = []
    for raw_exercise in raw_exercises:
        if not isinstance(raw_exercise, dict):
            continue
        exercise_id = raw_exercise.get("exercise_id")
        if exercise_id not in valid_exercise_ids:
            continue
        equipment = equipment_by_id.get(exercise_id, "")

        sets: list[dict[str, Any]] = []
        raw_sets = raw_exercise.get("sets")
        if isinstance(raw_sets, list):
            for raw_set in raw_sets:
                if not isinstance(raw_set, dict):
                    continue
                reps = raw_set.get("reps")
                weight = raw_set.get("weight")
                weight = weight if isinstance(weight, int | float) else None
                if weight is None:
                    weight = _default_weight_for_exercise(exercise_id, profile, equipment)
                sets.append(
                    {
                        "reps": reps if isinstance(reps, int | float) else None,
                        "weight": weight,
                    }
                )
        if not sets:
            default_weight = _default_weight_for_exercise(exercise_id, profile, equipment)
            sets = [{"reps": None, "weight": default_weight}]

        exercises.append({"exercise_id": exercise_id, "sets": sets})

    if not exercises:
        return None

    return {"name": name.strip(), "exercises": exercises}


def validate_proposed_workouts(
    proposed: list[dict[str, Any]] | None,
    valid_exercise_ids: frozenset[str],
    exercise_library: list[dict[str, Any]],
    profile: AthleteProfile,
) -> list[dict[str, Any]]:
    """Validate every proposed workout in a multi-day plan independently;
    a day that ends up with no valid exercises is dropped rather than
    failing the whole plan."""
    if not proposed:
        return []
    equipment_by_id = {e["id"]: e["equipment"] for e in exercise_library}
    validated = [
        _validate_one_proposed_workout(item, valid_exercise_ids, equipment_by_id, profile)
        for item in proposed
        if isinstance(item, dict)
    ]
    return [w for w in validated if w is not None]


def _validate_one_proposed_run(proposed: dict[str, Any]) -> dict[str, Any] | None:
    """A run proposal is much simpler than a workout -- no exercise
    library to check against, just a name, a run_type from RUN_TYPES, and
    optional numeric targets. Unlike a workout, there's nothing that would
    make a run proposal empty/invalid other than a bad run_type, so this
    only ever normalizes fields rather than dropping the whole proposal."""
    name = proposed.get("name")
    if not isinstance(name, str) or not name.strip():
        name = "AI-Suggested Run"

    run_type = proposed.get("run_type")
    if run_type not in RUN_TYPES:
        run_type = "easy"

    target_distance = proposed.get("target_distance")
    if not isinstance(target_distance, int | float) or isinstance(target_distance, bool):
        target_distance = None

    target_duration = proposed.get("target_duration_minutes")
    if not isinstance(target_duration, int | float) or isinstance(target_duration, bool):
        target_duration = None

    return {
        "name": name.strip(),
        "run_type": run_type,
        "target_distance": target_distance,
        "target_duration_minutes": target_duration,
    }


def validate_proposed_runs(proposed: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if not proposed:
        return []
    validated = [
        _validate_one_proposed_run(item) for item in proposed if isinstance(item, dict)
    ]
    return [r for r in validated if r is not None]
