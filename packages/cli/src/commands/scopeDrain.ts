import { info } from '../output.js';
import { GitError, type CommandRunner } from '../git.js';
import {
  classifyReadyItem,
  type AutoSummary,
  type DispatchRecord,
  type PlanningRecord,
  type RepoSession,
  type SkipRecord,
  type StopReason,
} from '../autoLoop.js';
import { RepoSessions, dispatchOne, type AutoOptions, type ResolvedAgent } from './auto.js';
import { findingsPolicyOf, resolveDispatchTarget, resolveDispatchTargets } from '../dispatch.js';
import { orderClaimedSet, unsatisfiedBlockers, type ScopeEdges } from '../scopedRun.js';
import type { runAgent } from '../agentRun.js';
import type { DispatchItem, MotirClient } from '../client.js';
import type { ProjectSession } from '../session.js';

// The DRAIN of a claimed scope (Story MOTIR-3001 · MOTIR-3199) — the back half
// of `motir run <scope>`. It starts holding a set of cards this run already
// owns, and works that set to open pull requests.
//
// ── SNAPSHOT-SHAPED, and that is the difference from `motir auto` ──────────
// `auto` asks the server for exactly one item per iteration and never
// materializes a list — deliberately, because the ready set changes underneath
// it as integration unblocks dependents. A scoped run has no such problem: the
// claim already took every member of the scope, so nothing outside the run can
// add to or remove from the set, and the run orders the work itself from the
// dependency edges.
//
// ⚠️ SO IT NEVER QUERIES A READY SET AFTER THE CLAIM. That is the invariant to
// protect, and it is not a performance note: a mid-flight ready query would
// silently reintroduce exactly the interleaving the up-front claim exists to
// prevent. `test/scopeDrain.test.ts` fails if a ready read is issued mid-drain.
//
// ── REUSE, NOT REINVENTION ────────────────────────────────────────────────
// `RepoSessions`, `dispatchOne` and `closeOutRepos` are `motir auto`'s, exported
// rather than copied. The two loops differ in how they pick the next card and in
// nothing else — the claim, the agent spawn, the replan check, the bootstrap
// check, the push check and the integration are ONE pipeline, and a fork of it
// would be two places for those checks to drift.

export interface ScopeDrainInput {
  session: ProjectSession;
  opts: AutoOptions;
  /** The claimed leaves, in the server's dispatch rank — the tie-break order. */
  members: DispatchItem[];
  /** `key → the keys it is blocked by`, read ONCE before the drain starts. */
  edges: ScopeEdges;
  max: number | null;
  agent: ResolvedAgent;
  runId: string;
  branch: string;
  run: CommandRunner;
  clock: () => number;
  runAgentFn: typeof runAgent;
}

/**
 * Work the claimed set in `blocked_by` order and return the summary.
 *
 * Exported so it can be driven end-to-end against a scripted client + agent,
 * which is the only way the "never re-queries a ready set" property can actually
 * be asserted — the same reason `runAutoLoop` is exported.
 */
export async function drainScope(input: ScopeDrainInput): Promise<AutoSummary> {
  const { session, opts, members, edges, max, agent, runId, branch, run, clock, runAgentFn } =
    input;
  const { client } = session;

  const byKey = new Map(members.map((m) => [m.key, m]));
  const inScope = new Set(byKey.keys());
  // ⚠️ COMPUTED ONCE, HERE, from edges the run already holds. Nothing below
  // recomputes it and nothing below asks the server what is ready.
  const order = orderClaimedSet([...byKey.keys()], edges);

  const records: DispatchRecord[] = [];
  const skipped: SkipRecord[] = [];
  const planning: PlanningRecord[] = [];
  const repos = new RepoSessions(branch, run);
  /** Cards that have LANDED — what an in-scope blocker is satisfied by. */
  const satisfied = new Set<string>();

  let interrupted = false;
  const onSigint = (): void => {
    if (interrupted) process.exit(130);
    interrupted = true;
    info('');
    info('Interrupt received — finishing up and opening the session pull request(s).');
    info('Press Ctrl-C again to exit immediately.');
  };
  process.on('SIGINT', onSigint);

  let stopReason: StopReason = 'drained';
  try {
    for (const key of order) {
      if (interrupted) {
        stopReason = 'interrupted';
        break;
      }
      if (max !== null && records.length >= max) {
        stopReason = 'max';
        break;
      }
      const item = byKey.get(key) as DispatchItem;

      // ⚠️ SKIPPED AND NAMED, NEVER FORCED. The run owns this card — the claim
      // took every member in the to-do category, `blocked` included — which is
      // not the same as being allowed to build it out of order. Its blockers
      // failed, were skipped, or were never reached; either way the honest
      // answer is to leave it and say so.
      const open = unsatisfiedBlockers(key, edges, satisfied, inScope);
      if (open.length > 0) {
        skipped.push({
          key: item.key,
          title: item.title,
          reason: 'blocked_in_scope',
          blockedBy: open,
        });
        info(`${item.key}: skipped — waiting on ${open.join(', ')}, which did not land.`);
        continue;
      }

      // The SAME classifier `auto` and `batch` use, so a scoped run cannot
      // disagree with them about what a coding agent may be handed. A `manual` /
      // `executor: human` card is skipped and named, and the story stays open —
      // correctly.
      const disposition = classifyReadyItem(item);
      if (disposition !== 'dispatch') {
        skipped.push({ key: item.key, title: item.title, reason: disposition });
        info(
          `${item.key}: skipped — ${
            disposition === 'needs_planning'
              ? 'an unexpanded container needs planning'
              : 'human work'
          }.`,
        );
        continue;
      }

      // ⚠️ SEED FIRST, THEN RESOLVE (MOTIR-2398), exactly as `auto` does: the
      // checkout cannot be resolved before this read, because `targetRepo` lives
      // on the PROMPT and not on the row; and the seed cannot follow it, because
      // `repos.ensure` creates the branch the seed names.
      let dispatch = await client.dispatchPrompt(item.key, {
        sessionBranch: branch,
        findingsPolicy: findingsPolicyOf(opts),
      });
      const targets = resolveDispatchTargets(
        session.link.dir,
        session.link.config,
        (dispatch.targetRepos ?? []).map((r) => r.name),
      );
      const resolved =
        targets.length > 0
          ? targets
          : [resolveDispatchTarget(session.link.dir, session.link.config, dispatch.targetRepo)];
      const target = resolved[0]!;

      let repo: RepoSession[] | null;
      try {
        repo = repos.ensure(resolved);
      } catch (err) {
        // A git failure in a REAL checkout is a run-ending problem, and it
        // happens before anything is spawned — the card is untouched. Stop, but
        // still close out whatever earlier repos completed.
        info('');
        info(`${item.key}: ${err instanceof GitError ? err.message : String(err)}`);
        stopReason = 'halted';
        break;
      }
      if (!repo) {
        // No checkout to branch in, so the seeded prompt names a branch that
        // does not exist here. Re-read WITHOUT the seed.
        dispatch = await client.dispatchPrompt(item.key, {
          findingsPolicy: findingsPolicyOf(opts),
        });
      }

      const outcome = await dispatchOne({
        client,
        item,
        dispatch,
        target,
        targets: resolved,
        repos: resolved.map((t) => t.targetRepo).filter((n): n is string => n !== null),
        agent,
        clock,
        runAgentFn,
        run,
        onIntegrated: (k) => repo?.forEach((s) => s.keys.push(k)),
      });

      if (outcome.kind === 'skipped') {
        // The claim was refused. ⚠️ On a scoped run this should be unreachable —
        // this run already holds every member — so it is recorded rather than
        // swallowed: if it ever fires, the up-front claim did not hold and the
        // summary is where that has to be visible.
        skipped.push({ key: item.key, title: item.title, reason: outcome.reason });
        continue;
      }

      const record = outcome.record;
      records.push(record);
      if (record.outcome === 'integrated' || record.outcome === 'implemented') {
        satisfied.add(item.key);
      }

      // ⚠️ A REFUSED CARD STOPS THE RUN, and `--keep-going` does not override it
      // (MOTIR-3018): that flag says one agent failing is not a reason to
      // abandon the rest, and this is not a failure — it is the agent reporting
      // that the PLAN is wrong, and every card left in this scope is one the
      // submitted plan may be about to change.
      if (record.outcome === 'replanned') {
        stopReason = 'replanned';
        break;
      }
      if (record.outcome === 'failed' && !opts.keepGoing) {
        stopReason = interrupted ? 'interrupted' : 'halted';
        break;
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
  }

  return {
    runId,
    records,
    skipped,
    planning,
    repos: repos.touched(),
    prs: [],
    approvals: [],
    stopReason,
  };
}

/**
 * The intra-scope dependency edges, read ONCE, before the drain.
 *
 * ── Two scope kinds, two sources, and the PR body names both ───────────────
 * A CONTAINER scope needs no read at all beyond the one the claim path already
 * made: `get_work_item` returns every CHILD row carrying
 * `dependencies: { blockedBy, blocks }`, and its own tool description states
 * that the children's build order is derivable from that single call with no
 * per-child read.
 *
 * A SPRINT scope spans several parents at mixed depths, so there is no one
 * container to read. Its edges come from the work-item COLLECTION filtered to
 * the sprint — the same `dependencies` block on every row — walked to
 * exhaustion.
 *
 * ⚠️ EITHER WAY THE INVARIANT HOLDS: the order is computed once from edges the
 * run holds before the first agent starts, and no ready set is consulted again.
 */
export async function readScopeEdges(
  client: MotirClient,
  scope: { kind: 'work_item'; key: string } | { kind: 'sprint'; sprintId: string },
  projectKey: string,
): Promise<ScopeEdges> {
  const edges: ScopeEdges = {};
  if (scope.kind === 'work_item') {
    const detail = await client.getWorkItem(scope.key);
    for (const child of detail.children) {
      // ⚠️ The CHILD row is keyed `identifier` in the view model while the EDGE
      // rows on it are keyed `key` — the adapter renames the row's own key and
      // leaves the edge summaries as the wire spells them (`adapters/reads.ts`).
      // Both are the same `MOTIR-<n>` string; the asymmetry is the only trap in
      // this function.
      edges[child.identifier] = (child.dependencies?.blockedBy ?? []).map((b) => b.key);
    }
    return edges;
  }

  let cursor: string | undefined;
  do {
    const page = await client.searchWorkItems({
      projectKey,
      filter: {
        version: 'v1',
        combinator: 'and',
        conditions: [{ field: 'sprint', operator: 'is_any_of', value: [scope.sprintId] }],
      },
      ...(cursor ? { cursor } : {}),
    });
    for (const row of page.items) {
      edges[row.identifier] = (row.dependencies?.blockedBy ?? []).map((b) => b.key);
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return edges;
}
