from __future__ import annotations

import uuid
from dataclasses import dataclass, field


def new_id() -> str:
    return uuid.uuid4().hex


@dataclass
class Vehicle:
    id: str
    nickname: str
    year: int
    make: str
    model: str
    trim: str = ""
    vin: str = ""
    license_plate: str = ""
    title_number: str = ""
    color: str = ""
    current_mileage: int = 0
    fuel_type: str = "gasoline"
    tank_capacity_gal: float | None = None
    oil_capacity_qt: float | None = None
    tire_size: str = ""
    drivetrain: str = "fwd"
    notes: str = ""
    photo_path: str | None = None
    status: str = "active"
    current_fuel_pct: float | None = None
    registration_expires: str | None = None
    insurance_expires: str | None = None
    primary_driver_id: str | None = None
    additional_driver_ids: list[str] = field(default_factory=list)
    # Home Assistant sensors (e.g. a WiCAN OBD dongle's) that keep
    # current_mileage / current_fuel_pct live - see obd.py.
    odometer_entity_id: str = ""
    fuel_level_entity_id: str = ""
    # Gear (Park ends a trip - see obd.py), the four tire pressure sensors
    # keyed fl/fr/rl/rr, and a trouble-code sensor.
    gear_entity_id: str = ""
    tire_entity_ids: dict[str, str] = field(default_factory=dict)
    tire_target_psi: float | None = None
    trouble_codes_entity_id: str = ""
    # The fuel sensor's view of fill-ups - see logic.track_sensor_tank.
    tank_tracking: dict = field(default_factory=dict)
    sensor_tanks: list[dict] = field(default_factory=list)
    # Latest tire pressures (psi, keyed like tire_entity_ids), one reading a
    # day for slow-leak trends, and which tire alerts were already sent.
    tire_pressures: dict[str, float] = field(default_factory=dict)
    tire_history: list[dict] = field(default_factory=list)
    tire_alerts_notified: list[str] = field(default_factory=list)
    trouble_codes: list[str] = field(default_factory=list)
    check_engine_light: bool | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "nickname": self.nickname,
            "year": self.year,
            "make": self.make,
            "model": self.model,
            "trim": self.trim,
            "vin": self.vin,
            "license_plate": self.license_plate,
            "title_number": self.title_number,
            "color": self.color,
            "current_mileage": self.current_mileage,
            "fuel_type": self.fuel_type,
            "tank_capacity_gal": self.tank_capacity_gal,
            "oil_capacity_qt": self.oil_capacity_qt,
            "tire_size": self.tire_size,
            "drivetrain": self.drivetrain,
            "notes": self.notes,
            "photo_path": self.photo_path,
            "status": self.status,
            "current_fuel_pct": self.current_fuel_pct,
            "registration_expires": self.registration_expires,
            "insurance_expires": self.insurance_expires,
            "primary_driver_id": self.primary_driver_id,
            "additional_driver_ids": list(self.additional_driver_ids),
            "odometer_entity_id": self.odometer_entity_id,
            "fuel_level_entity_id": self.fuel_level_entity_id,
            "gear_entity_id": self.gear_entity_id,
            "tire_entity_ids": dict(self.tire_entity_ids),
            "tire_target_psi": self.tire_target_psi,
            "trouble_codes_entity_id": self.trouble_codes_entity_id,
            "tank_tracking": dict(self.tank_tracking),
            "sensor_tanks": [dict(t) for t in self.sensor_tanks],
            "tire_pressures": dict(self.tire_pressures),
            "tire_history": [dict(h) for h in self.tire_history],
            "tire_alerts_notified": list(self.tire_alerts_notified),
            "trouble_codes": list(self.trouble_codes),
            "check_engine_light": self.check_engine_light,
        }

    @staticmethod
    def from_dict(data: dict) -> Vehicle:
        return Vehicle(
            id=data["id"],
            nickname=data["nickname"],
            year=int(data["year"]),
            make=data["make"],
            model=data["model"],
            trim=data.get("trim", ""),
            vin=data.get("vin", ""),
            license_plate=data.get("license_plate", ""),
            title_number=data.get("title_number", ""),
            color=data.get("color", ""),
            current_mileage=int(data.get("current_mileage", 0)),
            fuel_type=data.get("fuel_type", "gasoline"),
            tank_capacity_gal=data.get("tank_capacity_gal"),
            oil_capacity_qt=data.get("oil_capacity_qt"),
            tire_size=data.get("tire_size", ""),
            drivetrain=data.get("drivetrain", "fwd"),
            notes=data.get("notes", ""),
            photo_path=data.get("photo_path"),
            status=data.get("status", "active"),
            current_fuel_pct=data.get("current_fuel_pct"),
            registration_expires=data.get("registration_expires"),
            insurance_expires=data.get("insurance_expires"),
            primary_driver_id=data.get("primary_driver_id"),
            additional_driver_ids=list(data.get("additional_driver_ids", [])),
            odometer_entity_id=data.get("odometer_entity_id", ""),
            fuel_level_entity_id=data.get("fuel_level_entity_id", ""),
            gear_entity_id=data.get("gear_entity_id", ""),
            tire_entity_ids=dict(data.get("tire_entity_ids") or {}),
            tire_target_psi=data.get("tire_target_psi"),
            trouble_codes_entity_id=data.get("trouble_codes_entity_id", ""),
            tank_tracking=dict(data.get("tank_tracking") or {}),
            sensor_tanks=[dict(t) for t in data.get("sensor_tanks") or []],
            tire_pressures=dict(data.get("tire_pressures") or {}),
            tire_history=[dict(h) for h in data.get("tire_history") or []],
            tire_alerts_notified=list(data.get("tire_alerts_notified") or []),
            trouble_codes=list(data.get("trouble_codes") or []),
            check_engine_light=data.get("check_engine_light"),
        )


@dataclass
class Driver:
    id: str
    name: str
    ha_user_id: str | None = None
    notify_target: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "ha_user_id": self.ha_user_id,
            "notify_target": self.notify_target,
        }

    @staticmethod
    def from_dict(data: dict) -> Driver:
        return Driver(
            id=data["id"],
            name=data["name"],
            ha_user_id=data.get("ha_user_id"),
            notify_target=data.get("notify_target"),
        )


@dataclass
class FuelEntry:
    id: str
    vehicle_id: str
    date: str
    odometer: int
    amount_dollars: float
    fuel_grade: str = "regular"
    station: str = ""
    payment_method: str = "credit_card"
    full_tank: bool = True
    receipt_photo_path: str | None = None
    notes: str = ""
    gallons_added: float | None = None
    price_per_gallon: float | None = None
    mpg: float | None = None
    finance_expense_id: str | None = None
    # "I missed logging the fill-up before this one" - its miles span more
    # than the gallons added, so it gets no mpg.
    missed_fill_before: bool = False

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "vehicle_id": self.vehicle_id,
            "date": self.date,
            "odometer": self.odometer,
            "amount_dollars": self.amount_dollars,
            "fuel_grade": self.fuel_grade,
            "station": self.station,
            "payment_method": self.payment_method,
            "full_tank": self.full_tank,
            "receipt_photo_path": self.receipt_photo_path,
            "notes": self.notes,
            "gallons_added": self.gallons_added,
            "price_per_gallon": self.price_per_gallon,
            "mpg": self.mpg,
            "finance_expense_id": self.finance_expense_id,
            "missed_fill_before": self.missed_fill_before,
        }

    @staticmethod
    def from_dict(data: dict) -> FuelEntry:
        return FuelEntry(
            id=data["id"],
            vehicle_id=data["vehicle_id"],
            date=data["date"],
            odometer=int(data["odometer"]),
            amount_dollars=float(data["amount_dollars"]),
            fuel_grade=data.get("fuel_grade", "regular"),
            station=data.get("station", ""),
            payment_method=data.get("payment_method", "credit_card"),
            full_tank=bool(data.get("full_tank", True)),
            receipt_photo_path=data.get("receipt_photo_path"),
            notes=data.get("notes", ""),
            gallons_added=data.get("gallons_added"),
            finance_expense_id=data.get("finance_expense_id"),
            price_per_gallon=data.get("price_per_gallon"),
            mpg=data.get("mpg"),
            missed_fill_before=bool(data.get("missed_fill_before", False)),
        )


@dataclass
class MaintenanceTemplate:
    id: str
    name: str
    basis: str = "mileage"
    interval_miles: int | None = None
    interval_months: int | None = None
    is_custom: bool = True

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "basis": self.basis,
            "interval_miles": self.interval_miles,
            "interval_months": self.interval_months,
            "is_custom": self.is_custom,
        }

    @staticmethod
    def from_dict(data: dict) -> MaintenanceTemplate:
        return MaintenanceTemplate(
            id=data["id"],
            name=data["name"],
            basis=data.get("basis", "mileage"),
            interval_miles=data.get("interval_miles"),
            interval_months=data.get("interval_months"),
            is_custom=bool(data.get("is_custom", True)),
        )


@dataclass
class MaintenanceRecord:
    id: str
    vehicle_id: str
    template_id: str | None
    name: str
    date: str
    odometer: int
    cost: float = 0.0
    parts_cost: float = 0.0
    labor_cost: float = 0.0
    performed_by: str = "shop"
    shop_name: str = ""
    photo_paths: list[str] = field(default_factory=list)
    receipt_paths: list[str] = field(default_factory=list)
    wheel_positions: list[str] = field(default_factory=list)
    notes: str = ""
    finance_expense_id: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "vehicle_id": self.vehicle_id,
            "template_id": self.template_id,
            "name": self.name,
            "date": self.date,
            "odometer": self.odometer,
            "cost": self.cost,
            "parts_cost": self.parts_cost,
            "labor_cost": self.labor_cost,
            "performed_by": self.performed_by,
            "shop_name": self.shop_name,
            "photo_paths": list(self.photo_paths),
            "receipt_paths": list(self.receipt_paths),
            "wheel_positions": list(self.wheel_positions),
            "notes": self.notes,
            "finance_expense_id": self.finance_expense_id,
        }

    @staticmethod
    def from_dict(data: dict) -> MaintenanceRecord:
        return MaintenanceRecord(
            id=data["id"],
            vehicle_id=data["vehicle_id"],
            template_id=data.get("template_id"),
            name=data["name"],
            date=data["date"],
            odometer=int(data.get("odometer", 0)),
            cost=float(data.get("cost", 0.0)),
            parts_cost=float(data.get("parts_cost", 0.0)),
            labor_cost=float(data.get("labor_cost", 0.0)),
            performed_by=data.get("performed_by", "shop"),
            shop_name=data.get("shop_name", ""),
            photo_paths=list(data.get("photo_paths", [])),
            receipt_paths=list(data.get("receipt_paths", [])),
            wheel_positions=list(data.get("wheel_positions", [])),
            notes=data.get("notes", ""),
            finance_expense_id=data.get("finance_expense_id"),
        )


@dataclass
class Document:
    id: str
    vehicle_id: str
    category: str
    filename: str
    path: str
    uploaded_at: str

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "vehicle_id": self.vehicle_id,
            "category": self.category,
            "filename": self.filename,
            "path": self.path,
            "uploaded_at": self.uploaded_at,
        }

    @staticmethod
    def from_dict(data: dict) -> Document:
        return Document(
            id=data["id"],
            vehicle_id=data["vehicle_id"],
            category=data["category"],
            filename=data["filename"],
            path=data["path"],
            uploaded_at=data["uploaded_at"],
        )
