// The PLAN-REVISION LEASE's pure half (Story MOTIR-3595 · Subtask MOTIR-3596) —
// the one window the ADR, the service and the tests all name.
//
// ⚠️ THIS FILE CARRIES A CONSTANT AND NOTHING ELSE. The acquire, the refusal and
// the release are the implementing cards' (`docs/decisions/agent-authored-plans.md`
// AMENDMENT 9, "The constant and the type this card ships"); a decision card that
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
