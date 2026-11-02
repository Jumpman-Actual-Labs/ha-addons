/** Warm-up sets before an exercise's working sets. They're guidance shown
 * on the exercise page, not logged sets, so they never count toward PRs,
 * volume or progression. */

export interface WarmupSet {
  weight: number;
  reps: number;
}

interface Muscles {
  primary: readonly string[];
  secondary: readonly string[];
}

/** True when any of this exercise's primary muscles hasn't been worked
 * (as primary or secondary) by an earlier exercise in the workout -- e.g.
 * deadlifts first thing still need the lower back warmed up, but a second
 * chest exercise after bench press doesn't. */
export function needsWarmup(
  exerciseIds: readonly string[],
  index: number,
  musclesFor: (exerciseId: string) => Muscles | undefined,
): boolean {
  const target = musclesFor(exerciseIds[index]);
  if (!target?.primary.length) return false;
  const worked = new Set<string>();
  for (const id of exerciseIds.slice(0, index)) {
    const muscles = musclesFor(id);
    muscles?.primary.forEach((m) => worked.add(m));
    muscles?.secondary.forEach((m) => worked.add(m));
  }
  return target.primary.some((m) => !worked.has(m));
}

/** Rounds down to a load the athlete can actually make: the highest ladder
 * value at or under the target, or the nearest increment without one. */
export function snapDown(target: number, ladder: readonly number[], increment: number): number {
  const options = ladder.filter((value) => value <= target + 0.001);
  if (options.length) return Math.max(...options);
  if (ladder.length) return Math.min(...ladder);
  return Math.floor(target / increment + 1e-9) * increment;
}

/** Barbell-style work (a bar or carriage to start from) ramps from the
 * empty bar; other loaded work ramps by percentage. Steps within 90% of the
 * working weight, or that wouldn't be heavier than the step before, are
 * dropped, so a light working weight gets a short ramp or none at all. */
export function warmupSets(
  working: number | null | undefined,
  options: { start?: number; ladder?: readonly number[]; increment: number },
): WarmupSet[] {
  if (working == null || !Number.isFinite(working) || working <= 0) return [];
  const ladder = options.ladder ?? [];
  const steps = options.start != null
    ? [{ pct: 0, reps: 10 }, { pct: 0.4, reps: 5 }, { pct: 0.6, reps: 3 }, { pct: 0.8, reps: 2 }]
    : [{ pct: 0.5, reps: 8 }, { pct: 0.75, reps: 4 }];
  const sets: WarmupSet[] = [];
  for (const { pct, reps } of steps) {
    const raw = pct === 0 ? options.start! : snapDown(working * pct, ladder, options.increment);
    const weight = Math.max(options.start ?? 0, Math.round(raw * 100) / 100);
    if (weight <= 0 && options.start == null) continue;
    if (weight > working * 0.9 + 0.001) continue;
    if (sets.length && weight <= sets[sets.length - 1].weight + 0.001) continue;
    sets.push({ weight, reps });
  }
  return sets;
}
