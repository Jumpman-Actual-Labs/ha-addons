from __future__ import annotations

from datetime import date

from garage_addon.logic import (
    average_mpg,
    average_price_per_gallon,
    compute_cost_per_mile,
    compute_fuel_entry_derived,
    compute_health_score,
    compute_mpg,
    estimate_fuel_pct_after_partial_fill,
    estimated_range_miles,
    health_score_deductions,
    maintenance_due_status,
    spend_in_period,
    total_fuel_cost,
    total_maintenance_cost,
)
from garage_addon.models import (
    FuelEntry,
    MaintenanceRecord,
    MaintenanceTemplate,
    Vehicle,
)


def make_vehicle(**overrides) -> Vehicle:
    defaults = dict(
        id="v1",
        nickname="Ram",
        year=2022,
        make="Ram",
        model="1500",
        current_mileage=10000,
    )
    defaults.update(overrides)
    return Vehicle(**defaults)


def make_fuel_entry(**overrides) -> FuelEntry:
    defaults = dict(
        id="f1",
        vehicle_id="v1",
        date="2026-01-01",
        odometer=10000,
        amount_dollars=40.0,
    )
    defaults.update(overrides)
    return FuelEntry(**defaults)


def test_compute_mpg():
    assert compute_mpg(300, 10) == 30.0
    assert compute_mpg(300, 0) is None


def test_compute_cost_per_mile():
    assert compute_cost_per_mile(60.0, 300) == 0.2
    assert compute_cost_per_mile(60.0, 0) is None


def test_compute_fuel_entry_derived_from_price_per_gallon():
    prior = make_fuel_entry(id="f0", odometer=9700, full_tank=True)
    result = compute_fuel_entry_derived(40.0, 10000, 4.0, None, prior)
    assert result["gallons_added"] == 10.0
    assert result["price_per_gallon"] == 4.0
    assert result["mpg"] == 30.0


def test_compute_fuel_entry_derived_from_gallons():
    prior = make_fuel_entry(id="f0", odometer=9700, full_tank=True)
    result = compute_fuel_entry_derived(40.0, 10000, None, 10.0, prior)
    assert result["gallons_added"] == 10.0
    assert result["price_per_gallon"] == 4.0
    assert result["mpg"] == 30.0


def test_compute_fuel_entry_derived_gallons_wins_over_price_when_both_given():
    result = compute_fuel_entry_derived(40.0, 10000, 5.0, 10.0, None)
    assert result["gallons_added"] == 10.0
    assert result["price_per_gallon"] == 4.0


def test_compute_fuel_entry_derived_without_either_leaves_fields_none():
    result = compute_fuel_entry_derived(40.0, 10000, None, None, None)
    assert result == {"gallons_added": None, "price_per_gallon": None, "mpg": None}


def test_average_mpg_and_price():
    entries = [make_fuel_entry(mpg=20.0), make_fuel_entry(mpg=30.0), make_fuel_entry(mpg=None)]
    assert average_mpg(entries) == 25.0
    priced = [make_fuel_entry(price_per_gallon=3.0), make_fuel_entry(price_per_gallon=4.0)]
    assert average_price_per_gallon(priced) == 3.5
    assert average_mpg([]) is None


def test_total_fuel_and_maintenance_cost():
    entries = [make_fuel_entry(amount_dollars=40.0), make_fuel_entry(amount_dollars=35.5)]
    assert total_fuel_cost(entries) == 75.5
    records = [
        MaintenanceRecord(
            id="m1", vehicle_id="v1", template_id=None, name="Oil",
            date="2026-01-01", odometer=10000, cost=60.0,
        ),
        MaintenanceRecord(
            id="m2", vehicle_id="v1", template_id=None, name="Tires",
            date="2026-01-01", odometer=10000, cost=40.0,
        ),
    ]
    assert total_maintenance_cost(records) == 100.0


def test_spend_in_period_filters_by_year_and_month():
    data = [("2026-01-15", 10.0), ("2026-02-01", 20.0), ("2025-01-15", 5.0)]
    assert spend_in_period(data, 2026, 1) == 10.0
    assert spend_in_period(data, 2026) == 30.0


def test_estimated_range_miles():
    assert estimated_range_miles(20.0, 0.5, 25.0) == 250.0
    assert estimated_range_miles(None, 0.5, 25.0) is None


def test_estimate_fuel_pct_after_partial_fill_adds_fraction():
    # 5 gallons into a 20 gallon tank starting at 25% -> +25% = 50%
    assert estimate_fuel_pct_after_partial_fill(0.25, 5.0, 20.0) == 0.5


def test_estimate_fuel_pct_after_partial_fill_caps_at_full():
    assert estimate_fuel_pct_after_partial_fill(0.9, 10.0, 20.0) == 1.0


def test_estimate_fuel_pct_after_partial_fill_none_without_a_baseline():
    assert estimate_fuel_pct_after_partial_fill(None, 5.0, 20.0) is None


def test_estimate_fuel_pct_after_partial_fill_none_without_tank_capacity():
    assert estimate_fuel_pct_after_partial_fill(0.25, 5.0, None) is None


def test_estimate_fuel_pct_after_partial_fill_none_without_gallons():
    assert estimate_fuel_pct_after_partial_fill(0.25, None, 20.0) is None


def test_maintenance_due_status_mileage_basis_due():
    template = MaintenanceTemplate(
        id="t1", name="Oil Change", basis="mileage", interval_miles=5000
    )
    last = MaintenanceRecord(
        id="m1", vehicle_id="v1", template_id="t1", name="Oil Change",
        date="2025-01-01", odometer=5000,
    )
    status = maintenance_due_status(
        template, current_mileage=10500, last_record=last, today=date(2026, 1, 1)
    )
    assert status["due"] is True
    assert status["miles_remaining"] == -500


def test_maintenance_due_status_time_basis_due_soon():
    template = MaintenanceTemplate(
        id="t2", name="Registration", basis="time", interval_months=12
    )
    last = MaintenanceRecord(
        id="m2", vehicle_id="v1", template_id="t2", name="Registration",
        date="2025-01-05", odometer=1000,
    )
    status = maintenance_due_status(
        template, current_mileage=1000, last_record=last, today=date(2026, 1, 1)
    )
    assert status["due_soon"] is True
    assert status["due"] is False


def test_maintenance_due_status_no_history_uses_today_as_base():
    template = MaintenanceTemplate(id="t3", name="Inspection", basis="time", interval_months=12)
    status = maintenance_due_status(
        template, current_mileage=0, last_record=None, today=date(2026, 1, 1)
    )
    assert status["due"] is False
    assert status["due_at_date"] == "2027-01-01"


def test_compute_health_score_full_marks_when_nothing_wrong():
    vehicle = make_vehicle(current_fuel_pct=0.8)
    score = compute_health_score(
        vehicle=vehicle, maintenance_statuses=[], today=date(2026, 1, 1), low_fuel_threshold=0.2
    )
    assert score == 100


def test_compute_health_score_deducts_for_overdue_maintenance_and_low_fuel():
    vehicle = make_vehicle(current_fuel_pct=0.1)
    statuses = [
        {"name": "Oil Change", "due": True, "due_soon": False},
        {"name": "Tire Rotation", "due": False, "due_soon": True},
    ]
    score = compute_health_score(
        vehicle=vehicle, maintenance_statuses=statuses,
        today=date(2026, 1, 1), low_fuel_threshold=0.2,
    )
    # 100 - 15 (overdue) - 5 (due soon) - 5 (low fuel) = 75
    assert score == 75


def test_compute_health_score_ignores_registration_and_insurance():
    vehicle = make_vehicle(registration_expires="2025-01-01", insurance_expires="2025-01-01")
    statuses = [
        {"name": "Registration", "due": True, "due_soon": False},
        {"name": "Insurance Renewal", "due": False, "due_soon": True},
    ]
    score = compute_health_score(
        vehicle=vehicle, maintenance_statuses=statuses,
        today=date(2026, 1, 1), low_fuel_threshold=0.2,
    )
    # Paperwork is a notification, not vehicle health
    assert score == 100


def test_health_score_deductions_itemizes_each_reason():
    vehicle = make_vehicle(
        current_fuel_pct=0.1,
        registration_expires="2026-01-15",
        insurance_expires="2025-01-01",
    )
    statuses = [
        {"name": "Oil Change", "due": True, "due_soon": False},
        {"name": "Tire Rotation", "due": False, "due_soon": True},
        {"name": "Air Filter", "due": False, "due_soon": False},
    ]
    deductions = health_score_deductions(
        vehicle=vehicle, maintenance_statuses=statuses,
        today=date(2026, 1, 1), low_fuel_threshold=0.2,
    )
    assert deductions == [
        {"reason": "Oil Change overdue", "points": 15},
        {"reason": "Tire Rotation due soon", "points": 5},
        {"reason": "Low fuel", "points": 5},
    ]


def test_compute_health_score_clamped_to_zero():
    vehicle = make_vehicle(current_fuel_pct=0.0)
    statuses = [{"name": "Oil Change", "due": True, "due_soon": False}] * 10
    score = compute_health_score(
        vehicle=vehicle, maintenance_statuses=statuses,
        today=date(2026, 1, 1), low_fuel_threshold=0.2,
    )
    assert score == 0
