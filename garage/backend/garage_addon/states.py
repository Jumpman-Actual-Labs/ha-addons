"""The panel's read model - a `hass.states`-shaped snapshot of the garage.

Under the integration, the panel read everything from the sensor entities'
attributes (scanning `hass.states` for the `garage_key`/`vehicle_id` marker
attributes - see the frontend's ha-api.ts). These functions build exactly
those same entity payloads straight from the coordinator's public data, so
the frontend's whole parsing layer carries over unchanged: web.py serves
the result at `api/states` and pushes a fresh one over `api/websocket` on
every change.

Each function here corresponds 1:1 to a sensor class in the integration's
old sensor.py - keep their attribute shapes in sync with what ha-api.ts
parses.
"""
from __future__ import annotations

from typing import Any

from .models import Vehicle

Entity = dict[str, Any]


def _entity(entity_id: str, state: Any, attributes: dict[str, Any]) -> Entity:
    # Home Assistant always stringifies state (None becomes "unknown") -
    # ha-api.ts parses state with that in mind, so mirror it.
    return {
        "entity_id": entity_id,
        "state": "unknown" if state is None else str(state),
        "attributes": attributes,
    }


# --------------------------------------------------------------- fixed sensors


def _summary_value(data: dict[str, Any], key: str, entity_id: str) -> Entity:
    return _entity(entity_id, round(data.get(key, 0), 2), {"garage_key": key})


def _vehicles_needing_attention(data: dict[str, Any]) -> Entity:
    ids = data.get("vehicles_needing_attention", [])
    return _entity(
        "sensor.garage_vehicles_needing_attention",
        len(ids),
        {"garage_key": "vehicles_needing_attention", "vehicle_ids": ids},
    )


def _settings(data: dict[str, Any]) -> Entity:
    settings = data.get("settings", {})
    return _entity(
        "sensor.garage_settings",
        "ok",
        {
            "garage_key": "settings",
            "low_fuel_threshold": settings.get("low_fuel_threshold"),
            "finance_sync_enabled": settings.get("finance_sync_enabled"),
            "finance_category_name": settings.get("finance_category_name", "Transportation"),
        },
    )


def _drivers(data: dict[str, Any]) -> Entity:
    drivers = data.get("drivers", [])
    return _entity(
        "sensor.garage_drivers",
        len(drivers),
        {"garage_key": "drivers", "drivers": [d.to_dict() for d in drivers]},
    )


def _maintenance_templates(data: dict[str, Any]) -> Entity:
    templates = data.get("maintenance_templates", [])
    return _entity(
        "sensor.garage_maintenance_templates",
        len(templates),
        {"garage_key": "maintenance_templates", "templates": [t.to_dict() for t in templates]},
    )


# ------------------------------------------------------------ per-vehicle sensor


def vehicle_summary_attributes(summary: dict[str, Any]) -> dict[str, Any]:
    """The vehicle's own fields plus its computed summary - everything the
    vehicle sensor carried except the per-vehicle history lists. Shared with
    mqtt.py, whose vehicle entities publish exactly this."""
    vehicle: Vehicle = summary["vehicle"]
    last_fuel = summary["last_fuel_entry"]
    last_maintenance = summary["last_maintenance_record"]
    return {
        "garage_key": "vehicle",
        "vehicle_id": vehicle.id,
        "nickname": vehicle.nickname,
        "year": vehicle.year,
        "make": vehicle.make,
        "model": vehicle.model,
        "trim": vehicle.trim,
        "drivetrain": vehicle.drivetrain,
        "status": vehicle.status,
        "current_mileage": vehicle.current_mileage,
        "current_fuel_pct": vehicle.current_fuel_pct,
        "fuel_type": vehicle.fuel_type,
        "vin": vehicle.vin,
        "license_plate": vehicle.license_plate,
        "title_number": vehicle.title_number,
        "color": vehicle.color,
        "tank_capacity_gal": vehicle.tank_capacity_gal,
        "oil_capacity_qt": vehicle.oil_capacity_qt,
        "tire_size": vehicle.tire_size,
        "notes": vehicle.notes,
        "photo_path": vehicle.photo_path,
        "primary_driver_id": vehicle.primary_driver_id,
        "additional_driver_ids": vehicle.additional_driver_ids,
        "odometer_entity_id": vehicle.odometer_entity_id,
        "fuel_level_entity_id": vehicle.fuel_level_entity_id,
        "registration_expires": vehicle.registration_expires,
        "insurance_expires": vehicle.insurance_expires,
        "health_score": summary["health_score"],
        "health_deductions": summary["health_deductions"],
        "average_mpg": summary["average_mpg"],
        "average_price_per_gallon": summary["average_price_per_gallon"],
        "estimated_range_miles": summary["estimated_range_miles"],
        "lifetime_fuel_cost": summary["lifetime_fuel_cost"],
        "lifetime_maintenance_cost": summary["lifetime_maintenance_cost"],
        "monthly_fuel_cost": summary["monthly_fuel_cost"],
        "monthly_maintenance_cost": summary["monthly_maintenance_cost"],
        "next_maintenance_due": summary["next_maintenance_due"],
        "maintenance_due_count": summary["maintenance_due_count"],
        "maintenance_due_soon_count": summary["maintenance_due_soon_count"],
        "last_fuel_date": last_fuel.date if last_fuel else None,
        "last_maintenance_date": last_maintenance.date if last_maintenance else None,
    }


def _vehicle_entity(data: dict[str, Any], vehicle: Vehicle) -> Entity:
    summary = data["vehicle_summaries"][vehicle.id]
    # Same order as the coordinator's *_for_vehicle helpers (date, then
    # odometer for fuel) - the panel relies on the last entry being newest.
    fuel_entries = sorted(
        (f for f in data.get("fuel_entries", []) if f.vehicle_id == vehicle.id),
        key=lambda f: (f.date, f.odometer),
    )
    records = sorted(
        (m for m in data.get("maintenance_records", []) if m.vehicle_id == vehicle.id),
        key=lambda m: m.date,
    )
    documents = [d for d in data.get("documents", []) if d.vehicle_id == vehicle.id]
    return _entity(
        f"sensor.garage_vehicle_{vehicle.id}",
        summary["health_score"],
        {
            **vehicle_summary_attributes(summary),
            "fuel_entries": [f.to_dict() for f in fuel_entries],
            "maintenance_records": [m.to_dict() for m in records],
            "documents": [d.to_dict() for d in documents],
            # Panel only (not MQTT): what the last poll of the vehicle's
            # linked sensors found - see obd.py.
            "live_sensors": data.get("live_status", {}).get(vehicle.id, {}),
        },
    )


# ------------------------------------------------------------------- snapshot


def build_states(data: dict[str, Any]) -> dict[str, Entity]:
    """Every entity the panel reads, keyed by entity_id like `hass.states`.
    A deleted vehicle simply isn't in here any more - unlike the
    integration, there's no stale "unavailable" entity left behind."""
    if not data:
        return {}
    entities = [
        _summary_value(data, "total_monthly_fuel_spend", "sensor.garage_monthly_fuel_spending"),
        _summary_value(
            data,
            "total_monthly_maintenance_spend",
            "sensor.garage_monthly_maintenance_spending",
        ),
        _vehicles_needing_attention(data),
        _settings(data),
        _drivers(data),
        _maintenance_templates(data),
    ]
    entities += [_vehicle_entity(data, v) for v in data.get("vehicles", [])]
    return {e["entity_id"]: e for e in entities}
