import { existsSync } from 'node:fs';
import { resolveRepo, type LinkConfig, type RepoResolutionSource } from './config/linkConfig.js';
import type { DispatchPrompt, DispatchWorkflowMode } from './mcpClient.js';

// The PURE half of single dispatch (Story 7.9 · Subtask 7.9.3 · MOTIR-881):
// where an item's agent runs, what the human is told about it, and how a
// bootstrap dispatch is verified afterwards. No MCP, no spawn, no stdout — the
// I/O half lives in commands/dispatch.ts and agentRun.ts, so the whole routing
// matrix is unit-testable without a server, an agent binary, or a real
// filesystem (`exists` is injected).
//
// REPO ROUTING is the load-bearing rule here. The dispatch payload names the
// item's repo (`targetRepo`, MOTIR-1804 — a bare name like `motir-core`, or
// `null` when Motir genuinely cannot say). The CLI maps that name to a checkout
// through the link's override map / the `<root>/<repoName>` convention
// (7.9.1's `resolveRepo`) and runs the agent THERE. Three outcomes, and only
// three — the CLI never picks a DIFFERENT existing checkout as a fallback,
// because dispatching an item into the wrong repo is worse in every way than
// admitting the gap.

/**
 * WHY the agent's cwd is what it is — the three (and only three) routing
 * outcomes:
 *
 * - `repo_checkout` — the item names a repo AND that checkout exists: run
 *   inside it. This is what makes dispatching a `motir-ai` item while standing
 *   in `motir-core` work.
 * - `bootstrap_root` — the item names a repo whose checkout is MISSING: run at
 *   the workspace root so the prompt's GIT WORKFLOW can CREATE the checkout
 *   (the empty-folder new-project flow). Verified after a successful run.
 * - `unpinned_root` — the payload carries no repo (`targetRepo: null`): run at
 *   the workspace root. `null` is a real answer ("Motir does not know"), never
 *   a licence to guess a checkout.
 */
export type DispatchCwdReason = 'repo_checkout' | 'bootstrap_root' | 'unpinned_root';

export interface DispatchTarget {
  /** The resolved repo NAME from the dispatch payload, or null when unpinned. */
  targetRepo: string | null;
  /** Absolute path the agent process runs in. */
  cwd: string;
  reason: DispatchCwdReason;
  /** Where the pinned repo's checkout resolves to — null when unpinned. Set
   *  even in `bootstrap_root`, where it is the path we expect to APPEAR. */
  repoPath: string | null;
  /** How `repoPath` was resolved (`override` from `.motir.json` / the
   *  `<root>/<repoName>` `convention`), or null when unpinned. */
  repoSource: RepoResolutionSource | null;
  /** True only for `bootstrap_root`: the run must be followed by a checkout
   *  existence check (see {@link checkBootstrapCheckout}). */
  verifyCheckoutAfterRun: boolean;
}

export interface ResolveDispatchTargetOptions {
  /** Injectable path-existence predicate (the tests' seam). */
  exists?: (path: string) => boolean;
}

/**
 * Decide WHERE to run an item, from the link root + the payload's `targetRepo`.
 * See {@link DispatchCwdReason} for the three outcomes. Deliberately total: an
 * unresolvable repo falls back to the ROOT, never to another checkout.
 */
export function resolveDispatchTarget(
  rootDir: string,
  config: LinkConfig,
  targetRepo: string | null,
  opts: ResolveDispatchTargetOptions = {},
): DispatchTarget {
  const exists = opts.exists ?? existsSync;
  if (!targetRepo) {
    return {
      targetRepo: null,
      cwd: rootDir,
      reason: 'unpinned_root',
      repoPath: null,
      repoSource: null,
      verifyCheckoutAfterRun: false,
    };
  }
  // `resolveRepo` computes its own `exists` off the real fs; re-test with the
  // injected predicate so the routing decision is the one under test.
  const resolved = resolveRepo(rootDir, config, targetRepo);
  const present = exists(resolved.path);
  return {
    targetRepo,
    cwd: present ? resolved.path : rootDir,
    reason: present ? 'repo_checkout' : 'bootstrap_root',
    repoPath: resolved.path,
    repoSource: resolved.source,
    verifyCheckoutAfterRun: !present,
  };
}

export interface SuspectDispatch {
  repoName: string;
  expectedPath: string;
  message: string;
  hint: string;
}

/**
 * The bootstrap POST-CONDITION: after an agent exits 0 on a `bootstrap_root`
 * dispatch, the checkout it was supposed to create must now exist. When it does
 * not, the run is SUSPECT — most likely the repo lives off-convention, which
 * `motir link add` fixes. Returns null in every other case (nothing to verify,
 * or the checkout appeared as expected).
 */
export function checkBootstrapCheckout(
  target: DispatchTarget,
  opts: ResolveDispatchTargetOptions = {},
): SuspectDispatch | null {
  const exists = opts.exists ?? existsSync;
  if (!target.verifyCheckoutAfterRun || !target.targetRepo || !target.repoPath) return null;
  if (exists(target.repoPath)) return null;
  return {
    repoName: target.targetRepo,
    expectedPath: target.repoPath,
    message:
      `Suspect dispatch: the agent exited 0 but "${target.targetRepo}" still has no checkout ` +
      `at ${target.repoPath}.`,
    hint: `If this repo lives elsewhere, run \`motir link add ${target.targetRepo} <path>\`.`,
  };
}

/** How the agent command was resolved, so the summary can say so. */
export type AgentSource = 'flag' | 'env' | 'config';

const AGENT_SOURCE_LABEL: Record<AgentSource, string> = {
  flag: '--agent',
  env: 'MOTIR_AGENT',
  config: 'config agentCommand',
};

export function agentSourceLabel(source: AgentSource): string {
  return AGENT_SOURCE_LABEL[source];
}

/** Human label for a routing outcome, used in the dispatch summary. */
export function cwdReasonLabel(target: DispatchTarget): string {
  switch (target.reason) {
    case 'repo_checkout':
      return `${target.targetRepo ?? ''} checkout (${target.repoSource})`;
    case 'bootstrap_root':
      return `workspace root — no "${target.targetRepo ?? ''}" checkout yet, the prompt creates it`;
    case 'unpinned_root':
      return 'workspace root — the item pins no repo';
  }
}

/** A one-line description of the git workflow the SERVER chose for this item. */
export function workflowLabel(mode: DispatchWorkflowMode, sessionBranch: string | null): string {
  return mode === 'session_lineage'
    ? `session lineage on ${sessionBranch ?? '(unnamed branch)'}`
    : 'one pull request of its own';
}

/**
 * The PROSE-vs-GRAPH warning (MOTIR-2079), or `null` when there is nothing to
 * say. Rendered from `dispatch_prompt`'s `advisories`: work items this card's
 * ACCEPTANCE CRITERIA name while carrying no `blocked_by` edge to them.
 *
 * ⚠️ A WARNING, NOT A REFUSAL — and the difference is the whole point. A missing
 * dependency EDGE is a fact, so `notReadyError` refuses and offers `--force`. A
 * prose reference is a HINT: a boundary-contract card legitimately names both
 * halves of a two-PR split, an acceptance criterion legitimately names a card
 * for contrast, and a sibling may be merged before this item is started.
 * Refusing those would teach authors to write vaguer acceptance criteria, which
 * is worse than the miss it would catch. So the dispatch proceeds, the exit code
 * is untouched, no `--force` is required — and the human sees the reference.
 *
 * Diagnostics, so it goes to STDERR with the summary: `motir next --print |
 * pbcopy` must still pipe the prompt and nothing else.
 */
export function renderDispatchAdvisories(dispatch: DispatchPrompt): string | null {
  const advisories = dispatch.advisories ?? [];
  if (advisories.length === 0) return null;
  return [
    `Advisory:   ${dispatch.key}'s acceptance criteria name work items it has no blocked_by edge to.`,
    ...advisories.map((a) => `            - ${a.referenced} (${a.referencedStatus})`),
    '            This is NOT a blocker — the dispatch proceeds. Before branching,',
    '            check each one is already on origin/main; if it lives only on an open',
    '            PR, add the blocked_by edge and stop instead of rebuilding its half.',
  ].join('\n');
}

export interface DispatchSummaryInput {
  key: string;
  title: string | null;
  dispatch: DispatchPrompt;
  target: DispatchTarget;
  /** The agent about to run, or null in `--print` mode. */
  agent: { command: string; source: AgentSource } | null;
}

/**
 * The status block that accompanies a dispatch. In `--print` mode this goes to
 * STDERR while the prompt goes to stdout, so `motir next --print | pbcopy`
 * pipes the prompt alone — and the copy-paste user still SEES which repo and
 * which resolved path the prompt expects to be run in.
 */
export function renderDispatchSummary(input: DispatchSummaryInput): string {
  const { key, title, dispatch, target, agent } = input;
  const lines = [
    `Dispatch:   ${key}${title ? ` — ${title}` : ''}`,
    `Repo:       ${dispatch.targetRepo ?? 'not pinned (Motir cannot say)'}`,
    `Path:       ${target.cwd}`,
    `            ${cwdReasonLabel(target)}`,
    `Workflow:   ${workflowLabel(dispatch.workflowMode, dispatch.sessionBranch)}`,
  ];
  lines.push(
    agent
      ? `Agent:      ${agent.command}  (${agentSourceLabel(agent.source)})`
      : 'Agent:      none — printing the prompt (copy it into your agent)',
  );
  return lines.join('\n');
}

/**
 * What the human should do after the agent exits 0. The two workflow modes end
 * differently: a per-item PR waits for the human's merge, then `motir done`; a
 * session-lineage item has JOINED a branch that ships with that session's PR,
 * so its close-out is the bulk `motir done --session`.
 */
export function renderAgentSuccess(key: string, dispatch: DispatchPrompt): string {
  if (dispatch.workflowMode === 'session_lineage' && dispatch.sessionBranch) {
    return [
      `${key}: agent finished — integrated on "${dispatch.sessionBranch}" (now In Review).`,
      `Next: review + merge the session PR, then \`motir done --session ${dispatch.sessionBranch}\`.`,
    ].join('\n');
  }
  return [
    `${key}: agent finished — its pull request should be open (now In Review).`,
    `Next: review + merge the PR, then \`motir done ${key}\`.`,
  ].join('\n');
}

/**
 * What the human should do after the agent FAILS. The item deliberately stays
 * `in_progress` — the work was started and is half-done, so silently reverting
 * it to `todo` would hide that. It is added to the session exclude list instead,
 * so the next `motir next` moves on rather than re-picking the same failure.
 */
export function renderAgentFailure(key: string, exitCode: number): string {
  return [
    `${key}: agent exited ${exitCode}. The item stays In Progress (nothing was reverted).`,
    `It is excluded from the next \`motir next\` in this session; re-run it with \`motir run ${key}\`.`,
  ].join('\n');
}

/** The per-item outcome lines of a `complete_session` bulk close-out. */
export function renderSessionOutcomes(
  sessionBranch: string,
  results: { key: string; outcome: string; reason?: string | null }[],
): string {
  if (results.length === 0) return `No work items are recorded on "${sessionBranch}".`;
  const counts = results.reduce<Record<string, number>>((acc, r) => {
    acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
    return acc;
  }, {});
  const head =
    `Completed session "${sessionBranch}": ` +
    Object.entries(counts)
      .map(([outcome, n]) => `${n} ${outcome.replace('_', ' ')}`)
      .join(', ') +
    '.';
  const detail = results.map((r) => `  ${r.key}: ${r.outcome}${r.reason ? ` — ${r.reason}` : ''}`);
  return [head, ...detail].join('\n');
}
