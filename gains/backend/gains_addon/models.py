"""Plain dataclasses for Gains domain objects.

No Home Assistant imports here -- these are pure data shapes with
to_dict/from_dict for Store serialization, matching Cache/Hustle's
convention so the shapes stay testable without a real HA install.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


def _as_str(data: dict, key: str, default: str | None = None) -> str | None:
    value = data.get(key, default)
    return value if isinstance(value, str) else default


def _as_int(data: dict, key: str, default: int | None = None) -> int | None:
    value = data.get(key, default)
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_bool(data: dict, key: str, default: bool = False) -> bool:
    value = data.get(key, default)
    return bool(value) if value is not None else default


def _as_float(data: dict, key: str, default: float | None = None) -> float | None:
    value = data.get(key, default)
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_list(data: dict, key: str) -> list:
    value = data.get(key, [])
    return value if isinstance(value, list) else []


def _as_str_list(data: dict, key: str) -> list[str]:
    value = data.get(key, [])
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def _as_float_dict(data: dict, key: str) -> dict[str, float]:
    value = data.get(key, {})
    if not isinstance(value, dict):
        return {}
    result: dict[str, float] = {}
    for k, v in value.items():
        if not isinstance(k, str):
            continue
        try:
            result[k] = float(v)
        except (TypeError, ValueError):
            continue
    return result


def _as_optional_float_list_dict(data: dict, key: str) -> dict[str, list[float | None]]:
    """Equipment is keyed by equipment_id -> a list of weights, one per
    physical unit the athlete owns of that item (e.g. two Short Bars at
    different weights) -- None in the list is meaningful (that unit is
    checked but has no custom weight, use the catalog default), so it's
    kept rather than dropped. An entry whose list ends up empty (every
    value was invalid) is dropped entirely -- a checked item always has
    at least one unit."""
    value = data.get(key, {})
    if not isinstance(value, dict):
        return {}
    result: dict[str, list[float | None]] = {}
    for k, v in value.items():
        if not isinstance(k, str) or not isinstance(v, list):
            continue
        weights: list[float | None] = []
        for item in v:
            if item is None:
                weights.append(None)
                continue
            try:
                weights.append(float(item))
            except (TypeError, ValueError):
                continue
        if weights:
            result[k] = weights
    return result


@dataclass
class AICoachMessage:
    """One turn in an athlete's persistent AI Coach conversation.

    proposed_workouts/proposed_runs are lists (a multi-day plan proposes
    several at once, e.g. 3 strength days + 2 run days) mirroring
    gains.create_workout/gains.create_run's own shapes (already validated
    by logic.validate_proposed_workouts/validate_proposed_runs against the
    exercise library and RUN_TYPES) so the frontend can hand any single
    accepted entry straight to that service -- the AI itself never creates
    a workout or run.
    """

    role: str
    content: str
    created_at: str = ""
    proposed_workouts: list[dict[str, Any]] = field(default_factory=list)
    proposed_runs: list[dict[str, Any]] = field(default_factory=list)
    actions: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "content": self.content,
            "created_at": self.created_at,
            "proposed_workouts": self.proposed_workouts,
            "proposed_runs": self.proposed_runs,
            **({"actions": self.actions} if self.actions else {}),
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> AICoachMessage:
        raw_workouts = data.get("proposed_workouts")
        raw_runs = data.get("proposed_runs")
        return AICoachMessage(
            actions=[a for a in _as_list(data, "actions") if isinstance(a, dict)],
            role=_as_str(data, "role") or "user",
            content=_as_str(data, "content") or "",
            created_at=_as_str(data, "created_at", "") or "",
            proposed_workouts=[w for w in raw_workouts if isinstance(w, dict)]
            if isinstance(raw_workouts, list)
            else [],
            proposed_runs=[r for r in raw_runs if isinstance(r, dict)]
            if isinstance(raw_runs, list)
            else [],
        )


@dataclass
class GymProfile:
    """A named, reusable equipment checklist shared instance-wide (e.g.
    "Home Gym", "Planet Fitness") -- any athlete on this Home Assistant
    instance can create one, edit any of them, and select which one is
    theirs via AthleteProfile.gym_profile_id. created_by_profile_id is
    attribution only, not an access boundary, matching the same
    same-instance-is-shared-trust model as account linking."""

    id: str
    name: str
    equipment: dict[str, list[float | None]] = field(default_factory=dict)
    """Same shape as the old per-athlete equipment field it replaces --
    keyed by equipment_id, a present key means "checked," value is a list
    of weights (one per physical unit owned, None meaning "use the
    catalog's default_weight")."""
    equipment_config: dict[str, dict[str, Any]] = field(default_factory=dict)
    """Per-equipment configuration that does not belong in the unit-weight
    list. Cable stations use this for load_type (plate_loaded/weight_stack),
    pulley_ratio, and optional weight-stack details. Missing config is valid
    for older stores and lets the frontend apply backwards-compatible
    defaults without rewriting user data on load."""
    created_by_profile_id: str = ""
    created_at: str = ""
    updated_at: str = ""
    inventory_units: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "equipment": self.equipment,
            "equipment_config": self.equipment_config,
            "inventory_units": self.inventory_units,
            "created_by_profile_id": self.created_by_profile_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> GymProfile:
        return GymProfile(
            inventory_units=_as_str(data, 'inventory_units'),
            id=_as_str(data, "id") or "",
            name=_as_str(data, "name") or "Gym",
            equipment=_as_optional_float_list_dict(data, "equipment"),
            equipment_config={
                str(key): dict(value)
                for key, value in (data.get("equipment_config") or {}).items()
                if isinstance(key, str) and isinstance(value, dict)
            }
            if isinstance(data.get("equipment_config"), dict)
            else {},
            created_by_profile_id=_as_str(data, "created_by_profile_id", "") or "",
            created_at=_as_str(data, "created_at", "") or "",
            updated_at=_as_str(data, "updated_at", "") or "",
        )


@dataclass
class AthleteProfile:
    """One athlete's profile, mapped 1:1 to an HA person/user.

    Phase 1 (Foundation) fields only -- onboarding, goals, sports,
    equipment, and restrictions arrive in later phases as additional
    nested fields on this same dataclass (matching Cache's convention of
    nesting rather than adding new top-level storage keys per feature).
    """

    id: str
    ha_user_id: str
    display_name: str
    units: str = "imperial"
    experience_level: str | None = None
    activity_level: str | None = None
    preferred_duration_minutes: int | None = None
    rest_timer_seconds: int = 60
    """Default rest-period timer between sets, in seconds -- one of
    const.py's REST_TIMER_OPTIONS. Purely a panel display preference (the
    backend doesn't run the countdown itself); update_profile validates it
    against that same option list."""
    is_admin: bool = False
    onboarding_complete: bool = False
    created_at: str = ""
    updated_at: str = ""
    bodyweight: float | None = None
    """In profile.units (lb or kg). Optional -- only needed as an input to
    progress.py's Strength Score (population-average lifts are expressed
    as a multiple of bodyweight); every other feature works without it."""
    age: int | None = None
    """Whole years, self-reported and not auto-incremented -- only needed
    as an input to Strength Score's age adjustment. Optional like
    bodyweight; a missing value just falls back to a prime-age assumption
    rather than blocking the score."""
    personal_records: dict[str, float] = field(default_factory=dict)
    """Best estimated one-rep max seen so far, keyed by exercise_id (Phase 2:
    Strength MVP). Updated by GainsCoordinator.async_log_set, never edited
    directly by a service call."""
    ai_conversation: list[AICoachMessage] = field(default_factory=list)
    """This athlete's persistent AI Coach thread (partial Phase 8). Appended
    to by GainsCoordinator.async_ai_chat only -- never edited directly."""
    gym_profile_id: str | None = None
    """Which GainsData.gym_profiles entry this athlete has selected as
    their gym -- gym profiles are shared instance-wide (see GymProfile),
    so equipment is no longer tracked per-athlete. None means no gym
    selected yet (available_equipment_categories then falls back to
    bodyweight-only). Set by GainsCoordinator.async_select_gym_profile."""
    last_bar_by_exercise: dict[str, dict[str, Any]] = field(default_factory=dict)
    """Last physical bar selected for each exercise by this athlete.
    Stored separately from workout history so a newly generated workout
    can preselect the bar the athlete normally uses for that movement."""
    coaching_conversations: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    coach_grants: dict[str, dict[str, Any]] = field(default_factory=dict)
    linked_profile_ids: list[str] = field(default_factory=list)
    """Other profiles on this same Home Assistant instance (e.g. a
    household's family members) this athlete has linked, for switching
    between profiles in the panel -- always symmetric (linking A to B also
    links B to A), maintained by GainsCoordinator.async_link_account /
    async_unlink_account. This is a convenience list, not a security
    boundary: HA's own entity permissions are what actually govern who can
    see another profile's sensor state."""

    preferred_sequencing_policy: str = "completion"
    """Default for new programs; existing program sequencing remains unchanged."""

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "ha_user_id": self.ha_user_id,
            "preferred_sequencing_policy": self.preferred_sequencing_policy,
            "display_name": self.display_name,
            "units": self.units,
            "experience_level": self.experience_level,
            "activity_level": self.activity_level,
            "preferred_duration_minutes": self.preferred_duration_minutes,
            "rest_timer_seconds": self.rest_timer_seconds,
            "is_admin": self.is_admin,
            "onboarding_complete": self.onboarding_complete,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "bodyweight": self.bodyweight,
            "age": self.age,
            "personal_records": self.personal_records,
            "ai_conversation": [m.to_dict() for m in self.ai_conversation],
            "gym_profile_id": self.gym_profile_id,
            "last_bar_by_exercise": self.last_bar_by_exercise,
            "linked_profile_ids": self.linked_profile_ids,
            "coach_grants": self.coach_grants,
            "coaching_conversations": self.coaching_conversations,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> AthleteProfile:
        raw_conversation = _as_list(data, "ai_conversation")
        return AthleteProfile(
            id=_as_str(data, "id") or "",
            ha_user_id=_as_str(data, "ha_user_id") or "",
            preferred_sequencing_policy=(
                data.get("preferred_sequencing_policy")
                if data.get("preferred_sequencing_policy") in ("calendar", "completion")
                else "completion"
            ),
            display_name=_as_str(data, "display_name") or "Athlete",
            units=_as_str(data, "units", "imperial") or "imperial",
            experience_level=_as_str(data, "experience_level"),
            activity_level=_as_str(data, "activity_level"),
            preferred_duration_minutes=_as_int(data, "preferred_duration_minutes"),
            rest_timer_seconds=_as_int(data, "rest_timer_seconds", 60) or 60,
            is_admin=_as_bool(data, "is_admin", False),
            onboarding_complete=_as_bool(data, "onboarding_complete", False),
            created_at=_as_str(data, "created_at", "") or "",
            updated_at=_as_str(data, "updated_at", "") or "",
            bodyweight=_as_float(data, "bodyweight"),
            age=_as_int(data, "age"),
            personal_records=_as_float_dict(data, "personal_records"),
            ai_conversation=[
                AICoachMessage.from_dict(m) for m in raw_conversation if isinstance(m, dict)
            ],
            gym_profile_id=_as_str(data, "gym_profile_id"),
            last_bar_by_exercise={
                str(exercise_id): dict(value)
                for exercise_id, value in (data.get("last_bar_by_exercise") or {}).items()
                if isinstance(exercise_id, str) and isinstance(value, dict)
            }
            if isinstance(data.get("last_bar_by_exercise"), dict)
            else {},
            linked_profile_ids=_as_str_list(data, "linked_profile_ids"),
            coaching_conversations=data.get("coaching_conversations")
            if isinstance(data.get("coaching_conversations"), dict)
            else {},
            coach_grants=data.get("coach_grants")
            if isinstance(data.get("coach_grants"), dict)
            else {},
        )


@dataclass
class WorkoutSet:
    """One planned (and eventually logged) set within a WorkoutExercise."""

    planned_reps: int | None = None
    planned_weight: float | None = None
    manual_weight: bool = False
    actual_reps: int | None = None
    actual_weight: float | None = None
    completed: bool = False
    recorded_by_profile_id: str | None = None
    recorded_at: str | None = None
    rpe: float | None = None
    set_type: str | None = None
    is_personal_record: bool = False
    personal_record_value: float | None = None
    previous_personal_record: float | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "planned_reps": self.planned_reps,
            "planned_weight": self.planned_weight,
            "manual_weight": self.manual_weight,
            "actual_reps": self.actual_reps,
            "actual_weight": self.actual_weight,
            "completed": self.completed,
            "recorded_by_profile_id": self.recorded_by_profile_id,
            "recorded_at": self.recorded_at,
            "rpe": self.rpe,
            "set_type": self.set_type,
            "is_personal_record": self.is_personal_record,
            "personal_record_value": self.personal_record_value,
            "previous_personal_record": self.previous_personal_record,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> WorkoutSet:
        return WorkoutSet(
            planned_reps=_as_int(data, "planned_reps"),
            planned_weight=_as_float(data, "planned_weight"),
            manual_weight=_as_bool(data, "manual_weight", False),
            actual_reps=_as_int(data, "actual_reps"),
            actual_weight=_as_float(data, "actual_weight"),
            completed=_as_bool(data, "completed", False),
            recorded_by_profile_id=_as_str(data, "recorded_by_profile_id"),
            recorded_at=_as_str(data, "recorded_at"),
            rpe=_as_float(data, "rpe"),
            set_type=_as_str(data, "set_type"),
            is_personal_record=_as_bool(data, "is_personal_record", False),
            personal_record_value=_as_float(data, "personal_record_value"),
            previous_personal_record=_as_float(data, "previous_personal_record"),
        )


@dataclass
class WorkoutExercise:
    """One exercise (by library exercise_id) within a Workout, with its sets.

    effort is recorded once for the whole exercise (after every set is
    logged), not per set -- a single "how did that feel" rating is what the
    AI coach needs to auto-adjust future weights/reps for this exercise, and
    asking after each individual set is more friction than signal.
    """

    exercise_id: str
    sets: list[WorkoutSet] = field(default_factory=list)
    notes: str = ""
    effort: str | None = None
    selected_bar_equipment_id: str | None = None
    selected_bar_weight: float | None = None
    rest_seconds: int | None = None
    """Optional physical bar selected for a barbell exercise. The set's
    weight remains total lifted weight including the bar; these fields let
    the frontend calculate plate loading correctly for non-standard bars."""

    def to_dict(self) -> dict[str, Any]:
        return {
            "exercise_id": self.exercise_id,
            "sets": [s.to_dict() for s in self.sets],
            "notes": self.notes,
            "effort": self.effort,
            "selected_bar_equipment_id": self.selected_bar_equipment_id,
            "selected_bar_weight": self.selected_bar_weight,
            "rest_seconds": self.rest_seconds,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> WorkoutExercise:
        raw_sets = _as_list(data, "sets")
        return WorkoutExercise(
            exercise_id=_as_str(data, "exercise_id") or "",
            sets=[WorkoutSet.from_dict(s) for s in raw_sets if isinstance(s, dict)],
            notes=_as_str(data, "notes", "") or "",
            effort=_as_str(data, "effort"),
            selected_bar_equipment_id=_as_str(data, "selected_bar_equipment_id"),
            selected_bar_weight=_as_float(data, "selected_bar_weight"),
            rest_seconds=_as_int(data, "rest_seconds"),
        )


@dataclass
class WorkoutParticipant:
    """One athlete's session membership and shared snapshot of their own set logs."""

    profile_id: str
    display_name: str
    workout_id: str
    status: str = "active"
    units: str = "imperial"
    exercises: list[WorkoutExercise] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"profile_id": self.profile_id, "display_name": self.display_name,
                "units": self.units,
                "workout_id": self.workout_id, "status": self.status,
                "exercises": [e.to_dict() for e in self.exercises]}


@dataclass
class JointWorkoutSession:
    """Replicated session state; authoritative performance stays in each owned Workout."""

    id: str
    participants: list[WorkoutParticipant]
    created_at: str = ""
    status: str = "active"
    turn: dict[str, Any] | None = None
    device_mode: str = "different_devices"
    controller_profile_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"id": self.id, "status": self.status, "created_at": self.created_at,
                "device_mode": self.device_mode,
                "controller_profile_id": self.controller_profile_id,
                "turn": self.turn, "participants": [p.to_dict() for p in self.participants]}

    @staticmethod
    def from_dict(data: Any) -> JointWorkoutSession | None:
        if not isinstance(data, dict) or not _as_str(data, "id"):
            return None
        raw = _as_list(data, "participants")
        if len(raw) != 2 or any(not isinstance(p, dict) for p in raw):
            return None
        participants = []
        for p in raw:
            if not _as_str(p, "profile_id") or not _as_str(p, "workout_id"):
                return None
            if p.get("status") not in {"active", "left", "completed", "skipped"}:
                return None
            participants.append(WorkoutParticipant(
                profile_id=p["profile_id"], workout_id=p["workout_id"],
                display_name=_as_str(p, "display_name", "Athlete") or "Athlete",
                status=p["status"], exercises=[WorkoutExercise.from_dict(e)
                                             for e in _as_list(p, "exercises")
                                             if isinstance(e, dict)]))
            participants[-1].units = _as_str(p, "units", "imperial") or "imperial"
        if len({p.profile_id for p in participants}) != 2:
            return None
        if len({p.workout_id for p in participants}) != 2:
            return None
        if data.get("status") not in {"active", "completed", "ended"}:
            return None
        mode = data.get("device_mode", "different_devices")
        if mode not in {"same_device", "different_devices"}:
            return None
        controller = _as_str(data, "controller_profile_id")
        if mode == "same_device" and controller not in {p.profile_id for p in participants}:
            return None
        turn = data.get("turn")
        if turn is not None and (
            not isinstance(turn, dict)
            or turn.get("profile_id") not in {p.profile_id for p in participants}
            or any(type(turn.get(k)) is not int or turn[k] < 0
                   for k in ("exercise_index", "set_index"))
        ):
            return None
        return JointWorkoutSession(id=data["id"], participants=participants,
                                   device_mode=mode, controller_profile_id=controller,
                                   status=data["status"], turn=turn,
                                   created_at=_as_str(data, "created_at", "") or "")


@dataclass
class Workout:
    """A manually-built strength workout (Phase 2: Strength MVP).

    status is one of const.WORKOUT_STATUSES ("planned", "active",
    "completed", "skipped"). Deterministic planning/scheduling is a later
    phase -- for now every workout is created explicitly by the athlete via
    gains.create_workout.
    """

    id: str
    profile_id: str
    name: str
    joint_session: dict[str, Any] | None = None
    status: str = "planned"
    exercises: list[WorkoutExercise] = field(default_factory=list)
    notes: str = ""
    created_at: str = ""
    started_at: str | None = None
    completed_at: str | None = None

    current_exercise_index: int = 0
    current_set_index: int = 0
    revision: int = 0
    audit: list[dict[str, Any]] = field(default_factory=list)
    program_id: str | None = None
    program_session_id: str | None = None
    load_context: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "current_exercise_index": self.current_exercise_index,
            "current_set_index": self.current_set_index,
            "revision": self.revision,
            "audit": self.audit,
            "program_id": self.program_id,
            "program_session_id": self.program_session_id,
            "load_context": self.load_context,
            "id": self.id,
            "profile_id": self.profile_id,
            "joint_session": self.joint_session,
            "name": self.name,
            "status": self.status,
            "exercises": [e.to_dict() for e in self.exercises],
            "notes": self.notes,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> Workout:
        raw_exercises = _as_list(data, "exercises")
        joint = JointWorkoutSession.from_dict(data.get("joint_session"))
        if joint and not any(p.workout_id == data.get("id") and
                             p.profile_id == data.get("profile_id") for p in joint.participants):
            joint = None
        return Workout(
            current_exercise_index=_as_int(data, "current_exercise_index", 0) or 0,
            current_set_index=_as_int(data, "current_set_index", 0) or 0,
            revision=_as_int(data, "revision", 0) or 0,
            audit=[a for a in _as_list(data, "audit") if isinstance(a, dict)],
            program_id=_as_str(data, "program_id"),
            load_context=data.get("load_context")
            if isinstance(data.get("load_context"), dict)
            else {},
            program_session_id=_as_str(data, "program_session_id"),
            id=_as_str(data, "id") or "",
            profile_id=_as_str(data, "profile_id") or "",
            name=_as_str(data, "name") or "Workout",
            joint_session=joint.to_dict() if joint else None,
            status=_as_str(data, "status", "planned") or "planned",
            exercises=[WorkoutExercise.from_dict(e) for e in raw_exercises if isinstance(e, dict)],
            notes=_as_str(data, "notes", "") or "",
            created_at=_as_str(data, "created_at", "") or "",
            started_at=_as_str(data, "started_at"),
            completed_at=_as_str(data, "completed_at"),
        )


@dataclass
class Run:
    """A planned or logged run (Strength MVP's running counterpart).

    status is one of const.RUN_STATUSES. target_* fields describe what was
    planned (set manually or via an accepted AI proposal); actual_* fields
    are filled in by gains.log_run once the run is done. Unlike Workout,
    there's no per-set structure or "active" state -- a run is logged as a
    whole after the fact, not tracked set-by-set while in progress.
    """

    id: str
    profile_id: str
    name: str
    run_type: str = "easy"
    status: str = "planned"
    target_distance: float | None = None
    target_duration_minutes: int | None = None
    actual_distance: float | None = None
    actual_duration_minutes: int | None = None
    notes: str = ""
    created_at: str = ""
    completed_at: str | None = None

    segments: list[dict[str, Any]] = field(default_factory=list)
    program_id: str | None = None
    program_session_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "segments": self.segments,
            "program_id": self.program_id,
            "program_session_id": self.program_session_id,
            "id": self.id,
            "profile_id": self.profile_id,
            "name": self.name,
            "run_type": self.run_type,
            "status": self.status,
            "target_distance": self.target_distance,
            "target_duration_minutes": self.target_duration_minutes,
            "actual_distance": self.actual_distance,
            "actual_duration_minutes": self.actual_duration_minutes,
            "notes": self.notes,
            "created_at": self.created_at,
            "completed_at": self.completed_at,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> Run:
        return Run(
            segments=[a for a in _as_list(data, "segments") if isinstance(a, dict)],
            program_id=_as_str(data, "program_id"),
            program_session_id=_as_str(data, "program_session_id"),
            id=_as_str(data, "id") or "",
            profile_id=_as_str(data, "profile_id") or "",
            name=_as_str(data, "name") or "Run",
            run_type=_as_str(data, "run_type", "easy") or "easy",
            status=_as_str(data, "status", "planned") or "planned",
            target_distance=_as_float(data, "target_distance"),
            target_duration_minutes=_as_int(data, "target_duration_minutes"),
            actual_distance=_as_float(data, "actual_distance"),
            actual_duration_minutes=_as_int(data, "actual_duration_minutes"),
            notes=_as_str(data, "notes", "") or "",
            created_at=_as_str(data, "created_at", "") or "",
            completed_at=_as_str(data, "completed_at"),
        )


@dataclass
class TrainingProgram:
    """An ongoing schedule cycle; occurrences materialize only when opened."""

    id: str
    profile_id: str
    name: str
    goal: str
    start_date: str
    weeks: list[dict[str, Any]] = field(default_factory=list)
    status: str = "active"
    created_at: str = ""
    revision: int = 0
    occurrences: dict[str, dict[str, Any]] = field(default_factory=dict)
    generated_weeks: dict[str, dict[str, Any]] = field(default_factory=dict)
    origin_request: dict[str, Any] = field(default_factory=dict)
    sequencing_policy: str = 'calendar'
    manual_overrides: bool = False
    rotation_events: dict[str, str] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "profile_id": self.profile_id,
            "name": self.name,
            "goal": self.goal,
            "start_date": self.start_date,
            "weeks": self.weeks,
            "status": self.status,
            "created_at": self.created_at,
            "revision": self.revision,
            "occurrences": self.occurrences,
            "generated_weeks": self.generated_weeks,
            "origin_request": self.origin_request,
            "sequencing_policy": self.sequencing_policy,
            'manual_overrides': self.manual_overrides,
            'rotation_events': self.rotation_events,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> TrainingProgram:
        return TrainingProgram(
            id=_as_str(data, "id") or "",
            profile_id=_as_str(data, "profile_id") or "",
            name=_as_str(data, "name") or "Program",
            goal=_as_str(data, "goal") or "",
            start_date=_as_str(data, "start_date") or "",
            status=_as_str(data, "status") or "draft",
            weeks=[w for w in _as_list(data, "weeks") if isinstance(w, dict)],
            created_at=_as_str(data, "created_at") or "",
            revision=_as_int(data, "revision", 0) or 0,
            origin_request=data.get("origin_request")
            if isinstance(data.get("origin_request"), dict)
            else {},
            sequencing_policy=_as_str(data, "sequencing_policy", "calendar") or "calendar",
            manual_overrides=_as_bool(data, "manual_overrides", False),
            rotation_events={
                str(k): v
                for k, v in data.get("rotation_events", {}).items()
                if isinstance(v, str) and v in {"completed", "skipped"}
            }
            if isinstance(data.get("rotation_events"), dict)
            else {},
            occurrences={
                key: value
                for key, value in data.get("occurrences", {}).items()
                if isinstance(key, str) and isinstance(value, dict)
            }
            if isinstance(data.get("occurrences"), dict)
            else {},
            generated_weeks={
                key: value
                for key, value in data.get("generated_weeks", {}).items()
                if isinstance(key, str) and isinstance(value, dict)
            }
            if isinstance(data.get("generated_weeks"), dict)
            else {},
        )


@dataclass
class ShareRequest:
    """A pending offer to copy a workout/run/program to another profile on
    this same Home Assistant instance.

    Created by GainsCoordinator.async_share_workout/async_share_run/
    async_share_program (one per share attempt, replacing what used to be
    an immediate copy), resolved by async_respond_share. `payload` is a
    snapshot of only the shareable fields (planned values, never
    actual/completed progress) captured at request time, so accepting or
    declining later never depends on the source item still existing --
    the sender can edit or delete their own copy in the meantime without
    corrupting the offer.
    """

    id: str
    from_profile_id: str
    to_profile_id: str
    kind: str
    """One of "workout", "run", "program"."""
    name: str
    payload: dict[str, Any] = field(default_factory=dict)
    status: str = "pending"
    """One of "pending", "accepted", "declined"."""
    created_at: str = ""
    responded_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "from_profile_id": self.from_profile_id,
            "to_profile_id": self.to_profile_id,
            "kind": self.kind,
            "name": self.name,
            "payload": self.payload,
            "status": self.status,
            "created_at": self.created_at,
            "responded_at": self.responded_at,
        }

    @staticmethod
    def from_dict(data: dict[str, Any]) -> ShareRequest:
        return ShareRequest(
            id=_as_str(data, "id") or "",
            from_profile_id=_as_str(data, "from_profile_id") or "",
            to_profile_id=_as_str(data, "to_profile_id") or "",
            kind=_as_str(data, "kind", "workout") or "workout",
            name=_as_str(data, "name", "") or "",
            payload=data.get("payload") if isinstance(data.get("payload"), dict) else {},
            status=_as_str(data, "status", "pending") or "pending",
            created_at=_as_str(data, "created_at", "") or "",
            responded_at=_as_str(data, "responded_at"),
        )


@dataclass
class GainsData:
    """Top-level container -- the single Store document's shape."""

    programs: list[TrainingProgram] = field(default_factory=list)
    training_proposals: list[dict[str, Any]] = field(default_factory=list)
    profiles: list[AthleteProfile] = field(default_factory=list)
    workouts: list[Workout] = field(default_factory=list)
    runs: list[Run] = field(default_factory=list)
    gym_profiles: list[GymProfile] = field(default_factory=list)
    share_requests: list[ShareRequest] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "programs": [p.to_dict() for p in self.programs],
            "training_proposals": self.training_proposals,
            "profiles": [p.to_dict() for p in self.profiles],
            "workouts": [w.to_dict() for w in self.workouts],
            "runs": [r.to_dict() for r in self.runs],
            "gym_profiles": [g.to_dict() for g in self.gym_profiles],
            "share_requests": [r.to_dict() for r in self.share_requests],
        }

    @staticmethod
    def from_dict(data: dict[str, Any] | None) -> GainsData:
        if not data:
            return GainsData()
        raw_profile_dicts = [p for p in data.get("profiles", []) if isinstance(p, dict)]
        profiles = [AthleteProfile.from_dict(p) for p in raw_profile_dicts]
        raw_workouts = data.get("workouts", [])
        workouts = [Workout.from_dict(w) for w in raw_workouts if isinstance(w, dict)]
        raw_runs = data.get("runs", [])
        runs = [Run.from_dict(r) for r in raw_runs if isinstance(r, dict)]
        raw_gym_profiles = data.get("gym_profiles", [])
        gym_profiles = [GymProfile.from_dict(g) for g in raw_gym_profiles if isinstance(g, dict)]

        # One-time migration: gym equipment used to live directly on each
        # AthleteProfile as an "equipment" dict (removed from that
        # dataclass in favor of shared GymProfiles). A profile that still
        # has old equipment data and hasn't already been assigned a gym
        # gets a personal GymProfile synthesized from it, so upgrading
        # doesn't silently wipe out equipment athletes already checked off.
        for raw_profile, profile in zip(raw_profile_dicts, profiles, strict=False):
            if profile.gym_profile_id is not None:
                continue
            legacy_equipment = _as_optional_float_list_dict(raw_profile, "equipment")
            if not legacy_equipment:
                continue
            migrated_gym = GymProfile(
                id=f"migrated-{profile.id}",
                name=f"{profile.display_name}'s Gym",
                equipment=legacy_equipment,
                inventory_units=profile.units,
                created_by_profile_id=profile.id,
                created_at=profile.created_at,
                updated_at=profile.created_at,
            )
            gym_profiles.append(migrated_gym)
            profile.gym_profile_id = migrated_gym.id

        # Older shared gyms predate inventory unit snapshots. Recover their
        # existing display convention only when associated profiles agree.
        # Preserve the numeric inventory; this is a label repair, not conversion.
        for gym in gym_profiles:
            if gym.inventory_units is not None:
                continue
            associated = [
                raw for raw in raw_profile_dicts
                if raw.get("id") == gym.created_by_profile_id
                or raw.get("gym_profile_id") == gym.id
            ]
            units = {raw.get("units") for raw in associated}
            if len(units) == 1 and units <= {"imperial", "metric"}:
                gym.inventory_units = units.pop()

        return GainsData(
            profiles=profiles,
            workouts=workouts,
            runs=runs,
            gym_profiles=gym_profiles,
            programs=[
                TrainingProgram.from_dict(p)
                for p in _as_list(data, "programs")
                if isinstance(p, dict)
            ],
            training_proposals=[
                p for p in _as_list(data, "training_proposals") if isinstance(p, dict)
            ],
            share_requests=[
                ShareRequest.from_dict(r)
                for r in _as_list(data, "share_requests")
                if isinstance(r, dict)
            ],
        )

