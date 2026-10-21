"""listing_text and fallback_fields are the deterministic pieces of
barcode_client.py - lookup_upc itself is a live network call to UPCitemdb,
out of scope for these fast unit tests (same boundary as openai_client.py's
network call - see CLAUDE.md)."""
from __future__ import annotations

from cache_addon.barcode_client import fallback_fields, listing_text


def test_listing_text_joins_available_fields():
    item = {
        "title": "Federal American Eagle 9mm 115gr FMJ",
        "brand": "Federal",
        "description": "50rd box",
    }
    assert listing_text(item) == "Federal American Eagle 9mm 115gr FMJ - Federal - 50rd box"


def test_listing_text_skips_missing_fields():
    item = {"title": "Federal American Eagle 9mm", "brand": None}
    assert listing_text(item) == "Federal American Eagle 9mm"


def test_listing_text_empty_when_nothing_present():
    assert listing_text({}) == ""


def test_fallback_fields_maps_brand_and_title():
    item = {"brand": "Hornady", "title": "Hornady Critical Defense .380 ACP"}
    fields = fallback_fields(item)
    assert fields["manufacturer"] == "Hornady"
    assert fields["product_name"] == "Hornady Critical Defense .380 ACP"
    assert fields["caliber"] is None
    assert fields["bullet_weight"] is None
    assert fields["bullet_type"] is None
    assert fields["muzzle_velocity"] is None
    assert fields["rounds_per_box"] is None


def test_fallback_fields_none_when_brand_and_title_missing():
    fields = fallback_fields({})
    assert fields["manufacturer"] is None
    assert fields["product_name"] is None
