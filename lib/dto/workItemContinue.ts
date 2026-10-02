import type { ClaimActorDto } from '@/lib/dto/claim';
import type {
  DispatchCommand,
  DispatchRunOrigin,
  DispatchRunStatus,
  DispatchStopReason,
} from '@/generated/prisma/client';

// The CONTINUE CLAIM result (Story MOTIR-6526 · MOTIR-6532,
// `docs/decisions/run-death-keeps-work.md` §4).
//
// A work item whose last run DIED keeps its status and its branch. `POST
// /api/v1/work-items/{key}/continue` hands that branch to ONE continuing agent: it
// opens a dispatch run with command `continue`, and that open run is the lock. The
// item is re-assigned to the claimant — the one card write — and its STATUS is
// never written.
//
// Like the repair claim (`lib/dto/workItemRepair.ts`), a refusal is a RESULT and
// not an error, and it DISCRIMINATES: the caller's next move is different for each.

/**
 * What a continue claim resolved to.
 *
 * - `claimed` — the item is the caller's now; a `continue` run was opened for it.
 * - `mine` — the caller already holds the open `continue` run: a resumed
 *   continue. The same run is returned, and no second one is opened.
 * - `taken` — somebody else holds the open `continue` run. Named, with its start.
 * - `not_continuable` — there is nothing to continue; `reason` says why.
 */
export type WorkItemContinueOutcome = 'claimed' | 'mine' | 'taken' | 'not_continuable';

/**
 * Why an item cannot be continued, checked in this order.
 *
 * - `run_alive` — a run holding the item is still ALIVE (`isRunAlive`); its
 *   dispatcher is named in `holder`.
 * - `use_fix` — the item is at Implemented / In Review / Approved: its pull
 *   request is open, CI decides, and a red one is `motir fix`'s.
 * - `not_in_progress` — any other status that is not In Progress (To Do, Blocked,
 *   Planning, Done…): `motir run` is the door, or nothing is.
 * - `continue_the_parent` — the dead run was a PARENT run and this item one of its
 *   legs; the parent is continued as a whole (`parentKey`).
 * - `no_dead_run` — no run on this item ended without success.
 * - `no_branch` — the dead run left no branch to continue on; start over instead.
 */
export type WorkItemContinueRefusal =
  | 'run_alive'
  | 'use_fix'
  | 'not_in_progress'
  | 'continue_the_parent'
  | 'no_dead_run'
  | 'no_branch';

/** The run that died — what the continuing agent is told it is continuing. */
export interface DeadRunDto {
  id: string;
  command: DispatchCommand;
  /** `instance` — a run in the developer's own agent (MOTIR-7023) can die and be continued. */
  origin: DispatchRunOrigin;
  status: DispatchRunStatus;
  /** Null for a run the claim found lapsed and closed itself (then `abandoned`). */
  stopReason: DispatchStopReason | null;
  /** When it started — the *run by* line names it. */
  startedAt: string;
  /** When it was last heard from: its last heartbeat, else its end, else its start. */
  lastHeardAt: string;
  /** Who ran it (null when that account has since been deleted). */
  dispatcher: ClaimActorDto | null;
}

/** The pull request the dead run left open, as the Development row names it. */
export interface ContinuePullRequestDto {
  repo: string;
  number: number;
  url: string;
  headRef: string;
}

/**
 * Where ONE repository's share of a dead run's work is (MOTIR-6791). A run that
 * spanned several repositories pushed a branch in each, and each is continued.
 *
 * `repository` is the repository NAME as the card's `targetRepos` names it, or
 * null when the run recorded a branch without saying where (a run older than
 * the per-repository checkpoint, or a session branch — one name everywhere).
 */
export interface ContinueBranchDto {
  repository: string | null;
  branch: string;
  /** The open pull request this repository's branch heads, when there is one —
   *  its head is then the branch, whatever the checkpoint recorded. */
  pullRequest: ContinuePullRequestDto | null;
}

/** The result of one continue claim attempt. */
export interface WorkItemContinueClaimDto {
  key: string;
  title: string;
  outcome: WorkItemContinueOutcome;
  /** Set exactly when `outcome === 'not_continuable'`. */
  reason: WorkItemContinueRefusal | null;
  /** The parent's key, set exactly when `reason === 'continue_the_parent'`. */
  parentKey: string | null;
  /** The `continue` run — set on `claimed`, `mine` and `taken`. */
  runId: string | null;
  /** Who holds the item: the `continue` run's opener (claimed / mine / taken), or
   *  the LIVE run's dispatcher (`run_alive`). */
  holder: ClaimActorDto | null;
  /** When the holder's run started, ISO-8601. */
  startedAt: string | null;
  /** The run that died — set on `claimed` and `mine`. */
  deadRun: DeadRunDto | null;
  /** The branch to continue on — set on `claimed` and `mine`. The PRIMARY
   *  repository's entry of `branches`; kept for readers that know one branch. */
  branch: string | null;
  /** Every repository's branch to continue on, primary first — set on `claimed`
   *  and `mine`, empty otherwise (MOTIR-6791). */
  branches: ContinueBranchDto[];
  /** The open pull request the dead run left, when there is one. */
  pullRequest: ContinuePullRequestDto | null;
  /** Who the item was assigned to before this claim took it over. */
  previousAssignee: ClaimActorDto | null;
  /**
   * `parent` when the dead run was a SCOPED run over this container (MOTIR-6535):
   * the continue resumes the whole scope on `branch`, the session branch. `card`
   * otherwise.
   */
  mode: 'card' | 'parent';
  /** The dead scope run's legs that already LANDED (Implemented or later) — never
   *  re-dispatched. Empty for a card. */
  landedKeys: string[];
  /** The dead scope run's legs still IN FLIGHT — In Progress, and re-assigned to
   *  the caller by this claim. The ready set lists only To Do leaves, so these are
   *  named here for the resumed drain to run again. Empty for a card. */
  resumedKeys: string[];
}

/** How a run ended without success, as the *run died* marker's reason line says it. */
export type RunDiedReason =
  | 'lapsed'
  | 'interrupted'
  | 'failed'
  | 'cancelled'
  | 'stalled'
  | 'backstop';

/**
 * What the item page draws about a run that died (MOTIR-6534; design
 * `design/runs/design-notes.md` § Run died). Derived from the SAME evaluation the
 * claim makes, so the page never offers a command the claim would refuse.
 *
 * - `none` — never run, or the last run succeeded: nothing to draw.
 * - `alive` — a run holding the item is alive: nothing to draw either.
 * - `died` — the last run died. `refusal` is what the claim would answer, or null
 *   when it would take the item (the D1 / D2 panels offer the command).
 * - `continuing` — an open `continue` run holds the item.
 */
export type WorkItemContinueViewDto =
  | { state: 'none' }
  | { state: 'alive' }
  | {
      state: 'died';
      deadRun: DeadRunDto;
      /** How it ended — the design's reason line (D3). */
      reason: RunDiedReason;
      /** The primary repository's branch — `branches[0]`, or null when none. */
      branch: string | null;
      /** Every repository's branch, primary first (MOTIR-6791). Empty is the
       *  *nothing pushed* case: no repository has a branch. */
      branches: ContinueBranchDto[];
      pullRequest: ContinuePullRequestDto | null;
      /** Null when the claim would take it; otherwise the refusal it would give
       *  (`use_fix`, `continue_the_parent`, `no_branch`, `not_in_progress`). */
      refusal: Exclude<WorkItemContinueRefusal, 'run_alive' | 'no_dead_run'> | null;
      /** Set with `continue_the_parent`. */
      parentKey: string | null;
    }
  | {
      state: 'continuing';
      holder: ClaimActorDto | null;
      byViewer: boolean;
      /** Where the continue runs — a HOSTED one says so on the card (MOTIR-6796). */
      origin: 'local' | 'hosted';
      startedAt: string;
      branch: string | null;
      /** Every repository's branch the continue took over (MOTIR-6791). */
      branches: ContinueBranchDto[];
      /** Whose run the continue took over, when the claim recorded it. */
      tookOverFrom: { runId: string; dispatcher: ClaimActorDto | null } | null;
    };

/**
 * A CONTINUE run's LIVENESS as the agent holding it reads it — what
 * `touch_work_item_continue` and `close_work_item_continue` answer (Story
 * MOTIR-7261 · MOTIR-7262). The repair tools' `WorkItemRepairRunDto`, one
 * lifecycle over.
 *
 * `open: false` is the signal to STOP: the run was closed — by the agent itself,
 * by the lapsed-heartbeat reap, or by anyone else — and the card no longer reads
 * *being continued*, so a second agent may already be on its branch.
 */
export interface WorkItemContinueRunDto {
  key: string;
  runId: string;
  open: boolean;
  /** The run's status — `running` while open. */
  status: DispatchRunStatus;
  /** Why it ended; null while open. `abandoned` is the reap's. */
  stopReason: DispatchStopReason | null;
  /** ISO-8601. */
  startedAt: string;
  /** ISO-8601; null while open. */
  endedAt: string | null;
  /** ISO-8601; the last `touch_work_item_continue` (or the claim's own first beat). */
  lastHeartbeatAt: string | null;
}
