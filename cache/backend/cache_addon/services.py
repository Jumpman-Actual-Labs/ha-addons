"""<verb>_<noun> services - one per coordinator mutation method, called by
the panel as `POST api/services/<name>` (see web.py) the same way it used to
call `cache.<name>` through Home Assistant.

Cache has no parent/child permission model like Hustle - every Home
Assistant user who can open the add-on's ingress panel can fully manage the
shared collection, so handlers here just take the acting user's display name
(from the ingress headers) for attribution (`created_by`) and call straight
through to the coordinator. Validation errors raised by the coordinator
(CacheError/ItemAlreadyInstalledError) surface directly to the caller.
"""
from __future__ import annotations

import asyncio
import logging
import mimetypes
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import aiohttp
import voluptuous as vol

from . import validation as cv
from .config import AddonConfig
from .coordinator import CacheCoordinator, CacheError
from .openai_client import OpenAIError, get_openai_api_key, remove_background

_LOGGER = logging.getLogger(__name__)

# A nullable numeric field: either coerced to a number, or the empty-string
# sentinel the frontend sends to mean "clear this field" (see coordinator.py's
# _normalize - voluptuous can't tell "omitted" from "null" for a present key).
_NULLABLE_FLOAT = vol.Any(vol.Coerce(float), "")
_NULLABLE_INT = vol.Any(vol.Coerce(int), "")
_STR = cv.string

FIREARM_FIELDS = {
    vol.Optional("manufacturer"): _STR,
    vol.Optional("model"): _STR,
    vol.Optional("serial_number"): _STR,
    vol.Optional("caliber"): _STR,
    vol.Optional("barrel_length"): _STR,
    vol.Optional("overall_length"): _STR,
    vol.Optional("weight"): _STR,
    vol.Optional("twist_rate"): _STR,
    vol.Optional("capacity"): _STR,
    vol.Optional("finish"): _STR,
    vol.Optional("color"): _STR,
    vol.Optional("condition"): _STR,
    vol.Optional("purchase_date"): _STR,
    vol.Optional("purchase_price"): _NULLABLE_FLOAT,
    vol.Optional("current_estimated_value"): _NULLABLE_FLOAT,
    vol.Optional("purchased_from"): _STR,
    vol.Optional("warranty_expiration"): _STR,
    vol.Optional("warranty_notes"): _STR,
    vol.Optional("product_url"): _STR,
    vol.Optional("uses"): cv.ensure_list,
    vol.Optional("storage_location_id"): _STR,
    vol.Optional("notes"): _STR,
    # No wishlist_priority here - Firearm replaced it with wishlist_rank,
    # which isn't a plain settable field (see coordinator.py's
    # async_add_firearm/async_update_firearm/async_reorder_wishlist_
    # firearms). InventoryItem still has wishlist_priority below.
    vol.Optional("is_wishlist"): cv.boolean,
    vol.Optional("is_nfa"): cv.boolean,
}

INVENTORY_ITEM_FIELDS = {
    vol.Optional("manufacturer"): _STR,
    vol.Optional("model"): _STR,
    vol.Optional("serial_number"): _STR,
    vol.Optional("purchase_date"): _STR,
    vol.Optional("purchase_price"): _NULLABLE_FLOAT,
    vol.Optional("estimated_value"): _NULLABLE_FLOAT,
    vol.Optional("condition"): _STR,
    vol.Optional("notes"): _STR,
    vol.Optional("storage_location_id"): _STR,
    vol.Optional("is_wishlist"): cv.boolean,
    vol.Optional("wishlist_priority"): _STR,
    vol.Optional("product_url"): _STR,
}

AMMUNITION_FIELDS = {
    vol.Optional("manufacturer"): _STR,
    vol.Optional("product_name"): _STR,
    vol.Optional("bullet_weight"): _STR,
    vol.Optional("bullet_type"): _STR,
    vol.Optional("muzzle_velocity"): _STR,
    vol.Optional("cost_per_box"): _NULLABLE_FLOAT,
    vol.Optional("rounds_per_box"): _NULLABLE_INT,
    vol.Optional("purchase_date"): _STR,
    vol.Optional("storage_location_id"): _STR,
    vol.Optional("notes"): _STR,
    vol.Optional("low_inventory_threshold"): _NULLABLE_INT,
}

RANGE_SESSION_FIREARM_ENTRY_SCHEMA = vol.Schema(
    {
        vol.Required("firearm_id"): _STR,
        vol.Required("rounds_fired"): vol.Coerce(int),
        vol.Optional("ammunition_id"): _STR,
    }
)

RANGE_SCHEDULE_TARGET_SCHEMA = vol.Schema(
    {
        vol.Required("target_type"): _STR,
        vol.Optional("firearm_id"): _STR,
        vol.Optional("firearm_type"): _STR,
        vol.Optional("caliber"): _STR,
        vol.Optional("speed_class"): _STR,
        vol.Optional("bullet_type"): _STR,
        vol.Optional("rounds_min"): _NULLABLE_INT,
    }
)

RANGE_SCHEDULE_FIELDS = {
    vol.Optional("label"): _STR,
    vol.Optional("ammo_alert_enabled"): cv.boolean,
    vol.Optional("active"): cv.boolean,
    vol.Optional("notes"): _STR,
}

TRAINING_PLAN_STEP_SCHEMA = vol.Schema(
    {
        vol.Required("label"): _STR,
        vol.Optional("targets"): vol.All(cv.ensure_list, [RANGE_SCHEDULE_TARGET_SCHEMA]),
        vol.Optional("notes"): _STR,
    }
)

TRAINING_PLAN_FIELDS = {
    vol.Optional("label"): _STR,
    vol.Optional("start_month"): _NULLABLE_INT,
    vol.Optional("start_year"): _NULLABLE_INT,
    vol.Optional("active"): cv.boolean,
    vol.Optional("ammo_alert_enabled"): cv.boolean,
    vol.Optional("notes"): _STR,
}

SERVICE_ADD_STORAGE_LOCATION = "add_storage_location"
SERVICE_UPDATE_STORAGE_LOCATION = "update_storage_location"
SERVICE_DELETE_STORAGE_LOCATION = "delete_storage_location"
SERVICE_ADD_FIREARM = "add_firearm"
SERVICE_UPDATE_FIREARM = "update_firearm"
SERVICE_DELETE_FIREARM = "delete_firearm"
SERVICE_REORDER_WISHLIST_FIREARMS = "reorder_wishlist_firearms"
SERVICE_ADD_ROUNDS = "add_rounds"
SERVICE_REMOVE_ROUNDS = "remove_rounds"
SERVICE_MARK_CLEANED = "mark_cleaned"
SERVICE_INSTALL_ITEM = "install_item"
SERVICE_REMOVE_ITEM = "remove_item"
SERVICE_ADD_INVENTORY_ITEM = "add_inventory_item"
SERVICE_UPDATE_INVENTORY_ITEM = "update_inventory_item"
SERVICE_DELETE_INVENTORY_ITEM = "delete_inventory_item"
SERVICE_ADD_AMMUNITION = "add_ammunition"
SERVICE_UPDATE_AMMUNITION = "update_ammunition"
SERVICE_DELETE_AMMUNITION = "delete_ammunition"
SERVICE_ADD_AMMO_QUANTITY = "add_ammo_quantity"
SERVICE_REMOVE_AMMO_QUANTITY = "remove_ammo_quantity"
SERVICE_SET_AMMO_QUANTITY = "set_ammo_quantity"
SERVICE_LOG_RANGE_SESSION = "log_range_session"
SERVICE_UPDATE_RANGE_SESSION = "update_range_session"
SERVICE_DELETE_RANGE_SESSION = "delete_range_session"
SERVICE_ADD_RANGE_SCHEDULE = "add_range_schedule"
SERVICE_UPDATE_RANGE_SCHEDULE = "update_range_schedule"
SERVICE_DELETE_RANGE_SCHEDULE = "delete_range_schedule"
SERVICE_ADD_AMMO_ALERT_RULE = "add_ammo_alert_rule"
SERVICE_UPDATE_AMMO_ALERT_RULE = "update_ammo_alert_rule"
SERVICE_DELETE_AMMO_ALERT_RULE = "delete_ammo_alert_rule"
SERVICE_ADD_TRAINING_PLAN = "add_training_plan"
SERVICE_UPDATE_TRAINING_PLAN = "update_training_plan"
SERVICE_DELETE_TRAINING_PLAN = "delete_training_plan"
SERVICE_ADVANCE_TRAINING_PLAN = "advance_training_plan"
SERVICE_DELETE_PHOTO = "delete_photo"
SERVICE_SET_PRIMARY_PHOTO = "set_primary_photo"
SERVICE_DELETE_DOCUMENT = "delete_document"
SERVICE_UPDATE_SETTINGS = "update_settings"
SERVICE_CLEAR_DIAGRAM_REFERENCE_IMAGE = "clear_diagram_reference_image"
SERVICE_REPROCESS_FIREARM_PHOTOS = "reprocess_firearm_photos"

SCHEMAS = {
    SERVICE_ADD_STORAGE_LOCATION: vol.Schema(
        {vol.Required("name"): _STR, vol.Optional("description"): _STR}
    ),
    SERVICE_UPDATE_STORAGE_LOCATION: vol.Schema(
        {
            vol.Required("location_id"): _STR,
            vol.Optional("name"): _STR,
            vol.Optional("description"): _STR,
        }
    ),
    SERVICE_DELETE_STORAGE_LOCATION: vol.Schema({vol.Required("location_id"): _STR}),
    SERVICE_ADD_FIREARM: vol.Schema(
        {
            vol.Optional("custom_name"): _STR,
            vol.Required("firearm_type"): _STR,
            **FIREARM_FIELDS,
        }
    ),
    SERVICE_UPDATE_FIREARM: vol.Schema(
        {
            vol.Required("firearm_id"): _STR,
            vol.Optional("custom_name"): _STR,
            vol.Optional("firearm_type"): _STR,
            **FIREARM_FIELDS,
        }
    ),
    SERVICE_DELETE_FIREARM: vol.Schema({vol.Required("firearm_id"): _STR}),
    SERVICE_REORDER_WISHLIST_FIREARMS: vol.Schema(
        {vol.Required("firearm_ids"): vol.All(cv.ensure_list, [_STR])}
    ),
    SERVICE_ADD_ROUNDS: vol.Schema(
        {
            vol.Required("firearm_id"): _STR,
            vol.Required("rounds"): vol.Coerce(int),
            vol.Optional("fired_date"): _STR,
        }
    ),
    SERVICE_REMOVE_ROUNDS: vol.Schema(
        {vol.Required("firearm_id"): _STR, vol.Required("rounds"): vol.Coerce(int)}
    ),
    SERVICE_MARK_CLEANED: vol.Schema(
        {
            vol.Required("firearm_id"): _STR,
            vol.Required("cleaned_date"): _STR,
            vol.Optional("notes"): _STR,
        }
    ),
    SERVICE_INSTALL_ITEM: vol.Schema(
        {
            vol.Required("firearm_id"): _STR,
            vol.Required("item_id"): _STR,
            vol.Required("slot_type"): _STR,
            vol.Optional("confirm_move", default=False): cv.boolean,
        }
    ),
    SERVICE_REMOVE_ITEM: vol.Schema(
        {
            vol.Required("item_id"): _STR,
            # Required for an owned item, but a wishlist item removed from
            # a preview build has no physical location to name - see
            # coordinator.async_remove_item.
            vol.Optional("new_storage_location_id"): _STR,
        }
    ),
    SERVICE_ADD_INVENTORY_ITEM: vol.Schema(
        {
            vol.Optional("custom_name"): _STR,
            vol.Required("category"): _STR,
            vol.Required("part_type"): _STR,
            **INVENTORY_ITEM_FIELDS,
        }
    ),
    SERVICE_UPDATE_INVENTORY_ITEM: vol.Schema(
        {
            vol.Required("item_id"): _STR,
            vol.Optional("custom_name"): _STR,
            vol.Optional("category"): _STR,
            vol.Optional("part_type"): _STR,
            **INVENTORY_ITEM_FIELDS,
        }
    ),
    SERVICE_DELETE_INVENTORY_ITEM: vol.Schema({vol.Required("item_id"): _STR}),
    SERVICE_ADD_AMMUNITION: vol.Schema(
        {
            vol.Required("caliber"): _STR,
            vol.Optional("quantity", default=0): vol.Coerce(int),
            **AMMUNITION_FIELDS,
        }
    ),
    SERVICE_UPDATE_AMMUNITION: vol.Schema(
        {vol.Required("ammo_id"): _STR, vol.Optional("caliber"): _STR, **AMMUNITION_FIELDS}
    ),
    SERVICE_DELETE_AMMUNITION: vol.Schema({vol.Required("ammo_id"): _STR}),
    SERVICE_ADD_AMMO_QUANTITY: vol.Schema(
        {
            vol.Required("ammo_id"): _STR,
            vol.Required("quantity_delta"): vol.Coerce(int),
            vol.Optional("note"): _STR,
        }
    ),
    SERVICE_REMOVE_AMMO_QUANTITY: vol.Schema(
        {
            vol.Required("ammo_id"): _STR,
            vol.Required("quantity_delta"): vol.Coerce(int),
            vol.Optional("note"): _STR,
        }
    ),
    SERVICE_SET_AMMO_QUANTITY: vol.Schema(
        {
            vol.Required("ammo_id"): _STR,
            vol.Required("quantity"): vol.Coerce(int),
            vol.Optional("note"): _STR,
        }
    ),
    SERVICE_LOG_RANGE_SESSION: vol.Schema(
        {
            vol.Required("date"): _STR,
            vol.Optional("location"): _STR,
            vol.Optional("notes"): _STR,
            vol.Required("firearms"): vol.All(cv.ensure_list, [RANGE_SESSION_FIREARM_ENTRY_SCHEMA]),
        }
    ),
    SERVICE_UPDATE_RANGE_SESSION: vol.Schema(
        {
            vol.Required("session_id"): _STR,
            vol.Required("date"): _STR,
            vol.Optional("location"): _STR,
            vol.Optional("notes"): _STR,
            vol.Required("firearms"): vol.All(cv.ensure_list, [RANGE_SESSION_FIREARM_ENTRY_SCHEMA]),
        }
    ),
    SERVICE_DELETE_RANGE_SESSION: vol.Schema({vol.Required("session_id"): _STR}),
    SERVICE_ADD_RANGE_SCHEDULE: vol.Schema(
        {
            vol.Required("targets"): vol.All(cv.ensure_list, [RANGE_SCHEDULE_TARGET_SCHEMA]),
            vol.Required("frequency"): _STR,
            **RANGE_SCHEDULE_FIELDS,
        }
    ),
    SERVICE_UPDATE_RANGE_SCHEDULE: vol.Schema(
        {
            vol.Required("schedule_id"): _STR,
            vol.Optional("targets"): vol.All(cv.ensure_list, [RANGE_SCHEDULE_TARGET_SCHEMA]),
            vol.Optional("frequency"): _STR,
            **RANGE_SCHEDULE_FIELDS,
        }
    ),
    SERVICE_DELETE_RANGE_SCHEDULE: vol.Schema({vol.Required("schedule_id"): _STR}),
    SERVICE_ADD_TRAINING_PLAN: vol.Schema(
        {
            vol.Required("mode"): _STR,
            vol.Required("steps"): vol.All(cv.ensure_list, [TRAINING_PLAN_STEP_SCHEMA]),
            **TRAINING_PLAN_FIELDS,
        }
    ),
    SERVICE_UPDATE_TRAINING_PLAN: vol.Schema(
        {
            vol.Required("plan_id"): _STR,
            vol.Optional("mode"): _STR,
            vol.Optional("steps"): vol.All(cv.ensure_list, [TRAINING_PLAN_STEP_SCHEMA]),
            **TRAINING_PLAN_FIELDS,
        }
    ),
    SERVICE_DELETE_TRAINING_PLAN: vol.Schema({vol.Required("plan_id"): _STR}),
    SERVICE_ADVANCE_TRAINING_PLAN: vol.Schema(
        {vol.Required("plan_id"): _STR, vol.Optional("completed_date"): _STR}
    ),
    SERVICE_DELETE_PHOTO: vol.Schema({vol.Required("photo_id"): _STR}),
    SERVICE_SET_PRIMARY_PHOTO: vol.Schema({vol.Required("photo_id"): _STR}),
    SERVICE_DELETE_DOCUMENT: vol.Schema({vol.Required("document_id"): _STR}),
    SERVICE_UPDATE_SETTINGS: vol.Schema(
        {
            vol.Optional("collection_name"): _STR,
            vol.Optional("low_ammo_threshold_default"): vol.Coerce(int),
            vol.Optional("cleaning_reminder_rounds"): vol.Coerce(int),
            vol.Optional("cleaning_reminder_days"): vol.Coerce(int),
            vol.Optional("cleaning_notifications_enabled"): cv.boolean,
            vol.Optional("low_ammo_notifications_enabled"): cv.boolean,
        }
    ),
    SERVICE_ADD_AMMO_ALERT_RULE: vol.Schema(
        {
            vol.Required("match_type"): _STR,
            vol.Required("match_value"): _STR,
            vol.Required("threshold"): vol.Coerce(int),
        }
    ),
    SERVICE_UPDATE_AMMO_ALERT_RULE: vol.Schema(
        {
            vol.Required("rule_id"): _STR,
            vol.Optional("match_type"): _STR,
            vol.Optional("match_value"): _STR,
            vol.Optional("threshold"): vol.Coerce(int),
        }
    ),
    SERVICE_DELETE_AMMO_ALERT_RULE: vol.Schema({vol.Required("rule_id"): _STR}),
    SERVICE_CLEAR_DIAGRAM_REFERENCE_IMAGE: vol.Schema({vol.Required("diagram_type"): _STR}),
    SERVICE_REPROCESS_FIREARM_PHOTOS: vol.Schema({vol.Optional("firearm_id"): _STR}),
}


@dataclass
class ServiceCall:
    data: dict[str, Any]
    actor: str | None = None


ServiceResponse = dict[str, Any] | None
Handler = Callable[[ServiceCall], Awaitable[ServiceResponse]]


@dataclass
class ServiceContext:
    coordinator: CacheCoordinator
    config: AddonConfig
    session: aiohttp.ClientSession
    handlers: dict[str, Handler] = field(default_factory=dict)


# add_firearm/add_inventory_item hand back the new record's id, so the
# panel can upload photos against it in the same Add form submission. Every
# other service returns nothing.
RESPONSE_SERVICES = {SERVICE_ADD_FIREARM, SERVICE_ADD_INVENTORY_ITEM}


async def _unlink_upload(config: AddonConfig, filename: str) -> None:
    path = config.uploads_dir / filename

    def _unlink() -> None:
        if path.is_file():
            path.unlink()

    await asyncio.to_thread(_unlink)


async def _read_upload_file(config: AddonConfig, filename: str) -> bytes | None:
    """Reads an already-stored upload's bytes back off disk - for
    reprocess_firearm_photos, which re-runs an EXISTING photo through
    background removal rather than a fresh upload. Returns None if the
    file is already missing (e.g. a store entry left over from before some
    earlier cleanup), so the caller can skip it rather than crash the rest
    of the batch."""
    path = config.uploads_dir / filename

    def _read() -> bytes | None:
        return path.read_bytes() if path.is_file() else None

    return await asyncio.to_thread(_read)


async def _write_upload_file(config: AddonConfig, filename: str, contents: bytes) -> None:
    path = config.uploads_dir / filename

    def _write() -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(contents)

    await asyncio.to_thread(_write)


def build_service_context(
    coordinator: CacheCoordinator, config: AddonConfig, session: aiohttp.ClientSession
) -> ServiceContext:
    ctx = ServiceContext(coordinator, config, session)

    async def handle_add_storage_location(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_add_storage_location(
            call.data["name"], call.data.get("description")
        )

    async def handle_update_storage_location(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        fields = {k: v for k, v in call.data.items() if k != "location_id"}
        await coordinator.async_update_storage_location(call.data["location_id"], **fields)

    async def handle_delete_storage_location(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_delete_storage_location(call.data["location_id"])

    async def handle_add_firearm(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        actor = call.actor
        firearm = await coordinator.async_add_firearm(created_by=actor, **dict(call.data))
        # supports_response=OPTIONAL: existing fire-and-forget callers are
        # unaffected, but a caller that wants the new id back (e.g. the
        # frontend uploading photos for a firearm right after creating it,
        # before any entity/state round-trip could tell it the id another
        # way) can call with return_response=true and read it here.
        return {"firearm_id": firearm.id}

    async def handle_update_firearm(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        fields = {k: v for k, v in call.data.items() if k != "firearm_id"}
        await coordinator.async_update_firearm(call.data["firearm_id"], **fields)

    async def handle_delete_firearm(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_delete_firearm(call.data["firearm_id"])

    async def handle_reorder_wishlist_firearms(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_reorder_wishlist_firearms(call.data["firearm_ids"])

    async def handle_add_rounds(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_add_rounds(
            call.data["firearm_id"], call.data["rounds"], call.data.get("fired_date")
        )

    async def handle_remove_rounds(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_remove_rounds(call.data["firearm_id"], call.data["rounds"])

    async def handle_mark_cleaned(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        actor = call.actor
        await coordinator.async_mark_cleaned(
            call.data["firearm_id"], call.data["cleaned_date"], call.data.get("notes"), actor
        )

    async def handle_install_item(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_install_item(
            call.data["firearm_id"],
            call.data["item_id"],
            call.data["slot_type"],
            call.data.get("confirm_move", False),
        )

    async def handle_remove_item(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_remove_item(
            call.data["item_id"], call.data.get("new_storage_location_id", "")
        )

    async def handle_add_inventory_item(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        item = await coordinator.async_add_inventory_item(**dict(call.data))
        # See handle_add_firearm's comment - same reasoning, so a caller
        # (e.g. the frontend uploading photos right after creating a part)
        # can get the new id back via return_response=true.
        return {"item_id": item.id}

    async def handle_update_inventory_item(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        fields = {k: v for k, v in call.data.items() if k != "item_id"}
        await coordinator.async_update_inventory_item(call.data["item_id"], **fields)

    async def handle_delete_inventory_item(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_delete_inventory_item(call.data["item_id"])

    async def handle_add_ammunition(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        actor = call.actor
        await coordinator.async_add_ammunition(created_by=actor, **dict(call.data))

    async def handle_update_ammunition(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        fields = {k: v for k, v in call.data.items() if k != "ammo_id"}
        await coordinator.async_update_ammunition(call.data["ammo_id"], **fields)

    async def handle_delete_ammunition(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_delete_ammunition(call.data["ammo_id"])

    async def handle_add_ammo_quantity(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        actor = call.actor
        await coordinator.async_add_ammo_quantity(
            call.data["ammo_id"], call.data["quantity_delta"], call.data.get("note"), actor
        )

    async def handle_remove_ammo_quantity(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        actor = call.actor
        await coordinator.async_remove_ammo_quantity(
            call.data["ammo_id"], call.data["quantity_delta"], call.data.get("note"), actor
        )

    async def handle_set_ammo_quantity(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        actor = call.actor
        await coordinator.async_set_ammo_quantity(
            call.data["ammo_id"], call.data["quantity"], call.data.get("note"), actor
        )

    async def handle_log_range_session(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        actor = call.actor
        await coordinator.async_log_range_session(
            call.data["date"],
            call.data["firearms"],
            call.data.get("location"),
            call.data.get("notes"),
            actor,
        )

    async def handle_update_range_session(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_update_range_session(
            call.data["session_id"],
            call.data["date"],
            call.data["firearms"],
            call.data.get("location"),
            call.data.get("notes"),
        )

    async def handle_delete_range_session(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_delete_range_session(call.data["session_id"])

    async def handle_add_range_schedule(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_add_range_schedule(**dict(call.data))

    async def handle_update_range_schedule(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        fields = {k: v for k, v in call.data.items() if k != "schedule_id"}
        await coordinator.async_update_range_schedule(call.data["schedule_id"], **fields)

    async def handle_delete_range_schedule(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_delete_range_schedule(call.data["schedule_id"])

    async def handle_add_training_plan(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_add_training_plan(**dict(call.data))

    async def handle_update_training_plan(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        fields = {k: v for k, v in call.data.items() if k != "plan_id"}
        await coordinator.async_update_training_plan(call.data["plan_id"], **fields)

    async def handle_delete_training_plan(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_delete_training_plan(call.data["plan_id"])

    async def handle_advance_training_plan(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_advance_training_plan(
            call.data["plan_id"], call.data.get("completed_date")
        )

    async def handle_delete_photo(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        filename = await coordinator.async_delete_photo(call.data["photo_id"])
        await _unlink_upload(ctx.config, filename)

    async def handle_set_primary_photo(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_set_primary_photo(call.data["photo_id"])

    async def handle_delete_document(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        filename = await coordinator.async_delete_document(call.data["document_id"])
        await _unlink_upload(ctx.config, filename)

    async def handle_update_settings(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_update_settings(**dict(call.data))

    async def handle_clear_diagram_reference_image(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        filename = await coordinator.async_clear_diagram_reference_image(call.data["diagram_type"])
        if filename:
            await _unlink_upload(ctx.config, filename)

    async def handle_reprocess_firearm_photos(call: ServiceCall) -> ServiceResponse:
        """One-off batch action: re-runs every already-uploaded firearm
        gallery photo (optionally scoped to one firearm) through OpenAI's
        background removal, same as a fresh upload now does (see http.py's
        CacheUploadPhotoView) - for photos uploaded before that behavior
        existed. Each photo costs one real OpenAI image-edit call and
        overwrites the stored file; there's no way to recover the original
        background afterward. A single photo's failure (a transient OpenAI
        error, a Store entry whose file already went missing) is logged and
        skipped rather than aborting the whole batch - one bad photo
        shouldn't undo everything already reprocessed before it. A missing
        API key fails the whole call upfront instead, since nothing in the
        batch could possibly succeed without one."""
        coordinator = ctx.coordinator
        api_key = await get_openai_api_key(ctx.config)
        if not api_key:
            raise CacheError(
                "OpenAI API key not configured. Add one under "
                "Settings > Add-ons > Cache > Configuration, or "
                "add an openai_api_key entry to secrets.yaml."
            )

        firearm_id = call.data.get("firearm_id")
        firearms = (
            [f for f in coordinator.firearms if f.id == firearm_id]
            if firearm_id
            else list(coordinator.firearms)
        )

        session = ctx.session
        for firearm in firearms:
            for photo in list(firearm.photos):
                image_bytes = await _read_upload_file(ctx.config, photo.filename)
                if image_bytes is None:
                    _LOGGER.warning(
                        "Skipping photo %s (firearm %s): file %s not found on disk",
                        photo.id,
                        firearm.id,
                        photo.filename,
                    )
                    continue
                content_type = mimetypes.guess_type(photo.filename)[0] or "image/jpeg"
                try:
                    processed_bytes = await remove_background(
                        session, api_key, image_bytes, content_type
                    )
                except OpenAIError as err:
                    _LOGGER.warning(
                        "Skipping photo %s (firearm %s): background removal failed: %s",
                        photo.id,
                        firearm.id,
                        err,
                    )
                    continue
                new_filename = f"{uuid.uuid4().hex}.png"
                await _write_upload_file(ctx.config, new_filename, processed_bytes)
                previous_filename = await coordinator.async_replace_photo_file(
                    photo.id, new_filename
                )
                await _unlink_upload(ctx.config, previous_filename)

    async def handle_add_ammo_alert_rule(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_add_ammo_alert_rule(
            call.data["match_type"], call.data["match_value"], call.data["threshold"]
        )

    async def handle_update_ammo_alert_rule(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        fields = {k: v for k, v in call.data.items() if k != "rule_id"}
        await coordinator.async_update_ammo_alert_rule(call.data["rule_id"], **fields)

    async def handle_delete_ammo_alert_rule(call: ServiceCall) -> ServiceResponse:
        coordinator = ctx.coordinator
        await coordinator.async_delete_ammo_alert_rule(call.data["rule_id"])

    handlers = {
        SERVICE_ADD_STORAGE_LOCATION: handle_add_storage_location,
        SERVICE_UPDATE_STORAGE_LOCATION: handle_update_storage_location,
        SERVICE_DELETE_STORAGE_LOCATION: handle_delete_storage_location,
        SERVICE_ADD_FIREARM: handle_add_firearm,
        SERVICE_UPDATE_FIREARM: handle_update_firearm,
        SERVICE_DELETE_FIREARM: handle_delete_firearm,
        SERVICE_REORDER_WISHLIST_FIREARMS: handle_reorder_wishlist_firearms,
        SERVICE_ADD_ROUNDS: handle_add_rounds,
        SERVICE_REMOVE_ROUNDS: handle_remove_rounds,
        SERVICE_MARK_CLEANED: handle_mark_cleaned,
        SERVICE_INSTALL_ITEM: handle_install_item,
        SERVICE_REMOVE_ITEM: handle_remove_item,
        SERVICE_ADD_INVENTORY_ITEM: handle_add_inventory_item,
        SERVICE_UPDATE_INVENTORY_ITEM: handle_update_inventory_item,
        SERVICE_DELETE_INVENTORY_ITEM: handle_delete_inventory_item,
        SERVICE_ADD_AMMUNITION: handle_add_ammunition,
        SERVICE_UPDATE_AMMUNITION: handle_update_ammunition,
        SERVICE_DELETE_AMMUNITION: handle_delete_ammunition,
        SERVICE_ADD_AMMO_QUANTITY: handle_add_ammo_quantity,
        SERVICE_REMOVE_AMMO_QUANTITY: handle_remove_ammo_quantity,
        SERVICE_SET_AMMO_QUANTITY: handle_set_ammo_quantity,
        SERVICE_LOG_RANGE_SESSION: handle_log_range_session,
        SERVICE_UPDATE_RANGE_SESSION: handle_update_range_session,
        SERVICE_DELETE_RANGE_SESSION: handle_delete_range_session,
        SERVICE_ADD_RANGE_SCHEDULE: handle_add_range_schedule,
        SERVICE_UPDATE_RANGE_SCHEDULE: handle_update_range_schedule,
        SERVICE_DELETE_RANGE_SCHEDULE: handle_delete_range_schedule,
        SERVICE_ADD_TRAINING_PLAN: handle_add_training_plan,
        SERVICE_UPDATE_TRAINING_PLAN: handle_update_training_plan,
        SERVICE_DELETE_TRAINING_PLAN: handle_delete_training_plan,
        SERVICE_ADVANCE_TRAINING_PLAN: handle_advance_training_plan,
        SERVICE_DELETE_PHOTO: handle_delete_photo,
        SERVICE_SET_PRIMARY_PHOTO: handle_set_primary_photo,
        SERVICE_DELETE_DOCUMENT: handle_delete_document,
        SERVICE_UPDATE_SETTINGS: handle_update_settings,
        SERVICE_CLEAR_DIAGRAM_REFERENCE_IMAGE: handle_clear_diagram_reference_image,
        SERVICE_REPROCESS_FIREARM_PHOTOS: handle_reprocess_firearm_photos,
        SERVICE_ADD_AMMO_ALERT_RULE: handle_add_ammo_alert_rule,
        SERVICE_UPDATE_AMMO_ALERT_RULE: handle_update_ammo_alert_rule,
        SERVICE_DELETE_AMMO_ALERT_RULE: handle_delete_ammo_alert_rule,
    }

    ctx.handlers = handlers
    return ctx


async def async_call_service(
    ctx: ServiceContext, name: str, data: dict[str, Any], actor: str | None = None
) -> ServiceResponse:
    """Validates `data` against the service's schema (the same voluptuous
    schemas Home Assistant used to apply before calling the handler) and
    runs it. Unknown service names and schema failures both raise
    CacheError, so web.py reports every user-facing failure the same way."""
    handler = ctx.handlers.get(name)
    if handler is None:
        raise CacheError(f"Unknown service: {name}")
    try:
        validated = SCHEMAS[name](data)
    except vol.Invalid as err:
        raise CacheError(f"Invalid data for {name}: {err}") from err
    response = await handler(ServiceCall(dict(validated), actor))
    return response if name in RESPONSE_SERVICES else None
