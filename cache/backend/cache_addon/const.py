from __future__ import annotations

DOMAIN = "cache"
STORAGE_VERSION = 2
STORAGE_KEY = f"{DOMAIN}_data"

# Ring-buffer caps for bounded history lists (mirrors Hustle's
# RECENT_ACTIVITY_LIMIT convention) - keeps the storage document and each
# entity's attribute payload bounded regardless of collection age.
RANGE_SESSION_HISTORY_LIMIT = 500
CLEANING_HISTORY_LIMIT = 100
AMMO_TRANSACTION_HISTORY_LIMIT = 200

DEFAULT_LOW_AMMO_THRESHOLD = 50
DEFAULT_CLEANING_REMINDER_ROUNDS = 300
DEFAULT_CLEANING_REMINDER_DAYS = 90

# ------------------------------------------------------------- range schedule
# A schedule targets one specific firearm, every firearm of a given type, or
# every firearm chambered in a given caliber, on a recurring training
# cadence. Logging a matching range session automatically marks it trained
# (see coordinator.async_log_range_session).
RANGE_SCHEDULE_TARGET_TYPES: list[str] = ["firearm", "firearm_type", "caliber"]

# Optional per-target ammo filter (see logic.speed_class) - e.g. "train with
# my suppressed pistol, but only using subsonic ammo" only counts subsonic
# ammo toward that target's ammo-on-hand alert, not the pistol's full
# caliber stock. None means no filter (any speed class counts).
AMMO_SPEED_CLASSES: list[str] = ["Subsonic", "Supersonic"]

RANGE_SCHEDULE_FREQUENCIES: list[str] = [
    "weekly",
    "biweekly",
    "monthly",
    "quarterly",
    "semi_annually",
    "annually",
]

RANGE_SCHEDULE_FREQUENCY_DAYS: dict[str, int] = {
    "weekly": 7,
    "biweekly": 14,
    "monthly": 30,
    "quarterly": 91,
    "semi_annually": 182,
    "annually": 365,
}

# ---------------------------------------------------------------- ammo alerts
# A low-inventory alert rule matches ammunition by caliber, bullet_type, or
# speed_class (see logic.speed_class) and sets a threshold for that whole
# group, rather than the single global low_ammo_threshold_default applying
# to everything - e.g. "alert me under 200 rounds of 9mm" or "alert me under
# 20 rounds of anything subsonic." An entry's own low_inventory_threshold
# (set directly on the Ammunition record) always takes priority over any
# rule; rules only fill the gap for entries with no threshold of their own.
AMMO_ALERT_RULE_MATCH_TYPES: list[str] = ["caliber", "bullet_type", "speed_class"]

# ---------------------------------------------------------------- training plan
# A multi-step rotating curriculum, distinct from a single RangeSchedule - one
# step is "due" at a time, out of an ordered list, cycling back to the start
# after the last step (e.g. a 6-month rifle/shotgun rotation: 300 BLK one
# month, 5.56 the next, etc.). Two ways a plan decides which step is "due":
# - "calendar": locked to specific real-world months, computed from
#   start_month/start_year - always automatic, but doesn't wait for you if
#   you miss a month.
# - "sequential": self-paced - tracks current_step_index directly, only
#   advancing to the next step once the current one is logged/marked done,
#   not tied to any specific calendar month.
TRAINING_PLAN_MODES: list[str] = ["calendar", "sequential"]

# Where the old integration kept uploaded photos/documents, relative to the
# Home Assistant config dir - only read by migrate.py's one-time import. The
# add-on's own copies live under /data/uploads/ (AddonConfig.uploads_dir)
# and are served by web.py at `uploads/<filename>`.
LEGACY_UPLOADS_SUBPATH: tuple[str, str] = ("www", "cache_uploads")
MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB per file

ALLOWED_PHOTO_CONTENT_TYPES: set[str] = {"image/jpeg", "image/png", "image/webp", "image/gif"}

# Ammo box photo scanning (see openai_client.py) - vision-capable, cheap
# enough for an occasional single-image extraction call. The API key is the
# add-on's openai_api_key option (see openai_client.get_openai_api_key for
# the fallbacks), never sent to or readable by the frontend.
OPENAI_VISION_MODEL = "gpt-4o-mini"
OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions"

# My Build hero image background removal (see openai_client.py's
# remove_background) - same API key as above, a separate model/endpoint
# since this is image editing, not chat/vision.
OPENAI_IMAGE_MODEL = "gpt-image-1"
OPENAI_IMAGES_EDIT_URL = "https://api.openai.com/v1/images/edits"

# Ammo box barcode scanning (see barcode_client.py) - UPCitemdb's free
# trial lookup endpoint, no API key required. Rate-limited by UPCitemdb
# (100 lookups/day, 1 per 5s, per IP) - fine for occasional single-item
# lookups, not for bulk import.
UPCITEMDB_TRIAL_URL = "https://api.upcitemdb.com/prod/trial/lookup"
ALLOWED_DOCUMENT_CONTENT_TYPES: set[str] = {
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
}

WISHLIST_PRIORITIES: list[str] = ["High", "Medium", "Low"]

FIREARM_TYPES: list[str] = [
    "Handgun",
    "Revolver",
    "Rifle",
    "Shotgun",
    "PCC",
    "AR Pistol",
    "SBR",
    "Bolt Action",
    "Lever Action",
    "Other",
]

# Maps a firearm type to which original SVG wireframe silhouette the panel
# renders in the My Build interface. Multiple types may share a diagram.
FIREARM_DIAGRAM_MAP: dict[str, str] = {
    "Handgun": "handgun",
    "AR Pistol": "ar_pistol",
    "Revolver": "revolver",
    "Rifle": "ar_platform",
    "Shotgun": "shotgun",
    "PCC": "ar_platform",
    "SBR": "ar_platform",
    "Bolt Action": "bolt_action",
    "Lever Action": "bolt_action",
    "Other": "ar_platform",
}

FIREARM_USES: list[str] = ["Training", "Home Defense", "Hunting", "Collectible"]

# Every firearm's My Build screen shows the identical set of installable
# slots now - no more per-diagram-type slot lists like the original SVG
# wireframe system had. Each Part (the specific, installable thing - what
# used to be the entirety of InventoryItem.category before this taxonomy)
# belongs to exactly one Category (a coarser grouping, used to narrow the
# frontend's Part dropdown once a Category is picked, and to group Parts in
# lists). Both are real stored fields on InventoryItem - see
# `InventoryItem.category`/`part_type` in models.py.
PART_TAXONOMY: dict[str, list[str]] = {
    "Optic": ["Optic", "Optic Mount"],
    "Muzzle": ["Muzzle Device", "Suppressor"],
    "Barrel": ["Barrel"],
    "Underbarrel": ["Foregrip", "Bipod"],
    "Light & Laser": ["Light", "Laser"],
    "Stock": ["Stock", "Brace"],
    "Rear Grip": ["Grip"],
    "Fire Control": ["Trigger", "Safety"],
    "Action": ["Bolt", "Charging Handle"],
    "Accessory": ["Handguard", "Other / Miscellaneous"],
}

# The 10 Categories - InventoryItem.category's allowed values.
INVENTORY_CATEGORIES: list[str] = list(PART_TAXONOMY.keys())

# The 18 Parts, flattened - InventoryItem.part_type's allowed values, and
# also literally the universal list of My Build slots (every entry here is
# installable, unlike the old system's BUILD_SLOT_CATEGORIES subset).
PART_TYPES: list[str] = [part for parts in PART_TAXONOMY.values() for part in parts]

# Reverse lookup (Part -> its Category) - used by storage.py's schema
# migration to split a pre-taxonomy item's single category value into
# part_type (the old value, kept as-is) + category (looked up here).
CATEGORY_FOR_PART: dict[str, str] = {
    part: category for category, parts in PART_TAXONOMY.items() for part in parts
}

# Every diagram_type value FIREARM_DIAGRAM_MAP can produce - used only to
# validate the per-diagram-type hero/reference image upload
# (CacheUploadDiagramImageView), now that DIAGRAM_SLOTS (which used to
# double as the set of valid diagram_type keys) is gone.
DIAGRAM_TYPES: list[str] = sorted(set(FIREARM_DIAGRAM_MAP.values()))

CONDITIONS: list[str] = ["New", "Excellent", "Good", "Fair", "Poor", "Parts/Non-Functional"]

DOCUMENT_TYPES: list[str] = ["Manual", "Receipt", "Warranty Information", "Tax Stamp", "Other"]

AMMO_TRANSACTION_TYPES: list[str] = ["add", "remove", "adjust", "range_session"]

# Legal/regulatory categories rolled into the dashboard's "NFA Items" count:
# SBR firearms plus any Suppressor inventory item.
NFA_FIREARM_TYPES: set[str] = {"SBR"}
HANDGUN_TYPES: set[str] = {"Handgun", "Revolver"}
RIFLE_TYPES: set[str] = {"Rifle", "PCC", "Bolt Action", "Lever Action"}
SHOTGUN_TYPES: set[str] = {"Shotgun"}
