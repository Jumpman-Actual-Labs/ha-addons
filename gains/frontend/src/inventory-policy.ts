import type { ExerciseDef, WorkoutExercise } from "./types";

export interface ExerciseAvailability {
  feasible: boolean;
  selectable?: boolean;
  reasons: string[];
  loads: number[];
  bars?: Record<string, number[]>;
}
export type InventoryPolicy = Record<string, ExerciseAvailability>;

export function parseInventoryPolicy(raw: unknown): InventoryPolicy {
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(Object.entries(raw).map(([id, value]) => {
    const v = value as Partial<ExerciseAvailability> | null;
    return [id, {
      feasible: v?.feasible === true,
      selectable: v?.selectable === true || v?.feasible === true,
      reasons: Array.isArray(v?.reasons) ? v.reasons.filter((s): s is string => typeof s === "string") : ["Inventory unverified"],
      loads: Array.isArray(v?.loads) ? v.loads.filter(n => typeof n === "number" && Number.isFinite(n)).sort((a,b) => a-b) : [],
      bars: v?.bars,
    }];
  }));
}

export function snapLoad(target: number | null, ladder: number[], lower = false): number | null {
  if (target === null || !ladder.length) return null;
  const choices = ladder.filter(v => lower ? v < target - 0.001 : v <= target + 0.001);
  return choices.length ? Math.max(...choices) : lower ? null : Math.min(...ladder);
}

export function nextSetSuggestion(exercise: WorkoutExercise, index: number, policy?: ExerciseAvailability) {
  const set = exercise.sets[index];
  if (set.manualWeight) return { reps: set.plannedReps, weight: set.plannedWeight };
  if (!policy?.feasible) return { reps: set.plannedReps, weight: null };
  const previous = index > 0 ? exercise.sets[index - 1] : undefined;
  const ladder = exercise.selectedBarEquipmentId && exercise.selectedBarWeight != null
    ? policy?.bars?.[`${exercise.selectedBarEquipmentId}:${exercise.selectedBarWeight}`] ?? []
    : policy?.loads ?? [];
  const staticWeight = snapLoad(set.plannedWeight ?? ladder[0] ?? null, ladder);
  if (!previous?.completed || previous.actualReps == null || previous.actualWeight == null) {
    return { reps: set.plannedReps, weight: staticWeight };
  }
  const missed = previous.actualReps < (previous.plannedReps ?? previous.actualReps);
  const held = ladder.find(v => Math.abs(v - previous.actualWeight!) < 0.001) ?? null;
  return { reps: previous.actualReps, weight: missed
    ? snapLoad(previous.actualWeight, ladder, true) ?? held
    : snapLoad(previous.actualWeight, ladder) };
}

export interface LibraryFilters {
  search: string; muscle: string; equipment: string; movement: string;
  sort?: "recommended" | "name";
  mode: "recommended" | "all"; showUnavailable: boolean;
}

export function replacementLibrary(library: ExerciseDef[], current: ExerciseDef | undefined,
  policy: InventoryPolicy, filters: LibraryFilters) {
  const primary = current?.muscles?.primary ?? [];
  return library.filter(e => e.id !== current?.id)
    .map(e => ({ exercise: e, availability: policy[e.id] ?? { feasible: false,
      reasons: ["Inventory unverified; update Gains integration"], loads: [] },
      score: (e.muscles?.primary ?? []).filter(m => primary.includes(m)).length * 10
        + (e.category === current?.category ? 3 : 0) + (e.equipment === current?.equipment ? 1 : 0) }))
    .filter(({exercise: e, availability: a, score}) =>
      (filters.showUnavailable || a.selectable || a.feasible) &&
      (!filters.search || `${e.name} ${e.id}`.toLowerCase().includes(filters.search.trim().toLowerCase())) &&
      (!filters.muscle || [...(e.muscles?.primary ?? []), ...(e.muscles?.secondary ?? [])].includes(filters.muscle as never)) &&
      (!filters.equipment || e.equipment === filters.equipment) &&
      (!filters.movement || e.category === filters.movement) &&
      (filters.mode === "all" || score >= 3))
    .sort((a,b) => Number(b.availability.feasible)-Number(a.availability.feasible) ||
      (filters.sort === "name" ? 0 : b.score-a.score) || a.exercise.name.localeCompare(b.exercise.name));
}


/** Counts match the gym editor: each entry is one matched pair of plates. */
export function buildPlateLoadout(totalWeight: number, barWeight: number,
  inventory: { weight: number; count: number }[]) {
  const perSide = Math.max(0, (totalWeight - barWeight) / 2);
  const empty = { perSide, counts: [] as {plate:number;count:number}[], remainder: perSide,
    exact: false, belowBar: totalWeight + 0.01 < barWeight };
  if (!Number.isFinite(totalWeight) || totalWeight <= 0 || empty.belowBar) return empty;
  const scale = 10000;
  const target = Math.round(perSide * scale);
  let totals = new Map<number, {plate:number;count:number}[]>([[0,[]]]);
  for (const item of [...inventory].sort((a,b) => b.weight-a.weight)) {
    if (!Number.isFinite(item.weight) || item.weight <= 0 || !Number.isFinite(item.count)) continue;
    const next = new Map(totals);
    const weight = Math.round(item.weight * scale);
    for (const [total, combination] of totals) {
      for (let count = 1; count <= Math.floor(item.count) && total + count * weight <= target + 10; count++) {
        const candidate = [...combination, {plate:item.weight,count}];
        const previous = next.get(total + count * weight);
        const pieces = candidate.reduce((n,p) => n+p.count,0);
        const previousPieces = previous?.reduce((n,p) => n+p.count,0) ?? Infinity;
        if (!previous || pieces < previousPieces || (pieces === previousPieces &&
            Math.max(...candidate.map(p => p.plate)) > Math.max(...previous.map(p => p.plate)))) {
          next.set(total + count * weight, candidate);
        }
      }
    }
    if (next.size > 20000) return empty;
    totals = next;
  }
  const best = Math.max(...totals.keys());
  return { perSide, counts: (totals.get(best) ?? []).sort((a,b) => b.plate-a.plate), remainder: Math.max(0,(target-best)/scale),
    exact: Math.abs(target-best) <= 10, belowBar: false };
}

