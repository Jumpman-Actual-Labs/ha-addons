const PALETTE = [
  "#297c70", "#597eaa", "#9b83ae", "#b59762", "#6c9a96", "#617383",
  "#a97078", "#7e9870", "#8b93b8", "#bd937f", "#438c9b", "#908275",
];

export function paletteColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}
