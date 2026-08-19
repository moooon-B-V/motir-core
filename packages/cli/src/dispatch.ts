import { existsSync } from 'node:fs';
import { resolveRepo, type LinkConfig, type RepoResolutionSource } from './config/linkConfig.js';
import {
  isOrderingAdvisory,
  isReferenceAdvisory,
  isRepoStraddleAdvisory,
  isSubsumptionAdvisory,
} from './client.js';
import type { DispatchPrompt, DispatchWorkflowMode } from './client.js';

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

/**
 * Decide where to run EVERY repository of an item's set (Story MOTIR-2731 ·
 * MOTIR-3133) — one {@link DispatchTarget} per repository, in the payload's
 * order, primary first.
 *
 * Each element is resolved by {@link resolveDispatchTarget}, unchanged, so the
 * routing matrix is applied per repository rather than re-derived for a set:
 * the override map, the `<root>/<name>` convention and the three outcomes all
 * behave exactly as they do for a single-repository card. Only element 0's `cwd`
 * is ever used to launch the agent — one dispatch, one agent process; the others
 * are places it works, not places it is launched in.
 *
 * An EMPTY set returns `[]`. The caller falls back to the scalar in that case,
 * which is also what happens against a server too old to send `targetRepos`.
 */
export function resolveDispatchTargets(
  rootDir: string,
  config: LinkConfig,
  repos: readonly string[],
  opts: ResolveDispatchTargetOptions = {},
): DispatchTarget[] {
  return repos.map((repo) => resolveDispatchTarget(rootDir, config, repo, opts));
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
  // Matched POSITIVELY, family and severity both: a family or severity a newer
  // server emits and this build does not know matches NO filter and prints
  // nothing, rather than printing another member's fields as `undefined`. The
  // reference filter used to be the `kind !== 'shape'` catch-all, which had
  // exactly that defect the moment a third family arrived (MOTIR-2903).
  const references = advisories.filter(isReferenceAdvisory);
  const shapes = advisories.filter(isOrderingAdvisory);
  const straddles = advisories.filter(isRepoStraddleAdvisory);
  const subsumed = advisories.filter(isSubsumptionAdvisory);
  const lines: string[] = [];

  if (references.length > 0) {
    lines.push(
      `Advisory:   ${dispatch.key}'s acceptance criteria name work items it has no blocked_by edge to.`,
      ...references.map((a) => `            - ${a.referenced} (${a.referencedStatus})`),
      '            This is NOT a blocker — the dispatch proceeds. Before branching,',
      '            check each one is already on origin/main; if it lives only on an open',
      '            PR, add the blocked_by edge and stop instead of rebuilding its half.',
    );
  }
  // The ORDERING advisory (MOTIR-2175). Same disposition, different remedy: the
  // reference block says "go check something"; this one says "part of this card
  // is not yours to finish", which the operator needs BEFORE the agent starts.
  for (const s of shapes) {
    lines.push(
      `Advisory:   ${dispatch.key}'s acceptance criterion ${s.criterionIndex} says "${s.phrase}" —`,
      "            state that exists only after this card's own PR has merged.",
      '            This is NOT a blocker — the dispatch proceeds. Your boundary ends at',
      '            PR opened, so that criterion and everything below it belongs to a',
      '            follow-on card. Build what is above the line and report the split.',
    );
  }
  // The REPO-STRADDLE advisory (MOTIR-2177). The operator is the one who knows
  // whether the other repo's half already merged, or whether this is a
  // boundary-contract card — the two shapes that make this a false positive —
  // so the path is named and the judgement is left with them.
  for (const s of straddles) {
    lines.push(
      `Advisory:   ${dispatch.key}'s acceptance criterion ${s.criterionIndex} names ${s.path},`,
      `            which lives in ${s.repo}${
        s.reason === 'contradiction'
          ? " — not this card's pinned repo."
          : ', and this card pins no repo while its criteria name more than one.'
      }`,
      '            This is NOT a blocker — the dispatch proceeds. One subtask, one repo,',
      '            one PR: check the other repo before branching. If that half is already',
      '            merged, or this is a boundary-contract card, proceed; otherwise surface',
      "            the split rather than dropping the other repo's criteria.",
    );
  }
  // The SUBSUMPTION advisory (MOTIR-2903). The operator is the one who can read
  // a diff in ten seconds and decide, and the alternative to their reading it is
  // an agent spending a session rebuilding something already on `main`.
  for (const s of subsumed) {
    lines.push(
      `Advisory:   ${dispatch.key}'s body names ${s.path}, which ${s.pullRequest} already`,
      `            changed (merged ${s.mergedAt}).`,
      '            This is NOT a blocker — the dispatch proceeds. But this card may already',
      "            be built: read that pull request against the card's acceptance criteria.",
      '            If it delivers them, close the card with the merge as the evidence instead',
      '            of rebuilding it. If the two merely share a file, proceed.',
    );
  }
  // Nothing MATCHED, not merely nothing sent: a payload carrying only advisories
  // this build cannot render is the same "nothing to say" as an empty array, and
  // must produce no output rather than a blank line (MOTIR-2177).
  return lines.length === 0 ? null : lines.join('\n');
}

export interface DispatchSummaryInput {
  key: string;
  title: string | null;
  dispatch: DispatchPrompt;
  target: DispatchTarget;
  /**
   * Every repository of the item's set, resolved (MOTIR-3133) — element 0 is
   * `target`. Absent, empty or of length ONE renders exactly today's two lines:
   * this block exists only where a card actually ships in more than one place.
   */
  targets?: DispatchTarget[];
  /** The agent about to run, or null in `--print` mode. */
  agent: { command: string; source: AgentSource } | null;
}

/**
 * The five per-repository delivery states, in the words a PERSON needs
 * (MOTIR-3136 · `lib/workItems/repoDelivery.ts`).
 *
 * ⚠️ `unestablished` and `excluded` are NOT shades of `awaiting`, and the
 * difference is the reader's next ACTION rather than a nuance. `awaiting` says a
 * pull request has not been opened and points at the host; `unestablished` says
 * there is no repository to open one against and points at the project's
 * establish step; `excluded` says nothing is expected there at all, and it is
 * the one state that does not hold the card. Collapsing them is what produced
 * the false "No pull request yet" row one level down.
 *
 * An UNKNOWN state — one a newer server added — renders verbatim rather than
 * being mapped onto a neighbour, for the same reason the advisory renderer
 * prints nothing for a family it does not know: a build that guesses is worse
 * than one that admits.
 */
function deliveryLabel(state: string | null): string | null {
  switch (state) {
    case null:
      return null;
    case 'delivered':
      return 'delivered — a pull request has merged onto its default branch';
    case 'awaiting':
      return 'awaiting — no merged pull request yet';
    case 'unknown':
      return 'unknown — a merge is recorded but not which branch it reached';
    case 'unestablished':
      return 'NOT ESTABLISHED — this repository does not exist yet, so there is nothing to open a pull request against';
    case 'excluded':
      return 'excluded — the project is deliberately code-less here; it does not hold this card';
    default:
      return state;
  }
}

/** The repositories of a card that carries more than one, or `[]`. */
function repoSet(dispatch: DispatchPrompt): NonNullable<DispatchPrompt['targetRepos']> {
  const repos = dispatch.targetRepos ?? [];
  return repos.length >= 2 ? repos : [];
}

/**
 * The RESUME line (MOTIR-3136) — printed only when at least one repository has
 * delivered and at least one has not.
 *
 * A partially delivered card is a legitimate resting state, not an error (ADR
 * §B4), and the whole cost of not saying so is that a resumed run reads exactly
 * like a fresh one: the operator has no way to tell that half the work is
 * already on `main` and the agent should not re-open it.
 */
export function renderResumeNotice(dispatch: DispatchPrompt): string | null {
  const repos = repoSet(dispatch);
  const delivered = repos.filter((r) => r.delivery === 'delivered').map((r) => r.name);
  const remaining = repos.filter((r) => r.delivery !== 'delivered').map((r) => r.name);
  if (delivered.length === 0 || remaining.length === 0) return null;
  return [
    `Resume:     ${dispatch.key} is PARTIALLY DELIVERED — this is not a fresh card.`,
    `            already delivered: ${delivered.join(', ')}`,
    `            still outstanding: ${remaining.join(', ')}`,
    '            Do not re-open a pull request in a repository that has already merged.',
  ].join('\n');
}

/**
 * The REPOSITORIES block — one line per repository, in set order, with the
 * primary marked as the working directory.
 *
 * ⚠️ A MISSING CHECKOUT IS A WARNING HERE, NOT A REFUSAL, and it is the same
 * doctrine {@link renderDispatchAdvisories} sets out one function down: the
 * operator is the one who knows whether that repository's half is already
 * merged, or whether their checkout simply lives somewhere the convention does
 * not predict. Refusing would convert a resumable card into a blocked one over a
 * fact the tool is not the authority on. So the line names the repository, the
 * path that was expected and the `motir link add` fix, the dispatch proceeds,
 * and the exit code is untouched. (ADR `work-item-repository-set.md`
 * § *Amendment 2026-08-19* §B6(a).)
 */
export function renderRepositoriesBlock(
  targets: DispatchTarget[],
  delivery?: (string | null)[],
): string[] {
  if (targets.length <= 1) return [];
  const lines = [`Repos:      ${targets.length} — this item ships in every one of them:`];
  targets.forEach((t, i) => {
    const where = i === 0 ? 'the working directory' : 'a sibling checkout';
    lines.push(`            - ${t.targetRepo ?? '(unpinned)'}  (${where})`);
    lines.push(`                ${t.repoPath ?? t.cwd}  (${t.repoSource ?? 'root'})`);
    // MOTIR-3136 — what this repository has already shipped, beside where it is.
    const label = deliveryLabel(delivery?.[i] ?? null);
    if (label) lines.push(`                ${label}`);
    if (t.reason === 'bootstrap_root') {
      lines.push(
        `                ⚠ no checkout here yet. This is NOT a blocker — the dispatch`,
        `                  proceeds. If it lives elsewhere: motir link add ${t.targetRepo ?? ''} <path>`,
      );
    }
  });
  return lines;
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
    // MOTIR-3133 — every OTHER repository the card ships in, and where each one
    // resolved to. Nothing is emitted for a one-repository or unpinned card, so
    // the two lines above are still the whole answer for every card that exists.
    ...renderRepositoriesBlock(
      input.targets ?? [],
      (dispatch.targetRepos ?? []).map((r) => r.delivery),
    ),
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
  const repos = repoSet(dispatch);
  if (dispatch.workflowMode === 'session_lineage' && dispatch.sessionBranch) {
    if (repos.length > 0) {
      return [
        `${key}: agent finished — integrated on "${dispatch.sessionBranch}" in ${repos.length}`,
        `repositories: ${repos.map((r) => r.name).join(', ')}.`,
        `Next: review + merge the session PR in EACH of them, then`,
        `\`motir done --session ${dispatch.sessionBranch}\`.`,
        `${key} is not complete until every repository's pull request has merged.`,
      ].join('\n');
    }
    return [
      `${key}: agent finished — integrated on "${dispatch.sessionBranch}" (now Implemented).`,
      'CI decides when it becomes reviewable: the card moves to In Review on its own',
      'when the checks on that branch go green.',
      `Next: review + merge the session PR, then \`motir done --session ${dispatch.sessionBranch}\`.`,
    ].join('\n');
  }
  // ⚠️ THE MULTI-REPOSITORY FORM MUST NOT SAY THE CARD IS FINISHED. The single
  // line below is not merely incomplete for a card carrying two repositories —
  // it reads as reassurance, at the exact moment the operator could still notice
  // that half the work has no pull request. It also drops the singular follow-up
  // deliberately: `motir done <key>` on a card the completion gate is holding
  // would be an instruction that cannot succeed.
  if (repos.length > 0) {
    const lines = [
      `${key}: agent finished — a pull request is expected in EACH of its ${repos.length} repositories:`,
    ];
    for (const repo of repos) {
      const label = deliveryLabel(repo.delivery);
      lines.push(`  - ${repo.name}${label ? ` — ${label}` : ''}`);
    }
    const blocked = repos.filter((r) => r.delivery === 'unestablished');
    if (blocked.length > 0) {
      lines.push(
        '',
        `⚠ ${blocked.map((r) => r.name).join(', ')} cannot be delivered yet: the repository does`,
        '  not exist. Establish it on the project before this card can complete.',
      );
    }
    lines.push(
      '',
      `Next: review + merge every one of them. ${key} completes only when EVERY`,
      "repository's pull request has merged — a single merge leaves it held.",
    );
    return lines.join('\n');
  }
  return [
    `${key}: agent finished — its pull request is open (now Implemented).`,
    'CI decides when it becomes reviewable: the card moves to In Review on its own',
    'when the checks on that pull request go green.',
    `Next: review + merge the PR, then \`motir done ${key}\`.`,
  ].join('\n');
}

/**
 * The agent exited 0 but NOTHING for this card reached the remote (MOTIR-3004).
 *
 * `implemented` is a claim that the code is pushed, so this run cannot make it —
 * and the honest failure is to say so and leave the card in progress rather than
 * to record a card whose work exists only in a worktree that is about to be
 * deleted. The item is excluded from the next pick for the same reason a failed
 * agent's is: re-picking it in the same session would just repeat the run.
 */
export function renderNothingPushed(key: string, dispatch: DispatchPrompt): string {
  const where =
    dispatch.workflowMode === 'session_lineage' && dispatch.sessionBranch
      ? `no commit naming ${key} is on origin/${dispatch.sessionBranch}`
      : `no branch naming ${key} is on the remote`;
  return [
    `${key}: agent exited 0, but ${where}.`,
    'The card stays In Progress: Implemented means the code is PUSHED, and this run',
    'cannot claim that. Nothing was reverted — check the worktree for uncommitted or',
    'unpushed work.',
    `It is excluded from the next \`motir next\` in this session; re-run it with \`motir run ${key}\`.`,
  ].join('\n');
}

/**
 * What the human should do after the agent FAILS. The item deliberately stays
 * `in_progress` — the work was started and is half-done, so silently reverting
 * it to `todo` would hide that. It is added to the session exclude list instead,
 * so the next `motir next` moves on rather than re-picking the same failure.
 */
export function renderAgentFailure(
  key: string,
  exitCode: number,
  dispatch?: DispatchPrompt,
): string {
  const lines = [
    `${key}: agent exited ${exitCode}. The item stays In Progress (nothing was reverted).`,
    `It is excluded from the next \`motir next\` in this session; re-run it with \`motir run ${key}\`.`,
  ];
  // MOTIR-3136 — how WIDE the half-done work is. The policy above is unchanged;
  // what a person reading a failed multi-repository run cannot otherwise tell is
  // how many checkouts they may now have to look in.
  const repos = dispatch ? repoSet(dispatch) : [];
  if (repos.length > 0) {
    lines.push(
      `${key} ships in ${repos.length} repositories (${repos.map((r) => r.name).join(', ')}),`,
      'so partial work may be sitting in more than one checkout.',
    );
  }
  return lines.join('\n');
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
