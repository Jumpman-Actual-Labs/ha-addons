/* Ingredient amounts, for scaling a recipe while cooking.
 *
 * An ingredient line is free text ("2 lbs Ground Chuck", "1/2 Cup Panko",
 * "1 1/2 tsp salt", "2-3 cloves garlic", "½ onion"). parseAmount finds the
 * number it starts with; scaleLine rewrites that number for a scale factor
 * and leaves everything else - lines without a leading number ("Salt to
 * taste") come back unchanged. Amounts are shown the way a cook writes
 * them: whole numbers, or a whole plus a common fraction (1/8 steps, plus
 * thirds), never 1.3333.
 */

const UNICODE_FRACTIONS: Record<string, number> = {
  "¼": 1 / 4,
  "½": 1 / 2,
  "¾": 3 / 4,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "⅛": 1 / 8,
  "⅜": 3 / 8,
  "⅝": 5 / 8,
  "⅞": 7 / 8,
};

const FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join("");

// One number: "1 1/2", "1½", "1/2", "1.5", "2", "½".
const NUMBER = `(?:\\d+\\s+\\d+\\/\\d+|\\d+\\s*[${FRACTION_CHARS}]|\\d+\\/\\d+|\\d+(?:\\.\\d+)?|\\.\\d+|[${FRACTION_CHARS}])`;
// Optionally a range: "2-3", "2 to 3".
const LEADING = new RegExp(`^(\\s*)(${NUMBER})(?:(\\s*(?:-|–|to)\\s*)(${NUMBER}))?`, "i");

export interface Amount {
  /** The (first) number, e.g. 2 for "2-3 cloves". */
  value: number;
  /** The second number of a range, if any. */
  to: number | null;
  /** Leading whitespace, the separator of a range, and the rest of the line. */
  lead: string;
  sep: string;
  rest: string;
}

export function parseNumber(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  let m = t.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = t.match(new RegExp(`^(\\d+)\\s*([${FRACTION_CHARS}])$`));
  if (m) return Number(m[1]) + UNICODE_FRACTIONS[m[2]];
  m = t.match(/^(\d+)\/(\d+)$/);
  if (m) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : null;
  if (t in UNICODE_FRACTIONS) return UNICODE_FRACTIONS[t];
  const n = Number(t);
  return Number.isFinite(n) && /^(\d+(\.\d+)?|\.\d+)$/.test(t) ? n : null;
}

export function parseAmount(line: string): Amount | null {
  const m = line.match(LEADING);
  if (!m) return null;
  const value = parseNumber(m[2]);
  if (value === null || value <= 0) return null;
  const to = m[4] ? parseNumber(m[4]) : null;
  return { value, to, lead: m[1], sep: m[3] ?? "", rest: line.slice(m[0].length) };
}

/** 1.5 -> "1 1/2", 0.333 -> "1/3", 12.25 -> "12 1/4", 37.4 -> "37". */
export function formatAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 20) return String(Math.round(value));
  const whole = Math.floor(value);
  const part = value - whole;
  // Nearest kitchen fraction: eighths, or thirds when they're closer.
  const candidates: Array<[number, string]> = [
    [0, ""],
    [1 / 8, "1/8"],
    [1 / 4, "1/4"],
    [1 / 3, "1/3"],
    [3 / 8, "3/8"],
    [1 / 2, "1/2"],
    [5 / 8, "5/8"],
    [2 / 3, "2/3"],
    [3 / 4, "3/4"],
    [7 / 8, "7/8"],
    [1, ""],
  ];
  let best = candidates[0];
  for (const c of candidates) if (Math.abs(part - c[0]) < Math.abs(part - best[0])) best = c;
  const w = best[0] === 1 ? whole + 1 : whole;
  if (!best[1]) return String(w || (value > 0 ? "1/8" : "0"));
  return w ? `${w} ${best[1]}` : best[1];
}

/** The line with its amount multiplied by `factor` (unchanged when it has
 * no leading amount, or the factor is 1). */
export function scaleLine(line: string, factor: number): string {
  if (factor === 1) return line;
  const a = parseAmount(line);
  if (!a) return line;
  const first = formatAmount(a.value * factor);
  const second = a.to !== null ? `${a.sep}${formatAmount(a.to * factor)}` : "";
  return `${a.lead}${first}${second}${a.rest}`;
}
