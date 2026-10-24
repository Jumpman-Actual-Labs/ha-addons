"""The only way to mutate state - one handler per former `gains.*` service,
called by the panel as `POST api/services/<name>` (see web.py) the same way
it used to call `gains.<name>` through Home Assistant. The schemas are
carried over from the integration unchanged (`validation.py` stands in for
HA's config_validation, imported as `cv`), so a field the panel sends that
isn't listed here fails with voluptuous's "extra keys not allowed".

Identity is the `user_id` web.py passes in: the Home Assistant user id
ingress put in the request's X-Remote-User-Id header - the add-on's
equivalent of the service call's context.user_id. Supervisor sets that
header itself for the authenticated session; the panel can't supply it.
A handler never trusts a client-supplied user/profile id for "whose data
is this."
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from math import isfinite
from typing import Any

import voluptuous as vol

from . import const
from . import validation as cv
from .const import (
    ACTIVITY_LEVELS,
    EFFORT_LEVELS,
    EXPERIENCE_LEVELS,
    REST_TIMER_OPTIONS,
    RUN_TYPES,
    SERVICE_AI_CHAT,
    SERVICE_COMPLETE_WORKOUT,
    SERVICE_CREATE_GYM_PROFILE,
    SERVICE_CREATE_RUN,
    SERVICE_CREATE_WORKOUT,
    SERVICE_DELETE_GYM_PROFILE,
    SERVICE_DELETE_WORKOUT,
    SERVICE_ENSURE_PROFILE,
    SERVICE_LINK_ACCOUNT,
    SERVICE_LOG_EXERCISE_EFFORT,
    SERVICE_LOG_RUN,
    SERVICE_LOG_SET,
    SERVICE_REMOVE_EXERCISE,
    SERVICE_REPLACE_EXERCISE,
    SERVICE_RESPOND_SHARE,
    SERVICE_SELECT_GYM_PROFILE,
    SERVICE_SHARE_PROGRAM,
    SERVICE_SHARE_RUN,
    SERVICE_SHARE_WORKOUT,
    SERVICE_SKIP_RUN,
    SERVICE_SKIP_WORKOUT,
    SERVICE_START_WORKOUT,
    SERVICE_UNLINK_ACCOUNT,
    SERVICE_UPDATE_GYM_PROFILE,
    SERVICE_UPDATE_PROFILE,
    UNITS,
)
from .coordinator import GainsCoordinator
from .equipment import EQUIPMENT_IDS
from .exercises import EXERCISE_IDS

_LOGGER = logging.getLogger(__name__)

ENSURE_PROFILE_SCHEMA = vol.Schema(
    {
        vol.Optional("display_name"): cv.string,
    }
)

UPDATE_PROFILE_SCHEMA = vol.Schema(
    {
        vol.Optional("display_name"): cv.string,
        vol.Optional("units"): vol.In(UNITS),
        vol.Optional("experience_level"): vol.In(EXPERIENCE_LEVELS),
        vol.Optional("activity_level"): vol.In(ACTIVITY_LEVELS),
        vol.Optional("preferred_sequencing_policy"): vol.In(["calendar", "completion"]),
        vol.Optional("preferred_duration_minutes"): vol.Coerce(int),
        vol.Optional("rest_timer_seconds"): vol.All(vol.Coerce(int), vol.In(REST_TIMER_OPTIONS)),
        vol.Optional("onboarding_complete"): cv.boolean,
        vol.Optional("bodyweight"): vol.All(vol.Coerce(float), vol.Range(min=1, max=2000)),
        vol.Optional("age"): vol.All(vol.Coerce(int), vol.Range(min=5, max=120)),
    }
)


def _valid_exercise_id(value: str) -> str:
    if value not in EXERCISE_IDS:
        raise vol.Invalid(f"Unknown exercise_id: {value}")
    return value


def _valid_equipment_config(value: object) -> dict[str, dict[str, object]]:
    """Validate per-equipment metadata separately from physical-unit weights."""
    if not isinstance(value, dict):
        raise vol.Invalid("equipment_config must be an object")

    result: dict[str, dict[str, object]] = {}
    for key, config in value.items():
        if key not in EQUIPMENT_IDS:
            raise vol.Invalid(f"Unknown equipment_id: {key}")
        if not isinstance(config, dict):
            raise vol.Invalid(f"{key} equipment config must be an object")

        parsed: dict[str, object] = {}
        load_type = config.get("load_type")
        if load_type is not None:
            if load_type not in {"plate_loaded", "weight_stack"}:
                raise vol.Invalid(f"Invalid load_type for {key}: {load_type}")
            parsed["load_type"] = load_type

        if "pulley_ratio" in config:
            try:
                pulley_ratio = float(config["pulley_ratio"])
            except (TypeError, ValueError) as err:
                raise vol.Invalid(f"Invalid pulley_ratio for {key}") from err
            if pulley_ratio <= 0 or pulley_ratio > 10:
                raise vol.Invalid(f"pulley_ratio for {key} must be > 0 and <= 10")
            parsed["pulley_ratio"] = pulley_ratio

        for field_name in (
            "stack_max", "stack_increment", "stack_min", "base_weight", "loading_points"
        ):
            if field_name not in config or config[field_name] is None:
                continue
            try:
                parsed_value = float(config[field_name])
            except (TypeError, ValueError) as err:
                raise vol.Invalid(f"Invalid {field_name} for {key}") from err
            if (
                not isfinite(parsed_value) or parsed_value < 0
                or (parsed_value == 0 and field_name not in {"base_weight", "stack_min"})
            ):
                raise vol.Invalid(f"{field_name} for {key} must be greater than 0")
            if field_name == "loading_points" and parsed_value not in {1, 2}:
                raise vol.Invalid("loading_points must be 1 or 2")
            parsed[field_name] = parsed_value

        result[key] = parsed
    return result


def _valid_equipment_dict(value: object) -> dict[str, list[float | None]]:
    """equipment is a dict of {equipment_id: [weight_or_null, ...]},
    wholesale replacing whatever a GymProfile had checked before -- every
    key must be a real equipment.EQUIPMENT_CATALOG id, and each value is a
    list with one entry per physical unit owned of that item (a gym can
    own more than one of the same item at different weights, e.g. two
    Short Bars)."""
    if not isinstance(value, dict):
        raise vol.Invalid("equipment must be an object of equipment_id -> [weight_or_null, ...]")
    result: dict[str, list[float | None]] = {}
    for key, weights in value.items():
        if key not in EQUIPMENT_IDS:
            raise vol.Invalid(f"Unknown equipment_id: {key}")
        if not isinstance(weights, list) or not weights:
            raise vol.Invalid(f"{key} must be a non-empty list of weights")
        parsed: list[float | None] = []
        for weight in weights:
            if weight is None:
                parsed.append(None)
                continue
            try:
                parsed.append(float(weight))
            except (TypeError, ValueError) as err:
                raise vol.Invalid(f"Invalid weight for {key}: {weight}") from err
        result[key] = parsed
    return result


WORKOUT_SET_SCHEMA = vol.Schema(
    {
        vol.Optional("reps"): vol.Coerce(int),
        vol.Optional("weight"): vol.Coerce(float),
        vol.Optional('set_type'): vol.In({'working', 'warmup'}),
    }
)

WORKOUT_EXERCISE_SCHEMA = vol.Schema(
    {
        vol.Required("exercise_id"): _valid_exercise_id,
        vol.Optional("sets", default=list): [WORKOUT_SET_SCHEMA],
        vol.Optional('rest_seconds'): vol.All(vol.Coerce(int), vol.Range(min=0, max=600)),
    }
)

CREATE_WORKOUT_SCHEMA = vol.Schema(
    {
        vol.Required("name"): cv.string,
        vol.Required("exercises"): [WORKOUT_EXERCISE_SCHEMA],
    }
)

WORKOUT_ID_SCHEMA = vol.Schema(
    {
        vol.Required("workout_id"): cv.string,
    }
)

LOG_SET_SCHEMA = vol.Schema(
    {
        vol.Required("workout_id"): cv.string,
        vol.Required("exercise_index"): vol.Coerce(int),
        vol.Required("set_index"): vol.Coerce(int),
        vol.Optional("reps"): vol.Coerce(int),
        vol.Optional("weight"): vol.Coerce(float),
    }
)

LOG_EXERCISE_EFFORT_SCHEMA = vol.Schema(
    {
        vol.Required("workout_id"): cv.string,
        vol.Required("exercise_index"): vol.Coerce(int),
        vol.Required("effort"): vol.In(EFFORT_LEVELS),
    }
)

REMOVE_EXERCISE_SCHEMA = vol.Schema(
    {
        vol.Required("workout_id"): cv.string,
        vol.Required("exercise_index"): vol.Coerce(int),
    }
)

REPLACE_EXERCISE_SCHEMA = vol.Schema(
    {
        vol.Required("workout_id"): cv.string,
        vol.Required("exercise_index"): vol.Coerce(int),
        vol.Required("new_exercise_id"): _valid_exercise_id,
    }
)

CREATE_RUN_SCHEMA = vol.Schema(
    {
        vol.Required("name"): cv.string,
        vol.Optional("run_type", default="easy"): vol.In(RUN_TYPES),
        vol.Optional("target_distance"): vol.Coerce(float),
        vol.Optional("target_duration_minutes"): vol.Coerce(int),
        vol.Optional("notes", default=""): cv.string,
    }
)

RUN_ID_SCHEMA = vol.Schema(
    {
        vol.Required("run_id"): cv.string,
    }
)

LOG_RUN_SCHEMA = vol.Schema(
    {
        vol.Required("run_id"): cv.string,
        vol.Optional("actual_distance"): vol.Coerce(float),
        vol.Optional("actual_duration_minutes"): vol.Coerce(int),
    }
)

CREATE_GYM_PROFILE_SCHEMA = vol.Schema(
    {
        vol.Required("name"): cv.string,
        vol.Optional("equipment", default=dict): _valid_equipment_dict,
        vol.Optional("equipment_config", default=dict): _valid_equipment_config,
    }
)

UPDATE_GYM_PROFILE_SCHEMA = vol.Schema(
    {
        vol.Required("gym_profile_id"): cv.string,
        vol.Optional("name"): cv.string,
        vol.Optional("equipment"): _valid_equipment_dict,
        vol.Optional("equipment_config"): _valid_equipment_config,
    }
)

GYM_PROFILE_ID_SCHEMA = vol.Schema(
    {
        vol.Required("gym_profile_id"): cv.string,
    }
)

SELECT_GYM_PROFILE_SCHEMA = vol.Schema(
    {
        # Omitted/None clears the athlete's selection (bodyweight-only).
        vol.Optional("gym_profile_id", default=None): vol.Any(None, cv.string),
    }
)

SHARE_WORKOUT_SCHEMA = vol.Schema(
    {
        vol.Required("workout_id"): cv.string,
        vol.Required("target_profile_id"): cv.string,
        # Coach mode only: the athlete being coached, on whose behalf the
        # share is offered. Deliberately not named target_profile_id --
        # that field already means "who receives the share."
        vol.Optional("acting_profile_id"): cv.string,
    }
)

SHARE_RUN_SCHEMA = vol.Schema(
    {
        vol.Required("run_id"): cv.string,
        vol.Required("target_profile_id"): cv.string,
        vol.Optional("acting_profile_id"): cv.string,
    }
)

SHARE_PROGRAM_SCHEMA = vol.Schema(
    {
        vol.Required("program_id"): cv.string,
        vol.Required("target_profile_id"): cv.string,
        vol.Optional("acting_profile_id"): cv.string,
    }
)

RESPOND_SHARE_SCHEMA = vol.Schema(
    {
        vol.Required("share_id"): cv.string,
        vol.Optional("acting_profile_id"): cv.string,
        vol.Required("accept"): cv.boolean,
    }
)

AI_CHAT_SCHEMA = vol.Schema(
    {
        vol.Required("message"): cv.string,
    }
)

LINK_ACCOUNT_SCHEMA = vol.Schema(
    {
        vol.Required("profile_id"): cv.string,
    }
)




class ServiceError(Exception):
    """Unknown service, invalid data, or a request the coordinator refused."""


Handler = Callable[[str, dict[str, Any]], Awaitable[Any]]
# Home Assistant user id -> account picture URL (ha_client.user_pictures).
PicturesSource = Callable[[], Awaitable[dict[str, str]]]


def build_handlers(
    coordinator: GainsCoordinator, pictures: PicturesSource | None = None
) -> dict[str, tuple[vol.Schema, Handler]]:
    """service name -> (schema, handler). Was `async_setup_services`'
    hass.services.async_register calls; every handler gets the caller's Home
    Assistant user id first (see the module docstring). `pictures` supplies
    account pictures for the Coach tab; without it there are none."""
    async def handle_ensure_profile(user_id: str, data: dict[str, Any]) -> None:
        display_name = data.get("display_name")
        await coordinator.async_ensure_profile(user_id, display_name)

    async def handle_update_profile(user_id: str, data: dict[str, Any]) -> None:
        fields = {k: v for k, v in data.items()}
        updated = await coordinator.async_update_profile(user_id, **fields)
        if updated is None:
            _LOGGER.warning(
                "gains.update_profile called before a profile exists for this user; "
                "call gains.ensure_profile first"
            )

    async def handle_create_workout(user_id: str, data: dict[str, Any]) -> None:
        workout = await coordinator.async_create_workout(
            user_id, data["name"], data["exercises"]
        )
        if workout is None:
            _LOGGER.warning(
                "gains.create_workout called before a profile exists for this user; "
                "call gains.ensure_profile first"
            )

    async def handle_start_workout(user_id: str, data: dict[str, Any]) -> None:
        result = await coordinator.async_start_workout(user_id, data["workout_id"])
        if result is None:
            _LOGGER.warning("gains.start_workout: no matching workout for this user")

    async def handle_log_set(user_id: str, data: dict[str, Any]) -> None:
        result = await coordinator.async_log_set(
            user_id,
            data["workout_id"],
            data["exercise_index"],
            data["set_index"],
            data.get("reps"),
            data.get("weight"),
        )
        if result is None:
            _LOGGER.warning("gains.log_set: no matching workout/exercise/set for this user")

    async def handle_log_exercise_effort(user_id: str, data: dict[str, Any]) -> None:
        result = await coordinator.async_log_exercise_effort(
            user_id,
            data["workout_id"],
            data["exercise_index"],
            data["effort"],
        )
        if result is None:
            _LOGGER.warning("gains.log_exercise_effort: no matching workout/exercise for this user")

    async def handle_remove_exercise(user_id: str, data: dict[str, Any]) -> None:
        result = await coordinator.async_remove_exercise(
            user_id, data["workout_id"], data["exercise_index"]
        )
        if result is None:
            _LOGGER.warning("gains.remove_exercise: no matching workout/exercise for this user")

    async def handle_replace_exercise(user_id: str, data: dict[str, Any]) -> None:
        result = await coordinator.async_replace_exercise(
            user_id,
            data["workout_id"],
            data["exercise_index"],
            data["new_exercise_id"],
        )
        if result is None:
            _LOGGER.warning("gains.replace_exercise: no matching workout/exercise for this user")

    async def handle_complete_workout(user_id: str, data: dict[str, Any]) -> None:
        result = await coordinator.async_complete_workout(user_id, data["workout_id"])
        if result is None:
            _LOGGER.warning("gains.complete_workout: no matching workout for this user")

    async def handle_skip_workout(user_id: str, data: dict[str, Any]) -> None:
        result = await coordinator.async_skip_workout(user_id, data["workout_id"])
        if result is None:
            _LOGGER.warning("gains.skip_workout: no matching workout for this user")

    async def handle_delete_workout(user_id: str, data: dict[str, Any]) -> None:
        deleted = await coordinator.async_delete_workout(user_id, data["workout_id"])
        if not deleted:
            _LOGGER.warning("gains.delete_workout: no matching workout for this user")

    async def handle_create_run(user_id: str, data: dict[str, Any]) -> None:
        run = await coordinator.async_create_run(
            user_id,
            data["name"],
            data["run_type"],
            data.get("target_distance"),
            data.get("target_duration_minutes"),
            data["notes"],
        )
        if run is None:
            _LOGGER.warning(
                "gains.create_run called before a profile exists for this user; "
                "call gains.ensure_profile first"
            )

    async def handle_log_run(user_id: str, data: dict[str, Any]) -> None:
        result = await coordinator.async_log_run(
            user_id,
            data["run_id"],
            data.get("actual_distance"),
            data.get("actual_duration_minutes"),
        )
        if result is None:
            _LOGGER.warning("gains.log_run: no matching run for this user")

    async def handle_skip_run(user_id: str, data: dict[str, Any]) -> None:
        result = await coordinator.async_skip_run(user_id, data["run_id"])
        if result is None:
            _LOGGER.warning("gains.skip_run: no matching run for this user")

    async def handle_create_gym_profile(user_id: str, data: dict[str, Any]) -> None:
        result = await coordinator.async_create_gym_profile(
            user_id,
            data["name"],
            data["equipment"],
            data["equipment_config"],
        )
        if result is None:
            _LOGGER.warning(
                "gains.create_gym_profile called before a profile exists for this user; "
                "call gains.ensure_profile first"
            )

    async def handle_update_gym_profile(user_id: str, data: dict[str, Any]) -> None:
        result = await coordinator.async_update_gym_profile(
            user_id,
            data["gym_profile_id"],
            data.get("name"),
            data.get("equipment"),
            data.get("equipment_config"),
        )
        if result is None:
            _LOGGER.warning("gains.update_gym_profile: no matching gym profile")

    async def handle_delete_gym_profile(user_id: str, data: dict[str, Any]) -> None:
        deleted = await coordinator.async_delete_gym_profile(user_id, data["gym_profile_id"])
        if not deleted:
            _LOGGER.warning("gains.delete_gym_profile: no matching gym profile")

    async def handle_select_gym_profile(user_id: str, data: dict[str, Any]) -> None:
        result = await coordinator.async_select_gym_profile(user_id, data["gym_profile_id"])
        if result is None:
            _LOGGER.warning(
                "gains.select_gym_profile: no profile for this user, or unknown gym_profile_id"
            )

    async def handle_share_workout(user_id: str, data: dict[str, Any]) -> None:
        result = await coordinator.async_share_workout(
            user_id,
            data["workout_id"],
            data["target_profile_id"],
            acting_profile_id=data.get("acting_profile_id"),
        )
        if result is None:
            _LOGGER.warning(
                "gains.share_workout: no matching workout, or target_profile_id doesn't exist"
            )

    async def handle_share_run(user_id: str, data: dict[str, Any]) -> None:
        result = await coordinator.async_share_run(
            user_id,
            data["run_id"],
            data["target_profile_id"],
            acting_profile_id=data.get("acting_profile_id"),
        )
        if result is None:
            _LOGGER.warning(
                "gains.share_run: no matching run, or target_profile_id doesn't exist"
            )

    async def handle_share_program(user_id: str, data: dict[str, Any]) -> None:
        result = await coordinator.async_share_program(
            user_id,
            data["program_id"],
            data["target_profile_id"],
            acting_profile_id=data.get("acting_profile_id"),
        )
        if result is None:
            _LOGGER.warning(
                "gains.share_program: no matching program, or target_profile_id doesn't exist"
            )

    async def handle_respond_share(user_id: str, data: dict[str, Any]) -> None:
        result = await coordinator.async_respond_share(
            user_id,
            data["share_id"],
            data["accept"],
            acting_profile_id=data.get("acting_profile_id"),
        )
        if result is None:
            _LOGGER.warning(
                "gains.respond_share: no matching pending share offered to this user"
            )

    async def handle_ai_chat(user_id: str, data: dict[str, Any]) -> None:
        result = await coordinator.async_ai_chat(user_id, data["message"])
        if result is None:
            _LOGGER.warning(
                "gains.ai_chat called before a profile exists for this user; "
                "call gains.ensure_profile first"
            )

    async def handle_link_account(user_id: str, data: dict[str, Any]) -> None:
        result = await coordinator.async_link_account(user_id, data["profile_id"])
        if result is None:
            _LOGGER.warning("gains.link_account: no matching profile to link")

    async def handle_unlink_account(user_id: str, data: dict[str, Any]) -> None:
        result = await coordinator.async_unlink_account(user_id, data["profile_id"])
        if result is None:
            _LOGGER.warning("gains.unlink_account called before a profile exists for this user")

    handlers: dict[str, tuple[vol.Schema, Handler]] = {
        SERVICE_ENSURE_PROFILE: (ENSURE_PROFILE_SCHEMA, handle_ensure_profile),
        SERVICE_UPDATE_PROFILE: (UPDATE_PROFILE_SCHEMA, handle_update_profile),
        SERVICE_CREATE_WORKOUT: (CREATE_WORKOUT_SCHEMA, handle_create_workout),
        SERVICE_START_WORKOUT: (WORKOUT_ID_SCHEMA, handle_start_workout),
        SERVICE_LOG_SET: (LOG_SET_SCHEMA, handle_log_set),
        SERVICE_LOG_EXERCISE_EFFORT: (LOG_EXERCISE_EFFORT_SCHEMA, handle_log_exercise_effort),
        SERVICE_REMOVE_EXERCISE: (REMOVE_EXERCISE_SCHEMA, handle_remove_exercise),
        SERVICE_REPLACE_EXERCISE: (REPLACE_EXERCISE_SCHEMA, handle_replace_exercise),
        SERVICE_COMPLETE_WORKOUT: (WORKOUT_ID_SCHEMA, handle_complete_workout),
        SERVICE_SKIP_WORKOUT: (WORKOUT_ID_SCHEMA, handle_skip_workout),
        SERVICE_DELETE_WORKOUT: (WORKOUT_ID_SCHEMA, handle_delete_workout),
        SERVICE_CREATE_RUN: (CREATE_RUN_SCHEMA, handle_create_run),
        SERVICE_LOG_RUN: (LOG_RUN_SCHEMA, handle_log_run),
        SERVICE_SKIP_RUN: (RUN_ID_SCHEMA, handle_skip_run),
        SERVICE_CREATE_GYM_PROFILE: (CREATE_GYM_PROFILE_SCHEMA, handle_create_gym_profile),
        SERVICE_UPDATE_GYM_PROFILE: (UPDATE_GYM_PROFILE_SCHEMA, handle_update_gym_profile),
        SERVICE_DELETE_GYM_PROFILE: (GYM_PROFILE_ID_SCHEMA, handle_delete_gym_profile),
        SERVICE_SELECT_GYM_PROFILE: (SELECT_GYM_PROFILE_SCHEMA, handle_select_gym_profile),
        SERVICE_AI_CHAT: (AI_CHAT_SCHEMA, handle_ai_chat),
        SERVICE_LINK_ACCOUNT: (LINK_ACCOUNT_SCHEMA, handle_link_account),
        SERVICE_UNLINK_ACCOUNT: (LINK_ACCOUNT_SCHEMA, handle_unlink_account),
        SERVICE_SHARE_WORKOUT: (SHARE_WORKOUT_SCHEMA, handle_share_workout),
        SERVICE_SHARE_RUN: (SHARE_RUN_SCHEMA, handle_share_run),
        SERVICE_SHARE_PROGRAM: (SHARE_PROGRAM_SCHEMA, handle_share_program),
        SERVICE_RESPOND_SHARE: (RESPOND_SHARE_SCHEMA, handle_respond_share),
    }
    if not const.RUNS_ENABLED:
        for name in (SERVICE_CREATE_RUN, SERVICE_LOG_RUN, SERVICE_SKIP_RUN, SERVICE_SHARE_RUN):
            del handlers[name]
    handlers.update(_training_handlers(coordinator, pictures))
    return handlers


def _training_handlers(
    coordinator: GainsCoordinator, pictures: PicturesSource | None
) -> dict[str, tuple[vol.Schema, Handler]]:
    """Response-only endpoints: snapshots are authorized instead of public sensor copies."""
    schema = vol.Schema(
        {
            vol.Optional("target_profile_id"): cv.string,
            vol.Optional("request", default=dict): dict,
            vol.Optional("fields", default=dict): dict,
            vol.Optional("action", default=""): cv.string,
            vol.Optional("id", default=""): cv.string,
        }
    )

    async def state(user_id: str, data: dict[str, Any]) -> dict:
        snapshot = await coordinator.async_training_state(
            user_id, data.get("target_profile_id")
        )
        # The Coach tab's athlete tiles show each person's Home Assistant
        # account picture, which only Home Assistant knows.
        by_user = await pictures() if pictures else {}
        for choice in snapshot.get("coachable_profiles", []):
            athlete = coordinator.get_profile(choice["profile_id"])
            choice["picture"] = by_user.get(athlete.ha_user_id) if athlete else None
        return snapshot

    async def build(user_id: str, data: dict[str, Any]) -> dict:
        return await coordinator.async_build_training(
            user_id, data["request"], data.get("target_profile_id")
        )

    async def review(user_id: str, data: dict[str, Any]) -> dict:
        return await coordinator.async_review_training(
            user_id,
            data["request"],
            data["fields"],
            data.get("target_profile_id"),
        )

    async def accept(user_id: str, data: dict[str, Any]) -> dict:
        return await coordinator.async_accept_training(
            user_id,
            data["id"],
            data["fields"],
            data.get("target_profile_id"),
        )

    async def program(user_id: str, data: dict[str, Any]) -> dict:
        return await coordinator.async_program_action(
            user_id,
            data["id"],
            data["action"],
            data["fields"],
            data.get("target_profile_id"),
        )

    async def session(user_id: str, data: dict[str, Any]) -> dict:
        return await coordinator.async_session_action(
            user_id,
            data.get("target_profile_id"),
            data["action"],
            data["fields"],
        )

    async def permissions(user_id: str, data: dict[str, Any]) -> dict:
        # The authenticated athlete grants access to their own data, never to a supplied target.
        return await coordinator.async_set_coach_permissions(
            user_id,
            data["id"],
            data["fields"].get("permissions", {}),
            data["fields"].get("role", "coach"),
        )

    async def joint(user_id: str, data: dict[str, Any]) -> dict:
        if data.get("target_profile_id"):
            raise ValueError("Workout Together is only available in your own account")
        if not hasattr(coordinator, "_training_lock"):
            import asyncio

            coordinator._training_lock = asyncio.Lock()
        async with coordinator._training_lock:
            return await coordinator.async_joint_action(
                user_id, data["action"], data["fields"]
            )

    async def geoffrey(user_id: str, data: dict[str, Any]) -> dict:
        result = await coordinator.async_ai_chat(
            user_id,
            data["fields"].get("message", ""),
            target_profile_id=data.get("target_profile_id"),
        )
        return result.to_dict() if result else {}

    async def progress(user_id: str, data: dict[str, Any]) -> dict:
        return await coordinator.async_progress_state(
            user_id, data.get("target_profile_id")
        )

    return {
        "training_state": (schema, state),
        "build_training": (schema, build),
        "accept_training": (schema, accept),
        "review_training": (schema, review),
        "program_action": (schema, program),
        "session_action": (schema, session),
        "joint_session_action": (schema, joint),
        "set_coach_permissions": (schema, permissions),
        "ask_geoffrey": (schema, geoffrey),
        "progress_state": (schema, progress),
    }


# The services that answer with data (HA's SupportsResponse.ONLY) - the rest
# answer with nothing, as they did through Home Assistant.
RESPONDS_WITH_DATA = frozenset(
    {
        "training_state",
        "build_training",
        "accept_training",
        "review_training",
        "program_action",
        "session_action",
        "joint_session_action",
        "set_coach_permissions",
        "ask_geoffrey",
        "progress_state",
    }
)


async def async_call_service(
    handlers: dict[str, tuple[vol.Schema, Handler]],
    name: str,
    user_id: str,
    data: dict[str, Any],
) -> Any:
    """Validates `data` against the service's schema (the same voluptuous
    schemas Home Assistant used to apply before calling the handler) and
    runs it as `user_id`. Unknown names, schema failures and the
    coordinator's own ValueErrors all raise ServiceError, so web.py reports
    every user-facing failure the same way."""
    entry = handlers.get(name)
    if entry is None:
        raise ServiceError(f"Unknown service: {name}")
    if not user_id:
        raise ServiceError("This service must be called by an authenticated Home Assistant user")
    schema, handler = entry
    try:
        validated = schema(data)
    except vol.Invalid as err:
        raise ServiceError(f"Invalid data for {name}: {err}") from err
    try:
        response = await handler(user_id, dict(validated))
    except ValueError as err:
        raise ServiceError(str(err)) from err
    return response if name in RESPONDS_WITH_DATA else None
