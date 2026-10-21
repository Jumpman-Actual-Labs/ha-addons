"""Coordinator lifecycle tests - call `coordinator.async_*` methods directly
against an in-memory `CacheCoordinator`, no HTTP layer, no real HA `Store`.
"""
from __future__ import annotations

import datetime

import pytest

from cache_addon.coordinator import (
    CacheCoordinator,
    CacheError,
    ItemAlreadyInstalledError,
)
from cache_addon.models import CacheSettings


class FakeStore:
    """In-memory stand-in for CacheStore - no real HA Store needed."""

    def __init__(self):
        self._data = None

    async def async_load(self):
        return self._data

    async def async_save(self, data):
        self._data = data


class FakeHass:
    pass


@pytest.fixture
async def coordinator():
    coord = CacheCoordinator.__new__(CacheCoordinator)
    # Bypass DataUpdateCoordinator.__init__ (stubbed under conftest) - set
    # only what our code actually touches.
    coord.hass = FakeHass()
    coord.store = FakeStore()
    coord.settings = CacheSettings()
    coord.storage_locations = []
    coord.firearms = []
    coord.inventory_items = []
    coord.ammunition = []
    coord.range_sessions = []
    coord.range_schedules = []
    coord.data = None

    def _set_updated_data(value):
        coord.data = value

    coord.async_set_updated_data = _set_updated_data

    await coord.async_load()
    return coord


async def _add_location(coordinator, name="Main Safe"):
    return await coordinator.async_add_storage_location(name)


async def _add_firearm(coordinator, **overrides):
    fields = dict(custom_name="Test AR", firearm_type="Rifle")
    fields.update(overrides)
    return await coordinator.async_add_firearm(**fields)


async def _add_item(
    coordinator, category="Optic", part_type="Optic", name="EOTech EXPS3", **overrides
):
    fields = dict(custom_name=name, category=category, part_type=part_type)
    fields.update(overrides)
    return await coordinator.async_add_inventory_item(**fields)


# ------------------------------------------------------------------ firearms


async def test_add_and_delete_firearm(coordinator):
    firearm = await _add_firearm(coordinator)
    assert firearm.id in [f.id for f in coordinator.firearms]

    await coordinator.async_delete_firearm(firearm.id)
    assert coordinator.firearms == []


async def test_add_firearm_rejects_invalid_type(coordinator):
    with pytest.raises(CacheError):
        await coordinator.async_add_firearm(custom_name="Bad", firearm_type="Laser Cannon")


async def test_add_firearm_without_custom_name_uses_manufacturer_model(coordinator):
    firearm = await coordinator.async_add_firearm(
        firearm_type="Rifle", manufacturer="Daniel Defense", model="DDM4"
    )
    assert firearm.custom_name == "Daniel Defense DDM4"


async def test_add_firearm_without_any_identifying_fields_falls_back_to_type(coordinator):
    firearm = await coordinator.async_add_firearm(firearm_type="Shotgun")
    assert firearm.custom_name == "Shotgun"


async def test_clearing_custom_name_on_update_regenerates_fallback(coordinator):
    firearm = await _add_firearm(coordinator, custom_name="My AR", manufacturer="BCM", model="MK2")
    updated = await coordinator.async_update_firearm(firearm.id, custom_name="")
    assert updated.custom_name == "BCM MK2"


async def test_add_firearm_blank_price_fields_store_none(coordinator):
    firearm = await coordinator.async_add_firearm(
        firearm_type="Rifle", purchase_price="", current_estimated_value=""
    )
    assert firearm.purchase_price is None
    assert firearm.current_estimated_value is None


async def test_add_wishlist_firearm_gets_next_rank(coordinator):
    firearm = await _add_firearm(coordinator, is_wishlist=True)
    assert firearm.is_wishlist is True
    assert firearm.wishlist_rank == 0

    second = await _add_firearm(coordinator, is_wishlist=True)
    assert second.wishlist_rank == 1


async def test_add_non_wishlist_firearm_has_no_rank(coordinator):
    firearm = await _add_firearm(coordinator)
    assert firearm.is_wishlist is False
    assert firearm.wishlist_rank is None


async def test_wishlisting_existing_firearm_on_update_assigns_rank(coordinator):
    await _add_firearm(coordinator, is_wishlist=True)  # takes rank 0
    firearm = await _add_firearm(coordinator)
    updated = await coordinator.async_update_firearm(firearm.id, is_wishlist=True)
    assert updated.wishlist_rank == 1


async def test_mark_firearm_purchased_clears_wishlist_rank(coordinator):
    firearm = await _add_firearm(coordinator, is_wishlist=True)
    updated = await coordinator.async_update_firearm(
        firearm.id, is_wishlist=False, purchase_date="2026-01-01"
    )
    assert updated.is_wishlist is False
    assert updated.wishlist_rank is None
    assert updated.purchase_date == "2026-01-01"


async def test_reorder_wishlist_firearms(coordinator):
    a = await _add_firearm(coordinator, is_wishlist=True)
    b = await _add_firearm(coordinator, is_wishlist=True)
    c = await _add_firearm(coordinator, is_wishlist=True)
    assert [a.wishlist_rank, b.wishlist_rank, c.wishlist_rank] == [0, 1, 2]

    await coordinator.async_reorder_wishlist_firearms([c.id, a.id, b.id])

    by_id = {f.id: f for f in coordinator.firearms}
    assert by_id[c.id].wishlist_rank == 0
    assert by_id[a.id].wishlist_rank == 1
    assert by_id[b.id].wishlist_rank == 2


async def test_reorder_wishlist_firearms_rejects_non_wishlist_id(coordinator):
    owned = await _add_firearm(coordinator)
    with pytest.raises(CacheError):
        await coordinator.async_reorder_wishlist_firearms([owned.id])


async def test_reorder_wishlist_firearms_rejects_unknown_id(coordinator):
    with pytest.raises(CacheError):
        await coordinator.async_reorder_wishlist_firearms(["does-not-exist"])


async def test_add_inventory_item_without_custom_name_uses_manufacturer_model(coordinator):
    item = await coordinator.async_add_inventory_item(
        category="Optic", part_type="Optic", manufacturer="EOTech", model="EXPS3"
    )
    assert item.custom_name == "EOTech EXPS3"


async def test_add_inventory_item_blank_price_fields_store_none(coordinator):
    item = await coordinator.async_add_inventory_item(
        category="Optic", part_type="Optic", purchase_price="", estimated_value=""
    )
    assert item.purchase_price is None
    assert item.estimated_value is None


async def test_add_inventory_item_without_any_identifying_fields_falls_back_to_part_type(
    coordinator,
):
    item = await coordinator.async_add_inventory_item(category="Accessory", part_type="Handguard")
    assert item.custom_name == "Handguard"


async def test_add_inventory_item_rejects_part_type_not_in_category(coordinator):
    with pytest.raises(CacheError):
        await coordinator.async_add_inventory_item(category="Barrel", part_type="Trigger")


async def test_add_inventory_item_rejects_invalid_part_type(coordinator):
    with pytest.raises(CacheError):
        await coordinator.async_add_inventory_item(category="Optic", part_type="Magazine")


async def test_add_wishlist_item(coordinator):
    item = await _add_item(coordinator, is_wishlist=True, wishlist_priority="Medium")
    assert item.is_wishlist is True
    assert item.wishlist_priority == "Medium"


async def test_add_item_rejects_invalid_wishlist_priority(coordinator):
    with pytest.raises(CacheError):
        await _add_item(coordinator, is_wishlist=True, wishlist_priority="Urgent")


async def test_mark_item_purchased_clears_wishlist_flag(coordinator):
    item = await _add_item(coordinator, is_wishlist=True, wishlist_priority="Medium")
    updated = await coordinator.async_update_inventory_item(
        item.id, is_wishlist=False, wishlist_priority="", purchase_date="2026-01-01"
    )
    assert updated.is_wishlist is False
    assert updated.wishlist_priority is None
    assert updated.purchase_date == "2026-01-01"


async def test_add_and_remove_rounds(coordinator):
    firearm = await _add_firearm(coordinator)
    firearm = await coordinator.async_add_rounds(firearm.id, 100)
    assert firearm.lifetime_round_count == 100
    assert firearm.last_fired_date is not None

    firearm = await coordinator.async_remove_rounds(firearm.id, 30)
    assert firearm.lifetime_round_count == 70

    # Cannot go negative
    firearm = await coordinator.async_remove_rounds(firearm.id, 1000)
    assert firearm.lifetime_round_count == 0


async def test_delete_firearm_frees_installed_items(coordinator):
    location = await _add_location(coordinator)
    firearm = await _add_firearm(coordinator, storage_location_id=location.id)
    item = await _add_item(coordinator)
    await coordinator.async_install_item(firearm.id, item.id, "Optic")

    await coordinator.async_delete_firearm(firearm.id)

    updated_item = coordinator.inventory_items[0]
    assert updated_item.installed_firearm_id is None
    assert updated_item.storage_location_id == location.id


# --------------------------------------------------------------- my build


async def test_install_item_matches_part_type(coordinator):
    location = await _add_location(coordinator)
    firearm = await _add_firearm(coordinator, storage_location_id=location.id)
    item = await _add_item(coordinator, category="Optic")

    await coordinator.async_install_item(firearm.id, item.id, "Optic")

    updated = coordinator.inventory_items[0]
    assert updated.installed_firearm_id == firearm.id
    assert updated.installed_slot_type == "Optic"
    assert updated.storage_location_id is None  # inherits from firearm now


async def test_update_installed_item_without_changing_location_succeeds(coordinator):
    # Regression: the frontend always echoes storage_location_id back in the
    # update payload (the field is just disabled in the UI while installed,
    # not omitted) - the backend must only reject an install-time location
    # change when the value actually differs, not merely when the key is
    # present, or every edit of an installed item (name, notes, price, ...)
    # gets rejected outright.
    location = await _add_location(coordinator)
    firearm = await _add_firearm(coordinator, storage_location_id=location.id)
    item = await _add_item(coordinator)
    await coordinator.async_install_item(firearm.id, item.id, "Optic")
    assert item.storage_location_id is None

    updated = await coordinator.async_update_inventory_item(
        item.id, storage_location_id="", notes="Zeroed at 50 yards"
    )
    assert updated.notes == "Zeroed at 50 yards"
    assert updated.installed_firearm_id == firearm.id


async def test_update_installed_item_rejects_actual_location_change(coordinator):
    location = await _add_location(coordinator)
    other_location = await _add_location(coordinator, name="Range Bag")
    firearm = await _add_firearm(coordinator, storage_location_id=location.id)
    item = await _add_item(coordinator)
    await coordinator.async_install_item(firearm.id, item.id, "Optic")

    with pytest.raises(CacheError):
        await coordinator.async_update_inventory_item(
            item.id, storage_location_id=other_location.id
        )


async def test_install_rejects_part_type_mismatch(coordinator):
    firearm = await _add_firearm(coordinator)
    item = await _add_item(coordinator, category="Stock", part_type="Stock")

    with pytest.raises(CacheError):
        await coordinator.async_install_item(firearm.id, item.id, "Optic")


async def test_multiple_items_can_share_a_slot(coordinator):
    location = await _add_location(coordinator)
    firearm = await _add_firearm(coordinator, storage_location_id=location.id)
    item1 = await _add_item(coordinator, category="Optic", name="Optic A")
    item2 = await _add_item(coordinator, category="Optic", name="Optic B")

    await coordinator.async_install_item(firearm.id, item1.id, "Optic")
    await coordinator.async_install_item(firearm.id, item2.id, "Optic")

    by_id = {i.id: i for i in coordinator.inventory_items}
    assert by_id[item1.id].installed_slot_type == "Optic"
    assert by_id[item1.id].installed_firearm_id == firearm.id
    assert by_id[item2.id].installed_slot_type == "Optic"
    assert by_id[item2.id].installed_firearm_id == firearm.id


async def test_move_installed_item_requires_confirmation(coordinator):
    location = await _add_location(coordinator)
    firearm1 = await _add_firearm(
        coordinator, custom_name="First AR", storage_location_id=location.id
    )
    firearm2 = await _add_firearm(
        coordinator, custom_name="Second AR", storage_location_id=location.id
    )
    item = await _add_item(coordinator, category="Optic")

    await coordinator.async_install_item(firearm1.id, item.id, "Optic")

    with pytest.raises(ItemAlreadyInstalledError):
        await coordinator.async_install_item(firearm2.id, item.id, "Optic")

    await coordinator.async_install_item(firearm2.id, item.id, "Optic", confirm_move=True)
    updated = coordinator.inventory_items[0]
    assert updated.installed_firearm_id == firearm2.id


async def test_remove_requires_storage_location(coordinator):
    location = await _add_location(coordinator)
    firearm = await _add_firearm(coordinator, storage_location_id=location.id)
    item = await _add_item(coordinator, category="Optic")
    await coordinator.async_install_item(firearm.id, item.id, "Optic")

    with pytest.raises(CacheError):
        await coordinator.async_remove_item(item.id, "")

    await coordinator.async_remove_item(item.id, location.id)
    updated = coordinator.inventory_items[0]
    assert updated.installed_firearm_id is None
    assert updated.storage_location_id == location.id


async def test_remove_rejects_item_not_currently_installed(coordinator):
    location = await _add_location(coordinator)
    item = await _add_item(coordinator, category="Optic")
    with pytest.raises(CacheError):
        await coordinator.async_remove_item(item.id, location.id)


async def test_removing_one_shared_slot_item_leaves_the_other_installed(coordinator):
    location = await _add_location(coordinator)
    firearm = await _add_firearm(coordinator, storage_location_id=location.id)
    item1 = await _add_item(coordinator, category="Optic", name="Optic A")
    item2 = await _add_item(coordinator, category="Optic", name="Optic B")
    await coordinator.async_install_item(firearm.id, item1.id, "Optic")
    await coordinator.async_install_item(firearm.id, item2.id, "Optic")

    await coordinator.async_remove_item(item1.id, location.id)

    by_id = {i.id: i for i in coordinator.inventory_items}
    assert by_id[item1.id].installed_firearm_id is None
    assert by_id[item1.id].storage_location_id == location.id
    assert by_id[item2.id].installed_firearm_id == firearm.id
    assert by_id[item2.id].installed_slot_type == "Optic"


async def test_removing_a_wishlist_item_does_not_require_a_storage_location(coordinator):
    firearm = await _add_firearm(coordinator)
    item = await _add_item(coordinator, category="Optic", is_wishlist=True)
    await coordinator.async_install_item(firearm.id, item.id, "Optic")

    await coordinator.async_remove_item(item.id, "")

    updated = coordinator.inventory_items[0]
    assert updated.installed_firearm_id is None
    assert updated.storage_location_id is None


async def test_removing_a_wishlist_item_still_accepts_a_storage_location(coordinator):
    location = await _add_location(coordinator)
    firearm = await _add_firearm(coordinator)
    item = await _add_item(coordinator, category="Optic", is_wishlist=True)
    await coordinator.async_install_item(firearm.id, item.id, "Optic")

    await coordinator.async_remove_item(item.id, location.id)

    updated = coordinator.inventory_items[0]
    assert updated.storage_location_id == location.id


async def test_item_moves_with_firearm_location(coordinator):
    location = await _add_location(coordinator, "Main Safe")
    firearm = await _add_firearm(coordinator, storage_location_id=location.id)
    item = await _add_item(coordinator, category="Optic")
    await coordinator.async_install_item(firearm.id, item.id, "Optic")

    new_location = await _add_location(coordinator, "Vehicle Safe")
    await coordinator.async_update_firearm(firearm.id, storage_location_id=new_location.id)

    from cache_addon import logic

    firearms_by_id = {f.id: f for f in coordinator.firearms}
    updated_item = coordinator.inventory_items[0]
    assert logic.effective_location_id(updated_item, firearms_by_id) == new_location.id


# --------------------------------------------------------------- ammunition


async def test_create_ammunition_with_initial_quantity(coordinator):
    ammo = await coordinator.async_add_ammunition(caliber="9mm", quantity=500)
    assert ammo.quantity == 500
    assert len(ammo.transactions) == 1


async def test_add_remove_adjust_quantity(coordinator):
    ammo = await coordinator.async_add_ammunition(caliber=".223", quantity=200)

    ammo = await coordinator.async_add_ammo_quantity(ammo.id, 50)
    assert ammo.quantity == 250

    ammo = await coordinator.async_remove_ammo_quantity(ammo.id, 100)
    assert ammo.quantity == 150

    with pytest.raises(CacheError):
        await coordinator.async_remove_ammo_quantity(ammo.id, 10000)

    ammo = await coordinator.async_set_ammo_quantity(ammo.id, 300)
    assert ammo.quantity == 300


async def test_add_ammunition_with_product_name_and_muzzle_velocity(coordinator):
    ammo = await coordinator.async_add_ammunition(
        caliber="300 BLK",
        quantity=100,
        product_name="Gold Medal Match",
        muzzle_velocity="2100 fps",
    )
    assert ammo.product_name == "Gold Medal Match"
    assert ammo.muzzle_velocity == "2100 fps"


async def test_update_ammunition_product_name_and_muzzle_velocity(coordinator):
    ammo = await coordinator.async_add_ammunition(caliber="9mm", quantity=50)
    updated = await coordinator.async_update_ammunition(
        ammo.id, product_name="HST", muzzle_velocity="1200 fps"
    )
    assert updated.product_name == "HST"
    assert updated.muzzle_velocity == "1200 fps"


async def test_add_ammunition_blank_low_inventory_threshold_stores_none(coordinator):
    # Mirrors the frontend's convention: an optional numeric field left
    # blank is sent as "" (see ha-cache-frontend's callCacheService), which
    # must normalize to None on add, not persist as the literal string "" -
    # a stray "" here previously crashed is_ammo_low() on every reload.
    ammo = await coordinator.async_add_ammunition(
        caliber="9mm", quantity=100, low_inventory_threshold="", cost_per_round=""
    )
    assert ammo.low_inventory_threshold is None
    assert ammo.cost_per_round is None

    from cache_addon import logic

    logic.is_ammo_low(ammo, coordinator.settings, coordinator.ammo_alert_rules)  # should not raise


async def test_add_ammunition_computes_cost_per_round_from_box(coordinator):
    ammo = await coordinator.async_add_ammunition(
        caliber="9mm", quantity=50, cost_per_box=20.0, rounds_per_box=50
    )
    assert ammo.cost_per_round == 0.4


async def test_update_ammunition_recomputes_cost_per_round(coordinator):
    ammo = await coordinator.async_add_ammunition(
        caliber="9mm", quantity=50, cost_per_box=20.0, rounds_per_box=50
    )
    updated = await coordinator.async_update_ammunition(ammo.id, cost_per_box=30.0)
    assert updated.cost_per_round == 0.6  # rounds_per_box (50) carried over from the add


async def test_update_ammunition_unrelated_field_leaves_cost_per_round_alone(coordinator):
    ammo = await coordinator.async_add_ammunition(
        caliber="9mm", quantity=50, cost_per_box=20.0, rounds_per_box=50
    )
    updated = await coordinator.async_update_ammunition(ammo.id, notes="stored in the safe")
    assert updated.cost_per_round == 0.4


async def test_low_inventory_uses_default_threshold_when_unset(coordinator):
    await coordinator.async_update_settings(low_ammo_threshold_default=1000)
    ammo = await coordinator.async_add_ammunition(caliber=".308", quantity=500)

    from cache_addon import logic

    assert logic.is_ammo_low(ammo, coordinator.settings, coordinator.ammo_alert_rules) is True


# ------------------------------------------------------------ range sessions


async def test_range_session_updates_round_count_and_ammo(coordinator):
    firearm = await _add_firearm(coordinator)
    ammo = await coordinator.async_add_ammunition(caliber="5.56 NATO", quantity=300)

    today = datetime.date.today().isoformat()
    session = await coordinator.async_log_range_session(
        today,
        [{"firearm_id": firearm.id, "ammunition_id": ammo.id, "rounds_fired": 120}],
        location="Local Range",
    )
    assert session.firearms[0].rounds_fired == 120

    updated_firearm = coordinator.firearms[0]
    assert updated_firearm.lifetime_round_count == 120
    assert updated_firearm.last_fired_date == today

    updated_ammo = coordinator.ammunition[0]
    assert updated_ammo.quantity == 180


async def test_range_session_rejects_insufficient_ammo(coordinator):
    firearm = await _add_firearm(coordinator)
    ammo = await coordinator.async_add_ammunition(caliber="5.56 NATO", quantity=10)

    with pytest.raises(CacheError):
        await coordinator.async_log_range_session(
            datetime.date.today().isoformat(),
            [{"firearm_id": firearm.id, "ammunition_id": ammo.id, "rounds_fired": 500}],
        )

    # Nothing should have changed
    assert coordinator.firearms[0].lifetime_round_count == 0
    assert coordinator.ammunition[0].quantity == 10


async def test_update_range_session_adjusts_round_count_delta(coordinator):
    firearm = await _add_firearm(coordinator)
    today = datetime.date.today().isoformat()
    session = await coordinator.async_log_range_session(
        today, [{"firearm_id": firearm.id, "rounds_fired": 100}]
    )
    assert coordinator.firearms[0].lifetime_round_count == 100

    await coordinator.async_update_range_session(
        session.id, today, [{"firearm_id": firearm.id, "rounds_fired": 60}]
    )
    assert coordinator.firearms[0].lifetime_round_count == 60


async def test_update_range_session_adjusts_ammo_delta(coordinator):
    firearm = await _add_firearm(coordinator)
    ammo = await coordinator.async_add_ammunition(caliber="5.56 NATO", quantity=300)
    today = datetime.date.today().isoformat()
    session = await coordinator.async_log_range_session(
        today, [{"firearm_id": firearm.id, "ammunition_id": ammo.id, "rounds_fired": 120}]
    )
    assert coordinator.ammunition[0].quantity == 180

    await coordinator.async_update_range_session(
        session.id,
        today,
        [{"firearm_id": firearm.id, "ammunition_id": ammo.id, "rounds_fired": 50}],
    )
    assert coordinator.ammunition[0].quantity == 250


async def test_update_range_session_can_increase_usage_within_stock(coordinator):
    firearm = await _add_firearm(coordinator)
    ammo = await coordinator.async_add_ammunition(caliber="5.56 NATO", quantity=300)
    today = datetime.date.today().isoformat()
    session = await coordinator.async_log_range_session(
        today, [{"firearm_id": firearm.id, "ammunition_id": ammo.id, "rounds_fired": 50}]
    )
    assert coordinator.ammunition[0].quantity == 250

    await coordinator.async_update_range_session(
        session.id,
        today,
        [{"firearm_id": firearm.id, "ammunition_id": ammo.id, "rounds_fired": 250}],
    )
    assert coordinator.ammunition[0].quantity == 50
    assert coordinator.firearms[0].lifetime_round_count == 250


async def test_update_range_session_rejects_insufficient_ammo_leaves_state_unchanged(coordinator):
    firearm = await _add_firearm(coordinator)
    ammo = await coordinator.async_add_ammunition(caliber="5.56 NATO", quantity=100)
    today = datetime.date.today().isoformat()
    session = await coordinator.async_log_range_session(
        today, [{"firearm_id": firearm.id, "ammunition_id": ammo.id, "rounds_fired": 50}]
    )
    assert coordinator.ammunition[0].quantity == 50

    with pytest.raises(CacheError):
        await coordinator.async_update_range_session(
            session.id,
            today,
            [{"firearm_id": firearm.id, "ammunition_id": ammo.id, "rounds_fired": 500}],
        )

    # Rejected edit must not partially apply - old usage stays deducted,
    # round count stays at the original value.
    assert coordinator.ammunition[0].quantity == 50
    assert coordinator.firearms[0].lifetime_round_count == 50


async def test_update_range_session_removes_firearm_reverses_its_rounds(coordinator):
    firearm1 = await _add_firearm(coordinator, custom_name="Rifle 1")
    firearm2 = await _add_firearm(coordinator, custom_name="Rifle 2")
    today = datetime.date.today().isoformat()
    session = await coordinator.async_log_range_session(
        today,
        [
            {"firearm_id": firearm1.id, "rounds_fired": 40},
            {"firearm_id": firearm2.id, "rounds_fired": 60},
        ],
    )
    by_id = {f.id: f for f in coordinator.firearms}
    assert by_id[firearm1.id].lifetime_round_count == 40
    assert by_id[firearm2.id].lifetime_round_count == 60

    await coordinator.async_update_range_session(
        session.id, today, [{"firearm_id": firearm2.id, "rounds_fired": 60}]
    )
    by_id = {f.id: f for f in coordinator.firearms}
    assert by_id[firearm1.id].lifetime_round_count == 0
    assert by_id[firearm2.id].lifetime_round_count == 60
    assert len(coordinator.range_sessions[0].firearms) == 1


async def test_update_range_session_changes_date_and_notes(coordinator):
    firearm = await _add_firearm(coordinator)
    session = await coordinator.async_log_range_session(
        "2026-01-01", [{"firearm_id": firearm.id, "rounds_fired": 10}], notes="original"
    )
    updated = await coordinator.async_update_range_session(
        session.id,
        "2026-02-15",
        [{"firearm_id": firearm.id, "rounds_fired": 10}],
        location="New Range",
        notes="corrected",
    )
    assert updated.date == "2026-02-15"
    assert updated.location == "New Range"
    assert updated.notes == "corrected"


async def test_update_range_session_still_bumps_schedule_if_newer(coordinator):
    firearm = await _add_firearm(coordinator)
    await coordinator.async_add_range_schedule(
        targets=[{"target_type": "firearm", "firearm_id": firearm.id}], frequency="quarterly"
    )
    session = await coordinator.async_log_range_session(
        "2026-01-01", [{"firearm_id": firearm.id, "rounds_fired": 10}]
    )
    assert coordinator.range_schedules[0].last_completed_date == "2026-01-01"

    await coordinator.async_update_range_session(
        session.id, "2026-03-01", [{"firearm_id": firearm.id, "rounds_fired": 10}]
    )
    assert coordinator.range_schedules[0].last_completed_date == "2026-03-01"


async def test_update_range_session_requires_at_least_one_firearm(coordinator):
    firearm = await _add_firearm(coordinator)
    session = await coordinator.async_log_range_session(
        datetime.date.today().isoformat(), [{"firearm_id": firearm.id, "rounds_fired": 10}]
    )
    with pytest.raises(CacheError):
        await coordinator.async_update_range_session(
            session.id, datetime.date.today().isoformat(), []
        )


async def test_update_range_session_twice_does_not_double_credit_ammo(coordinator):
    # Regression: the old "range_session"-tagged transaction used to stay
    # tagged after being reversed, so a second edit would find it again
    # alongside the newer deduction and return the same ammo twice.
    firearm = await _add_firearm(coordinator)
    ammo = await coordinator.async_add_ammunition(caliber="5.56 NATO", quantity=300)
    today = datetime.date.today().isoformat()
    session = await coordinator.async_log_range_session(
        today, [{"firearm_id": firearm.id, "ammunition_id": ammo.id, "rounds_fired": 100}]
    )
    assert coordinator.ammunition[0].quantity == 200

    await coordinator.async_update_range_session(
        session.id,
        today,
        [{"firearm_id": firearm.id, "ammunition_id": ammo.id, "rounds_fired": 80}],
    )
    assert coordinator.ammunition[0].quantity == 220

    await coordinator.async_update_range_session(
        session.id,
        today,
        [{"firearm_id": firearm.id, "ammunition_id": ammo.id, "rounds_fired": 80}],
    )
    # A no-op second edit (same rounds again) must leave quantity alone,
    # not return+rededuct an extra 80 on top.
    assert coordinator.ammunition[0].quantity == 220


async def test_delete_range_session_restores_round_count(coordinator):
    firearm = await _add_firearm(coordinator)
    session = await coordinator.async_log_range_session(
        datetime.date.today().isoformat(), [{"firearm_id": firearm.id, "rounds_fired": 75}]
    )
    assert coordinator.firearms[0].lifetime_round_count == 75

    await coordinator.async_delete_range_session(session.id)
    assert coordinator.firearms[0].lifetime_round_count == 0


async def test_delete_range_session_restores_ammo(coordinator):
    firearm = await _add_firearm(coordinator)
    ammo = await coordinator.async_add_ammunition(caliber="5.56 NATO", quantity=300)
    session = await coordinator.async_log_range_session(
        datetime.date.today().isoformat(),
        [{"firearm_id": firearm.id, "ammunition_id": ammo.id, "rounds_fired": 120}],
    )
    assert coordinator.ammunition[0].quantity == 180

    await coordinator.async_delete_range_session(session.id)
    assert coordinator.ammunition[0].quantity == 300


async def test_delete_range_session_skips_firearm_deleted_since(coordinator):
    firearm = await _add_firearm(coordinator)
    session = await coordinator.async_log_range_session(
        datetime.date.today().isoformat(), [{"firearm_id": firearm.id, "rounds_fired": 50}]
    )
    await coordinator.async_delete_firearm(firearm.id)

    await coordinator.async_delete_range_session(session.id)  # should not raise
    assert coordinator.range_sessions == []


async def test_delete_range_session_does_not_unbump_schedule(coordinator):
    firearm = await _add_firearm(coordinator)
    await coordinator.async_add_range_schedule(
        targets=[{"target_type": "firearm", "firearm_id": firearm.id}], frequency="quarterly"
    )
    session = await coordinator.async_log_range_session(
        "2026-01-01", [{"firearm_id": firearm.id, "rounds_fired": 10}]
    )
    assert coordinator.range_schedules[0].last_completed_date == "2026-01-01"

    await coordinator.async_delete_range_session(session.id)
    assert coordinator.range_schedules[0].last_completed_date == "2026-01-01"


# ----------------------------------------------------------- range schedule


async def test_add_range_schedule_by_firearm(coordinator):
    firearm = await _add_firearm(coordinator, custom_name="EDC Glock")
    schedule = await coordinator.async_add_range_schedule(
        targets=[{"target_type": "firearm", "firearm_id": firearm.id}], frequency="monthly"
    )
    assert schedule.targets[0].firearm_id == firearm.id
    assert schedule.label == "EDC Glock"


async def test_add_range_schedule_by_firearm_type(coordinator):
    schedule = await coordinator.async_add_range_schedule(
        targets=[{"target_type": "firearm_type", "firearm_type": "Shotgun"}],
        frequency="quarterly",
    )
    assert schedule.targets[0].firearm_type == "Shotgun"
    assert schedule.label == "All Shotguns"


async def test_add_range_schedule_by_caliber(coordinator):
    schedule = await coordinator.async_add_range_schedule(
        targets=[{"target_type": "caliber", "caliber": "300 BLK"}], frequency="quarterly"
    )
    assert schedule.targets[0].caliber == "300 BLK"
    assert schedule.label == "300 BLK ammo"


async def test_add_range_schedule_with_multiple_targets_joins_default_label(coordinator):
    schedule = await coordinator.async_add_range_schedule(
        targets=[
            {"target_type": "caliber", "caliber": "300 BLK"},
            {"target_type": "caliber", "caliber": "5.56"},
        ],
        frequency="quarterly",
    )
    assert len(schedule.targets) == 2
    assert schedule.label == "300 BLK ammo + 5.56 ammo"


async def test_add_range_schedule_blank_target_rounds_min_stores_none(coordinator):
    schedule = await coordinator.async_add_range_schedule(
        targets=[{"target_type": "firearm_type", "firearm_type": "Shotgun", "rounds_min": ""}],
        frequency="quarterly",
    )
    assert schedule.targets[0].rounds_min is None


async def test_add_range_schedule_requires_at_least_one_target(coordinator):
    with pytest.raises(CacheError):
        await coordinator.async_add_range_schedule(targets=[], frequency="monthly")


async def test_add_range_schedule_caliber_target_requires_caliber(coordinator):
    with pytest.raises(CacheError):
        await coordinator.async_add_range_schedule(
            targets=[{"target_type": "caliber"}], frequency="monthly"
        )


async def test_add_range_schedule_stores_target_speed_class(coordinator):
    firearm = await _add_firearm(coordinator)
    schedule = await coordinator.async_add_range_schedule(
        targets=[
            {"target_type": "firearm", "firearm_id": firearm.id, "speed_class": "Subsonic"}
        ],
        frequency="monthly",
    )
    assert schedule.targets[0].speed_class == "Subsonic"


async def test_add_range_schedule_stores_target_bullet_type(coordinator):
    firearm = await _add_firearm(coordinator)
    schedule = await coordinator.async_add_range_schedule(
        targets=[{"target_type": "firearm", "firearm_id": firearm.id, "bullet_type": "JHP"}],
        frequency="monthly",
    )
    assert schedule.targets[0].bullet_type == "JHP"


async def test_add_range_schedule_rejects_invalid_speed_class(coordinator):
    firearm = await _add_firearm(coordinator)
    with pytest.raises(CacheError):
        await coordinator.async_add_range_schedule(
            targets=[
                {"target_type": "firearm", "firearm_id": firearm.id, "speed_class": "Warp Speed"}
            ],
            frequency="monthly",
        )


async def test_add_range_schedule_rejects_invalid_frequency(coordinator):
    with pytest.raises(CacheError):
        await coordinator.async_add_range_schedule(
            targets=[{"target_type": "firearm_type", "firearm_type": "Rifle"}],
            frequency="daily",
        )


async def test_add_range_schedule_firearm_target_requires_firearm_id(coordinator):
    with pytest.raises(CacheError):
        await coordinator.async_add_range_schedule(
            targets=[{"target_type": "firearm"}], frequency="monthly"
        )


async def test_add_range_schedule_rejects_unknown_firearm_type(coordinator):
    with pytest.raises(CacheError):
        await coordinator.async_add_range_schedule(
            targets=[{"target_type": "firearm_type", "firearm_type": "Laser Cannon"}],
            frequency="monthly",
        )


async def test_log_range_session_marks_firearm_targeted_schedule_completed(coordinator):
    firearm = await _add_firearm(coordinator)
    schedule = await coordinator.async_add_range_schedule(
        targets=[{"target_type": "firearm", "firearm_id": firearm.id}], frequency="quarterly"
    )
    assert schedule.last_completed_date is None

    today = datetime.date.today().isoformat()
    await coordinator.async_log_range_session(
        today, [{"firearm_id": firearm.id, "rounds_fired": 50}]
    )

    updated = coordinator.range_schedules[0]
    assert updated.last_completed_date == today


async def test_log_range_session_marks_type_targeted_schedule_completed(coordinator):
    firearm = await _add_firearm(coordinator, firearm_type="Shotgun")
    await coordinator.async_add_range_schedule(
        targets=[{"target_type": "firearm_type", "firearm_type": "Shotgun"}],
        frequency="quarterly",
    )

    today = datetime.date.today().isoformat()
    await coordinator.async_log_range_session(
        today, [{"firearm_id": firearm.id, "rounds_fired": 25}]
    )

    assert coordinator.range_schedules[0].last_completed_date == today


async def test_log_range_session_does_not_complete_unrelated_schedule(coordinator):
    firearm = await _add_firearm(coordinator, firearm_type="Rifle")
    await coordinator.async_add_range_schedule(
        targets=[{"target_type": "firearm_type", "firearm_type": "Shotgun"}],
        frequency="quarterly",
    )

    await coordinator.async_log_range_session(
        datetime.date.today().isoformat(), [{"firearm_id": firearm.id, "rounds_fired": 25}]
    )

    assert coordinator.range_schedules[0].last_completed_date is None


async def test_log_range_session_marks_caliber_targeted_schedule_completed(coordinator):
    firearm = await _add_firearm(coordinator, caliber="300 BLK")
    await coordinator.async_add_range_schedule(
        targets=[{"target_type": "caliber", "caliber": "300 BLK"}], frequency="quarterly"
    )

    today = datetime.date.today().isoformat()
    await coordinator.async_log_range_session(
        today, [{"firearm_id": firearm.id, "rounds_fired": 40}]
    )

    assert coordinator.range_schedules[0].last_completed_date == today


async def test_log_range_session_marks_schedule_completed_via_second_target(coordinator):
    # A multi-caliber AR schedule (300 BLK + 5.56) should complete from
    # either caliber's firearm being logged.
    firearm = await _add_firearm(coordinator, caliber="5.56")
    await coordinator.async_add_range_schedule(
        targets=[
            {"target_type": "caliber", "caliber": "300 BLK"},
            {"target_type": "caliber", "caliber": "5.56"},
        ],
        frequency="quarterly",
    )

    today = datetime.date.today().isoformat()
    await coordinator.async_log_range_session(
        today, [{"firearm_id": firearm.id, "rounds_fired": 40}]
    )

    assert coordinator.range_schedules[0].last_completed_date == today


async def test_log_range_session_does_not_complete_unrelated_caliber_schedule(coordinator):
    firearm = await _add_firearm(coordinator, caliber="9mm")
    await coordinator.async_add_range_schedule(
        targets=[{"target_type": "caliber", "caliber": "300 BLK"}], frequency="quarterly"
    )

    await coordinator.async_log_range_session(
        datetime.date.today().isoformat(), [{"firearm_id": firearm.id, "rounds_fired": 40}]
    )

    assert coordinator.range_schedules[0].last_completed_date is None


async def test_update_range_schedule_replaces_targets(coordinator):
    schedule = await coordinator.async_add_range_schedule(
        targets=[{"target_type": "firearm_type", "firearm_type": "Shotgun"}],
        frequency="quarterly",
    )
    updated = await coordinator.async_update_range_schedule(
        schedule.id, targets=[{"target_type": "caliber", "caliber": "12ga"}]
    )
    assert len(updated.targets) == 1
    assert updated.targets[0].target_type == "caliber"
    assert updated.targets[0].caliber == "12ga"


async def test_delete_range_schedule(coordinator):
    schedule = await coordinator.async_add_range_schedule(
        targets=[{"target_type": "firearm_type", "firearm_type": "Handgun"}],
        frequency="monthly",
    )
    await coordinator.async_delete_range_schedule(schedule.id)
    assert coordinator.range_schedules == []


async def test_range_schedule_ammo_alert_end_to_end(coordinator):
    await _add_firearm(coordinator, firearm_type="Shotgun", caliber="12ga")
    await coordinator.async_add_ammunition(caliber="12ga", quantity=10)
    schedule = await coordinator.async_add_range_schedule(
        targets=[
            {"target_type": "firearm_type", "firearm_type": "Shotgun", "rounds_min": 50}
        ],
        frequency="quarterly",
        ammo_alert_enabled=True,
    )

    from cache_addon import logic

    assert (
        logic.range_schedule_ammo_ok(schedule, coordinator.firearms, coordinator.ammunition)
        is False
    )
    assert schedule.id in [
        s.id
        for s in logic.range_schedules_with_ammo_alert(
            coordinator.range_schedules, coordinator.firearms, coordinator.ammunition
        )
    ]


# ------------------------------------------------------------- training plan


def _plan_step(**overrides):
    fields = dict(
        label="Step 1", targets=[{"target_type": "firearm_type", "firearm_type": "Rifle"}]
    )
    fields.update(overrides)
    return fields


async def test_add_training_plan_sequential_basic(coordinator):
    plan = await coordinator.async_add_training_plan(
        mode="sequential", steps=[_plan_step(label="Pistols")]
    )
    assert plan.mode == "sequential"
    assert plan.current_step_index == 0
    assert plan.steps[0].label == "Pistols"
    assert plan.label == "Pistols"


async def test_add_training_plan_multi_step_joins_default_label(coordinator):
    plan = await coordinator.async_add_training_plan(
        mode="sequential",
        steps=[
            _plan_step(label="Pistols"),
            _plan_step(label="Rifles"),
            _plan_step(label="Shotguns"),
        ],
    )
    assert plan.label == "Pistols + 2 more"


async def test_add_training_plan_calendar_requires_start_month_and_year(coordinator):
    with pytest.raises(CacheError):
        await coordinator.async_add_training_plan(mode="calendar", steps=[_plan_step()])


async def test_add_training_plan_calendar_with_start_date(coordinator):
    plan = await coordinator.async_add_training_plan(
        mode="calendar", steps=[_plan_step()], start_month=1, start_year=2026
    )
    assert plan.start_month == 1
    assert plan.start_year == 2026


async def test_add_training_plan_requires_at_least_one_step(coordinator):
    with pytest.raises(CacheError):
        await coordinator.async_add_training_plan(mode="sequential", steps=[])


async def test_add_training_plan_rejects_invalid_mode(coordinator):
    with pytest.raises(CacheError):
        await coordinator.async_add_training_plan(mode="whenever", steps=[_plan_step()])


async def test_add_training_plan_step_requires_label(coordinator):
    with pytest.raises(CacheError):
        await coordinator.async_add_training_plan(
            mode="sequential", steps=[_plan_step(label="")]
        )


async def test_add_training_plan_stores_target_rounds_min(coordinator):
    plan = await coordinator.async_add_training_plan(
        mode="sequential",
        steps=[
            _plan_step(
                targets=[
                    {"target_type": "firearm_type", "firearm_type": "Rifle", "rounds_min": 50}
                ]
            )
        ],
    )
    assert plan.steps[0].targets[0].rounds_min == 50


async def test_update_training_plan_replaces_steps(coordinator):
    plan = await coordinator.async_add_training_plan(
        mode="sequential", steps=[_plan_step(label="Old Step")]
    )
    updated = await coordinator.async_update_training_plan(
        plan.id, steps=[_plan_step(label="New Step")]
    )
    assert len(updated.steps) == 1
    assert updated.steps[0].label == "New Step"


async def test_update_training_plan_switch_to_calendar_requires_start_date(coordinator):
    plan = await coordinator.async_add_training_plan(
        mode="sequential", steps=[_plan_step()]
    )
    with pytest.raises(CacheError):
        await coordinator.async_update_training_plan(plan.id, mode="calendar")


async def test_delete_training_plan(coordinator):
    plan = await coordinator.async_add_training_plan(
        mode="sequential", steps=[_plan_step()]
    )
    await coordinator.async_delete_training_plan(plan.id)
    assert coordinator.training_plans == []


async def test_advance_training_plan_sequential_moves_to_next_step(coordinator):
    plan = await coordinator.async_add_training_plan(
        mode="sequential",
        steps=[_plan_step(label="Step 1"), _plan_step(label="Step 2")],
    )
    today = datetime.date.today().isoformat()
    updated = await coordinator.async_advance_training_plan(plan.id, today)
    assert updated.current_step_index == 1
    assert updated.steps[0].last_completed_date == today


async def test_advance_training_plan_calendar_records_completion_without_moving_index(
    coordinator,
):
    plan = await coordinator.async_add_training_plan(
        mode="calendar",
        steps=[_plan_step(label="Step 1"), _plan_step(label="Step 2")],
        start_month=1,
        start_year=2026,
    )
    today = datetime.date.today().isoformat()
    updated = await coordinator.async_advance_training_plan(plan.id, today)
    assert updated.current_step_index == 0


async def test_log_range_session_advances_sequential_training_plan(coordinator):
    firearm = await _add_firearm(coordinator, firearm_type="Shotgun")
    await coordinator.async_add_training_plan(
        mode="sequential",
        steps=[
            _plan_step(
                label="Step 1",
                targets=[{"target_type": "firearm_type", "firearm_type": "Shotgun"}],
            ),
            _plan_step(
                label="Step 2",
                targets=[{"target_type": "firearm_type", "firearm_type": "Rifle"}],
            ),
        ],
    )

    today = datetime.date.today().isoformat()
    await coordinator.async_log_range_session(
        today, [{"firearm_id": firearm.id, "rounds_fired": 25}]
    )

    updated = coordinator.training_plans[0]
    assert updated.current_step_index == 1
    assert updated.steps[0].last_completed_date == today


async def test_log_range_session_does_not_advance_unrelated_training_plan_step(coordinator):
    firearm = await _add_firearm(coordinator, firearm_type="Rifle")
    await coordinator.async_add_training_plan(
        mode="sequential",
        steps=[
            _plan_step(
                label="Step 1",
                targets=[{"target_type": "firearm_type", "firearm_type": "Shotgun"}],
            ),
        ],
    )

    await coordinator.async_log_range_session(
        datetime.date.today().isoformat(), [{"firearm_id": firearm.id, "rounds_fired": 25}]
    )

    assert coordinator.training_plans[0].steps[0].last_completed_date is None
    assert coordinator.training_plans[0].current_step_index == 0


async def test_training_plan_ammo_alert_end_to_end(coordinator):
    await _add_firearm(coordinator, firearm_type="Shotgun", caliber="12ga")
    await coordinator.async_add_ammunition(caliber="12ga", quantity=10)
    plan = await coordinator.async_add_training_plan(
        mode="sequential",
        ammo_alert_enabled=True,
        steps=[
            _plan_step(
                label="Step 1",
                targets=[
                    {"target_type": "firearm_type", "firearm_type": "Shotgun", "rounds_min": 50}
                ],
            )
        ],
    )

    from cache_addon import logic

    step = logic.training_plan_current_step(plan)
    assert (
        logic.training_plan_step_ammo_ok(plan, step, coordinator.firearms, coordinator.ammunition)
        is False
    )
    assert plan.id in [
        p.id
        for p in logic.training_plans_with_ammo_alert(
            coordinator.training_plans, coordinator.firearms, coordinator.ammunition
        )
    ]


# ------------------------------------------------------------ ammo alert rules


async def test_add_ammo_alert_rule(coordinator):
    rule = await coordinator.async_add_ammo_alert_rule("caliber", "9mm", 100)
    assert rule.match_type == "caliber"
    assert rule.match_value == "9mm"
    assert rule.threshold == 100
    assert coordinator.ammo_alert_rules == [rule]


async def test_add_ammo_alert_rule_rejects_invalid_match_type(coordinator):
    with pytest.raises(CacheError):
        await coordinator.async_add_ammo_alert_rule("manufacturer", "Federal", 100)


async def test_add_ammo_alert_rule_rejects_invalid_speed_class_value(coordinator):
    with pytest.raises(CacheError):
        await coordinator.async_add_ammo_alert_rule("speed_class", "Warp Speed", 100)


async def test_add_ammo_alert_rule_requires_match_value(coordinator):
    with pytest.raises(CacheError):
        await coordinator.async_add_ammo_alert_rule("caliber", "", 100)


async def test_update_ammo_alert_rule_changes_threshold(coordinator):
    rule = await coordinator.async_add_ammo_alert_rule("caliber", "9mm", 100)
    updated = await coordinator.async_update_ammo_alert_rule(rule.id, threshold=250)
    assert updated.threshold == 250
    assert updated.match_value == "9mm"


async def test_delete_ammo_alert_rule(coordinator):
    rule = await coordinator.async_add_ammo_alert_rule("caliber", "9mm", 100)
    await coordinator.async_delete_ammo_alert_rule(rule.id)
    assert coordinator.ammo_alert_rules == []


async def test_ammo_alert_rule_applied_end_to_end(coordinator):
    await coordinator.async_add_ammo_alert_rule("caliber", "9mm", 200)
    ammo = await coordinator.async_add_ammunition(caliber="9mm", quantity=50)

    from cache_addon import logic

    assert logic.is_ammo_low(ammo, coordinator.settings, coordinator.ammo_alert_rules) is True


# ----------------------------------------------------------------- cleaning


async def test_mark_cleaned_records_history_and_updates_firearm(coordinator):
    firearm = await _add_firearm(coordinator)
    await coordinator.async_add_rounds(firearm.id, 400)

    today = datetime.date.today().isoformat()
    entry = await coordinator.async_mark_cleaned(firearm.id, today, notes="Full strip clean")
    assert entry.round_count_at_cleaning == 400

    updated = coordinator.firearms[0]
    assert updated.last_cleaning_date == today
    assert len(updated.cleaning_history) == 1


async def test_needs_cleaning_by_round_count(coordinator):
    await coordinator.async_update_settings(
        cleaning_reminder_rounds=200, cleaning_reminder_days=9999
    )
    firearm = await _add_firearm(coordinator)
    await coordinator.async_add_rounds(firearm.id, 250)

    from cache_addon import logic

    due = logic.cleaning_due_firearms(coordinator.firearms, coordinator.settings)
    assert firearm.id in [f.id for f in due]


async def test_needs_cleaning_resets_after_cleaning(coordinator):
    await coordinator.async_update_settings(
        cleaning_reminder_rounds=200, cleaning_reminder_days=9999
    )
    firearm = await _add_firearm(coordinator)
    await coordinator.async_add_rounds(firearm.id, 250)
    await coordinator.async_mark_cleaned(firearm.id, datetime.date.today().isoformat())

    from cache_addon import logic

    due = logic.cleaning_due_firearms(coordinator.firearms, coordinator.settings)
    assert firearm.id not in [f.id for f in due]


# ------------------------------------------------------------------ locations


async def test_duplicate_storage_location_name_rejected(coordinator):
    await _add_location(coordinator, "Main Safe")
    with pytest.raises(CacheError):
        await _add_location(coordinator, "Main Safe")


async def test_delete_storage_location_unassigns_firearms(coordinator):
    location = await _add_location(coordinator)
    await _add_firearm(coordinator, storage_location_id=location.id)

    await coordinator.async_delete_storage_location(location.id)

    assert coordinator.firearms[0].storage_location_id is None


# -------------------------------------------------------- diagram images


async def test_set_diagram_reference_image(coordinator):
    previous = await coordinator.async_set_diagram_reference_image("shotgun", "abc123.jpg")
    assert previous is None
    assert coordinator.settings.diagram_reference_images == {"shotgun": "abc123.jpg"}


async def test_set_diagram_reference_image_returns_previous_filename(coordinator):
    await coordinator.async_set_diagram_reference_image("shotgun", "old.jpg")
    previous = await coordinator.async_set_diagram_reference_image("shotgun", "new.jpg")
    assert previous == "old.jpg"
    assert coordinator.settings.diagram_reference_images == {"shotgun": "new.jpg"}


async def test_clear_diagram_reference_image(coordinator):
    await coordinator.async_set_diagram_reference_image("shotgun", "abc123.jpg")
    previous = await coordinator.async_clear_diagram_reference_image("shotgun")
    assert previous == "abc123.jpg"
    assert coordinator.settings.diagram_reference_images == {}


async def test_clear_diagram_reference_image_missing_type_is_noop(coordinator):
    previous = await coordinator.async_clear_diagram_reference_image("shotgun")
    assert previous is None
    assert coordinator.settings.diagram_reference_images == {}


async def test_diagram_reference_images_default_empty(coordinator):
    assert coordinator.settings.diagram_reference_images == {}


# ------------------------------------------------------------------- photos


async def test_replace_photo_file_swaps_filename_keeps_rest(coordinator):
    firearm = await _add_firearm(coordinator)
    photo = await coordinator.async_add_photo("firearm", firearm.id, "original.jpg", "gun.jpg")

    previous = await coordinator.async_replace_photo_file(photo.id, "cutout.png")

    assert previous == "original.jpg"
    stored = coordinator.firearms[0].photos[0]
    assert stored.filename == "cutout.png"
    assert stored.id == photo.id
    assert stored.original_filename == "gun.jpg"
    assert stored.is_primary is True


async def test_replace_photo_file_works_on_inventory_item_photo(coordinator):
    item = await _add_item(coordinator)
    photo = await coordinator.async_add_photo("inventory_item", item.id, "part.jpg")

    previous = await coordinator.async_replace_photo_file(photo.id, "part-cutout.png")

    assert previous == "part.jpg"
    assert coordinator.inventory_items[0].photos[0].filename == "part-cutout.png"


async def test_replace_photo_file_rejects_missing_photo(coordinator):
    with pytest.raises(CacheError):
        await coordinator.async_replace_photo_file("does-not-exist", "cutout.png")
