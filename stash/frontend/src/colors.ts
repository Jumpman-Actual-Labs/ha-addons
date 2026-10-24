// Category colors for the Midnight Cobalt themes in finance-panel.ts -
// saturated enough to stay distinct on both the dark and light surfaces.
const PALETTE = [
  "#3b82f6", "#2dd4bf", "#a78bfa", "#f59e0b", "#f472b6", "#22d3ee",
  "#84cc16", "#fb7185", "#818cf8", "#fbbf24", "#34d399", "#c084fc",
];

export function paletteColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}
