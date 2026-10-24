"""Shared deterministic training contracts, context and proposal validation."""

from __future__ import annotations

import copy
import json
import math
from datetime import UTC, date, datetime, timedelta
from typing import Any

from . import logic
from .const import RUN_TYPES
from .exercises import EXERCISE_LIBRARY
from .models import AthleteProfile, GainsData, TrainingProgram
from .planning_contracts import (
    effective_answers,
    intent_from_answers,
    normalize_session_preferences,
)
from .session_engine import plan_session, with_focus
from .training_splits import SPLITS, custom_split_focuses, normalize_split, split_focuses
from .workout_planner import next_strength_targets

BUILD_TYPES = {"workout", "run", "program"}
PERMISSIONS = {"view_workouts", "coach_workouts", "view_progress", "manage_programs"}


def number(value: Any, low: float, high: float, integer: bool = False) -> float | int:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError("A numeric value is required")
    if not math.isfinite(value) or not low <= value <= high or integer and int(value) != value:
        raise ValueError(f"Value must be between {low} and {high}")
    return int(value) if integer else float(value)


def text(value: Any, default: str = "", limit: int = 2000) -> str:
    return value.strip()[:limit] if isinstance(value, str) else default


def allowed_exercises(profile: AthleteProfile, data: GainsData) -> set[str]:
    gym = logic.find_gym_profile_by_id(data.gym_profiles, profile.gym_profile_id or "")
    categories = logic.available_equipment_categories(profile, data.gym_profiles)
    return {
        e["id"]
        for e in EXERCISE_LIBRARY
        if (gym is None or e["equipment"] in categories)
        and (
            not e.get("requires_equipment_id")
            or gym
            and e["requires_equipment_id"] in gym.equipment
        )
    }


def validate_workout(raw: Any, profile: AthleteProfile, data: GainsData) -> dict:
    if not isinstance(raw, dict) or not isinstance(raw.get("exercises"), list):
        raise ValueError("Workout needs exercises")
    if not 1 <= len(raw["exercises"]) <= 30:
        raise ValueError("Choose 1–30 exercises")
    allowed = allowed_exercises(profile, data)
    exercises = []
    for e in raw["exercises"]:
        if not isinstance(e, dict) or e.get("exercise_id") not in allowed:
            raise ValueError("Exercise is unavailable for this athlete or selected gym")
        if not isinstance(e.get("sets"), list) or not 1 <= len(e["sets"]) <= 20:
            raise ValueError("Choose 1–20 sets")
        sets = []
        for s in e["sets"]:
            if not isinstance(s, dict):
                raise ValueError("Invalid set")
            reps = number(s.get("reps", 8), 1, 200, True)
            weight = number(0 if s.get("weight") is None else s["weight"], 0, 2000)
            entry = {"reps": reps, "weight": weight}
            if s.get('set_type') in {'working', 'warmup'}:
                entry['set_type'] = s['set_type']
            sets.append(entry)
        entry = {"exercise_id": e["exercise_id"], "sets": sets}
        if e.get('rest_seconds') is not None:
            entry['rest_seconds'] = number(e['rest_seconds'], 0, 600, True)
        exercises.append(entry)
    result = {"name": text(raw.get("name"), "Workout", 100), "exercises": exercises}
    if isinstance(raw.get('planning'), dict):
        result['planning'] = copy.deepcopy(raw['planning'])
    return result


def validate_run(raw: Any) -> dict:
    if not isinstance(raw, dict) or raw.get("run_type", "easy") not in RUN_TYPES:
        raise ValueError("Invalid run type")
    result = {
        "name": text(raw.get("name"), "Run", 100),
        "run_type": raw.get("run_type", "easy"),
        "notes": text(raw.get("notes")),
        "segments": [],
    }
    for key, high in (("target_distance", 500), ("target_duration_minutes", 3000)):
        result[key] = number(raw[key], 0.1, high) if raw.get(key) is not None else None
    segments = raw.get("segments", [])
    if not isinstance(segments, list) or len(segments) > 30:
        raise ValueError("Invalid run segments")
    for seg in segments:
        if not isinstance(seg, dict) or seg.get("phase") not in {"warmup", "main", "cooldown"}:
            raise ValueError("Run segment needs warmup, main or cooldown phase")
        item = {
            "phase": seg["phase"],
            "label": text(seg.get("label"), "Run", 100),
            "repetitions": number(seg.get("repetitions", 1), 1, 100, True),
            "notes": text(seg.get("notes")),
        }
        for key, low, high in (
            ("distance_m", 1, 500000),
            ("duration_seconds", 1, 172800),
            ("recovery_seconds", 0, 7200),
            ("rpe", 1, 10),
            ("pace_min_seconds_per_km", 60, 3600),
            ("pace_max_seconds_per_km", 60, 3600),
        ):
            if seg.get(key) is not None:
                item[key] = number(seg[key], low, high)
        if "distance_m" not in item and "duration_seconds" not in item:
            raise ValueError("Each segment needs a distance or duration")
        if item.get("pace_min_seconds_per_km", 0) > item.get("pace_max_seconds_per_km", 3600):
            raise ValueError("Pace range is reversed")
        result["segments"].append(item)
    return result


def validate_program(raw: Any, profile: AthleteProfile, data: GainsData) -> dict:
    if not isinstance(raw, dict) or not isinstance(raw.get("weeks"), list):
        raise ValueError("Program needs weeks")
    if not 1 <= len(raw["weeks"]) <= 26:
        raise ValueError("Program length must be 1–26 weeks")
    start = text(raw.get("start_date"), date.today().isoformat(), 10)
    date.fromisoformat(start)
    weeks = []
    for wi, week in enumerate(raw["weeks"]):
        if not isinstance(week, dict) or not isinstance(week.get("sessions"), list):
            raise ValueError("Week needs sessions")
        if not 1 <= len(week["sessions"]) <= 14:
            raise ValueError("Choose 1–14 sessions per week")
        sessions = []
        for si, session in enumerate(week["sessions"]):
            if not isinstance(session, dict):
                raise ValueError("Invalid session")
            kind = session.get("type")
            if kind not in {"workout", "run", "hiit", "conditioning", "recovery", "rest"}:
                raise ValueError("Invalid session type")
            prescription = session.get("prescription", {})
            if kind in {"workout", "hiit", "conditioning"}:
                prescription = validate_workout(prescription, profile, data)
            elif kind == "run":
                prescription = validate_run(prescription)
            else:
                prescription = (
                    {"notes": text(prescription.get("notes"))}
                    if isinstance(prescription, dict)
                    else {}
                )
            sessions.append(
                {
                    "id": f"w{wi + 1}s{si + 1}",
                    "day": number(session.get("day"), 0, 6, True),
                    "type": kind,
                    "name": text(session.get("name"), kind.title(), 100),
                    "prescription": prescription,
                    "notes": text(session.get("notes")),
                }
            )
        weeks.append(
            {"week_number": wi + 1, "focus": text(week.get("focus")), "sessions": sessions}
        )
    return {
        "name": text(raw.get("name"), "Training Program", 100),
        "goal": text(raw.get("goal")),
        "start_date": start,
        "weeks": weeks,
    }


def repair_workout_exercises(raw: Any, profile: AthleteProfile, data: GainsData) -> Any:
    """Resolve provider exercise names to real IDs without inventing exercises."""
    if not isinstance(raw, dict) or not isinstance(raw.get("exercises"), list):
        return raw
    import re
    allowed = allowed_exercises(profile, data)
    def canonical(value: Any) -> str:
        return re.sub(r"[^a-z0-9]", "", str(value or "").lower())
    # Common gym shorthand and equivalent names used by athletes and LLMs.
    # Resolve only to canonical IDs that exist in the athlete's allowed set.
    aliases = {
        "bench press": "barbell_bench_press",
        "flat bench": "barbell_bench_press",
        "bb bench": "barbell_bench_press",
        "db bench": "dumbbell_bench_press",
        "dumbbell flat bench press": "dumbbell_bench_press",
        "incline db press": "incline_dumbbell_bench_press",
        "incline bb bench": "incline_barbell_bench_press",
        "rdl": "romanian_deadlift",
        "barbell rdl": "romanian_deadlift",
        "lat pull down": "lat_pulldown",
        "lat pull-down": "lat_pulldown",
        "cable lat pulldown": "lat_pulldown",
        "seated row": "cable_row",
        "seated cable row": "cable_row",
        "bent over row": "barbell_row",
        "barbell bent over row": "barbell_row",
        "db row": "dumbbell_row",
        "one arm dumbbell row": "dumbbell_row",
        "ohp": "overhead_press",
        "military press": "overhead_press",
        "shoulder press": "dumbbell_shoulder_press",
        "lateral raises": "lateral_raise",
        "face pulls": "face_pull",
        "leg curls": "seated_leg_curl",
        "hamstring curl": "seated_leg_curl",
        "leg extensions": "leg_extension",
        "cable crunch": "kneeling_cable_crunch",
        "pallof press": "pallof_press",
        "rear foot elevated split squat": "rear_foot_elevated_split_squat",
        "bulgarian split squat": "bulgarian_split_squat",
    }
    lookup = {}
    for exercise in EXERCISE_LIBRARY:
        if exercise["id"] in allowed:
            for key in ("id", "name"):
                lookup[canonical(exercise.get(key))] = exercise["id"]
    for label, exercise_id in aliases.items():
        if exercise_id in allowed:
            lookup[canonical(label)] = exercise_id
    repaired = copy.deepcopy(raw)
    for exercise in repaired["exercises"]:
        if not isinstance(exercise, dict):
            continue
        if exercise.get("exercise_id") not in allowed:
            for key in ("exercise_id", "name", "exercise", "exercise_name"):
                match = lookup.get(canonical(exercise.get(key)))
                if match:
                    exercise["exercise_id"] = match
                    break
        if exercise.get("exercise_id") in allowed and not exercise.get("sets"):
            exercise["sets"] = [{"reps": 8, "weight": None} for _ in range(3)]
    return repaired


def normalize_generated(kind: str, raw: Any, profile: AthleteProfile, data: GainsData) -> dict:
    if kind == "workout":
        valid_ids = frozenset(allowed_exercises(profile, data))
        raw = repair_workout_exercises(raw, profile, data)
        extras = (
            {
                e["exercise_id"]: e
                for e in raw.get("exercises", [])
                if isinstance(e, dict) and "exercise_id" in e
            }
            if isinstance(raw, dict)
            else {}
        )
        normalized = logic.validate_proposed_workouts([raw], valid_ids, EXERCISE_LIBRARY, profile)
        if not normalized:
            raise ValueError("No usable exercises in proposal")
        raw = normalized[0]
        for exercise in raw["exercises"]:
            original = extras.get(exercise['exercise_id'], {})
            if original.get('rest_seconds') is not None:
                exercise['rest_seconds'] = original['rest_seconds']
            for index, planned in enumerate(exercise["sets"]):
                if index < len(original.get("sets", [])) and original["sets"][index].get(
                    "set_type"
                ) in {"working", "warmup"}:
                    planned['set_type'] = original['sets'][index]['set_type']
            for planned in exercise["sets"]:
                if planned["reps"] is None:
                    planned["reps"] = 8
        from .load_policy import exercise_availability
        from .prescription_engine import prescribe
        catalog = {e["id"]: e for e in EXERCISE_LIBRARY}
        for exercise in raw["exercises"]:
            definition = catalog[exercise["exercise_id"]]
            availability = exercise_availability(definition, profile, data)
            if not availability["feasible"]:
                raise ValueError("; ".join(availability["reasons"]))
            prescribe(definition, exercise, profile, data, "hypertrophy")
    elif kind == "program" and isinstance(raw, dict):
        raw = copy.deepcopy(raw)
        if not isinstance(raw.get("weeks"), list):
            raise ValueError("Program needs weeks")
        for week in raw.get("weeks", [])[:1]:
            if not isinstance(week, dict):
                continue
            if not isinstance(week.get("sessions"), list):
                raise ValueError("Program week needs sessions")
            for session in week.get("sessions", []):
                if not isinstance(session, dict):
                    continue
                session_kind = session.get("type")
                if session_kind in {"workout", "hiit", "conditioning"}:
                    session["prescription"] = normalize_generated(
                        "workout", session.get("prescription"), profile, data
                    )
                elif session_kind == "run":
                    session["prescription"] = normalize_generated(
                        "run", session.get("prescription"), profile, data
                    )
    if kind == "program" and isinstance(raw, dict) and isinstance(raw.get("weeks"), list):
        raw = {**raw, "weeks": raw["weeks"][:1]}
    return validate_proposal(kind, raw, profile, data)


def validate_proposal(kind: str, raw: Any, profile: AthleteProfile, data: GainsData) -> dict:
    if kind == "workout":
        return validate_workout(raw, profile, data)
    if kind == "run":
        return validate_run(raw)
    if kind == "program":
        return validate_program(raw, profile, data)
    raise ValueError("Unknown builder type")


def build_request(raw: Any) -> dict:
    if not isinstance(raw, dict) or raw.get("type") not in BUILD_TYPES:
        raise ValueError("Choose workout, run or program")
    if raw.get("source") not in {"wizard", "geoffrey"} or not isinstance(raw.get("answers"), dict):
        raise ValueError("Invalid builder request")
    if len(json.dumps(raw, allow_nan=False)) > 40000:
        raise ValueError("Builder request is too large")
    answers = effective_answers(raw["answers"], run_duration=raw["type"] == "run")
    if raw["type"] == "program":
        if "session_preferences" in answers:
            answers["session_preferences"] = normalize_session_preferences(
                answers["session_preferences"]
            )
        if answers.get('sequencing_policy', 'calendar') not in {'calendar', 'completion'}:
            raise ValueError('Choose calendar or completion sequencing policy')
        if answers.get("split") == "Custom Split":
            try:
                count = int(answers.get("lifting_days", 0))
            except (TypeError, ValueError) as err:
                raise ValueError("Choose a valid lifting-day count") from err
            answers["custom_split_days"] = custom_split_focuses(
                answers.get("custom_split_days"), count
            )
        # Store a progressive schedule cycle. The Program remains active and
        # repeats that cycle until the athlete explicitly removes it.
        answers.pop("weeks", None)
        answers.pop("weeks_other", None)
        answers["schedule_model"] = "ongoing"
        answers["cycle_weeks"] = 1
    return {"type": raw["type"], "source": raw["source"], "answers": answers}


def adapt_program_session(
    program: TrainingProgram, session: dict, week_number: int, data: GainsData
) -> dict:
    """Use the most recent completed matching program session for next week's targets.

    Existing materialized sessions are never changed. An uncompleted prior
    session cannot be used as evidence of progress.
    """
    adapted = copy.deepcopy(session)
    if week_number <= 1 or session.get("type") != "workout":
        return adapted
    template_id = session["id"]
    previous = []
    for key, occurrence in program.occurrences.items():
        if not key.endswith(f":{template_id}") or not key.startswith("week-"):
            continue
        try:
            previous_week = int(key.split(":", 1)[0][5:])
        except ValueError:
            continue
        if previous_week >= week_number:
            continue
        actual = next(
            (w for w in data.workouts if w.id == occurrence.get("actual_id")
             and w.profile_id == program.profile_id and w.status == "completed"),
            None,
        )
        if actual:
            previous.append((previous_week, actual))
    if not previous:
        return adapted
    prior = max(previous, key=lambda entry: entry[0])[1]
    by_id = {exercise.exercise_id: exercise for exercise in prior.exercises}
    for exercise in adapted["prescription"]["exercises"]:
        logged = by_id.get(exercise["exercise_id"])
        if not logged:
            continue
        catalog_item = next(
            (e for e in EXERCISE_LIBRARY if e["id"] == exercise["exercise_id"]), None
        )
        if catalog_item and catalog_item.get("is_timed"):
            continue
        for index, planned in enumerate(exercise["sets"]):
            if index >= len(logged.sets):
                break
            recorded = logged.sets[index]
            if not recorded.completed or recorded.actual_reps is None:
                continue
            if planned.get("reps") is None:
                continue
            effort = (logged.effort or "").strip().lower()
            demanding = effort in {"hard", "very hard", "max", "maximal", "failure"}
            profile = next(
                (p for p in data.profiles if p.id == program.profile_id), None
            )
            increment = 1.0 if profile and profile.units == "metric" else 2.5
            planned["reps"], planned["weight"] = next_strength_targets(
                planned["reps"],
                recorded.actual_reps,
                recorded.actual_weight,
                recorded.rpe,
                demanding=demanding,
                increment=increment,
            )
    return adapted


def missed_training_priorities(
    program: TrainingProgram, week_number: int, data: GainsData
) -> dict[str, int]:
    """Identify planned primary-muscle sets missed during an earlier week.

    Uses persisted workout completion status, not merely the presence of a
    program occurrence. Missed sessions influence future planning only; old
    workouts and schedules are never edited.
    """
    if week_number < 1 or not program.weeks:
        return {}
    previous = program_week(program, week_number, data)
    catalog = {item["id"]: item for item in EXERCISE_LIBRARY}
    completed = {
        workout.id for workout in data.workouts
        if workout.profile_id == program.profile_id and workout.status == "completed"
    }
    missed: dict[str, int] = {}
    for session in previous["sessions"]:
        if session.get("type") not in {"workout", "hiit", "conditioning"}:
            continue
        occurrence_id = f"week-{week_number}:{session['id']}"
        occurrence = program.occurrences.get(occurrence_id, {})
        if occurrence.get("actual_id") in completed:
            continue
        prescription = session.get("prescription") or {}
        for exercise in prescription.get("exercises", []):
            item = catalog.get(exercise.get("exercise_id"))
            if not item:
                continue
            count = len(exercise.get("sets", []))
            for muscle in item.get("muscles", {}).get("primary", []):
                missed[muscle] = missed.get(muscle, 0) + count
    return dict(sorted(missed.items(), key=lambda pair: (-pair[1], pair[0]))[:8])


def program_week(program: TrainingProgram, week_number: int, data: GainsData) -> dict:
    """Resolve a persisted week or adapt the original template for legacy programs."""
    stored = program.generated_weeks.get(str(week_number))
    if stored:
        return copy.deepcopy(stored)
    if program.origin_request and week_number > 1:
        profile = next(p for p in data.profiles if p.id == program.profile_id)
        template = program_template(program, week_number, data)
        return enforce_week_workouts(template, profile, data, template=template)
    template = program.weeks[(week_number - 1) % len(program.weeks)]
    return {
        **copy.deepcopy(template),
        "week_number": week_number,
        "sessions": [
            adapt_program_session(program, session, week_number, data)
            for session in template["sessions"]
        ],
    }


def program_template(program: TrainingProgram, week_number: int, data: GainsData) -> dict:
    """Stable authored structure plus an explicit continuing rotation policy."""
    template = copy.deepcopy(program.weeks[(week_number - 1) % len(program.weeks)])
    template['week_number'] = week_number
    if not program.origin_request:
        return template
    answers = program.origin_request["answers"]
    workouts = sorted(
        (s for s in template["sessions"] if s["type"] == "workout"), key=lambda s: s["day"]
    )
    offset = (week_number - 1) * len(workouts)
    if program.sequencing_policy == 'completion':
        actual_ids = {o.get("actual_id") for o in program.occurrences.values()}
        finished = {w.id for w in data.workouts if w.id in actual_ids
                    and w.profile_id == program.profile_id and w.status in {'completed', 'skipped'}}
        offset = len(set(program.rotation_events) | finished)
    requested = answers.get('split_other') or answers.get('split')
    custom = answers.get('custom_split_days')
    focuses = (
        [custom[(offset + i) % len(custom)] for i in range(len(workouts))]
        if requested == "Custom Split"
        else split_focuses(requested, len(workouts), offset=offset)
    )
    for session, focus in zip(workouts, focuses, strict=True):
        session["name"] = focus + " Training"
        cycle = (
            custom
            if requested == "Custom Split"
            else SPLITS[normalize_split(requested, len(workouts))]
        )
        preferences = answers.get('session_preferences', {})
        overrides = preferences.get(str(cycle.index(focus) + 1), {})
        profile = next(p for p in data.profiles if p.id == program.profile_id)
        canonical = intent_from_answers(answers | overrides | {'focus': focus}, profile).to_dict()
        canonical['seed'] = answers.get('seed', 0) + week_number - 1
        cadence = answers.get('deload_every', 0)
        if isinstance(cadence, int) and cadence > 0 and week_number % cadence == 0:
            canonical['intensity'] = 'Light'
        session['prescription'].setdefault('planning', {})['intent'] = canonical
    return template


def program_state(program: TrainingProgram, data: GainsData, at: date | None = None) -> dict:
    """Derive progress from actual records, never maintain a second performance copy."""
    import copy
    today = at or date.today()

    result = copy.deepcopy(program.to_dict())
    if not program.weeks:
        result.update(
            {
                "current_week": 1,
                "cycle_week": 1,
                "current_schedule": {"week_number": 1, "focus": "", "sessions": []},
                "completed_sessions": 0,
            }
        )
        return result
    actuals = {
        item.id: item
        for item in [*data.workouts, *data.runs]
        if item.profile_id == program.profile_id
    }
    completed = 0
    for week in result["weeks"]:
        for session in week["sessions"]:
            actual = actuals.get(session.get("actual_id"))
            if actual:
                session["actual_status"] = actual.status
                if actual.status == "completed":
                    session["completed_at"] = actual.completed_at
            if session.get("completed_at"):
                completed += 1
    for occurrence in result.get("occurrences", {}).values():
        actual = actuals.get(occurrence.get("actual_id"))
        if occurrence.get("completed_at") or actual and actual.status == "completed":
            completed += 1
    start_date = date.fromisoformat(program.start_date)
    program_monday = start_date - timedelta(days=start_date.weekday())
    elapsed = max(0, (today - program_monday).days)
    current_week = elapsed // 7 + 1
    cycle_index = (current_week - 1) % len(program.weeks)
    current = program_week(program, current_week, data)
    for session in current["sessions"]:
        template_id = session["id"]
        occurrence_id = f"week-{current_week}:{template_id}"
        occurrence = result.get("occurrences", {}).get(occurrence_id, {})
        session.update(occurrence)
        session["template_id"] = template_id
        session["id"] = occurrence_id
        actual = actuals.get(session.get("actual_id"))
        if actual:
            session["actual_status"] = actual.status
            if actual.status == "completed":
                session["completed_at"] = actual.completed_at
    result["current_week"] = current_week
    result["cycle_week"] = cycle_index + 1
    result["current_schedule"] = current
    result["completed_sessions"] = completed
    upcoming = []
    for absolute_week in range(current_week, current_week + 5):
        template = program_week(program, absolute_week, data)
        for raw_session in template["sessions"]:
            if raw_session["type"] in {"rest", "recovery"}:
                continue
            scheduled = program_monday + timedelta(
                days=(absolute_week - 1) * 7 + raw_session["day"]
            )
            if scheduled < max(today, start_date):
                continue
            session = copy.deepcopy(raw_session)
            template_id = session["id"]
            occurrence_id = f"week-{absolute_week}:{template_id}"
            session.update(result.get("occurrences", {}).get(occurrence_id, {}))
            session.update(
                {
                    "id": occurrence_id,
                    "template_id": template_id,
                    "week_number": absolute_week,
                    "scheduled_date": scheduled.isoformat(),
                }
            )
            actual = actuals.get(session.get("actual_id"))
            if actual:
                session["actual_status"] = actual.status
                if actual.status == "completed":
                    continue
            upcoming.append(session)
    upcoming.sort(key=lambda item: (item["scheduled_date"], item["day"]))
    result["upcoming_sessions"] = upcoming[:8]
    return result


def athlete_context(profile: AthleteProfile, data: GainsData, viewer: AthleteProfile) -> dict:
    workouts = [w for w in data.workouts if w.profile_id == profile.id]
    runs = [r for r in data.runs if r.profile_id == profile.id]
    recent = [r for r in runs if r.status == "completed"][-20:]
    week_start = (
        (datetime.now(UTC) - timedelta(days=datetime.now(UTC).weekday())).date().isoformat()
    )
    mileage = sum(
        r.actual_distance or 0 for r in recent if (r.completed_at or "")[:10] >= week_start
    )
    paced = [r for r in recent if r.actual_distance and r.actual_duration_minutes]
    return {
        "athlete": {
            "id": profile.id,
            "name": profile.display_name,
            "units": profile.units,
            "experience": profile.experience_level,
            "duration": profile.preferred_duration_minutes,
        },
        "viewer": {
            "id": viewer.id,
            "name": viewer.display_name,
            "mode": "self" if viewer.id == profile.id else "coach",
        },
        "strength_summary": logic.build_strength_summary(profile, workouts),
        "recent_workouts": [w.to_dict() for w in workouts[-12:]],
        "recent_runs": [r.to_dict() for r in runs[-20:]],
        "weekly_distance": mileage,
        "longest_recent_run": max((r.actual_distance or 0 for r in recent), default=0),
        "typical_minutes_per_distance_unit": sum(
            r.actual_duration_minutes / r.actual_distance for r in paced
        )
        / len(paced)
        if paced
        else None,
        "equipment": sorted(allowed_exercises(profile, data)),
        "programs": [
            program_state(p, data)
            for p in data.programs
            if p.profile_id == profile.id and p.status == "active"
        ],
    }


SCHEMA_PROMPT = """You are Geoffrey, Gains' training assistant. Never persist or execute
changes.
Return JSON. Chat shape: {"reply":"...", "actions":[{"type":"start_builder",
"builder":"workout|run|program", "prefill":{}}], "proposed_workouts":[], "proposed_runs":[]}.
Use start_builder for program intent or requests needing clarification; prefill all known
answers.
Builder shape: {"proposal": ...}. Workout:
{"name":"...","exercises":[{"exercise_id":"...","sets":[{"reps":8,"weight":0}]}]}.
Run: {"name":"...","run_type":"easy","target_distance":null,
"target_duration_minutes":30,"notes":"...","segments":[{
"phase":"warmup|main|cooldown","label":"...","distance_m":400,
"duration_seconds":null,"repetitions":6,"recovery_seconds":90,
"pace_min_seconds_per_km":300,"pace_max_seconds_per_km":330,"rpe":6}]}.
Program: {"name":"...","goal":"...","start_date":"YYYY-MM-DD",
"weeks":[{"week_number":1,"focus":"Progression rationale","sessions":[{
"day":0,"type":"workout|run|hiit|conditioning|recovery|rest",
"name":"...","prescription":{...},"notes":"..."}]}]}.
Monday=0. Programs continue until removed. Return exactly one week of workouts
for the current training week,
with recovery and rationale. Respect available days and training frequency.
Avoid hard legs
immediately before hard runs. Session prescriptions are full workouts/runs; recovery/rest have
notes. Do not duplicate unrelated workouts. Only use allowed exercise IDs in context. Kids may
use weighted exercises; keep loads conservative and based on their own logged history and
configured equipment rather than adult strength assumptions. Use known session duration/equipment
without asking again. RPE is 1–10. Run
segments use meters, seconds, seconds/km regardless of profile units; top-level distance and
all weights use profile units. No invented PRs or history. For modifications, propose revised
training for explicit review, never claim you changed saved records."""


def system_prompt(profile: AthleteProfile, data: GainsData, viewer: AthleteProfile) -> str:
    return (
        logic.build_ai_system_prompt(profile, EXERCISE_LIBRARY, data.workouts, data.gym_profiles)
        + "\n"
        + SCHEMA_PROMPT
        + "\nATHLETE CONTEXT:\n"
        + json.dumps(athlete_context(profile, data, viewer), allow_nan=False)
    )


def parse_json(raw: str) -> dict:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1].rsplit("```", 1)[0]
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise ValueError("Geoffrey returned an invalid response")
    return result


def generated_proposal(parsed: dict, kind: str) -> Any:
    """Unwrap the common envelopes used by structured-output providers."""
    for key in ("proposal", kind, f"training_{kind}", "plan"):
        candidate = parsed.get(key)
        if isinstance(candidate, dict):
            return candidate
    if kind == "program" and isinstance(parsed.get("schedule"), list):
        return {**parsed, "weeks": parsed["schedule"]}
    return parsed


def fallback_workout(request: dict, profile: AthleteProfile, data: GainsData) -> dict:
    """Build a varied equipment-compatible workout when the AI response is unusable."""
    return generated_workout(request, profile, data)


def generated_workout(request: dict, profile: AthleteProfile, data: GainsData) -> dict:
    """AI output cannot bypass the normalized user session contract."""
    raw = plan_session(intent_from_answers(request['answers'], profile), profile, data,
                       allowed_exercises(profile, data))
    return normalize_generated('workout', raw, profile, data) | {'planning': raw['planning']}


def enforce_program_split(
    program: dict, request: dict, profile: AthleteProfile, data: GainsData
) -> dict:
    """Enforce requested lifting split instead of trusting the AI session names."""
    if request.get("type") != "program":
        return program
    answers = request.get("answers", {})
    requested = answers.get("split_other") or answers.get("split")
    result = copy.deepcopy(program)
    for week in result["weeks"]:
        sessions = sorted(
            (item for item in week["sessions"] if item["type"] == "workout"),
            key=lambda item: item["day"],
        )
        count = answers.get('lifting_days', len(sessions))
        if len(sessions) != count:
            raise ValueError('AI program must preserve requested lifting-day count')
        days = answers.get('days')
        if isinstance(days, list):
            names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
            allowed_days = {names.index(day) for day in days if day in names}
            if any(
                s["day"] not in allowed_days
                for s in week["sessions"]
                if s["type"] not in {"rest", "recovery"}
            ):
                raise ValueError('Program must preserve available days')
        if len({s['day'] for s in sessions}) != len(sessions):
            raise ValueError('Lifting sessions need distinct days')
        for kind, key in (('run', 'running_days'), ('hiit', 'hiit')):
            expected = answers.get(key)
            if (
                isinstance(expected, int)
                and sum(s["type"] == kind for s in week["sessions"]) != expected
            ):
                raise ValueError(f'AI program must preserve requested {kind} count')
        focuses = (
            answers["custom_split_days"]
            if requested == "Custom Split"
            else split_focuses(requested, len(sessions))
        )
        if len(focuses) != len(sessions):
            raise ValueError("AI program must preserve the custom lifting-day count")
        preferences = answers.get('session_preferences', {})
        if not isinstance(preferences, dict):
            raise ValueError('Session preferences must be keyed by ordered day number')
        for index, (session, focus) in enumerate(zip(sessions, focuses, strict=True), 1):
            session["name"] = f"{focus} Training"
            overrides = preferences.get(str(index), {})
            if not isinstance(overrides, dict) or set(overrides) - {
                "required_exercises",
                "preferred_exercises",
                "excluded_exercises",
                "intensity",
                "duration",
            }:
                raise ValueError('Unsupported session preference')
            session["prescription"]["planning"] = {
                "intent": intent_from_answers(
                    answers | overrides | {"focus": focus}, profile
                ).to_dict()
            }
        for session in week['sessions']:
            if session['type'] in {'hiit', 'conditioning'}:
                session["prescription"]["planning"] = {
                    "intent": intent_from_answers(
                        answers | {"focus": "Full Body"}, profile
                    ).to_dict()
                }
        repaired = enforce_week_workouts(week, profile, data)
        week["sessions"] = repaired["sessions"]
    return result


def enforce_week_workouts(
    week: dict,
    profile: AthleteProfile,
    data: GainsData,
    template: dict | None = None,
    preserve_exercises: bool = False,
) -> dict:
    """Rebuild exercise choices with hard equipment and session-focus constraints.

    Template session order and types are authoritative for existing programs.
    The AI may supply rationale but cannot force invalid or mismatched lifts.
    """
    result = copy.deepcopy(week)
    if template and len(result['sessions']) != len(template['sessions']):
        raise ValueError('Generated week must preserve session count')
    original = template["sessions"] if template else result["sessions"]
    reservations: set[str] = set()
    for index, session in enumerate(result["sessions"]):
        reference = original[index]
        if template and (session.get("type"), session.get("day")) != (
            reference.get("type"),
            reference.get("day"),
        ):
            raise ValueError('Generated week must preserve session type and day')
        if session['type'] not in {'workout', 'hiit', 'conditioning'}:
            continue
        if preserve_exercises:
            from .prescription_engine import prescribe
            catalog = {e['id']: e for e in EXERCISE_LIBRARY}
            authored = validate_workout(reference['prescription'], profile, data)
            for exercise in authored['exercises']:
                prescribe(catalog[exercise['exercise_id']], exercise, profile, data,
                          'strength' if 'power' in reference['name'].lower() else 'hypertrophy',
                          preserve_unknown_targets=True)
            authored.setdefault('planning', {})['manual_override'] = True
            authored['planning'].pop('estimated_duration_minutes', None)
            session['prescription'] = authored
            session['name'] = reference['name']
            continue
        answers = (reference.get('prescription', {}).get('planning', {}).get('intent', {}))
        # Stored intent uses canonical duration and exercise preference fields.
        intent = intent_from_answers(
            answers
            | {
                "duration": answers.get("duration_minutes"),
                "required_exercises": list(answers.get("required", [])),
                "preferred_exercises": list(answers.get("preferred", [])),
                "excluded_exercises": list(answers.get("excluded", [])),
            },
            profile,
        )
        # Persisted SessionSpec takes precedence over provider presentation.
        intent = with_focus(
            intent, reference["name"] if session["type"] == "workout" else "Full Body"
        )
        raw = plan_session(
            intent, profile, data, allowed_exercises(profile, data), reservations=reservations
        )
        session["name"] = reference["name"]
        session["prescription"] = normalize_generated("workout", raw, profile, data) | {
            "planning": raw["planning"]
        }
        reservations.update(e['exercise_id'] for e in raw['exercises'])
    return result


def fallback_program(request: dict, profile: AthleteProfile, data: GainsData) -> dict:
    """Honor exact authored counts and days when providers are unavailable."""
    answers = effective_answers(request['answers'])
    day_names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
    selected = answers.get("days")
    days = (
        sorted({day_names.index(day) for day in selected if day in day_names})
        if isinstance(selected, list)
        else list(range(7))
    )
    lifting = int(answers.get('lifting_days', 3))
    running = int(answers.get('running_days', 0))
    hiit = answers.get('hiit', 0)
    hiit = hiit if isinstance(hiit, int) else 0
    if not days or not 1 <= lifting + running + hiit <= len(days):
        raise ValueError('Requested session count exceeds available days or is empty')
    requested = answers.get("split_other") or answers.get("split")
    focuses = (
        answers["custom_split_days"]
        if requested == "Custom Split"
        else split_focuses(requested, lifting)
    )
    sessions = []
    for index, focus in enumerate(focuses):
        prescription = generated_workout({"answers": answers | {"focus": focus}}, profile, data)
        sessions.append(
            {
                "day": days[index],
                "type": "workout",
                "name": focus + " Training",
                "prescription": prescription,
            }
        )
    for index in range(running):
        sessions.append(
            {
                "day": days[lifting + index],
                "type": "run",
                "name": "Easy Run",
                "prescription": {
                    "name": "Easy Run",
                    "run_type": "easy",
                    "target_duration_minutes": 30,
                    "segments": [
                        {
                            "phase": "main",
                            "label": "Conversational effort",
                            "duration_seconds": 1800,
                        }
                    ],
                },
            }
        )
    for index in range(hiit):
        prescription = generated_workout(
            {"answers": answers | {"focus": "Full Body", "intensity": "Light"}}, profile, data
        )
        sessions.append(
            {
                "day": days[lifting + running + index],
                "type": "hiit",
                "name": "Full Body Conditioning",
                "prescription": prescription,
            }
        )
    raw = {
        "name": "Ongoing Training Program",
        "goal": text(answers.get("goal"), "General fitness", 200),
        "start_date": answers.get("start_date") or date.today().isoformat(),
        "weeks": [{"focus": "Base", "sessions": sessions}],
    }
    normalized = normalize_generated('program', raw, profile, data)
    return enforce_program_split(normalized, {'type': 'program', 'answers': answers}, profile, data)


def actions(raw: Any) -> list[dict]:
    if not isinstance(raw, list):
        return []
    result = []
    for a in raw[:5]:
        if (
            isinstance(a, dict)
            and a.get("type") == "start_builder"
            and a.get("builder") in BUILD_TYPES
        ):
            prefill = a.get("prefill") if isinstance(a.get("prefill"), dict) else {}
            if len(json.dumps(prefill, allow_nan=False)) <= 10000:
                result.append(
                    {"type": "start_builder", "builder": a["builder"], "prefill": prefill}
                )
    return result



def regenerate_session(session: dict, profile: AthleteProfile, data: GainsData) -> dict:
    """Reselect exercises within the existing session contract, or leave it intact."""
    from dataclasses import replace

    from .planning_contracts import PlanningError, PlanningIntent

    prescription = session["prescription"]
    saved = prescription.get("planning", {}).get("intent", {})
    intent = (
        PlanningIntent(
            **{
                key: tuple(value)
                if key in {"required", "excluded", "preferred"}
                else value
                for key, value in saved.items()
                if key in PlanningIntent.__dataclass_fields__
            }
        )
        if saved
        else PlanningIntent(focus=session["name"])
    )
    current = {e["exercise_id"] for e in prescription["exercises"]}
    replaceable = sorted(current - set(intent.required))
    # Prefer a completely new selection. If inventory is limited, retain the
    # indispensable movements while guaranteeing at least one actual change.
    for avoid in [replaceable, *[[i] for i in replaceable]]:
        if not avoid:
            continue
        candidate_intent = replace(
            intent,
            seed=intent.seed + 1,
            variety="variety",
            excluded=tuple(sorted(set(intent.excluded) | set(avoid))),
        )
        try:
            candidate = plan_session(
                candidate_intent, profile, data, allowed_exercises(profile, data)
            )
        except PlanningError:
            continue
        if {e["exercise_id"] for e in candidate["exercises"]} == current:
            continue
        # Temporary exclusions should not accumulate across regenerations.
        candidate["planning"]["intent"]["excluded"] = list(intent.excluded)
        candidate["name"] = prescription.get("name", session["name"])
        return validate_proposal("workout", candidate, profile, data) | {
            "planning": candidate["planning"]
        }
    raise ValueError(
        "No different workout is available for these muscles and your gym equipment."
    )
