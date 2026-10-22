from __future__ import annotations

import datetime

import pytest

from cache_addon import logic
from cache_addon.models import (
    AmmoAlertRule,
    Ammunition,
    CacheSettings,
    Firearm,
    InventoryItem,
    RangeSchedule,
    RangeScheduleTarget,
    RangeSessionFirearmEntry,
    TrainingPlan,
    TrainingPlanStep,
)


def _firearm(**overrides) -> Firearm:
    defaults = dict(id="f1", custom_name="Test AR", firearm_type="Rifle")
    defaults.update(overrides)
    return Firearm(**defaults)


def _target(**overrides) -> RangeScheduleTarget:
    defaults = dict(target_type="firearm_type", firearm_type="Shotgun")
    defaults.update(overrides)
    return RangeScheduleTarget(**defaults)


def _schedule(targets=None, **overrides) -> RangeSchedule:
    defaults = dict(id="s1", targets=targets or [_target()], frequency="quarterly")
    defaults.update(overrides)
    return RangeSchedule(**defaults)


def _step(**overrides) -> TrainingPlanStep:
    defaults = dict(id="st1", label="Step 1", targets=[_target()])
    defaults.update(overrides)
    return TrainingPlanStep(**defaults)


def _plan(steps=None, **overrides) -> TrainingPlan:
    defaults = dict(id="p1", label="Plan", mode="sequential", steps=steps or [_step()])
    defaults.update(overrides)
    return TrainingPlan(**defaults)


def _months_ago(n: int) -> tuple[int, int]:
    """Returns (month, year) n calendar months before today - used to build
    calendar-mode plans whose current step index is deterministic regardless
    of when the test suite runs."""
    today = datetime.date.today()
    total = today.year * 12 + (today.month - 1) - n
    return total % 12 + 1, total // 12


def test_diagram_type_mapping():
    assert logic.diagram_type_for("Rifle") == "ar_platform"
    assert logic.diagram_type_for("Bolt Action") == "bolt_action"
    assert logic.diagram_type_for("Revolver") == "revolver"
    assert logic.diagram_type_for("Shotgun") == "shotgun"
    assert logic.diagram_type_for("Handgun") == "handgun"
    assert logic.diagram_type_for("AR Pistol") == "ar_pistol"
    assert logic.diagram_type_for("SBR") == "ar_platform"
    assert logic.diagram_type_for("Unknown Type") == "ar_platform"


def test_migrate_inventory_item_taxonomy_splits_retained_category():
    data = {"id": "i1", "custom_name": "EOTech", "category": "Optic Mount"}
    migrated = logic.migrate_inventory_item_taxonomy(data)
    assert migrated["part_type"] == "Optic Mount"
    assert migrated["category"] == "Optic"


def test_migrate_inventory_item_taxonomy_falls_back_for_dropped_category():
    data = {"id": "i1", "custom_name": "Rifle Sling", "category": "Sling"}
    migrated = logic.migrate_inventory_item_taxonomy(data)
    assert migrated["part_type"] == "Other / Miscellaneous"
    assert migrated["category"] == "Accessory"


def test_migrate_inventory_item_taxonomy_uninstalls_dropped_magazine_slot():
    data = {
        "id": "i1",
        "custom_name": "PMAG",
        "category": "Magazine",
        "installed_slot_type": "Magazine",
        "installed_firearm_id": "f1",
        "installed_at": "2026-01-01T00:00:00",
    }
    migrated = logic.migrate_inventory_item_taxonomy(data)
    assert migrated["part_type"] == "Other / Miscellaneous"
    assert migrated["installed_slot_type"] is None
    assert migrated["installed_firearm_id"] is None
    assert migrated["installed_at"] is None


def test_migrate_inventory_item_taxonomy_leaves_retained_install_slot_alone():
    data = {
        "id": "i1",
        "custom_name": "EOTech",
        "category": "Optic",
        "installed_slot_type": "Optic",
        "installed_firearm_id": "f1",
    }
    migrated = logic.migrate_inventory_item_taxonomy(data)
    assert migrated["installed_slot_type"] == "Optic"
    assert migrated["installed_firearm_id"] == "f1"


def test_part_taxonomy_every_part_maps_back_to_its_category():
    from cache_addon.const import CATEGORY_FOR_PART, PART_TAXONOMY

    for category, parts in PART_TAXONOMY.items():
        for part in parts:
            assert CATEGORY_FOR_PART[part] == category


def test_needs_cleaning_never_cleaned_but_fired():
    settings = CacheSettings()
    firearm = _firearm(lifetime_round_count=10, last_cleaning_date=None)
    assert logic.needs_cleaning(firearm, settings) is True


def test_needs_cleaning_never_fired_or_cleaned():
    settings = CacheSettings()
    firearm = _firearm(lifetime_round_count=0, last_cleaning_date=None)
    assert logic.needs_cleaning(firearm, settings) is False


def test_needs_cleaning_by_round_count_threshold():
    settings = CacheSettings(cleaning_reminder_rounds=200, cleaning_reminder_days=9999)
    firearm = _firearm(
        lifetime_round_count=250, round_count_at_last_cleaning=0, last_cleaning_date="2020-01-01"
    )
    assert logic.needs_cleaning(firearm, settings) is True


def test_needs_cleaning_resets_after_cleaning():
    settings = CacheSettings(cleaning_reminder_rounds=200, cleaning_reminder_days=9999)
    today = datetime.date.today().isoformat()
    firearm = _firearm(
        lifetime_round_count=250, round_count_at_last_cleaning=250, last_cleaning_date=today
    )
    assert logic.needs_cleaning(firearm, settings) is False


def test_needs_cleaning_by_days_threshold():
    settings = CacheSettings(cleaning_reminder_rounds=999999, cleaning_reminder_days=30)
    old_date = (datetime.date.today() - datetime.timedelta(days=40)).isoformat()
    firearm = _firearm(
        lifetime_round_count=5, round_count_at_last_cleaning=5, last_cleaning_date=old_date
    )
    assert logic.needs_cleaning(firearm, settings) is True


def test_is_ammo_low_uses_custom_threshold():
    settings = CacheSettings(low_ammo_threshold_default=1000)
    ammo = Ammunition(id="a1", caliber="9mm", quantity=20, low_inventory_threshold=25)
    assert logic.is_ammo_low(ammo, settings, []) is True


def test_is_ammo_low_falls_back_to_default_threshold():
    settings = CacheSettings(low_ammo_threshold_default=500)
    ammo = Ammunition(id="a1", caliber=".308", quantity=100, low_inventory_threshold=None)
    assert logic.is_ammo_low(ammo, settings, []) is True


def _rule(**overrides) -> AmmoAlertRule:
    defaults = dict(id="r1", match_type="caliber", match_value="9mm", threshold=100)
    defaults.update(overrides)
    return AmmoAlertRule(**defaults)


def test_effective_threshold_entry_override_wins_over_rules():
    settings = CacheSettings(low_ammo_threshold_default=10)
    ammo = Ammunition(id="a1", caliber="9mm", quantity=50, low_inventory_threshold=5)
    rules = [_rule(match_type="caliber", match_value="9mm", threshold=1000)]
    assert logic.effective_low_ammo_threshold(ammo, settings, rules) == 5


def test_effective_threshold_matches_by_caliber():
    settings = CacheSettings(low_ammo_threshold_default=10)
    ammo = Ammunition(id="a1", caliber="9mm", quantity=50)
    rules = [_rule(match_type="caliber", match_value="9mm", threshold=200)]
    assert logic.effective_low_ammo_threshold(ammo, settings, rules) == 200


def test_effective_threshold_matches_by_bullet_type():
    settings = CacheSettings(low_ammo_threshold_default=10)
    ammo = Ammunition(id="a1", caliber="12 Gauge", bullet_type="Buckshot", quantity=50)
    rules = [_rule(match_type="bullet_type", match_value="Buckshot", threshold=25)]
    assert logic.effective_low_ammo_threshold(ammo, settings, rules) == 25


def test_effective_threshold_matches_by_speed_class():
    settings = CacheSettings(low_ammo_threshold_default=10)
    ammo = Ammunition(id="a1", caliber="9mm", muzzle_velocity="1000 fps", quantity=50)
    rules = [_rule(match_type="speed_class", match_value="Subsonic", threshold=75)]
    assert logic.effective_low_ammo_threshold(ammo, settings, rules) == 75


def test_effective_threshold_first_matching_rule_wins():
    settings = CacheSettings(low_ammo_threshold_default=10)
    ammo = Ammunition(id="a1", caliber="9mm", quantity=50)
    rules = [
        _rule(id="r1", match_type="caliber", match_value="9mm", threshold=200),
        _rule(id="r2", match_type="caliber", match_value="9mm", threshold=999),
    ]
    assert logic.effective_low_ammo_threshold(ammo, settings, rules) == 200


def test_effective_threshold_falls_back_to_default_when_no_rule_matches():
    settings = CacheSettings(low_ammo_threshold_default=10)
    ammo = Ammunition(id="a1", caliber="9mm", quantity=50)
    rules = [_rule(match_type="caliber", match_value=".308", threshold=999)]
    assert logic.effective_low_ammo_threshold(ammo, settings, rules) == 10


def test_is_ammo_low_uses_matching_rule():
    settings = CacheSettings(low_ammo_threshold_default=1000)
    ammo = Ammunition(id="a1", caliber="9mm", quantity=50)
    rules = [_rule(match_type="caliber", match_value="9mm", threshold=25)]
    assert logic.is_ammo_low(ammo, settings, rules) is False


def test_compute_cost_per_round():
    assert logic.compute_cost_per_round(20.0, 50) == 0.4


def test_compute_cost_per_round_none_when_missing_box_info():
    assert logic.compute_cost_per_round(20.0, None) is None
    assert logic.compute_cost_per_round(None, 50) is None
    assert logic.compute_cost_per_round(20.0, 0) is None


def test_speed_class_subsonic_at_threshold():
    assert logic.speed_class("1100 fps") == "Subsonic"


def test_speed_class_supersonic_above_threshold():
    assert logic.speed_class("2100 fps") == "Supersonic"


def test_speed_class_parses_various_formats():
    assert logic.speed_class("1,050 FPS") == "Subsonic"
    assert logic.speed_class("980") == "Subsonic"
    assert logic.speed_class("~1250fps") == "Supersonic"


def test_speed_class_none_when_unparseable_or_missing():
    assert logic.speed_class(None) is None
    assert logic.speed_class("") is None
    assert logic.speed_class("fast") is None


def test_effective_location_id_uninstalled_item():
    item = InventoryItem(id="i1", custom_name="Optic", category="Optic", storage_location_id="loc1")
    assert logic.effective_location_id(item, {}) == "loc1"


def test_effective_location_id_installed_item_follows_firearm():
    firearm = _firearm(storage_location_id="loc2")
    item = InventoryItem(
        id="i1",
        custom_name="Optic",
        category="Optic",
        installed_firearm_id="f1",
        storage_location_id=None,
    )
    assert logic.effective_location_id(item, {"f1": firearm}) == "loc2"


def test_validate_install_rejects_part_type_mismatch():
    item = InventoryItem(id="i1", custom_name="Stock", category="Stock", part_type="Stock")
    with pytest.raises(ValueError):
        logic.validate_install(item, "Optic")


def test_validate_install_rejects_slot_not_a_real_part_type():
    item = InventoryItem(id="i1", custom_name="Mag", category="Accessory", part_type="Handguard")
    with pytest.raises(ValueError):
        logic.validate_install(item, "Magazine")  # dropped from the taxonomy entirely


def test_validate_install_accepts_matching_part_type():
    item = InventoryItem(id="i1", custom_name="EOTech", category="Optic", part_type="Optic")
    logic.validate_install(item, "Optic")  # should not raise


def test_validate_range_session_ammo_rejects_insufficient_stock():
    ammo = Ammunition(id="a1", caliber="5.56", quantity=10)
    entries = [RangeSessionFirearmEntry(firearm_id="f1", ammunition_id="a1", rounds_fired=50)]
    with pytest.raises(ValueError):
        logic.validate_range_session_ammo(entries, {"a1": ammo})


def test_validate_range_session_ammo_sums_across_firearms():
    ammo = Ammunition(id="a1", caliber="5.56", quantity=100)
    entries = [
        RangeSessionFirearmEntry(firearm_id="f1", ammunition_id="a1", rounds_fired=40),
        RangeSessionFirearmEntry(firearm_id="f2", ammunition_id="a1", rounds_fired=40),
    ]
    needed = logic.validate_range_session_ammo(entries, {"a1": ammo})
    assert needed == {"a1": 80}


def test_validate_range_session_ammo_extra_available_covers_shortfall():
    # Simulates editing a session: current stock alone isn't enough, but
    # accounting for what the old session's usage would return is.
    ammo = Ammunition(id="a1", caliber="5.56", quantity=20)
    entries = [RangeSessionFirearmEntry(firearm_id="f1", ammunition_id="a1", rounds_fired=50)]
    needed = logic.validate_range_session_ammo(entries, {"a1": ammo}, extra_available={"a1": 40})
    assert needed == {"a1": 50}


def test_validate_range_session_ammo_extra_available_insufficient_still_rejects():
    ammo = Ammunition(id="a1", caliber="5.56", quantity=20)
    entries = [RangeSessionFirearmEntry(firearm_id="f1", ammunition_id="a1", rounds_fired=50)]
    with pytest.raises(ValueError):
        logic.validate_range_session_ammo(entries, {"a1": ammo}, extra_available={"a1": 10})


def test_dashboard_stats_counts_by_type_and_value():
    settings = CacheSettings()
    firearms = [
        _firearm(
            id="f1", firearm_type="Handgun", manufacturer="Glock", current_estimated_value=500
        ),
        _firearm(
            id="f2",
            firearm_type="Rifle",
            manufacturer="Daniel Defense",
            current_estimated_value=2000,
        ),
        _firearm(
            id="f3",
            firearm_type="SBR",
            is_nfa=True,
            manufacturer="BCM",
            current_estimated_value=1500,
        ),
    ]
    items = [
        InventoryItem(
            id="i1",
            custom_name="Suppressor",
            category="Muzzle",
            part_type="Suppressor",
            estimated_value=800,
        )
    ]
    ammo = [Ammunition(id="a1", caliber="9mm", quantity=250)]

    stats = logic.dashboard_stats(firearms, items, ammo, settings)
    assert stats["total_firearms"] == 3
    assert stats["handguns"] == 1
    assert stats["rifles"] == 1
    assert stats["nfa_items"] == 2  # 1 SBR firearm + 1 Suppressor item
    assert stats["total_collection_value"] == 500 + 2000 + 1500 + 800
    assert stats["total_ammunition"] == 250
    assert stats["by_manufacturer"]["Glock"] == 1


def test_dashboard_stats_excludes_wishlist_from_owned_totals():
    settings = CacheSettings()
    firearms = [
        _firearm(id="f1", firearm_type="Handgun", current_estimated_value=500),
        _firearm(
            id="f2",
            firearm_type="Rifle",
            current_estimated_value=3000,
            is_wishlist=True,
            wishlist_rank=0,
        ),
    ]
    items = [
        InventoryItem(id="i1", custom_name="Optic", category="Optic", estimated_value=200),
        InventoryItem(
            id="i2",
            custom_name="Wishlist Optic",
            category="Optic",
            estimated_value=400,
            is_wishlist=True,
        ),
    ]
    ammo: list[Ammunition] = []
    stats = logic.dashboard_stats(firearms, items, ammo, settings)
    assert stats["total_firearms"] == 1
    assert stats["total_collection_value"] == 700
    assert stats["wishlist_firearms_count"] == 1
    assert stats["wishlist_items_count"] == 1
    assert stats["wishlist_total_value"] == 3400


def test_dashboard_stats_wishlist_nfa_items_mirrors_owned_definition():
    settings = CacheSettings()
    firearms = [
        _firearm(id="f1", firearm_type="SBR", is_nfa=True, is_wishlist=False),
        _firearm(id="f2", firearm_type="SBR", is_nfa=True, is_wishlist=True),
    ]
    items = [
        InventoryItem(id="i1", custom_name="Owned Can", category="Muzzle", part_type="Suppressor"),
        InventoryItem(
            id="i2",
            custom_name="Wishlist Can",
            category="Muzzle",
            part_type="Suppressor",
            is_wishlist=True,
        ),
    ]
    ammo: list[Ammunition] = []
    stats = logic.dashboard_stats(firearms, items, ammo, settings)
    assert stats["nfa_items"] == 2  # 1 owned SBR + 1 owned Suppressor
    assert stats["wishlist_nfa_items"] == 2  # 1 wishlist SBR + 1 wishlist Suppressor


def test_dashboard_stats_top_wishlist_item_prefers_lower_rank_over_value():
    settings = CacheSettings()
    firearms = [
        _firearm(
            id="f1",
            custom_name="Expensive Rank 1 Rifle",
            is_wishlist=True,
            wishlist_rank=1,
            current_estimated_value=5000,
        ),
        _firearm(
            id="f2",
            custom_name="Cheap Rank 0 Pistol",
            is_wishlist=True,
            wishlist_rank=0,
            current_estimated_value=100,
        ),
    ]
    items: list[InventoryItem] = []
    ammo: list[Ammunition] = []
    stats = logic.dashboard_stats(firearms, items, ammo, settings)
    assert stats["top_wishlist_item_name"] == "Cheap Rank 0 Pistol"
    # A firearm-sourced pick reports no priority tier - rank replaced it.
    assert stats["top_wishlist_item_priority"] is None


def test_dashboard_stats_top_wishlist_item_unranked_firearms_break_tie_by_value():
    settings = CacheSettings()
    firearms = [
        _firearm(
            id="f1", custom_name="Unranked Cheap", is_wishlist=True, current_estimated_value=100
        ),
        _firearm(
            id="f2", custom_name="Unranked Expensive", is_wishlist=True, current_estimated_value=900
        ),
    ]
    items: list[InventoryItem] = []
    ammo: list[Ammunition] = []
    stats = logic.dashboard_stats(firearms, items, ammo, settings)
    assert stats["top_wishlist_item_name"] == "Unranked Expensive"


def test_dashboard_stats_top_wishlist_item_firearm_always_beats_item():
    # Any wishlist firearm outranks any wishlist part, regardless of the
    # part's priority tier or price - a rank is a stronger signal than a
    # coarse tier, and comparing the two directly would be apples-to-
    # oranges (see logic.dashboard_stats's comment).
    settings = CacheSettings()
    firearms = [
        _firearm(
            id="f1",
            custom_name="Unranked Cheap Firearm",
            is_wishlist=True,
            current_estimated_value=100,
        ),
    ]
    items = [
        InventoryItem(
            id="i1",
            custom_name="High Priority Expensive Part",
            category="Optic",
            is_wishlist=True,
            wishlist_priority="High",
            estimated_value=900,
        )
    ]
    ammo: list[Ammunition] = []
    stats = logic.dashboard_stats(firearms, items, ammo, settings)
    assert stats["top_wishlist_item_name"] == "Unranked Cheap Firearm"


def test_dashboard_stats_top_wishlist_item_falls_back_to_item_when_no_wishlist_firearms():
    settings = CacheSettings()
    firearms: list[Firearm] = []
    items = [
        InventoryItem(
            id="i1",
            custom_name="High Priority Part",
            category="Optic",
            is_wishlist=True,
            wishlist_priority="High",
            estimated_value=100,
        )
    ]
    ammo: list[Ammunition] = []
    stats = logic.dashboard_stats(firearms, items, ammo, settings)
    assert stats["top_wishlist_item_name"] == "High Priority Part"
    assert stats["top_wishlist_item_priority"] == "High"


def test_dashboard_stats_top_wishlist_item_none_when_wishlist_empty():
    settings = CacheSettings()
    firearms = [_firearm(id="f1", is_wishlist=False)]
    items: list[InventoryItem] = []
    ammo: list[Ammunition] = []
    stats = logic.dashboard_stats(firearms, items, ammo, settings)
    assert stats["top_wishlist_item_name"] is None
    assert stats["top_wishlist_item_priority"] is None


def test_dashboard_stats_total_value_falls_back_to_purchase_price():
    settings = CacheSettings()
    firearms = [_firearm(id="f1", purchase_price=600, current_estimated_value=None)]
    items = [
        InventoryItem(id="i1", custom_name="Optic", category="Optic", purchase_price=200)
    ]
    ammo: list[Ammunition] = []
    stats = logic.dashboard_stats(firearms, items, ammo, settings)
    assert stats["total_collection_value"] == 800


def test_firearm_effective_value_none_when_nothing_set():
    firearm = _firearm(id="f1")
    assert logic.firearm_effective_value(firearm, []) is None


def test_firearm_effective_value_uses_own_estimated_value():
    firearm = _firearm(id="f1", current_estimated_value=1200)
    assert logic.firearm_effective_value(firearm, []) == 1200


def test_firearm_effective_value_falls_back_to_purchase_price():
    firearm = _firearm(id="f1", purchase_price=900, current_estimated_value=None)
    assert logic.firearm_effective_value(firearm, []) == 900


def test_firearm_effective_value_sums_installed_parts():
    firearm = _firearm(id="f1", current_estimated_value=1000)
    items = [
        InventoryItem(
            id="i1",
            custom_name="Optic",
            category="Optic",
            estimated_value=300,
            installed_firearm_id="f1",
        ),
        InventoryItem(
            id="i2",
            custom_name="Sling",
            category="Sling",
            purchase_price=50,
            installed_firearm_id="f1",
        ),
    ]
    assert logic.firearm_effective_value(firearm, items) == 1350


def test_firearm_effective_value_ignores_installed_wishlist_parts():
    # Installing a wishlist part onto a real firearm (to preview a wanted
    # build) shouldn't inflate that firearm's displayed value with money
    # that hasn't actually been spent.
    firearm = _firearm(id="f1", current_estimated_value=1000)
    items = [
        InventoryItem(
            id="i1",
            custom_name="Owned Optic",
            category="Optic",
            estimated_value=300,
            installed_firearm_id="f1",
        ),
        InventoryItem(
            id="i2",
            custom_name="Dream Scope",
            category="Optic",
            estimated_value=3000,
            installed_firearm_id="f1",
            is_wishlist=True,
        ),
    ]
    assert logic.firearm_effective_value(firearm, items) == 1300


def test_firearm_effective_value_ignores_uninstalled_and_other_firearms_items():
    firearm = _firearm(id="f1", current_estimated_value=1000)
    items = [
        InventoryItem(id="i1", custom_name="Loose Optic", category="Optic", estimated_value=300),
        InventoryItem(
            id="i2",
            custom_name="Other Rifle's Optic",
            category="Optic",
            estimated_value=400,
            installed_firearm_id="f2",
        ),
    ]
    assert logic.firearm_effective_value(firearm, items) == 1000


def test_firearm_effective_value_parts_only_when_firearm_value_unset():
    firearm = _firearm(id="f1")
    items = [
        InventoryItem(
            id="i1",
            custom_name="Optic",
            category="Optic",
            estimated_value=300,
            installed_firearm_id="f1",
        )
    ]
    assert logic.firearm_effective_value(firearm, items) == 300


# ------------------------------------------------------------ range schedule


def test_range_schedule_never_completed_has_no_next_due_date():
    schedule = _schedule(last_completed_date=None)
    assert logic.range_schedule_next_due_date(schedule) is None


def test_range_schedule_never_completed_is_due():
    schedule = _schedule(last_completed_date=None)
    assert logic.range_schedule_is_due(schedule) is True


def test_range_schedule_inactive_is_never_due():
    schedule = _schedule(last_completed_date=None, active=False)
    assert logic.range_schedule_is_due(schedule) is False


def test_range_schedule_next_due_date_computed_from_frequency():
    schedule = _schedule(frequency="monthly", last_completed_date="2026-01-01")
    assert logic.range_schedule_next_due_date(schedule) == "2026-01-31"


def test_range_schedule_not_due_when_recently_completed():
    today = datetime.date.today().isoformat()
    schedule = _schedule(frequency="quarterly", last_completed_date=today)
    assert logic.range_schedule_is_due(schedule) is False


def test_range_schedule_due_when_interval_elapsed():
    old_date = (datetime.date.today() - datetime.timedelta(days=200)).isoformat()
    schedule = _schedule(frequency="quarterly", last_completed_date=old_date)
    assert logic.range_schedule_is_due(schedule) is True


def test_range_schedule_matching_firearms_by_type():
    firearms = [
        _firearm(id="f1", firearm_type="Shotgun"),
        _firearm(id="f2", firearm_type="Rifle"),
        _firearm(id="f3", firearm_type="Shotgun"),
    ]
    schedule = _schedule(targets=[_target(target_type="firearm_type", firearm_type="Shotgun")])
    matched = logic.range_schedule_matching_firearms(schedule, firearms)
    assert {f.id for f in matched} == {"f1", "f3"}


def test_range_schedule_matching_firearms_by_firearm():
    firearms = [_firearm(id="f1"), _firearm(id="f2")]
    schedule = _schedule(targets=[_target(target_type="firearm", firearm_id="f2")])
    matched = logic.range_schedule_matching_firearms(schedule, firearms)
    assert {f.id for f in matched} == {"f2"}


def test_range_schedule_matching_firearms_by_caliber():
    firearms = [
        _firearm(id="f1", caliber="300 BLK"),
        _firearm(id="f2", caliber="5.56"),
        _firearm(id="f3", caliber="300 BLK"),
    ]
    schedule = _schedule(targets=[_target(target_type="caliber", caliber="300 BLK")])
    matched = logic.range_schedule_matching_firearms(schedule, firearms)
    assert {f.id for f in matched} == {"f1", "f3"}


def test_range_schedule_matching_firearms_unions_across_multiple_targets():
    # One AR upper-swap schedule listing both calibers it might be fed.
    firearms = [
        _firearm(id="f1", caliber="300 BLK"),
        _firearm(id="f2", caliber="5.56"),
        _firearm(id="f3", caliber="9mm"),
    ]
    schedule = _schedule(
        targets=[
            _target(target_type="caliber", caliber="300 BLK"),
            _target(target_type="caliber", caliber="5.56"),
        ]
    )
    matched = logic.range_schedule_matching_firearms(schedule, firearms)
    assert {f.id for f in matched} == {"f1", "f2"}


def test_range_schedule_matches_firearm_by_caliber():
    firearm = _firearm(caliber="300 BLK")
    schedule = _schedule(targets=[_target(target_type="caliber", caliber="300 BLK")])
    assert logic.range_schedule_matches_firearm(schedule, firearm) is True
    assert logic.range_schedule_matches_firearm(schedule, _firearm(caliber="9mm")) is False


def test_range_schedule_calibers_includes_explicit_caliber_target_even_with_no_matching_firearm():
    schedule = _schedule(targets=[_target(target_type="caliber", caliber="300 BLK")])
    assert logic.range_schedule_calibers(schedule, []) == {"300 BLK"}


def test_range_schedule_target_label_firearm_type():
    target = _target(target_type="firearm_type", firearm_type="Shotgun")
    assert logic.range_schedule_target_label(target, {}) == "All Shotguns"


def test_range_schedule_target_label_caliber():
    target = _target(target_type="caliber", caliber="300 BLK")
    assert logic.range_schedule_target_label(target, {}) == "300 BLK ammo"


def test_range_schedule_target_label_firearm():
    firearm = _firearm(id="f1", custom_name="Home Defense AR")
    target = _target(target_type="firearm", firearm_id="f1")
    assert logic.range_schedule_target_label(target, {"f1": firearm}) == "Home Defense AR"


def test_range_schedule_default_label_joins_multiple_targets():
    targets = [
        _target(target_type="caliber", caliber="300 BLK"),
        _target(target_type="caliber", caliber="5.56"),
    ]
    assert logic.range_schedule_default_label(targets, {}) == "300 BLK ammo + 5.56 ammo"


def test_range_schedule_ammo_ok_none_when_alert_disabled():
    schedule = _schedule(
        targets=[_target(rounds_min=100)],
        ammo_alert_enabled=False,
    )
    assert logic.range_schedule_ammo_ok(schedule, [], []) is None


def test_range_schedule_ammo_ok_none_when_no_target_has_rounds_min():
    schedule = _schedule(targets=[_target(rounds_min=None)], ammo_alert_enabled=True)
    assert logic.range_schedule_ammo_ok(schedule, [], []) is None


def test_range_schedule_ammo_ok_true_when_sufficient():
    firearms = [_firearm(id="f1", firearm_type="Shotgun", caliber="12ga")]
    ammo = [Ammunition(id="a1", caliber="12ga", quantity=200)]
    schedule = _schedule(
        targets=[_target(target_type="firearm_type", firearm_type="Shotgun", rounds_min=50)],
        ammo_alert_enabled=True,
    )
    assert logic.range_schedule_ammo_ok(schedule, firearms, ammo) is True


def test_range_schedule_ammo_ok_false_when_insufficient():
    firearms = [_firearm(id="f1", firearm_type="Shotgun", caliber="12ga")]
    ammo = [Ammunition(id="a1", caliber="12ga", quantity=20)]
    schedule = _schedule(
        targets=[_target(target_type="firearm_type", firearm_type="Shotgun", rounds_min=50)],
        ammo_alert_enabled=True,
    )
    assert logic.range_schedule_ammo_ok(schedule, firearms, ammo) is False


def test_range_schedule_ammo_ok_false_when_any_target_is_short():
    # Two targets, each checked independently - sufficient ammo for one
    # doesn't cover for a shortfall on the other.
    firearms = [
        _firearm(id="f1", firearm_type="Shotgun", caliber="12ga"),
        _firearm(id="f2", firearm_type="Rifle", caliber="5.56"),
    ]
    ammo = [
        Ammunition(id="a1", caliber="12ga", quantity=200),
        Ammunition(id="a2", caliber="5.56", quantity=10),
    ]
    schedule = _schedule(
        targets=[
            _target(target_type="firearm_type", firearm_type="Shotgun", rounds_min=50),
            _target(target_type="firearm_type", firearm_type="Rifle", rounds_min=100),
        ],
        ammo_alert_enabled=True,
    )
    assert logic.range_schedule_ammo_ok(schedule, firearms, ammo) is False


def test_range_schedule_ammo_ok_speed_class_filter_only_counts_matching_ammo():
    # "Train with my suppressed pistol, but only subsonic ammo" - a
    # supersonic-labeled entry in the same caliber shouldn't count.
    firearm = _firearm(id="f1", caliber="9mm")
    subsonic = Ammunition(id="a1", caliber="9mm", quantity=50, muzzle_velocity="1000 fps")
    supersonic = Ammunition(id="a2", caliber="9mm", quantity=500, muzzle_velocity="1300 fps")
    schedule = _schedule(
        targets=[
            _target(target_type="firearm", firearm_id="f1", speed_class="Subsonic", rounds_min=100)
        ],
        ammo_alert_enabled=True,
    )
    assert logic.range_schedule_ammo_ok(schedule, [firearm], [subsonic, supersonic]) is False


def test_range_schedule_ammo_ok_speed_class_filter_true_when_sufficient_subsonic():
    firearm = _firearm(id="f1", caliber="9mm")
    subsonic = Ammunition(id="a1", caliber="9mm", quantity=150, muzzle_velocity="1000 fps")
    schedule = _schedule(
        targets=[
            _target(target_type="firearm", firearm_id="f1", speed_class="Subsonic", rounds_min=100)
        ],
        ammo_alert_enabled=True,
    )
    assert logic.range_schedule_ammo_ok(schedule, [firearm], [subsonic]) is True


def test_range_schedule_ammo_ok_no_speed_class_filter_counts_all():
    firearm = _firearm(id="f1", caliber="9mm")
    subsonic = Ammunition(id="a1", caliber="9mm", quantity=50, muzzle_velocity="1000 fps")
    supersonic = Ammunition(id="a2", caliber="9mm", quantity=60, muzzle_velocity="1300 fps")
    schedule = _schedule(
        targets=[_target(target_type="firearm", firearm_id="f1", rounds_min=100)],
        ammo_alert_enabled=True,
    )
    assert logic.range_schedule_ammo_ok(schedule, [firearm], [subsonic, supersonic]) is True


def test_range_schedule_target_label_includes_speed_class_qualifier():
    firearm = _firearm(id="f1", custom_name="Suppressed Glock")
    target = _target(target_type="firearm", firearm_id="f1", speed_class="Subsonic")
    label = logic.range_schedule_target_label(target, {"f1": firearm})
    assert label == "Suppressed Glock (subsonic only)"


def test_range_schedule_ammo_ok_bullet_type_filter_only_counts_matching_ammo():
    firearm = _firearm(id="f1", caliber="12ga")
    buckshot = Ammunition(id="a1", caliber="12ga", bullet_type="Buckshot", quantity=50)
    birdshot = Ammunition(id="a2", caliber="12ga", bullet_type="Birdshot", quantity=500)
    schedule = _schedule(
        targets=[
            _target(target_type="firearm", firearm_id="f1", bullet_type="Buckshot", rounds_min=100)
        ],
        ammo_alert_enabled=True,
    )
    assert logic.range_schedule_ammo_ok(schedule, [firearm], [buckshot, birdshot]) is False


def test_range_schedule_ammo_ok_bullet_type_filter_true_when_sufficient():
    firearm = _firearm(id="f1", caliber="12ga")
    buckshot = Ammunition(id="a1", caliber="12ga", bullet_type="Buckshot", quantity=150)
    schedule = _schedule(
        targets=[
            _target(target_type="firearm", firearm_id="f1", bullet_type="Buckshot", rounds_min=100)
        ],
        ammo_alert_enabled=True,
    )
    assert logic.range_schedule_ammo_ok(schedule, [firearm], [buckshot]) is True


def test_range_schedule_ammo_ok_bullet_type_and_speed_class_filters_combine():
    firearm = _firearm(id="f1", caliber="9mm")
    matching = Ammunition(
        id="a1", caliber="9mm", bullet_type="JHP", muzzle_velocity="1000 fps", quantity=150
    )
    wrong_bullet_type = Ammunition(
        id="a2", caliber="9mm", bullet_type="FMJ", muzzle_velocity="1000 fps", quantity=500
    )
    wrong_speed = Ammunition(
        id="a3", caliber="9mm", bullet_type="JHP", muzzle_velocity="1300 fps", quantity=500
    )
    schedule = _schedule(
        targets=[
            _target(
                target_type="firearm",
                firearm_id="f1",
                speed_class="Subsonic",
                bullet_type="JHP",
                rounds_min=100,
            )
        ],
        ammo_alert_enabled=True,
    )
    ammo = [matching, wrong_bullet_type, wrong_speed]
    assert logic.range_schedule_ammo_ok(schedule, [firearm], ammo) is True
    assert (
        logic.range_schedule_ammo_ok(schedule, [firearm], [wrong_bullet_type, wrong_speed]) is False
    )


# --------------------------------------------------------------- training plan --


def test_training_plan_current_step_index_sequential_uses_stored_index():
    plan = _plan(steps=[_step(id="s1"), _step(id="s2"), _step(id="s3")], current_step_index=1)
    assert logic.training_plan_current_step_index(plan) == 1


def test_training_plan_current_step_index_sequential_wraps_out_of_range_index():
    plan = _plan(steps=[_step(id="s1"), _step(id="s2")], current_step_index=5)
    assert logic.training_plan_current_step_index(plan) == 1


def test_training_plan_current_step_index_calendar_computes_from_start_date():
    month, year = _months_ago(2)
    plan = _plan(
        mode="calendar",
        steps=[_step(id="s1"), _step(id="s2"), _step(id="s3")],
        start_month=month,
        start_year=year,
    )
    assert logic.training_plan_current_step_index(plan) == 2


def test_training_plan_current_step_index_calendar_none_when_no_start_date():
    plan = _plan(mode="calendar", steps=[_step()], start_month=None, start_year=None)
    assert logic.training_plan_current_step_index(plan) is None


def test_training_plan_current_step_index_none_when_no_steps():
    plan = TrainingPlan(id="p1", label="Plan", mode="sequential", steps=[])
    assert logic.training_plan_current_step_index(plan) is None


def test_training_plan_current_step_returns_matching_step():
    steps = [_step(id="s1"), _step(id="s2")]
    plan = _plan(steps=steps, current_step_index=1)
    assert logic.training_plan_current_step(plan) is steps[1]


def test_training_plan_step_is_due_false_when_inactive():
    plan = _plan(active=False)
    assert logic.training_plan_step_is_due(plan) is False


def test_training_plan_step_is_due_sequential_always_true_regardless_of_completion():
    # Sequential mode is self-paced - the current step stays "due" until
    # explicitly advanced, even if it has a last_completed_date from before.
    today = datetime.date.today().isoformat()
    step = _step(last_completed_date=today)
    plan = _plan(mode="sequential", steps=[step])
    assert logic.training_plan_step_is_due(plan) is True


def test_training_plan_step_is_due_calendar_true_when_never_completed():
    month, year = _months_ago(0)
    plan = _plan(mode="calendar", steps=[_step()], start_month=month, start_year=year)
    assert logic.training_plan_step_is_due(plan) is True


def test_training_plan_step_is_due_calendar_false_when_completed_this_month():
    month, year = _months_ago(0)
    today = datetime.date.today().isoformat()
    step = _step(last_completed_date=today)
    plan = _plan(mode="calendar", steps=[step], start_month=month, start_year=year)
    assert logic.training_plan_step_is_due(plan) is False


def test_training_plan_step_is_due_calendar_true_when_completed_a_different_month():
    month, year = _months_ago(0)
    old_date = (datetime.date.today() - datetime.timedelta(days=200)).isoformat()
    step = _step(last_completed_date=old_date)
    plan = _plan(mode="calendar", steps=[step], start_month=month, start_year=year)
    assert logic.training_plan_step_is_due(plan) is True


def test_training_plan_matches_firearm_checks_current_step_only():
    firearm = _firearm(id="f1", firearm_type="Shotgun")
    other_firearm = _firearm(id="f2", firearm_type="Rifle", caliber="5.56")
    steps = [
        _step(id="s1", targets=[_target(target_type="firearm_type", firearm_type="Shotgun")]),
        _step(id="s2", targets=[_target(target_type="caliber", caliber="5.56")]),
    ]
    plan = _plan(steps=steps, current_step_index=0)
    assert logic.training_plan_matches_firearm(plan, firearm) is True
    assert logic.training_plan_matches_firearm(plan, other_firearm) is False


def test_training_plan_step_ammo_ok_none_when_alert_disabled():
    plan = _plan(ammo_alert_enabled=False)
    step = _step(targets=[_target(rounds_min=100)])
    assert logic.training_plan_step_ammo_ok(plan, step, [], []) is None


def test_training_plan_step_ammo_ok_true_when_sufficient():
    firearms = [_firearm(id="f1", firearm_type="Shotgun", caliber="12ga")]
    ammo = [Ammunition(id="a1", caliber="12ga", quantity=200)]
    plan = _plan(ammo_alert_enabled=True)
    step = _step(
        targets=[_target(target_type="firearm_type", firearm_type="Shotgun", rounds_min=50)],
    )
    assert logic.training_plan_step_ammo_ok(plan, step, firearms, ammo) is True


def test_training_plan_step_ammo_ok_false_when_insufficient():
    firearms = [_firearm(id="f1", firearm_type="Shotgun", caliber="12ga")]
    ammo = [Ammunition(id="a1", caliber="12ga", quantity=5)]
    plan = _plan(ammo_alert_enabled=True)
    step = _step(
        targets=[_target(target_type="firearm_type", firearm_type="Shotgun", rounds_min=50)],
    )
    assert logic.training_plan_step_ammo_ok(plan, step, firearms, ammo) is False


def test_training_plans_due_filters_to_due_plans_only():
    due_plan = _plan(id="p1", mode="sequential", steps=[_step()])
    not_due_plan = _plan(id="p2", mode="sequential", steps=[_step()], active=False)
    assert logic.training_plans_due([due_plan, not_due_plan]) == [due_plan]


def test_training_plans_with_ammo_alert_filters_to_insufficient_active_plans():
    firearms = [_firearm(id="f1", firearm_type="Shotgun", caliber="12ga")]
    ammo = [Ammunition(id="a1", caliber="12ga", quantity=5)]
    alert_step = _step(
        targets=[_target(target_type="firearm_type", firearm_type="Shotgun", rounds_min=50)],
    )
    alert_plan = _plan(id="p1", ammo_alert_enabled=True, steps=[alert_step])
    ok_plan = _plan(id="p2", ammo_alert_enabled=False, steps=[_step()])
    assert logic.training_plans_with_ammo_alert([alert_plan, ok_plan], firearms, ammo) == [
        alert_plan
    ]


def test_training_plan_advance_sets_last_completed_date():
    step = _step(id="s1")
    plan = _plan(mode="sequential", steps=[step], current_step_index=0)
    logic.training_plan_advance(plan, "2026-07-13")
    assert plan.steps[0].last_completed_date == "2026-07-13"


def test_training_plan_advance_sequential_wraps_to_next_step():
    plan = _plan(
        mode="sequential",
        steps=[_step(id="s1"), _step(id="s2"), _step(id="s3")],
        current_step_index=2,
    )
    logic.training_plan_advance(plan, "2026-07-13")
    assert plan.current_step_index == 0


def test_training_plan_advance_calendar_does_not_touch_current_step_index():
    month, year = _months_ago(0)
    plan = _plan(
        mode="calendar",
        steps=[_step(id="s1"), _step(id="s2")],
        start_month=month,
        start_year=year,
        current_step_index=0,
    )
    logic.training_plan_advance(plan, "2026-07-13")
    assert plan.current_step_index == 0
    assert plan.steps[0].last_completed_date == "2026-07-13"


def test_training_plan_advance_noop_when_already_completed_after_date():
    step = _step(id="s1", last_completed_date="2026-08-01")
    plan = _plan(mode="sequential", steps=[step], current_step_index=0)
    logic.training_plan_advance(plan, "2026-07-01")
    assert plan.steps[0].last_completed_date == "2026-08-01"
    assert plan.current_step_index == 0


def test_dashboard_stats_nfa_counts_only_checked_firearms_and_suppressors():
    firearms = [
        _firearm(id="f1", firearm_type="Rifle", is_nfa=True),  # e.g. a machine gun
        _firearm(id="f2", firearm_type="Shotgun", is_nfa=True),  # e.g. an SBS
        _firearm(id="f3", firearm_type="SBR"),  # unchecked: not counted
        _firearm(id="f4", firearm_type="Rifle"),
    ]
    items = [
        InventoryItem(id="i1", custom_name="Can", category="Muzzle", part_type="Suppressor")
    ]
    stats = logic.dashboard_stats(firearms, items, [], CacheSettings())
    assert stats["nfa_items"] == 3


def test_firearm_saved_before_is_nfa_existed_keeps_sbr_counted():
    from cache_addon.models import Firearm

    old_sbr = Firearm.from_dict({"id": "a", "custom_name": "PDW", "firearm_type": "SBR"})
    old_rifle = Firearm.from_dict({"id": "b", "custom_name": "AR", "firearm_type": "Rifle"})
    unchecked_sbr = Firearm.from_dict(
        {"id": "c", "custom_name": "X", "firearm_type": "SBR", "is_nfa": False}
    )
    assert old_sbr.is_nfa is True
    assert old_rifle.is_nfa is False
    assert unchecked_sbr.is_nfa is False  # an explicit choice wins
