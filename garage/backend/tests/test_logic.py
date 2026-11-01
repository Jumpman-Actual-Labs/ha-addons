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
    exceeds_tank_range,
    health_score_deductions,
    maintenance_due_status,
    match_detected_fill,
    parse_trouble_codes,
    pending_fill_up,
    record_tire_history,
    spend_in_period,
    suggest_sensor_links,
    tire_alerts,
    total_fuel_cost,
    total_maintenance_cost,
    track_sensor_tank,
    unlogged_fill_between,
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


def test_average_mpg_drops_fill_ups_that_span_an_unlogged_one():
    entries = [make_fuel_entry(mpg=18.0), make_fuel_entry(mpg=174.7)]
    assert average_mpg(entries) == 18.0


def test_average_mpg_prefers_sensor_tanks_weighted_by_miles():
    entries = [make_fuel_entry(mpg=40.0)]
    tanks = [
        {"miles": 300, "gallons": 15, "mpg": 20.0},
        {"miles": 100, "gallons": 10, "mpg": 10.0},
        {"miles": 20, "gallons": None, "mpg": None},
    ]
    assert average_mpg(entries, tanks) == 16.0
    assert average_mpg(entries, [{"miles": 20, "gallons": None, "mpg": None}]) == 40.0


def test_track_sensor_tank_closes_a_tank_on_a_fill_up():
    tanks: list[dict] = []
    tracking = track_sensor_tank(None, tanks, 1000.0, 0.90, 26, "2026-11-01")
    tracking = track_sensor_tank(tracking, tanks, 1150.0, 0.60, 26, "2026-11-01")
    tracking = track_sensor_tank(tracking, tanks, 1234.0, 0.40, 26, "2026-11-02")
    assert tanks == []
    tracking = track_sensor_tank(tracking, tanks, 1236.0, 0.95, 26, "2026-11-02")
    assert len(tanks) == 1
    tank = tanks[0]
    assert tank["id"]
    assert {k: tank[k] for k in ("date", "fill_odometer", "miles", "gallons", "mpg")} == {
        "date": "2026-11-02",
        "fill_odometer": 1234.0,
        "miles": 234.0,
        "gallons": 13.0,
        "mpg": 18.0,
    }
    assert (tank["fuel_pct_before"], tank["fuel_pct_after"], tank["gallons_added"]) == (
        0.40,
        0.95,
        14.3,
    )
    assert not tank["logged"] and not tank["dismissed"]
    assert tracking["start_odometer"] == 1236.0
    assert tracking["start_fuel_pct"] == 0.95


def test_track_sensor_tank_ignores_small_rises_and_small_tanks():
    tanks: list[dict] = []
    tracking = track_sensor_tank(None, tanks, 1000.0, 0.50, 26, "2026-11-01")
    tracking = track_sensor_tank(tracking, tanks, 1010.0, 0.58, 26, "2026-11-01")
    assert tanks == []  # a slosh or a slope, not a fill-up
    # A top-off after barely any driving: the fill-up counts, the mpg doesn't.
    track_sensor_tank(tracking, tanks, 1020.0, 0.95, 26, "2026-11-01")
    assert tanks[0]["fill_odometer"] == 1010.0
    assert tanks[0]["mpg"] is None


def test_unlogged_fill_between():
    tanks = [{"fill_odometer": 1234.0}]
    assert unlogged_fill_between(tanks, 1000, 1500)
    assert not unlogged_fill_between(tanks, 1000, 1240)  # that logged fill-up itself
    assert not unlogged_fill_between([], 1000, 1500)


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


def test_track_sensor_tank_only_fills_across_a_stop():
    tanks: list[dict] = []
    tracking = track_sensor_tank(None, tanks, 1000.0, 0.40, 26, "2026-11-01")
    # A slosh spike mid-trip looks like a fill-up, but there was no stop.
    same = track_sensor_tank(tracking, tanks, 1005.0, 0.70, 26, "2026-11-01", after_stop=False)
    assert tanks == [] and same == tracking
    track_sensor_tank(tracking, tanks, 1006.0, 0.95, 26, "2026-11-01", after_stop=True)
    assert len(tanks) == 1


def test_match_and_pending_detected_fills():
    tanks = [
        {"id": "a", "fill_odometer": 1000.0, "logged": True, "dismissed": False},
        {"id": "b", "fill_odometer": 1400.0, "logged": False, "dismissed": False},
        {"fill_odometer": 900.0},  # from before fill-ups had ids
    ]
    assert match_detected_fill(tanks, 1395)["id"] == "b"  # logged at the pump
    assert match_detected_fill(tanks, 1460)["id"] == "b"  # logged at home later
    assert match_detected_fill(tanks, 1500) is None
    assert match_detected_fill(tanks, 1000) is None  # already logged
    assert pending_fill_up(tanks)["id"] == "b"
    tanks[1]["dismissed"] = True
    assert pending_fill_up(tanks) is None


def test_exceeds_tank_range():
    assert exceeds_tank_range(700, 26, 18)  # 26 gal x 18 mpg = 468 mi a tank
    assert not exceeds_tank_range(500, 26, 18)
    assert not exceeds_tank_range(5000, None, 18)
    assert not exceeds_tank_range(5000, 26, None)


def test_tire_alerts_low_and_uneven():
    today = date(2026, 11, 1)
    fine = {"fl": 37, "fr": 37, "rl": 35, "rr": 36}
    assert tire_alerts(fine, 36, [], today) == []
    alerts = tire_alerts({**fine, "rl": 30}, 36, [], today)
    assert [a["key"] for a in alerts] == ["low_rl", "uneven"]
    assert alerts[0]["message"] == "Rear left tire is low (30 psi)"
    # Without a target on the vehicle, low means under 30 psi.
    assert [a["key"] for a in tire_alerts({**fine, "fl": 29}, None, [], today)] == [
        "low_fl",
        "uneven",
    ]


def test_tire_alerts_slow_leak_against_the_other_tires():
    today = date(2026, 11, 10)
    history = [{"date": "2026-11-01", "fl": 37, "fr": 37, "rl": 36, "rr": 36}]
    # Everything dropped 3 psi on a cold morning - no leak, all together.
    cold = {"fl": 34, "fr": 34, "rl": 33, "rr": 33}
    assert tire_alerts(cold, None, history, today) == []
    # Front right fell 3 psi further than the rest.
    leaking = {"fl": 37, "fr": 34, "rl": 36, "rr": 36}
    assert [a["key"] for a in tire_alerts(leaking, None, history, today)] == ["leak_fr"]
    # Too recent a reading to compare against.
    assert tire_alerts(leaking, None, history, date(2026, 11, 4)) == []


def test_record_tire_history_keeps_one_full_set_a_day():
    history: list[dict] = []
    full = {"fl": 37, "fr": 37, "rl": 35, "rr": 36}
    assert record_tire_history(history, "2026-11-01", full)
    assert not record_tire_history(history, "2026-11-01", {**full, "fl": 40})
    assert not record_tire_history(history, "2026-11-02", {"fl": 37})
    assert history == [{"date": "2026-11-01", **full}]


def test_parse_trouble_codes():
    sensor = {"state": "P0420 P0171", "attributes": {"check_engine_light": "1"}}
    assert parse_trouble_codes(sensor) == (["P0420", "P0171"], True)
    assert parse_trouble_codes({"state": "All clear", "attributes": {"mil": "off"}}) == (
        [],
        False,
    )
    assert parse_trouble_codes({"state": "p0420, P0420"}) == (["P0420"], None)
    assert parse_trouble_codes({"state": "unavailable"}) is None
    assert parse_trouble_codes(None) is None


def test_health_score_counts_tires_and_trouble_codes():
    today = date(2026, 11, 1)
    vehicle = make_vehicle(
        tire_pressures={"fl": 37, "fr": 37, "rl": 30, "rr": 36},
        tire_target_psi=36,
        trouble_codes=["P0420"],
        check_engine_light=True,
    )
    deductions = health_score_deductions(
        vehicle=vehicle, maintenance_statuses=[], today=today, low_fuel_threshold=0.2
    )
    assert [(d["reason"], d["points"]) for d in deductions] == [
        ("Rear left tire is low (30 psi)", 10),
        ("Tire pressures are uneven (30-37 psi)", 5),
        ("Check engine light: P0420", 25),
    ]


def _wican(key: str, unit: str = "") -> dict:
    slug = key.lower().replace(" ", "_").replace("-", "_")
    return {"entity_id": f"sensor.wican_94a990dc061d_{slug}", "name": f"WiCAN {key}", "unit": unit}


def test_suggest_sensor_links_from_a_wican():
    sensors = [
        _wican("A6-Odometer", "mi"),
        _wican("2F-FuelTankLevel", "%"),
        _wican("FUEL_GAL", "gal"),
        _wican("Gear"),
        _wican("GEAR_TARGET"),
        _wican("FL Tire", "psi"),
        _wican("FR Tire", "psi"),
        _wican("RR Tire", "psi"),
        _wican("RL Tire", "psi"),
        _wican("TRAN_F_TEMP", "°F"),
        _wican("batt_voltage", "V"),
    ]
    links = suggest_sensor_links(sensors)
    w = "sensor.wican_94a990dc061d_"
    assert links == {
        "odometer_entity_id": w + "a6_odometer",
        "fuel_level_entity_id": w + "2f_fueltanklevel",
        "gear_entity_id": w + "gear",
        "tire_entity_ids": {
            "fl": w + "fl_tire",
            "fr": w + "fr_tire",
            "rl": w + "rl_tire",
            "rr": w + "rr_tire",
        },
        "trouble_codes_entity_id": "",
    }


def test_suggest_sensor_links_spelled_out_tires_and_codes():
    sensors = [
        {"entity_id": "sensor.car_tire_pressure_front_left", "name": "Tire pressure front left"},
        {"entity_id": "sensor.car_tire_temperature_front_left", "name": "Tire temp front left"},
        {"entity_id": "sensor.truck_trouble_codes", "name": "Truck trouble codes"},
    ]
    links = suggest_sensor_links(sensors)
    assert links["tire_entity_ids"] == {"fl": "sensor.car_tire_pressure_front_left"}
    assert links["trouble_codes_entity_id"] == "sensor.truck_trouble_codes"
    assert links["odometer_entity_id"] == ""
