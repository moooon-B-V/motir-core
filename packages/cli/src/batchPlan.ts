import { formatTable, truncate } from './render.js';
import { classifyReadyItem, formatDuration } from './autoLoop.js';

// The PURE half of `motir batch` (Story 7.9 · Subtask 7.9.10 · MOTIR-888): what
// the SNAPSHOT contains, what is left out of it and why, and what the run
// reports — with no MCP call, no spawn, no git and no stdout. The I/O half — the
// drain over the frozen list — lives in `commands/batch.ts`.
//
// ── batch is the INVERSE of auto, and that is the whole point ────────────────
// `motir auto` holds no plan of the run: it asks for ONE item per iteration and
// follows the ready set as it changes. `batch` deliberately does the opposite —
// it FREEZES the ready set once, up front, and implements exactly those items.
// An item that becomes ready during the run is NOT picked up; it is counted and
// named, so the human can re-run `batch` or reach for `auto` instead.
//
// ── why a frozen snapshot needs NO session branch ────────────────────────────
// A STRICTLY-main-ready snapshot is mutually independent by construction: an
// item is in it only when every dependency is DONE ON MAIN, so no snapshot item
// can depend on another snapshot item (it would not have been ready). Each item
// therefore rides the 7.9.3 per-item flow unchanged — its own branch off
// origin/main in its own repo, its own pull request targeting main. Nothing in
// this command creates a session branch, and nothing calls `mark_integrated`;
// main still moves only through a human-merged pull request.
//
// That independence is exactly what {@link classifySnapshotItem}'s lineage gate
// protects: an item that is ready ONLY because a dependency is integrated-
// awaiting-review (7.8.11) has a dependency whose code is NOT on main, so a
// pull request of its own against main could not even build. Those belong to
// `auto`'s session territory and are excluded here by name.

/** What the snapshot does with one ready item the server offered. */
export type SnapshotDisposition =
  /** A leaf a coding agent can execute, with every dependency done on main. */
  | 'take'
  /** An UNEXPANDED epic/story — a planning item with no agent prompt (the
   *  7.9.4 rule, shared verbatim via {@link classifyReadyItem}). There is no
   *  `--include-planning` here on purpose: an expansion's output could never
   *  join a frozen snapshot. */
  | 'needs_planning'
  /** Human work a coding agent cannot do (`type: manual` / `executor: human`). */
  | 'needs_human'
  /** Ready ONLY via an integrated-awaiting-review dependency (7.8.11): the
   *  dependency's code is not on main, so this item cannot ship a per-item pull
   *  request against main. `motir auto` is the command for that lineage. */
  | 'integrated_dep';

/**
 * Decide whether one ready item belongs in the snapshot.
 *
 * The planning / human split DELEGATES to `motir auto`'s {@link
 * classifyReadyItem}, so the two loops can never disagree about what a coding
 * agent may be handed. The lineage gate is applied only to what would otherwise
 * be dispatched: a container that needs planning is reported as needing
 * planning whether or not it also inherits a branch, which is the more
 * actionable answer for a human reading the summary.
 *
 * `sessionBranch` on a ready dispatch payload is the INHERITED lineage — the
 * single session branch this item's integrated dependencies live on
 * (`getReadiness().inheritedSessionBranch`). Non-null therefore means precisely
 * "ready, but not from main".
 */
export function classifySnapshotItem(item: {
  kind: string;
  type?: string | null;
  executor?: string | null;
  sessionBranch?: string | null;
}): SnapshotDisposition {
  const shared = classifyReadyItem(item);
  if (shared !== 'dispatch') return shared;
  if (item.sessionBranch) return 'integrated_dep';
  return 'take';
}

/** One item the snapshot TOOK — frozen at snapshot time, in dispatch order. */
export interface SnapshotEntry {
  id: string;
  key: string;
  title: string | null;
  kind: string;
  targetRepo: string | null;
  /** The status key as of the snapshot, so the drain can skip a redundant
   *  `todo → in_progress` flip (the same guard `ensureInProgress` applies). */
  statusKey?: string | undefined;
}

/** One item the snapshot left out, with the reason a human needs. */
export interface SnapshotSkip {
  key: string;
  title: string | null;
  reason: Exclude<SnapshotDisposition, 'take'>;
}

/** The frozen plan of the run: what will be implemented, and what will not. */
export interface Snapshot {
  taken: SnapshotEntry[];
  skipped: SnapshotSkip[];
}

/** How one dispatched item ended. */
export type BatchOutcome =
  /** Agent exited 0; its own pull request is open, so the item is In Review. */
  | 'in_review'
  /** Agent exited non-zero. The item stays In Progress — nothing was reverted. */
  | 'failed';

export interface BatchRecord {
  key: string;
  title: string | null;
  outcome: BatchOutcome;
  durationMs: number;
  repo: string | null;
  /** Extra detail for the summary (an exit code, a bootstrap miss). */
  detail?: string;
}

/** Why the drain stopped — every exit path is named, so the summary can say. */
export type BatchStopReason =
  /** Every snapshot item was attempted. */
  | 'completed'
  /** `--max <n>` reached. */
  | 'max'
  /** An agent failed and `--keep-going` was not passed. */
  | 'halted'
  /** Ctrl-C. */
  | 'interrupted';

export interface BatchSummary {
  records: BatchRecord[];
  /** Everything left out of the snapshot, plus anything refused at dispatch
   *  time because its lineage appeared after the snapshot was frozen. */
  skipped: SnapshotSkip[];
  /** Snapshot items the run never reached (`--max`, a halt, or Ctrl-C). */
  notReached: SnapshotEntry[];
  /** Items that became ready DURING the run — deliberately not dispatched. */
  newlyReady: { key: string; title: string | null }[];
  stopReason: BatchStopReason;
}

const OUTCOME_LABEL: Record<BatchOutcome, string> = {
  in_review: 'in review',
  failed: 'FAILED',
};

const STOP_LABEL: Record<BatchStopReason, string> = {
  completed: 'the whole snapshot was attempted',
  max: '--max reached',
  halted: 'halted on the first agent failure (--keep-going continues past one)',
  interrupted: 'interrupted (Ctrl-C)',
};

const SKIP_LABEL: Record<SnapshotSkip['reason'], string> = {
  needs_planning: 'needs planning',
  needs_human: 'needs a human',
  integrated_dep: 'ready only via an integrated dependency (not on main)',
};

/** The reasons in the order the summary groups them. */
const SKIP_ORDER: SnapshotSkip['reason'][] = ['needs_planning', 'needs_human', 'integrated_dep'];

const PLAN_HEADERS = ['ITEM', 'KIND', 'REPO', 'TITLE'];

/**
 * The snapshot, printed UP FRONT — before a single agent starts.
 *
 * This is the command's contract made visible: the human sees the exact,
 * complete list the run will implement, and can Ctrl-C before anything is
 * touched. A `batch` that only reported afterwards would be indistinguishable
 * from `auto` at the moment it matters.
 */
export function renderSnapshotPlan(snapshot: Snapshot, titleWidth = 44): string {
  const blocks: string[] = [];
  const { taken, skipped } = snapshot;

  if (taken.length === 0) {
    blocks.push('Snapshot: no work items to implement.');
  } else {
    blocks.push(
      `Snapshot: ${taken.length} work item${taken.length === 1 ? '' : 's'} — ` +
        'this exact list, one at a time. Items that become ready during the run are NOT picked up.',
    );
    blocks.push(
      formatTable(
        PLAN_HEADERS,
        taken.map((e) => [e.key, e.kind, e.targetRepo ?? '—', truncate(e.title ?? '', titleWidth)]),
      ),
    );
  }
  blocks.push(...renderSkipGroups(skipped, titleWidth));
  return blocks.join('\n\n');
}

function renderSkipGroups(skipped: SnapshotSkip[], titleWidth: number): string[] {
  const blocks: string[] = [];
  for (const reason of SKIP_ORDER) {
    const group = skipped.filter((s) => s.reason === reason);
    if (group.length === 0) continue;
    const lines = [
      `Not in the snapshot — ${SKIP_LABEL[reason]} (${group.length}):`,
      ...group.map((s) => `  ${s.key} — ${truncate(s.title ?? '', titleWidth)}`),
    ];
    if (reason === 'integrated_dep') {
      lines.push('  Run these with `motir auto`, which carries that lineage on a session branch.');
    }
    blocks.push(lines.join('\n'));
  }
  return blocks;
}

const SUMMARY_HEADERS = ['ITEM', 'OUTCOME', 'TIME', 'REPO', 'TITLE'];

/** The end-of-run summary: what ran, then everything the run did NOT do —
 *  which is the half a human has to act on. */
export function renderBatchSummary(summary: BatchSummary, titleWidth = 44): string {
  const blocks: string[] = [];
  blocks.push(`Batch finished — stopped: ${STOP_LABEL[summary.stopReason]}.`);

  if (summary.records.length === 0) {
    blocks.push('No work items were dispatched.');
  } else {
    blocks.push(
      formatTable(
        SUMMARY_HEADERS,
        summary.records.map((r) => [
          r.key,
          OUTCOME_LABEL[r.outcome] + (r.detail ? ` (${r.detail})` : ''),
          formatDuration(r.durationMs),
          r.repo ?? '—',
          truncate(r.title ?? '', titleWidth),
        ]),
      ),
    );
  }

  const inReview = summary.records.filter((r) => r.outcome === 'in_review');
  if (inReview.length > 0) {
    blocks.push(
      [
        `In Review — each has its OWN pull request to merge (${inReview.length}):`,
        ...inReview.map((r) => `  ${r.key} — review + merge it, then \`motir done ${r.key}\``),
      ].join('\n'),
    );
  }

  const failed = summary.records.filter((r) => r.outcome === 'failed');
  if (failed.length > 0) {
    blocks.push(
      [
        `Failed — still In Progress, nothing reverted (${failed.length}):`,
        ...failed.map((r) => `  ${r.key} — re-run it with \`motir run ${r.key}\``),
      ].join('\n'),
    );
  }

  if (summary.notReached.length > 0) {
    blocks.push(
      [
        `Not reached — still in the snapshot, never started (${summary.notReached.length}):`,
        ...summary.notReached.map((e) => `  ${e.key} — ${truncate(e.title ?? '', titleWidth)}`),
        '  Re-run `motir batch` to take a fresh snapshot including these.',
      ].join('\n'),
    );
  }

  blocks.push(...renderSkipGroups(summary.skipped, titleWidth));

  if (summary.newlyReady.length > 0) {
    blocks.push(
      [
        `${summary.newlyReady.length} became ready during the run — NOT dispatched ` +
          '(a snapshot is frozen on purpose):',
        ...summary.newlyReady.map((n) => `  ${n.key} — ${truncate(n.title ?? '', titleWidth)}`),
        '  Re-run `motir batch`, or use `motir auto` to follow the ready set live.',
      ].join('\n'),
    );
  }
  return blocks.join('\n\n');
}

/** The process exit code for a finished batch: non-zero when anything needs the
 *  human's attention as a FAILURE (an interrupted run included). */
export function batchExitCode(summary: BatchSummary): number {
  if (summary.records.some((r) => r.outcome === 'failed')) return 1;
  if (summary.stopReason === 'interrupted') return 130;
  return 0;
}
