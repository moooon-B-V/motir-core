/**
 * Quick-search bounds (Subtask 6.9.1) — bounded reads, never load-all (finding
 * #57). Kept in a PURE module (no `db` / Prisma imports) so both the server
 * service and the CLIENT link pickers (6.9.2 — which gate the per-keystroke
 * fetch on the minimum length) can import them without pulling the service into
 * the browser bundle. `workItemsService` re-exports these so existing importers
 * (and tests) keep their `@/lib/services/workItemsService` source.
 */

/** The default result window — serves the cmd-K palette. */
export const QUICK_SEARCH_DEFAULT_LIMIT = 20;

/** Hard ceiling — a caller (6.9.2's link picker) may ask for more, never beyond this. */
export const QUICK_SEARCH_MAX_LIMIT = 50;

/**
 * Shortest query the quick-search runs — below this it returns `[]` with no DB
 * round-trip. A 1-char title `ILIKE '%x%'` can't use the `pg_trgm` GIN index (a
 * trigram needs ≥3 chars), so a sub-2-char search would only ever be a noisy
 * seq-scan; the guard keeps the read index-friendly and cheap. The client
 * pickers gate their per-keystroke fetch on the same minimum.
 */
export const QUICK_SEARCH_MIN_QUERY_LENGTH = 2;

/**
 * The work-item NUMBER a quick-search query names, or `null` when it names none
 * (Subtask MOTIR-6896). People refer to work by its number — "plan 6010" — and
 * a bare number is a prefix of no identifier (`MOTIR-6010`), so the identifier
 * arm alone never finds it.
 *
 * A query names a number when, trimmed and with ONE leading `#` stripped, it is
 * digits only: `6010` and `#6010` do, `6010 plan` (a title query), `1; drop`
 * and `##6010` do not. The digits must themselves clear
 * {@link QUICK_SEARCH_MIN_QUERY_LENGTH}, so `#6` names no number exactly as `6`
 * alone does — the raw query still decides whether the search runs at all.
 *
 * The result is an integer parsed only after the digits-only match, and it
 * reaches SQL as a bound parameter — never interpolated. `null` above the
 * integer column's range too, because no key can be that number.
 */
export function quickSearchNumber(query: string): number | null {
  const trimmed = query.trim();
  const digits = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (!/^\d+$/.test(digits) || digits.length < QUICK_SEARCH_MIN_QUERY_LENGTH) return null;
  const n = Number(digits);
  return n <= 2_147_483_647 ? n : null;
}
