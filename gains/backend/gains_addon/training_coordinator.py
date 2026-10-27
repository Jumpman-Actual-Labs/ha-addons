"""Permissioned training operations on the existing coordinator and Store."""

from __future__ import annotations

import asyncio
import copy
import json
import uuid
from datetime import UTC, date, datetime

from . import logic, training
from .ai import AIProviderError
from .equipment import get_equipment_item
from .exercises import get_exercise
from .models import AthleteProfile, TrainingProgram, Workout, WorkoutExercise, WorkoutSet
from .planning_contracts import PlanningContext, context_digest


def now() -> str:
    return datetime.now(UTC).isoformat()


def _local_today() -> date:
    """Home Assistant's local date (was dt_util.now()) - Supervisor sets the
    container's TZ to Home Assistant's configured time zone."""
    return datetime.now().astimezone().date()


class TrainingCoordinatorMixin:
    def _target_profile(self, user_id: str, target_id: str | None, permission: str):
        """Resolves who a coach-aware action actually acts on behalf of.

        No linking is required to coach someone -- being on the same Home
        Assistant instance is enough (matches gains.share_*'s own
        same-instance trust model). Two paths grant access to someone
        else's profile:

        - Automatic: a "kids" experience_level profile is always fully
          coachable by any non-kids profile, with every permission,
          since a minor can't meaningfully consent to being coached in
          the first place and a household's kids shouldn't need a
          separate opt-in step per adult.
        - Granted: anyone else needs an explicit per-permission grant
          from the athlete (async_set_coach_permissions), same as
          before, just without the linking prerequisite.
        """
        viewer = self.get_profile_by_user_id(user_id)
        if viewer is None:
            if target_id is None:
                return None
            raise ValueError("No viewer profile")
        if target_id is None or target_id == viewer.id:
            return viewer
        target = self.get_profile(target_id)
        if target is None:
            raise ValueError("No such athlete")
        if target.experience_level == "kids" and viewer.experience_level != "kids":
            return target
        grant = target.coach_grants.get(viewer.id, {})
        permissions = grant.get("permissions", {}) if isinstance(grant, dict) else {}
        if not isinstance(permissions, dict) or permissions.get(permission) is not True:
            raise ValueError("Athlete has not granted this permission")
        return target

    def _effective_permissions(self, viewer, target) -> dict:
        """What `viewer` can do to `target`'s training -- full access for
        their own profile or an auto-coachable kid (see _target_profile),
        otherwise whatever the athlete explicitly granted."""
        if viewer.id == target.id or (
            target.experience_level == "kids" and viewer.experience_level != "kids"
        ):
            return dict.fromkeys(training.PERMISSIONS, True)
        grant = target.coach_grants.get(viewer.id, {})
        permissions = grant.get("permissions", {}) if isinstance(grant, dict) else {}
        return {k: permissions.get(k, False) for k in training.PERMISSIONS}

    def _workout_for_actor(self, user_id: str, workout_id: str, target_id: str | None):
        if target_id is None:
            return self._own_workout(user_id, workout_id)
        target = self._target_profile(user_id, target_id, "coach_workouts")
        workout = self.get_workout(workout_id)
        if workout is None or workout.profile_id != target.id:
            raise ValueError("Workout does not belong to the selected athlete")
        return workout

    def _run_for_actor(self, user_id: str, run_id: str, target_id: str | None):
        if target_id is None:
            return self._own_run(user_id, run_id)
        target = self._target_profile(user_id, target_id, "coach_workouts")
        run = self.get_run(run_id)
        if run is None or run.profile_id != target.id:
            raise ValueError("Run does not belong to the selected athlete")
        return run

    def _audit_workout(self, workout, user_id: str, action: str) -> None:
        viewer = self.get_profile_by_user_id(user_id)
        workout.revision += 1
        workout.audit.append(
            {
                "action": action,
                "recorded_by_profile_id": viewer.id,
                "recorded_at": now(),
                "revision": workout.revision,
            }
        )
        workout.audit = workout.audit[-500:]
        self._joint_sync(workout, action)
        if action in {"complete_workout", "skip_workout"} and workout.program_id:
            program = next(
                (
                    p
                    for p in self.data.programs
                    if p.id == workout.program_id and p.profile_id == workout.profile_id
                ),
                None,
            )
            if program and workout.id not in program.rotation_events:
                program.rotation_events[workout.id] = workout.status
                program.revision += 1

    async def async_set_coach_permissions(
        self, user_id: str, coach_id: str, permissions: dict, role: str = "coach"
    ) -> dict:
        """Grants (or revokes) a coach's permissions over the calling
        athlete -- any other profile on the instance can be granted here
        directly, no linking required first (mirrors _target_profile
        dropping that same requirement)."""
        athlete = self.get_profile_by_user_id(user_id)
        if athlete is None or self.get_profile(coach_id) is None:
            raise ValueError("No such coach")
        if role not in {"coach", "guardian", "partner"}:
            raise ValueError("Invalid relationship role")
        if not isinstance(permissions, dict) or set(permissions) - training.PERMISSIONS:
            raise ValueError("Invalid permission names")
        if any(type(v) is not bool for v in permissions.values()):
            raise ValueError("Permissions must be true or false")
        normalized = {k: permissions.get(k, False) for k in training.PERMISSIONS}
        if normalized["coach_workouts"]:
            normalized["view_workouts"] = True
        athlete.coach_grants[coach_id] = {"role": role, "permissions": normalized}
        await self._async_save()
        return {"saved": True}

    async def async_training_state(self, user_id: str, target_id: str | None = None) -> dict:
        viewer = self.get_profile_by_user_id(user_id)
        target = self._target_profile(user_id, target_id, "view_workouts")
        if viewer is None or target is None:
            raise ValueError("Open Gains to create your profile first")
        permissions = self._effective_permissions(viewer, target)
        workouts = self.workouts_for_profile(target.id)
        runs = self.runs_for_profile(target.id)
        if not permissions.get("view_progress"):
            workouts = [w for w in workouts if w.status in {"planned", "active"}]
            runs = [r for r in runs if r.status == "planned"]
        attrs = logic.profile_extra_attributes(
            target, workouts, runs, self.profiles, self.gym_profiles, self.data.share_requests
        )
        from .load_policy import inventory_policy
        attrs["inventory_policy"] = inventory_policy(target, self.data)
        attrs["joint_targets"] = self.joint_targets(target) if viewer.id == target.id else []
        # Coaching snapshots do not expose account administration or the athlete's private chat.
        # share_targets/incoming_shares stay populated -- a coach can act on
        # the athlete's behalf for sharing (gains.share_*/respond_share with
        # acting_profile_id), so the picker needs the athlete's real lists.
        if viewer.id != target.id:
            attrs["ai_conversation"] = (
                target.coaching_conversations.get(viewer.id, [])
                if permissions.get("coach_workouts") and permissions.get("view_progress")
                else []
            )
            attrs["linked_profiles"] = []
            attrs["linkable_profiles"] = []
            if not permissions.get("view_progress"):
                attrs["personal_records"] = {}
                attrs.pop("muscle_recovery", None)
        choices = []
        for athlete in self.profiles:
            try:
                if athlete.id != viewer.id:
                    self._target_profile(user_id, athlete.id, "view_workouts")
                    choices.append({"profile_id": athlete.id, "display_name": athlete.display_name})
            except ValueError:
                pass
        return {
            "attributes": attrs,
            "viewer_profile_id": viewer.id,
            "active_profile_id": target.id,
            "mode": "self" if target.id == viewer.id else "coach",
            "permissions": permissions,
            "coachable_profiles": choices,
            "grants": viewer.coach_grants,
            "programs": [
                training.program_state(p, self.data, _local_today())
                for p in self.data.programs
                if p.profile_id == target.id
            ]
            if permissions.get("manage_programs")
            else [],
            "proposals": [
                p
                for p in self.data.training_proposals
                if p["profile_id"] == target.id and p["viewer_profile_id"] == viewer.id
            ],
        }

    async def async_build_training(
        self, user_id: str, request: dict, target_id: str | None = None
    ) -> dict:
        target = self._target_profile(
            user_id,
            target_id,
            "manage_programs" if request.get("type") == "program" else "coach_workouts",
        )
        if target is None:
            raise ValueError('Open Gains to create your profile first')
        if not hasattr(self, '_generation_locks'):
            self._generation_locks = {}
        key = ('builder', target.id)
        lock = self._generation_locks.setdefault(key, asyncio.Lock())
        if lock.locked():
            raise ValueError('Generation already in progress for this athlete')
        async with lock:
            return await self._async_build_training(user_id, request, target_id)

    async def _async_build_training(
        self, user_id: str, request: dict, target_id: str | None = None
    ) -> dict:
        request = training.build_request(request)
        if request['type'] == 'program' and not request['answers'].get('start_date'):
            request['answers']['start_date'] = _local_today().isoformat()
        permission = "manage_programs" if request["type"] == "program" else "coach_workouts"
        target = self._target_profile(user_id, target_id, permission)
        viewer = self.get_profile_by_user_id(user_id)
        if target is None:
            raise ValueError('Open Gains to create your profile first')
        if target.id != viewer.id:
            self._target_profile(user_id, target_id, "view_progress")
        if request["type"] == "program":
            request["answers"].setdefault("sequencing_policy", target.preferred_sequencing_policy)
        system_prompt = training.system_prompt(target, self.data, viewer)
        digest = context_digest(target, self.data)
        planning_context = PlanningContext(
            target.id, viewer.id, digest, now(), request["answers"].get("seed", 0)
        )
        builder_context = {"training_build_request": request}
        if request["type"] == "workout":
            answers = request["answers"]
            focus = " ".join(
                str(answers.get(key) or "")
                for key in ("focus", "focus_other", "goal")
            )
            from .workout_planner import select_exercises

            builder_context["ranked_exercise_ids"] = select_exercises(
                training.EXERCISE_LIBRARY,
                training.allowed_exercises(target, self.data),
                [w for w in self.data.workouts if w.profile_id == target.id],
                focus,
                count=12,
            )
            builder_context["ranking_guidance"] = (
                "Prefer the ranked eligible exercises where appropriate; "
                "avoid redundant movement patterns and honor user requirements."
            )
        messages = [{"role": "user", "content": json.dumps(builder_context)}]
        payload = None
        last_error: ValueError | json.JSONDecodeError | None = None
        for attempt in range(2):
            if self.ai_provider is None:
                break
            try:
                raw = await self.ai_provider.complete(system_prompt, messages)
            except AIProviderError as err:
                last_error = err
                break
            self._target_profile(user_id, target_id, permission)
            if target.id != viewer.id:
                self._target_profile(user_id, target_id, "view_progress")
            if digest != context_digest(target, self.data):
                raise ValueError('Planning context changed; generate a fresh proposal')
            try:
                parsed = training.parse_json(raw)
                generated = training.generated_proposal(parsed, request["type"])
                candidate = training.normalize_generated(
                    request["type"], generated, target, self.data
                )
                if request['type'] == 'workout':
                    candidate = training.generated_workout(request, target, self.data)
                if request["type"] == "program":
                    if len(candidate["weeks"]) != 1:
                        raise ValueError("Generate exactly one week of program sessions")
                    candidate = training.enforce_program_split(
                        candidate, request, target, self.data
                    )
                payload = candidate
                break
            except (ValueError, json.JSONDecodeError) as err:
                last_error = err
                if attempt == 0:
                    messages.append(
                        {
                            "role": "user",
                            "content": (
                                "Your previous response was invalid: "
                                f"{err}. Return one complete corrected JSON object."
                            ),
                        }
                    )
        if payload is None:
            if request["type"] == "program":
                payload = training.fallback_program(request, target, self.data)
            elif request["type"] == "workout":
                payload = training.fallback_workout(request, target, self.data)
            else:
                raise ValueError(
                    "Geoffrey's proposal could not be used: "
                    f"{last_error or 'invalid response'}. Try Generate proposal again."
                ) from last_error
        self._target_profile(user_id, target_id, permission)
        if target.id != viewer.id:
            self._target_profile(user_id, target_id, 'view_progress')
        if digest != context_digest(target, self.data):
            raise ValueError('Planning context changed; generate a fresh proposal')
        proposal = {
            'planning_context': planning_context.to_dict(),
            'context_digest': digest,
            "id": uuid.uuid4().hex,
            "profile_id": target.id,
            "viewer_profile_id": viewer.id,
            "type": request["type"],
            "request": request,
            "payload": payload,
            "created_at": now(),
            "accepted_id": None,
        }
        self.data.training_proposals.append(proposal)
        # Bound unaccepted proposals per viewer, retain accepted IDs for retry idempotency.
        pending = [
            p
            for p in self.data.training_proposals
            if p["viewer_profile_id"] == viewer.id and not p.get("accepted_id")
        ]
        for old in pending[:-20]:
            self.data.training_proposals.remove(old)
        await self._async_save()
        return copy.deepcopy(proposal)

    async def async_accept_training(
        self, user_id: str, proposal_id: str, payload: dict, target_id: str | None = None
    ) -> dict:
        if not hasattr(self, "_training_lock"):
            self._training_lock = asyncio.Lock()
        async with self._training_lock:
            viewer = self.get_profile_by_user_id(user_id)
            p = next((p for p in self.data.training_proposals if p["id"] == proposal_id), None)
            if p is None or viewer is None or p["viewer_profile_id"] != viewer.id:
                raise ValueError("Proposal is unavailable")
            target = self._target_profile(
                user_id,
                target_id,
                "manage_programs" if p["type"] == "program" else "coach_workouts",
            )
            if target.id != p["profile_id"]:
                raise ValueError("Proposal belongs to another athlete")
            if p.get("accepted_id"):
                return {"id": p["accepted_id"], "type": p["type"]}
            if p.get('context_digest') and p['context_digest'] != context_digest(target, self.data):
                raise ValueError('Planning context changed; generate a fresh proposal')
            valid = training.validate_proposal(p["type"], payload, target, self.data)
            previous_proposal = copy.deepcopy(p)
            p['manual_override'] = payload != p['payload']
            if p["type"] == "program":
                item = TrainingProgram(
                    id=uuid.uuid4().hex, profile_id=target.id, created_at=now(), **valid
                )
                item.origin_request = {} if p['manual_override'] else copy.deepcopy(p["request"])
                item.manual_overrides = p['manual_override']
                item.sequencing_policy = p["request"]["answers"].get(
                    "sequencing_policy", "calendar"
                )
                self.data.programs.append(item)
            else:
                item = await self._create_prescription(user_id, target_id, p["type"], valid)
                if p["type"] == "workout" and p["manual_override"]:
                    for exercise in item.exercises:
                        for planned in exercise.sets:
                            planned.manual_weight = True
            p["payload"] = valid
            p["accepted_id"] = item.id
            try:
                await self._async_save()
            except Exception:
                collection = (
                    self.data.programs
                    if p["type"] == "program"
                    else self.data.runs
                    if p["type"] == "run"
                    else self.data.workouts
                )
                collection.remove(item)
                p.clear()
                p.update(previous_proposal)
                raise
            return {"id": item.id, "type": p["type"]}

    async def _create_prescription(
        self, user_id: str, target_id: str | None, kind: str, payload: dict
    ):
        if kind == "run":
            item = await self.async_create_run(
                user_id,
                payload["name"],
                payload["run_type"],
                payload.get("target_distance"),
                payload.get("target_duration_minutes"),
                payload.get("notes", ""),
                target_profile_id=target_id,
                persist=False,
            )
            item.segments = payload.get("segments", [])
        else:
            item = await self.async_create_workout(
                user_id,
                payload["name"],
                payload["exercises"],
                target_profile_id=target_id,
                persist=False,
            )
        if kind != "run" and item:
            manual = bool(payload.get("planning", {}).get("manual_override"))
            for exercise in item.exercises:
                for planned in exercise.sets:
                    planned.manual_weight = manual
        return item

    async def async_program_action(
        self, user_id: str, program_id: str, action: str, fields: dict, target_id: str | None = None
    ) -> dict:
        target = self._target_profile(user_id, target_id, "manage_programs")
        program = next(
            (p for p in self.data.programs if p.id == program_id and p.profile_id == target.id),
            None,
        )
        if program is None:
            raise ValueError("Program does not belong to this athlete")
        if action == "generate_week":
            return await self._async_generate_program_week(
                user_id, target_id, target, program, fields
            )
        if not hasattr(self, "_training_lock"):
            self._training_lock = asyncio.Lock()
        async with self._training_lock:
            self._target_profile(user_id, target_id, "manage_programs")
            if action == "delete":
                self.data.programs.remove(program)
                await self._async_save()
                return {"deleted": True}
            if action == "status":
                if fields.get("status") not in {"active", "paused"}:
                    raise ValueError("Invalid program status")
                program.status = fields["status"]
            elif action == "regenerate_session":
                self._target_profile(user_id, target_id, "coach_workouts")
                if program.status != "active":
                    raise ValueError("Activate the program before regenerating a workout")
                requested = fields.get("session_id", "")
                try:
                    week_number = (
                        int(requested.split(":", 1)[0][5:])
                        if requested.startswith("week-") else 1
                    )
                    template_id = (
                        requested.split(":", 1)[1]
                        if requested.startswith("week-") else requested
                    )
                    if week_number < 1:
                        raise ValueError
                except (ValueError, IndexError, AttributeError) as err:
                    raise ValueError("Invalid session identity") from err
                week = training.program_week(program, week_number, self.data)
                session = next((s for s in week['sessions'] if s['id'] == template_id), None)
                if session is None or session['type'] != 'workout':
                    raise ValueError("Choose a planned strength workout")
                occurrence = program.occurrences.get(requested, {})
                linked = (self.get_workout(occurrence['actual_id'])
                          if occurrence.get('actual_id') else None)
                if occurrence.get('completed_at') or (linked and (
                    linked.profile_id != target.id or linked.status != 'planned'
                    or any(s.completed for e in linked.exercises for s in e.sets)
                )):
                    raise ValueError("Only an unstarted workout can be regenerated")
                payload = training.regenerate_session(session, target, self.data)
                session['prescription'] = payload
                program.generated_weeks[str(week_number)] = week
                if linked:
                    linked.exercises = [WorkoutExercise.from_dict(e) for e in payload['exercises']]
            elif action == "open_session":
                if program.status != "active":
                    raise ValueError("Activate the program before opening a session")
                requested_id = fields.get("session_id", "")
                if not isinstance(requested_id, str):
                    raise ValueError('Invalid session identity')
                occurrence_id = requested_id if requested_id.startswith("week-") else None
                try:
                    template_id = requested_id.split(':', 1)[1] if occurrence_id else requested_id
                    requested_week = int(occurrence_id.split(':', 1)[0][5:]) if occurrence_id else 1
                    if requested_week < 1:
                        raise ValueError
                except (ValueError, IndexError) as err:
                    raise ValueError('Invalid program week or session identity') from err
                week = training.program_week(program, requested_week, self.data)
                session = next(
                    (s for s in week["sessions"] if s["id"] == template_id),
                    None,
                )
                if session is None:
                    raise ValueError("Session not found")
                if (
                    program.origin_request
                    and requested_week > 1
                    and str(requested_week) not in program.generated_weeks
                ):
                    program.generated_weeks[str(requested_week)] = copy.deepcopy(week)
                occurrence = program.occurrences.setdefault(occurrence_id or template_id, {})
                if occurrence.get("actual_id"):
                    linked = (self.get_run(occurrence["actual_id"]) if session["type"] == "run"
                              else self.get_workout(occurrence["actual_id"]))
                    if linked is None:
                        # Deleting a materialized session must not leave a dead preview link.
                        occurrence.pop("actual_id", None)
                        occurrence.pop("completed_at", None)
                    elif linked.profile_id != target.id:
                        raise ValueError("Session does not belong to the selected athlete")
                if occurrence.get("actual_id"):
                    if fields.get("start_now") and session["type"] != "run":
                        workout = self._workout_for_actor(
                            user_id, occurrence["actual_id"], target_id
                        )
                        if workout and workout.status == "planned":
                            await self.async_start_workout(
                                user_id, workout.id, target_profile_id=target_id
                            )
                    return {"id": occurrence["actual_id"], "type": session["type"]}
                if session["type"] in {"rest", "recovery"}:
                    occurrence["completed_at"] = now()
                else:
                    # Program management alone does not grant live logging/creation rights.
                    self._target_profile(user_id, target_id, "coach_workouts")
                    # program_week already resolves adaptive or persisted prescriptions.
                    prescribed = session
                    payload = training.validate_proposal(
                        "run" if session["type"] == "run" else "workout",
                        prescribed["prescription"],
                        target,
                        self.data,
                    )
                    item = await self._create_prescription(
                        user_id, target_id, session["type"], payload
                    )
                    item.program_id = program.id
                    item.program_session_id = occurrence_id or template_id
                    occurrence["actual_id"] = item.id
                    if fields.get("start_now") and session["type"] != "run":
                        await self.async_start_workout(
                            user_id, item.id, target_profile_id=target_id
                        )
                    program.revision += 1
                    await self._async_save()
                    return {"id": item.id, "type": "run" if session["type"] == "run" else "workout"}
            elif action == "update":
                if fields.get("revision") != program.revision:
                    raise ValueError("Program changed; refresh before saving")
                valid = training.validate_program(fields.get("payload"), target, self.data)
                # Keep materialized sessions attached and immutable during plan edits.
                previous = {
                    s["id"]: s
                    for w in program.weeks
                    for s in w["sessions"]
                    if s.get("actual_id") or s.get("completed_at")
                }
                for week in valid["weeks"]:
                    for i, session in enumerate(week["sessions"]):
                        if session["id"] in previous:
                            week["sessions"][i] = previous.pop(session["id"])
                if previous:
                    raise ValueError("Cannot remove a started program session")
                for key, value in valid.items():
                    setattr(program, key, value)
                # Explicit authored edits become the source of future weeks.
                program.origin_request = {}
                program.manual_overrides = True
            else:
                raise ValueError("Unknown program action")
            program.revision += 1
            await self._async_save()
            return program.to_dict()

    async def _async_generate_program_week(self, user_id: str, target_id: str | None,
                                         target: AthleteProfile, program: TrainingProgram,
                                         fields: dict) -> dict:
        week_number = fields.get('week_number')
        if type(week_number) is not int or not 2 <= week_number <= 260:
            raise ValueError('Choose a future week number between 2 and 260')
        if not hasattr(self, '_generation_locks'):
            self._generation_locks = {}
        key = ('program', program.id)
        lock = self._generation_locks.setdefault(key, asyncio.Lock())
        async with lock:
            self._target_profile(user_id, target_id, 'manage_programs')
            if program.status != 'active':
                raise ValueError('Activate the program before generating a week')
            if str(week_number) in program.generated_weeks:
                return {'week_number': week_number, 'generated': False}
            revision = program.revision
            digest = context_digest(target, self.data)
            template = training.program_template(program, week_number, self.data)
            viewer = self.get_profile_by_user_id(user_id)
            if target.id != viewer.id:
                self._target_profile(user_id, target_id, 'view_progress')
            prompt = training.system_prompt(target, self.data, viewer)
            context = {'task': 'Generate exactly one new training week', 'week_number': week_number,
                       'previous_week': template, 'goal': program.goal}
            week = None
            for _attempt in range(2):
                if self.ai_provider is None:
                    break
                try:
                    raw = await self.ai_provider.complete(
                        prompt, [{"role": "user", "content": json.dumps(context)}]
                    )
                except AIProviderError:
                    break
                self._target_profile(user_id, target_id, 'manage_programs')
                if target.id != viewer.id:
                    self._target_profile(user_id, target_id, "view_progress")
                if (
                    program.revision != revision
                    or context_digest(target, self.data) != digest
                    or program not in self.data.programs
                ):
                    raise ValueError('Planning context changed; retry week generation')
                try:
                    candidate = training.generated_proposal(training.parse_json(raw), "program")
                    normalized = training.normalize_generated(
                        "program", candidate, target, self.data
                    )
                    week = training.enforce_week_workouts(
                        normalized["weeks"][0], target, self.data, template=template,
                        preserve_exercises=program.manual_overrides,
                    )
                    break
                except (ValueError, TypeError):
                    context["correction"] = (
                        "Preserve exact session count, types and days; return valid JSON"
                    )
            if week is None:
                week = training.enforce_week_workouts(
                    template, target, self.data, template=template,
                    preserve_exercises=program.manual_overrides,
                )
            self._target_profile(user_id, target_id, 'manage_programs')
            if target.id != viewer.id:
                self._target_profile(user_id, target_id, "view_progress")
            if (
                program.revision != revision
                or context_digest(target, self.data) != digest
                or program not in self.data.programs
            ):
                raise ValueError('Planning context changed; retry week generation')
            # Existing occurrence prescriptions are immutable, including opened sessions.
            for index, session in enumerate(week['sessions']):
                session['id'] = template['sessions'][index]['id']
                occurrence = program.occurrences.get(f"week-{week_number}:{session['id']}", {})
                if occurrence.get('actual_id') or occurrence.get('completed_at'):
                    existing = training.program_week(program, week_number, self.data)
                    session.clear()
                    session.update(copy.deepcopy(existing['sessions'][index]))
            week['week_number'] = week_number
            program.generated_weeks[str(week_number)] = week
            program.revision += 1
            try:
                await self._async_save()
            except Exception:
                program.generated_weeks.pop(str(week_number), None)
                program.revision -= 1
                raise
            return {'week_number': week_number, 'generated': True}

    def _apply_set_bar(
        self, workout: Workout, exercise: WorkoutExercise, equipment_id: object, bar_weight: object
    ) -> None:
        """Select a configured bar for one exercise of the workout owner's gym."""
        equipment_id = training.text(equipment_id)
        bar_weight = training.number(bar_weight, 0.1, 200)
        item = get_equipment_item(equipment_id)
        if (
            item is None
            or item.get("category") != "bars_and_plates"
            or item.get("equipment_category") != "barbell"
            or equipment_id in {"landmine", "plates"}
        ):
            raise ValueError("Select a valid bar")

        target = self.get_profile(workout.profile_id)
        gym = (
            self.get_gym_profile(target.gym_profile_id)
            if target is not None and target.gym_profile_id
            else None
        )
        configured = gym.equipment.get(equipment_id, []) if gym is not None else []
        from .inventory_units import convert_weight
        available_weights = [
            convert_weight(item["default_weight"], "imperial", target.units)
            if value is None
            else convert_weight(
                value, gym.inventory_units or target.units, target.units
            )
            for value in configured
            if value is not None or item.get("default_weight") is not None
        ]
        if not any(abs(weight - bar_weight) < 0.01 for weight in available_weights):
            raise ValueError("That bar is not configured in this gym")

        exercise_def = get_exercise(exercise.exercise_id)
        required_id = exercise_def.get("requires_equipment_id") if exercise_def else None
        if required_id in {
            "olympic_barbell",
            "ez_bar",
            "trap_bar",
            "short_bar",
            "safety_squat_bar",
        } and equipment_id != required_id:
            raise ValueError("That exercise requires a different bar")

        exercise.selected_bar_equipment_id = equipment_id
        exercise.selected_bar_weight = bar_weight
        if target is not None:
            target.last_bar_by_exercise[exercise.exercise_id] = {
                "equipment_id": equipment_id,
                "weight": bar_weight,
            }
            target.updated_at = now()

    async def async_session_action(
        self, user_id: str, target_id: str | None, action: str, fields: dict
    ) -> dict:
        """Explicit allowlist, original actor retained through all existing mutations."""
        from . import services

        schemas = {
            "start_workout": services.WORKOUT_ID_SCHEMA,
            "complete_workout": services.WORKOUT_ID_SCHEMA,
            "skip_workout": services.WORKOUT_ID_SCHEMA,
            "delete_workout": services.WORKOUT_ID_SCHEMA,
            "log_set": services.LOG_SET_SCHEMA,
            "log_exercise_effort": services.LOG_EXERCISE_EFFORT_SCHEMA,
            "remove_exercise": services.REMOVE_EXERCISE_SCHEMA,
            "replace_exercise": services.REPLACE_EXERCISE_SCHEMA,
            "add_exercise": services.ADD_EXERCISE_SCHEMA,
            "log_run": services.LOG_RUN_SCHEMA,
            "skip_run": services.RUN_ID_SCHEMA,
        }
        self._target_profile(user_id, target_id, "coach_workouts")
        if not hasattr(self, "_training_lock"):
            self._training_lock = asyncio.Lock()
        async with self._training_lock:
            fields = dict(fields)
            expected = fields.pop("expected_revision", None)
            workout = None
            if "workout_id" in fields:
                workout = self._workout_for_actor(user_id, fields["workout_id"], target_id)
                if workout is None:
                    raise ValueError("Workout not found")
                if expected is not None and expected != workout.revision:
                    raise ValueError("Workout changed on another device. Refresh and retry.")
                self._joint_guard(workout, action,
                                  fields.get("exercise_index"), fields.get("set_index"))
            if action in {"create_workout", "create_run"}:
                kind = "workout" if action == "create_workout" else "run"
                target = self._target_profile(user_id, target_id, "coach_workouts")
                valid = training.validate_proposal(kind, fields, target, self.data)
                item = await self._create_prescription(user_id, target_id, kind, valid)
                await self._async_save()
                return {"id": item.id}
            if action in schemas:
                fields = schemas[action](fields)
                if workout is not None:
                    if action not in {"delete_workout"} and workout.status not in {
                        "planned",
                        "active",
                    }:
                        raise ValueError("Workout is not editable")
                    if action == "log_set" and workout.status != "active":
                        raise ValueError("Start the workout before logging")
                    if "exercise_index" in fields:
                        ei = training.number(
                            fields["exercise_index"], 0, len(workout.exercises) - 1, True
                        )
                        if "set_index" in fields:
                            training.number(
                                fields["set_index"], 0, len(workout.exercises[ei].sets) - 1, True
                            )
                    if action in {"replace_exercise", "add_exercise"}:
                        target = self.get_profile(workout.profile_id)
                        new_id = fields.get("new_exercise_id", fields.get("exercise_id"))
                        if new_id not in training.allowed_exercises(target, self.data):
                            raise ValueError("Exercise unavailable for this athlete")
                if action == "log_set":
                    if fields.get("reps") is not None:
                        training.number(fields["reps"], 1, 200, True)
                    if fields.get("weight") is not None:
                        training.number(fields["weight"], 0, 2000)
                if action == "log_run":
                    for key in ("actual_distance", "actual_duration_minutes"):
                        if fields.get(key) is not None:
                            training.number(fields[key], 0.1, 10000)
                result = await getattr(self, "async_" + action)(
                    user_id, **fields, target_profile_id=target_id
                )
                if result is None or result is False:
                    raise ValueError("Action could not be applied")
                return {"saved": True}
            if workout is None or workout.status not in {"planned", "active"}:
                raise ValueError("Select an editable workout")
            ei = training.number(fields.get("exercise_index"), 0, len(workout.exercises) - 1, True)
            exercise = workout.exercises[ei]
            if action == "focus":
                workout.current_exercise_index = ei
                workout.current_set_index = training.number(
                    fields.get("set_index", 0), 0, max(0, len(exercise.sets) - 1), True
                )
            elif action == "notes":
                exercise.notes = training.text(fields.get("notes"))
            elif action == "skip_exercise":
                exercise.notes = (exercise.notes + "\nSkipped during session").strip()
                workout.current_exercise_index = min(ei + 1, len(workout.exercises) - 1)
                workout.current_set_index = 0
            elif action == "add_set":
                if len(exercise.sets) >= 20:
                    raise ValueError("Maximum 20 sets")
                exercise.sets.append(WorkoutSet(planned_reps=8, planned_weight=0))
            elif action == "set_bar":
                self._apply_set_bar(
                    workout, exercise, fields.get("equipment_id"), fields.get("bar_weight")
                )
            elif action in {"remove_set", "plan_set"}:
                si = training.number(fields.get("set_index"), 0, len(exercise.sets) - 1, True)
                selected = exercise.sets[si]
                if selected.completed:
                    raise ValueError("Use log correction for completed sets")
                if action == "remove_set":
                    if len(exercise.sets) <= 1:
                        raise ValueError("Keep at least one set")
                    exercise.sets.pop(si)
                else:
                    reps = training.number(fields.get("reps"), 1, 200, True)
                    weight = training.number(fields.get("weight", 0), 0, 2000)
                    selected.planned_reps = reps
                    selected.planned_weight = weight
                    selected.manual_weight = True
            else:
                raise ValueError("Unknown session action")
            self._audit_workout(workout, user_id, action)
            await self._async_save()
            return {"saved": True, "revision": workout.revision}

    async def async_review_training(
        self, user_id: str, request: dict, payload: dict, target_id: str | None = None
    ) -> dict:
        request = training.build_request(request)
        viewer = self.get_profile_by_user_id(user_id)
        target = self._target_profile(
            user_id,
            target_id,
            "manage_programs" if request["type"] == "program" else "coach_workouts",
        )
        if target is None:
            raise ValueError("Profile not found")
        if request["type"] == "program":
            request["answers"].setdefault("sequencing_policy", target.preferred_sequencing_policy)
        valid = training.validate_proposal(request["type"], payload, target, self.data)
        proposal = {
            "id": uuid.uuid4().hex,
            "profile_id": target.id,
            "viewer_profile_id": viewer.id,
            "type": request["type"],
            "request": request,
            "payload": valid,
            "created_at": now(),
            "accepted_id": None,
        }
        self.data.training_proposals.append(proposal)
        await self._async_save()
        return proposal

