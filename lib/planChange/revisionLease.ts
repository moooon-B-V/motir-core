// The PLAN-REVISION LEASE's pure half (Story MOTIR-3595 · Subtask MOTIR-3596) —
// the one window the ADR, the service and the tests all name.
//
// ⚠️ THIS FILE CARRIES A CONSTANT AND NOTHING ELSE. The acquire, the refusal and
// the release are the implementing cards' (`docs/decisions/agent-authored-plans.md`
// AMENDMENT 10, "The constant and the type this card ships"); a decision card that
// shipped the mechanism as well would have decided it twice.
//
// ── WHY A LEASE AT ALL ──────────────────────────────────────────────────────
// `approvePlan` re-reads the proposal set FRESH under the plan row lock and
// materializes it in ONE transaction, so every individual write is atomic and the
// COMPOSITION is not. A revision is a SEQUENCE of transactions — one proposal per
// call, the discipline every shipped sink call site follows — and an approve that
// takes the lock between the third and the fourth of them materializes a tree
// that is neither the plan the reviewer read nor the plan they asked for. Approve
// is one-shot; there is no un-approve.
//
// ── WHY IT LIVES ON THE TRAIL AND NOT IN A TABLE ────────────────────────────
// `PlanRevision.changeKind` is plain text precisely so a new verb is a code
// change rather than a migration (`planRevisionsService` says so in as many
// words), and the lease's two verbs — `revision_started` / `revision_ended` — are
// the eighth and ninth. It also keeps the lease and its VISIBILITY the same
// record: a reviewer learns a revision is running by reading the timeline they
// were already reading.

/**
 * How long a revision lease is good for, measured from the LATEST trail row the
 * revision has written.
 *
 * Sized against what it actually races: ONE motir-ai job over a tree that is
 * already written — minutes, rather than the tens of minutes
 * `PLAN_TARGET_LOCK_LEASE_MS` is sized for (that one races a human-paced planning
 * conversation and a person who steps away mid-review). Short enough that "wait
 * for it to clear" is a real answer to a stuck lease rather than a joke.
 *
 * REFRESHED by every write the revision makes, because the window is measured
 * from the latest row rather than from the acquire: a long revision never ages
 * out while it is doing something, and the clock only starts running down once it
 * STOPS — which is the condition the expiry exists to detect. A job that dies
 * writes no `revision_ended`, and this window is the ONLY thing that recovers the
 * plan, exactly as `targetLock.ts` records of its own.
 */
export const PLAN_REVISION_LEASE_MS = 10 * 60 * 1000;

/** The two trail verbs that BRACKET a revision. They are ordinary
 *  `PlanRevision.changeKind` values — the column is plain text — and the pair IS
 *  the lease. */
export const REVISION_STARTED_KIND = 'revision_started';
export const REVISION_ENDED_KIND = 'revision_ended';

/** The shape this module needs of a trail row: nothing but the verb, when it
 *  happened, and who did it. Declared structurally rather than importing the
 *  Prisma model, so the predicate stays pure and unit-testable. */
export interface RevisionLeaseRow {
  changeKind: string;
  changedAt: Date;
  actorHarness?: string | null;
  actorModel?: string | null;
}

/** A held lease: who has the plan, and until when. */
export interface RevisionLease {
  heldBy: string | null;
  expiresAt: Date;
}

/**
 * The lease a plan's trail carries, or `null` when nothing holds it.
 *
 * HELD means: the trail's latest {@link REVISION_STARTED_KIND} has no
 * {@link REVISION_ENDED_KIND} after it, AND the most recent row at or after that
 * start is inside {@link PLAN_REVISION_LEASE_MS}.
 *
 * ⚠️ THE WINDOW IS MEASURED FROM THE LATEST ROW, not from the start — which is
 * what makes the lease REFRESH on every write the revision makes. A long
 * revision never ages out while it is doing something; the clock only runs down
 * once it STOPS, which is the condition the expiry exists to detect. A job that
 * dies writes no `revision_ended`, and this window is the only thing that
 * recovers the plan.
 *
 * `rows` is the whole trail in the order `planRevisionRepository.listByPlan`
 * returns it — OLDEST FIRST. Passing it unsorted would silently pick the wrong
 * start, so the order is part of the contract rather than something re-derived
 * here on every call.
 */
export function revisionLeaseOf(
  rows: readonly RevisionLeaseRow[],
  now: Date,
): RevisionLease | null {
  let startIndex = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const kind = rows[i]!.changeKind;
    // The FIRST terminator walking backwards ends the search: a revision that
    // landed is not holding anything, however many earlier ones there were.
    if (kind === REVISION_ENDED_KIND) return null;
    if (kind === REVISION_STARTED_KIND) {
      startIndex = i;
      break;
    }
  }
  if (startIndex < 0) return null;

  const start = rows[startIndex]!;
  const latest = rows[rows.length - 1]!;
  const expiresAt = new Date(latest.changedAt.getTime() + PLAN_REVISION_LEASE_MS);
  if (expiresAt.getTime() <= now.getTime()) return null;

  // The HARNESS, never the model — the same discriminator the timeline row uses
  // (Part X §4): a harness name is what a reader recognises, and the model is one
  // level of detail below what a refusal needs to say.
  return { heldBy: start.actorHarness ?? null, expiresAt };
}
