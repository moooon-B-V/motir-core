import { formatTable, truncate } from './render.js';
import type { SessionCommit } from './git.js';

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
  /** Agent exited 0 and its work reached the remote, but the server kept the item
   *  OFF the session lineage (it already belonged to another one), so it opened a
   *  pull request of its own and was moved to Implemented instead — CI decides
   *  when that becomes In Review (MOTIR-3004). */
  | 'implemented'
  /** Agent exited non-zero. The item stays In Progress — nothing was reverted. */
  | 'failed'
  /**
   * The agent REFUSED the card: it found the premise false, reverted, commented
   * the finding, left the card in `planning` and submitted a re-plan for a human
   * (MOTIR-3018). Exit 0, and NOT a success — nothing was built and nothing
   * reached a branch.
   *
   * ⚠️ IT IS ALSO NOT A FAILURE, and every consumer has to be told which. It
   * does not open a pull request, it is not listed among the cards a session
   * branch carries, it does not set a failing exit code, and it does not consult
   * `--keep-going` — the run stops because the prompt told the agent to stop,
   * not because anything went wrong.
   */
  | 'replanned';

export interface DispatchRecord {
  key: string;
  title: string | null;
  outcome: AutoOutcome;
  durationMs: number;
  /** The branch the work was integrated onto, when it was. */
  sessionBranch: string | null;
  repo: string | null;
  /**
   * EVERY repository the card ships in (MOTIR-3135), primary first — `[]` when
   * it names none, so `repo` is `repos[0] ?? null`.
   *
   * The scalar alone is not enough at close-out: a FAILED record is matched to a
   * repository's session pull request by name, and a card that failed while
   * carrying two repositories belongs in BOTH of their bodies. Matching on the
   * primary would silently drop it from the other one — a half-done card missing
   * from the review surface of the repository it half-touched.
   */
  repos?: string[];
  /**
   * The card's PARENT key, or `null` for a top-level item (MOTIR-2422).
   *
   * Carried on the record because the TITLE is decided at close-out, from the
   * whole set — and it costs nothing: it rides the dispatch prompt the loop
   * already fetches per item (MOTIR-2445).
   */
  parentKey: string | null;
  /** Extra detail for the summary (an exit code, a lineage note). */
  detail?: string;
}

export interface SkipRecord {
  key: string;
  title: string | null;
  reason: 'needs_planning' | 'needs_human';
}

/** How ONE `--include-planning` expansion trigger ended (MOTIR-886).
 *
 *  Note what is NOT here: an `expanded` / `children` outcome. The job produces a
 *  Plan of PROPOSALS, and approving that plan — in Motir, by a human — is the
 *  only thing that turns a proposal into a work item. The run's whole job is to
 *  FIRE the planning and say so; it can never report children it did not create.
 *  The vocabulary mirrors the shipped server-side cadence trigger (MOTIR-916):
 *  fired / skipped / failed. */
export interface PlanningRecord {
  key: string;
  title: string | null;
  /** `triggered` — the job was accepted; `failed` — the submit was refused. */
  outcome: 'triggered' | 'failed';
  /** The plan the job writes its proposals into — the thing to review. */
  planId: string | null;
  /** Where to review it, when the run knew the server URL. */
  reviewUrl: string | null;
  /** Why it failed, verbatim from the server's own typed error. */
  detail?: string;
}

/**
 * One plan the run APPROVED on its own (MOTIR-3023) — what
 * `--auto-approve-replan` actually did to the operator's tree.
 *
 * ⚠️ THE SUMMARY OWES THIS MORE THAN ANYTHING ELSE IN THE RUN. Every other
 * record says what the loop BUILT; this one says what it DECIDED, while nobody
 * was watching, about a plan someone else owns. The first thing they read in the
 * morning should be what changed, not a tree that is quietly different.
 */
export interface ApprovalRecord {
  /** The card whose refusal produced the plan. */
  key: string;
  /** The plan that was approved — the id to open in Motir. */
  planId: string;
  /** How many proposals it carried. */
  proposalCount: number;
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
  | 'interrupted'
  /**
   * An agent submitted a re-plan (MOTIR-3018). The loop stops rather than
   * picking up other work, which is what the prompt's own THE-CARD-IS-WRONG
   * branch instructs — and what a human deciding on a plan needs, since the
   * cards the loop would take next are the ones that plan may be about to
   * change.
   *
   * Distinct from `halted` on purpose: `halted` means something went wrong and
   * `autoExitCode` reports it; this is a correct outcome and exits 0.
   */
  | 'replanned';

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
  /** The expansions `--include-planning` fired. Empty without the flag, in which
   *  case the planning items appear under {@link AutoSummary.skipped} instead. */
  planning: PlanningRecord[];
  repos: RepoSession[];
  prs: PrReport[];
  /** The plans `--auto-approve-replan` approved. Empty without the flag, and
   *  empty with it when no agent refused a card. */
  approvals: ApprovalRecord[];
  stopReason: StopReason;
}

/** The review surface for a submitted plan — `<server>/plans/<id>`, the same
 *  route the in-app generation hand-off links to. Built from the run's own
 *  server URL so the summary line is clickable rather than a bare id. */
export function planReviewUrl(serverUrl: string, planId: string): string | null {
  try {
    return new URL(`/plans/${encodeURIComponent(planId)}`, serverUrl).toString();
  } catch {
    // A server URL the CLI could not parse is not worth failing a run over — the
    // planId alone still identifies the plan.
    return null;
  }
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
  implemented: 'implemented',
  failed: 'FAILED',
  replanned: 're-planned',
};

/**
 * Did this dispatch put code somewhere? The partition every consumer needs, and
 * the reason it is a named predicate rather than `outcome !== 'failed'`.
 *
 * ⚠️ `!== 'failed'` WAS TOTAL AND STOPPED BEING SO (MOTIR-3018). With two
 * outcomes it read as "landed"; with `replanned` added, every site spelling it
 * that way silently claims a refused card as delivered work — listing it under
 * *Implemented*, naming it in a pull-request title, and putting it in the body
 * as a card the branch carries. A predicate that enumerates what it INCLUDES
 * cannot rot the same way: a future outcome is excluded until someone decides
 * otherwise, which is the safe direction for a claim about shipped code.
 */
export function landedWork(record: Pick<DispatchRecord, 'outcome'>): boolean {
  return record.outcome === 'integrated' || record.outcome === 'implemented';
}

const STOP_LABEL: Record<StopReason, string> = {
  drained: 'the ready set is drained',
  max: '--max reached',
  halted: 'halted on the first agent failure (--keep-going continues past one)',
  interrupted: 'interrupted (Ctrl-C)',
  replanned: 'an agent refused its card and submitted a re-plan — waiting for you in Motir',
};

const SKIP_LABEL: Record<SkipRecord['reason'], string> = {
  needs_planning: 'needs planning',
  needs_human: 'needs a human',
};

/** The PR title for a session branch. Carries NO `MOTIR-<n>`: see
 *  {@link import('./git.js').sessionBranchName} for why a session PR must not
 *  name one item. */
export function sessionPrTitle(
  runId: string,
  carried: readonly Pick<DispatchRecord, 'key' | 'title' | 'parentKey'>[],
): string {
  const count = carried.length;
  const fallback = `Motir auto run ${runId} — ${count} work item${count === 1 ? '' : 's'}`;

  // ⚠️ ONE card: the CARD is the deliverable, and its parent describes something
  // much larger than what shipped. Naming the story here would overstate a
  // single subtask as its whole feature.
  const only = count === 1 ? carried[0] : undefined;
  if (only) return fitTitle(`${only.key}${only.title ? ` ${only.title}` : ''}`);

  // ⚠️ SHARED means EVERY card, and a `null` counts as a distinct answer. A set
  // containing a top-level card does not share a parent, so it falls back rather
  // than naming the story the OTHERS happen to sit under — a title that says
  // less beats one that says something untrue.
  const parents = new Set(carried.map((r) => r.parentKey));
  const shared = parents.size === 1 ? [...parents][0] : null;
  if (!shared) return fallback;

  return fitTitle(`${shared} — ${count} work items`);
}

/**
 * GitHub renders a pull-request title in a list at roughly this width before it
 * elides; stating the budget here beats discovering it in the UI. Titles are
 * built to fit rather than trimmed after the fact, so the elision — when it
 * happens — falls at the end of a card title, never mid-key.
 */
const TITLE_BUDGET = 72;

function fitTitle(title: string): string {
  return title.length <= TITLE_BUDGET ? title : `${title.slice(0, TITLE_BUDGET - 1).trimEnd()}…`;
}

/**
 * The PR body: the LOOP's frame around the AGENTS' own commit messages
 * (MOTIR-2411).
 *
 * ── Who writes what, and why neither can do the other's job ────────────────
 * The body used to be a MANIFEST — one `- KEY — title` line per card. Fully
 * traceable, and it said nothing about what the branch DOES. A card title is
 * what was PLANNED; the commit is what was DONE, including everything that only
 * surfaced while doing it, and those diverge.
 *
 * So: **the AGENT writes the substance** — one card, one commit, composed at the
 * moment it had the most context it will ever have (11.5.25 tells it that this
 * message becomes this body). **The loop writes the frame** — which run, which
 * branch, what failed, how to close out. An agent saw one card and can know none
 * of that; the loop knows the run and nothing about what the change means.
 *
 * ⚠️ It reads the COMMITS, it does not reconstruct them from `records`. An
 * implementation that kept building from `DispatchRecord[]` and merely appended
 * a subject would look right in a single-repo test and silently drop any commit
 * the loop did not record — which is exactly the commit a reviewer most needs
 * told about.
 *
 * ⚠️ KNOWN LIMIT, not papered over: concatenated commits do not SYNTHESISE.
 * Four commits that together deliver one capability read as four changes. Saying
 * "these four do X" needs something that read the whole diff — a close-out agent
 * call, which is MOTIR-2423. This gets most of the value for none of that cost.
 */
export function renderSessionPrBody(
  runId: string,
  branch: string,
  records: DispatchRecord[],
  commits: SessionCommit[] = [],
): string {
  const carried = records.filter(landedWork);
  const failed = records.filter((r) => r.outcome === 'failed');
  const lines = [
    `Unattended \`motir auto\` run \`${runId}\`, integrated on \`${branch}\`.`,
    '',
    `## Work items carried (${carried.length})`,
    '',
    ...carried.map((r) => `- ${r.key} — ${r.title ?? '(untitled)'}`),
  ];

  if (commits.length > 0) {
    lines.push('', `## What the commits say (${commits.length})`, '');
    for (const [index, commit] of commits.entries()) {
      if (index > 0) lines.push('');
      lines.push(`### ${commit.subject}`);
      // A THIN commit degrades to the card's title rather than to a bare
      // subject with nothing under it — today's output, not worse than it. The
      // pairing is positional because one card is one commit, in dispatch order.
      const fallback = carried[index]?.title;
      const beneath = commit.body || (fallback ? `_${fallback}_` : '');
      if (beneath) lines.push('', beneath);
    }
  }

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

  blocks.push(...renderPlanningBlocks(summary.planning, titleWidth));

  const landed = summary.records.filter(landedWork);
  if (landed.length > 0) {
    blocks.push(
      [
        // Implemented, not In Review: the cards are built and pushed, and CI is
        // what promotes them (MOTIR-3006). Saying "awaiting your merge" here
        // would teach the operator that the run finished the lifecycle, which is
        // the mental model this story exists to correct.
        `Implemented — CI decides when these become reviewable (${landed.length}):`,
        ...landed.map((r) => `  ${r.key} on ${r.sessionBranch ?? '(no branch recorded)'}`),
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

  if (summary.approvals.length > 0) {
    blocks.push(
      [
        // Named PLAN BY PLAN, with the card each was approved FOR. A count would
        // tell an operator that their tree moved without telling them where.
        `Plans APPROVED by this run — your tree changed while you were away (${summary.approvals.length}):`,
        ...summary.approvals.map(
          (a) =>
            `  ${a.planId} — approved for ${a.key}, ${a.proposalCount} proposal${a.proposalCount === 1 ? '' : 's'} materialized`,
        ),
        '  Each card that was re-planned is held out of THIS run; re-run to pick the new work up.',
      ].join('\n'),
    );
  }

  const replanned = summary.records.filter((r) => r.outcome === 'replanned');
  if (replanned.length > 0) {
    blocks.push(
      [
        // Named as an OUTCOME the run produced, not as a shortfall — and it says
        // what is now waiting for the operator, because the plan is the thing
        // they have to act on and it is not in this terminal.
        `Re-planned — refused by their agent, left in Planning (${replanned.length}):`,
        ...replanned.map((r) => {
          // Do not tell the operator to review a plan this run already approved
          // — the approvals block above says what happened to it.
          const approved = summary.approvals.some((a) => a.key === r.key);
          return approved
            ? `  ${r.key} — its plan was approved by this run (above); the card itself stays in Planning`
            : `  ${r.key} — review the submitted plan in Motir, then re-run it`;
        }),
        '  Nothing was recorded for these: no branch, no pull request, no status moved by this run.',
      ].join('\n'),
    );
  }

  if (summary.prs.length > 0) {
    blocks.push(['Pull requests:', ...summary.prs.map(prLine)].join('\n'));
  }
  return blocks.join('\n\n');
}

/**
 * The planning section: what `--include-planning` fired, and what it did NOT do.
 *
 * The "awaiting your approval" wording is load-bearing, not decoration. A run
 * that printed "expanded ACME-5" would be claiming work items it never created
 * — the exact misreading the tool's own description guards against — so every
 * triggered line says out loud that a human's approval stands between this plan
 * and any subtask.
 */
function renderPlanningBlocks(planning: PlanningRecord[], titleWidth: number): string[] {
  const blocks: string[] = [];
  const triggered = planning.filter((p) => p.outcome === 'triggered');
  const failed = planning.filter((p) => p.outcome === 'failed');

  if (triggered.length > 0) {
    blocks.push(
      [
        `Planning triggered — awaiting your approval (${triggered.length}):`,
        ...triggered.map(
          (p) =>
            `  ${p.key} — ${truncate(p.title ?? '', titleWidth)}\n` +
            `    plan ${p.planId ?? '(id not returned)'}${p.reviewUrl ? ` — ${p.reviewUrl}` : ''}`,
        ),
        '  These are PROPOSALS. Nothing was added to the plan: approve them in Motir',
        '  and their subtasks join a later run like any other ready work.',
      ].join('\n'),
    );
  }

  if (failed.length > 0) {
    blocks.push(
      [
        `Planning failed — still unexpanded (${failed.length}):`,
        ...failed.map((p) => `  ${p.key} — ${p.detail ?? 'the expansion was refused'}`),
      ].join('\n'),
    );
  }
  return blocks;
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
 *  human's attention as a FAILURE (an interrupted run included).
 *
 *  DISPATCH outcomes only — `summary.planning` is deliberately not read. A failed
 *  expansion is non-halting (nothing in the run depended on it), so letting it
 *  redden the exit code would fail a run whose every dispatch succeeded. */
export function autoExitCode(summary: AutoSummary): number {
  if (summary.records.some((r) => r.outcome === 'failed')) return 1;
  if (summary.stopReason === 'interrupted') return 130;
  return 0;
}
