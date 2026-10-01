// Every number `docs/decisions/pages.md` fixes, in one place (its
// "Consequences" section). A change to one is a one-line change with a test.

/** §4 — at most 10 levels of pages. A root-level or folder-filed page is level 1. */
export const PAGE_DEPTH_LIMIT = 10;

/** §3 — the largest stored body, `page.body_state`, in bytes (2 MiB). */
export const PAGE_BODY_MAX_BYTES = 2_097_152;

/** §3 — the largest single save request, in bytes (1 MiB). */
export const PAGE_SAVE_MAX_BYTES = 1_048_576;

/** §6 — same-author saves within this window coalesce into one version (10 minutes). */
export const PAGE_VERSION_WINDOW_MS = 600_000;

/** §6 — the most versions one page keeps; the oldest are deleted past it. */
export const PAGE_VERSION_CAP = 100;

/** §4 — pages per tree level read, by default. */
export const PAGE_LEVEL_PAGE_SIZE = 50;

/** §4 — pages per tree level read, at most. */
export const PAGE_LEVEL_PAGE_SIZE_MAX = 100;
