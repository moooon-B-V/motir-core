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
 * - `not_implemented` — archived, or not at the project's Implemented rung. A red
 *   build is only a repair's business once the run that built it has ended.
 * - `repair_on_run_target` — the pull requests belong to a run launched against
 *   another card (`runTargetKey`); the repair runs there, never on a child the
 *   same pull requests also deliver.
 * - `no_pull_requests` — the card has no delivery rows at all.
 * - `ci_running` — nothing open is failing, and at least one member is running.
 * - `not_failing` — nothing open is failing and nothing is running.
 */
export type WorkItemRepairRefusal =
  | 'not_implemented'
  | 'repair_on_run_target'
  | 'no_pull_requests'
  | 'ci_running'
  | 'not_failing';

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
  /** Always `failing` today; carried so a reader never has to assume it. */
  ci: PrCiState;
  /** The checks failing at the verdict's commit, by name, sorted — what a
   *  give-up names (MOTIR-5465). */
  failingChecks: string[];
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
