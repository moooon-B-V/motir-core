import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';

/** The two statuses a parked target may rest at once its plan is approved. */
export const RESTING_BLOCKED_KEY = 'blocked';
export const RESTING_TODO_KEY = 'todo';

/** Why a parked target was NOT given a resting status. Reported rather than
 *  silent, because every one of these is a case somebody will ask about. */
export type RestingSkipReason =
  /** The plan `remove`d it. An archived row is claimed by nothing, and writing a
   *  status onto it would be a claim about work that is gone. */
  | 'archived'
  /** It is no longer at `planning` — MOVED OUT BY A SYSTEM WRITE OR AFTER AN
   *  EXPIRED LEASE. The name predates `agent-authored-plans.md` AMENDMENT 21
   *  (MOTIR-6017), which overturned the "manual release" it was named for: while
   *  an undecided plan holds a card, no hand move out of `planning` is accepted.
   *  The arm is KEPT as a defensive one (§7) because it still has occupants — a
   *  card moved by a system write or the status-delete admin reassign, a card whose
   *  `generating` lease expired before it was moved, a card moved before the hold
   *  deployed — and writing a resting status over any of them would put it where
   *  nobody decided. The identifier is left alone: renaming it would touch every
   *  call site for a rule change, not a symbol change. `releaseOne` keeps the same
   *  guard for the same reason. */
  | 'moved_by_hand';

export type RestingDecision =
  | { readonly write: false; readonly reason: RestingSkipReason }
  | { readonly write: true; readonly toKey: typeof RESTING_BLOCKED_KEY | typeof RESTING_TODO_KEY };

/**
 * THE RESTING STATUS (bug MOTIR-5640 · MOTIR-5646;
 * `docs/decisions/agent-authored-plans.md` AMENDMENT 16 D6–D8) — where a target a
 * plan PARKED goes when that plan is approved.
 *
 * PURE, and its own module for the reason `rescopeReset.ts` gave for being one:
 * the answer is a DECISION, it has to be identical wherever it is read, and a
 * pure function is the only shape a unit test can pin without a database.
 *
 * ⚠️ D7'S FIVE-ROW TABLE IS A CONSEQUENCE OF THIS, NOT A SECOND MECHANISM — and
 * that is the point worth holding, because a five-row table invites five code
 * paths. Read the rows against the two questions below:
 *
 * | the approved plan's effect on the target | how it arrives here |
 * | --- | --- |
 * | `remove` | archived by materialize ⇒ `archived`, no write |
 * | `modify` carrying `blockedByAdd` | the edge is wired by materialize, so the blocker read sees it ⇒ `blocked` |
 * | `add`s parented at it (a container) | no open blocker of its own ⇒ `todo` |
 * | `modify` with no new edge (re-scope, re-size, re-type) | ⇒ `todo` |
 * | `modify` carrying only `parentRef` | ⇒ `todo` |
 *
 * Every row is answered by *was it archived*, *did a person move it*, and *does
 * it have an open blocker NOW* — asked after materialize has wired the plan's
 * edges, which is what makes the `blockedByAdd` row fall out rather than need a
 * rule.
 *
 * ⚠️ AND THIS REPLACES MOTIR-5359's RE-SCOPE RESET rather than joining it. That
 * one moved a re-scoped in-progress-category card to the project's INITIAL
 * status, keyed on whether the patch changed the card's title, body or
 * repository — a narrower question (*did the body change?*) than the one the
 * park poses (*was this card parked?*), and blind to the card's blockers, so it
 * would send a card with an open prerequisite to `todo`. One predicate now
 * answers for every target, and `rescopeReset.ts` is deleted.
 *
 * @param archived whether materialize archived the row (the plan `remove`d it)
 * @param currentStatus the target's status AFTER materialize
 * @param hasOpenBlocker `!classifyBlockerReadiness(...).ready` — the SAME
 *   predicate the ready set and the birth-status pass use, so `blocked` here can
 *   never mean something different from "not ready" there
 */
export function restingStatusFor(args: {
  archived: boolean;
  currentStatus: string;
  hasOpenBlocker: boolean;
}): RestingDecision {
  if (args.archived) return { write: false, reason: 'archived' };
  if (args.currentStatus !== PLANNING_STATUS_KEY) {
    return { write: false, reason: 'moved_by_hand' };
  }
  return { write: true, toKey: args.hasOpenBlocker ? RESTING_BLOCKED_KEY : RESTING_TODO_KEY };
}
