const PALETTE = [
  "#ef5350",
  "#42a5f5",
  "#66bb6a",
  "#ffa726",
  "#ab47bc",
  "#26a69a",
  "#ec407a",
  "#8d6e63",
  "#5c6bc0",
  "#d4e157",
  "#29b6f6",
  "#ff7043",
];

export function paletteColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}
