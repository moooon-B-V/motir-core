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
