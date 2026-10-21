"""Dataclasses for the Cache integration.

Conventions (matching ha-hustle-integration/ha-finance-integration):
- `new_id()` returns a UUID4 hex string.
- `created_at`/`updated_at` are ISO datetime strings.
- Photos, documents, and cleaning history nest inside their parent Firearm
  (and photos inside InventoryItem) rather than living in separate top-level
  lists - there's no cross-entity query need that would justify a flat list,
  and nesting keeps a firearm's full detail payload in one sensor's
  attributes. Ammunition transactions nest the same way, ring-buffered.
- `InventoryItem` never stores its own location while installed - it's
  computed from whichever firearm it's installed on (see
  `logic.effective_location_id`). Only `installed_firearm_id` +
  `installed_slot_type` are persisted.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime


def new_id() -> str:
    return uuid.uuid4().hex


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


def _as_int(value: object) -> int | None:
    """Tolerates a stray "" or other non-numeric value that slipped into
    storage from an add-flow that skipped coordinator._normalize() (fixed,
    but old bad data can still be sitting in an existing Store) - loading
    should never crash on a malformed optional numeric field."""
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_float(value: object) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------------ photos --


@dataclass
class Photo:
    id: str
    filename: str
    original_filename: str | None = None
    is_primary: bool = False
    uploaded_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "filename": self.filename,
            "original_filename": self.original_filename,
            "is_primary": self.is_primary,
            "uploaded_at": self.uploaded_at,
        }

    @staticmethod
    def from_dict(data: dict) -> Photo:
        return Photo(
            id=data["id"],
            filename=data["filename"],
            original_filename=data.get("original_filename"),
            is_primary=data.get("is_primary", False),
            uploaded_at=data.get("uploaded_at", now_iso()),
        )


@dataclass
class Document:
    id: str
    filename: str
    original_filename: str | None = None
    document_type: str = "Other"
    uploaded_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "filename": self.filename,
            "original_filename": self.original_filename,
            "document_type": self.document_type,
            "uploaded_at": self.uploaded_at,
        }

    @staticmethod
    def from_dict(data: dict) -> Document:
        return Document(
            id=data["id"],
            filename=data["filename"],
            original_filename=data.get("original_filename"),
            document_type=data.get("document_type", "Other"),
            uploaded_at=data.get("uploaded_at", now_iso()),
        )


@dataclass
class CleaningLogEntry:
    id: str
    cleaned_date: str
    round_count_at_cleaning: int = 0
    notes: str | None = None
    created_at: str = field(default_factory=now_iso)
    created_by: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "cleaned_date": self.cleaned_date,
            "round_count_at_cleaning": self.round_count_at_cleaning,
            "notes": self.notes,
            "created_at": self.created_at,
            "created_by": self.created_by,
        }

    @staticmethod
    def from_dict(data: dict) -> CleaningLogEntry:
        return CleaningLogEntry(
            id=data["id"],
            cleaned_date=data["cleaned_date"],
            round_count_at_cleaning=data.get("round_count_at_cleaning", 0),
            notes=data.get("notes"),
            created_at=data.get("created_at", now_iso()),
            created_by=data.get("created_by"),
        )


# ------------------------------------------------------------------ storage --


@dataclass
class StorageLocation:
    id: str
    name: str
    description: str | None = None
    created_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "created_at": self.created_at,
        }

    @staticmethod
    def from_dict(data: dict) -> StorageLocation:
        return StorageLocation(
            id=data["id"],
            name=data["name"],
            description=data.get("description"),
            created_at=data.get("created_at", now_iso()),
        )


# ----------------------------------------------------------------- firearms --


@dataclass
class Firearm:
    id: str
    custom_name: str
    firearm_type: str
    manufacturer: str | None = None
    model: str | None = None
    serial_number: str | None = None
    caliber: str | None = None
    barrel_length: str | None = None
    overall_length: str | None = None
    weight: str | None = None
    twist_rate: str | None = None
    capacity: str | None = None
    finish: str | None = None
    color: str | None = None
    condition: str | None = None

    purchase_date: str | None = None
    purchase_price: float | None = None
    current_estimated_value: float | None = None
    purchased_from: str | None = None
    warranty_expiration: str | None = None
    warranty_notes: str | None = None
    # Optional link to a product page/listing - useful for a wishlist
    # firearm (where to buy it) but not restricted to wishlist entries,
    # same as every other field here.
    product_url: str | None = None

    uses: list[str] = field(default_factory=list)

    storage_location_id: str | None = None
    lifetime_round_count: int = 0
    last_fired_date: str | None = None
    last_cleaning_date: str | None = None
    round_count_at_last_cleaning: int = 0
    notes: str | None = None
    primary_photo_id: str | None = None

    # A wishlist firearm is a normal Firearm record, just flagged - not a
    # separate entity - so it can reuse every existing field (current_
    # estimated_value doubles as "what I think this will cost", filled in
    # for real once actually bought) rather than needing its own shadow
    # model. dashboard_stats excludes is_wishlist=True firearms from every
    # "owned collection" total and instead rolls them into their own
    # separate wishlist_* aggregates (see logic.dashboard_stats).
    #
    # wishlist_rank replaces the old 3-tier High/Medium/Low priority for
    # firearms specifically (InventoryItem still uses wishlist_priority -
    # only firearms got a drag-and-drop reorder UI) - a full, user-
    # controlled ordering across every wishlist firearm, 0 = wanted most.
    # Only means anything while is_wishlist is True. Coordinator-managed,
    # not a plain settable field: auto-assigned to the next rank when a
    # firearm is newly wishlisted (add or update), cleared back to None
    # when un-wishlisted, and only ever reassigned in bulk by
    # async_reorder_wishlist_firearms (the drag-and-drop list saves the
    # complete new order in one call, not per-item deltas).
    is_wishlist: bool = False
    wishlist_rank: int | None = None

    photos: list[Photo] = field(default_factory=list)
    documents: list[Document] = field(default_factory=list)
    cleaning_history: list[CleaningLogEntry] = field(default_factory=list)

    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)
    created_by: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "custom_name": self.custom_name,
            "firearm_type": self.firearm_type,
            "manufacturer": self.manufacturer,
            "model": self.model,
            "serial_number": self.serial_number,
            "caliber": self.caliber,
            "barrel_length": self.barrel_length,
            "overall_length": self.overall_length,
            "weight": self.weight,
            "twist_rate": self.twist_rate,
            "capacity": self.capacity,
            "finish": self.finish,
            "color": self.color,
            "condition": self.condition,
            "purchase_date": self.purchase_date,
            "purchase_price": self.purchase_price,
            "current_estimated_value": self.current_estimated_value,
            "purchased_from": self.purchased_from,
            "warranty_expiration": self.warranty_expiration,
            "warranty_notes": self.warranty_notes,
            "product_url": self.product_url,
            "uses": self.uses,
            "storage_location_id": self.storage_location_id,
            "lifetime_round_count": self.lifetime_round_count,
            "last_fired_date": self.last_fired_date,
            "last_cleaning_date": self.last_cleaning_date,
            "round_count_at_last_cleaning": self.round_count_at_last_cleaning,
            "notes": self.notes,
            "primary_photo_id": self.primary_photo_id,
            "is_wishlist": self.is_wishlist,
            "wishlist_rank": self.wishlist_rank,
            "photos": [p.to_dict() for p in self.photos],
            "documents": [d.to_dict() for d in self.documents],
            "cleaning_history": [c.to_dict() for c in self.cleaning_history],
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "created_by": self.created_by,
        }

    @staticmethod
    def from_dict(data: dict) -> Firearm:
        return Firearm(
            id=data["id"],
            custom_name=data["custom_name"],
            firearm_type=data["firearm_type"],
            manufacturer=data.get("manufacturer"),
            model=data.get("model"),
            serial_number=data.get("serial_number"),
            caliber=data.get("caliber"),
            barrel_length=data.get("barrel_length"),
            overall_length=data.get("overall_length"),
            weight=data.get("weight"),
            twist_rate=data.get("twist_rate"),
            capacity=data.get("capacity"),
            finish=data.get("finish"),
            color=data.get("color"),
            condition=data.get("condition"),
            purchase_date=data.get("purchase_date"),
            purchase_price=_as_float(data.get("purchase_price")),
            current_estimated_value=_as_float(data.get("current_estimated_value")),
            purchased_from=data.get("purchased_from"),
            warranty_expiration=data.get("warranty_expiration"),
            warranty_notes=data.get("warranty_notes"),
            product_url=data.get("product_url"),
            uses=list(data.get("uses", [])),
            storage_location_id=data.get("storage_location_id"),
            lifetime_round_count=data.get("lifetime_round_count", 0),
            last_fired_date=data.get("last_fired_date"),
            last_cleaning_date=data.get("last_cleaning_date"),
            round_count_at_last_cleaning=data.get("round_count_at_last_cleaning", 0),
            notes=data.get("notes"),
            primary_photo_id=data.get("primary_photo_id"),
            is_wishlist=data.get("is_wishlist", False),
            wishlist_rank=_as_int(data.get("wishlist_rank")),
            photos=[Photo.from_dict(p) for p in data.get("photos", [])],
            documents=[Document.from_dict(d) for d in data.get("documents", [])],
            cleaning_history=[
                CleaningLogEntry.from_dict(c) for c in data.get("cleaning_history", [])
            ],
            created_at=data.get("created_at", now_iso()),
            updated_at=data.get("updated_at", now_iso()),
            created_by=data.get("created_by"),
        )


# ---------------------------------------------------------------- inventory --


@dataclass
class InventoryItem:
    id: str
    custom_name: str
    category: str
    # The specific, installable thing (e.g. "Optic Mount") - category is
    # the coarser grouping it belongs to (e.g. "Optic"). See const.py's
    # PART_TAXONOMY. Optional/defaulted (not required like category) so
    # from_dict tolerates pre-taxonomy stored data and test fixtures that
    # don't set it, same as other optional fields in this dataclass -
    # storage.py's schema migration backfills it for real stored items.
    part_type: str | None = None
    manufacturer: str | None = None
    model: str | None = None
    serial_number: str | None = None
    purchase_date: str | None = None
    purchase_price: float | None = None
    estimated_value: float | None = None
    condition: str | None = None
    notes: str | None = None

    storage_location_id: str | None = None
    installed_firearm_id: str | None = None
    installed_slot_type: str | None = None
    installed_at: str | None = None

    # Same wishlist convention as Firearm - see the comment there. A
    # wishlist part CAN be installed_firearm_id-installed like any other
    # item - My Build lets you install a wishlist part onto any firearm to
    # preview a wanted build - but see logic.firearm_effective_value,
    # which deliberately excludes installed wishlist parts from a
    # firearm's displayed value so that preview doesn't count as money
    # actually spent.
    is_wishlist: bool = False
    wishlist_priority: str | None = None

    # Same idea as Firearm.product_url - a link to buy/reference this
    # part, most useful while it's still on the wishlist.
    product_url: str | None = None

    photos: list[Photo] = field(default_factory=list)

    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "custom_name": self.custom_name,
            "category": self.category,
            "part_type": self.part_type,
            "manufacturer": self.manufacturer,
            "model": self.model,
            "serial_number": self.serial_number,
            "purchase_date": self.purchase_date,
            "purchase_price": self.purchase_price,
            "estimated_value": self.estimated_value,
            "condition": self.condition,
            "notes": self.notes,
            "storage_location_id": self.storage_location_id,
            "installed_firearm_id": self.installed_firearm_id,
            "installed_slot_type": self.installed_slot_type,
            "installed_at": self.installed_at,
            "is_wishlist": self.is_wishlist,
            "wishlist_priority": self.wishlist_priority,
            "product_url": self.product_url,
            "photos": [p.to_dict() for p in self.photos],
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @staticmethod
    def from_dict(data: dict) -> InventoryItem:
        return InventoryItem(
            id=data["id"],
            custom_name=data["custom_name"],
            category=data["category"],
            part_type=data.get("part_type"),
            manufacturer=data.get("manufacturer"),
            model=data.get("model"),
            serial_number=data.get("serial_number"),
            purchase_date=data.get("purchase_date"),
            purchase_price=_as_float(data.get("purchase_price")),
            estimated_value=_as_float(data.get("estimated_value")),
            condition=data.get("condition"),
            notes=data.get("notes"),
            storage_location_id=data.get("storage_location_id"),
            installed_firearm_id=data.get("installed_firearm_id"),
            installed_slot_type=data.get("installed_slot_type"),
            installed_at=data.get("installed_at"),
            is_wishlist=data.get("is_wishlist", False),
            wishlist_priority=data.get("wishlist_priority"),
            product_url=data.get("product_url"),
            photos=[Photo.from_dict(p) for p in data.get("photos", [])],
            created_at=data.get("created_at", now_iso()),
            updated_at=data.get("updated_at", now_iso()),
        )


# --------------------------------------------------------------- ammunition --


@dataclass
class AmmoTransaction:
    id: str
    change_type: str  # add | remove | adjust | range_session
    quantity_delta: int
    resulting_quantity: int
    note: str | None = None
    range_session_id: str | None = None
    created_at: str = field(default_factory=now_iso)
    created_by: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "change_type": self.change_type,
            "quantity_delta": self.quantity_delta,
            "resulting_quantity": self.resulting_quantity,
            "note": self.note,
            "range_session_id": self.range_session_id,
            "created_at": self.created_at,
            "created_by": self.created_by,
        }

    @staticmethod
    def from_dict(data: dict) -> AmmoTransaction:
        return AmmoTransaction(
            id=data["id"],
            change_type=data["change_type"],
            quantity_delta=data["quantity_delta"],
            resulting_quantity=data["resulting_quantity"],
            note=data.get("note"),
            range_session_id=data.get("range_session_id"),
            created_at=data.get("created_at", now_iso()),
            created_by=data.get("created_by"),
        )


@dataclass
class Ammunition:
    id: str
    caliber: str
    manufacturer: str | None = None
    product_name: str | None = None
    bullet_weight: str | None = None
    bullet_type: str | None = None
    muzzle_velocity: str | None = None
    quantity: int = 0
    cost_per_box: float | None = None
    rounds_per_box: int | None = None
    cost_per_round: float | None = None
    purchase_date: str | None = None
    storage_location_id: str | None = None
    notes: str | None = None
    low_inventory_threshold: int | None = None

    transactions: list[AmmoTransaction] = field(default_factory=list)

    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "caliber": self.caliber,
            "manufacturer": self.manufacturer,
            "product_name": self.product_name,
            "bullet_weight": self.bullet_weight,
            "bullet_type": self.bullet_type,
            "muzzle_velocity": self.muzzle_velocity,
            "quantity": self.quantity,
            "cost_per_box": self.cost_per_box,
            "rounds_per_box": self.rounds_per_box,
            "cost_per_round": self.cost_per_round,
            "purchase_date": self.purchase_date,
            "storage_location_id": self.storage_location_id,
            "notes": self.notes,
            "low_inventory_threshold": self.low_inventory_threshold,
            "transactions": [t.to_dict() for t in self.transactions],
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @staticmethod
    def from_dict(data: dict) -> Ammunition:
        return Ammunition(
            id=data["id"],
            caliber=data["caliber"],
            manufacturer=data.get("manufacturer"),
            product_name=data.get("product_name"),
            bullet_weight=data.get("bullet_weight"),
            bullet_type=data.get("bullet_type"),
            muzzle_velocity=data.get("muzzle_velocity"),
            quantity=_as_int(data.get("quantity")) or 0,
            cost_per_box=_as_float(data.get("cost_per_box")),
            rounds_per_box=_as_int(data.get("rounds_per_box")),
            cost_per_round=_as_float(data.get("cost_per_round")),
            purchase_date=data.get("purchase_date"),
            storage_location_id=data.get("storage_location_id"),
            notes=data.get("notes"),
            low_inventory_threshold=_as_int(data.get("low_inventory_threshold")),
            transactions=[AmmoTransaction.from_dict(t) for t in data.get("transactions", [])],
            created_at=data.get("created_at", now_iso()),
            updated_at=data.get("updated_at", now_iso()),
        )


@dataclass
class AmmoAlertRule:
    """A low-inventory threshold applied to every Ammunition entry matching
    one caliber/bullet_type/speed_class value, rather than the single global
    CacheSettings.low_ammo_threshold_default applying to everything - see
    logic.effective_low_ammo_threshold for the priority order (an entry's
    own low_inventory_threshold always wins over any rule)."""

    id: str
    match_type: str  # "caliber" | "bullet_type" | "speed_class"
    match_value: str
    threshold: int
    created_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "match_type": self.match_type,
            "match_value": self.match_value,
            "threshold": self.threshold,
            "created_at": self.created_at,
        }

    @staticmethod
    def from_dict(data: dict) -> AmmoAlertRule:
        return AmmoAlertRule(
            id=data["id"],
            match_type=data["match_type"],
            match_value=data["match_value"],
            threshold=_as_int(data.get("threshold")) or 0,
            created_at=data.get("created_at", now_iso()),
        )


# ----------------------------------------------------------- range sessions --


@dataclass
class RangeSessionFirearmEntry:
    firearm_id: str
    rounds_fired: int
    ammunition_id: str | None = None

    def to_dict(self) -> dict:
        return {
            "firearm_id": self.firearm_id,
            "rounds_fired": self.rounds_fired,
            "ammunition_id": self.ammunition_id,
        }

    @staticmethod
    def from_dict(data: dict) -> RangeSessionFirearmEntry:
        return RangeSessionFirearmEntry(
            firearm_id=data["firearm_id"],
            rounds_fired=data.get("rounds_fired", 0),
            ammunition_id=data.get("ammunition_id"),
        )


@dataclass
class RangeSession:
    id: str
    date: str
    location: str | None = None
    notes: str | None = None
    firearms: list[RangeSessionFirearmEntry] = field(default_factory=list)
    created_at: str = field(default_factory=now_iso)
    created_by: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "date": self.date,
            "location": self.location,
            "notes": self.notes,
            "firearms": [f.to_dict() for f in self.firearms],
            "created_at": self.created_at,
            "created_by": self.created_by,
        }

    @staticmethod
    def from_dict(data: dict) -> RangeSession:
        return RangeSession(
            id=data["id"],
            date=data["date"],
            location=data.get("location"),
            notes=data.get("notes"),
            firearms=[RangeSessionFirearmEntry.from_dict(f) for f in data.get("firearms", [])],
            created_at=data.get("created_at", now_iso()),
            created_by=data.get("created_by"),
        )


# ----------------------------------------------------------- range schedule --


@dataclass
class RangeScheduleTarget:
    """One entry in a schedule's "Train with" list - a schedule matches a
    firearm if it satisfies ANY of its targets, so e.g. one AR upper-swap
    schedule can list both a 300 BLK and a 5.56 caliber target.
    `speed_class`/`bullet_type` are optional ammo filters on top of the
    target itself - e.g. "my suppressed pistol, but only subsonic ammo" or
    "only JHP" - see logic.range_schedule_ammo_ok."""

    target_type: str  # "firearm" | "firearm_type" | "caliber"
    firearm_id: str | None = None
    firearm_type: str | None = None
    caliber: str | None = None
    speed_class: str | None = None  # None | "Subsonic" | "Supersonic"
    bullet_type: str | None = None  # e.g. "FMJ", "JHP", "Buckshot" - matches Ammunition.bullet_type
    rounds_min: int | None = None  # minimum rounds to have on hand for this target

    def to_dict(self) -> dict:
        return {
            "target_type": self.target_type,
            "firearm_id": self.firearm_id,
            "firearm_type": self.firearm_type,
            "caliber": self.caliber,
            "speed_class": self.speed_class,
            "bullet_type": self.bullet_type,
            "rounds_min": self.rounds_min,
        }

    @staticmethod
    def from_dict(data: dict) -> RangeScheduleTarget:
        return RangeScheduleTarget(
            target_type=data["target_type"],
            firearm_id=data.get("firearm_id"),
            firearm_type=data.get("firearm_type"),
            caliber=data.get("caliber"),
            speed_class=data.get("speed_class"),
            bullet_type=data.get("bullet_type"),
            rounds_min=_as_int(data.get("rounds_min")),
        )


@dataclass
class RangeSchedule:
    id: str
    targets: list[RangeScheduleTarget]
    frequency: str  # see RANGE_SCHEDULE_FREQUENCIES
    label: str | None = None
    ammo_alert_enabled: bool = False
    active: bool = True
    last_completed_date: str | None = None
    notes: str | None = None
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "targets": [t.to_dict() for t in self.targets],
            "frequency": self.frequency,
            "label": self.label,
            "ammo_alert_enabled": self.ammo_alert_enabled,
            "active": self.active,
            "last_completed_date": self.last_completed_date,
            "notes": self.notes,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @staticmethod
    def from_dict(data: dict) -> RangeSchedule:
        if "targets" in data:
            targets = [RangeScheduleTarget.from_dict(t) for t in data["targets"]]
        elif data.get("target_type"):
            # Pre-multi-target Store data (single target_type/target_firearm_id/
            # target_firearm_type/target_caliber fields) - synthesize a one-entry
            # list rather than requiring a version-bump migration. Gets rewritten
            # to the new shape the next time this schedule is saved.
            targets = [
                RangeScheduleTarget(
                    target_type=data["target_type"],
                    firearm_id=data.get("target_firearm_id"),
                    firearm_type=data.get("target_firearm_type"),
                    caliber=data.get("target_caliber"),
                )
            ]
        else:
            targets = []
        return RangeSchedule(
            id=data["id"],
            targets=targets,
            frequency=data["frequency"],
            label=data.get("label"),
            ammo_alert_enabled=data.get("ammo_alert_enabled", False),
            active=data.get("active", True),
            last_completed_date=data.get("last_completed_date"),
            notes=data.get("notes"),
            created_at=data.get("created_at", now_iso()),
            updated_at=data.get("updated_at", now_iso()),
        )


# ------------------------------------------------------------- training plan --


@dataclass
class TrainingPlanStep:
    """One step in a TrainingPlan's rotation - reuses RangeScheduleTarget for
    "what to train with" so a step can mix firearms/types/calibers exactly
    like a RangeSchedule can, each target carrying its own optional
    rounds_min for the ammo alert."""

    id: str
    label: str
    targets: list[RangeScheduleTarget] = field(default_factory=list)
    notes: str | None = None
    last_completed_date: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "targets": [t.to_dict() for t in self.targets],
            "notes": self.notes,
            "last_completed_date": self.last_completed_date,
        }

    @staticmethod
    def from_dict(data: dict) -> TrainingPlanStep:
        return TrainingPlanStep(
            id=data["id"],
            label=data.get("label") or "",
            targets=[RangeScheduleTarget.from_dict(t) for t in data.get("targets", [])],
            notes=data.get("notes"),
            last_completed_date=data.get("last_completed_date"),
        )


@dataclass
class TrainingPlan:
    """A multi-step rotating training curriculum - see const.TRAINING_PLAN_MODES
    for the two ways a plan decides which step is currently due.
    `current_step_index` is only meaningful (and only mutated) in
    "sequential" mode; "calendar" mode's current step is always computed
    fresh from start_month/start_year rather than stored (see
    logic.training_plan_current_step_index)."""

    id: str
    label: str
    mode: str  # "calendar" | "sequential"
    steps: list[TrainingPlanStep] = field(default_factory=list)
    start_month: int | None = None  # 1-12, calendar mode only
    start_year: int | None = None  # calendar mode only
    current_step_index: int = 0  # sequential mode only
    active: bool = True
    ammo_alert_enabled: bool = False
    notes: str | None = None
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "label": self.label,
            "mode": self.mode,
            "steps": [s.to_dict() for s in self.steps],
            "start_month": self.start_month,
            "start_year": self.start_year,
            "current_step_index": self.current_step_index,
            "active": self.active,
            "ammo_alert_enabled": self.ammo_alert_enabled,
            "notes": self.notes,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @staticmethod
    def from_dict(data: dict) -> TrainingPlan:
        return TrainingPlan(
            id=data["id"],
            label=data.get("label") or "",
            mode=data.get("mode") or "sequential",
            steps=[TrainingPlanStep.from_dict(s) for s in data.get("steps", [])],
            start_month=_as_int(data.get("start_month")),
            start_year=_as_int(data.get("start_year")),
            current_step_index=_as_int(data.get("current_step_index")) or 0,
            active=data.get("active", True),
            ammo_alert_enabled=data.get("ammo_alert_enabled", False),
            notes=data.get("notes"),
            created_at=data.get("created_at", now_iso()),
            updated_at=data.get("updated_at", now_iso()),
        )


# -------------------------------------------------------------- settings ----


@dataclass
class CacheSettings:
    collection_name: str = "My Collection"
    low_ammo_threshold_default: int = 50
    cleaning_reminder_rounds: int = 300
    cleaning_reminder_days: int = 90
    cleaning_notifications_enabled: bool = True
    low_ammo_notifications_enabled: bool = True
    # Distinguishes "still at hardcoded defaults" from "user genuinely named
    # their collection 'My Collection'" - set True the first time
    # __init__.py applies the config flow wizard's answers, so a later HA
    # restart never overwrites settings the user has since changed.
    setup_completed: bool = False
    # Per diagram_type ("ar_platform", "shotgun", etc.), a stored upload
    # filename (see http.py's CacheUploadDiagramImageView) used as a
    # fallback hero photo for any firearm of that type with no photo of
    # its own in Firearm.photos - a per-type fallback rather than a
    # per-firearm default. See ha-cache-frontend's CLAUDE.md.
    diagram_reference_images: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "collection_name": self.collection_name,
            "low_ammo_threshold_default": self.low_ammo_threshold_default,
            "cleaning_reminder_rounds": self.cleaning_reminder_rounds,
            "cleaning_reminder_days": self.cleaning_reminder_days,
            "cleaning_notifications_enabled": self.cleaning_notifications_enabled,
            "low_ammo_notifications_enabled": self.low_ammo_notifications_enabled,
            "setup_completed": self.setup_completed,
            "diagram_reference_images": self.diagram_reference_images,
        }

    @staticmethod
    def from_dict(data: dict) -> CacheSettings:
        return CacheSettings(
            collection_name=data.get("collection_name", "My Collection"),
            low_ammo_threshold_default=data.get("low_ammo_threshold_default", 50),
            cleaning_reminder_rounds=data.get("cleaning_reminder_rounds", 300),
            cleaning_reminder_days=data.get("cleaning_reminder_days", 90),
            cleaning_notifications_enabled=data.get("cleaning_notifications_enabled", True),
            low_ammo_notifications_enabled=data.get("low_ammo_notifications_enabled", True),
            setup_completed=data.get("setup_completed", False),
            diagram_reference_images=data.get("diagram_reference_images", {}) or {},
        )
