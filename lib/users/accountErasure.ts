// THE ERASURE VOCABULARY (Story 8.4 · MOTIR-3702 · design of record
// `design/settings/design-notes.md` → `Data & privacy` → DECISION 3).
//
// DECISION 3 splits everything an account touches into three groups — DELETED,
// ANONYMISED, KEPT — and this module holds the two things that split needs and
// that no service should retype: what an anonymised profile row LOOKS like, and
// how long a half-finished erasure stays resumable.
//
// ── WHY THE `user` ROW SURVIVES AT ALL, WHICH IS THE DECISION THIS FEATURE
//    TURNS ON ────────────────────────────────────────────────────────────────
//
// DECISION 3's ANONYMISE group says, of a comment or a work item inside a
// workspace other people share: *"the name is removed, the row stays."* The
// schema makes that a statement about the `user` row rather than about the
// comment. Four foreign keys onto `user` are NOT NULL and `onDelete: Restrict`:
//
//   `work_item.reporter_id` · `comment.author_id` ·
//   `work_item_link.created_by_id` · `work_item_revision.changed_by_id`
//
// So a `DELETE FROM "user"` is REFUSED by Postgres for anybody who ever
// reported an item or wrote a comment — which is exactly the population the
// anonymise group is about. There is no ordering that gets around it: making
// those rows point somewhere else is either deleting a third party's backlog
// (what DECISION 3 forbids in as many words) or inventing a shared "deleted
// user" row, which is a second identity to keep correct for ever.
//
// **So the erasure ANONYMISES the profile row in place and never deletes it.**
// Every surface renders a person through `user.name` / `user.email` /
// `user.image`, so scrubbing those three removes the name from every
// attribution at once — including from tables nobody thought to enumerate,
// which is the failure mode this card's own explanation names. What is left is
// an opaque id that carries no personal data and points at nothing.
//
// It is also what keeps the RECORD of the erasure: `account_deletion_request`
// is `onDelete: Cascade` on `user`, so deleting the row would delete the
// `completed` request that proves the erasure ran — and with it the idempotence
// this job depends on.
//
// ONE terminal state, not two: an account with nothing shared is anonymised by
// the same path as one with a thousand comments. A branch that hard-deletes
// "when it can" would make the outcome depend on the data shape, which is the
// one property a destructive operation must not have.

/**
 * The `name` an erased profile carries.
 *
 * The product already has this string, in `messages/en.json`'s `formerMember`,
 * and `ActivityEntryRow` already renders it for an attribution whose referent
 * is gone. Reusing the literal makes an erased author read on the item page
 * exactly as a `SetNull`'d one does, rather than introducing a second phrasing
 * for the same fact.
 *
 * ⚠️ It is NOT localised, and that is a known limitation rather than an
 * oversight: this is a database column read by every surface, and the i18n
 * catalogue is not reachable from a background job. Rendering the key instead
 * would need a flag on the row saying "this name is a sentinel", which is a
 * schema change on a model this card does not own.
 */
export const ERASED_USER_NAME = 'Former member';

/**
 * The domain an erased account's placeholder address sits in.
 *
 * `.invalid` is reserved by RFC 2606 §2 and can never be delegated, so the
 * address is guaranteed undeliverable — which matters, because `user.email` is
 * read by mail paths that have no idea an account was erased.
 */
export const ERASED_EMAIL_DOMAIN = 'erased.invalid';

/**
 * The address an erased profile carries, derived from the id it already holds.
 *
 * `user.email` is `@unique`, so the erasure cannot simply blank it — and it
 * must not KEEP the real address, which is the single most identifying column
 * on the row. Deriving the placeholder from the user id gives a value that is
 * unique by construction, carries nothing the row did not already carry, and
 * **releases the real address**, so the person can open a new account with it.
 */
export function erasedEmailFor(userId: string): string {
  return `erased-${userId}@${ERASED_EMAIL_DOMAIN}`;
}

/**
 * How long after `completedAt` the sweep keeps re-visiting a `completed`
 * request to finish its post-commit half.
 *
 * ⚠️ WHAT THIS WINDOW IS FOR, because it is not a retention period. The erasure
 * commits in ONE locked transaction and then deletes the reader's sole-
 * membership workspaces AFTER it — through `workspacesService.deleteWorkspace`,
 * which opens its own transactions and fires its own offboarding enqueue, so it
 * cannot be inside. A crash between the two leaves a `completed` request whose
 * workspaces are still standing, and the ordinary due set (`scheduled` and past
 * `erasureDueAt`) can never see it again.
 *
 * So the sweep's work set carries a second arm: `completed` requests finished
 * inside this window, for which it re-derives the workspace set and re-runs
 * only that step. Bounded rather than unbounded because the arm scans by
 * status: seven days is many nightly ticks, and a leftover older than that is
 * an incident for the schedule-health check, not a row for a nightly sweep to
 * keep re-reading for ever.
 */
export const ERASURE_RESUME_WINDOW_DAYS = 7;

/** One day in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** The earliest `completedAt` the resume arm still re-visits, as of `now`. */
export function erasureResumeFloor(now: Date): Date {
  return new Date(now.getTime() - ERASURE_RESUME_WINDOW_DAYS * DAY_MS);
}
