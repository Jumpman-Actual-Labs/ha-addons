"""Central state holder for the Cache add-on.

Push-based - state changes are made by the services (or the upload HTTP
views), each of which calls a mutation method here. Every mutation method
persists to storage and notifies listeners (the websocket state push and the
MQTT publisher) via `_async_save`.
"""
from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import date
from typing import Any

from . import logic
from .const import (
    AMMO_ALERT_RULE_MATCH_TYPES,
    AMMO_SPEED_CLASSES,
    AMMO_TRANSACTION_HISTORY_LIMIT,
    CATEGORY_FOR_PART,
    CLEANING_HISTORY_LIMIT,
    FIREARM_TYPES,
    INVENTORY_CATEGORIES,
    PART_TYPES,
    RANGE_SCHEDULE_FREQUENCIES,
    RANGE_SCHEDULE_TARGET_TYPES,
    RANGE_SESSION_HISTORY_LIMIT,
    TRAINING_PLAN_MODES,
    WISHLIST_PRIORITIES,
)
from .models import (
    AmmoAlertRule,
    AmmoTransaction,
    Ammunition,
    CacheSettings,
    CleaningLogEntry,
    Document,
    Firearm,
    InventoryItem,
    Photo,
    RangeSchedule,
    RangeScheduleTarget,
    RangeSession,
    RangeSessionFirearmEntry,
    StorageLocation,
    TrainingPlan,
    TrainingPlanStep,
    new_id,
    now_iso,
)
from .storage import CacheStore, default_data

_LOGGER = logging.getLogger(__name__)

_FIREARM_TYPES_SET = set(FIREARM_TYPES)
_INVENTORY_CATEGORIES_SET = set(INVENTORY_CATEGORIES)
_PART_TYPES_SET = set(PART_TYPES)
_RANGE_SCHEDULE_TARGET_TYPES_SET = set(RANGE_SCHEDULE_TARGET_TYPES)
_RANGE_SCHEDULE_FREQUENCIES_SET = set(RANGE_SCHEDULE_FREQUENCIES)
_AMMO_SPEED_CLASSES_SET = set(AMMO_SPEED_CLASSES)
_WISHLIST_PRIORITIES_SET = set(WISHLIST_PRIORITIES)
_TRAINING_PLAN_MODES_SET = set(TRAINING_PLAN_MODES)
_AMMO_ALERT_RULE_MATCH_TYPES_SET = set(AMMO_ALERT_RULE_MATCH_TYPES)


def _normalize(value: Any) -> Any:
    """HA service calls can't distinguish "field omitted" from "field
    explicitly null" (voluptuous rejects None for a present key), so the
    frontend's callCacheService() strips undefined/null before sending and
    uses "" as the sentinel for "clear this optional field" instead. Any key
    that does arrive here is meant to be applied - normalize "" to None so
    clearing actually clears rather than storing a literal empty string."""
    return None if value == "" else value


def _normalize_fields(fields: dict[str, Any]) -> dict[str, Any]:
    """Applies `_normalize` to every value in a service-call fields dict -
    every async_add_* method needs this on the way in, same as async_update_*
    already does per-field, or a blank optional field (e.g. an ammo entry's
    Low Inventory Threshold left empty) gets constructed straight into the
    dataclass as the literal string "" instead of None."""
    return {key: _normalize(value) for key, value in fields.items()}


def _validate_part_taxonomy(category: Any, part_type: Any) -> None:
    """category (coarse, e.g. "Optic") and part_type (specific, e.g. "Optic
    Mount") are both required, independently-validated fields on every
    InventoryItem - this also cross-checks that part_type actually belongs
    to category (via CATEGORY_FOR_PART), since a caller passing a
    correctly-spelled but mismatched pair (e.g. category="Barrel",
    part_type="Trigger") would otherwise silently store an inconsistent
    item rather than getting a clear rejection."""
    if category not in _INVENTORY_CATEGORIES_SET:
        raise CacheError("Invalid category")
    if part_type not in _PART_TYPES_SET:
        raise CacheError("Invalid part_type")
    if CATEGORY_FOR_PART[part_type] != category:
        raise CacheError(f"'{part_type}' is not a {category} part")


def _validate_wishlist_priority(value: Any) -> None:
    """wishlist_priority is optional (None means "not set", legitimate for
    a non-wishlist InventoryItem or a wishlist one that just hasn't been
    prioritized) - only reject it if it's set to something that isn't one
    of the real WISHLIST_PRIORITIES values. InventoryItem only now -
    Firearm replaced priority tiers with wishlist_rank (see
    CacheCoordinator._next_wishlist_firearm_rank/async_reorder_wishlist_
    firearms below)."""
    if value is not None and value not in _WISHLIST_PRIORITIES_SET:
        raise CacheError("Invalid wishlist_priority")


class CacheError(Exception):
    """Raised for user-facing validation failures (bad category match, not
    enough ammunition, duplicate location name, etc)."""


class ItemAlreadyInstalledError(CacheError):
    """Raised when installing an item that's already on a different firearm
    without confirm_move=True. The frontend catches this by message and
    offers a confirmation dialog before retrying with confirm_move=True."""


class CacheCoordinator:
    def __init__(self, store: CacheStore) -> None:
        self.store = store
        self.data: dict[str, Any] | None = None
        self._listeners: list[Callable[[], None]] = []
        self.settings: CacheSettings = CacheSettings()
        self.storage_locations: list[StorageLocation] = []
        self.firearms: list[Firearm] = []
        self.inventory_items: list[InventoryItem] = []
        self.ammunition: list[Ammunition] = []
        self.range_sessions: list[RangeSession] = []
        self.range_schedules: list[RangeSchedule] = []
        self.training_plans: list[TrainingPlan] = []
        self.ammo_alert_rules: list[AmmoAlertRule] = []

    # ----------------------------------------------------------- listeners --
    # Stands in for DataUpdateCoordinator's push API from the integration
    # days - same two method names, so everything below is unchanged.

    def async_add_listener(self, listener: Callable[[], None]) -> Callable[[], None]:
        self._listeners.append(listener)
        return lambda: self._listeners.remove(listener)

    def async_set_updated_data(self, data: dict[str, Any]) -> None:
        self.data = data
        for listener in list(self._listeners):
            try:
                listener()
            except Exception:  # one bad listener mustn't block the rest
                _LOGGER.exception("Cache listener failed")

    # ---------------------------------------------------------------- load --

    async def async_load(self) -> None:
        raw = await self.store.async_load()
        if raw is None:
            raw = default_data()
            await self.store.async_save(raw)

        self.settings = CacheSettings.from_dict(raw.get("settings", {}))
        self.storage_locations = [
            StorageLocation.from_dict(d) for d in raw.get("storage_locations", [])
        ]
        self.firearms = [Firearm.from_dict(d) for d in raw.get("firearms", [])]
        self.inventory_items = [InventoryItem.from_dict(d) for d in raw.get("inventory_items", [])]
        self.ammunition = [Ammunition.from_dict(d) for d in raw.get("ammunition", [])]
        self.range_sessions = [RangeSession.from_dict(d) for d in raw.get("range_sessions", [])]
        self.range_schedules = [
            RangeSchedule.from_dict(d) for d in raw.get("range_schedules", [])
        ]
        self.training_plans = [
            TrainingPlan.from_dict(d) for d in raw.get("training_plans", [])
        ]
        self.ammo_alert_rules = [
            AmmoAlertRule.from_dict(d) for d in raw.get("ammo_alert_rules", [])
        ]

        self.async_set_updated_data(self._build_public_data())

    # ---------------------------------------------------------------- save --

    async def _async_save(self) -> None:
        data = {
            "version": 1,
            "settings": self.settings.to_dict(),
            "storage_locations": [s.to_dict() for s in self.storage_locations],
            "firearms": [f.to_dict() for f in self.firearms],
            "inventory_items": [i.to_dict() for i in self.inventory_items],
            "ammunition": [a.to_dict() for a in self.ammunition],
            "range_sessions": [r.to_dict() for r in self.range_sessions],
            "range_schedules": [r.to_dict() for r in self.range_schedules],
            "training_plans": [p.to_dict() for p in self.training_plans],
            "ammo_alert_rules": [r.to_dict() for r in self.ammo_alert_rules],
        }
        await self.store.async_save(data)
        self.async_set_updated_data(self._build_public_data())

    def _build_public_data(self) -> dict[str, Any]:
        stats = logic.dashboard_stats(
            self.firearms, self.inventory_items, self.ammunition, self.settings
        )
        cleaning_due = logic.cleaning_due_firearms(self.firearms, self.settings)
        low_ammo = logic.low_ammo_entries(self.ammunition, self.settings, self.ammo_alert_rules)
        schedules_due = logic.range_schedules_due(self.range_schedules)
        schedules_ammo_alert = logic.range_schedules_with_ammo_alert(
            self.range_schedules, self.firearms, self.ammunition
        )
        plans_due = logic.training_plans_due(self.training_plans)
        plans_ammo_alert = logic.training_plans_with_ammo_alert(
            self.training_plans, self.firearms, self.ammunition
        )
        return {
            "settings": self.settings,
            "storage_locations": self.storage_locations,
            "firearms": self.firearms,
            "inventory_items": self.inventory_items,
            "ammunition": self.ammunition,
            "range_sessions": self.range_sessions[:RANGE_SESSION_HISTORY_LIMIT],
            "range_schedules": self.range_schedules,
            "training_plans": self.training_plans,
            "ammo_alert_rules": self.ammo_alert_rules,
            "dashboard_stats": stats,
            "cleaning_due_firearm_ids": [f.id for f in cleaning_due],
            "low_ammo_ids": [a.id for a in low_ammo],
            "range_schedules_due_ids": [s.id for s in schedules_due],
            "range_schedules_ammo_alert_ids": [s.id for s in schedules_ammo_alert],
            "training_plans_due_ids": [p.id for p in plans_due],
            "training_plans_ammo_alert_ids": [p.id for p in plans_ammo_alert],
        }

    # -------------------------------------------------------------- lookup --

    def _firearms_by_id(self) -> dict[str, Firearm]:
        return {f.id: f for f in self.firearms}

    def _get_firearm(self, firearm_id: str) -> Firearm:
        for f in self.firearms:
            if f.id == firearm_id:
                return f
        raise CacheError(f"Firearm {firearm_id} not found")

    def _find_firearm(self, firearm_id: str) -> Firearm | None:
        return next((f for f in self.firearms if f.id == firearm_id), None)

    def _get_inventory_item(self, item_id: str) -> InventoryItem:
        for i in self.inventory_items:
            if i.id == item_id:
                return i
        raise CacheError(f"Inventory item {item_id} not found")

    def _get_ammo(self, ammo_id: str) -> Ammunition:
        for a in self.ammunition:
            if a.id == ammo_id:
                return a
        raise CacheError(f"Ammunition {ammo_id} not found")

    def _get_storage_location(self, location_id: str) -> StorageLocation:
        for s in self.storage_locations:
            if s.id == location_id:
                return s
        raise CacheError(f"Storage location {location_id} not found")

    def _get_range_session(self, session_id: str) -> RangeSession:
        for s in self.range_sessions:
            if s.id == session_id:
                return s
        raise CacheError(f"Range session {session_id} not found")

    def _get_range_schedule(self, schedule_id: str) -> RangeSchedule:
        for s in self.range_schedules:
            if s.id == schedule_id:
                return s
        raise CacheError(f"Range schedule {schedule_id} not found")

    def _get_training_plan(self, plan_id: str) -> TrainingPlan:
        for p in self.training_plans:
            if p.id == plan_id:
                return p
        raise CacheError(f"Training plan {plan_id} not found")

    # ------------------------------------------------------ storage locations

    async def async_add_storage_location(
        self, name: str, description: str | None = None
    ) -> StorageLocation:
        if any(s.name == name for s in self.storage_locations):
            raise CacheError(f"A storage location named '{name}' already exists")
        location = StorageLocation(id=new_id(), name=name, description=description)
        self.storage_locations.append(location)
        await self._async_save()
        return location

    async def async_update_storage_location(
        self, location_id: str, name: str | None = None, description: str | None = None
    ) -> StorageLocation:
        location = self._get_storage_location(location_id)
        if name is not None:
            if any(s.name == name and s.id != location_id for s in self.storage_locations):
                raise CacheError(f"A storage location named '{name}' already exists")
            location.name = name
        if description is not None:
            location.description = description
        await self._async_save()
        return location

    async def async_delete_storage_location(self, location_id: str) -> None:
        self._get_storage_location(location_id)
        for f in self.firearms:
            if f.storage_location_id == location_id:
                f.storage_location_id = None
        for i in self.inventory_items:
            if i.storage_location_id == location_id:
                i.storage_location_id = None
        for a in self.ammunition:
            if a.storage_location_id == location_id:
                a.storage_location_id = None
        self.storage_locations = [s for s in self.storage_locations if s.id != location_id]
        await self._async_save()

    # ------------------------------------------------------------- firearms --

    def _next_wishlist_firearm_rank(self) -> int:
        ranks = [f.wishlist_rank for f in self.firearms if f.wishlist_rank is not None]
        return (max(ranks) + 1) if ranks else 0

    async def async_add_firearm(self, created_by: str | None = None, **fields: Any) -> Firearm:
        fields = _normalize_fields(fields)
        if fields.get("firearm_type") not in _FIREARM_TYPES_SET:
            raise CacheError("Invalid firearm type")
        if not fields.get("custom_name"):
            fields["custom_name"] = logic.default_firearm_name(
                fields.get("manufacturer"), fields.get("model"), fields.get("firearm_type")
            )
        firearm = Firearm(id=new_id(), created_by=created_by, **fields)
        if firearm.is_wishlist:
            firearm.wishlist_rank = self._next_wishlist_firearm_rank()
        self.firearms.append(firearm)
        await self._async_save()
        return firearm

    async def async_update_firearm(self, firearm_id: str, **fields: Any) -> Firearm:
        firearm = self._get_firearm(firearm_id)
        if "firearm_type" in fields and fields["firearm_type"] not in _FIREARM_TYPES_SET:
            raise CacheError("Invalid firearm type")
        was_wishlist = firearm.is_wishlist
        for key, value in fields.items():
            if key == "custom_name":
                normalized = _normalize(value)
                if not normalized:
                    normalized = logic.default_firearm_name(
                        fields.get("manufacturer", firearm.manufacturer),
                        fields.get("model", firearm.model),
                        fields.get("firearm_type", firearm.firearm_type),
                    )
                firearm.custom_name = normalized
                continue
            setattr(firearm, key, _normalize(value))
        # wishlist_rank isn't a settable field (not in FIREARM_FIELDS) - it
        # only changes here, automatically, on an is_wishlist transition:
        # newly wishlisted gets appended to the end of the current order,
        # un-wishlisted (e.g. "Mark as Purchased") clears it back to None
        # rather than leaving a stale rank behind on an owned firearm.
        if firearm.is_wishlist and not was_wishlist:
            firearm.wishlist_rank = self._next_wishlist_firearm_rank()
            firearm.acquired_at = None
        elif not firearm.is_wishlist and was_wishlist:
            firearm.wishlist_rank = None
            firearm.acquired_at = now_iso()
        firearm.updated_at = now_iso()
        await self._async_save()
        return firearm

    async def async_reorder_wishlist_firearms(self, firearm_ids: list[str]) -> None:
        """Saves the complete new drag-and-drop order in one call (rank =
        position in the given list) rather than per-item deltas - simpler
        and race-free compared to inserting/shifting individual ranks.
        Every id must be a real, currently-wishlisted firearm; anything
        else is rejected outright rather than silently skipped, since a
        stale id almost always means the frontend's list and the backend's
        state have drifted apart and the reorder shouldn't partially apply."""
        firearms_by_id = {f.id: f for f in self.firearms}
        for firearm_id in firearm_ids:
            firearm = firearms_by_id.get(firearm_id)
            if firearm is None or not firearm.is_wishlist:
                raise CacheError(f"'{firearm_id}' is not a wishlist firearm")
        now = now_iso()
        for index, firearm_id in enumerate(firearm_ids):
            firearm = firearms_by_id[firearm_id]
            firearm.wishlist_rank = index
            firearm.updated_at = now
        await self._async_save()

    async def async_delete_firearm(self, firearm_id: str) -> None:
        firearm = self._get_firearm(firearm_id)
        for item in self.inventory_items:
            if item.installed_firearm_id == firearm_id:
                item.installed_firearm_id = None
                item.installed_slot_type = None
                item.installed_at = None
                item.storage_location_id = firearm.storage_location_id
        self.firearms = [f for f in self.firearms if f.id != firearm_id]
        await self._async_save()

    async def async_add_rounds(
        self, firearm_id: str, rounds: int, fired_date: str | None = None
    ) -> Firearm:
        if rounds < 0:
            raise CacheError("Rounds must be non-negative")
        firearm = self._get_firearm(firearm_id)
        firearm.lifetime_round_count += rounds
        firearm.last_fired_date = fired_date or date.today().isoformat()
        firearm.updated_at = now_iso()
        await self._async_save()
        return firearm

    async def async_remove_rounds(self, firearm_id: str, rounds: int) -> Firearm:
        if rounds < 0:
            raise CacheError("Rounds must be non-negative")
        firearm = self._get_firearm(firearm_id)
        firearm.lifetime_round_count = max(0, firearm.lifetime_round_count - rounds)
        firearm.updated_at = now_iso()
        await self._async_save()
        return firearm

    async def async_mark_cleaned(
        self,
        firearm_id: str,
        cleaned_date: str,
        notes: str | None = None,
        created_by: str | None = None,
    ) -> CleaningLogEntry:
        firearm = self._get_firearm(firearm_id)
        entry = CleaningLogEntry(
            id=new_id(),
            cleaned_date=cleaned_date,
            round_count_at_cleaning=firearm.lifetime_round_count,
            notes=notes,
            created_by=created_by,
        )
        firearm.cleaning_history.insert(0, entry)
        del firearm.cleaning_history[CLEANING_HISTORY_LIMIT:]

        if firearm.last_cleaning_date is None or cleaned_date >= firearm.last_cleaning_date:
            firearm.last_cleaning_date = cleaned_date
            firearm.round_count_at_last_cleaning = firearm.lifetime_round_count
        firearm.updated_at = now_iso()
        await self._async_save()
        return entry

    # ------------------------------------------------------------ my build --

    async def async_install_item(
        self, firearm_id: str, item_id: str, slot_type: str, confirm_move: bool = False
    ) -> Firearm:
        firearm = self._get_firearm(firearm_id)
        item = self._get_inventory_item(item_id)
        try:
            logic.validate_install(item, slot_type)
        except ValueError as err:
            raise CacheError(str(err)) from err

        already_on_other_firearm = (
            item.installed_firearm_id and item.installed_firearm_id != firearm_id
        )
        if already_on_other_firearm and not confirm_move:
            other = self._firearms_by_id().get(item.installed_firearm_id)
            other_name = other.custom_name if other else "another firearm"
            raise ItemAlreadyInstalledError(
                f"'{item.custom_name}' is already installed on another firearm ({other_name}). "
                "Confirm to move it."
            )

        # Multiple items can share the same slot_type on the same firearm
        # (e.g. two Optics) - installing never evicts whatever's already
        # there. Removing a specific item is always by its own item_id
        # (see async_remove_item) rather than "whatever's in this slot",
        # which would be ambiguous once more than one item can occupy it.
        item.installed_firearm_id = firearm_id
        item.installed_slot_type = slot_type
        item.installed_at = now_iso()
        item.storage_location_id = None  # inherits from firearm while installed
        item.updated_at = now_iso()

        await self._async_save()
        return firearm

    async def async_remove_item(self, item_id: str, new_storage_location_id: str) -> InventoryItem:
        item = self._get_inventory_item(item_id)
        if item.installed_firearm_id is None:
            raise CacheError("Item is not currently installed")

        # A wishlist part installed via My Build has no physical location to
        # return to - it was never actually bought, just previewed on a
        # build (see logic.firearm_effective_value). Only an owned item is
        # required to name a real storage_location_id on removal; a
        # wishlist item may still be given one (e.g. if it's about to be
        # purchased), it just isn't forced to.
        if not item.is_wishlist and not new_storage_location_id:
            raise CacheError("A storage location is required when removing an item")
        if new_storage_location_id:
            self._get_storage_location(new_storage_location_id)
        item.storage_location_id = new_storage_location_id or None

        item.installed_firearm_id = None
        item.installed_slot_type = None
        item.installed_at = None
        item.updated_at = now_iso()

        await self._async_save()
        return item

    # ----------------------------------------------------------- inventory --

    async def async_add_inventory_item(self, **fields: Any) -> InventoryItem:
        fields = _normalize_fields(fields)
        _validate_part_taxonomy(fields.get("category"), fields.get("part_type"))
        _validate_wishlist_priority(fields.get("wishlist_priority"))
        if not fields.get("custom_name"):
            fields["custom_name"] = logic.default_item_name(
                fields.get("manufacturer"), fields.get("model"), fields.get("part_type")
            )
        item = InventoryItem(id=new_id(), **fields)
        self.inventory_items.append(item)
        await self._async_save()
        return item

    async def async_update_inventory_item(self, item_id: str, **fields: Any) -> InventoryItem:
        item = self._get_inventory_item(item_id)
        if "category" in fields or "part_type" in fields:
            _validate_part_taxonomy(
                fields.get("category", item.category), fields.get("part_type", item.part_type)
            )
        if "wishlist_priority" in fields:
            _validate_wishlist_priority(_normalize(fields["wishlist_priority"]))
        if (
            "storage_location_id" in fields
            and item.installed_firearm_id is not None
            and _normalize(fields["storage_location_id"]) != item.storage_location_id
        ):
            raise CacheError(
                "Item is installed on a firearm; remove it before changing storage location"
            )
        was_wishlist = item.is_wishlist
        for key, value in fields.items():
            if key == "custom_name":
                normalized = _normalize(value)
                if not normalized:
                    normalized = logic.default_item_name(
                        fields.get("manufacturer", item.manufacturer),
                        fields.get("model", item.model),
                        fields.get("part_type", item.part_type),
                    )
                item.custom_name = normalized
                continue
            setattr(item, key, _normalize(value))
        # Same transition bookkeeping as async_update_firearm's acquired_at.
        if item.is_wishlist and not was_wishlist:
            item.acquired_at = None
        elif not item.is_wishlist and was_wishlist:
            item.acquired_at = now_iso()
        item.updated_at = now_iso()
        await self._async_save()
        return item

    async def async_delete_inventory_item(self, item_id: str) -> None:
        self._get_inventory_item(item_id)
        self.inventory_items = [i for i in self.inventory_items if i.id != item_id]
        await self._async_save()

    # ---------------------------------------------------------- ammunition --

    async def async_add_ammunition(
        self, quantity: int = 0, created_by: str | None = None, **fields: Any
    ) -> Ammunition:
        fields = _normalize_fields(fields)
        fields["cost_per_round"] = logic.compute_cost_per_round(
            fields.get("cost_per_box"), fields.get("rounds_per_box")
        )
        ammo = Ammunition(id=new_id(), quantity=0, **fields)
        if quantity:
            ammo.transactions.insert(
                0,
                AmmoTransaction(
                    id=new_id(),
                    change_type="add",
                    quantity_delta=quantity,
                    resulting_quantity=quantity,
                    note="Initial stock",
                    created_by=created_by,
                ),
            )
            ammo.quantity = quantity
        self.ammunition.append(ammo)
        await self._async_save()
        return ammo

    async def async_update_ammunition(self, ammo_id: str, **fields: Any) -> Ammunition:
        ammo = self._get_ammo(ammo_id)
        fields = _normalize_fields(fields)
        if "cost_per_box" in fields or "rounds_per_box" in fields:
            fields["cost_per_round"] = logic.compute_cost_per_round(
                fields.get("cost_per_box", ammo.cost_per_box),
                fields.get("rounds_per_box", ammo.rounds_per_box),
            )
        for key, value in fields.items():
            setattr(ammo, key, value)
        ammo.updated_at = now_iso()
        await self._async_save()
        return ammo

    async def async_delete_ammunition(self, ammo_id: str) -> None:
        self._get_ammo(ammo_id)
        self.ammunition = [a for a in self.ammunition if a.id != ammo_id]
        await self._async_save()

    def _apply_ammo_delta(
        self,
        ammo: Ammunition,
        delta: int,
        change_type: str,
        note: str | None,
        created_by: str | None,
    ) -> None:
        new_qty = ammo.quantity + delta
        if new_qty < 0:
            raise CacheError("Resulting quantity cannot be negative")
        ammo.quantity = new_qty
        ammo.transactions.insert(
            0,
            AmmoTransaction(
                id=new_id(),
                change_type=change_type,
                quantity_delta=delta,
                resulting_quantity=new_qty,
                note=note,
                created_by=created_by,
            ),
        )
        del ammo.transactions[AMMO_TRANSACTION_HISTORY_LIMIT:]
        ammo.updated_at = now_iso()

    async def async_add_ammo_quantity(
        self,
        ammo_id: str,
        quantity_delta: int,
        note: str | None = None,
        created_by: str | None = None,
    ) -> Ammunition:
        if quantity_delta < 0:
            raise CacheError("Quantity to add must be positive")
        ammo = self._get_ammo(ammo_id)
        self._apply_ammo_delta(ammo, quantity_delta, "add", note, created_by)
        await self._async_save()
        return ammo

    async def async_remove_ammo_quantity(
        self,
        ammo_id: str,
        quantity_delta: int,
        note: str | None = None,
        created_by: str | None = None,
    ) -> Ammunition:
        if quantity_delta < 0:
            raise CacheError("Quantity to remove must be positive")
        ammo = self._get_ammo(ammo_id)
        self._apply_ammo_delta(ammo, -quantity_delta, "remove", note, created_by)
        await self._async_save()
        return ammo

    async def async_set_ammo_quantity(
        self, ammo_id: str, quantity: int, note: str | None = None, created_by: str | None = None
    ) -> Ammunition:
        if quantity < 0:
            raise CacheError("Quantity cannot be negative")
        ammo = self._get_ammo(ammo_id)
        delta = quantity - ammo.quantity
        self._apply_ammo_delta(ammo, delta, "adjust", note or "Manual adjustment", created_by)
        await self._async_save()
        return ammo

    # ------------------------------------------------------- range sessions

    async def async_log_range_session(
        self,
        date_: str,
        firearms: list[dict[str, Any]],
        location: str | None = None,
        notes: str | None = None,
        created_by: str | None = None,
    ) -> RangeSession:
        if not firearms:
            raise CacheError("At least one firearm is required")

        entries = [
            RangeSessionFirearmEntry(
                firearm_id=f["firearm_id"],
                rounds_fired=f.get("rounds_fired", 0),
                ammunition_id=f.get("ammunition_id"),
            )
            for f in firearms
        ]
        for entry in entries:
            self._get_firearm(entry.firearm_id)

        ammo_by_id = {a.id: a for a in self.ammunition}
        try:
            needed = logic.validate_range_session_ammo(entries, ammo_by_id)
        except ValueError as err:
            raise CacheError(str(err)) from err

        session = RangeSession(
            id=new_id(),
            date=date_,
            location=location,
            notes=notes,
            firearms=entries,
            created_by=created_by,
        )

        for entry in entries:
            firearm = self._get_firearm(entry.firearm_id)
            firearm.lifetime_round_count += entry.rounds_fired
            firearm.last_fired_date = date_
            firearm.updated_at = now_iso()

        # Any training schedule targeting one of these firearms (by exact
        # firearm or by its type) counts this session as completing it -
        # this is the only place last_completed_date ever changes.
        session_firearms = [self._get_firearm(e.firearm_id) for e in entries]
        for schedule in self.range_schedules:
            if not schedule.active:
                continue
            matched = any(
                logic.range_schedule_matches_firearm(schedule, f) for f in session_firearms
            )
            if matched and (
                schedule.last_completed_date is None or date_ > schedule.last_completed_date
            ):
                schedule.last_completed_date = date_
                schedule.updated_at = now_iso()

        # Same idea for training plans, but only against the CURRENT step -
        # a session doesn't complete a plan step that isn't up next.
        for plan in self.training_plans:
            if not plan.active:
                continue
            matched = any(logic.training_plan_matches_firearm(plan, f) for f in session_firearms)
            if matched:
                logic.training_plan_advance(plan, date_)
                plan.updated_at = now_iso()

        for ammo_id, qty in needed.items():
            ammo = ammo_by_id[ammo_id]
            self._apply_ammo_delta(
                ammo, -qty, "range_session", f"Range session on {date_}", created_by
            )
            ammo.transactions[0].range_session_id = session.id

        self.range_sessions.insert(0, session)
        del self.range_sessions[RANGE_SESSION_HISTORY_LIMIT:]

        await self._async_save()
        return session

    async def async_update_range_session(
        self,
        session_id: str,
        date_: str,
        firearms: list[dict[str, Any]],
        location: str | None = None,
        notes: str | None = None,
    ) -> RangeSession:
        """Unlike delete, editing a session's rounds/ammo does need to
        correct the side effects it already applied - re-derives them
        rather than leaving the original numbers in place. The old
        entries' rounds are subtracted back off each firearm and the old
        ammo usage (found by ammo_transactions' range_session_id tag) is
        returned to inventory *before* validating the new entries against
        stock, so e.g. editing "used 50 rounds" down to "used 30" of the
        same ammo doesn't spuriously fail for lack of stock. Schedule/
        training-plan "last completed" bumps are never un-bumped on edit,
        same as delete leaves them alone - only ever bumped forward, same
        as logging normally, so an edit can still (re)trigger completion
        but can't un-complete something a later session already satisfied.
        Note: ammo transaction history is a bounded ring buffer
        (AMMO_TRANSACTION_HISTORY_LIMIT) - if that ammo entry has logged
        200+ other transactions since this session, the original deduction
        may have already scrolled out of history and can't be found to
        reverse, same bounded-history limitation delete already has."""
        session = self._get_range_session(session_id)
        if not firearms:
            raise CacheError("At least one firearm is required")

        new_entries = [
            RangeSessionFirearmEntry(
                firearm_id=f["firearm_id"],
                rounds_fired=f.get("rounds_fired", 0),
                ammunition_id=f.get("ammunition_id"),
            )
            for f in firearms
        ]
        for entry in new_entries:
            self._get_firearm(entry.firearm_id)

        old_rounds_by_firearm: dict[str, int] = {}
        for entry in session.firearms:
            old_rounds_by_firearm[entry.firearm_id] = (
                old_rounds_by_firearm.get(entry.firearm_id, 0) + entry.rounds_fired
            )
        new_rounds_by_firearm: dict[str, int] = {}
        for entry in new_entries:
            new_rounds_by_firearm[entry.firearm_id] = (
                new_rounds_by_firearm.get(entry.firearm_id, 0) + entry.rounds_fired
            )

        # Tally what each ammo entry's old usage would return to stock
        # without touching anything yet, so a validation failure below
        # leaves state untouched rather than being caught mid-reversal.
        old_ammo_returns: dict[str, int] = {}
        for ammo in self.ammunition:
            returned = sum(
                -t.quantity_delta for t in ammo.transactions if t.range_session_id == session_id
            )
            if returned:
                old_ammo_returns[ammo.id] = returned

        ammo_by_id = {a.id: a for a in self.ammunition}
        try:
            needed = logic.validate_range_session_ammo(
                new_entries, ammo_by_id, extra_available=old_ammo_returns
            )
        except ValueError as err:
            raise CacheError(str(err)) from err

        for ammo_id in old_ammo_returns:
            ammo = ammo_by_id[ammo_id]
            for transaction in [
                t for t in ammo.transactions if t.range_session_id == session_id
            ]:
                self._apply_ammo_delta(
                    ammo,
                    -transaction.quantity_delta,
                    "adjust",
                    "Reversed for range session edit",
                    session.created_by,
                )
                # Clear the tag so a *second* edit of this same session
                # doesn't find this already-reversed transaction again and
                # return the same ammo twice.
                transaction.range_session_id = None

        for firearm_id in set(old_rounds_by_firearm) | set(new_rounds_by_firearm):
            firearm = self._find_firearm(firearm_id)
            if firearm is None:
                continue  # deleted since this session was logged - nothing to reverse
            delta = new_rounds_by_firearm.get(firearm_id, 0) - old_rounds_by_firearm.get(
                firearm_id, 0
            )
            firearm.lifetime_round_count = max(0, firearm.lifetime_round_count + delta)
            firearm.updated_at = now_iso()
        for entry in new_entries:
            self._get_firearm(entry.firearm_id).last_fired_date = date_

        session_firearms = [self._get_firearm(e.firearm_id) for e in new_entries]
        for schedule in self.range_schedules:
            if not schedule.active:
                continue
            matched = any(
                logic.range_schedule_matches_firearm(schedule, f) for f in session_firearms
            )
            if matched and (
                schedule.last_completed_date is None or date_ > schedule.last_completed_date
            ):
                schedule.last_completed_date = date_
                schedule.updated_at = now_iso()

        for plan in self.training_plans:
            if not plan.active:
                continue
            matched = any(logic.training_plan_matches_firearm(plan, f) for f in session_firearms)
            if matched:
                logic.training_plan_advance(plan, date_)
                plan.updated_at = now_iso()

        for ammo_id, qty in needed.items():
            ammo = ammo_by_id[ammo_id]
            self._apply_ammo_delta(
                ammo, -qty, "range_session", f"Range session on {date_}", session.created_by
            )
            ammo.transactions[0].range_session_id = session.id

        session.date = date_
        session.location = location
        session.notes = notes
        session.firearms = new_entries

        await self._async_save()
        return session

    async def async_delete_range_session(self, session_id: str) -> None:
        """Deletes the session record AND reverses the round-count/ammo
        side effects it applied when logged, same mechanism as editing
        (subtract the entries' rounds back off each firearm, return ammo
        tagged with this session's id and clear that tag) - a deleted
        session behaves as if it never happened for those two counters.
        A firearm deleted since this session was logged has nothing to
        reverse against and is skipped rather than erroring. Matching
        RangeSchedule/TrainingPlan "last completed" bumps are NOT
        un-bumped - see async_update_range_session's docstring for why
        (no safe way to tell whether a later session already
        re-satisfied it)."""
        session = self._get_range_session(session_id)

        for entry in session.firearms:
            firearm = self._find_firearm(entry.firearm_id)
            if firearm is None:
                continue
            firearm.lifetime_round_count = max(0, firearm.lifetime_round_count - entry.rounds_fired)
            firearm.updated_at = now_iso()

        for ammo in self.ammunition:
            for transaction in [
                t for t in ammo.transactions if t.range_session_id == session_id
            ]:
                self._apply_ammo_delta(
                    ammo,
                    -transaction.quantity_delta,
                    "adjust",
                    "Reversed for range session delete",
                    session.created_by,
                )
                transaction.range_session_id = None

        self.range_sessions = [s for s in self.range_sessions if s.id != session_id]
        await self._async_save()

    # ------------------------------------------------------- range schedule --

    def _validate_and_build_targets(self, raw_targets: Any) -> list[RangeScheduleTarget]:
        if not raw_targets:
            raise CacheError("At least one target is required")
        targets: list[RangeScheduleTarget] = []
        for raw in raw_targets:
            target_type = raw.get("target_type")
            firearm_id = _normalize(raw.get("firearm_id"))
            firearm_type = _normalize(raw.get("firearm_type"))
            caliber = _normalize(raw.get("caliber"))
            speed_class = _normalize(raw.get("speed_class"))
            bullet_type = _normalize(raw.get("bullet_type"))
            rounds_min = _normalize(raw.get("rounds_min"))
            if target_type not in _RANGE_SCHEDULE_TARGET_TYPES_SET:
                raise CacheError("Invalid target_type")
            if target_type == "firearm":
                if not firearm_id:
                    raise CacheError("firearm_id is required when target_type is 'firearm'")
                self._get_firearm(firearm_id)
            elif target_type == "firearm_type":
                if firearm_type not in _FIREARM_TYPES_SET:
                    raise CacheError("Invalid firearm_type")
            elif target_type == "caliber":
                if not caliber:
                    raise CacheError("caliber is required when target_type is 'caliber'")
            if speed_class is not None and speed_class not in _AMMO_SPEED_CLASSES_SET:
                raise CacheError("Invalid speed_class")
            targets.append(
                RangeScheduleTarget(
                    target_type=target_type,
                    firearm_id=firearm_id,
                    firearm_type=firearm_type,
                    caliber=caliber,
                    speed_class=speed_class,
                    bullet_type=bullet_type,
                    rounds_min=rounds_min,
                )
            )
        return targets

    async def async_add_range_schedule(self, **fields: Any) -> RangeSchedule:
        fields = _normalize_fields(fields)
        if fields.get("frequency") not in _RANGE_SCHEDULE_FREQUENCIES_SET:
            raise CacheError("Invalid frequency")
        targets = self._validate_and_build_targets(fields.pop("targets", None))
        if not fields.get("label"):
            firearms_by_id = {f.id: f for f in self.firearms}
            fields["label"] = logic.range_schedule_default_label(targets, firearms_by_id)
        schedule = RangeSchedule(id=new_id(), targets=targets, **fields)
        self.range_schedules.append(schedule)
        await self._async_save()
        return schedule

    async def async_update_range_schedule(self, schedule_id: str, **fields: Any) -> RangeSchedule:
        schedule = self._get_range_schedule(schedule_id)
        fields = _normalize_fields(fields)
        if "frequency" in fields and fields["frequency"] not in _RANGE_SCHEDULE_FREQUENCIES_SET:
            raise CacheError("Invalid frequency")
        if "targets" in fields:
            schedule.targets = self._validate_and_build_targets(fields.pop("targets"))
        for key, value in fields.items():
            setattr(schedule, key, value)
        schedule.updated_at = now_iso()
        await self._async_save()
        return schedule

    async def async_delete_range_schedule(self, schedule_id: str) -> None:
        self._get_range_schedule(schedule_id)
        self.range_schedules = [s for s in self.range_schedules if s.id != schedule_id]
        await self._async_save()

    # -------------------------------------------------------- training plan --

    def _validate_and_build_plan_steps(self, raw_steps: Any) -> list[TrainingPlanStep]:
        if not raw_steps:
            raise CacheError("At least one step is required")
        steps: list[TrainingPlanStep] = []
        for raw in raw_steps:
            label = _normalize(raw.get("label"))
            if not label:
                raise CacheError("Each step needs a label")
            targets = self._validate_and_build_targets(raw.get("targets"))
            steps.append(
                TrainingPlanStep(
                    id=new_id(),
                    label=label,
                    targets=targets,
                    notes=_normalize(raw.get("notes")),
                )
            )
        return steps

    def _validate_plan_mode(
        self, mode: str, start_month: Any, start_year: Any
    ) -> None:
        if mode not in _TRAINING_PLAN_MODES_SET:
            raise CacheError("Invalid mode")
        if mode == "calendar":
            month = _normalize(start_month)
            year = _normalize(start_year)
            if not month or not (1 <= int(month) <= 12):
                raise CacheError("start_month (1-12) is required for calendar-mode plans")
            if not year:
                raise CacheError("start_year is required for calendar-mode plans")

    async def async_add_training_plan(self, **fields: Any) -> TrainingPlan:
        fields = _normalize_fields(fields)
        steps = self._validate_and_build_plan_steps(fields.pop("steps", None))
        mode = fields.get("mode", "")
        self._validate_plan_mode(mode, fields.get("start_month"), fields.get("start_year"))
        if not fields.get("label"):
            extra = len(steps) - 1
            fields["label"] = f"{steps[0].label} + {extra} more" if extra else steps[0].label
        plan = TrainingPlan(id=new_id(), steps=steps, **fields)
        self.training_plans.append(plan)
        await self._async_save()
        return plan

    async def async_update_training_plan(self, plan_id: str, **fields: Any) -> TrainingPlan:
        plan = self._get_training_plan(plan_id)
        fields = _normalize_fields(fields)
        if "steps" in fields:
            plan.steps = self._validate_and_build_plan_steps(fields.pop("steps"))
        if "mode" in fields or "start_month" in fields or "start_year" in fields:
            self._validate_plan_mode(
                fields.get("mode", plan.mode),
                fields.get("start_month", plan.start_month),
                fields.get("start_year", plan.start_year),
            )
        for key, value in fields.items():
            setattr(plan, key, value)
        plan.updated_at = now_iso()
        await self._async_save()
        return plan

    async def async_delete_training_plan(self, plan_id: str) -> None:
        self._get_training_plan(plan_id)
        self.training_plans = [p for p in self.training_plans if p.id != plan_id]
        await self._async_save()

    async def async_advance_training_plan(
        self, plan_id: str, completed_date: str | None = None
    ) -> TrainingPlan:
        """Manually marks the plan's current step done without requiring a
        full Log Range Session - useful for a self-paced plan you just want
        to check off. In sequential mode this also advances to the next
        step; in calendar mode the "current step" is always computed fresh
        from today's date, so there's nothing to advance, just a
        last_completed_date to record."""
        plan = self._get_training_plan(plan_id)
        logic.training_plan_advance(plan, completed_date or date.today().isoformat())
        plan.updated_at = now_iso()
        await self._async_save()
        return plan

    # -------------------------------------------------------------- photos --

    async def async_add_photo(
        self, entity_type: str, entity_id: str, filename: str, original_filename: str | None = None
    ) -> Photo:
        photo = Photo(id=new_id(), filename=filename, original_filename=original_filename)
        if entity_type == "firearm":
            firearm = self._get_firearm(entity_id)
            is_first = not firearm.photos
            photo.is_primary = is_first
            firearm.photos.append(photo)
            if is_first:
                firearm.primary_photo_id = photo.id
            firearm.updated_at = now_iso()
        elif entity_type == "inventory_item":
            item = self._get_inventory_item(entity_id)
            item.photos.append(photo)
            item.updated_at = now_iso()
        else:
            raise CacheError("entity_type must be 'firearm' or 'inventory_item'")
        await self._async_save()
        return photo

    def _find_photo_owner(self, photo_id: str) -> tuple[str, Firearm | InventoryItem, Photo] | None:
        for firearm in self.firearms:
            for photo in firearm.photos:
                if photo.id == photo_id:
                    return "firearm", firearm, photo
        for item in self.inventory_items:
            for photo in item.photos:
                if photo.id == photo_id:
                    return "inventory_item", item, photo
        return None

    async def async_delete_photo(self, photo_id: str) -> str:
        """Returns the stored filename so the caller (http.py) can unlink it."""
        found = self._find_photo_owner(photo_id)
        if found is None:
            raise CacheError(f"Photo {photo_id} not found")
        entity_type, owner, photo = found
        owner.photos = [p for p in owner.photos if p.id != photo_id]
        if entity_type == "firearm" and photo.is_primary:
            owner.primary_photo_id = owner.photos[0].id if owner.photos else None
            if owner.photos:
                owner.photos[0].is_primary = True
        owner.updated_at = now_iso()
        await self._async_save()
        return photo.filename

    async def async_replace_photo_file(self, photo_id: str, new_filename: str) -> str:
        """Swaps a photo's stored file in place - e.g. after reprocessing it
        through AI background removal (see services.py's
        reprocess_firearm_photos) - while keeping its id/original_filename/
        is_primary/uploaded_at untouched. Returns the PREVIOUS filename so
        the caller can unlink the now-orphaned file, matching every other
        photo-replaces-photo pattern in this codebase."""
        found = self._find_photo_owner(photo_id)
        if found is None:
            raise CacheError(f"Photo {photo_id} not found")
        _entity_type, owner, photo = found
        previous = photo.filename
        photo.filename = new_filename
        owner.updated_at = now_iso()
        await self._async_save()
        return previous

    async def async_set_primary_photo(self, photo_id: str) -> None:
        found = self._find_photo_owner(photo_id)
        if found is None:
            raise CacheError(f"Photo {photo_id} not found")
        entity_type, owner, _photo = found
        if entity_type != "firearm":
            raise CacheError("Only firearm photos can be set as primary")
        for p in owner.photos:
            p.is_primary = p.id == photo_id
        owner.primary_photo_id = photo_id
        owner.updated_at = now_iso()
        await self._async_save()

    async def async_add_document(
        self,
        firearm_id: str,
        filename: str,
        document_type: str,
        original_filename: str | None = None,
    ) -> Document:
        firearm = self._get_firearm(firearm_id)
        doc = Document(
            id=new_id(),
            filename=filename,
            original_filename=original_filename,
            document_type=document_type,
        )
        firearm.documents.append(doc)
        firearm.updated_at = now_iso()
        await self._async_save()
        return doc

    async def async_delete_document(self, document_id: str) -> str:
        for firearm in self.firearms:
            for doc in firearm.documents:
                if doc.id == document_id:
                    firearm.documents = [d for d in firearm.documents if d.id != document_id]
                    firearm.updated_at = now_iso()
                    await self._async_save()
                    return doc.filename
        raise CacheError(f"Document {document_id} not found")

    # ------------------------------------------------------------ settings --

    async def async_update_settings(self, **fields: Any) -> CacheSettings:
        for key, value in fields.items():
            if value is not None:
                setattr(self.settings, key, value)
        await self._async_save()
        return self.settings

    async def async_set_diagram_reference_image(
        self, diagram_type: str, filename: str
    ) -> str | None:
        """Records the uploaded file as this diagram_type's reference image
        and returns the PREVIOUS filename (if any) so the caller (http.py's
        upload view) can delete the now-orphaned file from disk."""
        images = dict(self.settings.diagram_reference_images)
        previous = images.get(diagram_type)
        images[diagram_type] = filename
        self.settings.diagram_reference_images = images
        await self._async_save()
        return previous

    async def async_clear_diagram_reference_image(self, diagram_type: str) -> str | None:
        """Returns the removed filename (if any) so the caller can delete it
        from disk."""
        images = dict(self.settings.diagram_reference_images)
        previous = images.pop(diagram_type, None)
        self.settings.diagram_reference_images = images
        await self._async_save()
        return previous

    # ------------------------------------------------------ ammo alert rules

    def _get_ammo_alert_rule(self, rule_id: str) -> AmmoAlertRule:
        for r in self.ammo_alert_rules:
            if r.id == rule_id:
                return r
        raise CacheError(f"Ammo alert rule {rule_id} not found")

    async def async_add_ammo_alert_rule(
        self, match_type: str, match_value: str, threshold: int
    ) -> AmmoAlertRule:
        if match_type not in _AMMO_ALERT_RULE_MATCH_TYPES_SET:
            raise CacheError("Invalid match_type")
        if match_type == "speed_class" and match_value not in _AMMO_SPEED_CLASSES_SET:
            raise CacheError("Invalid speed_class match_value")
        if not match_value:
            raise CacheError("match_value is required")
        rule = AmmoAlertRule(
            id=new_id(), match_type=match_type, match_value=match_value, threshold=threshold
        )
        self.ammo_alert_rules.append(rule)
        await self._async_save()
        return rule

    async def async_update_ammo_alert_rule(self, rule_id: str, **fields: Any) -> AmmoAlertRule:
        rule = self._get_ammo_alert_rule(rule_id)
        fields = _normalize_fields(fields)
        match_type = fields.get("match_type", rule.match_type)
        if match_type not in _AMMO_ALERT_RULE_MATCH_TYPES_SET:
            raise CacheError("Invalid match_type")
        match_value = fields.get("match_value", rule.match_value)
        if match_type == "speed_class" and match_value not in _AMMO_SPEED_CLASSES_SET:
            raise CacheError("Invalid speed_class match_value")
        for key, value in fields.items():
            setattr(rule, key, value)
        await self._async_save()
        return rule

    async def async_delete_ammo_alert_rule(self, rule_id: str) -> None:
        self._get_ammo_alert_rule(rule_id)
        self.ammo_alert_rules = [r for r in self.ammo_alert_rules if r.id != rule_id]
        await self._async_save()

