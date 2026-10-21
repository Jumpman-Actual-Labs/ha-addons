"""Deserialization resilience - a Store document can contain data written by
an older version of an add-flow that didn't normalize "" to None (see
coordinator._normalize_fields), so from_dict must never crash on a stray
string in an optional numeric field."""
from __future__ import annotations

from cache_addon.models import Ammunition, Firearm, InventoryItem, RangeSchedule


def test_ammunition_from_dict_tolerates_blank_string_low_inventory_threshold():
    ammo = Ammunition.from_dict(
        {"id": "a1", "caliber": "9mm", "low_inventory_threshold": "", "cost_per_round": ""}
    )
    assert ammo.low_inventory_threshold is None
    assert ammo.cost_per_round is None


def test_ammunition_from_dict_coerces_numeric_strings():
    ammo = Ammunition.from_dict(
        {"id": "a1", "caliber": "9mm", "low_inventory_threshold": "50", "cost_per_round": "0.35"}
    )
    assert ammo.low_inventory_threshold == 50
    assert ammo.cost_per_round == 0.35


def test_firearm_from_dict_tolerates_blank_string_prices():
    firearm = Firearm.from_dict(
        {
            "id": "f1",
            "custom_name": "Test",
            "firearm_type": "Rifle",
            "purchase_price": "",
            "current_estimated_value": "",
        }
    )
    assert firearm.purchase_price is None
    assert firearm.current_estimated_value is None


def test_inventory_item_from_dict_tolerates_blank_string_prices():
    item = InventoryItem.from_dict(
        {
            "id": "i1",
            "custom_name": "Optic",
            "category": "Optic",
            "purchase_price": "",
            "estimated_value": "",
        }
    )
    assert item.purchase_price is None
    assert item.estimated_value is None


def test_range_schedule_target_from_dict_tolerates_blank_string_rounds_min():
    schedule = RangeSchedule.from_dict(
        {
            "id": "s1",
            "frequency": "quarterly",
            "targets": [{"target_type": "caliber", "caliber": "9mm", "rounds_min": ""}],
        }
    )
    assert schedule.targets[0].rounds_min is None


def test_range_schedule_from_dict_reads_new_targets_shape():
    schedule = RangeSchedule.from_dict(
        {
            "id": "s1",
            "frequency": "quarterly",
            "targets": [
                {"target_type": "caliber", "caliber": "300 BLK"},
                {"target_type": "caliber", "caliber": "5.56"},
            ],
        }
    )
    assert [t.caliber for t in schedule.targets] == ["300 BLK", "5.56"]


def test_range_schedule_from_dict_synthesizes_target_from_old_singular_shape():
    # Data written before the multi-target redesign - no "targets" key, just
    # the old top-level target_type/target_firearm_type/etc. fields.
    schedule = RangeSchedule.from_dict(
        {
            "id": "s1",
            "target_type": "firearm_type",
            "target_firearm_type": "Shotgun",
            "frequency": "quarterly",
        }
    )
    assert len(schedule.targets) == 1
    assert schedule.targets[0].target_type == "firearm_type"
    assert schedule.targets[0].firearm_type == "Shotgun"


def test_range_schedule_to_dict_always_emits_new_targets_shape():
    schedule = RangeSchedule.from_dict(
        {
            "id": "s1",
            "target_type": "caliber",
            "target_caliber": "9mm",
            "frequency": "monthly",
        }
    )
    data = schedule.to_dict()
    assert "targets" in data
    assert "target_type" not in data
    assert data["targets"] == [
        {
            "target_type": "caliber",
            "firearm_id": None,
            "firearm_type": None,
            "caliber": "9mm",
            "speed_class": None,
            "bullet_type": None,
            "rounds_min": None,
        }
    ]
