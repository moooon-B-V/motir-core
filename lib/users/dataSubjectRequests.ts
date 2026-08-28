// THE DATA-SUBJECT-REQUEST VOCABULARY (Story 8.4 · MOTIR-3698 · design of
// record `design/settings/design-notes.md` → `Data & privacy`, DECISIONs 2
// and 4).
//
// The two windows this feature turns on live here rather than at their call
// sites, for the reason `lib/codeGraph/offboarding.ts` gives about its own:
// a window is "one named constant in motir-core … interpolated into the copy
// that states it, rather than retyped — so the promise and the behaviour cannot
// drift." A product that tells somebody "30 days" in a dialog and erases on a
// different schedule has expressed its enforcement in terms it does not control.
// One value, every reader.
//
// Nothing here reads the database or decides policy — it is arithmetic over two
// published numbers, so a repository, a service, a job and a React component may
// all import it.

/**
 * How long after an account-deletion request the erasure becomes due — the
 * grace period during which signing back in cancels it.
 *
 * ⚠️ **THIS VALUE IS A PUBLISHED LEGAL PROMISE.**
 * `content/legal/privacy.md` **§6** ("How long we keep it") tells every user:
 * _"After you delete it, we erase or anonymise within **30 days**, except where
 * something below applies"_. The erasure runs AT day 30, which is within 30
 * days, so the deadline and the promise are the same number read as the
 * deadline it is. Changing this changes that promise — amend §6 in the same
 * change, or do not change it.
 *
 * `tests/users/dataSubjectRequests.test.ts` reads §6 out of the shipped Markdown
 * and asserts it equals this constant, so the two cannot drift silently.
 *
 * The product already holds this doctrine one domain over:
 * {@link ../codeGraph/offboarding.CODE_GRAPH_RETENTION_WINDOW_DAYS} is the same
 * 30 for the same reason (a window interpolated into the copy that states it).
 * They are deliberately SEPARATE constants: they answer to different promises —
 * §6 of the Privacy Policy here, `docs/decisions/code-graph-index-fleet.md`
 * §14.3 there — and a shared constant would make an edit to one silently move
 * the other.
 */
export const ACCOUNT_ERASURE_WINDOW_DAYS = 30;

/**
 * How long a built personal-data archive stays downloadable.
 *
 * Design DECISION 2: a presigned download URL lives 300 seconds
 * (`signedDownloadUrl` in `lib/blob/uploader.ts`), which is far too short to
 * email, so the shape is "we mail you that it is ready, you come back to the
 * pane and press Download". That return trip is a real instruction rather than
 * a race only because the archive is still there when the reader makes it —
 * seven days is what makes it so.
 */
export const DATA_EXPORT_RETENTION_DAYS = 7;

/** One day in milliseconds — the unit both windows are expressed in. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When an erasure requested at `requestedAt` becomes due.
 *
 * `requestedAt` is injectable (and required) rather than defaulted to `now()`
 * so a caller — or a test pinning the boundary — owns the clock. A timestamp
 * assertion against wall-clock is a window, not an equality; here it can be an
 * equality, so it is.
 */
export function erasureDueAt(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + ACCOUNT_ERASURE_WINDOW_DAYS * DAY_MS);
}

/**
 * When an archive BUILT at `builtAt` stops being downloadable.
 *
 * Measured from the BUILD, never from the request: an export that took an hour
 * to assemble must still be available for the full retention window after it
 * exists, and measuring from the request would silently shorten it by however
 * long the job queued.
 */
export function dataExportExpiresAt(builtAt: Date): Date {
  return new Date(builtAt.getTime() + DATA_EXPORT_RETENTION_DAYS * DAY_MS);
}

/**
 * Where the reader comes back to, once the archive is built.
 *
 * The export-ready email carries a link to THIS PANE and never to the file —
 * design DECISION 2, and the reason is measured rather than stylistic: a
 * presigned URL lives 300 seconds, which is far too short to survive an inbox.
 * So the notification is a nudge back to a surface that can authenticate the
 * reader, and the download is minted on the click.
 *
 * It lives here, with the two windows, for the same reason they do: the pane
 * (MOTIR-1136) and the email that points at it must not each carry their own
 * copy of the path. One value, every reader.
 */
export const DATA_PRIVACY_PANE_PATH = '/settings/account/data';
