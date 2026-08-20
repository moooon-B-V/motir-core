import type { ClaimActorDto } from '@/lib/dto/claim';
import type { SprintBlockerDto } from '@/lib/dto/sprints';

// The SCOPE CLAIM result (MOTIR-3049) — the scope-shaped sibling of
// `lib/dto/claim.ts`'s single-key claim.
//
// A scoped run (`motir run <story-id>`, `motir run sprint`) does not want to
// claim as it goes. Claiming card by card leaves a long window in which a second
// run takes card five while the first is on card two, and the two then integrate
// onto different branches — a half-delivered story split across two pull
// requests, which is worse than either run having refused outright. So the claim
// moves to the FRONT and becomes all-or-nothing: either this run owns the whole
// scope and can promise to finish it, or it owns nothing and says why.
//
// ⚠️ A PARTIALLY-CLAIMED SCOPE IS THE ONE OUTCOME WITH NO GOOD HANDLING — you
// can neither finish it nor cleanly abandon it, because you are already holding
// cards somebody else is now blocked on. That is why the whole thing is one
// transaction, and why this file has no shape for "some of it".

/** Which of the two claimable scopes a result is about. */
export type ScopeClaimKind = 'work_item' | 'sprint';

/**
 * What a scope claim attempt resolved to.
 *
 * The first four are `lib/dto/claim.ts`'s vocabulary, unchanged and computed by
 * the SAME classifier — a refusal here means one MEMBER refused, and the reason
 * a member refuses does not become a different reason for being inside a scope.
 * The last two are the two ways a scope can fail that a single card cannot:
 *
 * - `claimed`        — every member was in the to-do CATEGORY; all of them are
 *                      now assigned to the caller and `in_progress`.
 * - `mine`           — a member is already `in_progress` and already the
 *                      caller's. A resume of the caller's own run.
 * - `taken`          — a member is `in_progress` and NOT the caller's.
 * - `not_claimable`  — a member is outside the to-do category and not
 *                      `in_progress` (`implemented`, `in_review`, `planning`,
 *                      `done`, `cancelled`, a status the workflow does not
 *                      define, or an ARCHIVED row).
 * - `wrong_shape`    — a work-item scope whose child is itself a container, so
 *                      a leaf is more than one hop from the root. A RESULT and
 *                      not an error, because the caller's response is to submit
 *                      a re-plan rather than to retry.
 * - `not_finishable` — the scope's own validator refuses it: work OUTSIDE the
 *                      scope gates work inside it, so a run that took it could
 *                      not finish it.
 */
export type ScopeClaimOutcome =
  | 'claimed'
  | 'mine'
  | 'taken'
  | 'not_claimable'
  | 'wrong_shape'
  | 'not_finishable';

/** What was asked for — echoed back so a refusal reads without a second call. */
export interface ScopeClaimScopeDto {
  kind: ScopeClaimKind;
  /** The container's key for a `work_item` scope; `null` for a sprint. */
  key: string | null;
  /** The sprint's id for a `sprint` scope; `null` for a work item. */
  sprintId: string | null;
  /** The container's title, or the sprint's name. */
  name: string;
}

/** One work item inside a claimed scope. */
export interface ScopeClaimMemberDto {
  key: string;
  title: string;
  /** Where the row stands after the call — `in_progress` for every claimed member. */
  status: { key: string; category: string | null };
}

/**
 * The member whose state refused the claim, with its holder named.
 *
 * ⚠️ THE OFFENDER IS CHOSEN BY SEVERITY, NOT BY LOCK ORDER, and that is
 * deliberate. The card says the refusal "names the first offender"; it does not
 * say what makes one offender first, and the lock order is `id` — a cuid, which
 * is to say an accident. Picking by cuid would make a scope holding one card a
 * sibling took AND one card the caller already owns answer `taken` or `mine`
 * depending on which id sorted lower, so the same set of facts would produce two
 * different verdicts on two different days. So the verdict is a total function
 * of the member set: `taken` (somebody else is on it — a hard stop whatever else
 * is true) beats `not_claimable` (the scope contains finished work — a plan
 * problem) beats `mine` (nothing but the caller's own cards — a resume). Within
 * one class the named offender IS the first in lock order, which is stable.
 */
export interface ScopeClaimOffenderDto {
  key: string;
  title: string;
  /** The status the member is at — untouched, since nothing was written. */
  status: { key: string; category: string | null };
  /** Who it is assigned to, or `null` when a sibling flipped the status without assigning. */
  assignee: ClaimActorDto | null;
  /** Who performed the transition that put it where it is — the field that names
   *  the holder even when nothing was assigned (the MOTIR-2958 shape). */
  transitionedBy: ClaimActorDto | null;
  /** When that transition happened, ISO-8601, or `null` if the status never moved. */
  transitionedAt: string | null;
}

/**
 * The `wrong_shape` detail — the child that is itself a container, and how deep
 * the work under it actually sits.
 *
 * `depth` counts HOPS FROM THE SCOPE ROOT to the work this child holds: `1` is
 * the only claimable depth (a leaf child), and an offender therefore reports
 * `2`. It is the number the caller's re-plan has to flatten, stated as a number
 * rather than left for the reader to infer from the child's kind.
 */
export interface ScopeClaimShapeDto {
  /** The offending child's key. */
  child: string;
  /** The offending child's title. */
  childTitle: string;
  /** Hops from the scope root to the work under `child` — always ≥ 2 here. */
  depth: number;
}

/** The result of one scope claim attempt. */
export interface ScopeClaimDto {
  scope: ScopeClaimScopeDto;
  outcome: ScopeClaimOutcome;
  /** `outcome === 'claimed'` — the happy-path branch, without knowing the vocabulary. */
  claimed: boolean;
  /** Every row the caller now holds. Populated on `claimed`; `[]` on every refusal,
   *  because a refusal claimed nothing. Ordered by key. */
  members: ScopeClaimMemberDto[];
  /** The member that decided a `mine` / `taken` / `not_claimable` verdict; `null` otherwise. */
  offender: ScopeClaimOffenderDto | null;
  /** The offending child of a `wrong_shape` verdict; `null` otherwise. */
  shape: ScopeClaimShapeDto | null;
  /** Why a `not_finishable` scope cannot be finished, in the validators' own
   *  shape; `[]` otherwise. */
  blockers: SprintBlockerDto[];
}
