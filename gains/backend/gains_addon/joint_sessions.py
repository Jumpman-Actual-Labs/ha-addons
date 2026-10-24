"""Joint workouts link athlete-owned histories; they never share a performance row."""

from __future__ import annotations

import copy
import uuid
from datetime import UTC, datetime

from . import training
from .const import EFFORT_LEVELS
from .models import AthleteProfile, JointWorkoutSession, ShareRequest, Workout, WorkoutParticipant


class JointSessionMixin:
    def _joint_members(self, workout: Workout) -> list[Workout]:
        session = workout.joint_session
        if not session:
            return []
        return [
            w
            for w in self.data.workouts
            if w.joint_session and w.joint_session.get("id") == session.get("id")
        ]

    def _joint_sync(self, workout: Workout, action: str) -> None:
        session = workout.joint_session
        if not session:
            return
        if action not in {"joint_join", "joint_leave", "joint_end"} and (
            session["status"] != "active"
            or not any(
                p["profile_id"] == workout.profile_id and p["status"] == "active"
                for p in session["participants"]
            )
        ):
            return
        members = self._joint_members(workout)
        if not members:
            return
        session = copy.deepcopy(workout.joint_session)
        for participant in session["participants"]:
            owned = next((w for w in members if w.id == participant["workout_id"]), None)
            if owned and participant["status"] == "active":
                if owned.status in {"completed", "skipped"}:
                    participant["status"] = owned.status
                participant["exercises"] = [e.to_dict() for e in owned.exercises]
                from .exercises import get_exercise
                from .load_policy import exercise_availability
                athlete = self.get_profile(owned.profile_id)
                participant["inventory_policy"] = {
                    e.exercise_id: exercise_availability(
                        get_exercise(e.exercise_id), athlete, self.data
                    )
                    for e in owned.exercises if get_exercise(e.exercise_id) and athlete
                }
        active = [p for p in session["participants"] if p["status"] == "active"]
        session["turn"] = None
        template = next(
            (w for w in members if any(p["workout_id"] == w.id for p in active)), workout
        )
        # Exercise, then set, then participant: A1, B1, A2, B2.
        for ei, exercise in enumerate(template.exercises):
            for si in range(len(exercise.sets)):
                for participant in active:
                    owned = next((w for w in members if w.id == participant["workout_id"]), None)
                    if owned and not owned.exercises[ei].sets[si].completed:
                        session["turn"] = {
                            "profile_id": participant["profile_id"],
                            "exercise_index": ei,
                            "set_index": si,
                        }
                        break
                if session["turn"]:
                    break
            if session["turn"]:
                break
        if not active and session["status"] == "active":
            session["status"] = (
                "completed"
                if all(p["status"] == "completed" for p in session["participants"])
                else "ended"
            )
        for owned in members:
            owned.joint_session = copy.deepcopy(session)
            if owned.id != workout.id:
                owned.revision += 1

    def _joint_guard(
        self, workout: Workout, action: str, ei: int | None = None, si: int | None = None
    ) -> None:
        session = workout.joint_session
        if not session or session["status"] != "active":
            return
        participant = next(
            p for p in session["participants"] if p["profile_id"] == workout.profile_id
        )
        if participant["status"] != "active":
            return
        if action == "log_set":
            if (
                not isinstance(ei, int)
                or not isinstance(si, int)
                or not 0 <= ei < len(workout.exercises)
                or not 0 <= si < len(workout.exercises[ei].sets)
            ):
                raise ValueError("Invalid exercise or set")
            if workout.exercises[ei].sets[si].completed:
                return  # Corrections keep attribution and do not consume a turn.
            expected = {"profile_id": workout.profile_id, "exercise_index": ei, "set_index": si}
            if expected != session["turn"]:
                raise ValueError("It is another athlete's turn or a different set is next")
        elif action not in {
            "complete_workout",
            "log_exercise_effort",
            "focus",
            "notes",
            "set_bar",
            "plan_set",
        }:
            raise ValueError("Leave Workout Together before changing the session structure")

    def joint_targets(self, profile: AthleteProfile) -> list[dict]:
        return [
            {"profile_id": p.id, "display_name": p.display_name}
            for p in self.profiles
            if p.id != profile.id
        ]

    async def async_respond_joint_invite(
        self, user_id: str, request: ShareRequest, accept: bool
    ) -> Workout | ShareRequest:
        import asyncio

        if not hasattr(self, "_training_lock"):
            self._training_lock = asyncio.Lock()
        async with self._training_lock:
            partner = self.get_profile_by_user_id(user_id)
            if not partner or request.to_profile_id != partner.id or request.status != "pending":
                raise ValueError("This invite is no longer pending for your account")
            if not accept:
                request.status = "declined"
                request.responded_at = datetime.now(UTC).isoformat()
                await self._async_save()
                return request
            profile = self.get_profile(request.from_profile_id)
            workout = self.get_workout(request.payload.get("workout_id", ""))
            if (
                not profile
                or not workout
                or workout.profile_id != profile.id
                or workout.status != "planned"
                or workout.joint_session
                or workout.revision != request.payload.get("source_revision")
                or any(s.completed for e in workout.exercises for s in e.sets)
            ):
                raise ValueError(
                    "The invited workout has changed or started. Ask for a new invite."
                )
            mode = request.payload.get("device_mode", "different_devices")
            return await self._async_start_joint_invite(
                user_id, request, profile, partner, workout, mode
            )

    async def _async_start_joint_invite(
        self,
        user_id: str,
        request: ShareRequest,
        profile: AthleteProfile,
        partner: AthleteProfile,
        workout: Workout,
        mode: str,
    ) -> Workout:
        stamp = datetime.now(UTC).isoformat()
        from .inventory_units import performance_context
        other = Workout(
            load_context=performance_context(partner, self.data),
            id=uuid.uuid4().hex,
            profile_id=partner.id,
            name=workout.name,
            exercises=copy.deepcopy(workout.exercises),
            created_at=stamp,
            started_at=stamp,
            status="active",
        )
        # Only prescriptions are copied; performance and program attribution remain personal.
        for exercise in other.exercises:
            exercise.effort = None
            exercise.selected_bar_equipment_id, exercise.selected_bar_weight = (
                self._bar_for_exercise(partner, exercise.exercise_id)
            )
            for selected in exercise.sets:
                if selected.planned_weight is not None and profile.units != partner.units:
                    factor = 0.45359237 if partner.units == "metric" else 1 / 0.45359237
                    selected.planned_weight = round(selected.planned_weight * factor, 2)
                selected.actual_reps = selected.actual_weight = None
                selected.completed = selected.is_personal_record = False
                selected.recorded_by_profile_id = selected.recorded_at = None
                selected.personal_record_value = selected.previous_personal_record = None
        workout.status = "active"
        workout.started_at = stamp
        workout.joint_session = JointWorkoutSession(
            id=uuid.uuid4().hex,
            device_mode=mode,
            controller_profile_id=profile.id if mode == "same_device" else None,
            created_at=stamp,
            participants=[
                WorkoutParticipant(
                    profile_id=p.id, display_name=p.display_name, workout_id=w.id, units=p.units
                )
                for p, w in [(profile, workout), (partner, other)]
            ],
        ).to_dict()
        other.joint_session = copy.deepcopy(workout.joint_session)
        self.data.workouts.append(other)
        request.status = "accepted"
        request.responded_at = stamp
        self._audit_workout(workout, user_id, "joint_accept")
        await self._async_save()
        return other

    async def async_joint_action(self, user_id: str, action: str, fields: dict) -> dict:
        profile = self.get_profile_by_user_id(user_id)
        if not profile:
            raise ValueError("Open Gains to create your profile first")
        workout = self._own_workout(user_id, fields.get("workout_id", ""))
        if not workout:
            raise ValueError("Workout not found in your account")
        if fields.get("expected_revision") != workout.revision:
            raise ValueError("Workout changed on another device. Refresh and retry.")
        if action == "join":
            mode = fields.get("device_mode", "different_devices")
            if mode not in {"same_device", "different_devices"}:
                raise ValueError("Choose same device or different devices")
            partner = self.get_profile(fields.get("partner_profile_id", ""))
            if not partner or partner.id == profile.id:
                raise ValueError("Choose another Gains profile")
            if workout.status != "planned" or workout.joint_session:
                raise ValueError("Choose a planned workout that has not been joined")
            if any(s.completed for e in workout.exercises for s in e.sets):
                raise ValueError("Choose an unlogged planned workout")
            if not workout.exercises:
                raise ValueError("Choose a workout with exercises")
            pending = next(
                (
                    r
                    for r in self.data.share_requests
                    if r.kind == "joint_workout"
                    and r.status == "pending"
                    and r.from_profile_id == profile.id
                    and r.to_profile_id == partner.id
                    and r.payload.get("workout_id") == workout.id
                    and r.payload.get("source_revision") == workout.revision
                    and r.payload.get("device_mode") == mode
                ),
                None,
            )
            if pending:
                return {"invite_id": pending.id, "pending": True}
            request = ShareRequest(
                id=uuid.uuid4().hex,
                from_profile_id=profile.id,
                to_profile_id=partner.id,
                kind="joint_workout",
                name=workout.name,
                payload={
                    "workout_id": workout.id,
                    "device_mode": mode,
                    "source_revision": workout.revision,
                },
                created_at=datetime.now(UTC).isoformat(),
            )
            self.data.share_requests.append(request)
            await self._async_save()
            return {"invite_id": request.id, "pending": True}
        elif action in {"log_set", "log_effort", "complete_workout"}:
            session = workout.joint_session
            if (
                not session
                or session["status"] != "active"
                or session.get("device_mode") != "same_device"
                or session.get("controller_profile_id") != profile.id
            ):
                raise ValueError("Partner logging is only available on the shared session device")
            controller = next(p for p in session["participants"] if p["profile_id"] == profile.id)
            if controller["status"] not in {"active", "completed"}:
                raise ValueError("You have left this session")
            participant = next(
                (
                    p
                    for p in session["participants"]
                    if p["profile_id"] == fields.get("participant_profile_id")
                ),
                None,
            )
            if not participant or participant["status"] != "active":
                raise ValueError("Choose an active session participant")
            target = self.get_workout(participant["workout_id"])
            if (
                not target
                or target.status != "active"
                or target.profile_id != participant["profile_id"]
                or not target.joint_session
                or target.joint_session["id"] != session["id"]
            ):
                raise ValueError("Participant workout is no longer active")
            if action == "complete_workout":
                await self._async_complete_workout_for_workout(user_id, target)
            elif action == "log_effort":
                ei = training.number(
                    fields.get("exercise_index"), 0, len(target.exercises) - 1, True
                )
                effort = fields.get("effort")
                if effort not in EFFORT_LEVELS:
                    raise ValueError("Choose a valid exercise effort")
                target.exercises[ei].effort = effort
                self._audit_workout(target, user_id, "log_exercise_effort")
                await self._async_save()
            else:
                ei = training.number(
                    fields.get("exercise_index"), 0, len(target.exercises) - 1, True
                )
                si = training.number(
                    fields.get("set_index"), 0, len(target.exercises[ei].sets) - 1, True
                )
                reps = training.number(fields.get("reps"), 1, 200, True)
                weight = training.number(fields.get("weight", 0), 0, 2000)
                effort = fields.get("effort")
                if effort is not None and effort not in EFFORT_LEVELS:
                    raise ValueError("Choose a valid exercise effort")
                self._joint_guard(target, "log_set", ei, si)
                if effort is not None:
                    target.exercises[ei].effort = effort
                await self._async_log_set_for_workout(user_id, target, ei, si, reps, weight)
            return {"workout_id": target.id, "session_id": session["id"]}
        elif action in {"leave", "end"}:
            if not workout.joint_session or workout.joint_session["status"] != "active":
                raise ValueError("No active joint session")
            participant = next(
                p for p in workout.joint_session["participants"] if p["profile_id"] == profile.id
            )
            if participant["status"] != "active":
                raise ValueError("You have already left or finished")
            participant["status"] = "left"
            if action == "end":
                workout.joint_session["status"] = "ended"
                for p in workout.joint_session["participants"]:
                    if p["status"] == "active":
                        p["status"] = "left"
        else:
            raise ValueError("Unknown joint session action")
        self._audit_workout(workout, user_id, "joint_" + action)
        await self._async_save()
        return {"workout_id": workout.id, "session_id": workout.joint_session["id"]}
