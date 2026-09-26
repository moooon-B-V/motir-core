// THE ORGANIZATION-DELETION VOCABULARY (Story MOTIR-6306 · MOTIR-6391).
// Contract: `docs/decisions/organization-deletion.md` (MOTIR-6389).
//
// The two numbers this feature turns on live here rather than at their call
// sites, for the reason `lib/users/dataSubjectRequests.ts` gives about its own
// window: one named constant, interpolated into every sentence that states it,
// so the promise and the behaviour cannot drift. The dialog, the scheduled card,
// the banner, every email and the sweep all read these.
//
// Nothing here reads the database or decides policy — it is arithmetic over two
// published numbers, so a repository, a service, a job and a React component may
// all import it.

/**
 * How long after an Owner schedules a deletion the organization is erased — the
 * window the Owner can cancel inside, during which the org is read-only
 * (DECISION §2, §3).
 *
 * ⚠️ **THIS VALUE IS A PUBLISHED CONTRACTUAL PROMISE.** The Data Processing
 * Agreement **§10** ("Deletion and return", `motir-marketing`
 * `content/legal/dpa.md`) tells every customer: _"Unless you ask otherwise, we
 * delete it within **thirty days** of termination"_. The erasure runs AT day 30,
 * which is within 30 days — so the deadline and the promise are the same number.
 * A longer window needs a DPA change; do not change this without one.
 *
 * Deliberately SEPARATE from `ACCOUNT_ERASURE_WINDOW_DAYS` although both are 30
 * today: that one answers to Privacy Policy §6 and this one to DPA §10, and a
 * shared constant would let an edit to one promise silently move the other
 * (DECISION §2).
 */
export const ORGANIZATION_DELETION_WINDOW_DAYS = 30;

/**
 * How long an erased organization's tombstone and its billing record are kept
 * before the retention purge removes them (DECISION §7).
 *
 * Privacy Policy **§6**: billing records are _"kept as long as tax and
 * accounting law requires, which in the Netherlands is generally **seven
 * years**"_ (AWR art. 52). Measured from the erasure, never from the request.
 */
export const ORGANIZATION_BILLING_RETENTION_YEARS = 7;

/** One day in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When a deletion scheduled at `requestedAt` becomes due. `requestedAt` is
 * required rather than defaulted to `now()`, so the caller — or a test pinning
 * the boundary — owns the clock and the assertion can be an equality.
 */
export function erasureDueAt(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + ORGANIZATION_DELETION_WINDOW_DAYS * DAY_MS);
}

/**
 * The instant before which an org erased at `erasedAt` is still inside its
 * retention — i.e. `erasedAt + ORGANIZATION_BILLING_RETENTION_YEARS` calendar
 * years (UTC). A calendar year, not 365 days: a leap day inside the window must
 * not shorten a legal retention by a day.
 */
export function retentionEndsAt(erasedAt: Date): Date {
  const end = new Date(erasedAt.getTime());
  end.setUTCFullYear(end.getUTCFullYear() + ORGANIZATION_BILLING_RETENTION_YEARS);
  return end;
}

/**
 * The erasure cut-off for the retention purge at `now`: every tombstone erased
 * strictly before it has served its retention.
 */
export function retentionCutoff(now: Date): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - ORGANIZATION_BILLING_RETENTION_YEARS);
  return cutoff;
}

/**
 * Is this organization CLOSING — scheduled for deletion and inside its window?
 *
 * Reads the org row's own `closingSince` flag, which the schedule sets and the
 * cancel clears in the same transaction as the request row (MOTIR-6399), so the
 * read-only resolver (MOTIR-6396) answers from the row it already holds rather
 * than joining the request table on every request. An erased org (a tombstone)
 * is not "closing" — it has no workspaces left to be read-only in.
 */
export function isOrganizationClosing(org: {
  closingSince: Date | null;
  erasedAt: Date | null;
}): boolean {
  return org.closingSince !== null && org.erasedAt === null;
}
