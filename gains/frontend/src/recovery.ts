/** Validate backend estimates; absent/invalid data stays unavailable. */
export interface MuscleRecovery {
  calculatedAt: string;
  halfLifeHours: number;
  muscles: Record<string, number>;
}
export function parseMuscleRecovery(raw: unknown): MuscleRecovery | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (value.model_version !== 1 || typeof value.calculated_at !== "string" ||
      !Number.isFinite(Date.parse(value.calculated_at)) ||
      typeof value.half_life_hours !== "number" || value.half_life_hours <= 0 ||
      !Number.isFinite(value.half_life_hours) || !value.muscles || typeof value.muscles !== "object") return undefined;
  const muscles: Record<string, number> = {};
  for (const [id, entry] of Object.entries(value.muscles)) {
    const percent = (entry as { recovery_percent?: unknown } | null)?.recovery_percent;
    if (typeof percent === "number" && Number.isFinite(percent) && percent >= 0 && percent <= 100) muscles[id] = percent;
  }
  return { calculatedAt: value.calculated_at, halfLifeHours: value.half_life_hours, muscles };
}
/** Continue recovery between backend refreshes, with the same decay rule. */
export function recoveryPercent(state: MuscleRecovery | undefined, muscle: string, now = Date.now()): number | undefined {
  const value = state?.muscles[muscle];
  if (!state || value === undefined) return undefined;
  const hours = Math.max(0, (now - Date.parse(state.calculatedAt)) / 3600000);
  const fatigue = (100 - value) * 2 ** (-hours / state.halfLifeHours);
  return Math.round(fatigue < 0.5 ? 100 : 100 - fatigue);
}
