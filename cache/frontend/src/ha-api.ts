import type {
  Ammunition,
  AmmoAlertRule,
  AmmoTransaction,
  CacheState,
  CleaningLogEntry,
  DashboardStats,
  DocumentEntry,
  Firearm,
  InstalledItemSummary,
  InventoryItem,
  Photo,
  RangeSchedule,
  RangeScheduleTarget,
  RangeSession,
  RangeSessionFirearmEntry,
  ScannedAmmoFields,
  Settings,
  StorageLocation,
  TrainingPlan,
  TrainingPlanStep,
  UsedValueEstimate,
} from "./types";

export interface HassEntity {
  entity_id: string;
  state: string;
  attributes: Record<string, unknown>;
}

export interface HassUser {
  id: string;
  name: string;
  is_admin: boolean;
}

export interface HomeAssistant {
  states: Record<string, HassEntity>;
  user?: HassUser;
  hassUrl?: (path?: string) => string;
  auth?: { data: { access_token: string } };
  // target/notifyOnError match real HA's signature but are never used
  // here (no service targets an entity_id/device_id/area_id the frontend
  // controls); returnResponse is - see SERVICE_ADD_FIREARM's comment in
  // the backend's services.py. HA's own frontend resolves the
  // returned promise with `{ context, response? }` when supports_response
  // isn't NONE, `undefined` otherwise - every existing call site here
  // ignores the return value entirely, so widening it from the previous
  // `Promise<unknown>` is backward compatible.
  callService(
    domain: string,
    service: string,
    serviceData?: Record<string, unknown>,
    target?: unknown,
    notifyOnError?: boolean,
    returnResponse?: boolean
  ): Promise<{ context?: unknown; response?: Record<string, unknown> } | undefined>;
  callWS<T>(msg: Record<string, unknown>): Promise<T>;
}

const DOMAIN = "cache";
// Relative - the add-on serves uploads itself, under its ingress prefix.
const UPLOADS_BASE = "uploads";

function entitiesWith(hass: HomeAssistant, attr: string): HassEntity[] {
  return Object.values(hass.states).filter(
    (e) => e.entity_id.startsWith("sensor.") && attr in e.attributes
  );
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown, fallback = ""): string {
  return value === null || value === undefined ? fallback : String(value);
}

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function bool(value: unknown): boolean {
  return Boolean(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseDiagramReferenceImages(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [diagramType, filename] of Object.entries(value as Record<string, unknown>)) {
    if (typeof filename === "string" && filename) out[diagramType] = `${UPLOADS_BASE}/${filename}`;
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asNumberRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(asRecord(value))) out[k] = num(v);
  return out;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

function parsePhoto(raw: unknown): Photo {
  const p = raw as Record<string, unknown>;
  const filename = str(p.filename);
  return {
    id: str(p.id),
    filename,
    originalFilename: strOrNull(p.original_filename),
    isPrimary: bool(p.is_primary),
    uploadedAt: str(p.uploaded_at),
    url: `${UPLOADS_BASE}/${filename}`,
  };
}

function parseDocument(raw: unknown): DocumentEntry {
  const d = raw as Record<string, unknown>;
  const filename = str(d.filename);
  return {
    id: str(d.id),
    filename,
    originalFilename: strOrNull(d.original_filename),
    documentType: str(d.document_type, "Other"),
    uploadedAt: str(d.uploaded_at),
    url: `${UPLOADS_BASE}/${filename}`,
  };
}

function parseCleaningLogEntry(raw: unknown): CleaningLogEntry {
  const c = raw as Record<string, unknown>;
  return {
    id: str(c.id),
    cleanedDate: str(c.cleaned_date),
    roundCountAtCleaning: num(c.round_count_at_cleaning),
    notes: strOrNull(c.notes),
    createdAt: str(c.created_at),
    createdBy: strOrNull(c.created_by),
  };
}

// This is Firearm.installedItems - a lightweight summary from the
// firearm's own sensor payload, used only for the "Installed Parts (N)"
// count. It carries no photo data (the backend doesn't include one), so
// photoUrl is always null here - card rendering instead derives an
// InstalledItemSummary per slot from the live `cacheState.inventoryItems`
// list (see utils/installed-items.ts), which does have each item's own
// photos.
function parseInstalledItem(raw: unknown): InstalledItemSummary {
  const i = raw as Record<string, unknown>;
  return {
    id: str(i.id),
    customName: str(i.custom_name),
    category: str(i.category),
    partType: strOrNull(i.part_type),
    manufacturer: strOrNull(i.manufacturer),
    model: strOrNull(i.model),
    installedSlotType: strOrNull(i.installed_slot_type),
    photoUrl: null,
    isWishlist: bool(i.is_wishlist),
  };
}

function parseRangeScheduleTarget(raw: unknown): RangeScheduleTarget {
  const t = raw as Record<string, unknown>;
  const targetType = str(t.target_type, "firearm_type");
  const speedClass = t.speed_class;
  return {
    targetType: targetType === "firearm" || targetType === "caliber" ? targetType : "firearm_type",
    firearmId: strOrNull(t.firearm_id),
    firearmType: strOrNull(t.firearm_type),
    caliber: strOrNull(t.caliber),
    speedClass: speedClass === "Subsonic" || speedClass === "Supersonic" ? speedClass : null,
    bulletType: strOrNull(t.bullet_type),
    roundsMin: numOrNull(t.rounds_min),
  };
}

function parseAmmoAlertRule(raw: unknown): AmmoAlertRule {
  const r = raw as Record<string, unknown>;
  const matchType = r.match_type;
  return {
    id: str(r.id),
    matchType:
      matchType === "bullet_type" || matchType === "speed_class" ? matchType : "caliber",
    matchValue: str(r.match_value),
    threshold: num(r.threshold),
    createdAt: str(r.created_at),
  };
}

function parseTrainingPlanStep(raw: unknown): TrainingPlanStep {
  const s = raw as Record<string, unknown>;
  return {
    id: str(s.id),
    label: str(s.label),
    targets: asArray(s.targets).map(parseRangeScheduleTarget),
    notes: strOrNull(s.notes),
    lastCompletedDate: strOrNull(s.last_completed_date),
    isCurrent: bool(s.is_current),
    matchingFirearmNames: asStringArray(s.matching_firearm_names),
    matchingCalibers: asStringArray(s.matching_calibers),
  };
}

function parseAmmoTransaction(raw: unknown): AmmoTransaction {
  const t = raw as Record<string, unknown>;
  return {
    id: str(t.id),
    changeType: str(t.change_type),
    quantityDelta: num(t.quantity_delta),
    resultingQuantity: num(t.resulting_quantity),
    note: strOrNull(t.note),
    rangeSessionId: strOrNull(t.range_session_id),
    createdAt: str(t.created_at),
    createdBy: strOrNull(t.created_by),
  };
}

/** Scans hass.states for every sensor.* entity that carries the discovery
 * attributes documented in sensor.py, groups them, and builds a fully typed
 * CacheState - mirroring Hustle/Stash's "scan and group by attribute key"
 * approach rather than guessing entity_ids from naming. */
export function parseCacheState(hass: HomeAssistant): CacheState {
  const fixedByKey = new Map<string, HassEntity>();
  for (const entity of entitiesWith(hass, "cache_key")) {
    fixedByKey.set(String(entity.attributes.cache_key), entity);
  }

  const settingsEntity = fixedByKey.get("settings");
  const settings: Settings | null = settingsEntity
    ? {
        collectionName: str(settingsEntity.attributes.collection_name, "My Collection"),
        lowAmmoThresholdDefault: num(settingsEntity.attributes.low_ammo_threshold_default, 50),
        cleaningReminderRounds: num(settingsEntity.attributes.cleaning_reminder_rounds, 300),
        cleaningReminderDays: num(settingsEntity.attributes.cleaning_reminder_days, 90),
        cleaningNotificationsEnabled: bool(settingsEntity.attributes.cleaning_notifications_enabled),
        lowAmmoNotificationsEnabled: bool(settingsEntity.attributes.low_ammo_notifications_enabled),
        diagramReferenceImages: parseDiagramReferenceImages(
          settingsEntity.attributes.diagram_reference_images
        ),
      }
    : null;

  const storageLocationsEntity = fixedByKey.get("storage_locations");
  const storageLocations: StorageLocation[] = asArray(
    storageLocationsEntity?.attributes.locations
  ).map((raw): StorageLocation => {
    const l = raw as Record<string, unknown>;
    return {
      id: str(l.id),
      name: str(l.name),
      description: strOrNull(l.description),
      createdAt: str(l.created_at),
      firearmCount: num(l.firearm_count),
      itemCount: num(l.item_count),
    };
  });

  const dashboardEntity = fixedByKey.get("dashboard_stats");
  const dashboardStats: DashboardStats | null = dashboardEntity
    ? {
        totalFirearms: num(dashboardEntity.attributes.total_firearms),
        handguns: num(dashboardEntity.attributes.handguns),
        rifles: num(dashboardEntity.attributes.rifles),
        shotguns: num(dashboardEntity.attributes.shotguns),
        nfaItems: num(dashboardEntity.attributes.nfa_items),
        totalCollectionValue: num(dashboardEntity.attributes.total_collection_value),
        totalAmmunition: num(dashboardEntity.attributes.total_ammunition),
        averageRoundCount: num(dashboardEntity.attributes.average_round_count),
        byManufacturer: asNumberRecord(dashboardEntity.attributes.by_manufacturer),
        byType: asNumberRecord(dashboardEntity.attributes.by_type),
        byCaliber: asNumberRecord(dashboardEntity.attributes.by_caliber),
        ammunitionByCaliber: asNumberRecord(dashboardEntity.attributes.ammunition_by_caliber),
        recentlyAddedIds: asStringArray(dashboardEntity.attributes.recently_added_ids),
        recentlyFiredIds: asStringArray(dashboardEntity.attributes.recently_fired_ids),
        needingCleaningIds: asStringArray(dashboardEntity.attributes.needing_cleaning_ids),
        mostUsedIds: asStringArray(dashboardEntity.attributes.most_used_ids),
        wishlistFirearmsCount: num(dashboardEntity.attributes.wishlist_firearms_count),
        wishlistItemsCount: num(dashboardEntity.attributes.wishlist_items_count),
        wishlistNfaItems: num(dashboardEntity.attributes.wishlist_nfa_items),
        wishlistTotalValue: num(dashboardEntity.attributes.wishlist_total_value),
        topWishlistItemName: strOrNull(dashboardEntity.attributes.top_wishlist_item_name),
        topWishlistItemPriority: strOrNull(dashboardEntity.attributes.top_wishlist_item_priority),
      }
    : null;

  const rangeSessionsEntity = fixedByKey.get("range_sessions");
  const rangeSessions: RangeSession[] = asArray(rangeSessionsEntity?.attributes.sessions).map(
    (raw): RangeSession => {
      const s = raw as Record<string, unknown>;
      const firearmEntries: RangeSessionFirearmEntry[] = asArray(s.firearms).map((rawF) => {
        const f = rawF as Record<string, unknown>;
        return {
          firearmId: str(f.firearm_id),
          firearmName: strOrNull(f.firearm_name),
          ammunitionId: strOrNull(f.ammunition_id),
          ammunitionLabel: strOrNull(f.ammunition_label),
          roundsFired: num(f.rounds_fired),
        };
      });
      return {
        id: str(s.id),
        date: str(s.date),
        location: strOrNull(s.location),
        notes: strOrNull(s.notes),
        createdAt: str(s.created_at),
        createdBy: strOrNull(s.created_by),
        totalRounds: num(s.total_rounds),
        firearms: firearmEntries,
      };
    }
  );

  const cleaningDueCount = num(fixedByKey.get("cleaning_due_count")?.state);
  const lowAmmoCount = num(fixedByKey.get("low_ammo_count")?.state);
  const trainingDueCount = num(fixedByKey.get("training_due_count")?.state);
  const trainingAmmoAlertCount = num(fixedByKey.get("training_ammo_alert_count")?.state);

  const rangeSchedulesEntity = fixedByKey.get("range_schedules");
  const rangeSchedules: RangeSchedule[] = asArray(rangeSchedulesEntity?.attributes.schedules).map(
    (raw): RangeSchedule => {
      const s = raw as Record<string, unknown>;
      return {
        id: str(s.id),
        label: strOrNull(s.label),
        targets: asArray(s.targets).map(parseRangeScheduleTarget),
        frequency: str(s.frequency, "quarterly"),
        ammoAlertEnabled: bool(s.ammo_alert_enabled),
        active: s.active === undefined ? true : bool(s.active),
        lastCompletedDate: strOrNull(s.last_completed_date),
        nextDueDate: strOrNull(s.next_due_date),
        isDue: bool(s.is_due),
        ammoOk: s.ammo_ok === null || s.ammo_ok === undefined ? null : bool(s.ammo_ok),
        matchingFirearmNames: asStringArray(s.matching_firearm_names),
        matchingCalibers: asStringArray(s.matching_calibers),
        notes: strOrNull(s.notes),
        createdAt: str(s.created_at),
        updatedAt: str(s.updated_at),
      };
    }
  );

  const trainingPlansEntity = fixedByKey.get("training_plans");
  const trainingPlans: TrainingPlan[] = asArray(trainingPlansEntity?.attributes.plans).map(
    (raw): TrainingPlan => {
      const p = raw as Record<string, unknown>;
      const mode = p.mode === "calendar" ? "calendar" : "sequential";
      return {
        id: str(p.id),
        label: strOrNull(p.label),
        mode,
        startMonth: numOrNull(p.start_month),
        startYear: numOrNull(p.start_year),
        currentStepIndex: numOrNull(p.current_step_index),
        active: p.active === undefined ? true : bool(p.active),
        ammoAlertEnabled: bool(p.ammo_alert_enabled),
        isDue: bool(p.is_due),
        ammoOk: p.ammo_ok === null || p.ammo_ok === undefined ? null : bool(p.ammo_ok),
        notes: strOrNull(p.notes),
        steps: asArray(p.steps).map(parseTrainingPlanStep),
        createdAt: str(p.created_at),
        updatedAt: str(p.updated_at),
      };
    }
  );

  const ammoAlertRulesEntity = fixedByKey.get("ammo_alert_rules");
  const ammoAlertRules: AmmoAlertRule[] = asArray(ammoAlertRulesEntity?.attributes.rules).map(
    parseAmmoAlertRule
  );

  const firearms: Firearm[] = entitiesWith(hass, "firearm_id").map((e): Firearm => ({
    entityId: e.entity_id,
    id: str(e.attributes.firearm_id),
    customName: str(e.attributes.custom_name),
    firearmType: str(e.attributes.firearm_type),
    manufacturer: strOrNull(e.attributes.manufacturer),
    model: strOrNull(e.attributes.model),
    serialNumber: strOrNull(e.attributes.serial_number),
    caliber: strOrNull(e.attributes.caliber),
    barrelLength: strOrNull(e.attributes.barrel_length),
    overallLength: strOrNull(e.attributes.overall_length),
    weight: strOrNull(e.attributes.weight),
    twistRate: strOrNull(e.attributes.twist_rate),
    capacity: strOrNull(e.attributes.capacity),
    finish: strOrNull(e.attributes.finish),
    color: strOrNull(e.attributes.color),
    condition: strOrNull(e.attributes.condition),
    purchaseDate: strOrNull(e.attributes.purchase_date),
    purchasePrice: numOrNull(e.attributes.purchase_price),
    currentEstimatedValue: numOrNull(e.attributes.current_estimated_value),
    effectiveEstimatedValue: numOrNull(e.attributes.effective_estimated_value),
    purchasedFrom: strOrNull(e.attributes.purchased_from),
    warrantyExpiration: strOrNull(e.attributes.warranty_expiration),
    warrantyNotes: strOrNull(e.attributes.warranty_notes),
    productUrl: strOrNull(e.attributes.product_url),
    uses: asStringArray(e.attributes.uses),
    storageLocationId: strOrNull(e.attributes.storage_location_id),
    storageLocationName: strOrNull(e.attributes.storage_location_name),
    lifetimeRoundCount: num(e.attributes.lifetime_round_count),
    lastFiredDate: strOrNull(e.attributes.last_fired_date),
    lastCleaningDate: strOrNull(e.attributes.last_cleaning_date),
    roundCountAtLastCleaning: num(e.attributes.round_count_at_last_cleaning),
    notes: strOrNull(e.attributes.notes),
    primaryPhotoId: strOrNull(e.attributes.primary_photo_id),
    diagramType: str(e.attributes.diagram_type, "ar_platform"),
    needsCleaning: bool(e.attributes.needs_cleaning),
    isWishlist: bool(e.attributes.is_wishlist),
    wishlistRank: numOrNull(e.attributes.wishlist_rank),
    acquiredAt: strOrNull(e.attributes.acquired_at),
    installedItems: asArray(e.attributes.installed_items).map(parseInstalledItem),
    photos: asArray(e.attributes.photos).map(parsePhoto),
    documents: asArray(e.attributes.documents).map(parseDocument),
    cleaningHistory: asArray(e.attributes.cleaning_history).map(parseCleaningLogEntry),
    createdAt: str(e.attributes.created_at),
    updatedAt: str(e.attributes.updated_at),
    createdBy: strOrNull(e.attributes.created_by),
  }));

  const inventoryItems: InventoryItem[] = entitiesWith(hass, "inventory_item_id").map(
    (e): InventoryItem => ({
      entityId: e.entity_id,
      id: str(e.attributes.inventory_item_id),
      customName: str(e.attributes.custom_name),
      category: str(e.attributes.category),
      partType: strOrNull(e.attributes.part_type),
      manufacturer: strOrNull(e.attributes.manufacturer),
      model: strOrNull(e.attributes.model),
      serialNumber: strOrNull(e.attributes.serial_number),
      purchaseDate: strOrNull(e.attributes.purchase_date),
      purchasePrice: numOrNull(e.attributes.purchase_price),
      estimatedValue: numOrNull(e.attributes.estimated_value),
      condition: strOrNull(e.attributes.condition),
      notes: strOrNull(e.attributes.notes),
      storageLocationId: strOrNull(e.attributes.storage_location_id),
      installedFirearmId: strOrNull(e.attributes.installed_firearm_id),
      installedFirearmName: strOrNull(e.attributes.installed_firearm_name),
      installedSlotType: strOrNull(e.attributes.installed_slot_type),
      installedAt: strOrNull(e.attributes.installed_at),
      effectiveLocationName: strOrNull(e.attributes.effective_location_name),
      isWishlist: bool(e.attributes.is_wishlist),
      wishlistPriority: strOrNull(e.attributes.wishlist_priority),
      acquiredAt: strOrNull(e.attributes.acquired_at),
      productUrl: strOrNull(e.attributes.product_url),
      photos: asArray(e.attributes.photos).map(parsePhoto),
      createdAt: str(e.attributes.created_at),
      updatedAt: str(e.attributes.updated_at),
    })
  );

  const ammunition: Ammunition[] = entitiesWith(hass, "ammunition_id").map(
    (e): Ammunition => ({
      entityId: e.entity_id,
      id: str(e.attributes.ammunition_id),
      caliber: str(e.attributes.caliber),
      manufacturer: strOrNull(e.attributes.manufacturer),
      productName: strOrNull(e.attributes.product_name),
      bulletWeight: strOrNull(e.attributes.bullet_weight),
      bulletType: strOrNull(e.attributes.bullet_type),
      muzzleVelocity: strOrNull(e.attributes.muzzle_velocity),
      speedClass:
        e.attributes.speed_class === "Subsonic" || e.attributes.speed_class === "Supersonic"
          ? e.attributes.speed_class
          : null,
      quantity: num(e.attributes.quantity),
      costPerBox: numOrNull(e.attributes.cost_per_box),
      roundsPerBox: numOrNull(e.attributes.rounds_per_box),
      costPerRound: numOrNull(e.attributes.cost_per_round),
      purchaseDate: strOrNull(e.attributes.purchase_date),
      storageLocationId: strOrNull(e.attributes.storage_location_id),
      storageLocationName: strOrNull(e.attributes.storage_location_name),
      notes: strOrNull(e.attributes.notes),
      lowInventoryThreshold: numOrNull(e.attributes.low_inventory_threshold),
      isLow: bool(e.attributes.is_low),
      transactions: asArray(e.attributes.transactions).map(parseAmmoTransaction),
      createdAt: str(e.attributes.created_at),
      updatedAt: str(e.attributes.updated_at),
    })
  );

  return {
    settings,
    storageLocations,
    dashboardStats,
    rangeSessions,
    rangeSchedules,
    trainingPlans,
    ammoAlertRules,
    cleaningDueCount,
    lowAmmoCount,
    trainingDueCount,
    trainingAmmoAlertCount,
    firearms,
    inventoryItems,
    ammunition,
  };
}

// -------------------------------------------------------------- services

/** Home Assistant's voluptuous service schemas use `vol.Optional(field)` to
 * mean "may be omitted", not "may be null" - a present key with a
 * `null`/`undefined` value still gets type-checked and fails. Views build
 * payloads with `value ?? ""` for blank inputs on *update* calls (the
 * coordinator's `_normalize()` treats "" as "clear this field"), so this
 * only strips genuinely absent keys. */
function _cleanServiceData(data: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && value !== undefined) cleaned[key] = value;
  }
  return cleaned;
}

function callCacheService(
  hass: HomeAssistant,
  service: string,
  data: Record<string, unknown>
): Promise<unknown> {
  return hass.callService(DOMAIN, service, _cleanServiceData(data));
}

/** Same as callCacheService, but for the handful of services registered
 * with supports_response (currently add_firearm/add_inventory_item - see
 * the backend's services.py) where the caller actually needs
 * something back, not just to await completion - returns the service's
 * response dict (e.g. `{ firearm_id: "..." }`), or undefined if the
 * backend didn't include one (shouldn't happen for these two, but the
 * type stays honest about it rather than asserting non-null). */
function callCacheServiceForResponse(
  hass: HomeAssistant,
  service: string,
  data: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  return hass
    .callService(DOMAIN, service, _cleanServiceData(data), undefined, true, true)
    .then((result) => result?.response);
}

// Both paths are relative to the add-on's ingress page (see
// addon-hass.ts) - no Authorization header needed, ingress itself only
// lets logged-in Home Assistant users through. `hass` stays in these
// signatures so every caller in the views is unchanged from the custom
// panel days.

async function _parseJsonResponse(resp: Response, failureVerb: string): Promise<Record<string, unknown>> {
  const text = await resp.text();
  let body: Record<string, unknown>;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(resp.ok ? `${failureVerb}: unexpected server response` : `${failureVerb} (${resp.status})`);
  }
  if (!resp.ok) {
    throw new Error(typeof body?.error === "string" ? body.error : failureVerb);
  }
  return body;
}

async function uploadFile(
  _hass: HomeAssistant,
  path: string,
  fields: Record<string, string>,
  file: File
): Promise<Record<string, unknown>> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("file", file);
  const resp = await fetch(path, { method: "POST", body: form });
  return _parseJsonResponse(resp, "Upload failed");
}

async function postJson(
  _hass: HomeAssistant,
  path: string,
  body: unknown
): Promise<Record<string, unknown>> {
  const headers = { "Content-Type": "application/json" };
  const resp = await fetch(path, { method: "POST", body: JSON.stringify(body), headers });
  return _parseJsonResponse(resp, "Request failed");
}

function parseScannedAmmoFields(body: Record<string, unknown>): ScannedAmmoFields {
  return {
    caliber: strOrNull(body.caliber),
    manufacturer: strOrNull(body.manufacturer),
    productName: strOrNull(body.product_name),
    bulletWeight: strOrNull(body.bullet_weight),
    bulletType: strOrNull(body.bullet_type),
    muzzleVelocity: strOrNull(body.muzzle_velocity),
    roundsPerBox: numOrNull(body.rounds_per_box),
  };
}

function parseUsedValueEstimate(body: Record<string, unknown>): UsedValueEstimate {
  return {
    estimatedLow: numOrNull(body.estimated_low),
    estimatedHigh: numOrNull(body.estimated_high),
    confidence: strOrNull(body.confidence),
  };
}

export const cacheApi = {
  // ------------------------------------------------------- storage locations
  addStorageLocation(hass: HomeAssistant, name: string, description?: string) {
    return callCacheService(hass, "add_storage_location", { name, description });
  },
  updateStorageLocation(hass: HomeAssistant, locationId: string, fields: Record<string, unknown>) {
    return callCacheService(hass, "update_storage_location", { location_id: locationId, ...fields });
  },
  deleteStorageLocation(hass: HomeAssistant, locationId: string) {
    return callCacheService(hass, "delete_storage_location", { location_id: locationId });
  },

  // -------------------------------------------------------------- firearms
  // Returns the new firearm's id (from the backend's supports_response
  // handler - see the backend's services.py) so a caller can
  // immediately upload staged photos/a build image against it, in the
  // same Add Firearm submission, without waiting for any entity/state
  // round-trip to learn the id another way.
  async addFirearm(hass: HomeAssistant, fields: Record<string, unknown>): Promise<string> {
    const response = await callCacheServiceForResponse(hass, "add_firearm", fields);
    return String(response?.firearm_id ?? "");
  },
  updateFirearm(hass: HomeAssistant, firearmId: string, fields: Record<string, unknown>) {
    return callCacheService(hass, "update_firearm", { firearm_id: firearmId, ...fields });
  },
  deleteFirearm(hass: HomeAssistant, firearmId: string) {
    return callCacheService(hass, "delete_firearm", { firearm_id: firearmId });
  },
  reorderWishlistFirearms(hass: HomeAssistant, firearmIds: string[]) {
    return callCacheService(hass, "reorder_wishlist_firearms", { firearm_ids: firearmIds });
  },
  addRounds(hass: HomeAssistant, firearmId: string, rounds: number, firedDate?: string) {
    return callCacheService(hass, "add_rounds", { firearm_id: firearmId, rounds, fired_date: firedDate });
  },
  removeRounds(hass: HomeAssistant, firearmId: string, rounds: number) {
    return callCacheService(hass, "remove_rounds", { firearm_id: firearmId, rounds });
  },
  markCleaned(hass: HomeAssistant, firearmId: string, cleanedDate: string, notes?: string) {
    return callCacheService(hass, "mark_cleaned", { firearm_id: firearmId, cleaned_date: cleanedDate, notes });
  },

  // ---------------------------------------------------------------- build
  installItem(
    hass: HomeAssistant,
    firearmId: string,
    itemId: string,
    slotType: string,
    confirmMove = false
  ) {
    return callCacheService(hass, "install_item", {
      firearm_id: firearmId,
      item_id: itemId,
      slot_type: slotType,
      confirm_move: confirmMove,
    });
  },
  removeItem(hass: HomeAssistant, itemId: string, newStorageLocationId: string) {
    return callCacheService(hass, "remove_item", {
      item_id: itemId,
      new_storage_location_id: newStorageLocationId,
    });
  },

  // ------------------------------------------------------------- inventory
  // Same reasoning as addFirearm above - returns the new item's id so
  // staged photos can be uploaded right after creation.
  async addInventoryItem(hass: HomeAssistant, fields: Record<string, unknown>): Promise<string> {
    const response = await callCacheServiceForResponse(hass, "add_inventory_item", fields);
    return String(response?.item_id ?? "");
  },
  updateInventoryItem(hass: HomeAssistant, itemId: string, fields: Record<string, unknown>) {
    return callCacheService(hass, "update_inventory_item", { item_id: itemId, ...fields });
  },
  deleteInventoryItem(hass: HomeAssistant, itemId: string) {
    return callCacheService(hass, "delete_inventory_item", { item_id: itemId });
  },

  // ------------------------------------------------------------ ammunition
  addAmmunition(hass: HomeAssistant, fields: Record<string, unknown>) {
    return callCacheService(hass, "add_ammunition", fields);
  },
  updateAmmunition(hass: HomeAssistant, ammoId: string, fields: Record<string, unknown>) {
    return callCacheService(hass, "update_ammunition", { ammo_id: ammoId, ...fields });
  },
  deleteAmmunition(hass: HomeAssistant, ammoId: string) {
    return callCacheService(hass, "delete_ammunition", { ammo_id: ammoId });
  },
  addAmmoQuantity(hass: HomeAssistant, ammoId: string, quantityDelta: number, note?: string) {
    return callCacheService(hass, "add_ammo_quantity", { ammo_id: ammoId, quantity_delta: quantityDelta, note });
  },
  removeAmmoQuantity(hass: HomeAssistant, ammoId: string, quantityDelta: number, note?: string) {
    return callCacheService(hass, "remove_ammo_quantity", { ammo_id: ammoId, quantity_delta: quantityDelta, note });
  },
  setAmmoQuantity(hass: HomeAssistant, ammoId: string, quantity: number, note?: string) {
    return callCacheService(hass, "set_ammo_quantity", { ammo_id: ammoId, quantity, note });
  },

  // -------------------------------------------------------- range sessions
  logRangeSession(
    hass: HomeAssistant,
    fields: {
      date: string;
      location?: string;
      notes?: string;
      firearms: { firearm_id: string; ammunition_id?: string; rounds_fired: number }[];
    }
  ) {
    return callCacheService(hass, "log_range_session", fields);
  },
  updateRangeSession(
    hass: HomeAssistant,
    sessionId: string,
    fields: {
      date: string;
      location?: string;
      notes?: string;
      firearms: { firearm_id: string; ammunition_id?: string; rounds_fired: number }[];
    }
  ) {
    return callCacheService(hass, "update_range_session", { session_id: sessionId, ...fields });
  },
  deleteRangeSession(hass: HomeAssistant, sessionId: string) {
    return callCacheService(hass, "delete_range_session", { session_id: sessionId });
  },

  // ------------------------------------------------------- range schedules
  addRangeSchedule(hass: HomeAssistant, fields: Record<string, unknown>) {
    return callCacheService(hass, "add_range_schedule", fields);
  },
  updateRangeSchedule(hass: HomeAssistant, scheduleId: string, fields: Record<string, unknown>) {
    return callCacheService(hass, "update_range_schedule", { schedule_id: scheduleId, ...fields });
  },
  deleteRangeSchedule(hass: HomeAssistant, scheduleId: string) {
    return callCacheService(hass, "delete_range_schedule", { schedule_id: scheduleId });
  },

  // --------------------------------------------------------- training plans
  addTrainingPlan(hass: HomeAssistant, fields: Record<string, unknown>) {
    return callCacheService(hass, "add_training_plan", fields);
  },
  updateTrainingPlan(hass: HomeAssistant, planId: string, fields: Record<string, unknown>) {
    return callCacheService(hass, "update_training_plan", { plan_id: planId, ...fields });
  },
  deleteTrainingPlan(hass: HomeAssistant, planId: string) {
    return callCacheService(hass, "delete_training_plan", { plan_id: planId });
  },
  advanceTrainingPlan(hass: HomeAssistant, planId: string, completedDate?: string) {
    return callCacheService(hass, "advance_training_plan", {
      plan_id: planId,
      completed_date: completedDate,
    });
  },

  // -------------------------------------------------------------- settings
  updateSettings(hass: HomeAssistant, fields: Record<string, unknown>) {
    return callCacheService(hass, "update_settings", fields);
  },
  uploadDiagramImage(hass: HomeAssistant, diagramType: string, file: File) {
    return uploadFile(hass, "api/upload/diagram_image", { diagram_type: diagramType }, file);
  },
  clearDiagramReferenceImage(hass: HomeAssistant, diagramType: string) {
    return callCacheService(hass, "clear_diagram_reference_image", { diagram_type: diagramType });
  },

  // -------------------------------------------------------- ammo alert rules
  addAmmoAlertRule(hass: HomeAssistant, matchType: string, matchValue: string, threshold: number) {
    return callCacheService(hass, "add_ammo_alert_rule", {
      match_type: matchType,
      match_value: matchValue,
      threshold,
    });
  },
  updateAmmoAlertRule(hass: HomeAssistant, ruleId: string, fields: Record<string, unknown>) {
    return callCacheService(hass, "update_ammo_alert_rule", { rule_id: ruleId, ...fields });
  },
  deleteAmmoAlertRule(hass: HomeAssistant, ruleId: string) {
    return callCacheService(hass, "delete_ammo_alert_rule", { rule_id: ruleId });
  },

  // -------------------------------------------------------- photos/documents
  deletePhoto(hass: HomeAssistant, photoId: string) {
    return callCacheService(hass, "delete_photo", { photo_id: photoId });
  },
  setPrimaryPhoto(hass: HomeAssistant, photoId: string) {
    return callCacheService(hass, "set_primary_photo", { photo_id: photoId });
  },
  deleteDocument(hass: HomeAssistant, documentId: string) {
    return callCacheService(hass, "delete_document", { document_id: documentId });
  },
  uploadPhoto(hass: HomeAssistant, entityType: "firearm" | "inventory_item", entityId: string, file: File) {
    return uploadFile(hass, "api/upload/photo", { entity_type: entityType, entity_id: entityId }, file);
  },
  // Batch action: re-runs every ALREADY-uploaded firearm gallery photo
  // through AI background removal (new uploads already get this - see
  // uploadPhoto above). Costs one real OpenAI call per photo and
  // overwrites the stored file - there's no undo. Omit firearmId to
  // process every firearm.
  reprocessFirearmPhotos(hass: HomeAssistant, firearmId?: string) {
    return callCacheService(hass, "reprocess_firearm_photos", firearmId ? { firearm_id: firearmId } : {});
  },
  uploadDocument(hass: HomeAssistant, firearmId: string, documentType: string, file: File) {
    return uploadFile(
      hass,
      "api/upload/document",
      { firearm_id: firearmId, document_type: documentType },
      file
    );
  },
  async scanAmmoBox(hass: HomeAssistant, file: File): Promise<ScannedAmmoFields> {
    const body = await uploadFile(hass, "api/scan_ammo_box", {}, file);
    return parseScannedAmmoFields(body);
  },
  async lookupAmmoBarcode(hass: HomeAssistant, barcode: string): Promise<ScannedAmmoFields> {
    const body = await postJson(hass, "api/lookup_ammo_barcode", { barcode });
    return parseScannedAmmoFields(body);
  },
  // AI-guessed used/resale price range from OpenAI's general knowledge,
  // not live market data - see UsedValueEstimate's own doc comment.
  // `description` is a plain text summary the caller builds from whatever
  // manufacturer/model/type/caliber/condition fields are on file; nothing
  // here persists anything server-side.
  async estimateUsedValue(hass: HomeAssistant, description: string): Promise<UsedValueEstimate> {
    const body = await postJson(hass, "api/estimate_value", { description });
    return parseUsedValueEstimate(body);
  },
};
