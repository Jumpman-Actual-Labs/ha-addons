const PALETTE = ["#f6a45b", "#a4b1bc", "#83d5ad", "#edc27e", "#c79a7a", "#a6b9b8", "#f5a0a5", "#b5b5a3"];

export function paletteColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}

export function healthScoreColor(score: number): string {
  if (score >= 80) return "#66bb6a";
  if (score >= 50) return "#ffa726";
  return "#ef5350";
}

