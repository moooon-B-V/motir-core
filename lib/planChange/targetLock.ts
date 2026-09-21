// The PLANNING-TARGET LOCK's pure half (Story MOTIR-2786 · MOTIR-2787) — the
// lease window and the two status facts the service reasons from, kept out of
// the service so they can be unit-tested and so the migration's prose, the
// service and the sweep job all name the same constants.
//
// ── WHY A LEASE AND NOT A HOLD ──────────────────────────────────────────────
// A status lock is a lock, and the failure that outlasts every other is a lock
// that is never released: a crashed planner leaves an epic in `planning` and NO
// user can clear it. That is worse than the race the lock prevents, because a
// race produces a confusing tree a person can repair and this produces an item
// nobody can ever plan again.
//
// Nothing else in the system can recover it. A plan-edit job that dies leaves
// its `Plan` at `generating` — `PlanStatus` has no `failed` member — so no
// product event ever fires to say the session is over. The lease is therefore
// the ONLY mechanism that reaches the crash case, which is why it is the
// primary recovery path rather than a backstop.

/**
 * How long a freshly acquired (or refreshed) lease is good for.
 *
 * Sized against what it is actually racing: a planning TURN, whose motir-ai job
 * is minutes rather than seconds, and a human who reads the proposal before
 * approving it. Too short and a person who steps away mid-review has their epic
 * taken from under them; too long and a crashed planner blocks the item for that
 * long. Thirty minutes is comfortably longer than any turn and short enough that
 * "wait for it to clear" is a real answer to a stuck lock rather than a joke.
 *
 * It is REFRESHED on every submit, so a long conversation never ages out while
 * it is being had — the window only starts running down once the session stops
 * doing anything, which is exactly the condition it exists to detect.
 */
export const PLAN_TARGET_LOCK_LEASE_MS = 30 * 60 * 1000;

/**
 * The lease for a lock held by a PLAN rather than by a session (MOTIR-5645;
 * `docs/decisions/agent-authored-plans.md` AMENDMENT 16 D9) — TWENTY-FOUR HOURS.
 *
 * ⚠️ WHY NOT THE THIRTY MINUTES ABOVE. That window is refreshed by a session
 * SUBMIT, and the things that now park a target make no submit at all: a runbook
 * planning pass walks a corpus, lays a level, authors a card at a time, and a
 * walk longer than half an hour would have its own targets swept out from under
 * it mid-pass. A plan-held lease is refreshed by each APPEND instead, so an
 * honest pass keeps its own window open by working.
 *
 * ⚠️ AND THE NUMBER IS NOT CHOSEN — it is `ABANDONED_PLAN_MAX_AGE_HOURS`, the
 * threshold already shipped for exactly this population. `abandonedPlanService`
 * uses it as the crashed-worker arm and as the only signal available for a plan
 * with NO producer, which is every MCP-authored plan, and its own comment
 * records that it reuses that constant *"rather than introducing a threshold of
 * its own"*. A lock released on the same threshold is released exactly when the
 * plan it belongs to is declared dead.
 *
 * The agreement is PINNED rather than imported: this module is a pure leaf with
 * no imports, and reaching up into a service for a number is how a cycle starts.
 * `tests/planning/planLeaseWindow.test.ts` fails if the two ever diverge.
 */
export const PLAN_TARGET_PLAN_LEASE_MS = 24 * 60 * 60 * 1000;

/** How many expired leases one sweep pass releases. Bounded so a backlog drains
 *  over several passes instead of one run holding locks across a large slice of
 *  the table. */
export const PLAN_TARGET_LOCK_SWEEP_BATCH_SIZE = 100;

/** The workflow status key the lock shows on the board while it is held. */
export const PLANNING_STATUS_KEY = 'planning';

/**
 * Whether acquiring on an item currently at `fromStatus` should ALSO move it to
 * `planning` — asked of the project's REAL transition graph, never of a constant
 * list, because a project may customize its workflow.
 *
 * ⚠️ THIS IS NOT A GATE ON THE LOCK. An item in `in_review` — from which the
 * default workflow has no edge to `planning` — can still legitimately be the
 * subject of a planning conversation, and must still be held exclusively. The
 * LEASE ROW does that. What this decides is only whether the board also gets the
 * visible affordance. Refusing the conversation over a display detail would be
 * the wrong trade; locking without the status keeps the exclusion total and
 * loses nothing but the colour.
 *
 * `false` for an item ALREADY at `planning`: there is nothing to move, whether
 * it got there by a sibling scope's hand-off or by MOTIR-2425 parking it. The
 * caller records the answer on the lease as `statusHeld`, and release restores
 * the prior status only when it is `true` — so a lock that never moved a status
 * never moves one back.
 */
export function shouldHoldStatus(fromStatus: string, planningIsLegalFromHere: boolean): boolean {
  if (fromStatus === PLANNING_STATUS_KEY) return false;
  return planningIsLegalFromHere;
}

/** The lease expiry for a SESSION-held lock acquired or refreshed at `now`. */
export function leaseExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + PLAN_TARGET_LOCK_LEASE_MS);
}

/** The lease expiry for a PLAN-held lock acquired or refreshed at `now`
 *  (MOTIR-5645) — the 24-hour window, refreshed by each append. */
export function planLeaseExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + PLAN_TARGET_PLAN_LEASE_MS);
}

/** Whether a lease has run out at `now` — the single definition the acquire
 *  path's take-over branch and the sweep both read, so "expired" cannot mean two
 *  slightly different things in two places. */
export function isExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}
