"""CacheStore._async_migrate_func - the schema migration bumped alongside
the Category/Part taxonomy change (STORAGE_VERSION 1 -> 2). The pure
per-item transform itself is tested directly in test_logic.py
(migrate_inventory_item_taxonomy) - this just confirms the Store-level hook
actually applies it to every stored inventory item and leaves other
top-level keys untouched.
"""
from __future__ import annotations

import pytest

from cache_addon.storage import CacheStore


@pytest.fixture
def store() -> CacheStore:
    # __new__ skips __init__ (which wants a file path) - _async_migrate_func
    # never touches `self`, so a bare instance is all it needs.
    return CacheStore.__new__(CacheStore)


async def test_migrate_applies_taxonomy_split_to_every_inventory_item(store):
    old_data = {
        "version": 1,
        "settings": {},
        "inventory_items": [
            {"id": "i1", "custom_name": "EOTech", "category": "Optic Mount"},
            {"id": "i2", "custom_name": "Old Sling", "category": "Sling"},
        ],
    }
    migrated = await store._async_migrate_func(1, 0, old_data)
    items_by_id = {i["id"]: i for i in migrated["inventory_items"]}
    assert items_by_id["i1"]["category"] == "Optic"
    assert items_by_id["i1"]["part_type"] == "Optic Mount"
    assert items_by_id["i2"]["category"] == "Accessory"
    assert items_by_id["i2"]["part_type"] == "Other / Miscellaneous"


async def test_migrate_leaves_other_top_level_keys_untouched(store):
    old_data = {"version": 1, "settings": {"collection_name": "My Armory"}, "inventory_items": []}
    migrated = await store._async_migrate_func(1, 0, old_data)
    assert migrated["settings"] == {"collection_name": "My Armory"}


async def test_migrate_is_a_noop_already_on_version_2(store):
    old_data = {
        "version": 2,
        "inventory_items": [
            {"id": "i1", "custom_name": "EOTech", "category": "Optic", "part_type": "Optic"}
        ],
    }
    migrated = await store._async_migrate_func(2, 0, old_data)
    assert migrated["inventory_items"][0]["part_type"] == "Optic"
