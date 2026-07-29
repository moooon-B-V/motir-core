import { formatTable, truncate } from './render.js';

// The PURE half of `motir auto` (Story 7.9 · Subtask 7.9.4 · MOTIR-882): what
// the loop DECIDES and what it REPORTS, with no MCP call, no spawn, no git and
// no stdout. The I/O half — the WHILE loop itself — lives in
// `commands/auto.ts`, so every decision below is unit-testable against a plain
// object.
//
// The loop's defining property is that it holds NO plan of the run. It asks the
// server for exactly ONE item per iteration and acts on that; the ready set
// changes underneath it (an integrated item unlocks its dependents mid-run), so
// any list materialized up front would be wrong by the second iteration. There
// is deliberately no function here that takes or returns a ready LIST.

/** What the loop does with one item the server handed it. */
export type ItemDisposition =
  /** A leaf a coding agent can execute — the normal case. */
  | 'dispatch'
  /** An UNEXPANDED epic/story: legitimately ready (the childless-container
   *  rule — a container WITH children never reaches the ready set), but it is a
   *  PLANNING item, and there is no agent prompt for "do the planning". Skipped
   *  and named; `motir auto --include-planning` (MOTIR-886) is what will instead
   *  trigger its expansion. */
  | 'needs_planning'
  /** Human work a coding agent cannot do (`type: manual` / `executor: human`).
   *  It has no branch and no pull request, so handing it to an agent would
   *  produce a confident lie rather than a deliverable. */
  | 'needs_human';

const CONTAINER_KINDS = new Set(['epic', 'story']);

/**
 * Decide what to do with one ready item — the loop's only classification, made
 * from the dispatch payload alone (no extra round-trip).
 *
 * The manual test mirrors the server's own `isManualReadyItem` predicate; it is
 * re-stated here rather than imported because the CLI is a standalone package
 * that cannot reach into the Next app, exactly as it re-states the workflow
 * status keys it names.
 */
export function classifyReadyItem(item: {
  kind: string;
  type?: string | null;
  executor?: string | null;
}): ItemDisposition {
  if (CONTAINER_KINDS.has(item.kind.toLowerCase())) return 'needs_planning';
  if (item.executor === 'human' || item.type === 'manual') return 'needs_human';
  return 'dispatch';
}

/** How one dispatched item ended. */
export type AutoOutcome =
  /** Agent exited 0 and the work was recorded on the session branch. */
  | 'integrated'
  /** Agent exited 0, but the server kept the item OFF the session lineage (it
   *  already belonged to another one), so it was moved to In Review instead. */
  | 'in_review'
  /** Agent exited non-zero. The item stays In Progress — nothing was reverted. */
  | 'failed';

export interface DispatchRecord {
  key: string;
  title: string | null;
  outcome: AutoOutcome;
  durationMs: number;
  /** The branch the work was integrated onto, when it was. */
  sessionBranch: string | null;
  repo: string | null;
  /** Extra detail for the summary (an exit code, a lineage note). */
  detail?: string;
}

export interface SkipRecord {
  key: string;
  title: string | null;
  reason: 'needs_planning' | 'needs_human';
}

/** One repo the run touched: its session branch and the items carried on it. */
export interface RepoSession {
  repoName: string | null;
  cwd: string;
  branch: string;
  keys: string[];
}

/** Why the loop stopped — every exit path is named, so the summary can say. */
export type StopReason =
  /** `next_ready` returned nothing: the ready set is drained. */
  | 'drained'
  /** `--max <n>` reached. */
  | 'max'
  /** An agent failed and `--keep-going` was not passed. */
  | 'halted'
  /** Ctrl-C. */
  | 'interrupted';

export interface PrReport {
  repoName: string | null;
  branch: string;
  url: string | null;
  outcome: 'opened' | 'existing' | 'failed' | 'empty';
  message?: string;
}

export interface AutoSummary {
  runId: string;
  records: DispatchRecord[];
  skipped: SkipRecord[];
  repos: RepoSession[];
  prs: PrReport[];
  stopReason: StopReason;
}

/** `1m 04s` / `12s` — a duration a human reads at a glance. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

const OUTCOME_LABEL: Record<AutoOutcome, string> = {
  integrated: 'integrated',
  in_review: 'in review',
  failed: 'FAILED',
};

const STOP_LABEL: Record<StopReason, string> = {
  drained: 'the ready set is drained',
  max: '--max reached',
  halted: 'halted on the first agent failure (--keep-going continues past one)',
  interrupted: 'interrupted (Ctrl-C)',
};

const SKIP_LABEL: Record<SkipRecord['reason'], string> = {
  needs_planning: 'needs planning',
  needs_human: 'needs a human',
};

/** The PR title for a session branch. Carries NO `MOTIR-<n>`: see
 *  {@link import('./git.js').sessionBranchName} for why a session PR must not
 *  name one item. */
export function sessionPrTitle(runId: string, itemCount: number): string {
  return `Motir auto run ${runId} — ${itemCount} work item${itemCount === 1 ? '' : 's'}`;
}

/**
 * The PR body: every item this branch carries, plus the close-out instruction.
 * The keys live HERE rather than in the title precisely because the status sync
 * does not parse a body — so a reviewer gets full traceability while the run's
 * many items stay un-linked to this one PR.
 */
export function renderSessionPrBody(
  runId: string,
  branch: string,
  records: DispatchRecord[],
): string {
  const carried = records.filter((r) => r.outcome !== 'failed');
  const failed = records.filter((r) => r.outcome === 'failed');
  const lines = [
    `Unattended \`motir auto\` run \`${runId}\`, integrated on \`${branch}\`.`,
    '',
    `## Work items carried (${carried.length})`,
    '',
    ...carried.map((r) => `- ${r.key} — ${r.title ?? '(untitled)'}`),
  ];
  if (failed.length > 0) {
    lines.push(
      '',
      `## Attempted and failed (${failed.length}) — still In Progress, not in this branch`,
      '',
      ...failed.map((r) => `- ${r.key} — ${r.title ?? '(untitled)'}`),
    );
  }
  lines.push(
    '',
    '## Close-out',
    '',
    'Review this pull request as ONE unit. After merging it, run:',
    '',
    '```',
    `motir done --session ${branch}`,
    '```',
    '',
    'That flips every item recorded on the branch to Done and clears the recorded',
    'branch. If the pull request is rejected instead, the items honestly stay In',
    'Review — flip them back or re-dispatch them.',
  );
  return lines.join('\n');
}

const SUMMARY_HEADERS = ['ITEM', 'OUTCOME', 'TIME', 'BRANCH', 'TITLE'];

/** The end-of-run summary block: the dispatch table, then everything the run
 *  did NOT do — which is the half a human has to act on. */
export function renderAutoSummary(summary: AutoSummary, titleWidth = 44): string {
  const blocks: string[] = [];
  blocks.push(`Run ${summary.runId} — stopped: ${STOP_LABEL[summary.stopReason]}.`);

  if (summary.records.length === 0) {
    blocks.push('No work items were dispatched.');
  } else {
    const rows = summary.records.map((r) => [
      r.key,
      OUTCOME_LABEL[r.outcome] + (r.detail ? ` (${r.detail})` : ''),
      formatDuration(r.durationMs),
      r.sessionBranch ?? '—',
      truncate(r.title ?? '', titleWidth),
    ]);
    blocks.push(formatTable(SUMMARY_HEADERS, rows));
  }

  for (const reason of ['needs_planning', 'needs_human'] as const) {
    const group = summary.skipped.filter((s) => s.reason === reason);
    if (group.length === 0) continue;
    blocks.push(
      [
        `Skipped — ${SKIP_LABEL[reason]} (${group.length}):`,
        ...group.map((s) => `  ${s.key} — ${truncate(s.title ?? '', titleWidth)}`),
      ].join('\n'),
    );
  }

  const inReview = summary.records.filter((r) => r.outcome !== 'failed');
  if (inReview.length > 0) {
    blocks.push(
      [
        `In Review — awaiting your merge (${inReview.length}):`,
        ...inReview.map((r) => `  ${r.key} on ${r.sessionBranch ?? '(no branch recorded)'}`),
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

  if (summary.prs.length > 0) {
    blocks.push(['Pull requests:', ...summary.prs.map(prLine)].join('\n'));
  }
  return blocks.join('\n\n');
}

function prLine(pr: PrReport): string {
  const repo = pr.repoName ?? 'the checkout';
  switch (pr.outcome) {
    case 'opened':
      return `  ${repo}: ${pr.url ?? pr.branch} (opened)`;
    case 'existing':
      return `  ${repo}: ${pr.url ?? pr.branch} (already open — updated by this run)`;
    case 'empty':
      return `  ${repo}: no pull request — ${pr.branch} carries no commits beyond main.`;
    case 'failed':
      return (
        `  ${repo}: NOT opened. ${pr.message ?? ''}\n` +
        `    The work IS pushed to ${pr.branch} — open the pull request by hand, then ` +
        `\`motir done --session ${pr.branch}\`.`
      );
  }
}

/** The process exit code for a finished run: non-zero when anything needs the
 *  human's attention as a FAILURE (an interrupted run included). */
export function autoExitCode(summary: AutoSummary): number {
  if (summary.records.some((r) => r.outcome === 'failed')) return 1;
  if (summary.stopReason === 'interrupted') return 130;
  return 0;
}
