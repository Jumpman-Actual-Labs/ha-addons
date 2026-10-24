"""The only place that touches both storage and logic.py.

Push-based, not polling -- every mutation method persists then calls
_async_save, which notifies listeners (web.py's websocket push and
mqtt.py's publisher).
"""

from __future__ import annotations

import copy
import logging
import uuid
from collections.abc import Callable
from datetime import UTC, date, datetime

from . import logic, progress, training
from .ai import AIProvider, AIProviderError
from .const import AI_ROLE_ASSISTANT, AI_ROLE_USER
from .equipment import get_equipment_item
from .exercises import get_exercise
from .joint_sessions import JointSessionMixin
from .models import (
    AICoachMessage,
    AthleteProfile,
    GainsData,
    GymProfile,
    Run,
    ShareRequest,
    TrainingProgram,
    Workout,
    WorkoutExercise,
    WorkoutSet,
)
from .storage import GainsStore
from .training_coordinator import TrainingCoordinatorMixin

_LOGGER = logging.getLogger(__name__)

NO_AI_PROVIDER_REPLY = (
    "Ask Geoffrey isn't configured yet. Add an Anthropic or OpenAI API key under "
    "Settings -> Add-ons -> Gains -> Configuration to enable it."
)


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


class GainsCoordinator(JointSessionMixin, TrainingCoordinatorMixin):
    def __init__(self, store: GainsStore) -> None:
        self._store = store
        self.data: GainsData = GainsData()
        self.ai_provider: AIProvider | None = None
        self._listeners: list[Callable[[], None]] = []

    # ----------------------------------------------------------- listeners
    # Stands in for DataUpdateCoordinator's push API from the integration
    # days - same two method names, so everything below is unchanged.

    def async_add_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener)

    def async_set_updated_data(self, data: GainsData) -> None:
        self.data = data
        for listener in list(self._listeners):
            try:
                listener()
            except Exception:  # one bad listener mustn't block the rest
                _LOGGER.exception("Gains listener failed")

    async def async_load(self) -> None:
        self.data = await self._store.async_load()

    async def _async_save(self) -> None:
        await self._store.async_save(self.data)
        self.async_set_updated_data(self.data)

    @property
    def profiles(self) -> list[AthleteProfile]:
        return self.data.profiles

    def get_profile(self, profile_id: str) -> AthleteProfile | None:
        return logic.find_profile_by_id(self.data.profiles, profile_id)

    def get_profile_by_user_id(self, ha_user_id: str) -> AthleteProfile | None:
        return logic.find_profile_by_user_id(self.data.profiles, ha_user_id)

    async def async_ensure_profile(
        self, ha_user_id: str, person_name: str | None
    ) -> AthleteProfile:
        """Return the calling user's profile, creating it if this is their first visit."""
        existing = self.get_profile_by_user_id(ha_user_id)
        if existing is not None:
            return existing

        now = _now_iso()
        profile = AthleteProfile(
            id=uuid.uuid4().hex,
            ha_user_id=ha_user_id,
            display_name=logic.default_display_name(person_name, ha_user_id),
            is_admin=logic.new_profile_is_admin(self.data.profiles),
            created_at=now,
            updated_at=now,
        )
        self.data.profiles.append(profile)
        await self._async_save()
        return profile

    async def async_update_profile(self, ha_user_id: str, **fields) -> AthleteProfile | None:
        """Update the calling user's own profile.

        Only the caller's own profile can be targeted -- fields are keyed
        by ha_user_id (from the service call's context), never a
        client-supplied profile_id, so one athlete can't edit another's
        data through this service. Coach/admin cross-athlete edits are a
        later-phase concern layered on top of this, not a bypass of it.
        """
        profile = self.get_profile_by_user_id(ha_user_id)
        if profile is None:
            return None

        policy = fields.get("preferred_sequencing_policy")
        if policy is not None and policy not in ("calendar", "completion"):
            raise ValueError("Choose calendar or completion sequencing")
        for key in (
            "preferred_sequencing_policy",
            "display_name",
            "units",
            "experience_level",
            "activity_level",
            "preferred_duration_minutes",
            "rest_timer_seconds",
            "onboarding_complete",
            "bodyweight",
            "age",
        ):
            if key in fields and fields[key] is not None:
                setattr(profile, key, fields[key])
        profile.updated_at = _now_iso()

        await self._async_save()
        return profile

    @property
    def gym_profiles(self) -> list[GymProfile]:
        return self.data.gym_profiles

    def get_gym_profile(self, gym_profile_id: str) -> GymProfile | None:
        return logic.find_gym_profile_by_id(self.data.gym_profiles, gym_profile_id)

    async def async_create_gym_profile(
        self,
        ha_user_id: str,
        name: str,
        equipment: dict[str, list[float | None]] | None = None,
        equipment_config: dict[str, dict[str, object]] | None = None,
    ) -> GymProfile | None:
        """Create a new gym profile -- shared instance-wide from the moment
        it's created (see GymProfile), attributed to the calling user only
        for created_by_profile_id bookkeeping, not as an access boundary."""
        profile = self.get_profile_by_user_id(ha_user_id)
        if profile is None:
            return None

        now = _now_iso()
        gym = GymProfile(
            inventory_units=profile.units,
            id=uuid.uuid4().hex,
            name=name,
            equipment=equipment or {},
            equipment_config=equipment_config or {},
            created_by_profile_id=profile.id,
            created_at=now,
            updated_at=now,
        )
        self.data.gym_profiles.append(gym)
        await self._async_save()
        return gym

    async def async_update_gym_profile(
        self,
        ha_user_id: str,
        gym_profile_id: str,
        name: str | None = None,
        equipment: dict[str, list[float | None]] | None = None,
        equipment_config: dict[str, dict[str, object]] | None = None,
    ) -> GymProfile | None:
        """Edit any gym profile on the instance -- gym profiles are shared,
        unlike AthleteProfile, so this only requires the caller to have a
        profile at all, not to have created this particular gym."""
        profile = self.get_profile_by_user_id(ha_user_id)
        if profile is None:
            return None
        gym = self.get_gym_profile(gym_profile_id)
        if gym is None:
            return None

        if name is not None:
            gym.name = name
        if equipment is not None or equipment_config is not None:
            from .inventory_units import gym_as_units
            normalized = gym_as_units(gym, profile.units)
            gym.equipment = normalized['equipment']
            gym.equipment_config = normalized['equipment_config']
            gym.inventory_units = profile.units
        if equipment is not None:
            gym.equipment = equipment
        if equipment_config is not None:
            gym.equipment_config = equipment_config
        gym.updated_at = _now_iso()
        await self._async_save()
        return gym

    async def async_delete_gym_profile(self, ha_user_id: str, gym_profile_id: str) -> bool:
        """Deletes a shared gym profile and clears it from every athlete who
        had it selected (they fall back to no-gym/bodyweight-only, same as
        never having picked one)."""
        profile = self.get_profile_by_user_id(ha_user_id)
        if profile is None:
            return False
        gym = self.get_gym_profile(gym_profile_id)
        if gym is None:
            return False

        self.data.gym_profiles.remove(gym)
        for other in self.data.profiles:
            if other.gym_profile_id == gym_profile_id:
                other.gym_profile_id = None
        await self._async_save()
        return True

    async def async_select_gym_profile(
        self, ha_user_id: str, gym_profile_id: str | None
    ) -> AthleteProfile | None:
        """Sets which shared gym the calling user has selected as their own
        -- None clears the selection back to bodyweight-only."""
        profile = self.get_profile_by_user_id(ha_user_id)
        if profile is None:
            return None
        if gym_profile_id is not None and self.get_gym_profile(gym_profile_id) is None:
            return None

        profile.gym_profile_id = gym_profile_id
        profile.updated_at = _now_iso()
        await self._async_save()
        return profile

    async def async_link_account(
        self, ha_user_id: str, target_profile_id: str
    ) -> AthleteProfile | None:
        """Links the calling user's profile with another profile on this
        same Home Assistant instance (e.g. a family member) -- always
        symmetric, so this updates both sides in one call. Returns None
        (no-op) if the caller has no profile yet, the target doesn't
        exist, or the target is the caller's own profile."""
        profile = self.get_profile_by_user_id(ha_user_id)
        if profile is None:
            return None
        target = self.get_profile(target_profile_id)
        if target is None or target.id == profile.id:
            return None

        if target.id not in profile.linked_profile_ids:
            profile.linked_profile_ids.append(target.id)
        if profile.id not in target.linked_profile_ids:
            target.linked_profile_ids.append(profile.id)
        now = _now_iso()
        profile.updated_at = now
        target.updated_at = now

        await self._async_save()
        return profile

    async def async_unlink_account(
        self, ha_user_id: str, target_profile_id: str
    ) -> AthleteProfile | None:
        """Reverses async_link_account -- removes both sides of the link."""
        profile = self.get_profile_by_user_id(ha_user_id)
        if profile is None:
            return None
        target = self.get_profile(target_profile_id)
        profile.coach_grants.pop(target_profile_id, None)
        if target is not None:
            target.coach_grants.pop(profile.id, None)

        if target_profile_id in profile.linked_profile_ids:
            profile.linked_profile_ids.remove(target_profile_id)
            profile.updated_at = _now_iso()
        if target is not None and profile.id in target.linked_profile_ids:
            target.linked_profile_ids.remove(profile.id)
            target.updated_at = _now_iso()

        await self._async_save()
        return profile

    @property
    def workouts(self) -> list[Workout]:
        return self.data.workouts

    def get_workout(self, workout_id: str) -> Workout | None:
        return logic.find_workout_by_id(self.data.workouts, workout_id)

    def workouts_for_profile(self, profile_id: str) -> list[Workout]:
        return logic.workouts_for_profile(self.data.workouts, profile_id)

    def _bar_for_exercise(
        self, profile: AthleteProfile, exercise_id: str
    ) -> tuple[str | None, float | None]:
        """Resolve a valid physical bar for a barbell exercise.

        Prefer the athlete's last-used bar for this exact movement. When no
        remembered choice exists yet, choose a configured default so the
        workout has an explicit bar from the start (Olympic bar for adults
        when available; lightest compatible bar for kids).
        """
        exercise_def = get_exercise(exercise_id)
        if exercise_def is None or exercise_def.get("equipment") != "barbell":
            return None, None

        gym = self.get_gym_profile(profile.gym_profile_id) if profile.gym_profile_id else None
        if gym is None:
            return None, None

        bar_ids = (
            "olympic_barbell",
            "ez_bar",
            "trap_bar",
            "short_bar",
            "safety_squat_bar",
        )
        required_id = exercise_def.get("requires_equipment_id")
        choices: list[tuple[str, float]] = []
        from .exercise_eligibility import requirements
        compatible = requirements(exercise_def)[0]
        for equipment_id in bar_ids:
            if equipment_id not in compatible:
                continue
            if required_id in bar_ids and equipment_id != required_id:
                continue
            item = get_equipment_item(equipment_id)
            if (
                item is None
                or item.get("category") != "bars_and_plates"
                or item.get("equipment_category") != "barbell"
            ):
                continue
            for value in gym.equipment.get(equipment_id, []):
                from .inventory_units import convert_weight
                raw_weight = (
                    convert_weight(item["default_weight"], "imperial", profile.units)
                    if value is None and item.get("default_weight") is not None
                    else convert_weight(value, gym.inventory_units or profile.units, profile.units)
                    if value is not None
                    else None
                )
                if raw_weight is None:
                    continue
                choices.append((equipment_id, float(raw_weight)))

        if not choices:
            return None, None

        preference = profile.last_bar_by_exercise.get(exercise_id)
        if isinstance(preference, dict):
            preferred_id = preference.get("equipment_id")
            raw_weight = preference.get("weight")
            if isinstance(preferred_id, str) and isinstance(raw_weight, (int, float)):
                preferred_weight = float(raw_weight)
                for equipment_id, weight in choices:
                    if equipment_id == preferred_id and abs(weight - preferred_weight) < 0.01:
                        return equipment_id, weight

        if profile.experience_level == "kids":
            return min(choices, key=lambda choice: choice[1])
        for equipment_id, weight in choices:
            if equipment_id == "olympic_barbell":
                return equipment_id, weight
        return choices[0]

    def _own_workout(self, ha_user_id: str, workout_id: str) -> Workout | None:
        """Resolve a workout only if it belongs to the calling user's own
        profile -- mirrors async_update_profile's cross-user isolation so
        one athlete can't start/log/complete/skip another's workout."""
        profile = self.get_profile_by_user_id(ha_user_id)
        if profile is None:
            return None
        workout = self.get_workout(workout_id)
        if workout is None or workout.profile_id != profile.id:
            return None
        return workout

    async def async_create_workout(
        self,
        ha_user_id: str,
        name: str,
        exercises: list[dict],
        *,
        target_profile_id: str | None = None,
        persist: bool = True,
    ) -> Workout | None:
        """Create a planned workout for the calling user's own profile.

        `exercises` is already validated by services.py (exercise_id against
        the exercise library, shape via voluptuous) before reaching here.
        """
        profile = self._target_profile(ha_user_id, target_profile_id, "coach_workouts")
        if profile is None:
            return None

        workout_exercises: list[WorkoutExercise] = []
        for exercise in exercises:
            exercise_id = exercise["exercise_id"]
            remembered_bar_id, remembered_bar_weight = self._bar_for_exercise(
                profile, exercise_id
            )
            workout_exercises.append(
                WorkoutExercise(
                    exercise_id=exercise_id,
                    sets=[
                        WorkoutSet(
                            planned_reps=set_data.get("reps"),
                            planned_weight=set_data.get("weight"),
                            manual_weight=set_data.get("weight") is not None,
                            set_type=set_data.get('set_type'),
                        )
                        for set_data in exercise.get("sets", [])
                    ],
                    selected_bar_equipment_id=remembered_bar_id,
                    selected_bar_weight=remembered_bar_weight,
                    rest_seconds=exercise.get('rest_seconds'),
                )
            )
        from .inventory_units import performance_context
        workout = Workout(
            id=uuid.uuid4().hex,
            profile_id=profile.id,
            name=name,
            status="planned",
            exercises=workout_exercises,
            created_at=_now_iso(),
            load_context=performance_context(profile, self.data),
        )
        self.data.workouts.append(workout)
        if persist:
            await self._async_save()
        return workout

    async def async_start_workout(
        self, ha_user_id: str, workout_id: str, *, target_profile_id: str | None = None
    ) -> Workout | None:
        workout = self._workout_for_actor(ha_user_id, workout_id, target_profile_id)
        if workout is None:
            return None
        self._joint_guard(workout, "start_workout")
        workout.status = "active"
        if not any(s.completed for e in workout.exercises for s in e.sets):
            from .inventory_units import performance_context
            athlete = self.get_profile(workout.profile_id)
            workout.load_context = performance_context(athlete, self.data)
        workout.started_at = _now_iso()
        self._audit_workout(workout, ha_user_id, "start_workout")
        await self._async_save()
        return workout

    async def async_log_set(
        self,
        ha_user_id: str,
        workout_id: str,
        exercise_index: int,
        set_index: int,
        reps: int | None,
        weight: float | None,
        *,
        target_profile_id: str | None = None,
    ) -> Workout | None:
        workout = self._workout_for_actor(ha_user_id, workout_id, target_profile_id)
        if workout is None:
            return None
        if not (0 <= exercise_index < len(workout.exercises)):
            return None
        return await self._async_log_set_for_workout(
            ha_user_id, workout, exercise_index, set_index, reps, weight
        )

    async def _async_log_set_for_workout(
        self, ha_user_id: str, workout: Workout, exercise_index: int,
        set_index: int, reps: int | None, weight: float | None,
    ) -> Workout | None:
        """Apply a log after the caller has resolved its explicit authorization scope."""
        exercise = workout.exercises[exercise_index]
        if not (0 <= set_index < len(exercise.sets)):
            return None

        target_set = exercise.sets[set_index]
        self._joint_guard(workout, "log_set", exercise_index, set_index)
        was_completed = target_set.completed
        prior_set_record_value = target_set.personal_record_value
        prior_set_previous_record = target_set.previous_personal_record
        prior_set_was_record = target_set.is_personal_record

        target_set.actual_reps = reps
        target_set.actual_weight = weight
        target_set.completed = True
        target_set.recorded_by_profile_id = self.get_profile_by_user_id(ha_user_id).id
        target_set.recorded_at = _now_iso()
        target_set.is_personal_record = False
        target_set.personal_record_value = None
        target_set.previous_personal_record = None
        workout.current_exercise_index = exercise_index
        workout.current_set_index = min(set_index + 1, len(exercise.sets) - 1)

        profile = self.get_profile(workout.profile_id)
        exercise_def = get_exercise(exercise.exercise_id)
        if (
            profile is not None
            and exercise_def
            and exercise_def.get("equipment") == "barbell"
            and exercise.selected_bar_equipment_id
            and exercise.selected_bar_weight is not None
        ):
            profile.last_bar_by_exercise[exercise.exercise_id] = {
                "equipment_id": exercise.selected_bar_equipment_id,
                "weight": exercise.selected_bar_weight,
            }
            profile.updated_at = _now_iso()
        is_timed = bool(exercise_def and exercise_def.get("is_timed"))
        # Strength PRs are rep-aware, not "heaviest plate weight wins".
        # Gains already uses Epley estimated 1RM as the comparable score, so
        # a lighter set with enough extra reps can legitimately beat a
        # heavier low-rep set. Persist the record metadata on the set so the
        # UI can still show the badge and previous PR after a reload.
        if profile is not None and weight is not None and reps is not None and not is_timed:
            estimated = logic.estimate_one_rep_max(weight, reps)
            current_best = profile.personal_records.get(exercise.exercise_id)
            unchanged_existing_record = (
                was_completed
                and prior_set_was_record
                and prior_set_record_value is not None
                and abs(prior_set_record_value - estimated) < 1e-9
            )
            if unchanged_existing_record:
                target_set.is_personal_record = True
                target_set.personal_record_value = estimated
                target_set.previous_personal_record = prior_set_previous_record
            elif logic.is_new_personal_record(
                profile.personal_records, exercise.exercise_id, estimated
            ):
                target_set.is_personal_record = True
                target_set.personal_record_value = estimated
                target_set.previous_personal_record = current_best
                profile.personal_records[exercise.exercise_id] = estimated

        self._audit_workout(workout, ha_user_id, "log_set")
        await self._async_save()
        return workout

    async def async_log_exercise_effort(
        self,
        ha_user_id: str,
        workout_id: str,
        exercise_index: int,
        effort: str,
        *,
        target_profile_id: str | None = None,
    ) -> Workout | None:
        """Records how the whole exercise felt (asked once, after every set
        is logged, rather than per set) -- feeds build_strength_summary so
        the AI coach can nudge future recommended weights up or down."""
        workout = self._workout_for_actor(ha_user_id, workout_id, target_profile_id)
        if workout is None:
            return None
        if not (0 <= exercise_index < len(workout.exercises)):
            return None
        workout.exercises[exercise_index].effort = effort
        self._audit_workout(workout, ha_user_id, "log_exercise_effort")
        await self._async_save()
        return workout

    async def async_complete_workout(
        self, ha_user_id: str, workout_id: str, *, target_profile_id: str | None = None
    ) -> Workout | None:
        workout = self._workout_for_actor(ha_user_id, workout_id, target_profile_id)
        if workout is None:
            return None
        return await self._async_complete_workout_for_workout(ha_user_id, workout)

    async def _async_complete_workout_for_workout(
        self, ha_user_id: str, workout: Workout
    ) -> Workout:
        workout.status = "completed"
        workout.completed_at = _now_iso()
        self._audit_workout(workout, ha_user_id, "complete_workout")
        await self._async_save()
        return workout

    async def async_skip_workout(
        self, ha_user_id: str, workout_id: str, *, target_profile_id: str | None = None
    ) -> Workout | None:
        workout = self._workout_for_actor(ha_user_id, workout_id, target_profile_id)
        if workout is None:
            return None
        self._joint_guard(workout, "skip_workout")
        workout.status = "skipped"
        self._audit_workout(workout, ha_user_id, "skip_workout")
        await self._async_save()
        return workout

    async def async_delete_workout(
        self, ha_user_id: str, workout_id: str, *, target_profile_id: str | None = None
    ) -> bool:
        """Removes a workout outright (any status) rather than changing its
        status -- for clearing test/junk entries, unlike skip/complete which
        preserve history."""
        workout = self._workout_for_actor(ha_user_id, workout_id, target_profile_id)
        if workout is None:
            return False
        self._joint_guard(workout, "delete_workout")
        self.data.workouts.remove(workout)
        self._audit_workout(workout, ha_user_id, "delete_workout")
        await self._async_save()
        return True

    async def async_remove_exercise(
        self,
        ha_user_id: str,
        workout_id: str,
        exercise_index: int,
        *,
        target_profile_id: str | None = None,
    ) -> Workout | None:
        """Drops one exercise (and whatever sets it had logged) from a
        workout -- e.g. equipment turned out to be taken, or it just isn't
        wanted anymore. No effect on the workout's other exercises."""
        workout = self._workout_for_actor(ha_user_id, workout_id, target_profile_id)
        if workout is None:
            return None
        self._joint_guard(workout, "remove_exercise")
        if not (0 <= exercise_index < len(workout.exercises)):
            return None
        del workout.exercises[exercise_index]
        self._audit_workout(workout, ha_user_id, "remove_exercise")
        await self._async_save()
        return workout

    async def async_replace_exercise(
        self,
        ha_user_id: str,
        workout_id: str,
        exercise_index: int,
        new_exercise_id: str,
        *,
        target_profile_id: str | None = None,
    ) -> Workout | None:
        """Replace remaining sets only, retaining the old identity on logged work.

        Eligibility and prescription are validated for the workout's owner before
        any mutation, including calls through the legacy HA service route.
        """
        workout = self._workout_for_actor(ha_user_id, workout_id, target_profile_id)
        if workout is None:
            return None
        self._joint_guard(workout, "replace_exercise")
        if not (0 <= exercise_index < len(workout.exercises)):
            return None
        if workout.status not in {"planned", "active"}:
            raise ValueError("Workout is not editable")
        from .load_policy import exercise_availability
        from .prescription_engine import prescribe
        profile = self.get_profile(workout.profile_id)
        definition = get_exercise(new_exercise_id)
        if definition is None or profile is None:
            raise ValueError("Unknown exercise or athlete")
        availability = exercise_availability(definition, profile, self.data)
        if not availability["selectable"]:
            raise ValueError("; ".join(availability["reasons"]))
        exercise = workout.exercises[exercise_index]
        if exercise.exercise_id == new_exercise_id:
            return workout
        remaining = [s for s in exercise.sets if not s.completed]
        if not remaining:
            raise ValueError("All sets are logged; add a new exercise instead")
        planned = {"sets": [{"reps": s.planned_reps or 8, "weight": None} for s in remaining]}
        if availability["feasible"]:
            prescribe(definition, planned, profile, self.data, "hypertrophy")
        bar_id, bar_weight = self._bar_for_exercise(profile, new_exercise_id)
        replacement = WorkoutExercise(
            exercise_id=new_exercise_id,
            sets=[WorkoutSet(planned_reps=s["reps"], planned_weight=s["weight"])
                  for s in planned["sets"]],
            selected_bar_equipment_id=bar_id, selected_bar_weight=bar_weight,
            rest_seconds=exercise.rest_seconds,
        )
        if any(s.completed for s in exercise.sets):
            # Keep the old identity, actuals and effort on the logged work.
            exercise.sets = [s for s in exercise.sets if s.completed]
            workout.exercises.insert(exercise_index + 1, replacement)
        else:
            workout.exercises[exercise_index] = replacement
        if any(s.completed for s in exercise.sets):
            if workout.current_exercise_index > exercise_index:
                workout.current_exercise_index += 1
            elif workout.current_exercise_index == exercise_index:
                workout.current_exercise_index = exercise_index + 1
                workout.current_set_index = 0
        elif workout.current_exercise_index == exercise_index:
            workout.current_set_index = 0
        self._audit_workout(workout, ha_user_id, "replace_exercise")
        await self._async_save()
        return workout

    async def async_share_workout(
        self,
        ha_user_id: str,
        workout_id: str,
        target_profile_id: str,
        *,
        acting_profile_id: str | None = None,
    ) -> ShareRequest | None:
        """Offers a copy of this workout's planned exercises/sets to any
        other profile on the instance -- being on the same Home Assistant
        instance already implies a shared-household trust level (see
        logic.other_profile_summaries), so this no longer requires
        target_profile_id to be a linked account first. Creates a pending
        ShareRequest rather than copying immediately; the recipient must
        accept it (async_respond_share) before anything lands in their own
        workouts. Only planned values (exercise_id, planned_reps,
        planned_weight) are captured, never actual/completed progress, and
        the source workout is untouched.

        acting_profile_id lets a coach share a workout on behalf of the
        athlete they're coaching (_target_profile enforces the same
        coach_workouts permission gains.log_set etc. already require) --
        the share is then offered *from* the athlete's profile, exactly as
        if the athlete had shared it themselves."""
        profile = self._target_profile(ha_user_id, acting_profile_id, "coach_workouts")
        if profile is None:
            return None
        workout = self.get_workout(workout_id)
        if workout is None or workout.profile_id != profile.id:
            return None
        target = self.get_profile(target_profile_id)
        if target is None or target.id == profile.id:
            return None

        request = ShareRequest(
            id=uuid.uuid4().hex,
            from_profile_id=profile.id,
            to_profile_id=target.id,
            kind="workout",
            name=workout.name,
            payload={
                "name": workout.name,
                "notes": workout.notes,
                "exercises": [
                    {
                        "exercise_id": exercise.exercise_id,
                        "notes": exercise.notes,
                        "sets": [
                            {
                                "planned_reps": s.planned_reps,
                                "planned_weight": s.planned_weight,
                            }
                            for s in exercise.sets
                        ],
                    }
                    for exercise in workout.exercises
                ],
            },
            created_at=_now_iso(),
        )
        self.data.share_requests.append(request)
        await self._async_save()
        return request

    @property
    def runs(self) -> list[Run]:
        return self.data.runs

    def get_run(self, run_id: str) -> Run | None:
        return logic.find_run_by_id(self.data.runs, run_id)

    def runs_for_profile(self, profile_id: str) -> list[Run]:
        return logic.runs_for_profile(self.data.runs, profile_id)

    def _own_run(self, ha_user_id: str, run_id: str) -> Run | None:
        """Mirrors _own_workout's cross-user isolation for runs."""
        profile = self.get_profile_by_user_id(ha_user_id)
        if profile is None:
            return None
        run = self.get_run(run_id)
        if run is None or run.profile_id != profile.id:
            return None
        return run

    async def async_create_run(
        self,
        ha_user_id: str,
        name: str,
        run_type: str,
        target_distance: float | None,
        target_duration_minutes: int | None,
        notes: str,
        *,
        target_profile_id: str | None = None,
        persist: bool = True,
    ) -> Run | None:
        """Create a planned run for the calling user's own profile.

        run_type is already validated by services.py's voluptuous schema
        against const.RUN_TYPES before reaching here.
        """
        profile = self._target_profile(ha_user_id, target_profile_id, "coach_workouts")
        if profile is None:
            return None

        run = Run(
            id=uuid.uuid4().hex,
            profile_id=profile.id,
            name=name,
            run_type=run_type,
            status="planned",
            target_distance=target_distance,
            target_duration_minutes=target_duration_minutes,
            notes=notes,
            created_at=_now_iso(),
        )
        self.data.runs.append(run)
        if persist:
            await self._async_save()
        return run

    async def async_log_run(
        self,
        ha_user_id: str,
        run_id: str,
        actual_distance: float | None,
        actual_duration_minutes: int | None,
        *,
        target_profile_id: str | None = None,
    ) -> Run | None:
        """Records actual distance/duration and marks the run completed in
        one step -- a run (unlike a multi-set workout) is logged as a whole
        after the fact, so there's no separate start/in-progress state."""
        run = self._run_for_actor(ha_user_id, run_id, target_profile_id)
        if run is None:
            return None
        run.actual_distance = actual_distance
        run.actual_duration_minutes = actual_duration_minutes
        run.status = "completed"
        run.completed_at = _now_iso()
        await self._async_save()
        return run

    async def async_skip_run(
        self, ha_user_id: str, run_id: str, *, target_profile_id: str | None = None
    ) -> Run | None:
        run = self._run_for_actor(ha_user_id, run_id, target_profile_id)
        if run is None:
            return None
        run.status = "skipped"
        await self._async_save()
        return run

    async def async_share_run(
        self,
        ha_user_id: str,
        run_id: str,
        target_profile_id: str,
        *,
        acting_profile_id: str | None = None,
    ) -> ShareRequest | None:
        """Offers a copy of this run's planned targets/segments to any
        other profile on the instance. Mirrors async_share_workout: no
        linked-account requirement, creates a pending ShareRequest instead
        of copying immediately, only planned values are captured, never
        actual/completed progress -- the source run is untouched -- and
        acting_profile_id lets a coach share on the athlete's behalf."""
        profile = self._target_profile(ha_user_id, acting_profile_id, "coach_workouts")
        if profile is None:
            return None
        run = self.get_run(run_id)
        if run is None or run.profile_id != profile.id:
            return None
        target = self.get_profile(target_profile_id)
        if target is None or target.id == profile.id:
            return None

        request = ShareRequest(
            id=uuid.uuid4().hex,
            from_profile_id=profile.id,
            to_profile_id=target.id,
            kind="run",
            name=run.name,
            payload={
                "name": run.name,
                "run_type": run.run_type,
                "target_distance": run.target_distance,
                "target_duration_minutes": run.target_duration_minutes,
                "notes": run.notes,
                "segments": copy.deepcopy(run.segments),
            },
            created_at=_now_iso(),
        )
        self.data.share_requests.append(request)
        await self._async_save()
        return request

    async def async_share_program(
        self,
        ha_user_id: str,
        program_id: str,
        target_profile_id: str,
        *,
        acting_profile_id: str | None = None,
    ) -> ShareRequest | None:
        """Offers a copy of this program's week/session prescriptions to
        any other profile on the instance. Mirrors async_share_workout: no
        linked-account requirement, creates a pending ShareRequest instead
        of copying immediately. Never captures the source's materialized
        occurrences (those point at the source's own actual workouts/runs,
        which the recipient doesn't own) or revision history; any
        actual_id/completed_at that leaked onto a session template itself
        (rather than living only in `occurrences`) is stripped the same
        way, so an accepted copy can't reference an actual record it
        doesn't belong to. acting_profile_id lets a coach share a program
        on the athlete's behalf (requires manage_programs, matching
        async_build_training's own permission choice for programs)."""
        profile = self._target_profile(ha_user_id, acting_profile_id, "manage_programs")
        if profile is None:
            return None
        program = next(
            (p for p in self.data.programs if p.id == program_id and p.profile_id == profile.id),
            None,
        )
        if program is None:
            return None
        target = self.get_profile(target_profile_id)
        if target is None or target.id == profile.id:
            return None

        weeks = copy.deepcopy(program.weeks)
        for week in weeks:
            for session in week.get("sessions", []):
                session.pop("actual_id", None)
                session.pop("completed_at", None)
                session.pop("actual_status", None)

        request = ShareRequest(
            id=uuid.uuid4().hex,
            from_profile_id=profile.id,
            to_profile_id=target.id,
            kind="program",
            name=program.name,
            payload={"name": program.name, "goal": program.goal, "weeks": weeks},
            created_at=_now_iso(),
        )
        self.data.share_requests.append(request)
        await self._async_save()
        return request

    async def async_respond_share(
        self,
        ha_user_id: str,
        share_id: str,
        accept: bool,
        *,
        acting_profile_id: str | None = None,
    ) -> Workout | Run | TrainingProgram | ShareRequest | None:
        """Resolves a pending ShareRequest offered to the calling user's
        profile (or, with acting_profile_id, offered to the athlete a
        coach is coaching -- same coach_workouts permission gains.log_set
        etc. already require). Declining just marks it resolved. Accepting
        builds a brand-new item (workout/run/program) for the recipient
        from the request's snapshot payload and appends it -- the same
        construction the old immediate-copy share methods used to do
        inline, just deferred until the recipient opts in. A program's
        copy starts fresh regardless of when it's accepted -- status
        "active", revision 0, start_date reset to the acceptance day, not
        the original share day. Returns the created item on accept, the
        (now-resolved) ShareRequest on decline, or None if the request
        doesn't exist, isn't addressed to this profile, or was already
        resolved."""
        profile = self._target_profile(ha_user_id, acting_profile_id, "coach_workouts")
        if profile is None:
            return None
        request = next((r for r in self.data.share_requests if r.id == share_id), None)
        if request is None or request.to_profile_id != profile.id or request.status != "pending":
            return None

        if request.kind == "joint_workout":
            viewer = self.get_profile_by_user_id(ha_user_id)
            if viewer.id != profile.id:
                raise ValueError("Workout Together invites must be accepted in your own account")
            return await self.async_respond_joint_invite(ha_user_id, request, accept)

        request.status = "accepted" if accept else "declined"
        request.responded_at = _now_iso()

        result: Workout | Run | TrainingProgram | ShareRequest = request
        if accept:
            payload = request.payload
            if request.kind == "workout":
                result = Workout(
                    id=uuid.uuid4().hex,
                    profile_id=profile.id,
                    name=payload.get("name") or "Workout",
                    status="planned",
                    exercises=[
                        WorkoutExercise(
                            exercise_id=e.get("exercise_id", ""),
                            sets=[
                                WorkoutSet(
                                    planned_reps=s.get("planned_reps"),
                                    planned_weight=s.get("planned_weight"),
                                    set_type=s.get('set_type'),
                                )
                                for s in e.get("sets", [])
                                if isinstance(s, dict)
                            ],
                            notes=e.get("notes", ""),
                            rest_seconds=e.get('rest_seconds'),
                        )
                        for e in payload.get("exercises", [])
                        if isinstance(e, dict)
                    ],
                    notes=payload.get("notes", ""),
                    created_at=_now_iso(),
                )
                self.data.workouts.append(result)
            elif request.kind == "run":
                result = Run(
                    id=uuid.uuid4().hex,
                    profile_id=profile.id,
                    name=payload.get("name") or "Run",
                    run_type=payload.get("run_type", "easy"),
                    status="planned",
                    target_distance=payload.get("target_distance"),
                    target_duration_minutes=payload.get("target_duration_minutes"),
                    notes=payload.get("notes", ""),
                    segments=copy.deepcopy(payload.get("segments", [])),
                    created_at=_now_iso(),
                )
                self.data.runs.append(result)
            elif request.kind == "program":
                result = TrainingProgram(
                    id=uuid.uuid4().hex,
                    profile_id=profile.id,
                    name=payload.get("name") or "Program",
                    goal=payload.get("goal", ""),
                    start_date=date.today().isoformat(),
                    weeks=copy.deepcopy(payload.get("weeks", [])),
                    status="active",
                    created_at=_now_iso(),
                )
                self.data.programs.append(result)

        await self._async_save()
        return result

    async def async_progress_state(
        self, ha_user_id: str, target_profile_id: str | None = None
    ) -> dict:
        """Read-only Strength Score + Activity data for the Progress tab.
        target_profile_id lets a coach view the same "view_progress"
        permission gains.training_state already gates coaching snapshots
        on -- raises ValueError the same way _target_profile always does
        if the caller isn't authorized to view that profile."""
        target = self._target_profile(ha_user_id, target_profile_id, "view_progress")
        if target is None:
            raise ValueError("Open Gains to create your profile first")
        workouts = self.workouts_for_profile(target.id)
        return progress.progress_state(target, workouts, date.today())

    async def async_ai_chat(
        self, ha_user_id: str, message: str, *, target_profile_id: str | None = None
    ) -> AICoachMessage | None:
        """One turn of the calling user's own AI Coach conversation.

        The AI only ever produces *proposals* -- profile_updates are
        applied through the same sanitize step gains.update_profile's
        schema would apply to a manual edit, proposed_workouts is
        validated against the exercise library the same way
        gains.create_workout validates a manual one, and proposed_runs is
        validated against const.RUN_TYPES. The AI is never able to write
        anything that a human couldn't have written through the existing
        services.
        """
        profile = self._target_profile(ha_user_id, target_profile_id, "coach_workouts")
        if profile is None:
            return None

        viewer = self.get_profile_by_user_id(ha_user_id)
        if target_profile_id and profile.id != viewer.id:
            self._target_profile(ha_user_id, target_profile_id, "view_progress")
            conversation = [
                AICoachMessage.from_dict(m)
                for m in profile.coaching_conversations.get(viewer.id, [])
            ]
        else:
            conversation = profile.ai_conversation

        def retain_conversation():
            if target_profile_id and profile.id != viewer.id:
                profile.coaching_conversations[viewer.id] = [
                    m.to_dict() for m in conversation[-100:]
                ]

        conversation.append(
            AICoachMessage(role=AI_ROLE_USER, content=message, created_at=_now_iso())
        )

        if self.ai_provider is None:
            assistant_message = AICoachMessage(
                role=AI_ROLE_ASSISTANT, content=NO_AI_PROVIDER_REPLY, created_at=_now_iso()
            )
            conversation.append(assistant_message)
            retain_conversation()
            await self._async_save()
            return assistant_message

        system_prompt = training.system_prompt(
            profile, self.data, self.get_profile_by_user_id(ha_user_id)
        )
        history = [{"role": m.role, "content": m.content} for m in conversation]
        from .planning_contracts import context_digest
        chat_digest = context_digest(profile, self.data)
        if not hasattr(self, '_chat_generation_tokens'):
            self._chat_generation_tokens = {}
        token = self._chat_generation_tokens.get(profile.id, 0) + 1
        self._chat_generation_tokens[profile.id] = token

        try:
            raw_reply = await self.ai_provider.complete(system_prompt, history)
        except AIProviderError as err:
            if target_profile_id is not None:
                self._target_profile(ha_user_id, target_profile_id, "coach_workouts")
                self._target_profile(ha_user_id, target_profile_id, "view_progress")
            assistant_message = AICoachMessage(
                role=AI_ROLE_ASSISTANT,
                content=f"Sorry, I couldn't reach the AI provider ({err}). Try again shortly.",
                created_at=_now_iso(),
            )
            conversation.append(assistant_message)
            retain_conversation()
            await self._async_save()
            return assistant_message

        self._target_profile(ha_user_id, target_profile_id, 'coach_workouts')
        if target_profile_id:
            self._target_profile(ha_user_id, target_profile_id, "view_progress")
        if token != self._chat_generation_tokens[profile.id] or chat_digest != context_digest(
            profile, self.data
        ):
            raise ValueError('Planning context changed; retry the conversation request')
        parsed = logic.parse_ai_reply(raw_reply)

        sanitized_updates = logic.sanitize_profile_updates(parsed["profile_updates"])
        if sanitized_updates and target_profile_id is None:
            for key, value in sanitized_updates.items():
                setattr(profile, key, value)
            profile.updated_at = _now_iso()

        proposed_workouts = []
        proposed_runs = []
        for kind, items, output in (
            ("workout", parsed["proposed_workouts"], proposed_workouts),
            ("run", parsed["proposed_runs"], proposed_runs),
        ):
            for item in items:
                try:
                    if kind == 'workout':
                        from .planning_contracts import chat_answers

                        output.append(
                            training.generated_workout(
                                {"answers": chat_answers(message, item.get("name", "Full Body"))},
                                profile,
                                self.data,
                            )
                        )
                    else:
                        output.append(training.normalize_generated(kind, item, profile, self.data))
                except ValueError:
                    continue
        try:
            reply_actions = training.actions(training.parse_json(raw_reply).get("actions", []))
        except (ValueError, TypeError):
            reply_actions = []
        from .planning_contracts import authored_chat_program
        authored = authored_chat_program(message)
        if authored:
            proposed_workouts = []
            reply_actions = [authored]
        # Recheck all context permissions after the provider await.
        self._target_profile(ha_user_id, target_profile_id, "coach_workouts")
        if target_profile_id:
            self._target_profile(ha_user_id, target_profile_id, "view_progress")

        assistant_message = AICoachMessage(
            role=AI_ROLE_ASSISTANT,
            content=parsed["reply"],
            created_at=_now_iso(),
            proposed_workouts=proposed_workouts,
            proposed_runs=proposed_runs,
            actions=reply_actions,
        )
        conversation.append(assistant_message)
        retain_conversation()
        await self._async_save()
        return assistant_message

