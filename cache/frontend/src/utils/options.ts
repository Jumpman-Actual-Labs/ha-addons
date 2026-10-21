import { COMMON_CALIBERS } from "../types";
import type { CacheState } from "../types";

/** Manufacturer/caliber fields render as a <datalist>-backed input (browser-
 * native "combobox": suggestions dropdown + free typing still allowed,
 * since neither field is a closed enum - there's no maintaining a complete
 * list of every firearm/parts/ammo manufacturer that could ever exist). */
export function knownManufacturers(state: CacheState): string[] {
  const set = new Set<string>();
  for (const f of state.firearms) if (f.manufacturer) set.add(f.manufacturer);
  for (const i of state.inventoryItems) if (i.manufacturer) set.add(i.manufacturer);
  for (const a of state.ammunition) if (a.manufacturer) set.add(a.manufacturer);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

// Free-typed calibers collide case-insensitively more than manufacturers
// do ("12 Gauge"/"12 gauge"/"12 GAUGE" are all the same caliber someone
// typed differently at different times) - a plain Set<string> treated
// each as distinct and the dropdown filled up with near-duplicates. Dedup
// on a trimmed-lowercase key instead, keeping whichever casing was seen
// first - COMMON_CALIBERS is added before any stored data, so its
// canonical casing always wins over a user-typed variant. This only
// merges case/whitespace variants of the SAME string; a genuinely
// different spelling like "12 GA" has its own key and stays separate.
export function knownCalibers(state: CacheState): string[] {
  const byKey = new Map<string, string>();
  const add = (value: string) => {
    const key = value.trim().toLowerCase();
    if (!byKey.has(key)) byKey.set(key, value);
  };
  for (const c of COMMON_CALIBERS) add(c);
  for (const f of state.firearms) if (f.caliber) add(f.caliber);
  for (const a of state.ammunition) if (a.caliber) add(a.caliber);
  return Array.from(byKey.values()).sort((a, b) => a.localeCompare(b));
}

export function knownBulletTypes(state: CacheState): string[] {
  const set = new Set<string>();
  for (const a of state.ammunition) if (a.bulletType) set.add(a.bulletType);
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}
