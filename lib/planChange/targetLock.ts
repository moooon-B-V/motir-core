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

/** The lease expiry for a lock acquired or refreshed at `now`. */
export function leaseExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + PLAN_TARGET_LOCK_LEASE_MS);
}

/** Whether a lease has run out at `now` — the single definition the acquire
 *  path's take-over branch and the sweep both read, so "expired" cannot mean two
 *  slightly different things in two places. */
export function isExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}
