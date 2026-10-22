"""Pure functions (no Home Assistant imports). Keep new business logic here,
not in coordinator.py, so it stays unit-testable without the HA test harness.
"""
from __future__ import annotations

from datetime import date, datetime

from .const import (
    HEALTH_SCORE_DEDUCT_LOW_FUEL,
    HEALTH_SCORE_DEDUCT_MAINTENANCE_DUE_SOON,
    HEALTH_SCORE_DEDUCT_OVERDUE_MAINTENANCE,
    HEALTH_SCORE_EXCLUDED_TEMPLATE_NAMES,
    HEALTH_SCORE_START,
    MAINTENANCE_DUE_SOON_DAYS,
    MAINTENANCE_DUE_SOON_MILES,
)
from .models import FuelEntry, MaintenanceRecord, MaintenanceTemplate, Vehicle


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


def average_mpg(fuel_entries: list[FuelEntry]) -> float | None:
    values = [e.mpg for e in fuel_entries if e.mpg]
    if not values:
        return None
    return round(sum(values) / len(values), 2)


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
