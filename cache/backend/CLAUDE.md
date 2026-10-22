# Cache - backend

The Python service inside the Cache add-on (`cache_addon/`, run as
`python3 -m cache_addon`). See the repo's top-level CLAUDE.md for how the
add-on fits together (ingress, the panel's `hass` stand-in, MQTT, the
one-time import from the old integration).

Most of this file - the coordinator/logic/models notes - carried over
unchanged from `ha-cache-integration`, which this replaced: `models.py`,
`logic.py`, `coordinator.py`'s mutation methods and `services.py`'s
`SCHEMAS` were ported as-is, so everything below about their behavior still
applies. Where a note mentions Home Assistant's `Store`, sensors or service
registration, read it as the add-on equivalent: `storage.py`'s
`CacheStore` (same file envelope), `states.py`, and `web.py`'s
`api/services/<name>`.

## Architecture

- `models.py` - dataclasses (Firearm, InventoryItem, Ammunition,
  StorageLocation, RangeSession, RangeSchedule, CacheSettings) with
  `to_dict`/`from_dict` for storage serialization. `Firearm.photos`/
  `documents`/`cleaning_history` and `InventoryItem.photos` nest inside their
  parent rather than living in separate top-level lists (matches Hustle's
  `Bounty.acceptances` pattern). `Ammunition.transactions` nests too,
  ring-buffered at `AMMO_TRANSACTION_HISTORY_LIMIT`. `Firearm.custom_name` /
  `InventoryItem.custom_name` are never blank in storage even though the
  add forms make them optional - `coordinator.async_add_firearm`/
  `async_add_inventory_item` fill in `logic.default_firearm_name`/
  `default_item_name` (manufacturer + model, else firearm_type/part_type)
  before constructing the dataclass, and the update methods do the same if
  the field is explicitly cleared. Optional numeric fields (`purchase_price`,
  `cost_per_round`, `RangeScheduleTarget.rounds_min`, etc.) go through `from_dict`'s
  `_as_int`/`_as_float` coercion helpers rather than a bare `data.get(...)`,
  so a stray non-numeric value already sitting in an existing Store (e.g.
  from before `coordinator._normalize_fields` existed) can't crash the
  whole integration on load - it just becomes `None` instead.
- `coordinator.py`'s `async_add_*` methods all call `_normalize_fields()` on
  incoming fields before constructing the dataclass, same as `async_update_*`
  already does per-field via `_normalize()` - a blank optional field arrives
  as the frontend's `""` sentinel (see `ha-cache-frontend`'s
  `callCacheService`), and both add and update need to turn that into `None`
  rather than storing the literal string.
- `storage.py` - wraps HA's `Store` helper. One versioned JSON document. Add
  new top-level keys for future modules rather than changing existing key
  shapes - bump `STORAGE_VERSION` and add a migration in
  `CacheStore._async_migrate_func` if a shape must change. The one
  migration so far (version 1 -> 2, the Category/Part taxonomy split
  below) delegates its actual per-item transform to
  `logic.migrate_inventory_item_taxonomy` (a plain `dict -> dict`
  function) rather than inlining it, so it's unit-testable without the HA
  `Store`/`hass` machinery - `test_storage.py` covers the `Store`-level
  hook (applies to every item, leaves other top-level keys alone),
  `test_logic.py` covers the transform itself (retained values split
  correctly, dropped values fall back sanely, a dropped install slot gets
  uninstalled).
- `logic.py` - pure functions (no Home Assistant imports): cleaning-due
  detection, dashboard stat aggregation, effective-location resolution,
  install/remove slot validation, range-session ammo math. Keep new business
  logic here, not in `coordinator.py`, so it stays unit-testable without the
  HA test harness.
- `coordinator.py` - the only place that touches both storage and `logic.py`.
  Push-based, not polling - every mutation method persists then calls
  `_async_save`, which notifies listeners (`web.py`'s websocket push and
  `mqtt.py`'s publisher) through the small `async_add_listener`/
  `async_set_updated_data` pair that stands in for HA's
  DataUpdateCoordinator.
- `services.py` - the only way to mutate state. `SCHEMAS` (one
  `vol.Schema` per service, mostly built from the shared `FIREARM_FIELDS`/
  `INVENTORY_ITEM_FIELDS`/`AMMUNITION_FIELDS` dicts) validates every call
  before its handler runs - `async_call_service` is the single entry point
  `web.py` uses for `POST api/services/<name>`. `validation.py`
  reimplements the three `homeassistant.helpers.config_validation`
  helpers the schemas use (`string`/`boolean`/`ensure_list`), imported as
  `cv` so the schemas stayed byte-for-byte the same as the integration's.
  **Any new/changed service field needs updating in `SCHEMAS` (or one of
  the shared FIELDS dicts) AND `coordinator.py`'s handling** - a field the
  panel sends that `SCHEMAS` doesn't list fails with voluptuous's "extra
  keys not allowed". (The integration also had a `services.yaml` for
  Developer Tools plus a test cross-checking it against `SCHEMAS`; both
  are gone since there are no HA services any more.) `add_firearm`/
  `add_inventory_item` (`RESPONSE_SERVICES`) return
  `{"firearm_id": ...}`/`{"item_id": ...}` so the frontend can upload
  photos for a firearm/part immediately after creating it, in the same Add
  form submission. Every other service returns `None`. The acting user's
  display name (`created_by` attribution) comes from ingress's
  `X-Remote-User-Display-Name` header.
- `states.py` - the panel's read model: builds the exact entity
  payloads the integration's `sensor.py` used to expose (same entity ids,
  same `cache_key`/`firearm_id`/`inventory_item_id`/`ammunition_id` marker
  attributes, state stringified like HA), keyed like `hass.states`. The
  frontend's `parseCacheState()` reads it unchanged. Keep each function's
  attribute shape in sync with what `ha-api.ts` parses.
- `mqtt.py` - publishes only the automation-facing entities
  (`binary_sensor.cache_*` cleaning-due/low-ammo/training-due/
  training-ammo-alert flags, their count sensors, dashboard stats, range
  session count) via MQTT discovery, keeping the integration's entity ids.
  The broker comes from Supervisor's `services/mqtt` endpoint.
- Range session (`RangeSession` model) logging has side effects beyond the
  session record itself: `coordinator.async_log_range_session` bumps each
  entry's firearm `lifetime_round_count`/`last_fired_date`, deducts ammo
  (`logic.validate_range_session_ammo` + `_apply_ammo_delta`, tagging the
  resulting `AmmoTransaction.range_session_id` so it can be traced back),
  and bumps matching `RangeSchedule`/`TrainingPlan` "last completed"
  forward if this session is newer. Both `async_update_range_session` and
  `async_delete_range_session` reverse those first two side effects -
  editing re-derives round counts/ammo from a diff against the session's
  old entries (old entries' rounds are subtracted back off each firearm; a
  firearm no longer in the edited session gets its rounds fully reversed),
  deleting just reverses everything unconditionally. Both use
  `_find_firearm` not `_get_firearm` for that reversal, since the firearm
  may have been deleted since the session was logged - nothing to reverse
  against in that case, not an error. Ammo reversal for both scans
  `AmmoTransaction.range_session_id` (bounded by
  `AMMO_TRANSACTION_HISTORY_LIMIT` same as everything else in that ring
  buffer) for transactions tagged with this session, reverses each one via
  `_apply_ammo_delta`, and then **clears that transaction's
  `range_session_id`** - without that clear, editing the same session a
  second time would find the already-reversed transaction still tagged
  alongside the newer one and return the same ammo twice (a real bug this
  session hit and fixed; the offsetting "adjust" reversal transaction
  itself is deliberately left untagged, or a later delete would try to
  reverse the reversal). For edit specifically, old ammo usage is tallied
  as returned-to-stock *before* validating the new entries via
  `validate_range_session_ammo`'s `extra_available` param - nothing is
  actually mutated until that validation passes, so a rejected edit (not
  enough stock even after the return) leaves state exactly as it was
  rather than getting caught mid-reversal. Schedule/training-plan bumps
  are never un-bumped by either edit or delete - only ever bumped forward,
  so an edit/delete can still (re)trigger completion later but can't
  un-complete something a later session already satisfied (no safe way to
  tell whether that later session would have satisfied it on its own).
- Range schedule (`RangeSchedule` model, `logic.range_schedule_*` functions)
  - a recurring training goal with a `targets: list[RangeScheduleTarget]`
  list. Each target entry is
  independently one specific firearm (`target_type=
  "firearm"`), every firearm of a type (`"firearm_type"`), or every firearm
  chambered in a given caliber (`"caliber"`, matches `Firearm.caliber`
  exactly). A firearm counts toward the schedule if it satisfies ANY target
  (`logic._target_matches_firearm`/`range_schedule_matching_firearms`) -
  this is what lets one schedule cover a multi-caliber AR upper (a 300 BLK
  target + a 5.56 target) or "train with either my AR or my shotgun" in a
  single schedule, resolved dynamically against the current collection each
  time, not snapshotted. `range_schedule_calibers` includes both the
  calibers of matching firearms AND any explicit caliber target's own
  value directly, even if no firearm in the collection currently has that
  exact caliber recorded - an ammo-type target tracks that caliber on its
  own, not just derived from a firearm. `coordinator.async_log_range_session`
  is the only place `last_completed_date` changes - it checks every active
  schedule against the firearms in the session being logged
  (`logic.range_schedule_matches_firearm`) and bumps it forward if the
  session date is newer. "Due" (`logic.range_schedule_is_due`) means either
  never trained, or `last_completed_date + RANGE_SCHEDULE_FREQUENCY_DAYS[frequency]`
  has passed. Each target also has an optional `speed_class` filter
  (`AMMO_SPEED_CLASSES`: "Subsonic" | "Supersonic") and an optional
  `bullet_type` filter (free text, e.g. "JHP"/"Buckshot" - matches
  `Ammunition.bullet_type` exactly) - e.g. "train with my suppressed
  pistol, but only subsonic JHP" only counts ammo matching both filters
  (per `logic.speed_class` and a direct string comparison) toward that
  target's ammo-on-hand check, not the pistol's full caliber stock. Each
  target also has its own optional `rounds_min` - the ammo alert
  (`schedule.ammo_alert_enabled`, computed in `range_schedule_ammo_ok` via
  the shared `logic._ammo_ok_for_targets` helper) checks EACH target with a
  `rounds_min` set independently against on-hand ammo matching that
  target's own caliber set (filtered by its `speed_class`/`bullet_type` if
  set) - not a combined total across targets, so a multi-target schedule
  can require e.g. "50+ rounds of 300 BLK AND 100+ rounds of 5.56" rather
  than either one covering the other. `None` means "not applicable"
  (disabled, or no target has a `rounds_min` set), distinct from a real
  True/False sufficiency result (`False` if ANY target with a `rounds_min`
  is short); the frontend treats `None` as "no
  alert".
  `RangeSchedule.from_dict` tolerates pre-redesign Store data (the old
  singular `target_type`/`target_firearm_id`/`target_firearm_type`/
  `target_caliber` fields, no `targets` key) by synthesizing a one-entry
  targets list - no version-bump migration needed, and it's rewritten to
  the new shape the next time that schedule is saved.
- Training plan (`TrainingPlan`/`TrainingPlanStep` models, `logic.
  training_plan_*` functions) - a distinct entity from `RangeSchedule`: an
  ORDERED, ROTATING list of steps where only one is "current" at a time
  (e.g. a 6-month rifle/shotgun rotation - 300 BLK one month, 5.56 the
  next, etc.), rather than one standalone recurring goal. Each step reuses
  `RangeScheduleTarget` for "what to train with" (each target carrying its
  own optional `rounds_min`) plus its own `notes`, same shape as a
  `RangeSchedule`. A plan
  picks its current step one of two ways, chosen per-plan at creation via
  `mode` (`const.TRAINING_PLAN_MODES`): `"calendar"` computes the index
  fresh every time from `start_month`/`start_year`
  (`logic.training_plan_current_step_index` -
  `((today.year*12+today.month) - (start_year*12+start_month)) %
  len(steps)`) - fully automatic, but doesn't wait for you if you miss a
  month; `"sequential"` tracks `current_step_index` directly on the plan,
  only advancing (mod `len(steps)`) once the current step is completed -
  self-paced, no calendar coupling. `logic.training_plan_step_is_due`
  reflects this split: sequential mode is always due until advanced away
  from, calendar mode is due unless already completed during this specific
  occurrence of its assigned month (comparing year+month, not just
  "recently enough"). `coordinator.async_log_range_session` auto-advances a
  plan the same way it completes a `RangeSchedule`, but only checks the
  plan's CURRENT step (`logic.training_plan_matches_firearm`) - logging a
  session doesn't complete a step that isn't up next. `logic.
  training_plan_advance` (used by both that auto-advance and the explicit
  `advance_training_plan` service, for self-paced plans you just want to
  check off without a full Log Range Session) sets the current step's
  `last_completed_date` and, in sequential mode only, bumps
  `current_step_index` - a no-op if the step was already completed on or
  after the given date, matching `RangeSchedule`'s "bumps forward if the
  session date is newer" behavior. The optional per-plan ammo alert
  (`ammo_alert_enabled`) reuses the exact same `logic._ammo_ok_for_targets`
  helper as `RangeSchedule`'s, checking each of the current step's targets'
  `rounds_min` independently - `training_plan_step_ammo_ok`.
  `TrainingDueCountSensor`/
  `TrainingAmmoAlertCountSensor` fold both `RangeSchedule` and
  `TrainingPlan` results into the same aggregate counts, so an automation
  watching "any training due" catches plan steps too, not just standalone
  schedules.
- Ammunition's `cost_per_round` is computed, not settable directly - the
  add/update services take `cost_per_box`/`rounds_per_box` instead, and
  `coordinator.async_add_ammunition`/`async_update_ammunition` recompute
  `cost_per_round` via `logic.compute_cost_per_round` whenever either
  changes (falling back to the ammo's existing value for whichever one
  wasn't touched on update). `logic.speed_class` similarly derives a
  Subsonic/Supersonic label by parsing the leading number out of the
  free-text `muzzle_velocity` field (`<=1100 fps` is subsonic) - exposed as
  the `speed_class` sensor attribute rather than stored, since it's fully
  derived from `muzzle_velocity`.
- Low-ammo alerting (`AmmoAlertRule` model, `logic.effective_low_ammo_threshold`/
  `is_ammo_low`) has three tiers, checked in priority order:
  1. An `Ammunition` entry's own `low_inventory_threshold` (set directly on
     that entry) always wins if present.
  2. Otherwise, the first `AmmoAlertRule` (in list order) whose
     `match_type`/`match_value` matches that entry - `"caliber"` matches
     `Ammunition.caliber` exactly, `"bullet_type"` matches
     `Ammunition.bullet_type` exactly, `"speed_class"` matches
     `logic.speed_class(ammo.muzzle_velocity)` (so a "Subsonic" rule
     applies to every subsonic entry regardless of caliber).
  3. Otherwise, the single global `CacheSettings.low_ammo_threshold_default`.
  Rules are a standalone top-level entity (own storage key, own CRUD
  services `add`/`update`/`delete_ammo_alert_rule`, own
  `AmmoAlertRulesSensor`) rather than fields on `CacheSettings`, matching
  the same "self-contained list entity" convention as `RangeSchedule`/
  `TrainingPlan` - a flat settings dataclass with a single "replace all
  rules" service call would've been much clumsier for reordering/deleting
  individual rules than a proper CRUD list.
- `CacheSettings.diagram_reference_images` (`dict[diagram_type, filename]`,
  `async_set_diagram_reference_image`/`async_clear_diagram_reference_image`,
  `http.py`'s `CacheUploadDiagramImageView` at
  `/api/cache/upload/diagram_image` for the upload itself plus a
  `clear_diagram_reference_image` service for removal) is a per-diagram_type
  fallback hero photo, used by any firearm of that type with no photo of its
  own at all (see the frontend's `utils/hero-image.ts` - it's the last tier
  of that fallback chain, behind the firearm's own primary gallery photo) -
  managed from Settings, not tied to any single firearm.
  `async_set_diagram_reference_image` returns the previous filename (if
  replacing an existing upload) so the view can delete the now-orphaned
  file, same pattern as `services.py`'s existing photo/document delete
  handlers. This diagram_type-level image system used to also carry a
  per-slot anchor-position override (`diagram_anchor_overrides`) for the
  frontend's now-removed wireframe-SVG diagram - that field was dropped
  entirely once the frontend redesigned My Build around a flat
  attachment-card bar with no per-slot positions to override (see
  `ha-cache-frontend`'s CLAUDE.md).
- A firearm's "hero" photo (shown on the Dashboard's Wishlist panel and the
  firearm detail page header) is just its regular gallery's primary photo -
  there's no separate dedicated hero/build-image field or upload endpoint.
  There used to be one (`Firearm.build_image_filename`, a `CacheUpload
  FirearmBuildImageView` at `/api/cache/upload/firearm_build_image`, a
  `clear_firearm_build_image` service) - removed once the concept of a
  hero image distinct from the gallery stopped making sense: every gallery
  photo already runs through `openai_client.remove_background` on upload
  (see `CacheUploadPhotoView` below), so a separate dedicated upload was no
  longer buying a different result, just a second thing to keep in sync.
  `coordinator.async_add_photo` already marks the FIRST photo added to an
  empty firearm gallery as primary automatically (`is_first = not
  firearm.photos`), so a freshly-added firearm's first gallery photo
  becomes its hero with no extra step. See `ha-cache-frontend`'s CLAUDE.md
  for `utils/hero-image.ts`'s fallback chain.
- `coordinator.async_replace_photo_file(photo_id, new_filename)` swaps a
  `Photo`'s stored file in place - keeping its id/original_filename/
  is_primary/uploaded_at untouched - and returns the previous filename,
  same return convention as every other photo-replaces-photo method here.
  Its one caller is `services.py`'s `reprocess_firearm_photos` service (no
  upload involved, like `clear_diagram_reference_image`): a one-off batch
  action that re-runs every ALREADY-uploaded firearm gallery photo
  (optionally scoped to one `firearm_id`) through `openai_client.
  remove_background`, for photos uploaded before `CacheUploadPhotoView`
  started doing that automatically on every new upload. Reads each
  photo's existing file bytes back off disk (`services.py`'s own
  `_read_upload_file`/`_write_upload_file` helpers, since this isn't a
  multipart upload - the bytes already live in `www/cache_uploads/`),
  guesses `content_type` from the stored filename's extension
  (`mimetypes.guess_type` - photos don't otherwise carry their own
  content_type in storage), then writes the result as a new file and
  unlinks the old one. A single photo's failure (transient OpenAI error,
  or a Store entry whose file already went missing) is logged and
  skipped rather than aborting the whole batch, since one bad photo
  shouldn't undo everything already reprocessed before it in the same
  call; a missing API key fails the whole call upfront instead, since
  nothing in the batch could succeed without one. This is a real,
  costly, one-way operation - one OpenAI image-edit call per photo, and
  the original background can't be recovered once overwritten - so it's
  services.yaml-documented as such rather than something wired to run
  automatically.
- A firearm's displayed "estimated value" (`logic.firearm_effective_value`,
  exposed as `FirearmSensor`'s `effective_estimated_value` attribute) is
  computed, not the raw stored field - the firearm's own value plus every
  `InventoryItem` currently installed on it (`installed_firearm_id ==
  firearm.id`), so buying a $1000 rifle and installing a $300 optic on it
  shows $1300, not $1000. Both sides use the shared `logic._effective_value`
  fallback (an explicit estimate wins, otherwise falls back to purchase
  price, `None` only when neither is known) - `dashboard_stats`'s
  `total_collection_value` uses the same fallback per firearm/item so the
  collection-wide total and the sum of what's shown on each individual
  firearm card never drift apart. The raw `Firearm.current_estimated_value`
  field (the Edit Firearm form's own input) is untouched by any of this -
  it's still just what the user typed in, one input among several the
  fallback chain reads from.
- A wishlist firearm/part is a normal `Firearm`/`InventoryItem` record with
  `is_wishlist=True`, not a separate entity or shadow model - it reuses
  every existing field (`current_estimated_value`/`estimated_value`
  doubles as "what I think this will cost", filled in for real once
  actually bought). There's no dedicated "mark as purchased" service - the
  frontend just calls the existing `update_firearm`/`update_inventory_item`
  with `is_wishlist: false` (and usually `purchase_date`/`purchase_price`
  filled in at the same time), since flipping a flag on an existing record
  is all "purchasing" a wishlist entry actually is. The coordinator does record
  WHEN it happened: `acquired_at` (Firearm and InventoryItem) is set to
  now on the `is_wishlist` True->False transition in `async_update_firearm`
  / `async_update_inventory_item`, cleared on False->True, and `None` for
  records never on the wishlist. Not a settable service field; it drives the
  dashboard's "Added to collection" activity row for bought wishlist items.
  **`Firearm` and `InventoryItem` now use TWO DIFFERENT wishlist-priority
  schemes**, deliberately - firearms got a full drag-and-drop reorder UI,
  parts didn't (yet):
  - `InventoryItem.wishlist_priority` (`const.py`'s `WISHLIST_PRIORITIES`:
    High/Medium/Low) - the original 3-tier scheme, only means anything
    while `is_wishlist` is `True`; `coordinator._validate_wishlist_priority`
    rejects anything else but allows `None` (not wishlisted, or wishlisted
    without a priority set yet).
  - `Firearm.wishlist_rank` (`int | None`) replaced priority tiers for
    firearms entirely - a full, user-controlled ordering across every
    wishlist firearm (0 = wanted most), driven by the frontend's drag-and-
    drop reorder modal. NOT a plain settable field on `add_firearm`/
    `update_firearm` (unlike everything else in `FIREARM_FIELDS`) -
    `coordinator.async_add_firearm`/`async_update_firearm` auto-assign the
    next rank (`_next_wishlist_firearm_rank()`, one past the current max)
    the moment `is_wishlist` becomes `True` on add or update, and clear it
    back to `None` the moment it becomes `False` again (so "Mark as
    Purchased"/un-wishlisting never leaves a stale rank on an owned
    firearm). The ONLY way to reassign existing ranks is the dedicated
    `reorder_wishlist_firearms` service (`firearm_ids`, the complete new
    order - rank = position in the list) /
    `coordinator.async_reorder_wishlist_firearms` - it saves the whole new
    order in one atomic call rather than per-item deltas, which sidesteps
    any insert-between/fractional-rank complexity entirely. Every id
    passed must already be a real, currently-wishlisted firearm, or the
    whole call is rejected (a stale id almost always means the frontend's
    list and backend state have drifted apart, and a partial reorder would
    make that worse, not better).
  `logic.dashboard_stats` excludes `is_wishlist=True` firearms/items from
  every owned-collection aggregate (counts, `total_collection_value`,
  `by_manufacturer`/`by_type`/`by_caliber`, `recently_added`/
  `recently_fired`/`needing_cleaning`/`most_used`) entirely, rather than
  mixing wishlist entries into "what I own" - they get their own separate
  `wishlist_firearms_count`/`wishlist_items_count`/`wishlist_total_value`
  aggregates instead, still using the same `_effective_value` fallback for
  consistency. `nfa_items` counts firearms the user checked as NFA
  (`Firearm.is_nfa`, a plain boolean - Jordan wanted a simple checkbox,
  not a classification) plus owned Suppressor parts; nothing is inferred
  from firearm type. The one exception is loading a firearm saved before
  `is_nfa` existed: `Firearm.from_dict` defaults it to `firearm_type in
  NFA_FIREARM_TYPES` ("SBR"), so an existing SBR stays counted.
  `wishlist_nfa_items` uses the same definition, scoped to the wishlist. `top_wishlist_item_name`/
  `top_wishlist_item_priority` pick the single wishlist entry (firearm OR
  part) the dashboard sensor exposes - since firearms and parts now use
  two incomparable schemes (a rank position vs. a priority tier), comparing
  them directly would be apples-to-oranges, so a wishlist FIREARM always
  wins if any exist at all (ranked ascending by `wishlist_rank`, unranked
  ones sorting last, tiebroken by effective value descending then most-
  recently-added), falling back to the top-priority PART (the original
  priority/value/recency tiebreak) only when there are no wishlist
  firearms. `top_wishlist_item_priority` is therefore `None` for a
  firearm-sourced pick (a rank isn't a tier) and only populated for a
  part-sourced one. Both fields are `None` when the wishlist is empty.
  Every tiebreak sort here is two passes (sort by `created_at` descending
  first, then a stable sort by the rank-or-priority/value key) rather than
  one compound key, since negating an ISO date string for "newest first"
  doesn't work the way negating a number does - Python's sort stability
  makes the two-pass version equivalent to a real three-key sort.
  `logic.firearm_effective_value` similarly excludes installed wishlist
  parts from a firearm's own displayed value, even though My Build DOES
  let you install a wishlist part onto a real firearm to preview a wanted
  build - the preview shouldn't count as money actually spent. Both
  `Firearm` and `InventoryItem` also carry an optional `product_url` (a
  link to buy/reference the thing) - not restricted to wishlist entries,
  same as every other field, just most useful while something still is
  one.
- `web.py` (was `http.py`) - `upload_photo` / `upload_document` /
  `upload_diagram_image`, the one thing a JSON service call can't do
  (multipart upload). Saves under `/data/uploads/`, served at
  `uploads/...` (relative to the ingress page). `scan_ammo_box` is another upload
  view, but doesn't persist anything - it forwards the image straight to
  `openai_client.scan_ammo_box` and returns the extracted fields,
  discarding the photo. Most share `_read_upload` (validate + read into
  memory); the ones that persist as-is go on to `_save_upload`'s disk
  write, which itself calls the shared `_write_bytes` executor-job helper.
  `upload_photo` is the one exception to "persist as-is": when an OpenAI
  key is configured it pipes the upload through
  `openai_client.remove_background` FIRST and writes the processed PNG
  (via `_write_bytes` directly, not `_save_upload`) - for both
  `entity_type`s, so parts (whose photo is their attachment-card art) and
  firearms (whose primary gallery photo doubles as their hero) read as
  clean cutouts. **Without a key the photo is saved as uploaded** (original
  extension kept) - this used to reject the upload outright, which left a
  fresh install unable to add any photos until the user set up OpenAI. A
  key that IS configured but whose call fails still fails the upload
  (502), rather than silently skipping a cutout the user expects.
  Firearm photos saved without removal (no key at the time) aren't touched
  retroactively by a plain upload/re-upload - `services.py`'s
  `reprocess_firearm_photos` service (see below) is the one-off batch
  action for those. `CacheLookupAmmoBarcodeView` is a non-upload view
  (plain JSON POST, `{"barcode": "..."}") - the two ammo-fill flows
  (photo scan vs. barcode scan) end up at the same `ScannedAmmoFields`-
  shaped JSON response either way, so the frontend handles them
  identically once the request comes back.
- `web.py`'s `estimate_value` (`api/estimate_value`) asks OpenAI for a
  rough used/resale price range via `openai_client.estimate_used_value` -
  a Structured Outputs call sharing the `_structured_completion` plumbing
  `scan_ammo_box`/`extract_ammo_fields_from_text` use (renamed from
  `_extract_fields` and generalized to take a schema). A knowledge-based
  estimate from the model's training data, NOT live market data - the
  prompt says so and asks for null-both-prices rather than a guess when
  the model doesn't recognize the item. Takes one plain text
  `description` (built by the panel from whatever manufacturer/model/
  type/caliber/condition is on file), so one endpoint serves firearms and
  parts. Persists nothing - the panel shows the range for the user to
  review and explicitly apply to `current_estimated_value`/
  `estimated_value`.
- `openai_client.py` - vision-capable OpenAI chat-completions calls (plain
  `aiohttp` REST, not the `openai` pip package, to avoid a new dependency
  for two endpoints) extracting caliber/manufacturer/product_name/
  bullet_weight/bullet_type/muzzle_velocity/rounds_per_box via Structured
  Outputs (`response_format: json_schema`, `strict: true` - any field not
  clearly stated comes back `null` rather than guessed). `scan_ammo_box`
  reads a photo; `extract_ammo_fields_from_text` reads a barcode lookup's
  listing text instead (see `barcode_client.py`) - both funnel through the
  shared `_extract_fields` request/schema/error-handling helper, differing
  only in the "content parts" list (image vs. text) sent to OpenAI.
  `get_openai_api_key(hass)` checks the (single, since this integration is
  `single_instance_allowed`) config entry's `options` first; if that's
  blank, it falls back to an `openai_api_key` entry in the user's own
  `secrets.yaml` (read via `hass.async_add_executor_job` - file I/O, can't
  block the event loop), for anyone who already has that secret defined for
  another integration/automation and doesn't want to duplicate it in the
  options flow UI. Never logged, never returned to the frontend, and read
  fresh on every call rather than cached at startup, so changing either
  source takes effect on the next scan with no reload needed. `remove_
  background` is the module's one non-vision, non-chat-completions call -
  OpenAI's image edit endpoint (`OPENAI_IMAGES_EDIT_URL`/
  `OPENAI_IMAGE_MODEL` in `const.py`, `gpt-image-1`) rather than
  `OPENAI_CHAT_COMPLETIONS_URL`, posted as multipart form data (`aiohttp.
  FormData`) instead of JSON since it's an image edit, not a chat message,
  requesting `background: "transparent"` and returning the resulting
  image as base64 (`b64_json`) rather than a URL. `size` is `"auto"`, not
  a fixed `"1024x1024"` - a fixed square canvas forces OpenAI to reframe
  (effectively zoom/crop) any non-square input to fit it, which silently
  cut real content off the edges of wide/landscape photos (e.g. a scope's
  side wings) - `"auto"` lets the model pick an output size matching the
  input's own aspect ratio instead. Called from `http.py`'s
  `CacheUploadPhotoView` (both entity types), and from `services.py`'s
  `reprocess_firearm_photos` handler for existing photos.
- `barcode_client.py` - looks up a scanned UPC/EAN via UPCitemdb's free
  trial endpoint (`lookup_upc`, no API key, rate-limited by UPCitemdb to
  100 lookups/day/IP - fine for occasional single-item lookups, not bulk
  import). Ammo UPC coverage varies by brand/retailer, so `http.py`'s
  `CacheLookupAmmoBarcodeView` degrades gracefully rather than requiring
  OpenAI: if a key is configured, the matched listing's title/brand/
  description gets parsed into full structured fields via
  `openai_client.extract_ammo_fields_from_text`; if not (or that call
  fails), `fallback_fields` does a plain manufacturer/product_name mapping
  from the raw listing instead of failing outright - caliber/bullet_weight/
  bullet_type/muzzle_velocity/rounds_per_box just come back `null` for the
  user to fill in by hand in that case.
- Configuration: there's no config flow any more. The OpenAI key is the
  add-on's `openai_api_key` option (Settings > Add-ons > Cache >
  Configuration), with secrets.yaml and the key imported from the old
  integration as fallbacks (`openai_client.get_openai_api_key`). Collection
  name and default thresholds start at `CacheSettings` defaults (or
  whatever the import brought over) and are edited in the panel's
  Settings tab.

## Testing

- Plain pytest, no Home Assistant needed - nothing imports `homeassistant`
  any more. `cd cache/backend && python -m venv .venv && .venv/Scripts/pip
  install -r requirements_test.txt`, then `.venv/Scripts/python -m pytest
  -q` and `.venv/Scripts/python -m ruff check cache_addon tests`.
- `test_logic.py` covers all pure functions. `test_coordinator.py` covers
  mutation lifecycles directly against an in-memory `CacheCoordinator` (a
  `FakeStore` stand-in), no HTTP layer. `test_addon.py` covers the add-on
  layers: `states.py` shapes, MQTT payloads/discovery, `migrate.py`,
  `CacheStore` on disk, and `web.py` through aiohttp's test client.

## Conventions

- Type hints on everything; `from __future__ import annotations` at the top
  of every module.
- Add-on options (`config.yaml`'s `options`/`schema`, read by `config.py`)
  only - no other configuration.
- IDs are `uuid.uuid4().hex` (matches Stash/Hustle's convention).
- No compatibility validation on installed parts - only part_type matching
  (an Optic Mount fits any Optic Mount slot). This is a deliberate product
  decision, not a gap: the user is responsible for choosing the correct
  item.
- A slot_type (Part) is NOT exclusive - any number of items can share the
  same slot_type on the same firearm at once (e.g. two Optics). Installing
  an item never evicts whatever else already occupies that slot_type - it
  used to, but that eviction loop was removed since "only one item per
  slot" turned out not to match how people actually build (a rifle with
  both a red dot and a magnifier, etc.). Because of this,
  `async_remove_item(item_id, new_storage_location_id)` targets a specific
  item by its own id, not by `(firearm_id, slot_type)` - that pair alone
  is ambiguous once more than one item can share a slot_type. The frontend
  is responsible for showing every item currently occupying a slot_type
  (not just one) and letting the user pick which specific one to remove.
  `new_storage_location_id` is only *required* for an owned item - a
  wishlist item installed via My Build has no physical location to
  return to (it was never actually bought, just previewed on a build; see
  `logic.firearm_effective_value` below), so removing a wishlist item
  accepts an empty/omitted location and just clears
  `storage_location_id` to `None`. A wishlist item CAN still be given a
  real location on removal (e.g. it's about to be purchased) - the field
  is optional for it, not ignored.
- Every `InventoryItem` has two real, independently-stored fields:
  `category` (coarse, e.g. "Optic") and `part_type` (specific, e.g. "Optic
  Mount") - `const.py`'s `PART_TAXONOMY` (`dict[Category, list[Part]]`) is
  the single source of truth both are validated against, plus its reverse
  `CATEGORY_FOR_PART` lookup. `coordinator._validate_part_taxonomy` checks
  both belong to the allowed set AND that they're a real pair (rejects
  e.g. `category="Barrel", part_type="Trigger"` even though both are
  individually valid). `INVENTORY_CATEGORIES` (10 entries) and
  `PART_TYPES` (18 entries, flattened from `PART_TAXONOMY`) are derived
  from it, not hand-maintained lists. Every firearm's My Build now shows
  the identical universal set of installable slots - `PART_TYPES` itself,
  literally - there's no more per-firearm-type slot list like the old
  `DIAGRAM_SLOTS`/`BUILD_SLOT_CATEGORIES` had; `logic.validate_install`
  checks `slot_type in PART_TYPES` plus `item.part_type == slot_type`, no
  longer taking a `firearm` argument at all since firearm type no longer
  affects which slots exist. `FIREARM_DIAGRAM_MAP`/`diagram_type_for` are
  still around, but only for picking a default per-type fallback hero photo
  (see `CacheSettings.diagram_reference_images` below) -
  `DIAGRAM_TYPES` (every value `FIREARM_DIAGRAM_MAP` can produce)
  replaced `DIAGRAM_SLOTS` as what `CacheUploadDiagramImageView` validates
  `diagram_type` against. A handful of pre-taxonomy categories were
  dropped outright rather than folded in somewhere (Sling, Holster, Case,
  Cleaning Kit, Ammo Can, Range Bag, Safe, Tool, and the old catch-all
  "Miscellaneous", now "Other / Miscellaneous" under Accessory) - see the
  `storage.py`/`logic.migrate_inventory_item_taxonomy` bullet below for
  what happens to existing items that had one of those.

## Deployment

See the repo's top-level CLAUDE.md.
