import { info } from '../output.js';
import { GitError, type CommandRunner } from '../git.js';
import {
  DECISION_RELEASED_STATUS_KEYS,
  classifyReadyItem,
  isAgentDecisionItem,
  landedWork,
  type AutoSummary,
  type DispatchRecord,
  type PlanningRecord,
  type RepoSession,
  type SkipRecord,
  type StopReason,
} from '../autoLoop.js';
import {
  RepoSessions,
  dispatchOne,
  ensureRepoPullRequest,
  type AutoOptions,
  type ResolvedAgent,
} from './auto.js';
import { findingsPolicyOf, resolveDispatchTarget, resolveDispatchTargets } from '../dispatch.js';
import { orderClaimedSet, unsatisfiedBlockers, type ScopeEdges } from '../scopedRun.js';
import { nullDispatchRunReporter, type DispatchRunReporter } from '../dispatchRunReporter.js';
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
// `RepoSessions`, `dispatchOne`, `ensureRepoPullRequest` and `closeOutRepos` are
// `motir auto`'s, exported rather than copied. The two loops differ in how they
// pick the next card and in nothing else — the claim, the agent spawn, the
// replan check, the bootstrap check, the push check, the integration and the
// mid-run pull-request open are ONE pipeline, and a fork of it would be two
// places for those checks to drift.
//
// ⚠️ AND THAT LIST GREW BY ONE THE HARD WAY (MOTIR-4999). The eager open used to
// live behind `LoopInput.openPrEagerly`, a flag only `motir auto` passed — so
// this loop, which never reads that flag because it never runs `runAutoLoop`,
// silently deferred every session pull request to the close-out. A whole story's
// work sat on the session branch with no pull request and therefore no CI until
// its last child landed, which is precisely what opening early exists to avoid,
// and it is worst on THIS lane: a drain builds later children on top of earlier
// ones, so a red check at card two is worth far more than a red check at card
// ten. Read a "lane" difference between these two loops as a defect until proven
// otherwise.

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
  /**
   * The run REPORTER (Story MOTIR-1789 · MOTIR-1794), already OPENED by the
   * command with this run's full member set in `orderClaimedSet` order.
   *
   * ⚠️ THE SET WAS SETTLED BEFORE THIS FUNCTION WAS CALLED, and that is the
   * point: the claim has just returned its members and the order has just been
   * computed from edges the run already holds. That is the one instant anyone
   * knows what this run set out to do — sending it later, from the stream of
   * per-card events, would yield the cards the drain got round to and lose the
   * skipped ones entirely.
   */
  reporter?: DispatchRunReporter;
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
  const reporter = input.reporter ?? nullDispatchRunReporter;

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
  /**
   * DECISIONS whose gate nobody has approved yet (MOTIR-6094) — what holds the
   * cards that wait on them. Seeded from the ones an EARLIER run already shipped,
   * which are no longer members and so are invisible to `unsatisfiedBlockers`,
   * and grown by every decision this drain ships. Nothing in this run can
   * approve one, so nothing below ever removes a key.
   */
  const heldDecisions = await readHeldDecisions(client, members, edges);

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
      const open = [
        ...new Set([
          ...unsatisfiedBlockers(key, edges, satisfied, inScope),
          ...(edges[key] ?? []).filter((dep) => heldDecisions.has(dep)),
        ]),
      ];
      if (open.length > 0) {
        skipped.push({
          key: item.key,
          title: item.title,
          reason: 'blocked_in_scope',
          blockedBy: open,
        });
        reporter.event({
          kind: 'card_skipped',
          workItemKey: item.key,
          disposition: 'skipped',
          skipReason: 'blocked_in_scope',
          data: { blockedBy: open },
        });
        const decisions = open.filter((dep) => heldDecisions.has(dep));
        info(
          decisions.length === open.length
            ? `${item.key}: held — waiting on decision ${decisions.join(', ')} to be approved. ` +
                'Its approval, not this run, releases it; run the scope again after it.'
            : `${item.key}: skipped — waiting on ${open.join(', ')}, which did not land.`,
        );
        continue;
      }

      // The SAME classifier `auto` and `batch` use, so a scoped run cannot
      // disagree with them about what a coding agent may be handed. A `manual` /
      // `executor: human` card is skipped and named, and the story stays open —
      // correctly.
      const disposition = classifyReadyItem(item);
      if (disposition !== 'dispatch') {
        skipped.push({ key: item.key, title: item.title, reason: disposition });
        reporter.event({
          kind: 'card_skipped',
          workItemKey: item.key,
          disposition: 'skipped',
          skipReason: disposition,
        });
        info(
          `${item.key}: skipped — ${
            disposition === 'needs_planning'
              ? 'an unexpanded container needs planning'
              : 'human work'
          }.`,
        );
        continue;
      }

      // ⚠️ A DECISION NEVER JOINS THE SESSION (MOTIR-6094). Its approval is also
      // the merge of whatever pull request it is linked to, so it ships on a pull
      // request of its OWN, off `main`: no seed, no session branch ensured for it,
      // and therefore no session pull request opened or linked on its account.
      // The server's prompt makes the same call on its side, which is what covers
      // a lineage the card INHERITS from a blocker rather than being seeded.
      const decision = isAgentDecisionItem(item);

      // ⚠️ SEED FIRST, THEN RESOLVE (MOTIR-2398), exactly as `auto` does: the
      // checkout cannot be resolved before this read, because `targetRepo` lives
      // on the PROMPT and not on the row; and the seed cannot follow it, because
      // `repos.ensure` creates the branch the seed names.
      let dispatch = await client.dispatchPrompt(item.key, {
        ...(decision ? {} : { sessionBranch: branch }),
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

      let repo: RepoSession[] | null = null;
      try {
        if (!decision) repo = repos.ensure(resolved);
      } catch (err) {
        // A git failure in a REAL checkout is a run-ending problem, and it
        // happens before anything is spawned — the card is untouched. Stop, but
        // still close out whatever earlier repos completed.
        info('');
        info(`${item.key}: ${err instanceof GitError ? err.message : String(err)}`);
        stopReason = 'halted';
        break;
      }
      if (!repo && !decision) {
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
        opts,
        onIntegrated: (k) => repo?.forEach((s) => s.keys.push(k)),
        reporter,
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
      if (decision) {
        // ⚠️ SHIPPED IS NOT SATISFIED, for a decision. Its dependents wait on a
        // PERSON approving it, exactly as the runbook's parent run holds a design
        // child's — and they are named as held rather than built on a decision
        // nobody has accepted yet.
        if (landedWork(record)) heldDecisions.add(item.key);
      } else if (record.outcome === 'integrated' || record.outcome === 'implemented') {
        satisfied.add(item.key);
      }

      // MOTIR-4999 — OPEN THE PULL REQUEST AT THE FIRST CARD THAT LANDS, per
      // repository, exactly as `runAutoLoop` does. Same helper, same trigger:
      // `landedWork`, so a card that failed or was refused opens nothing and the
      // next successful card in that repository opens it instead.
      //
      // `ensureRepoPullRequest` lists before it creates, so every later
      // iteration finds the same pull request and this is a no-op — the run
      // holds no "have I opened it?" state, which is what makes a resumed drain
      // safe. The close-out still runs and REWRITES the title and body from
      // every record, so a reviewer reads the whole scope even though the pull
      // request existed from the first card.
      //
      // ⚠️ AND WHAT IT OPENS IS A DRAFT (MOTIR-4967) — which is what makes an
      // early open safe on THIS lane in particular. A scoped run's pull request
      // hangs off the container it claimed, and a draft cannot be merged, so it
      // cannot complete that container or cascade `done` onto children that have
      // not been built. Bug MOTIR-3268's hold carried that invariant by opening
      // nothing at all; the draft carries it without withholding CI.
      //
      // ⚠️ AND IT IS ALSO WHAT LINKS IT (MOTIR-4969). A scoped run over a story
      // carries that story's children, so the parent partition of `records` is
      // `shared-parent` from the second landed card onward and the session pull
      // request declares the STORY it delivers. The arm is read off the carried
      // set rather than off this lane's name — `motir run sprint` comes through
      // here too, spans parents, and must invent no story.
      if (landedWork(record)) {
        for (const repoSession of repo ?? []) {
          await ensureRepoPullRequest(repoSession, runId, run, { client, carried: records });
        }
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

  // Whatever the drain queued reaches the server before the caller closes the
  // run — best-effort, so a failure here is one stderr line and nothing else.
  await reporter.flush();

  return {
    runId,
    records,
    skipped,
    planning,
    repos: repos.touched(),
    prs: [],
    approvals: [],
    // A scoped run REFUSES `--auto-approve-replan` (`autoOnlyFlagError`), so it
    // never makes a lane decision — there is nothing here that could fill this.
    lanes: [],
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

/**
 * The DECISIONS, outside the claimed set, that a member waits on and whose gate
 * nobody has approved yet (MOTIR-6094) — read ONCE, before the drain, like the
 * edges.
 *
 * ⚠️ WHY A READ IS NEEDED AT ALL. A decision this run ships is held by the loop
 * itself. One an EARLIER run shipped is not: it sits at `implemented` or
 * `in_review` waiting on its gate, so the claim did not take it, it is not a
 * member, and `unsatisfiedBlockers` — IN-SCOPE ONLY by design — cannot see it.
 * The claim's own validator cannot either: a blocker inside the container's
 * subtree never gates it. So without this read, the re-run a person makes AFTER
 * shipping the decision and BEFORE approving it would build every dependent on a
 * decision nobody has accepted.
 *
 * ⚠️ ONE `get_work_item` PER NON-MEMBER BLOCKER, because the child rows the
 * edges came from carry a status but no type. None of these is a READY read,
 * so the drain's defining invariant is untouched. A read that fails is named
 * and does not hold: the claim already cleared every out-of-scope blocker, and a
 * network error is not evidence that a card is a decision.
 */
export async function readHeldDecisions(
  client: MotirClient,
  members: readonly DispatchItem[],
  edges: ScopeEdges,
): Promise<Set<string>> {
  const memberKeys = new Set(members.map((m) => m.key));
  const outside = new Set<string>();
  for (const key of memberKeys) {
    for (const dep of edges[key] ?? []) if (!memberKeys.has(dep)) outside.add(dep);
  }

  const held = new Set<string>();
  for (const key of outside) {
    try {
      const { item } = await client.getWorkItem(key);
      if (
        isAgentDecisionItem(item) &&
        !DECISION_RELEASED_STATUS_KEYS.has(item.status.toLowerCase())
      ) {
        held.add(key);
      }
    } catch (err) {
      info(
        `Could not read ${key} to check whether it is an unapproved decision: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return held;
}
