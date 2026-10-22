"""Pure business-logic functions for the Cache integration (no Home Assistant
imports) - kept separate from coordinator.py so they stay unit-testable
without the HA test harness. Ported from the original FastAPI prototype's
serializers.py/notifications.py/stats.py/build_slots.py router logic."""
from __future__ import annotations

import re
from collections import defaultdict
from datetime import date, timedelta

from .const import (
    CATEGORY_FOR_PART,
    FIREARM_DIAGRAM_MAP,
    HANDGUN_TYPES,
    PART_TYPES,
    RANGE_SCHEDULE_FREQUENCY_DAYS,
    RIFLE_TYPES,
    SHOTGUN_TYPES,
    WISHLIST_PRIORITIES,
)
from .models import (
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


def diagram_type_for(firearm_type: str) -> str:
    return FIREARM_DIAGRAM_MAP.get(firearm_type, "ar_platform")


def default_firearm_name(
    manufacturer: str | None, model: str | None, firearm_type: str | None
) -> str:
    """Custom Name is optional on the add-firearm form - when left blank,
    fall back to "<manufacturer> <model>", then just the firearm type, so
    every firearm still has a real display label everywhere it's shown."""
    parts = [p for p in (manufacturer, model) if p]
    if parts:
        return " ".join(parts)
    return firearm_type or "Unnamed Firearm"


def default_item_name(manufacturer: str | None, model: str | None, part_type: str | None) -> str:
    parts = [p for p in (manufacturer, model) if p]
    if parts:
        return " ".join(parts)
    return part_type or "Unnamed Item"


def migrate_inventory_item_taxonomy(data: dict) -> dict:
    """Splits a pre-Category/Part-taxonomy InventoryItem dict's single
    `category` value into `part_type` (the old fine-grained value, kept
    as-is) plus a new, coarser `category` (looked up via CATEGORY_FOR_PART)
    - see storage.py's schema migration (STORAGE_VERSION 1 -> 2). A
    handful of pre-taxonomy category values don't exist at all anymore
    (Sling, Holster, Case, Cleaning Kit, Ammo Can, Range Bag, Safe, Tool,
    Magazine, and the old catch-all "Miscellaneous") - CATEGORY_FOR_PART
    has no entry for any of those, so they fall back to part_type "Other /
    Miscellaneous" under category "Accessory" rather than crashing the
    migration or silently dropping the item. "Magazine" was also a valid
    install slot in the old taxonomy but isn't a slot at all in the new
    universal one, so an item installed under exactly that slot gets
    uninstalled - its physical location is unknown post-migration, so the
    user re-files it rather than the migration guessing one."""
    old_value = data.get("category")
    is_known_part = old_value in CATEGORY_FOR_PART
    data = {
        **data,
        "category": CATEGORY_FOR_PART.get(old_value, "Accessory"),
        "part_type": old_value if is_known_part else "Other / Miscellaneous",
    }
    if data.get("installed_slot_type") == "Magazine":
        data["installed_slot_type"] = None
        data["installed_firearm_id"] = None
        data["installed_at"] = None
    return data


def needs_cleaning(firearm: Firearm, settings: CacheSettings) -> bool:
    rounds_since_cleaning = firearm.lifetime_round_count - (
        firearm.round_count_at_last_cleaning or 0
    )
    reminder_rounds = settings.cleaning_reminder_rounds
    if reminder_rounds and rounds_since_cleaning >= reminder_rounds:
        return True

    if firearm.last_cleaning_date is None:
        return firearm.lifetime_round_count > 0

    if settings.cleaning_reminder_days:
        last_cleaned = date.fromisoformat(firearm.last_cleaning_date)
        days_since = (date.today() - last_cleaned).days
        if days_since >= settings.cleaning_reminder_days:
            return True

    return False


def effective_low_ammo_threshold(
    ammo: Ammunition, settings: CacheSettings, rules: list[AmmoAlertRule]
) -> int | None:
    """Priority order: the entry's own low_inventory_threshold always wins
    (an explicit per-entry override), then the first rule matching this
    entry's caliber/bullet_type/speed_class, then the single global
    low_ammo_threshold_default. None means no threshold applies at all."""
    if ammo.low_inventory_threshold is not None:
        return ammo.low_inventory_threshold
    for rule in rules:
        if rule.match_type == "caliber" and rule.match_value == ammo.caliber:
            return rule.threshold
        if rule.match_type == "bullet_type" and rule.match_value == ammo.bullet_type:
            return rule.threshold
        if rule.match_type == "speed_class" and rule.match_value == speed_class(
            ammo.muzzle_velocity
        ):
            return rule.threshold
    return settings.low_ammo_threshold_default


def is_ammo_low(ammo: Ammunition, settings: CacheSettings, rules: list[AmmoAlertRule]) -> bool:
    threshold = effective_low_ammo_threshold(ammo, settings, rules)
    return threshold is not None and ammo.quantity <= threshold


def compute_cost_per_round(cost_per_box: float | None, rounds_per_box: int | None) -> float | None:
    if cost_per_box is None or not rounds_per_box:
        return None
    return round(cost_per_box / rounds_per_box, 4)


_MUZZLE_VELOCITY_RE = re.compile(r"[\d,]+(?:\.\d+)?")

# The speed of sound at sea level, standard conditions - the conventional
# round-number threshold ammo manufacturers themselves use for "subsonic".
SUBSONIC_THRESHOLD_FPS = 1100


def muzzle_velocity_fps(muzzle_velocity: str | None) -> float | None:
    """Muzzle velocity is free text (e.g. "2100 fps", "1,050") - pulls out
    the first number so speed_class() can compare it, tolerating whatever
    units/formatting the user typed."""
    if not muzzle_velocity:
        return None
    match = _MUZZLE_VELOCITY_RE.search(muzzle_velocity)
    if not match:
        return None
    try:
        return float(match.group().replace(",", ""))
    except ValueError:
        return None


def speed_class(muzzle_velocity: str | None) -> str | None:
    """None means no numeric muzzle velocity could be read - distinct from
    a real Subsonic/Supersonic result, so the frontend can show no badge."""
    fps = muzzle_velocity_fps(muzzle_velocity)
    if fps is None:
        return None
    return "Subsonic" if fps <= SUBSONIC_THRESHOLD_FPS else "Supersonic"


def cleaning_due_firearms(firearms: list[Firearm], settings: CacheSettings) -> list[Firearm]:
    if not settings.cleaning_notifications_enabled:
        return []
    return [f for f in firearms if needs_cleaning(f, settings)]


def low_ammo_entries(
    ammunition: list[Ammunition], settings: CacheSettings, rules: list[AmmoAlertRule]
) -> list[Ammunition]:
    if not settings.low_ammo_notifications_enabled:
        return []
    return [a for a in ammunition if is_ammo_low(a, settings, rules)]


def effective_location_id(item: InventoryItem, firearms_by_id: dict[str, Firearm]) -> str | None:
    """An installed item has no location of its own - it inherits whatever
    storage location its firearm currently sits in."""
    if item.installed_firearm_id:
        firearm = firearms_by_id.get(item.installed_firearm_id)
        return firearm.storage_location_id if firearm else None
    return item.storage_location_id


def validate_install(item: InventoryItem, slot_type: str) -> None:
    """Raises ValueError with a user-facing message if the install is invalid.
    Every firearm has the identical universal set of slots (PART_TYPES) now -
    no more per-firearm-type diagram slot list - so the only rules are
    "is this actually a slot at all" and part_type matching (not category,
    which is too coarse to pick a slot - e.g. two different Optic-category
    Parts, Optic and Optic Mount, are two different slots). No
    physical-compatibility checks beyond that."""
    if slot_type not in PART_TYPES:
        raise ValueError(f"'{slot_type}' is not a valid build slot")
    if item.part_type != slot_type:
        raise ValueError(
            f"'{item.custom_name}' is a {item.part_type}, which does not match the {slot_type} slot"
        )


def validate_range_session_ammo(
    entries: list[RangeSessionFirearmEntry],
    ammo_by_id: dict[str, Ammunition],
    extra_available: dict[str, int] | None = None,
) -> dict[str, int]:
    """Returns {ammunition_id: rounds_needed}, raising ValueError if any
    referenced ammunition doesn't have enough in stock. Sums across multiple
    firearms drawing from the same ammunition entry in a single session.
    `extra_available` lets a caller account for ammo that will be returned
    to stock as part of the same operation (e.g. editing a session reverses
    its old usage before validating the new entries) without actually
    mutating anything yet - so a validation failure leaves state
    untouched instead of catching it partway through a reversal."""
    needed: dict[str, int] = defaultdict(int)
    for entry in entries:
        if entry.ammunition_id and entry.rounds_fired:
            needed[entry.ammunition_id] += entry.rounds_fired

    extra_available = extra_available or {}
    for ammo_id, qty in needed.items():
        ammo = ammo_by_id.get(ammo_id)
        if ammo is None:
            raise ValueError(f"Ammunition {ammo_id} not found")
        available = ammo.quantity + extra_available.get(ammo_id, 0)
        if available < qty:
            raise ValueError(
                f"Not enough {ammo.caliber} ammunition in inventory "
                f"({available} available, {qty} needed)"
            )
    return dict(needed)


def _effective_value(purchase_price: float | None, estimated_value: float | None) -> float | None:
    """An explicit estimate always wins; falls back to what was paid if no
    estimate has been entered. None means neither is known."""
    return estimated_value if estimated_value is not None else purchase_price


def firearm_effective_value(
    firearm: Firearm, inventory_items: list[InventoryItem]
) -> float | None:
    """The firearm's own value plus every OWNED part currently installed on
    it - each side falls back to purchase price if no estimate was
    entered. Wishlist parts are deliberately excluded even when installed:
    My Build lets you install a wishlist part onto any firearm (owned or
    wishlist) purely to preview a wanted build, and that preview shouldn't
    inflate a real firearm's displayed value with money that hasn't
    actually been spent. None only when nothing at all is known (no
    firearm value, no owned parts value) - distinct from a real $0.00,
    same convention as the rest of this module's optional-numeric
    fields."""
    own = _effective_value(firearm.purchase_price, firearm.current_estimated_value)
    parts = sum(
        _effective_value(i.purchase_price, i.estimated_value) or 0
        for i in inventory_items
        if i.installed_firearm_id == firearm.id and not i.is_wishlist
    )
    if own is None and not parts:
        return None
    return round((own or 0) + parts, 2)


# Lower rank sorts first - derived from WISHLIST_PRIORITIES (High, Medium,
# Low) rather than hand-duplicating the order, so the two can't drift.
# A missing priority ranks last, after every real priority.
_WISHLIST_PRIORITY_RANK: dict[str, int] = {p: i for i, p in enumerate(WISHLIST_PRIORITIES)}

# A wishlist firearm without a rank yet (shouldn't normally happen -
# coordinator.async_add_firearm/async_update_firearm auto-assign one the
# moment is_wishlist becomes True - but defends against it anyway) sorts
# after every real rank rather than crashing the comparison or, worse,
# sorting first as if it were rank 0.
_UNRANKED_WISHLIST_SORT_KEY = 10**9


def dashboard_stats(
    firearms: list[Firearm],
    inventory_items: list[InventoryItem],
    ammunition: list[Ammunition],
    settings: CacheSettings,
) -> dict:
    """Every aggregate here (counts, value, by_manufacturer/type/caliber,
    recently_added/fired, etc.) is scoped to what's actually owned -
    is_wishlist=True firearms/items are excluded entirely rather than
    counted alongside real collection stats, matching the same
    "wishlist doesn't count as owned" rule the frontend's filtered lists
    use. Wishlist entries get their own small set of aggregates instead
    (wishlist_firearms/wishlist_items/wishlist_total_value) so there's
    still a way to see "what would my wishlist cost" without it
    contaminating total_collection_value. wishlist_nfa_items mirrors
    nfa_items' own SBR-firearm + Suppressor-item definition, scoped to
    the wishlist instead of owned. top_wishlist_item_name/_priority pick
    the single highest-priority wishlist entry (ties broken by value,
    then by most-recently-added) across both firearms and parts - None
    when the wishlist is empty."""
    owned_firearms = [f for f in firearms if not f.is_wishlist]
    owned_items = [i for i in inventory_items if not i.is_wishlist]
    wishlist_firearms = [f for f in firearms if f.is_wishlist]
    wishlist_items = [i for i in inventory_items if i.is_wishlist]

    by_manufacturer: dict[str, int] = defaultdict(int)
    by_type: dict[str, int] = defaultdict(int)
    by_caliber: dict[str, int] = defaultdict(int)

    handguns = rifles = shotguns = 0
    total_value = 0.0

    for f in owned_firearms:
        if f.manufacturer:
            by_manufacturer[f.manufacturer] += 1
        by_type[f.firearm_type] += 1
        if f.caliber:
            by_caliber[f.caliber] += 1
        if f.firearm_type in HANDGUN_TYPES:
            handguns += 1
        if f.firearm_type in RIFLE_TYPES:
            rifles += 1
        if f.firearm_type in SHOTGUN_TYPES:
            shotguns += 1
        total_value += _effective_value(f.purchase_price, f.current_estimated_value) or 0

    suppressor_count = sum(1 for i in owned_items if i.part_type == "Suppressor")
    nfa_firearms = sum(1 for f in owned_firearms if f.is_nfa)
    nfa_items = nfa_firearms + suppressor_count

    total_value += sum(
        _effective_value(i.purchase_price, i.estimated_value) or 0 for i in owned_items
    )
    total_ammunition = sum(a.quantity for a in ammunition)

    wishlist_total_value = sum(
        _effective_value(f.purchase_price, f.current_estimated_value) or 0
        for f in wishlist_firearms
    ) + sum(_effective_value(i.purchase_price, i.estimated_value) or 0 for i in wishlist_items)

    wishlist_suppressor_count = sum(
        1 for i in wishlist_items if i.part_type == "Suppressor"
    )
    wishlist_nfa_firearms = sum(1 for f in wishlist_firearms if f.is_nfa)
    wishlist_nfa_items = wishlist_nfa_firearms + wishlist_suppressor_count

    # The single wishlist entry (firearm or part) the dashboard highlights
    # as "Top Wishlist Item". Firearms and parts are no longer ranked by
    # the same scheme: firearms replaced the old High/Medium/Low priority
    # tiers with wishlist_rank (a full drag-and-drop order - see
    # coordinator.async_reorder_wishlist_firearms), while parts still use
    # the older 3-tier WISHLIST_PRIORITIES scheme (no drag-and-drop reorder
    # UI for parts yet). Comparing a rank position against a priority tier
    # directly would be apples-to-oranges, so a ranked firearm always wins
    # if any wishlist firearms exist at all - a specific rank is a
    # stronger "what I want next" signal than a coarse tier - falling back
    # to the top-priority PART only when there are no wishlist firearms.
    # top_wishlist_item_priority is therefore None for a firearm-sourced
    # pick (rank, not tier) and only populated for a part-sourced one.
    if wishlist_firearms:
        ranked_firearms = sorted(wishlist_firearms, key=lambda f: f.created_at, reverse=True)
        ranked_firearms.sort(
            key=lambda f: (
                f.wishlist_rank if f.wishlist_rank is not None else _UNRANKED_WISHLIST_SORT_KEY,
                -(_effective_value(f.purchase_price, f.current_estimated_value) or 0),
            )
        )
        top_wishlist_item_name = ranked_firearms[0].custom_name
        top_wishlist_item_priority = None
    elif wishlist_items:
        # Sorting by created_at descending FIRST and relying on Python's
        # stable sort for the priority/value pass avoids needing to negate
        # an ISO date string to get "newest first" within a tie.
        item_entries = [
            (
                i.custom_name,
                i.wishlist_priority,
                _effective_value(i.purchase_price, i.estimated_value) or 0,
                i.created_at,
            )
            for i in wishlist_items
        ]
        item_entries.sort(key=lambda e: e[3], reverse=True)
        item_entries.sort(
            key=lambda e: (_WISHLIST_PRIORITY_RANK.get(e[1], len(WISHLIST_PRIORITIES)), -e[2])
        )
        top_wishlist_item_name = item_entries[0][0]
        top_wishlist_item_priority = item_entries[0][1]
    else:
        top_wishlist_item_name = None
        top_wishlist_item_priority = None

    ammo_by_caliber: dict[str, int] = defaultdict(int)
    for a in ammunition:
        ammo_by_caliber[a.caliber] += a.quantity

    recently_added = sorted(owned_firearms, key=lambda f: f.created_at, reverse=True)[:8]
    recently_fired = sorted(
        [f for f in owned_firearms if f.last_fired_date],
        key=lambda f: f.last_fired_date,
        reverse=True,
    )[:8]
    needing_cleaning = cleaning_due_firearms(owned_firearms, settings)
    most_used = sorted(owned_firearms, key=lambda f: f.lifetime_round_count, reverse=True)[:8]

    average_round_count = (
        round(sum(f.lifetime_round_count for f in owned_firearms) / len(owned_firearms), 1)
        if owned_firearms
        else 0
    )

    return {
        "total_firearms": len(owned_firearms),
        "handguns": handguns,
        "rifles": rifles,
        "shotguns": shotguns,
        "nfa_items": nfa_items,
        "total_collection_value": round(total_value, 2),
        "total_ammunition": total_ammunition,
        "average_round_count": average_round_count,
        "by_manufacturer": dict(sorted(by_manufacturer.items(), key=lambda kv: -kv[1])),
        "by_type": dict(sorted(by_type.items(), key=lambda kv: -kv[1])),
        "by_caliber": dict(sorted(by_caliber.items(), key=lambda kv: -kv[1])),
        "ammunition_by_caliber": dict(sorted(ammo_by_caliber.items(), key=lambda kv: -kv[1])),
        "recently_added_ids": [f.id for f in recently_added],
        "recently_fired_ids": [f.id for f in recently_fired],
        "needing_cleaning_ids": [f.id for f in needing_cleaning],
        "most_used_ids": [f.id for f in most_used],
        "wishlist_firearms_count": len(wishlist_firearms),
        "wishlist_items_count": len(wishlist_items),
        "wishlist_nfa_items": wishlist_nfa_items,
        "wishlist_total_value": round(wishlist_total_value, 2),
        "top_wishlist_item_name": top_wishlist_item_name,
        "top_wishlist_item_priority": top_wishlist_item_priority,
    }


# ----------------------------------------------------------- range schedule --


def _target_matches_firearm(target: RangeScheduleTarget, firearm: Firearm) -> bool:
    if target.target_type == "firearm":
        return firearm.id == target.firearm_id
    if target.target_type == "firearm_type":
        return firearm.firearm_type == target.firearm_type
    if target.target_type == "caliber":
        return firearm.caliber == target.caliber
    return False


def _target_calibers(target: RangeScheduleTarget, firearms: list[Firearm]) -> set[str]:
    """A caliber target's own value counts directly, even if no firearm in
    the collection currently has that exact caliber recorded - otherwise
    every firearm/firearm_type target derives its calibers from whichever
    firearms currently match it."""
    if target.target_type == "caliber":
        return {target.caliber} if target.caliber else set()
    return {f.caliber for f in firearms if _target_matches_firearm(target, f) and f.caliber}


def range_schedule_matching_firearms(
    schedule: RangeSchedule, firearms: list[Firearm]
) -> list[Firearm]:
    """A schedule's targets list can mix one specific firearm, every firearm
    of a given type, and/or every firearm chambered in a given caliber - a
    firearm counts if it satisfies ANY target, resolved dynamically each
    time, so adding a new Home Defense shotgun later automatically counts
    toward an existing "all shotguns" schedule, and a new 9mm pistol counts
    toward an existing "all 9mm" schedule. One schedule can list both a
    300 BLK and a 5.56 caliber target for a multi-caliber AR upper."""
    return [
        f for f in firearms if any(_target_matches_firearm(t, f) for t in schedule.targets)
    ]


def range_schedule_matches_firearm(schedule: RangeSchedule, firearm: Firearm) -> bool:
    return any(_target_matches_firearm(t, firearm) for t in schedule.targets)


def range_schedule_next_due_date(schedule: RangeSchedule) -> str | None:
    """None means "never trained - due now", matching how needs_cleaning
    treats a never-cleaned firearm with rounds fired as immediately due."""
    if not schedule.last_completed_date:
        return None
    interval_days = RANGE_SCHEDULE_FREQUENCY_DAYS.get(schedule.frequency, 91)
    last = date.fromisoformat(schedule.last_completed_date)
    return (last + timedelta(days=interval_days)).isoformat()


def range_schedule_is_due(schedule: RangeSchedule) -> bool:
    if not schedule.active:
        return False
    next_due = range_schedule_next_due_date(schedule)
    if next_due is None:
        return True
    return date.today() >= date.fromisoformat(next_due)


def range_schedule_calibers(schedule: RangeSchedule, firearms: list[Firearm]) -> set[str]:
    """Every caliber the ammo alert should check, across all targets - for
    display (see range_schedule_ammo_ok for the actual per-target,
    speed-class-aware on-hand computation)."""
    calibers: set[str] = set()
    for t in schedule.targets:
        calibers |= _target_calibers(t, firearms)
    return calibers


def range_schedule_target_label(
    target: RangeScheduleTarget, firearms_by_id: dict[str, Firearm]
) -> str:
    if target.target_type == "firearm":
        firearm = firearms_by_id.get(target.firearm_id or "")
        label = firearm.custom_name if firearm else "Firearm (deleted)"
    elif target.target_type == "firearm_type":
        label = f"All {target.firearm_type}s"
    elif target.target_type == "caliber":
        label = f"{target.caliber} ammo"
    else:
        label = "Unknown target"
    if target.speed_class:
        label = f"{label} ({target.speed_class.lower()} only)"
    return label


def range_schedule_default_label(
    targets: list[RangeScheduleTarget], firearms_by_id: dict[str, Firearm]
) -> str:
    labels = [range_schedule_target_label(t, firearms_by_id) for t in targets]
    return " + ".join(labels) if labels else "Training Schedule"


def _ammo_matches_target(
    ammo: Ammunition,
    calibers: set[str],
    speed_class_filter: str | None,
    bullet_type_filter: str | None,
) -> bool:
    if ammo.caliber not in calibers:
        return False
    if speed_class_filter is not None and speed_class(ammo.muzzle_velocity) != speed_class_filter:
        return False
    return bullet_type_filter is None or ammo.bullet_type == bullet_type_filter


def _ammo_ok_for_targets(
    targets: list[RangeScheduleTarget],
    firearms: list[Firearm],
    ammunition: list[Ammunition],
) -> bool | None:
    """Shared by range_schedule_ammo_ok and training_plan_step_ammo_ok. Each
    target's rounds_min is checked independently against on-hand ammo
    matching that target's own caliber set AND (if set) its speed_class/
    bullet_type filters (e.g. "my suppressed pistol, but only subsonic JHP")
    - not a combined total across targets. None means the alert isn't
    applicable (no target has a rounds_min set) - distinct from a real
    True/False sufficiency result. False if ANY target with a rounds_min
    set is short."""
    checks: list[bool] = []
    for t in targets:
        if not t.rounds_min:
            continue
        calibers = _target_calibers(t, firearms)
        if not calibers:
            continue
        on_hand = sum(
            a.quantity
            for a in ammunition
            if _ammo_matches_target(a, calibers, t.speed_class, t.bullet_type)
        )
        checks.append(on_hand >= t.rounds_min)
    if not checks:
        return None
    return all(checks)


def range_schedule_ammo_ok(
    schedule: RangeSchedule, firearms: list[Firearm], ammunition: list[Ammunition]
) -> bool | None:
    if not schedule.ammo_alert_enabled:
        return None
    return _ammo_ok_for_targets(schedule.targets, firearms, ammunition)


def range_schedules_due(schedules: list[RangeSchedule]) -> list[RangeSchedule]:
    return [s for s in schedules if range_schedule_is_due(s)]


def range_schedules_with_ammo_alert(
    schedules: list[RangeSchedule], firearms: list[Firearm], ammunition: list[Ammunition]
) -> list[RangeSchedule]:
    return [
        s
        for s in schedules
        if s.active and range_schedule_ammo_ok(s, firearms, ammunition) is False
    ]


# ------------------------------------------------------------- training plan --


def training_plan_current_step_index(plan: TrainingPlan) -> int | None:
    """None means there's no valid current step (no steps, or calendar mode
    with no start date set yet)."""
    if not plan.steps:
        return None
    if plan.mode == "calendar":
        if not plan.start_month or not plan.start_year:
            return None
        today = date.today()
        months_elapsed = (today.year * 12 + today.month) - (
            plan.start_year * 12 + plan.start_month
        )
        return months_elapsed % len(plan.steps)
    return plan.current_step_index % len(plan.steps)


def training_plan_current_step(plan: TrainingPlan) -> TrainingPlanStep | None:
    index = training_plan_current_step_index(plan)
    return plan.steps[index] if index is not None else None


def training_plan_step_is_due(plan: TrainingPlan) -> bool:
    """Sequential mode: the current step is always due until it's logged/
    advanced away from - self-paced, not time-gated. Calendar mode: due
    unless already completed during this specific occurrence of its
    assigned month (comparing year+month, not just "recently enough")."""
    if not plan.active:
        return False
    step = training_plan_current_step(plan)
    if step is None:
        return False
    if plan.mode == "sequential":
        return True
    if not step.last_completed_date:
        return True
    today = date.today()
    last = date.fromisoformat(step.last_completed_date)
    return not (last.year == today.year and last.month == today.month)


def _step_matches_firearm(step: TrainingPlanStep, firearm: Firearm) -> bool:
    return any(_target_matches_firearm(t, firearm) for t in step.targets)


def training_plan_matches_firearm(plan: TrainingPlan, firearm: Firearm) -> bool:
    """Whether a firearm satisfies the plan's CURRENT step - used to
    auto-advance the plan when a matching range session is logged (see
    coordinator.async_log_range_session)."""
    step = training_plan_current_step(plan)
    return step is not None and _step_matches_firearm(step, firearm)


def training_plan_step_matching_firearms(
    step: TrainingPlanStep, firearms: list[Firearm]
) -> list[Firearm]:
    return [f for f in firearms if _step_matches_firearm(step, f)]


def training_plan_step_calibers(step: TrainingPlanStep, firearms: list[Firearm]) -> set[str]:
    calibers: set[str] = set()
    for t in step.targets:
        calibers |= _target_calibers(t, firearms)
    return calibers


def training_plan_step_ammo_ok(
    plan: TrainingPlan,
    step: TrainingPlanStep,
    firearms: list[Firearm],
    ammunition: list[Ammunition],
) -> bool | None:
    if not plan.ammo_alert_enabled:
        return None
    return _ammo_ok_for_targets(step.targets, firearms, ammunition)


def training_plans_due(plans: list[TrainingPlan]) -> list[TrainingPlan]:
    return [p for p in plans if training_plan_step_is_due(p)]


def training_plans_with_ammo_alert(
    plans: list[TrainingPlan], firearms: list[Firearm], ammunition: list[Ammunition]
) -> list[TrainingPlan]:
    result = []
    for p in plans:
        if not p.active:
            continue
        step = training_plan_current_step(p)
        if step is None:
            continue
        if training_plan_step_ammo_ok(p, step, firearms, ammunition) is False:
            result.append(p)
    return result


def training_plan_advance(plan: TrainingPlan, completed_date: str) -> None:
    """Mutates the plan's current step's last_completed_date, and - in
    sequential mode - advances current_step_index to the next step (wrapping
    back to 0 after the last one). Called both by an explicit "mark done"
    service call and automatically when a matching range session is logged
    (see coordinator.async_log_range_session). No-ops if the step was
    already completed on or after completed_date, matching
    RangeSchedule's "bumps forward if the session date is newer" behavior."""
    step = training_plan_current_step(plan)
    if step is None:
        return
    if step.last_completed_date and step.last_completed_date >= completed_date:
        return
    step.last_completed_date = completed_date
    if plan.mode == "sequential" and plan.steps:
        current_index = training_plan_current_step_index(plan) or 0
        plan.current_step_index = (current_index + 1) % len(plan.steps)
