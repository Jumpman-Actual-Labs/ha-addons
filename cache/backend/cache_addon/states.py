"""The panel's read model - a `hass.states`-shaped snapshot of the
collection.

Under the integration, the panel read everything from the sensor entities'
attributes (scanning `hass.states` for the `cache_key`/`firearm_id`/... marker
attributes - see the frontend's ha-api.ts). These functions build exactly
those same entity payloads straight from the coordinator's public data, so
the frontend's whole parsing layer carries over unchanged: web.py serves
the result at `api/states` and pushes a fresh one over `api/websocket` on
every change.

Each `_fixed_*`/`_*_entity` function here corresponds 1:1 to a sensor class
in the integration's old sensor.py - keep their attribute shapes in sync with
what ha-api.ts parses.
"""
from __future__ import annotations

from typing import Any

from . import logic
from .models import Ammunition, Firearm, InventoryItem

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


def _dashboard_stats(data: dict[str, Any]) -> Entity:
    stats = dict(data.get("dashboard_stats", {}))
    stats["cache_key"] = "dashboard_stats"
    return _entity("sensor.cache_dashboard_stats", stats.get("total_firearms", 0), stats)


def _storage_locations(data: dict[str, Any]) -> Entity:
    firearms: list[Firearm] = data.get("firearms", [])
    items: list[InventoryItem] = data.get("inventory_items", [])
    locations = data.get("storage_locations", [])

    payload = []
    for loc in locations:
        firearm_count = sum(1 for f in firearms if f.storage_location_id == loc.id)
        item_count = sum(
            1 for i in items if i.storage_location_id == loc.id and i.installed_firearm_id is None
        )
        payload.append(
            {
                "id": loc.id,
                "name": loc.name,
                "description": loc.description,
                "created_at": loc.created_at,
                "firearm_count": firearm_count,
                "item_count": item_count,
            }
        )
    return _entity(
        "sensor.cache_storage_locations",
        len(locations),
        {"cache_key": "storage_locations", "locations": payload},
    )


def _settings(data: dict[str, Any]) -> Entity:
    settings = data.get("settings")
    return _entity(
        "sensor.cache_settings",
        settings.collection_name,
        {"cache_key": "settings", **settings.to_dict()},
    )


def _ammo_alert_rules(data: dict[str, Any]) -> Entity:
    rules = data.get("ammo_alert_rules", [])
    payload = [
        {
            "id": r.id,
            "match_type": r.match_type,
            "match_value": r.match_value,
            "threshold": r.threshold,
            "created_at": r.created_at,
        }
        for r in rules
    ]
    return _entity(
        "sensor.cache_ammo_alert_rules",
        len(rules),
        {"cache_key": "ammo_alert_rules", "rules": payload},
    )


def _range_sessions(data: dict[str, Any]) -> Entity:
    sessions = data.get("range_sessions", [])
    firearms_by_id = {f.id: f for f in data.get("firearms", [])}
    ammo_by_id = {a.id: a for a in data.get("ammunition", [])}

    payload = []
    for session in sessions:
        total_rounds = sum(f.rounds_fired for f in session.firearms)
        firearm_entries = []
        for entry in session.firearms:
            firearm = firearms_by_id.get(entry.firearm_id)
            ammo = ammo_by_id.get(entry.ammunition_id) if entry.ammunition_id else None
            firearm_entries.append(
                {
                    "firearm_id": entry.firearm_id,
                    "firearm_name": firearm.custom_name if firearm else None,
                    "ammunition_id": entry.ammunition_id,
                    "ammunition_label": (
                        f"{ammo.caliber} {ammo.bullet_weight or ''}".strip() if ammo else None
                    ),
                    "rounds_fired": entry.rounds_fired,
                }
            )
        payload.append(
            {
                "id": session.id,
                "date": session.date,
                "location": session.location,
                "notes": session.notes,
                "created_at": session.created_at,
                "created_by": session.created_by,
                "total_rounds": total_rounds,
                "firearms": firearm_entries,
            }
        )
    return _entity(
        "sensor.cache_range_sessions",
        len(sessions),
        {"cache_key": "range_sessions", "sessions": payload},
    )


def cleaning_due_items(data: dict[str, Any]) -> list[str]:
    firearms_by_id = {f.id: f for f in data.get("firearms", [])}
    ids = data.get("cleaning_due_firearm_ids", [])
    return [firearms_by_id[i].custom_name for i in ids if i in firearms_by_id]


def low_ammo_items(data: dict[str, Any]) -> list[str]:
    ammo_by_id = {a.id: a for a in data.get("ammunition", [])}
    ids = data.get("low_ammo_ids", [])
    return [
        f"{ammo_by_id[i].caliber} ({ammo_by_id[i].quantity} left)" for i in ids if i in ammo_by_id
    ]


def _due_labels(data: dict[str, Any], schedule_key: str, plan_key: str) -> list[str]:
    schedules_by_id = {s.id: s for s in data.get("range_schedules", [])}
    plans_by_id = {p.id: p for p in data.get("training_plans", [])}
    items = [schedules_by_id[i].label for i in data.get(schedule_key, []) if i in schedules_by_id]
    items += [plans_by_id[i].label for i in data.get(plan_key, []) if i in plans_by_id]
    return items


def training_due_items(data: dict[str, Any]) -> list[str]:
    return _due_labels(data, "range_schedules_due_ids", "training_plans_due_ids")


def training_ammo_alert_items(data: dict[str, Any]) -> list[str]:
    return _due_labels(data, "range_schedules_ammo_alert_ids", "training_plans_ammo_alert_ids")


def _cleaning_due_count(data: dict[str, Any]) -> Entity:
    return _entity(
        "sensor.cache_cleaning_due",
        len(data.get("cleaning_due_firearm_ids", [])),
        {
            "cache_key": "cleaning_due_count",
            "unit_of_measurement": "firearms",
            "items": cleaning_due_items(data),
        },
    )


def _low_ammo_count(data: dict[str, Any]) -> Entity:
    return _entity(
        "sensor.cache_low_ammunition",
        len(data.get("low_ammo_ids", [])),
        {
            "cache_key": "low_ammo_count",
            "unit_of_measurement": "calibers",
            "items": low_ammo_items(data),
        },
    )


def _range_schedules(data: dict[str, Any]) -> Entity:
    firearms = data.get("firearms", [])
    ammunition = data.get("ammunition", [])
    schedules = data.get("range_schedules", [])

    payload = []
    for schedule in schedules:
        matching = logic.range_schedule_matching_firearms(schedule, firearms)
        payload.append(
            {
                "id": schedule.id,
                "label": schedule.label,
                "targets": [t.to_dict() for t in schedule.targets],
                "frequency": schedule.frequency,
                "ammo_alert_enabled": schedule.ammo_alert_enabled,
                "active": schedule.active,
                "last_completed_date": schedule.last_completed_date,
                "next_due_date": logic.range_schedule_next_due_date(schedule),
                "is_due": logic.range_schedule_is_due(schedule),
                "ammo_ok": logic.range_schedule_ammo_ok(schedule, firearms, ammunition),
                "matching_firearm_names": [f.custom_name for f in matching],
                "matching_calibers": sorted(logic.range_schedule_calibers(schedule, firearms)),
                "notes": schedule.notes,
                "created_at": schedule.created_at,
                "updated_at": schedule.updated_at,
            }
        )
    return _entity(
        "sensor.cache_training_schedule",
        len(schedules),
        {"cache_key": "range_schedules", "schedules": payload},
    )


def _training_plans(data: dict[str, Any]) -> Entity:
    firearms = data.get("firearms", [])
    ammunition = data.get("ammunition", [])
    plans = data.get("training_plans", [])

    payload = []
    for plan in plans:
        current_index = logic.training_plan_current_step_index(plan)
        current_step = logic.training_plan_current_step(plan)
        steps_payload = []
        for i, step in enumerate(plan.steps):
            matching = logic.training_plan_step_matching_firearms(step, firearms)
            steps_payload.append(
                {
                    "id": step.id,
                    "label": step.label,
                    "targets": [t.to_dict() for t in step.targets],
                    "notes": step.notes,
                    "last_completed_date": step.last_completed_date,
                    "is_current": i == current_index,
                    "matching_firearm_names": [f.custom_name for f in matching],
                    "matching_calibers": sorted(logic.training_plan_step_calibers(step, firearms)),
                }
            )
        payload.append(
            {
                "id": plan.id,
                "label": plan.label,
                "mode": plan.mode,
                "start_month": plan.start_month,
                "start_year": plan.start_year,
                "current_step_index": current_index,
                "active": plan.active,
                "ammo_alert_enabled": plan.ammo_alert_enabled,
                "is_due": logic.training_plan_step_is_due(plan),
                "ammo_ok": (
                    logic.training_plan_step_ammo_ok(plan, current_step, firearms, ammunition)
                    if current_step
                    else None
                ),
                "notes": plan.notes,
                "steps": steps_payload,
                "created_at": plan.created_at,
                "updated_at": plan.updated_at,
            }
        )
    return _entity(
        "sensor.cache_training_plans",
        len(plans),
        {"cache_key": "training_plans", "plans": payload},
    )


def _training_due_count(data: dict[str, Any]) -> Entity:
    count = len(data.get("range_schedules_due_ids", [])) + len(
        data.get("training_plans_due_ids", [])
    )
    return _entity(
        "sensor.cache_training_due",
        count,
        {
            "cache_key": "training_due_count",
            "unit_of_measurement": "schedules",
            "items": training_due_items(data),
        },
    )


def _training_ammo_alert_count(data: dict[str, Any]) -> Entity:
    count = len(data.get("range_schedules_ammo_alert_ids", [])) + len(
        data.get("training_plans_ammo_alert_ids", [])
    )
    return _entity(
        "sensor.cache_training_ammo_alert",
        count,
        {
            "cache_key": "training_ammo_alert_count",
            "unit_of_measurement": "schedules",
            "items": training_ammo_alert_items(data),
        },
    )


# ------------------------------------------------------------- per-item sensors


def _firearm_entity(data: dict[str, Any], firearm: Firearm) -> Entity:
    settings = data.get("settings")
    inventory_items = data.get("inventory_items", [])
    locations = {s.id: s.name for s in data.get("storage_locations", [])}
    installed_items = [
        {
            "id": i.id,
            "custom_name": i.custom_name,
            "category": i.category,
            "part_type": i.part_type,
            "manufacturer": i.manufacturer,
            "model": i.model,
            "installed_slot_type": i.installed_slot_type,
            "is_wishlist": i.is_wishlist,
        }
        for i in inventory_items
        if i.installed_firearm_id == firearm.id
    ]
    fields = firearm.to_dict()
    fields.pop("photos", None)
    fields.pop("documents", None)
    fields.pop("cleaning_history", None)
    return _entity(
        f"sensor.cache_firearm_{firearm.id}",
        firearm.lifetime_round_count,
        {
            "firearm_id": firearm.id,
            "storage_location_name": locations.get(firearm.storage_location_id),
            "diagram_type": logic.diagram_type_for(firearm.firearm_type),
            "needs_cleaning": logic.needs_cleaning(firearm, settings),
            "effective_estimated_value": logic.firearm_effective_value(firearm, inventory_items),
            "installed_items": installed_items,
            "photos": [p.to_dict() for p in firearm.photos],
            "documents": [d.to_dict() for d in firearm.documents],
            "cleaning_history": [c.to_dict() for c in firearm.cleaning_history],
            **fields,
        },
    )


def _inventory_item_entity(data: dict[str, Any], item: InventoryItem) -> Entity:
    firearms_by_id = {f.id: f for f in data.get("firearms", [])}
    locations = {s.id: s.name for s in data.get("storage_locations", [])}
    installed_firearm = (
        firearms_by_id.get(item.installed_firearm_id) if item.installed_firearm_id else None
    )
    effective_location_id = logic.effective_location_id(item, firearms_by_id)

    fields = item.to_dict()
    fields.pop("photos", None)
    # part_type (e.g. "Optic Mount"), not category (e.g. "Optic") - the
    # more specific value is more useful at a glance than the coarser
    # grouping.
    return _entity(
        f"sensor.cache_inventory_item_{item.id}",
        item.part_type,
        {
            "inventory_item_id": item.id,
            "installed_firearm_name": installed_firearm.custom_name if installed_firearm else None,
            "effective_location_name": locations.get(effective_location_id),
            "photos": [p.to_dict() for p in item.photos],
            **fields,
        },
    )


def _ammunition_entity(data: dict[str, Any], ammo: Ammunition) -> Entity:
    settings = data.get("settings")
    rules = data.get("ammo_alert_rules", [])
    locations = {s.id: s.name for s in data.get("storage_locations", [])}
    fields = ammo.to_dict()
    fields.pop("transactions", None)
    return _entity(
        f"sensor.cache_ammunition_{ammo.id}",
        ammo.quantity,
        {
            "ammunition_id": ammo.id,
            "storage_location_name": locations.get(ammo.storage_location_id),
            "is_low": logic.is_ammo_low(ammo, settings, rules),
            "speed_class": logic.speed_class(ammo.muzzle_velocity),
            "transactions": [t.to_dict() for t in ammo.transactions[:20]],
            **fields,
        },
    )


# ------------------------------------------------------------------- snapshot


def build_states(data: dict[str, Any]) -> dict[str, Entity]:
    """Every entity the panel reads, keyed by entity_id like `hass.states`.
    A deleted firearm/item/ammo entry simply isn't in here any more - unlike
    the integration, there's no stale "unavailable" entity left behind."""
    entities = [
        _dashboard_stats(data),
        _storage_locations(data),
        _settings(data),
        _ammo_alert_rules(data),
        _range_sessions(data),
        _cleaning_due_count(data),
        _low_ammo_count(data),
        _range_schedules(data),
        _training_plans(data),
        _training_due_count(data),
        _training_ammo_alert_count(data),
    ]
    entities += [_firearm_entity(data, f) for f in data.get("firearms", [])]
    entities += [_inventory_item_entity(data, i) for i in data.get("inventory_items", [])]
    entities += [_ammunition_entity(data, a) for a in data.get("ammunition", [])]
    return {e["entity_id"]: e for e in entities}
