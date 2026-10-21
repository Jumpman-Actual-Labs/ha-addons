// TS mirror of custom_components/cache/const.py's constant lists and
// sensor.py's attribute shapes. Keep in sync by hand - see CLAUDE.md.

export const FIREARM_TYPES: string[] = [
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
];

// Baseline suggestions for the caliber dropdown - not an enforced enum, just
// a starting point. Any caliber already used in the collection is merged in
// too (see utils/options.ts), so entering something not on this list works
// fine and gets remembered as a suggestion from then on.
export const COMMON_CALIBERS: string[] = [
  // Handgun
  ".22 LR", ".25 ACP", ".32 ACP", ".380 ACP", "9mm", ".38 Special", ".357 Magnum",
  ".357 SIG", ".40 S&W", "10mm Auto", ".44 Magnum", ".44 Special", ".45 ACP", ".45 Colt", ".50 AE",
  // Rifle
  ".17 HMR", ".22-250 Rem", ".223 Remington", "5.56 NATO", "300 BLK", "6.5 Grendel",
  "6.5 Creedmoor", "6.8 SPC", "7.62x39mm", ".243 Winchester", ".270 Winchester",
  "7mm-08 Remington", "7mm Remington Magnum", ".308 Winchester", "7.62 NATO",
  "30-06 Springfield", ".300 Winchester Magnum", ".300 PRC", ".338 Lapua Magnum",
  ".450 Bushmaster", ".50 BMG",
  // Shotgun
  ".410 Bore", "28 Gauge", "20 Gauge", "16 Gauge", "12 Gauge", "10 Gauge",
];

export const FIREARM_USES: string[] = ["Training", "Home Defense", "Hunting", "Collectible"];

export const WISHLIST_PRIORITIES: string[] = ["High", "Medium", "Low"];

export const CONDITIONS: string[] = [
  "New",
  "Excellent",
  "Good",
  "Fair",
  "Poor",
  "Parts/Non-Functional",
];

// Every firearm's My Build screen shows the identical set of installable
// slots now - no more per-diagram-type slot lists (the old DIAGRAM_SLOTS).
// Each Part (the specific, installable thing, e.g. "Optic Mount" - what
// used to be the entirety of InventoryItem.category before this taxonomy)
// belongs to exactly one Category (a coarser grouping, e.g. "Optic" - used
// to narrow the add/edit form's Part dropdown once a Category is picked).
// Both are real stored fields - see InventoryItem.category/partType below.
// Mirrors the backend's const.py PART_TAXONOMY exactly.
export const PART_TAXONOMY: Record<string, string[]> = {
  Optic: ["Optic", "Optic Mount"],
  Muzzle: ["Muzzle Device", "Suppressor"],
  Barrel: ["Barrel"],
  Underbarrel: ["Foregrip", "Bipod"],
  "Light & Laser": ["Light", "Laser"],
  Stock: ["Stock", "Brace"],
  "Rear Grip": ["Grip"],
  "Fire Control": ["Trigger", "Safety"],
  Action: ["Bolt", "Charging Handle"],
  Accessory: ["Handguard", "Other / Miscellaneous"],
};

// The 10 Categories - InventoryItem.category's allowed values.
export const INVENTORY_CATEGORIES: string[] = Object.keys(PART_TAXONOMY);

// The 18 Parts, flattened - InventoryItem.partType's allowed values, and
// also literally the universal list of My Build slots (every entry here
// is installable, unlike the old system's BUILD_SLOT_CATEGORIES subset).
export const PART_TYPES: string[] = Object.values(PART_TAXONOMY).flat();

// Reverse lookup (Part -> its Category) - e.g. slot-modal.ts's "Add New"
// flow only knows the Part it's adding (the slot it was opened for), and
// needs the matching Category to send both required fields to
// addInventoryItem.
export const CATEGORY_FOR_PART: Record<string, string> = Object.fromEntries(
  Object.entries(PART_TAXONOMY).flatMap(([category, parts]) =>
    parts.map((part) => [part, category])
  )
);

export const DOCUMENT_TYPES: string[] = [
  "Manual",
  "Receipt",
  "Warranty Information",
  "Tax Stamp",
  "Other",
];

export interface Photo {
  id: string;
  filename: string;
  originalFilename: string | null;
  isPrimary: boolean;
  uploadedAt: string;
  url: string;
}

export interface DocumentEntry {
  id: string;
  filename: string;
  originalFilename: string | null;
  documentType: string;
  uploadedAt: string;
  url: string;
}

export interface CleaningLogEntry {
  id: string;
  cleanedDate: string;
  roundCountAtCleaning: number;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface InstalledItemSummary {
  id: string;
  customName: string;
  category: string;
  partType: string | null;
  manufacturer: string | null;
  model: string | null;
  installedSlotType: string | null;
  // The item's own first gallery photo (Manage Photos on the part itself,
  // not the firearm) - shown as the attachment card's art when present.
  photoUrl: string | null;
  // A wishlist item installed to preview a build has no physical location
  // to return to on removal - slot-modal.ts uses this to make that
  // dialog's storage location optional rather than required.
  isWishlist: boolean;
}

export interface Firearm {
  entityId: string;
  id: string;
  customName: string;
  firearmType: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  caliber: string | null;
  barrelLength: string | null;
  overallLength: string | null;
  weight: string | null;
  twistRate: string | null;
  capacity: string | null;
  finish: string | null;
  color: string | null;
  condition: string | null;
  purchaseDate: string | null;
  purchasePrice: number | null;
  currentEstimatedValue: number | null;
  effectiveEstimatedValue: number | null;
  purchasedFrom: string | null;
  warrantyExpiration: string | null;
  warrantyNotes: string | null;
  // A link to buy/reference this firearm - most useful while it's still on
  // the wishlist, but not restricted to wishlist entries.
  productUrl: string | null;
  uses: string[];
  storageLocationId: string | null;
  storageLocationName: string | null;
  lifetimeRoundCount: number;
  lastFiredDate: string | null;
  lastCleaningDate: string | null;
  roundCountAtLastCleaning: number;
  notes: string | null;
  primaryPhotoId: string | null;
  diagramType: string;
  needsCleaning: boolean;
  // A wishlist firearm is a normal Firearm record, just flagged - see
  // the repo's CLAUDE.md. wishlistRank (not wishlistPriority -
  // InventoryItem still has that) is the firearm's position in the
  // user's drag-and-drop wishlist order (0 = wanted most), only
  // meaningful while isWishlist is true. Coordinator-managed - auto-
  // assigned on wishlisting, cleared on un-wishlisting, only ever bulk-
  // reassigned via cacheApi.reorderWishlistFirearms.
  isWishlist: boolean;
  wishlistRank: number | null;
  installedItems: InstalledItemSummary[];
  photos: Photo[];
  documents: DocumentEntry[];
  cleaningHistory: CleaningLogEntry[];
  createdAt: string;
  updatedAt: string;
  createdBy: string | null;
}

export interface InventoryItem {
  entityId: string;
  id: string;
  customName: string;
  category: string;
  partType: string | null;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  purchaseDate: string | null;
  purchasePrice: number | null;
  estimatedValue: number | null;
  condition: string | null;
  notes: string | null;
  storageLocationId: string | null;
  installedFirearmId: string | null;
  installedFirearmName: string | null;
  installedSlotType: string | null;
  installedAt: string | null;
  effectiveLocationName: string | null;
  isWishlist: boolean;
  wishlistPriority: string | null;
  // Same idea as Firearm.productUrl - a link to buy/reference this part.
  productUrl: string | null;
  photos: Photo[];
  createdAt: string;
  updatedAt: string;
}

export interface AmmoTransaction {
  id: string;
  changeType: string;
  quantityDelta: number;
  resultingQuantity: number;
  note: string | null;
  rangeSessionId: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface Ammunition {
  entityId: string;
  id: string;
  caliber: string;
  manufacturer: string | null;
  productName: string | null;
  bulletWeight: string | null;
  bulletType: string | null;
  muzzleVelocity: string | null;
  speedClass: "Subsonic" | "Supersonic" | null;
  quantity: number;
  costPerBox: number | null;
  roundsPerBox: number | null;
  costPerRound: number | null;
  purchaseDate: string | null;
  storageLocationId: string | null;
  storageLocationName: string | null;
  notes: string | null;
  lowInventoryThreshold: number | null;
  isLow: boolean;
  transactions: AmmoTransaction[];
  createdAt: string;
  updatedAt: string;
}

/** What cacheApi.scanAmmoBox() returns - OpenAI's best-effort reading of a
 * photographed ammo box (see the backend's openai_client.py). Any
 * field it couldn't read comes back null; the caller prefills the Add
 * Ammunition form with whatever's non-null and leaves the rest for the
 * user to fill in or correct. */
export interface ScannedAmmoFields {
  caliber: string | null;
  manufacturer: string | null;
  productName: string | null;
  bulletWeight: string | null;
  bulletType: string | null;
  muzzleVelocity: string | null;
  roundsPerBox: number | null;
}

/** cacheApi.estimateUsedValue()'s result - an AI-GUESSED used/resale price
 * range from OpenAI's general training knowledge, NOT live market data
 * (this app has no web-browsing capability anywhere). Both prices are null
 * when the model doesn't recognize the item or can't estimate responsibly,
 * same "don't guess" convention as ScannedAmmoFields - never auto-applied
 * to currentEstimatedValue/estimatedValue, only shown for the user to
 * review and explicitly apply. */
export interface UsedValueEstimate {
  estimatedLow: number | null;
  estimatedHigh: number | null;
  confidence: string | null;
}

export interface RangeSessionFirearmEntry {
  firearmId: string;
  firearmName: string | null;
  ammunitionId: string | null;
  ammunitionLabel: string | null;
  roundsFired: number;
}

export interface RangeSession {
  id: string;
  date: string;
  location: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
  totalRounds: number;
  firearms: RangeSessionFirearmEntry[];
}

export interface StorageLocation {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  firearmCount: number;
  itemCount: number;
}

export const RANGE_SCHEDULE_TARGET_TYPES: string[] = ["firearm", "firearm_type", "caliber"];

export const RANGE_SCHEDULE_FREQUENCIES: string[] = [
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "semi_annually",
  "annually",
];

export const RANGE_SCHEDULE_FREQUENCY_LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  quarterly: "Quarterly",
  semi_annually: "Every 6 months",
  annually: "Annually",
};

export interface RangeScheduleTarget {
  targetType: "firearm" | "firearm_type" | "caliber";
  firearmId: string | null;
  firearmType: string | null;
  caliber: string | null;
  speedClass: "Subsonic" | "Supersonic" | null;
  bulletType: string | null;
  roundsMin: number | null;
}

export interface RangeSchedule {
  id: string;
  label: string | null;
  targets: RangeScheduleTarget[];
  frequency: string;
  ammoAlertEnabled: boolean;
  active: boolean;
  lastCompletedDate: string | null;
  nextDueDate: string | null;
  isDue: boolean;
  ammoOk: boolean | null;
  matchingFirearmNames: string[];
  matchingCalibers: string[];
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  collectionName: string;
  lowAmmoThresholdDefault: number;
  cleaningReminderRounds: number;
  cleaningReminderDays: number;
  cleaningNotificationsEnabled: boolean;
  lowAmmoNotificationsEnabled: boolean;
  // Per diagram_type, a fallback hero image (see utils/hero-image.ts)
  // used by any firearm of that type with no gallery photo of its own.
  diagramReferenceImages: Record<string, string>;
}

export const DIAGRAM_TYPE_LABELS: Record<string, string> = {
  ar_platform: "AR Platform",
  ar_pistol: "AR Pistol",
  bolt_action: "Bolt Action",
  handgun: "Handgun",
  revolver: "Revolver",
  shotgun: "Shotgun",
};

export interface DashboardStats {
  totalFirearms: number;
  handguns: number;
  rifles: number;
  shotguns: number;
  nfaItems: number;
  totalCollectionValue: number;
  totalAmmunition: number;
  averageRoundCount: number;
  byManufacturer: Record<string, number>;
  byType: Record<string, number>;
  byCaliber: Record<string, number>;
  ammunitionByCaliber: Record<string, number>;
  recentlyAddedIds: string[];
  recentlyFiredIds: string[];
  needingCleaningIds: string[];
  mostUsedIds: string[];
  wishlistFirearmsCount: number;
  wishlistItemsCount: number;
  wishlistNfaItems: number;
  wishlistTotalValue: number;
  topWishlistItemName: string | null;
  topWishlistItemPriority: string | null;
}

export const TRAINING_PLAN_MODES: string[] = ["calendar", "sequential"];

export const TRAINING_PLAN_MODE_LABELS: Record<string, string> = {
  calendar: "Locked to calendar months",
  sequential: "Sequential, self-paced",
};

export const MONTH_LABELS: string[] = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export interface TrainingPlanStep {
  id: string;
  label: string;
  targets: RangeScheduleTarget[];
  notes: string | null;
  lastCompletedDate: string | null;
  isCurrent: boolean;
  matchingFirearmNames: string[];
  matchingCalibers: string[];
}

export interface TrainingPlan {
  id: string;
  label: string | null;
  mode: "calendar" | "sequential";
  startMonth: number | null;
  startYear: number | null;
  currentStepIndex: number | null;
  active: boolean;
  ammoAlertEnabled: boolean;
  isDue: boolean;
  ammoOk: boolean | null;
  notes: string | null;
  steps: TrainingPlanStep[];
  createdAt: string;
  updatedAt: string;
}

export const AMMO_ALERT_RULE_MATCH_TYPES: string[] = ["caliber", "bullet_type", "speed_class"];

export const AMMO_ALERT_RULE_MATCH_TYPE_LABELS: Record<string, string> = {
  caliber: "Caliber",
  bullet_type: "Bullet type",
  speed_class: "Velocity (subsonic/supersonic)",
};

export interface AmmoAlertRule {
  id: string;
  matchType: "caliber" | "bullet_type" | "speed_class";
  matchValue: string;
  threshold: number;
  createdAt: string;
}

export interface CacheState {
  settings: Settings | null;
  storageLocations: StorageLocation[];
  dashboardStats: DashboardStats | null;
  rangeSessions: RangeSession[];
  rangeSchedules: RangeSchedule[];
  trainingPlans: TrainingPlan[];
  ammoAlertRules: AmmoAlertRule[];
  cleaningDueCount: number;
  lowAmmoCount: number;
  trainingDueCount: number;
  trainingAmmoAlertCount: number;
  firearms: Firearm[];
  inventoryItems: InventoryItem[];
  ammunition: Ammunition[];
}
