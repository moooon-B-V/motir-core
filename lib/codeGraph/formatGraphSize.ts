// THE SIZE OF A CODE GRAPH, AS A PERSON READS IT (MOTIR-7132 · design/code-context
// §17.5).
//
// Binary units — B, KiB, MiB, GiB, TiB — the largest unit whose value is at least 1,
// then AT MOST ONE DECIMAL, TRUNCATED rather than rounded, and a trailing `.0`
// dropped. So the supported maximum reads "1 GiB", never "1.0 GiB", and a 1.4-GiB
// graph reads "1.4 GiB". Truncating never overstates a size: 1.96 GiB reads
// "1.9 GiB", not "2 GiB" — a refused graph must never be shown as smaller than the
// limit by rounding, nor a cap as larger.
//
// ONE formatter for both numbers on the row, so the size and the cap it is compared
// against can never disagree about their unit or their precision. The digits go
// through `Intl.NumberFormat` for the locale's decimal separator; the unit symbols
// are the same in every locale, as the design specifies for `zh`.

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

export function formatGraphSize(bytes: number, locale = 'en'): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Truncate to one decimal — but after shedding float noise at the sixth digit,
  // so a byte count that IS 1.4 GiB to every reader (1 503 238 553 = 1.39999999…)
  // reads "1.4 GiB" and not "1.3 GiB". What truncation exists to prevent is
  // overstating by a visible amount (1.96 → "2"), not a millionth of a tenth.
  const truncated = Math.trunc(Number((value * 10).toFixed(6))) / 10;
  const digits = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(truncated);
  return `${digits} ${UNITS[unit]}`;
}
