from __future__ import annotations

import asyncio
from datetime import date

from garage_addon.coordinator import GarageCoordinator, _find_finance_category_id
from garage_addon.models import (
    FuelEntry,
    MaintenanceRecord,
    MaintenanceTemplate,
    Vehicle,
)


async def _noop_save() -> None:
    return None


def make_coordinator() -> GarageCoordinator:
    coordinator = GarageCoordinator(store=None)
    # Assigning a plain function (not a bound method) to an instance
    # attribute bypasses the descriptor protocol, so calling
    # coordinator._async_save() below doesn't try to pass self - it just
    # skips the real storage write/listener notification.
    coordinator._async_save = _noop_save
    return coordinator


def make_coordinator_with_finance(response: dict | None = None) -> GarageCoordinator:
    coordinator = make_coordinator()
    coordinator.ha = _FakeFinanceHa(response)
    coordinator.settings = {
        "low_fuel_threshold": 0.2,
        "finance_sync_enabled": True,
        "finance_category_name": "Gas",
    }
    return coordinator


def test_reconcile_adds_missing_default_templates():
    coordinator = make_coordinator()
    coordinator.maintenance_templates = [
        MaintenanceTemplate(
            id="t1", name="Oil Change", basis="both",
            interval_miles=5000, interval_months=6, is_custom=False,
        )
    ]
    added = coordinator._reconcile_default_maintenance_templates()
    names = {t.name for t in coordinator.maintenance_templates}
    assert added is True
    assert "New Tires" in names
    assert "Oil Change" in names


def test_reconcile_is_idempotent_and_preserves_custom_templates():
    coordinator = make_coordinator()
    coordinator.maintenance_templates = [
        MaintenanceTemplate(
            id="t1", name="My Custom Thing", basis="mileage",
            interval_miles=1000, interval_months=None, is_custom=True,
        )
    ]
    coordinator._reconcile_default_maintenance_templates()
    added_again = coordinator._reconcile_default_maintenance_templates()
    names = [t.name for t in coordinator.maintenance_templates]
    assert added_again is False
    assert names.count("New Tires") == 1
    assert "My Custom Thing" in names


def test_reconcile_matches_existing_template_case_insensitively():
    coordinator = make_coordinator()
    coordinator.maintenance_templates = [
        MaintenanceTemplate(
            id="t1", name="new tires", basis="mileage",
            interval_miles=40000, interval_months=None, is_custom=True,
        )
    ]
    # Only "new tires" was pre-seeded, so every *other* built-in (Oil Change,
    # Tire Rotation, ...) legitimately gets added too - the thing under test
    # is that "new tires" itself isn't duplicated/overwritten.
    coordinator._reconcile_default_maintenance_templates()
    matching = [t for t in coordinator.maintenance_templates if t.name.lower() == "new tires"]
    assert len(matching) == 1
    assert matching[0].is_custom is True
    assert matching[0].interval_miles == 40000


def test_new_tires_resets_tire_rotation_due_status():
    coordinator = make_coordinator()
    rotation_template = MaintenanceTemplate(
        id="rotation", name="Tire Rotation", basis="mileage", interval_miles=6000
    )
    coordinator.maintenance_templates = [rotation_template]
    coordinator.vehicles = [
        Vehicle(id="v1", nickname="Ram", year=2022, make="Ram", model="1500", current_mileage=40200)
    ]
    coordinator.maintenance_records = [
        # Old rotation from way back - would normally make rotation overdue.
        MaintenanceRecord(
            id="m1", vehicle_id="v1", template_id="rotation", name="Tire Rotation",
            date="2025-01-01", odometer=30000,
        ),
        # New tires installed since then, much more recently.
        MaintenanceRecord(
            id="m2", vehicle_id="v1", template_id=None, name="New Tires",
            date="2026-01-01", odometer=40000,
        ),
    ]
    statuses = coordinator.maintenance_statuses_for_vehicle(
        coordinator.vehicles[0], date(2026, 1, 15)
    )
    rotation_status = next(s for s in statuses if s["template_id"] == "rotation")
    assert rotation_status["due"] is False
    assert rotation_status["miles_remaining"] == 6000 - (40200 - 40000)


def test_tire_rotation_still_uses_its_own_history_when_more_recent():
    coordinator = make_coordinator()
    rotation_template = MaintenanceTemplate(
        id="rotation", name="Tire Rotation", basis="mileage", interval_miles=6000
    )
    coordinator.maintenance_templates = [rotation_template]
    coordinator.vehicles = [
        Vehicle(id="v1", nickname="Ram", year=2022, make="Ram", model="1500", current_mileage=46500)
    ]
    coordinator.maintenance_records = [
        MaintenanceRecord(
            id="m1", vehicle_id="v1", template_id=None, name="New Tires",
            date="2026-01-01", odometer=40000,
        ),
        # A rotation performed after the new tires - this should win.
        MaintenanceRecord(
            id="m2", vehicle_id="v1", template_id="rotation", name="Tire Rotation",
            date="2026-06-01", odometer=44000,
        ),
    ]
    statuses = coordinator.maintenance_statuses_for_vehicle(
        coordinator.vehicles[0], date(2026, 6, 15)
    )
    rotation_status = next(s for s in statuses if s["template_id"] == "rotation")
    assert rotation_status["miles_remaining"] == 6000 - (46500 - 44000)


def test_edit_fuel_entry_updates_only_given_fields():
    coordinator = make_coordinator()
    coordinator.fuel_entries = [
        FuelEntry(
            id="f1", vehicle_id="v1", date="2026-01-01", odometer=1000,
            amount_dollars=40.0, station="Old Station",
        )
    ]
    asyncio.run(
        coordinator.async_edit_fuel_entry("f1", amount_dollars=45.5, station="Shell")
    )
    entry = coordinator.fuel_entries[0]
    assert entry.amount_dollars == 45.5
    assert entry.station == "Shell"
    assert entry.odometer == 1000


def test_edit_fuel_entry_raises_on_unknown_id():
    coordinator = make_coordinator()
    coordinator.fuel_entries = []
    try:
        asyncio.run(coordinator.async_edit_fuel_entry("missing", station="Shell"))
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError for unknown entry_id")


def test_edit_fuel_entry_recomputes_price_from_gallons():
    coordinator = make_coordinator()
    coordinator.fuel_entries = [
        FuelEntry(
            id="f1", vehicle_id="v1", date="2026-01-01", odometer=1000, amount_dollars=40.0
        )
    ]
    asyncio.run(coordinator.async_edit_fuel_entry("f1", gallons_added=10.0))
    entry = coordinator.fuel_entries[0]
    assert entry.gallons_added == 10.0
    assert entry.price_per_gallon == 4.0


def test_edit_fuel_entry_without_gallons_or_price_leaves_them_untouched():
    coordinator = make_coordinator()
    coordinator.fuel_entries = [
        FuelEntry(
            id="f1", vehicle_id="v1", date="2026-01-01", odometer=1000,
            amount_dollars=40.0, gallons_added=10.0, price_per_gallon=4.0,
        )
    ]
    asyncio.run(coordinator.async_edit_fuel_entry("f1", station="Shell"))
    entry = coordinator.fuel_entries[0]
    assert entry.gallons_added == 10.0
    assert entry.price_per_gallon == 4.0


def test_add_full_tank_fuel_entry_sets_fuel_pct_to_full():
    coordinator = make_coordinator()
    coordinator.vehicles = [
        Vehicle(
            id="v1", nickname="Ram", year=2022, make="Ram", model="1500",
            current_mileage=1000, current_fuel_pct=0.2, tank_capacity_gal=20.0,
        )
    ]
    asyncio.run(
        coordinator.async_add_fuel_entry(
            "v1", "2026-01-01", 1200, 40.0, full_tank=True, gallons_added=10.0
        )
    )
    assert coordinator.vehicles[0].current_fuel_pct == 1.0


def test_add_partial_fuel_entry_estimates_fuel_pct_increase():
    coordinator = make_coordinator()
    coordinator.vehicles = [
        Vehicle(
            id="v1", nickname="Ram", year=2022, make="Ram", model="1500",
            current_mileage=1000, current_fuel_pct=0.2, tank_capacity_gal=20.0,
        )
    ]
    asyncio.run(
        coordinator.async_add_fuel_entry(
            "v1", "2026-01-01", 1200, 20.0, full_tank=False, gallons_added=5.0
        )
    )
    # 0.2 + 5/20 = 0.45
    assert coordinator.vehicles[0].current_fuel_pct == 0.45


def test_add_partial_fuel_entry_leaves_fuel_pct_untouched_without_baseline():
    coordinator = make_coordinator()
    coordinator.vehicles = [
        Vehicle(
            id="v1", nickname="Ram", year=2022, make="Ram", model="1500",
            current_mileage=1000, tank_capacity_gal=20.0,
        )
    ]
    asyncio.run(
        coordinator.async_add_fuel_entry(
            "v1", "2026-01-01", 1200, 20.0, full_tank=False, gallons_added=5.0
        )
    )
    assert coordinator.vehicles[0].current_fuel_pct is None


def _state(entity_id: str, attributes: dict) -> dict:
    return {"entity_id": entity_id, "state": "0", "attributes": attributes}


class _FakeFinanceHa:
    """Fake Home Assistant Core API client with Finance "installed" and a
    fixed category sensor, for testing Garage's sync/edit/delete propagation
    without a real HA core.
    """

    def __init__(self, response: dict | None = None, components: set[str] | None = None) -> None:
        self.calls: list[tuple[str, str, dict]] = []
        self._response = response or {}
        self._components = {"finance"} if components is None else components

    async def get_components(self) -> set[str]:
        return self._components

    async def get_states(self) -> list[dict]:
        return [_state("sensor.stash_gas", {"category_id": "cat-gas", "name": "Gas"})]

    async def call_service(self, domain, service, data, *, return_response=False):
        self.calls.append((domain, service, dict(data)))
        return self._response if return_response else None


def test_find_finance_category_id_matches_by_name_case_insensitively():
    states = [
        _state("sensor.a", {"category_id": "abc123", "name": "Gas"}),
        _state("sensor.b", {"category_id": "def456", "name": "Housing"}),
    ]
    assert _find_finance_category_id(states, "gas") == "abc123"
    assert _find_finance_category_id(states, "Housing") == "def456"


def test_find_finance_category_id_returns_none_when_not_found():
    states = [_state("sensor.a", {"category_id": "abc123", "name": "Gas"})]
    assert _find_finance_category_id(states, "Transportation") is None


def test_find_finance_category_id_ignores_non_sensors():
    states = [_state("input_text.a", {"category_id": "abc123", "name": "Gas"})]
    assert _find_finance_category_id(states, "Gas") is None


def test_finance_sync_skipped_when_finance_not_loaded():
    coordinator = make_coordinator_with_finance(response={"expense_id": "exp-1"})
    coordinator.ha = _FakeFinanceHa({"expense_id": "exp-1"}, components=set())
    coordinator.vehicles = [
        Vehicle(id="v1", nickname="Ram", year=2022, make="Ram", model="1500", current_mileage=1000)
    ]
    entry = asyncio.run(
        coordinator.async_add_fuel_entry("v1", "2026-01-01", 1200, 40.0, full_tank=True)
    )
    assert entry.finance_expense_id is None
    assert coordinator.ha.calls == []


def test_add_fuel_entry_captures_finance_expense_id_when_synced():
    coordinator = make_coordinator_with_finance(response={"expense_id": "exp-1"})
    coordinator.vehicles = [
        Vehicle(id="v1", nickname="Ram", year=2022, make="Ram", model="1500", current_mileage=1000)
    ]
    entry = asyncio.run(
        coordinator.async_add_fuel_entry("v1", "2026-01-01", 1200, 40.0, full_tank=True)
    )
    assert entry.finance_expense_id == "exp-1"
    call = coordinator.ha.calls[0]
    assert call[0] == "finance"
    assert call[1] == "add_category_expense"
    assert call[2]["category_id"] == "cat-gas"
    assert call[2]["amount"] == 40.0


def test_add_fuel_entry_skips_finance_sync_when_disabled():
    coordinator = make_coordinator()
    coordinator.ha = _FakeFinanceHa()
    coordinator.vehicles = [
        Vehicle(id="v1", nickname="Ram", year=2022, make="Ram", model="1500", current_mileage=1000)
    ]
    entry = asyncio.run(
        coordinator.async_add_fuel_entry("v1", "2026-01-01", 1200, 40.0, full_tank=True)
    )
    assert entry.finance_expense_id is None
    assert coordinator.ha.calls == []


def test_edit_fuel_entry_propagates_amount_change_to_linked_expense():
    coordinator = make_coordinator_with_finance()
    coordinator.fuel_entries = [
        FuelEntry(
            id="f1", vehicle_id="v1", date="2026-01-01", odometer=1000,
            amount_dollars=40.0, finance_expense_id="exp-1",
        )
    ]
    asyncio.run(coordinator.async_edit_fuel_entry("f1", amount_dollars=55.0))
    call = coordinator.ha.calls[0]
    assert call[1] == "edit_category_expense"
    assert call[2] == {"expense_id": "exp-1", "amount": 55.0, "date": "2026-01-01"}


def test_edit_fuel_entry_without_linked_expense_does_not_call_finance():
    coordinator = make_coordinator_with_finance()
    coordinator.fuel_entries = [
        FuelEntry(id="f1", vehicle_id="v1", date="2026-01-01", odometer=1000, amount_dollars=40.0)
    ]
    asyncio.run(coordinator.async_edit_fuel_entry("f1", amount_dollars=55.0))
    assert coordinator.ha.calls == []


def test_delete_fuel_entry_propagates_delete_to_linked_expense():
    coordinator = make_coordinator_with_finance()
    coordinator.fuel_entries = [
        FuelEntry(
            id="f1", vehicle_id="v1", date="2026-01-01", odometer=1000,
            amount_dollars=40.0, finance_expense_id="exp-1",
        )
    ]
    asyncio.run(coordinator.async_delete_fuel_entry("f1"))
    call = coordinator.ha.calls[0]
    assert call[1] == "delete_category_expense"
    assert call[2] == {"expense_id": "exp-1"}
    assert coordinator.fuel_entries == []
