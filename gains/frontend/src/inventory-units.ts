/** Equipment catalog defaults are canonical pounds; configured values use viewer units. */
export function defaultInventoryWeight(value: number | null, units: string): number | null {
  if (value === null) return null;
  return units === "metric" ? Math.round(value / 2.2046226218 * 10000) / 10000 : value;
}
