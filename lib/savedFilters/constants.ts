// Saved-filter limits (Story 6.2 · Subtask 6.2.1) — Prisma-free so the 6.2.3
// save dialog can consume them client-side (the lib/labels/constants pattern).

/** Display-name cap — recorded sanity guard (Jira documents no explicit cap;
 * a dropdown row must stay readable). */
export const SAVED_FILTER_NAME_MAX_LENGTH = 100;

/** Description cap — recorded sanity guard. */
export const SAVED_FILTER_DESCRIPTION_MAX_LENGTH = 500;

/** Default page size for the directory / dropdown list reads (finding #57 —
 * bounded, never load-all; the backlog page-unit precedent). */
export const SAVED_FILTER_PAGE_SIZE = 50;

/** The hard `limit` clamp on list reads. */
export const SAVED_FILTER_PAGE_MAX = 100;

/** The id prefix that routes a read to a built-in (non-persisted) filter —
 * `builtin:` ids ride the same list/resolve reads as rows but reject every
 * write (the mirror's "cannot be deleted or edited" rule). */
export const BUILTIN_FILTER_ID_PREFIX = 'builtin:';

/** "Recently" for the Created/Updated/Resolved-recently built-ins — Jira's
 * system filters use a one-week window. */
export const BUILTIN_RECENT_WINDOW_DAYS = 7;
