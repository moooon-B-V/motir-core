// Label-domain constants (Story 5.4) — in their own Prisma-free module so the
// CLIENT surfaces (the 5.4.8 rail card's cap + hint copy) can import them
// without pulling the service layer into the bundle. The service re-exports
// them, so server-side callers keep importing from labelsService.

/** Longest accepted label name, in characters (a recorded constant). */
export const LABEL_NAME_MAX_LENGTH = 60;

/** Per-issue label cap — the Story 5.4 sanity guard ("100 labels is absurd"). */
export const LABELS_PER_ISSUE_LIMIT = 20;

/** Autocomplete window — a bounded prefix read, never a load-all (finding #57). */
export const LABEL_SEARCH_LIMIT = 20;
