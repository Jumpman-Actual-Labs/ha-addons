import catalog from "./data/muscles.json";

export type MuscleId = keyof typeof catalog.muscles;
export interface ExerciseMuscles { primary: MuscleId[]; secondary: MuscleId[] }
export interface MuscleCoverage extends ExerciseMuscles { mapped: number; total: number }
export const MUSCLE_DICTIONARY = catalog.muscles;
export const MUSCLE_CATALOG_VERSION = catalog.catalogVersion;

export function musclesForExercise(id: string): ExerciseMuscles | undefined {
  const entry = (catalog.exercises as Record<string, { primary: string[]; secondary: string[] }>)[id];
  if (!entry) return undefined;
  return {
    primary: entry.primary.filter((m): m is MuscleId => m in MUSCLE_DICTIONARY),
    secondary: entry.secondary.filter((m): m is MuscleId => m in MUSCLE_DICTIONARY),
  };
}

/** Role union: a primary target anywhere takes precedence over secondary.
 * Callers pass only exercises with completed sets for a completed summary. */
export function muscleCoverage(ids: string[]): MuscleCoverage {
  const primary = new Set<MuscleId>();
  const secondary = new Set<MuscleId>();
  let mapped = 0;
  for (const id of ids) {
    const muscles = musclesForExercise(id);
    if (!muscles) continue;
    mapped++;
    muscles.primary.forEach(m => primary.add(m));
    muscles.secondary.forEach(m => secondary.add(m));
  }
  return { primary: [...primary], secondary: [...secondary].filter(m => !primary.has(m)), mapped, total: ids.length };
}

export function muscleLabels(ids: MuscleId[]): string {
  return ids.map(id => MUSCLE_DICTIONARY[id].label).join(", ");
}
