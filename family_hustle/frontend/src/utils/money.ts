const currencyFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
});

export function formatCents(cents: number | null | undefined, currency = "USD"): string {
  const value = (cents ?? 0) / 100;
  try {
    if (currency === "USD") return currencyFormatter.format(value);
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

export function signedFormatCents(cents: number | null | undefined, currency = "USD"): string {
  const formatted = formatCents(Math.abs(cents ?? 0), currency);
  if ((cents ?? 0) < 0) return `-${formatted}`;
  return formatted;
}
