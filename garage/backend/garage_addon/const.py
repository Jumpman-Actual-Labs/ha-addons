from __future__ import annotations

from enum import StrEnum

DOMAIN = "garage"
STORAGE_VERSION = 1
STORAGE_KEY = f"{DOMAIN}_data"

SIGNAL_GARAGE_UPDATED = f"{DOMAIN}_updated"


class VehicleStatus(StrEnum):
    ACTIVE = "active"
    STORED = "stored"
    SOLD = "sold"
    PROJECT = "project"


class Drivetrain(StrEnum):
    FWD = "fwd"
    RWD = "rwd"
    AWD = "awd"
    FOUR_WD = "4wd"


class WheelPosition(StrEnum):
    FRONT_LEFT = "front_left"
    FRONT_RIGHT = "front_right"
    REAR_LEFT = "rear_left"
    REAR_RIGHT = "rear_right"


class FuelType(StrEnum):
    GASOLINE = "gasoline"
    DIESEL = "diesel"
    ELECTRIC = "electric"
    HYBRID = "hybrid"
    FLEX = "flex"


class FuelGrade(StrEnum):
    REGULAR = "regular"
    MIDGRADE = "midgrade"
    PREMIUM = "premium"
    DIESEL = "diesel"
    ELECTRIC = "electric"


class PaymentMethod(StrEnum):
    CASH = "cash"
    CREDIT_CARD = "credit_card"
    DEBIT_CARD = "debit_card"
    OTHER = "other"


class MaintenanceBasis(StrEnum):
    MILEAGE = "mileage"
    TIME = "time"
    BOTH = "both"


class MaintenancePerformedBy(StrEnum):
    DIY = "diy"
    SHOP = "shop"


class DocumentCategory(StrEnum):
    REGISTRATION = "registration"
    INSURANCE = "insurance"
    RECEIPT = "receipt"
    PHOTO = "photo"
    OTHER = "other"


# Built-in maintenance templates: (name, default basis, mileage interval, months interval)
def _template(name: str, basis: MaintenanceBasis, miles: int | None, months: int | None) -> dict:
    return {"name": name, "basis": basis, "interval_miles": miles, "interval_months": months}


DEFAULT_MAINTENANCE_TEMPLATES: list[dict] = [
    _template("Oil Change", MaintenanceBasis.BOTH, 5000, 6),
    _template("Tire Rotation", MaintenanceBasis.BOTH, 6000, 6),
    _template("New Tires", MaintenanceBasis.MILEAGE, 50000, None),
    _template("Engine Air Filter", MaintenanceBasis.BOTH, 15000, 12),
    _template("Cabin Air Filter", MaintenanceBasis.BOTH, 15000, 12),
    _template("Brake Pads", MaintenanceBasis.MILEAGE, 30000, None),
    _template("Brake Fluid", MaintenanceBasis.TIME, None, 24),
    _template("Coolant", MaintenanceBasis.BOTH, 30000, 60),
    _template("Transmission Service", MaintenanceBasis.BOTH, 30000, 36),
    _template("Differential Service", MaintenanceBasis.MILEAGE, 30000, None),
    _template("Transfer Case Service", MaintenanceBasis.MILEAGE, 30000, None),
    _template("Spark Plugs", MaintenanceBasis.MILEAGE, 30000, None),
    _template("Battery", MaintenanceBasis.TIME, None, 48),
    _template("Inspection", MaintenanceBasis.TIME, None, 12),
    _template("Registration", MaintenanceBasis.TIME, None, 12),
    _template("Insurance Renewal", MaintenanceBasis.TIME, None, 6),
]

# Health score weights (points deducted). Kept as constants so they're easy
# to retune without touching the scoring algorithm itself.
HEALTH_SCORE_START = 100
HEALTH_SCORE_DEDUCT_OVERDUE_MAINTENANCE = 15
HEALTH_SCORE_DEDUCT_MAINTENANCE_DUE_SOON = 5
HEALTH_SCORE_DEDUCT_LOW_FUEL = 5

# Paperwork, not mechanical condition: these maintenance items still show up
# as due/overdue notifications but never count against the health score.
# Matched case-insensitively against the template name.
HEALTH_SCORE_EXCLUDED_TEMPLATE_NAMES = frozenset({"registration", "insurance renewal"})

LOW_FUEL_THRESHOLD_DEFAULT = 0.20
MAINTENANCE_DUE_SOON_MILES = 500
MAINTENANCE_DUE_SOON_DAYS = 14
