from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import date
from typing import Any

from .const import DEFAULT_MAINTENANCE_TEMPLATES
from .ha_client import HomeAssistantClient, HomeAssistantError
from .logic import (
    average_mpg,
    average_price_per_gallon,
    compute_fuel_entry_derived,
    compute_health_score,
    estimate_fuel_pct_after_partial_fill,
    estimated_range_miles,
    health_score_deductions,
    maintenance_due_status,
    spend_in_period,
    total_fuel_cost,
    total_maintenance_cost,
)
from .models import (
    Document,
    Driver,
    FuelEntry,
    MaintenanceRecord,
    MaintenanceTemplate,
    Vehicle,
    new_id,
)
from .stash_client import StashClient, StashError, StashUnavailable
from .storage import GarageStore, default_data

_LOGGER = logging.getLogger(__name__)


def _find_finance_category_id(states: list[dict[str, Any]], category_name: str) -> str | None:
    """Finance's own category_id is a generated UUID, not its display name -
    look it up by scanning for the category sensor with a matching name
    attribute rather than guessing an id. `states` is Core's `GET
    api/states` list.
    """
    target = category_name.strip().lower()
    for state in states:
        if not str(state.get("entity_id", "")).startswith("sensor."):
            continue
        attributes = state.get("attributes") or {}
        category_id = attributes.get("category_id")
        name = attributes.get("name")
        if category_id and name and str(name).strip().lower() == target:
            return str(category_id)
    return None


async def _async_finance_loaded(ha: HomeAssistantClient | None) -> bool:
    if ha is None:
        return False
    try:
        return "finance" in await ha.get_components()
    except HomeAssistantError:
        _LOGGER.warning("Finance sync skipped - Home Assistant unreachable", exc_info=True)
        return False


async def _async_stash_addon_call(
    stash: StashClient | None, service: str, data: dict[str, Any], category_name: str | None = None
) -> tuple[bool, dict[str, Any] | None]:
    """Tries the Stash add-on (see stash_client.py). Returns (handled,
    response): handled is False only when there's no Stash add-on to talk
    to, so the caller should fall back to the old integration. With
    `category_name`, looks the category up first and fills in `category_id`.
    Never raises, same reasoning as _async_sync_to_finance."""
    if stash is None:
        return False, None
    try:
        if category_name is not None:
            category_id = await stash.find_category_id(category_name)
            if category_id is None:
                _LOGGER.warning(
                    "Stash sync skipped - no Stash category named %r found", category_name
                )
                return True, None
            data = {**data, "category_id": category_id}
        return True, await stash.call_service(service, data)
    except StashUnavailable:
        return False, None
    except StashError:
        _LOGGER.warning("Stash %s failed", service, exc_info=True)
        return True, None


async def _async_sync_to_finance(
    ha: HomeAssistantClient | None,
    name: str,
    amount: float,
    vehicle_name: str,
    category_name: str,
    stash: StashClient | None = None,
) -> str | None:
    """Optional soft-dependency sync into Stash, if installed - the Stash
    add-on, or failing that the old Finance (Stash) integration. Never
    raises - Stash being absent or erroring must not block a fuel/
    maintenance log in Garage. Returns the created expense's id (so the
    caller can store it on the FuelEntry/MaintenanceRecord and later
    propagate an edit/delete), or None if the sync didn't happen for any
    reason.
    """
    expense = {
        "name": f"{name} - {vehicle_name}",
        "amount": amount,
        "expense_date": date.today().isoformat(),
    }
    handled, response = await _async_stash_addon_call(
        stash, "add_category_expense", expense, category_name
    )
    if handled:
        return (response or {}).get("expense_id")
    if not await _async_finance_loaded(ha):
        return None
    try:
        category_id = _find_finance_category_id(await ha.get_states(), category_name)
        if category_id is None:
            _LOGGER.warning(
                "Finance sync skipped - no Finance category named %r found", category_name
            )
            return None
        response = await ha.call_service(
            "finance",
            "add_category_expense",
            {"category_id": category_id, **expense},
            return_response=True,
        )
    except HomeAssistantError:
        _LOGGER.warning("Failed to sync %s to Finance", name, exc_info=True)
        return None
    return (response or {}).get("expense_id")


async def _async_edit_finance_expense(
    ha: HomeAssistantClient | None,
    expense_id: str,
    stash: StashClient | None = None,
    **fields: Any,
) -> None:
    """Best-effort propagation of a Garage-side edit to the linked Stash
    expense - never raises, same reasoning as _async_sync_to_finance.
    """
    data = {"expense_id": expense_id, **fields}
    handled, _ = await _async_stash_addon_call(stash, "edit_category_expense", data)
    if handled or not await _async_finance_loaded(ha):
        return
    try:
        await ha.call_service("finance", "edit_category_expense", data)
    except HomeAssistantError:
        _LOGGER.warning("Failed to update linked Finance expense %s", expense_id, exc_info=True)


async def _async_delete_finance_expense(
    ha: HomeAssistantClient | None, expense_id: str, stash: StashClient | None = None
) -> None:
    """Best-effort propagation of a Garage-side delete to the linked Stash
    expense - never raises, same reasoning as _async_sync_to_finance.
    """
    data = {"expense_id": expense_id}
    handled, _ = await _async_stash_addon_call(stash, "delete_category_expense", data)
    if handled or not await _async_finance_loaded(ha):
        return
    try:
        await ha.call_service("finance", "delete_category_expense", data)
    except HomeAssistantError:
        _LOGGER.warning("Failed to delete linked Finance expense %s", expense_id, exc_info=True)


class GarageCoordinator:
    """Central state holder for Garage.

    Not polling-based - state changes are pushed in by services.py calling
    the mutation methods below, each of which persists to storage and
    notifies listeners (web.py's websocket push and mqtt.py's publisher).
    `ha` and `stash` are None when running outside Supervisor - Stash sync
    is then simply skipped.
    """

    def __init__(
        self,
        store: GarageStore,
        ha: HomeAssistantClient | None = None,
        stash: StashClient | None = None,
    ) -> None:
        self.ha = ha
        self.stash = stash
        self.data: dict[str, Any] | None = None
        self._listeners: list[Callable[[], None]] = []
        self.store = store
        self.vehicles: list[Vehicle] = []
        self.drivers: list[Driver] = []
        self.fuel_entries: list[FuelEntry] = []
        self.maintenance_templates: list[MaintenanceTemplate] = []
        self.maintenance_records: list[MaintenanceRecord] = []
        self.documents: list[Document] = []
        self.settings: dict[str, Any] = {}
        self.archive: dict[str, Any] = {}

    # ----------------------------------------------------------- listeners
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
                _LOGGER.exception("Garage listener failed")

    # ---------------------------------------------------------------- load

    async def async_load(self) -> None:
        raw = await self.store.async_load()
        if raw is None:
            raw = default_data()
            await self.store.async_save(raw)

        self.vehicles = [Vehicle.from_dict(v) for v in raw.get("vehicles", [])]
        self.drivers = [Driver.from_dict(d) for d in raw.get("drivers", [])]
        self.fuel_entries = [FuelEntry.from_dict(f) for f in raw.get("fuel_entries", [])]
        self.maintenance_templates = [
            MaintenanceTemplate.from_dict(t) for t in raw.get("maintenance_templates", [])
        ]
        self.maintenance_records = [
            MaintenanceRecord.from_dict(m) for m in raw.get("maintenance_records", [])
        ]
        self.documents = [Document.from_dict(d) for d in raw.get("documents", [])]
        self.settings = raw.get(
            "settings",
            {
                "low_fuel_threshold": 0.20,
                "finance_sync_enabled": False,
                "finance_category_name": "Transportation",
            },
        )
        self.archive = raw.get("archive", {})

        added_defaults = self._reconcile_default_maintenance_templates()

        self.async_set_updated_data(self._build_public_data())
        if added_defaults:
            await self._async_save()

    def _reconcile_default_maintenance_templates(self) -> bool:
        """Add any built-in template shipped after this install's first run.

        Only additive - never touches an existing template, even if the
        user renamed or deleted one that shipped as a built-in. Matches by
        name (case-insensitive) so a later const.py addition like "New
        Tires" reaches installs that were seeded before it existed, not
        just fresh ones going through default_data().
        """
        existing_names = {t.name.strip().lower() for t in self.maintenance_templates}
        added = False
        for spec in DEFAULT_MAINTENANCE_TEMPLATES:
            if spec["name"].strip().lower() in existing_names:
                continue
            self.maintenance_templates.append(
                MaintenanceTemplate(
                    id=new_id(),
                    name=spec["name"],
                    basis=spec["basis"].value,
                    interval_miles=spec["interval_miles"],
                    interval_months=spec["interval_months"],
                    is_custom=False,
                )
            )
            added = True
        return added

    # --------------------------------------------------------------- save

    async def _async_save(self) -> None:
        data = {
            "version": 1,
            "vehicles": [v.to_dict() for v in self.vehicles],
            "drivers": [d.to_dict() for d in self.drivers],
            "fuel_entries": [f.to_dict() for f in self.fuel_entries],
            "maintenance_templates": [t.to_dict() for t in self.maintenance_templates],
            "maintenance_records": [m.to_dict() for m in self.maintenance_records],
            "documents": [d.to_dict() for d in self.documents],
            "settings": self.settings,
            "archive": self.archive,
        }
        await self.store.async_save(data)
        self.async_set_updated_data(self._build_public_data())

    # ----------------------------------------------------------- read model

    def fuel_entries_for_vehicle(self, vehicle_id: str) -> list[FuelEntry]:
        return sorted(
            (f for f in self.fuel_entries if f.vehicle_id == vehicle_id),
            key=lambda f: (f.date, f.odometer),
        )

    def maintenance_records_for_vehicle(self, vehicle_id: str) -> list[MaintenanceRecord]:
        return sorted(
            (m for m in self.maintenance_records if m.vehicle_id == vehicle_id),
            key=lambda m: m.date,
        )

    def documents_for_vehicle(self, vehicle_id: str) -> list[Document]:
        return [d for d in self.documents if d.vehicle_id == vehicle_id]

    def _last_maintenance_for_template(
        self, vehicle_id: str, template: MaintenanceTemplate
    ) -> MaintenanceRecord | None:
        all_records = self.maintenance_records_for_vehicle(vehicle_id)
        candidates = [m for m in all_records if m.template_id == template.id]
        if template.name.strip().lower() == "tire rotation":
            # A fresh set of tires doesn't need rotating on the old set's
            # schedule - a "New Tires" entry resets the rotation clock too,
            # not just its own.
            candidates += [m for m in all_records if "new tire" in m.name.strip().lower()]
        if not candidates:
            return None
        return max(candidates, key=lambda m: (m.date, m.odometer))

    def maintenance_statuses_for_vehicle(self, vehicle: Vehicle, today: date) -> list[dict]:
        statuses = []
        for template in self.maintenance_templates:
            last_record = self._last_maintenance_for_template(vehicle.id, template)
            statuses.append(
                maintenance_due_status(template, vehicle.current_mileage, last_record, today)
            )
        return statuses

    def _build_vehicle_summary(self, vehicle: Vehicle, today: date) -> dict[str, Any]:
        entries = self.fuel_entries_for_vehicle(vehicle.id)
        records = self.maintenance_records_for_vehicle(vehicle.id)
        statuses = self.maintenance_statuses_for_vehicle(vehicle, today)
        avg_mpg = average_mpg(entries)
        due_items = [s for s in statuses if s["due"]]
        due_soon_items = [s for s in statuses if s["due_soon"] and not s["due"]]
        health_args = dict(
            vehicle=vehicle,
            maintenance_statuses=statuses,
            today=today,
            low_fuel_threshold=self.settings.get("low_fuel_threshold", 0.20),
        )
        health_score = compute_health_score(**health_args)
        health_deductions = health_score_deductions(**health_args)
        return {
            "vehicle": vehicle,
            "average_mpg": avg_mpg,
            "average_price_per_gallon": average_price_per_gallon(entries),
            "lifetime_fuel_cost": total_fuel_cost(entries),
            "lifetime_maintenance_cost": total_maintenance_cost(records),
            "monthly_fuel_cost": spend_in_period(
                [(e.date, e.amount_dollars) for e in entries], today.year, today.month
            ),
            "monthly_maintenance_cost": spend_in_period(
                [(m.date, m.cost) for m in records], today.year, today.month
            ),
            "estimated_range_miles": estimated_range_miles(
                vehicle.tank_capacity_gal, vehicle.current_fuel_pct, avg_mpg
            ),
            "health_score": health_score,
            "health_deductions": health_deductions,
            "next_maintenance_due": (
                due_items[0] if due_items else (due_soon_items[0] if due_soon_items else None)
            ),
            "maintenance_due_count": len(due_items),
            "maintenance_due_soon_count": len(due_soon_items),
            "last_fuel_entry": entries[-1] if entries else None,
            "last_maintenance_record": records[-1] if records else None,
        }

    def _build_public_data(self) -> dict[str, Any]:
        today = date.today()
        vehicle_summaries = {v.id: self._build_vehicle_summary(v, today) for v in self.vehicles}
        active_vehicles = [v for v in self.vehicles if v.status == "active"]
        return {
            "vehicles": self.vehicles,
            "active_vehicles": active_vehicles,
            "drivers": self.drivers,
            "fuel_entries": self.fuel_entries,
            "maintenance_templates": self.maintenance_templates,
            "maintenance_records": self.maintenance_records,
            "documents": self.documents,
            "settings": self.settings,
            "vehicle_summaries": vehicle_summaries,
            "total_monthly_fuel_spend": round(
                sum(s["monthly_fuel_cost"] for s in vehicle_summaries.values()), 2
            ),
            "total_monthly_maintenance_spend": round(
                sum(s["monthly_maintenance_cost"] for s in vehicle_summaries.values()), 2
            ),
            "vehicles_needing_attention": [
                v.id for v in self.vehicles if vehicle_summaries[v.id]["maintenance_due_count"] > 0
            ],
        }

    # ------------------------------------------------------------ vehicles

    def _get_vehicle(self, vehicle_id: str) -> Vehicle:
        for vehicle in self.vehicles:
            if vehicle.id == vehicle_id:
                return vehicle
        raise ValueError(f"Unknown vehicle_id {vehicle_id}")

    async def async_add_vehicle(self, **fields: Any) -> Vehicle:
        vehicle = Vehicle(id=new_id(), **fields)
        self.vehicles.append(vehicle)
        await self._async_save()
        return vehicle

    async def async_edit_vehicle(self, vehicle_id: str, **fields: Any) -> Vehicle:
        # Unlike async_edit_driver, None is a legitimate explicit value here
        # (clearing the primary driver or a registration/insurance date), not
        # just "field omitted" - the frontend always sends the full form, so
        # every key present in `fields` reflects real user intent.
        vehicle = self._get_vehicle(vehicle_id)
        for key, value in fields.items():
            if hasattr(vehicle, key):
                setattr(vehicle, key, value)
        await self._async_save()
        return vehicle

    async def async_delete_vehicle(self, vehicle_id: str) -> None:
        self._get_vehicle(vehicle_id)
        self.vehicles = [v for v in self.vehicles if v.id != vehicle_id]
        self.fuel_entries = [f for f in self.fuel_entries if f.vehicle_id != vehicle_id]
        self.maintenance_records = [
            m for m in self.maintenance_records if m.vehicle_id != vehicle_id
        ]
        self.documents = [d for d in self.documents if d.vehicle_id != vehicle_id]
        await self._async_save()

    # ------------------------------------------------------------- drivers

    async def async_add_driver(
        self, name: str, ha_user_id: str | None = None, notify_target: str | None = None
    ) -> Driver:
        driver = Driver(id=new_id(), name=name, ha_user_id=ha_user_id, notify_target=notify_target)
        self.drivers.append(driver)
        await self._async_save()
        return driver

    async def async_edit_driver(self, driver_id: str, **fields: Any) -> Driver:
        driver = next((d for d in self.drivers if d.id == driver_id), None)
        if driver is None:
            raise ValueError(f"Unknown driver_id {driver_id}")
        for key, value in fields.items():
            if value is not None and hasattr(driver, key):
                setattr(driver, key, value)
        await self._async_save()
        return driver

    async def async_delete_driver(self, driver_id: str) -> None:
        self.drivers = [d for d in self.drivers if d.id != driver_id]
        for vehicle in self.vehicles:
            if vehicle.primary_driver_id == driver_id:
                vehicle.primary_driver_id = None
            vehicle.additional_driver_ids = [
                i for i in vehicle.additional_driver_ids if i != driver_id
            ]
        await self._async_save()

    # ---------------------------------------------------------------- fuel

    async def async_add_fuel_entry(
        self,
        vehicle_id: str,
        date_str: str,
        odometer: int,
        amount_dollars: float,
        fuel_grade: str = "regular",
        station: str = "",
        payment_method: str = "credit_card",
        full_tank: bool = True,
        notes: str = "",
        price_per_gallon: float | None = None,
        gallons_added: float | None = None,
    ) -> FuelEntry:
        vehicle = self._get_vehicle(vehicle_id)
        prior_full_tank = next(
            (
                e
                for e in reversed(self.fuel_entries_for_vehicle(vehicle_id))
                if e.full_tank
            ),
            None,
        )
        derived = compute_fuel_entry_derived(
            amount_dollars, odometer, price_per_gallon, gallons_added, prior_full_tank
        )
        entry = FuelEntry(
            id=new_id(),
            vehicle_id=vehicle_id,
            date=date_str,
            odometer=odometer,
            amount_dollars=amount_dollars,
            fuel_grade=fuel_grade,
            station=station,
            payment_method=payment_method,
            full_tank=full_tank,
            notes=notes,
            **derived,
        )
        self.fuel_entries.append(entry)
        if odometer > vehicle.current_mileage:
            vehicle.current_mileage = odometer
        if full_tank:
            vehicle.current_fuel_pct = 1.0
        else:
            estimated = estimate_fuel_pct_after_partial_fill(
                vehicle.current_fuel_pct, derived.get("gallons_added"), vehicle.tank_capacity_gal
            )
            if estimated is not None:
                vehicle.current_fuel_pct = estimated
        if self.settings.get("finance_sync_enabled"):
            entry.finance_expense_id = await _async_sync_to_finance(
                self.ha,
                "Fuel",
                amount_dollars,
                vehicle.nickname,
                self.settings.get("finance_category_name", "Transportation"),
                self.stash,
            )
        await self._async_save()
        return entry

    def _get_fuel_entry(self, entry_id: str) -> FuelEntry:
        for entry in self.fuel_entries:
            if entry.id == entry_id:
                return entry
        raise ValueError(f"Unknown entry_id {entry_id}")

    async def async_edit_fuel_entry(self, entry_id: str, **fields: Any) -> FuelEntry:
        entry = self._get_fuel_entry(entry_id)
        for key, value in fields.items():
            if hasattr(entry, key):
                setattr(entry, key, value)
        # Recompute the gallons/price-per-gallon pair if either was part of
        # this edit (or the total changed) - same "gallons wins if both
        # given" rule as adding a new entry. mpg is deliberately left alone:
        # recomputing it correctly needs the prior full-tank entry *as of
        # when this entry was originally logged*, which isn't reconstructable
        # here without risking silently wiping a valid value.
        if {"gallons_added", "price_per_gallon", "amount_dollars"} & fields.keys():
            derived = compute_fuel_entry_derived(
                entry.amount_dollars,
                entry.odometer,
                fields.get("price_per_gallon"),
                fields.get("gallons_added"),
                None,
            )
            if derived["gallons_added"] is not None:
                entry.gallons_added = derived["gallons_added"]
                entry.price_per_gallon = derived["price_per_gallon"]
        if entry.finance_expense_id and {"amount_dollars", "date"} & fields.keys():
            await _async_edit_finance_expense(
                self.ha,
                entry.finance_expense_id,
                self.stash,
                amount=entry.amount_dollars,
                date=entry.date,
            )
        await self._async_save()
        return entry

    async def async_delete_fuel_entry(self, entry_id: str) -> None:
        entry = self._get_fuel_entry(entry_id)
        if entry.finance_expense_id:
            await _async_delete_finance_expense(self.ha, entry.finance_expense_id, self.stash)
        self.fuel_entries = [f for f in self.fuel_entries if f.id != entry_id]
        await self._async_save()

    # ---------------------------------------------------------- maintenance

    async def async_add_maintenance_template(
        self,
        name: str,
        basis: str = "mileage",
        interval_miles: int | None = None,
        interval_months: int | None = None,
    ) -> MaintenanceTemplate:
        template = MaintenanceTemplate(
            id=new_id(),
            name=name,
            basis=basis,
            interval_miles=interval_miles,
            interval_months=interval_months,
            is_custom=True,
        )
        self.maintenance_templates.append(template)
        await self._async_save()
        return template

    async def async_delete_maintenance_template(self, template_id: str) -> None:
        self.maintenance_templates = [
            t for t in self.maintenance_templates if t.id != template_id
        ]
        await self._async_save()

    async def async_add_maintenance_record(
        self,
        vehicle_id: str,
        name: str,
        date_str: str,
        odometer: int,
        template_id: str | None = None,
        cost: float = 0.0,
        parts_cost: float = 0.0,
        labor_cost: float = 0.0,
        performed_by: str = "shop",
        shop_name: str = "",
        wheel_positions: list[str] | None = None,
        notes: str = "",
    ) -> MaintenanceRecord:
        vehicle = self._get_vehicle(vehicle_id)
        record = MaintenanceRecord(
            id=new_id(),
            vehicle_id=vehicle_id,
            template_id=template_id,
            name=name,
            date=date_str,
            odometer=odometer,
            cost=cost,
            parts_cost=parts_cost,
            labor_cost=labor_cost,
            performed_by=performed_by,
            shop_name=shop_name,
            wheel_positions=wheel_positions or [],
            notes=notes,
        )
        self.maintenance_records.append(record)
        if odometer > vehicle.current_mileage:
            vehicle.current_mileage = odometer
        if self.settings.get("finance_sync_enabled") and cost:
            record.finance_expense_id = await _async_sync_to_finance(
                self.ha,
                name,
                cost,
                vehicle.nickname,
                self.settings.get("finance_category_name", "Transportation"),
                self.stash,
            )
        await self._async_save()
        return record

    async def async_delete_maintenance_record(self, record_id: str) -> None:
        record = next((m for m in self.maintenance_records if m.id == record_id), None)
        if record and record.finance_expense_id:
            await _async_delete_finance_expense(
                self.ha, record.finance_expense_id, self.stash
            )
        self.maintenance_records = [
            m for m in self.maintenance_records if m.id != record_id
        ]
        await self._async_save()

    # ------------------------------------------------------------ documents

    async def async_add_document(
        self, vehicle_id: str, category: str, filename: str, path: str
    ) -> Document:
        self._get_vehicle(vehicle_id)
        document = Document(
            id=new_id(),
            vehicle_id=vehicle_id,
            category=category,
            filename=filename,
            path=path,
            uploaded_at=date.today().isoformat(),
        )
        self.documents.append(document)
        await self._async_save()
        return document

    async def async_delete_document(self, document_id: str) -> Document | None:
        """Returns the removed document (if any) so services.py can delete
        its file - the integration left uploads behind in www/, but here
        they'd bloat every add-on backup."""
        removed = next((d for d in self.documents if d.id == document_id), None)
        self.documents = [d for d in self.documents if d.id != document_id]
        await self._async_save()
        return removed

    # -------------------------------------------------------------- settings

    async def async_update_settings(self, **fields: Any) -> dict[str, Any]:
        for key, value in fields.items():
            if value is not None:
                self.settings[key] = value
        await self._async_save()
        return self.settings

    async def async_apply_live_readings(
        self, vehicle_id: str, odometer: int | None, fuel_pct: float | None
    ) -> bool:
        """Readings from the vehicle's linked HA sensors (obd.py). Odometer
        only ever moves forward, like a logged fill-up or service; only
        saves when something changed. Returns whether it did."""
        try:
            vehicle = self._get_vehicle(vehicle_id)
        except ValueError:
            return False  # deleted while the poll was in flight
        changed = False
        if odometer is not None and odometer > vehicle.current_mileage:
            vehicle.current_mileage = odometer
            changed = True
        if fuel_pct is not None and fuel_pct != vehicle.current_fuel_pct:
            vehicle.current_fuel_pct = fuel_pct
            changed = True
        if changed:
            await self._async_save()
        return changed

    def async_refresh(self) -> None:
        """Recomputes the date-dependent summaries (due status, health score,
        this month's spend) without a mutation - reminders.py calls it once a
        day, since nothing else would move them past midnight."""
        self.async_set_updated_data(self._build_public_data())

    # -------------------------------------------------------------- reminders

    def compute_reminders(self, today: date) -> list[dict[str, Any]]:
        """Return notification-worthy events across all vehicles: overdue/due-soon
        maintenance, low fuel, and expired/expiring registration & insurance.
        Called by the daily background job in __init__.py; kept side-effect-free
        here so it's easy to unit test the trigger logic separately from the
        notify.* dispatch.
        """
        reminders: list[dict[str, Any]] = []
        low_fuel_threshold = self.settings.get("low_fuel_threshold", 0.20)
        for vehicle in self.vehicles:
            if vehicle.status != "active":
                continue
            for status in self.maintenance_statuses_for_vehicle(vehicle, today):
                if status["due"]:
                    reminders.append(
                        {
                            "vehicle_id": vehicle.id,
                            "kind": "maintenance_overdue",
                            "message": f"{vehicle.nickname}: {status['name']} is due.",
                        }
                    )
            low_fuel = (
                vehicle.current_fuel_pct is not None
                and vehicle.current_fuel_pct <= low_fuel_threshold
            )
            if low_fuel:
                pct = round(vehicle.current_fuel_pct * 100)
                reminders.append(
                    {
                        "vehicle_id": vehicle.id,
                        "kind": "low_fuel",
                        "message": f"{vehicle.nickname} has {pct}% fuel remaining.",
                    }
                )
        return reminders
