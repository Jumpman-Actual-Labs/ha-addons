"""Pure functions (no Home Assistant imports). Keep new business logic here,
not in coordinator.py, so it stays unit-testable without the HA test harness.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta

from .const import (
    HEALTH_SCORE_DEDUCT_CHECK_ENGINE,
    HEALTH_SCORE_DEDUCT_LOW_FUEL,
    HEALTH_SCORE_DEDUCT_LOW_TIRE,
    HEALTH_SCORE_DEDUCT_MAINTENANCE_DUE_SOON,
    HEALTH_SCORE_DEDUCT_OVERDUE_MAINTENANCE,
    HEALTH_SCORE_DEDUCT_TIRE_WARNING,
    HEALTH_SCORE_DEDUCT_TROUBLE_CODES,
    HEALTH_SCORE_EXCLUDED_TEMPLATE_NAMES,
    HEALTH_SCORE_START,
    MAINTENANCE_DUE_SOON_DAYS,
    MAINTENANCE_DUE_SOON_MILES,
)
from .models import FuelEntry, MaintenanceRecord, MaintenanceTemplate, Vehicle, new_id


def parse_date(value: str | None) -> date | None:
    if not value:
        return None
    return datetime.strptime(value, "%Y-%m-%d").date()


def estimate_fuel_pct_after_partial_fill(
    current_fuel_pct: float | None,
    gallons_added: float | None,
    tank_capacity_gal: float | None,
) -> float | None:
    """A full-tank fill sets current_fuel_pct to 1.0 directly, but a partial
    fill needs a starting level to add to - if we've never had one (nobody's
    told us the tank was ever full or empty), there's nothing safe to
    estimate from, so this returns None and the caller leaves the level
    untouched rather than guessing from an unknown baseline.
    """
    if current_fuel_pct is None or not gallons_added or not tank_capacity_gal:
        return None
    return min(1.0, round(current_fuel_pct + gallons_added / tank_capacity_gal, 4))


def compute_mpg(miles_driven: float, gallons_used: float) -> float | None:
    if gallons_used <= 0:
        return None
    return round(miles_driven / gallons_used, 2)


def compute_cost_per_mile(total_cost: float, miles_driven: float) -> float | None:
    if miles_driven <= 0:
        return None
    return round(total_cost / miles_driven, 4)


def compute_fuel_entry_derived(
    entry_amount_dollars: float,
    entry_odometer: int,
    price_per_gallon_input: float | None,
    gallons_added_input: float | None,
    prior_full_tank_entry: FuelEntry | None,
) -> dict:
    """Fill in gallons_added / price_per_gallon / mpg for a new fuel entry.

    Whichever of gallons or price-per-gallon the user actually typed in
    determines the other (gallons entered -> price/gal = total/gallons;
    price/gal entered -> gallons = total/price_per_gal). If both were
    entered, gallons wins since it's the more directly observable number
    (read off the pump) rather than something back-computed.
    """
    result: dict = {"gallons_added": None, "price_per_gallon": None, "mpg": None}

    gallons = None
    price_per_gallon = None
    if gallons_added_input and gallons_added_input > 0:
        gallons = round(gallons_added_input, 3)
        price_per_gallon = round(entry_amount_dollars / gallons, 3) if gallons else None
    elif price_per_gallon_input and price_per_gallon_input > 0:
        price_per_gallon = round(price_per_gallon_input, 3)
        gallons = round(entry_amount_dollars / price_per_gallon_input, 3)

    if gallons is None:
        return result

    result["gallons_added"] = gallons
    result["price_per_gallon"] = price_per_gallon
    if prior_full_tank_entry is not None:
        miles = entry_odometer - prior_full_tank_entry.odometer
        if miles > 0:
            result["mpg"] = compute_mpg(miles, gallons)
    return result


# A logged fill-up's mpg is miles since the last logged full tank over the
# gallons it took - so a fill-up nobody logged in between folds two tanks of
# miles into one tank of gallons. Nothing that burns gasoline gets past this.
MAX_PLAUSIBLE_MPG = 80.0
# A rise in the (smoothed) fuel sensor this big between readings is a fill-up.
SENSOR_FILL_JUMP = 0.15
# A tank this empty-ish is too little burn for the float's error to wash out.
SENSOR_MIN_TANK_USED = 0.15
SENSOR_TANKS_KEPT = 20
SENSOR_TANKS_AVERAGED = 5
# How close (miles) a sensor-seen fill-up can sit to a logged one and still
# be that same fill-up.
SENSOR_FILL_MATCH_MILES = 10
# A fill-up logged later (at home, from the receipt) carries a later
# odometer than the pump's - still the same fill-up up to this far past it.
SENSOR_FILL_LOGGED_LATE_MILES = 75
# A logged full tank whose miles since the last full one run past this many
# tanks' worth (at the vehicle's own average) skipped a fill-up somewhere.
TANK_RANGE_SLACK = 1.3


def average_mpg(
    fuel_entries: list[FuelEntry], sensor_tanks: list[dict] | None = None
) -> float | None:
    """Prefer the fuel sensor's tanks (miles over gallons actually burned, so
    unlogged fill-ups can't skew it), weighted by distance; fall back to the
    logged fill-ups, minus any that can't be real."""
    tanks = [t for t in (sensor_tanks or []) if t.get("mpg")][-SENSOR_TANKS_AVERAGED:]
    if tanks:
        gallons = sum(t["gallons"] for t in tanks)
        return round(sum(t["miles"] for t in tanks) / gallons, 2)
    values = [e.mpg for e in fuel_entries if e.mpg and e.mpg <= MAX_PLAUSIBLE_MPG]
    if not values:
        return None
    return round(sum(values) / len(values), 2)


def track_sensor_tank(
    tracking: dict | None,
    sensor_tanks: list[dict],
    odometer: float | None,
    fuel_pct: float,
    tank_capacity_gal: float | None,
    date_str: str,
    after_stop: bool = True,
) -> dict:
    """Follow one tank from fill-up to fill-up on the fuel sensor, so MPG
    comes from what was burned rather than from what was logged.

    `tracking` is where this tank started and the last reading; a jump up
    of SENSOR_FILL_JUMP closes the tank - appended to `sensor_tanks` with
    its mpg when enough was burned to measure - and starts the next one.
    Fuel only goes in while the vehicle is stopped, so a jump counts only
    `after_stop` (Park, or a long stop - see obd.py); mid-trip it's slosh
    and that reading is dropped. Returns the new tracking.
    """
    if odometer is None:
        return tracking or {}
    if not tracking or tracking.get("start_odometer") is None:
        return {
            "start_odometer": odometer,
            "start_fuel_pct": fuel_pct,
            "last_odometer": odometer,
            "last_fuel_pct": fuel_pct,
        }
    if fuel_pct - tracking["last_fuel_pct"] < SENSOR_FILL_JUMP:
        return {**tracking, "last_odometer": odometer, "last_fuel_pct": fuel_pct}
    if not after_stop:
        return tracking

    miles = round(tracking["last_odometer"] - tracking["start_odometer"], 1)
    used = tracking["start_fuel_pct"] - tracking["last_fuel_pct"]
    tank: dict = {
        "id": new_id(),
        "date": date_str,
        "fill_odometer": round(tracking["last_odometer"], 1),
        "miles": miles,
        "gallons": None,
        "mpg": None,
        # The fill-up itself: the level either side of it and a gallons
        # estimate, for prompting whoever filled up to log it.
        "fuel_pct_before": tracking["last_fuel_pct"],
        "fuel_pct_after": fuel_pct,
        "gallons_added": (
            round((fuel_pct - tracking["last_fuel_pct"]) * tank_capacity_gal, 1)
            if tank_capacity_gal
            else None
        ),
        "logged": False,
        "dismissed": False,
    }
    if tank_capacity_gal and used >= SENSOR_MIN_TANK_USED and miles > 0:
        gallons = round(used * tank_capacity_gal, 2)
        mpg = compute_mpg(miles, gallons)
        if mpg is not None and mpg <= MAX_PLAUSIBLE_MPG:
            tank.update(gallons=gallons, mpg=mpg)
    sensor_tanks.append(tank)
    del sensor_tanks[:-SENSOR_TANKS_KEPT]
    return {
        "start_odometer": odometer,
        "start_fuel_pct": fuel_pct,
        "last_odometer": odometer,
        "last_fuel_pct": fuel_pct,
    }


def unlogged_fill_between(
    sensor_tanks: list[dict], from_odometer: float, to_odometer: float
) -> bool:
    """Whether the sensor saw a fill-up between two logged ones - which
    makes the later one's miles-since-last-full span more than one tank."""
    return any(
        from_odometer + SENSOR_FILL_MATCH_MILES
        < t["fill_odometer"]
        < to_odometer - SENSOR_FILL_MATCH_MILES
        for t in sensor_tanks
    )


def match_detected_fill(sensor_tanks: list[dict], odometer: float) -> dict | None:
    """The sensor-seen fill-up a fill-up logged at `odometer` is, if any: not
    yet logged or dismissed, at the pump or logged a little later."""
    for tank in reversed(sensor_tanks):
        if tank.get("logged") or tank.get("dismissed") or "id" not in tank:
            continue
        fill = tank["fill_odometer"]
        if fill - SENSOR_FILL_MATCH_MILES <= odometer <= fill + SENSOR_FILL_LOGGED_LATE_MILES:
            return tank
    return None


def pending_fill_up(sensor_tanks: list[dict]) -> dict | None:
    """The latest sensor-seen fill-up nobody has logged or dismissed."""
    for tank in reversed(sensor_tanks):
        if "id" in tank and not tank.get("logged") and not tank.get("dismissed"):
            return tank
    return None


def exceeds_tank_range(
    miles: float, tank_capacity_gal: float | None, avg_mpg: float | None
) -> bool:
    """Whether a logged full tank's miles since the last one are more than a
    tank could cover - a fill-up was skipped somewhere in between."""
    if not tank_capacity_gal or not avg_mpg:
        return False
    return miles > TANK_RANGE_SLACK * tank_capacity_gal * avg_mpg


# -------------------------------------------------------------------- tires

TIRE_POSITIONS = ("fl", "fr", "rl", "rr")
TIRE_NAMES = {"fl": "front left", "fr": "front right", "rl": "rear left", "rr": "rear right"}
# Low without a target set on the vehicle; with one, this far under it.
TIRE_LOW_DEFAULT_PSI = 30
TIRE_LOW_MARGIN_PSI = 4
TIRE_UNEVEN_PSI = 4
# A tire losing this much more than the others over TIRE_LEAK_DAYS is leaking.
TIRE_LEAK_PSI = 2
TIRE_LEAK_DAYS = 7
TIRE_HISTORY_DAYS = 30


def record_tire_history(history: list[dict], date_str: str, pressures: dict) -> bool:
    """Keep the day's first full set of readings (cold tires, before driving
    warms them) for slow-leak trends. Returns whether it added one."""
    if any(p not in pressures for p in TIRE_POSITIONS):
        return False
    if history and history[-1]["date"] == date_str:
        return False
    history.append({"date": date_str, **{p: pressures[p] for p in TIRE_POSITIONS}})
    del history[:-TIRE_HISTORY_DAYS]
    return True


def _deficit(reading: dict, position: str) -> float:
    others = [reading[p] for p in TIRE_POSITIONS if p != position]
    return sum(others) / len(others) - reading[position]


def tire_alerts(
    pressures: dict, target_psi: float | None, history: list[dict], today: date
) -> list[dict]:
    """Low tires, uneven pressures and slow leaks, as {key, kind, message}.
    `key` stays the same while the problem lasts, so it's notified once."""
    alerts: list[dict] = []
    low_below = target_psi - TIRE_LOW_MARGIN_PSI if target_psi else TIRE_LOW_DEFAULT_PSI
    for position in TIRE_POSITIONS:
        psi = pressures.get(position)
        if psi is not None and psi < low_below:
            alerts.append({
                "key": f"low_{position}",
                "kind": "low",
                "message": f"{TIRE_NAMES[position].capitalize()} tire is low ({psi:g} psi)",
            })
    readings = [pressures[p] for p in TIRE_POSITIONS if p in pressures]
    if len(readings) >= 2 and max(readings) - min(readings) >= TIRE_UNEVEN_PSI:
        alerts.append({
            "key": "uneven",
            "kind": "uneven",
            "message": f"Tire pressures are uneven ({min(readings):g}-{max(readings):g} psi)",
        })
    cutoff = (today - timedelta(days=TIRE_LEAK_DAYS)).isoformat()
    then = next((h for h in reversed(history) if h["date"] <= cutoff), None)
    if then is not None and all(p in pressures for p in TIRE_POSITIONS):
        for position in TIRE_POSITIONS:
            if _deficit(pressures, position) - _deficit(then, position) >= TIRE_LEAK_PSI:
                alerts.append({
                    "key": f"leak_{position}",
                    "kind": "leak",
                    "message": (
                        f"{TIRE_NAMES[position].capitalize()} tire may have a slow leak "
                        f"(losing pressure faster than the others since {then['date']})"
                    ),
                })
    return alerts


# ------------------------------------------------------------ trouble codes

_TROUBLE_CODE = re.compile(r"\b[PBCU][0-9A-F]{4}\b")
_TRUTHY = {"1", "true", "on", "yes"}


def parse_trouble_codes(state: dict | None) -> tuple[list[str], bool | None] | None:
    """(codes, check engine light) from a trouble-code sensor's state - its
    state text holds the codes ("P0420 P0171", or "All clear"), and a
    `check_engine_light` / `mil` attribute the light. None when the sensor
    has no usable reading."""
    if not state or str(state.get("state")) in ("unavailable", "unknown", "None"):
        return None
    codes = list(dict.fromkeys(_TROUBLE_CODE.findall(str(state.get("state", "")).upper())))
    attributes = state.get("attributes") or {}
    light = attributes.get("check_engine_light", attributes.get("mil"))
    mil = None if light is None else str(light).strip().lower() in _TRUTHY
    return codes, mil


def average_price_per_gallon(fuel_entries: list[FuelEntry]) -> float | None:
    values = [e.price_per_gallon for e in fuel_entries if e.price_per_gallon]
    if not values:
        return None
    return round(sum(values) / len(values), 3)


def total_fuel_cost(fuel_entries: list[FuelEntry]) -> float:
    return round(sum(e.amount_dollars for e in fuel_entries), 2)


def total_maintenance_cost(records: list[MaintenanceRecord]) -> float:
    return round(sum(r.cost for r in records), 2)


def spend_in_period(
    entries_with_dates_and_costs: list[tuple[str, float]],
    year: int,
    month: int | None = None,
) -> float:
    total = 0.0
    for date_str, cost in entries_with_dates_and_costs:
        d = parse_date(date_str)
        if d is None:
            continue
        if d.year == year and (month is None or d.month == month):
            total += cost
    return round(total, 2)


def estimated_range_miles(
    tank_capacity_gal: float | None,
    current_fuel_pct: float | None,
    avg_mpg: float | None,
) -> float | None:
    if tank_capacity_gal is None or current_fuel_pct is None or avg_mpg is None:
        return None
    return round(tank_capacity_gal * current_fuel_pct * avg_mpg, 1)


def maintenance_due_status(
    template: MaintenanceTemplate,
    current_mileage: int,
    last_record: MaintenanceRecord | None,
    today: date,
) -> dict:
    """Return due/due_soon flags plus the computed due-at mileage/date and remaining amounts."""
    last_mileage = last_record.odometer if last_record else 0
    last_date = parse_date(last_record.date) if last_record else None

    due_at_mileage = None
    miles_remaining = None
    if template.basis in ("mileage", "both") and template.interval_miles:
        due_at_mileage = last_mileage + template.interval_miles
        miles_remaining = due_at_mileage - current_mileage

    due_at_date = None
    days_remaining = None
    if template.basis in ("time", "both") and template.interval_months:
        base_date = last_date or today
        due_at_date = _add_months(base_date, template.interval_months)
        days_remaining = (due_at_date - today).days

    due = False
    due_soon = False
    if miles_remaining is not None and miles_remaining <= 0:
        due = True
    if days_remaining is not None and days_remaining <= 0:
        due = True
    if not due:
        if miles_remaining is not None and miles_remaining <= MAINTENANCE_DUE_SOON_MILES:
            due_soon = True
        if days_remaining is not None and days_remaining <= MAINTENANCE_DUE_SOON_DAYS:
            due_soon = True

    return {
        "template_id": template.id,
        "name": template.name,
        "due": due,
        "due_soon": due_soon,
        "due_at_mileage": due_at_mileage,
        "due_at_date": due_at_date.isoformat() if due_at_date else None,
        "miles_remaining": miles_remaining,
        "days_remaining": days_remaining,
    }


def _add_months(d: date, months: int) -> date:
    month_index = d.month - 1 + months
    year = d.year + month_index // 12
    month = month_index % 12 + 1
    day = min(d.day, _days_in_month(year, month))
    return date(year, month, day)


def _days_in_month(year: int, month: int) -> int:
    if month == 12:
        return 31
    return (date(year, month + 1, 1) - date(year, month, 1)).days


def health_score_deductions(
    *,
    vehicle: Vehicle,
    maintenance_statuses: list[dict],
    today: date,
    low_fuel_threshold: float,
) -> list[dict]:
    """Itemized reasons a vehicle's health score is below 100, as {reason, points}.

    Registration and insurance are deliberately left out - they're paperwork
    reminders surfaced as notifications, not a measure of the vehicle's condition.
    """
    deductions: list[dict] = []

    def deduct(reason: str, points: int) -> None:
        deductions.append({"reason": reason, "points": points})

    for status in maintenance_statuses:
        if status["name"].strip().lower() in HEALTH_SCORE_EXCLUDED_TEMPLATE_NAMES:
            continue
        if status["due"]:
            deduct(f"{status['name']} overdue", HEALTH_SCORE_DEDUCT_OVERDUE_MAINTENANCE)
        elif status["due_soon"]:
            deduct(f"{status['name']} due soon", HEALTH_SCORE_DEDUCT_MAINTENANCE_DUE_SOON)

    if vehicle.current_fuel_pct is not None and vehicle.current_fuel_pct <= low_fuel_threshold:
        deduct("Low fuel", HEALTH_SCORE_DEDUCT_LOW_FUEL)

    for alert in tire_alerts(
        vehicle.tire_pressures, vehicle.tire_target_psi, vehicle.tire_history, today
    ):
        points = (
            HEALTH_SCORE_DEDUCT_LOW_TIRE
            if alert["kind"] == "low"
            else HEALTH_SCORE_DEDUCT_TIRE_WARNING
        )
        deduct(alert["message"], points)

    if vehicle.trouble_codes:
        codes = ", ".join(vehicle.trouble_codes)
        if vehicle.check_engine_light:
            deduct(f"Check engine light: {codes}", HEALTH_SCORE_DEDUCT_CHECK_ENGINE)
        else:
            deduct(f"Trouble codes: {codes}", HEALTH_SCORE_DEDUCT_TROUBLE_CODES)

    return deductions


def compute_health_score(
    *,
    vehicle: Vehicle,
    maintenance_statuses: list[dict],
    today: date,
    low_fuel_threshold: float,
) -> int:
    deductions = health_score_deductions(
        vehicle=vehicle,
        maintenance_statuses=maintenance_statuses,
        today=today,
        low_fuel_threshold=low_fuel_threshold,
    )
    score = HEALTH_SCORE_START - sum(d["points"] for d in deductions)
    return max(0, min(100, score))
