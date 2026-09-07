/**
 * A Next `searchParams` bag as `URLSearchParams` entries (MOTIR-4770).
 *
 * ⚠️ A REPEATED PARAMETER ARRIVES AS AN ARRAY, and dropping the rest of it is
 * the quiet way to lose the one that mattered. Every value is emitted, in order,
 * so `new URLSearchParams(entries)` sees exactly what the address carried.
 *
 * Pure, and it takes the RESOLVED bag rather than the promise — a helper that
 * awaited for its caller would hide the one line a Server Component has to be
 * seen doing.
 */
export function searchParamsToEntries(
  params: Record<string, string | string[] | undefined>,
): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of Object.entries(params)) {
    if (typeof value === 'string') out.push([name, value]);
    else if (Array.isArray(value)) for (const v of value) out.push([name, v]);
  }
  return out;
}
