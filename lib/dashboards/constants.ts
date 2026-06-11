// Dashboard limits (Story 6.3 · Subtask 6.3.1) — Prisma-free so the 6.3.5
// dashboard UI can consume them client-side (the lib/savedFilters/constants
// pattern).

/** Display-name cap — recorded sanity guard (the SAVED_FILTER_NAME cap's
 * sibling; Jira documents no explicit cap, a switcher row must stay
 * readable). */
export const DASHBOARD_NAME_MAX_LENGTH = 100;

/** Widgets per dashboard — the verified Jira Data Center default
 * (`jira.dashboard.gadgets.limit` = 20), adopted as our sanity bound. The
 * 21st add is a typed 422, the designed cap state in 6.3.3. */
export const DASHBOARD_MAX_WIDGETS = 20;

/** The hard bound on the dashboards list read (finding #57 — bounded, never
 * load-all; a workspace pathologically hoarding grids still ships one sane
 * page to the switcher). */
export const DASHBOARD_LIST_LIMIT = 100;

/** Filter-results widget page-size cap — the verified Jira Cloud bound on
 * filter-displaying gadgets (50 rows/page, deliberately non-raisable). The
 * 6.3.2 read enforces it server-side again. */
export const FILTER_RESULTS_PAGE_SIZE_MAX = 50;

/** Created-vs-resolved window caps (the 6.3.2 read re-enforces): at most a
 * year of days-back… */
export const CREATED_VS_RESOLVED_DAYS_BACK_MAX = 366;

/** …and at most this many buckets after period division (guards `day` ×
 * large windows — the bounded-aggregate rule). */
export const CREATED_VS_RESOLVED_BUCKETS_MAX = 120;

/** Statistic-type id cap (shape guard only — the TOTAL statistic registry
 * that deep-validates the id lands with the 6.3.2 reads). */
export const STATISTIC_TYPE_ID_MAX_LENGTH = 100;

/** Columns per layout — the `dashboard_layout` enum's numeric meaning.
 * Widget `column` indexes are 0-based and must stay below this count. */
export const LAYOUT_COLUMN_COUNT = { one: 1, two: 2, three: 3 } as const;
