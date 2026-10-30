"""<verb>_<noun> services - one per coordinator mutation method, called by
the panel as `POST api/services/<name>` (see web.py) the same way it used to
call `garage.<name>` through Home Assistant. `SCHEMAS` is carried over from
the integration unchanged (`validation.py` stands in for HA's
config_validation, imported as `cv`), so a field the panel sends that isn't
listed here fails with voluptuous's "extra keys not allowed".
"""
from __future__ import annotations

import asyncio
import shutil
from collections.abc import Awaitable, Callable
from typing import Any

import voluptuous as vol

from . import validation as cv
from .config import AddonConfig
from .coordinator import GarageCoordinator


class ServiceError(Exception):
    """Unknown service, invalid data, or a mutation the coordinator refused."""


SERVICE_ADD_VEHICLE = "add_vehicle"
SERVICE_EDIT_VEHICLE = "edit_vehicle"
SERVICE_DELETE_VEHICLE = "delete_vehicle"
SERVICE_ADD_DRIVER = "add_driver"
SERVICE_EDIT_DRIVER = "edit_driver"
SERVICE_DELETE_DRIVER = "delete_driver"
SERVICE_LOG_FUEL = "log_fuel"
SERVICE_EDIT_FUEL_ENTRY = "edit_fuel_entry"
SERVICE_DELETE_FUEL_ENTRY = "delete_fuel_entry"
SERVICE_ADD_MAINTENANCE_TEMPLATE = "add_maintenance_template"
SERVICE_DELETE_MAINTENANCE_TEMPLATE = "delete_maintenance_template"
SERVICE_COMPLETE_MAINTENANCE = "complete_maintenance"
SERVICE_DELETE_MAINTENANCE_RECORD = "delete_maintenance_record"
SERVICE_DELETE_DOCUMENT = "delete_document"
SERVICE_UPDATE_SETTINGS = "update_settings"

SCHEMAS = {
    SERVICE_ADD_VEHICLE: vol.Schema(
        {
            vol.Required("nickname"): cv.string,
            vol.Required("year"): vol.Coerce(int),
            vol.Required("make"): cv.string,
            vol.Required("model"): cv.string,
            vol.Optional("trim", default=""): cv.string,
            vol.Optional("vin", default=""): cv.string,
            vol.Optional("license_plate", default=""): cv.string,
            vol.Optional("title_number", default=""): cv.string,
            vol.Optional("color", default=""): cv.string,
            vol.Optional("current_mileage", default=0): vol.Coerce(int),
            vol.Optional("fuel_type", default="gasoline"): cv.string,
            vol.Optional("tank_capacity_gal"): vol.Coerce(float),
            vol.Optional("oil_capacity_qt"): vol.Coerce(float),
            vol.Optional("tire_size", default=""): cv.string,
            vol.Optional("drivetrain", default="fwd"): cv.string,
            vol.Optional("notes", default=""): cv.string,
            vol.Optional("status", default="active"): cv.string,
            vol.Optional("current_fuel_pct"): vol.Coerce(float),
            vol.Optional("registration_expires"): vol.Any(cv.string, None),
            vol.Optional("insurance_expires"): vol.Any(cv.string, None),
            vol.Optional("primary_driver_id"): vol.Any(cv.string, None),
            vol.Optional("additional_driver_ids"): [cv.string],
            vol.Optional("odometer_entity_id"): cv.string,
            vol.Optional("fuel_level_entity_id"): cv.string,
        }
    ),
    SERVICE_EDIT_VEHICLE: vol.Schema(
        {
            vol.Required("vehicle_id"): cv.string,
            vol.Optional("nickname"): cv.string,
            vol.Optional("year"): vol.Coerce(int),
            vol.Optional("make"): cv.string,
            vol.Optional("model"): cv.string,
            vol.Optional("trim"): cv.string,
            vol.Optional("vin"): cv.string,
            vol.Optional("license_plate"): cv.string,
            vol.Optional("title_number"): cv.string,
            vol.Optional("color"): cv.string,
            vol.Optional("current_mileage"): vol.Coerce(int),
            vol.Optional("fuel_type"): cv.string,
            vol.Optional("tank_capacity_gal"): vol.Coerce(float),
            vol.Optional("oil_capacity_qt"): vol.Coerce(float),
            vol.Optional("tire_size"): cv.string,
            vol.Optional("drivetrain"): cv.string,
            vol.Optional("notes"): cv.string,
            vol.Optional("status"): cv.string,
            vol.Optional("current_fuel_pct"): vol.Coerce(float),
            vol.Optional("registration_expires"): vol.Any(cv.string, None),
            vol.Optional("insurance_expires"): vol.Any(cv.string, None),
            vol.Optional("primary_driver_id"): vol.Any(cv.string, None),
            vol.Optional("additional_driver_ids"): [cv.string],
            vol.Optional("odometer_entity_id"): cv.string,
            vol.Optional("fuel_level_entity_id"): cv.string,
        }
    ),
    SERVICE_DELETE_VEHICLE: vol.Schema({vol.Required("vehicle_id"): cv.string}),
    SERVICE_ADD_DRIVER: vol.Schema(
        {
            vol.Required("name"): cv.string,
            vol.Optional("ha_user_id"): cv.string,
            vol.Optional("notify_target"): cv.string,
        }
    ),
    SERVICE_EDIT_DRIVER: vol.Schema(
        {
            vol.Required("driver_id"): cv.string,
            vol.Optional("name"): cv.string,
            vol.Optional("ha_user_id"): cv.string,
            vol.Optional("notify_target"): cv.string,
        }
    ),
    SERVICE_DELETE_DRIVER: vol.Schema({vol.Required("driver_id"): cv.string}),
    SERVICE_LOG_FUEL: vol.Schema(
        {
            vol.Required("vehicle_id"): cv.string,
            vol.Required("date"): cv.string,
            vol.Required("odometer"): vol.Coerce(int),
            vol.Required("amount_dollars"): vol.Coerce(float),
            vol.Optional("fuel_grade", default="regular"): cv.string,
            vol.Optional("station", default=""): cv.string,
            vol.Optional("payment_method", default="credit_card"): cv.string,
            vol.Optional("full_tank", default=True): cv.boolean,
            vol.Optional("notes", default=""): cv.string,
            vol.Optional("price_per_gallon"): vol.Coerce(float),
            vol.Optional("gallons_added"): vol.Coerce(float),
        }
    ),
    SERVICE_EDIT_FUEL_ENTRY: vol.Schema(
        {
            vol.Required("entry_id"): cv.string,
            vol.Optional("date"): cv.string,
            vol.Optional("odometer"): vol.Coerce(int),
            vol.Optional("amount_dollars"): vol.Coerce(float),
            vol.Optional("fuel_grade"): cv.string,
            vol.Optional("station"): cv.string,
            vol.Optional("payment_method"): cv.string,
            vol.Optional("full_tank"): cv.boolean,
            vol.Optional("notes"): cv.string,
            vol.Optional("price_per_gallon"): vol.Coerce(float),
            vol.Optional("gallons_added"): vol.Coerce(float),
            vol.Optional("mpg"): vol.Coerce(float),
        }
    ),
    SERVICE_DELETE_FUEL_ENTRY: vol.Schema({vol.Required("entry_id"): cv.string}),
    SERVICE_ADD_MAINTENANCE_TEMPLATE: vol.Schema(
        {
            vol.Required("name"): cv.string,
            vol.Optional("basis", default="mileage"): cv.string,
            vol.Optional("interval_miles"): vol.Coerce(int),
            vol.Optional("interval_months"): vol.Coerce(int),
        }
    ),
    SERVICE_DELETE_MAINTENANCE_TEMPLATE: vol.Schema({vol.Required("template_id"): cv.string}),
    SERVICE_COMPLETE_MAINTENANCE: vol.Schema(
        {
            vol.Required("vehicle_id"): cv.string,
            vol.Required("name"): cv.string,
            vol.Required("date"): cv.string,
            vol.Required("odometer"): vol.Coerce(int),
            vol.Optional("template_id"): cv.string,
            vol.Optional("cost", default=0.0): vol.Coerce(float),
            vol.Optional("parts_cost", default=0.0): vol.Coerce(float),
            vol.Optional("labor_cost", default=0.0): vol.Coerce(float),
            vol.Optional("performed_by", default="shop"): cv.string,
            vol.Optional("shop_name", default=""): cv.string,
            vol.Optional("wheel_positions"): [cv.string],
            vol.Optional("notes", default=""): cv.string,
        }
    ),
    SERVICE_DELETE_MAINTENANCE_RECORD: vol.Schema({vol.Required("record_id"): cv.string}),
    SERVICE_DELETE_DOCUMENT: vol.Schema({vol.Required("document_id"): cv.string}),
    SERVICE_UPDATE_SETTINGS: vol.Schema(
        {
            vol.Optional("low_fuel_threshold"): vol.Coerce(float),
            vol.Optional("finance_sync_enabled"): cv.boolean,
            vol.Optional("finance_category_name"): cv.string,
        }
    ),
}


Handler = Callable[[dict[str, Any]], Awaitable[None]]


def upload_path(config: AddonConfig, url_path: str | None):
    """The file on disk behind a stored `uploads/...` URL path, or None for
    anything else (an empty path, or a leftover /local/ path the import
    couldn't map) - never anything outside the uploads dir."""
    if not url_path:
        return None
    relative = url_path.split("?", 1)[0].removeprefix("uploads/")
    if relative == url_path.split("?", 1)[0]:
        return None
    path = (config.uploads_dir / relative).resolve()
    if config.uploads_dir.resolve() not in path.parents:
        return None
    return path


def build_handlers(coordinator: GarageCoordinator, config: AddonConfig) -> dict[str, Handler]:
    async def handle_add_vehicle(data: dict[str, Any]) -> None:
        await coordinator.async_add_vehicle(**data)

    async def handle_edit_vehicle(data: dict[str, Any]) -> None:
        vehicle_id = data.pop("vehicle_id")
        await coordinator.async_edit_vehicle(vehicle_id, **data)

    async def handle_delete_vehicle(data: dict[str, Any]) -> None:
        vehicle_id = data["vehicle_id"]
        await coordinator.async_delete_vehicle(vehicle_id)

        def _remove_files() -> None:
            for kind in ("vehicles", "documents"):
                shutil.rmtree(config.uploads_dir / kind / vehicle_id, ignore_errors=True)

        await asyncio.to_thread(_remove_files)

    async def handle_add_driver(data: dict[str, Any]) -> None:
        await coordinator.async_add_driver(**data)

    async def handle_edit_driver(data: dict[str, Any]) -> None:
        driver_id = data.pop("driver_id")
        await coordinator.async_edit_driver(driver_id, **data)

    async def handle_delete_driver(data: dict[str, Any]) -> None:
        await coordinator.async_delete_driver(data["driver_id"])

    async def handle_log_fuel(data: dict[str, Any]) -> None:
        data["date_str"] = data.pop("date")
        await coordinator.async_add_fuel_entry(**data)

    async def handle_edit_fuel_entry(data: dict[str, Any]) -> None:
        entry_id = data.pop("entry_id")
        await coordinator.async_edit_fuel_entry(entry_id, **data)

    async def handle_delete_fuel_entry(data: dict[str, Any]) -> None:
        await coordinator.async_delete_fuel_entry(data["entry_id"])

    async def handle_add_maintenance_template(data: dict[str, Any]) -> None:
        await coordinator.async_add_maintenance_template(**data)

    async def handle_delete_maintenance_template(data: dict[str, Any]) -> None:
        await coordinator.async_delete_maintenance_template(data["template_id"])

    async def handle_complete_maintenance(data: dict[str, Any]) -> None:
        data["date_str"] = data.pop("date")
        await coordinator.async_add_maintenance_record(**data)

    async def handle_delete_maintenance_record(data: dict[str, Any]) -> None:
        await coordinator.async_delete_maintenance_record(data["record_id"])

    async def handle_delete_document(data: dict[str, Any]) -> None:
        removed = await coordinator.async_delete_document(data["document_id"])
        path = upload_path(config, removed.path if removed else None)
        if path is not None:
            await asyncio.to_thread(path.unlink, missing_ok=True)

    async def handle_update_settings(data: dict[str, Any]) -> None:
        await coordinator.async_update_settings(**data)

    return {
        SERVICE_ADD_VEHICLE: handle_add_vehicle,
        SERVICE_EDIT_VEHICLE: handle_edit_vehicle,
        SERVICE_DELETE_VEHICLE: handle_delete_vehicle,
        SERVICE_ADD_DRIVER: handle_add_driver,
        SERVICE_EDIT_DRIVER: handle_edit_driver,
        SERVICE_DELETE_DRIVER: handle_delete_driver,
        SERVICE_LOG_FUEL: handle_log_fuel,
        SERVICE_EDIT_FUEL_ENTRY: handle_edit_fuel_entry,
        SERVICE_DELETE_FUEL_ENTRY: handle_delete_fuel_entry,
        SERVICE_ADD_MAINTENANCE_TEMPLATE: handle_add_maintenance_template,
        SERVICE_DELETE_MAINTENANCE_TEMPLATE: handle_delete_maintenance_template,
        SERVICE_COMPLETE_MAINTENANCE: handle_complete_maintenance,
        SERVICE_DELETE_MAINTENANCE_RECORD: handle_delete_maintenance_record,
        SERVICE_DELETE_DOCUMENT: handle_delete_document,
        SERVICE_UPDATE_SETTINGS: handle_update_settings,
    }


async def async_call_service(
    handlers: dict[str, Handler], name: str, data: dict[str, Any]
) -> None:
    """Validates `data` against the service's schema (the same voluptuous
    schemas Home Assistant used to apply before calling the handler) and
    runs it. Unknown names, schema failures and the coordinator's own
    ValueErrors (unknown ids) all raise ServiceError, so web.py reports
    every user-facing failure the same way."""
    handler = handlers.get(name)
    if handler is None:
        raise ServiceError(f"Unknown service: {name}")
    try:
        validated = SCHEMAS[name](data)
    except vol.Invalid as err:
        raise ServiceError(f"Invalid data for {name}: {err}") from err
    try:
        await handler(dict(validated))
    except ValueError as err:
        raise ServiceError(str(err)) from err
