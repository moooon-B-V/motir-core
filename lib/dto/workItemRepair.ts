import type { ClaimActorDto } from '@/lib/dto/claim';
import type { PrCiState } from '@/lib/github/prCiState';

// The REPAIR CLAIM result (Story MOTIR-5460 · MOTIR-5464).
//
// A card whose run has ended can be left with a red pull request, and the only
// agent that could fix it has gone. `POST /api/v1/work-items/{key}/repair` hands
// that pull request to ONE fixing agent: it opens a dispatch run with command
// `fix`, and that open run is the lock. The card's status and assignee are never
// written — a red build already means `implemented`, and `ciPromotion` moves the
// card on when the build goes green, exactly as it does for any card.
//
// Like the keyed claim (`lib/dto/claim.ts`), a refusal is a RESULT and not an
// error, and it DISCRIMINATES: the caller's next move is different for each.

/**
 * What a repair claim resolved to.
 *
 * - `claimed` — the repair is the caller's now; a `fix` run was opened for it.
 * - `mine` — the caller already holds an open `fix` run on this card: a resumed
 *   repair. The same run is returned, and no second one is opened.
 * - `taken` — somebody else holds the open `fix` run. Named, with its start.
 * - `not_repairable` — there is nothing a repair can do here; `reason` says why.
 */
export type WorkItemRepairOutcome = 'claimed' | 'mine' | 'taken' | 'not_repairable';

/**
 * Why a card cannot be repaired, checked in this order.
 *
 * - `not_implemented` — archived, or at neither the project's Implemented nor its
 *   In Review rung. A red build is only a repair's business once the run that built
 *   it has ended; In Review is admitted for a merge-queue ejection (MOTIR-5803).
 * - `repair_on_run_target` — the pull requests belong to a run launched against
 *   another card (`runTargetKey`); the repair runs there, never on a child the
 *   same pull requests also deliver.
 * - `no_pull_requests` — the card has no delivery rows at all.
 * - `ci_running` — nothing open is failing, and at least one member is running.
 * - `not_failing` — nothing open is failing and nothing is running. Also an In
 *   Review card with no standing merge-queue outcome at a member's head: it is
 *   waiting on review, not failing (MOTIR-5803).
 * - `repair_not_code` — the merge did not land for a reason NO CODE CHANGE fixes
 *   (MOTIR-5803; `approval-gates.md` §4 FOURTH AMENDMENT, point 6): a setting
 *   blocked it, or somebody took the pull request out of the queue by hand. The
 *   message names what would help instead — approve again, or change the setting.
 */
export type WorkItemRepairRefusal =
  | 'not_implemented'
  | 'repair_on_run_target'
  | 'no_pull_requests'
  | 'ci_running'
  | 'not_failing'
  | 'repair_not_code';

/** One failing pull request the fixing agent is handed. */
export interface RepairPullRequestDto {
  /** `owner/name`. */
  repo: string;
  number: number;
  url: string;
  /** The branch the agent checks out and pushes to — the SAME pull request's. */
  headRef: string;
  /** Null on a row mirrored before base branches were recorded. */
  baseRef: string | null;
  /** The pull request's OWN verdict (`derivePrCiState`). `failing` when its own
   *  checks are red — and possibly `passing` when it is failing only because the
   *  merge queue threw it out: then {@link RepairPullRequestDto.queueExit} is set
   *  (MOTIR-5719). */
  ci: PrCiState;
  /** The checks failing at the verdict's commit, by name, sorted — what a
   *  give-up names (MOTIR-5465). The pull request's OWN checks; a queue's failing
   *  check rides on `queueExit`. */
  failingChecks: string[];
  /** The standing merge-queue FAILURE that makes this pull request failing — set
   *  exactly when its latest exit is a failure, not re-queued, at its current head
   *  (`queueExitHoldsAtHead`), else null. */
  queueExit: RepairQueueExitDto | null;
  /** The host reports this pull request CONFLICTED with its base at its head (MOTIR-5913's
   *  stored reading) — a member failing for that alone has green checks and no exit. NOT on
   *  the wire: the v1 presenter copies fields by name, and this one is the page's. */
  conflicted: boolean;
}

/** Why the merge queue threw a pull request out, as the fixing agent is told it
 *  (Story MOTIR-5628 · MOTIR-5719). */
export interface RepairQueueExitDto {
  /** GitHub's own reason string — `CI_FAILURE`, `MERGE_CONFLICT`, … */
  rawReason: string;
  /** When the queue removed it, ISO-8601. */
  exitedAt: string;
  /** The head the queue tested — the pull request's current head. */
  headSha: string;
  /** The queue's failing check, when the attempt named one; null for a conflict. */
  failingCheckName: string | null;
  failingCheckUrl: string | null;
}

/** The result of one repair claim attempt. */
export interface WorkItemRepairClaimDto {
  key: string;
  title: string;
  outcome: WorkItemRepairOutcome;
  /** Set exactly when `outcome === 'not_repairable'`. */
  reason: WorkItemRepairRefusal | null;
  /** The run target's key, set exactly when `reason === 'repair_on_run_target'`. */
  runTargetKey: string | null;
  /** The `fix` run — set on `claimed`, `mine` and `taken`. */
  runId: string | null;
  /** Who opened that run — set on `claimed`, `mine` and `taken` (null only for
   *  an operator whose account has since been deleted). */
  holder: ClaimActorDto | null;
  /** When that run started, ISO-8601 — set on `claimed`, `mine` and `taken`. */
  startedAt: string | null;
  /** The failing OPEN pull requests — non-empty on `claimed` and `mine`, empty
   *  otherwise, so a refused caller is handed nothing to act on. */
  pullRequests: RepairPullRequestDto[];
}

/** A failing pull request as the Development block names it: `owner/name · #n`. */
export interface RepairPullRequestRefDto {
  repo: string;
  number: number;
  /** The pull request's OWN verdict — `passing` on a member failing only because
   *  the merge queue threw it out (MOTIR-5719). */
  ci: PrCiState;
  /** Set when the pull request is failing because the merge queue threw it out.
   *  With `ci`, it is what the Development block's which-to-use line reads: *a
   *  failing member whose own `ci` is not `failing` and which carries a standing
   *  queue exit* (`design/github/design-notes.md` § 26, MOTIR-5718). */
  queueExit: { rawReason: string; failingCheckName: string | null } | null;
  /** Set when the host reports the pull request conflicted at its head (MOTIR-5916; design
   *  § 30's fix part) — the line then says it conflicts with `baseRef` and cannot be merged,
   *  never *Checks are failing*, which would be false. */
  conflict: { baseRef: string | null } | null;
}

/**
 * What the item page's Development block draws about a repair (Story MOTIR-5460
 * · MOTIR-5466; design `design/github` § 21, Panels F1–F4).
 *
 * Derived from the SAME evaluation the repair claim makes, so the page never
 * offers a command the claim would refuse (§ 21: *"the part and the claim read
 * one predicate"*).
 *
 * - `hidden` — state 5: not implemented, nothing failing, or no pull request.
 * - `offer` — F1, or F3 when the card's latest `fix` run gave up (`lastGaveUp`).
 * - `in_progress` — F2: an open `fix` run holds the card.
 * - `pointer` — F4: the card's own failing pull requests belong to a run launched
 *   against `runTargetKey`, which is where the repair runs.
 */
export type WorkItemRepairViewDto =
  | { state: 'hidden' }
  | {
      state: 'offer';
      failing: RepairPullRequestRefDto[];
      /** The latest `fix` run ended `failed`: when, and after how many attempts
       *  (null when the run reported no count — a give-up older than the event). */
      lastGaveUp: { attempts: number | null; endedAt: string } | null;
    }
  | {
      state: 'in_progress';
      failing: RepairPullRequestRefDto[];
      holder: ClaimActorDto | null;
      /** The viewer started it — the copy says *you*. */
      byViewer: boolean;
      startedAt: string;
    }
  | { state: 'pointer'; failing: RepairPullRequestRefDto[]; runTargetKey: string };
