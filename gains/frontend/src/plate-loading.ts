import { buildPlateLoadout } from "./inventory-policy";
import type { EquipmentConfig } from "./types";

/** How plates go onto an exercise's load:
 * - "barbell": both sleeves, always mirrored.
 * - "landmine": the bar's one free sleeve (the other end is anchored); the
 *   bar still counts toward the total, matching the backend's load ladder.
 * - "pulley": a plate-loaded cable station's loading pin(s) plus its base
 *   (carriage) weight. With two pulleys each side can differ, though even
 *   is the default. */
export type LoadingKind = "barbell" | "landmine" | "pulley";

export interface PlateInventoryItem {
  weight: number;
  /** Pairs, as the gym editor stores them. */
  count: number;
}

/** Plates on each loading point, heaviest (innermost) first. */
export type PointLoads = number[][];

/** Same rule as the backend's load_policy.load_ladder. */
export function isSingleSleeve(exerciseId: string): boolean {
  return exerciseId.includes("landmine") || exerciseId === "meadows_row";
}

const CABLE_STATIONS = ["crossover_cable", "cable_tower", "hi_lo_pull_cable"];

/** Candidate stations for a cable exercise, as in the backend's
 * exercise_eligibility.requirements. */
function cableStations(exerciseId: string, requiredEquipmentId?: string | null): string[] {
  if (requiredEquipmentId) return [requiredEquipmentId];
  if (exerciseId.includes("pulldown")) return ["lat_pulldown_cable", ...CABLE_STATIONS];
  if (exerciseId === "cable_row") return ["row_cable", ...CABLE_STATIONS];
  return CABLE_STATIONS;
}

export interface PulleyStation {
  equipmentId: string;
  baseWeight: number;
  loadingPoints: 1 | 2;
}

/** The plate-loaded station a cable exercise uses at this gym, or null when
 * it only has selectorized stacks (no plates to load). */
export function plateLoadedStation(
  exerciseId: string,
  requiredEquipmentId: string | null | undefined,
  equipment: Record<string, unknown[]>,
  config: Record<string, EquipmentConfig>,
): PulleyStation | null {
  for (const equipmentId of [...cableStations(exerciseId, requiredEquipmentId)].sort()) {
    const station = config[equipmentId];
    if (!equipment[equipmentId]?.length || station?.loadType !== "plate_loaded") continue;
    const points = station.loadingPoints;
    const base = station.baseWeight;
    if ((points === 1 || points === 2) && typeof base === "number" && Number.isFinite(base) && base >= 0) {
      return { equipmentId, baseWeight: base, loadingPoints: points };
    }
  }
  return null;
}

export function loadTotal(base: number, points: PointLoads): number {
  return Math.round((base + points.flat().reduce((sum, plate) => sum + plate, 0)) * 100) / 100;
}

/** Even plates for a target total: the same plates on every loading point. */
export function planLoad(total: number, base: number, inventory: PlateInventoryItem[], loadingPoints: number) {
  const loadout = buildPlateLoadout(total, base, inventory, loadingPoints);
  const plates = loadout.counts.flatMap(({ plate, count }) => Array.from({ length: count }, () => plate));
  return { ...loadout, points: Array.from({ length: loadingPoints }, () => [...plates]) as PointLoads };
}

/** Single plates still free, per weight (each inventory entry is a pair). */
export function remainingPlates(inventory: PlateInventoryItem[], points: PointLoads): Map<number, number> {
  const left = new Map(inventory.map(({ weight, count }) => [weight, Math.floor(count) * 2]));
  for (const plate of points.flat()) left.set(plate, (left.get(plate) ?? 0) - 1);
  return left;
}

const heaviestFirst = (plates: number[]) => [...plates].sort((a, b) => b - a);

/** Adds one plate to each targeted point; a barbell always targets both
 * sleeves so it stays balanced. Returns null when there aren't enough. */
export function addPlate(
  kind: LoadingKind, inventory: PlateInventoryItem[], points: PointLoads, weight: number, target: "all" | number,
): PointLoads | null {
  const targets = kind === "barbell" || target === "all" ? points.map((_, i) => i) : [target];
  if ((remainingPlates(inventory, points).get(weight) ?? 0) < targets.length) return null;
  return points.map((plates, i) => targets.includes(i) ? heaviestFirst([...plates, weight]) : plates);
}

/** Removes one plate of that weight from a point (from every sleeve for a
 * barbell). */
export function removePlate(kind: LoadingKind, points: PointLoads, weight: number, target: number): PointLoads {
  const targets = kind === "barbell" ? points.map((_, i) => i) : [target];
  return points.map((plates, i) => {
    if (!targets.includes(i)) return plates;
    const index = plates.indexOf(weight);
    return index < 0 ? plates : plates.filter((_, j) => j !== index);
  });
}

/** "2 × 45, 10" style summary for one point. */
export function groupPlates(plates: number[]): { plate: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const plate of plates) counts.set(plate, (counts.get(plate) ?? 0) + 1);
  return [...counts.entries()].map(([plate, count]) => ({ plate, count })).sort((a, b) => b.plate - a.plate);
}
