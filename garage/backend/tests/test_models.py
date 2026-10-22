from __future__ import annotations

from garage_addon.models import MaintenanceRecord, Vehicle


def test_title_number_preserves_leading_zeroes_and_can_be_cleared():
    vehicle = Vehicle(id="v1", nickname="Truck", year=2022, make="Ram", model="1500",
                      title_number="001234ABC")
    assert Vehicle.from_dict(vehicle.to_dict()).title_number == "001234ABC"
    vehicle.title_number = ""
    assert Vehicle.from_dict(vehicle.to_dict()).title_number == ""


def test_existing_vehicle_without_title_number_loads():
    vehicle = Vehicle.from_dict({"id": "v1", "nickname": "Truck", "year": 2022,
                                 "make": "Ram", "model": "1500"})
    assert vehicle.title_number == ""


def test_vehicle_drivetrain_round_trips_through_dict():
    vehicle = Vehicle(
        id="v1", nickname="Ram", year=2022, make="Ram", model="1500", drivetrain="4wd"
    )
    restored = Vehicle.from_dict(vehicle.to_dict())
    assert restored.drivetrain == "4wd"


def test_vehicle_drivetrain_defaults_to_fwd_when_missing():
    restored = Vehicle.from_dict(
        {"id": "v1", "nickname": "Ram", "year": 2022, "make": "Ram", "model": "1500"}
    )
    assert restored.drivetrain == "fwd"


def test_maintenance_record_wheel_positions_round_trip():
    record = MaintenanceRecord(
        id="m1",
        vehicle_id="v1",
        template_id=None,
        name="Tires",
        date="2026-01-01",
        odometer=40000,
        wheel_positions=["front_left", "front_right"],
    )
    restored = MaintenanceRecord.from_dict(record.to_dict())
    assert restored.wheel_positions == ["front_left", "front_right"]


def test_maintenance_record_wheel_positions_defaults_to_empty():
    restored = MaintenanceRecord.from_dict(
        {
            "id": "m1",
            "vehicle_id": "v1",
            "template_id": None,
            "name": "Oil Change",
            "date": "2026-01-01",
            "odometer": 1000,
        }
    )
    assert restored.wheel_positions == []
