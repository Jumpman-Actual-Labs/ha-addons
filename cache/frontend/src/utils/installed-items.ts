import type { CacheState, InstalledItemSummary } from "../types";

/** Builds a slot-type-keyed map of what's installed on one firearm, read
 * fresh from the live `cacheState.inventoryItems` list rather than
 * `Firearm.installedItems` (a lightweight backend summary with no photo
 * data) - this is what lets attachment cards show each part's own photo.
 * Used by firearms-view.ts's inline "Installed Parts" section (and
 * slot-modal.ts) to render each attachment card's contents.
 *
 * A slot_type isn't exclusive on the backend - any number of items can
 * share the same slot_type on the same firearm (e.g. two Optics) - so
 * each key maps to an ARRAY, not a single item. A key is only ever absent
 * or a non-empty array, never present-but-empty. */
export function installedBySlot(
  cacheState: CacheState,
  firearmId: string
): Record<string, InstalledItemSummary[]> {
  const out: Record<string, InstalledItemSummary[]> = {};
  for (const item of cacheState.inventoryItems) {
    if (item.installedFirearmId === firearmId && item.installedSlotType) {
      const summary: InstalledItemSummary = {
        id: item.id,
        customName: item.customName,
        category: item.category,
        partType: item.partType,
        manufacturer: item.manufacturer,
        model: item.model,
        installedSlotType: item.installedSlotType,
        photoUrl: item.photos[0]?.url ?? null,
        isWishlist: item.isWishlist,
      };
      (out[item.installedSlotType] ??= []).push(summary);
    }
  }
  return out;
}
