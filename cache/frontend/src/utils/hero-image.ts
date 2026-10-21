import type { CacheState, Firearm } from "../types";

/** The one hero-photo fallback chain every view that needs to feature a
 * firearm's photo shares: its regular gallery's primary photo, else a
 * per-type placeholder managed from Settings' "Default Firearm Photos"
 * card. There's no separate dedicated hero/build-image field - a
 * firearm's hero photo IS its gallery's primary photo (see "Set as
 * primary" in photo-manager-section.ts), on purpose: a firearm used to
 * have both, but every gallery photo already runs through background
 * removal on upload (see the repo's CLAUDE.md), so a second
 * dedicated upload wasn't buying a different result, just a second thing
 * to keep in sync. Returns null only when neither applies - callers fall
 * back to their own empty-state treatment (icon placeholder, hidden
 * section, etc.) in that case. */
export function firearmHeroImage(cacheState: CacheState, f: Firearm): string | null {
  const primary = f.photos.find((p) => p.id === f.primaryPhotoId) ?? f.photos[0];
  return primary?.url ?? cacheState.settings?.diagramReferenceImages[f.diagramType] ?? null;
}
