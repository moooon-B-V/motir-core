import { CliError } from '../errors.js';
import { info } from '../output.js';
import { parseKinds } from './read.js';
import {
  claimAllowsDispatch,
  ensureInProgress,
  resolveAgent,
  resolveOwnerId,
  type DeliveryOptions,
} from './dispatch.js';
import { parseMax } from './auto.js';
import { withProjectSession, type ProjectSession } from '../session.js';
import { runAgent } from '../agentRun.js';
import { deriveAgentHarness } from '../agentProfiles.js';
import { addExclude, clearExcludes, readExcludes, removeExclude } from '../sessionExcludes.js';
import {
  agentSubmittedReplan,
  autoOnlyFlagError,
  checkBootstrapCheckout,
  cwdReasonLabel,
  findingsPolicyOf,
  renderClaimRefusal,
  renderFindingsPolicy,
  renderNothingPushed,
  renderReplanSubmitted,
  renderRepositoriesBlock,
  resolveDispatchTarget,
  resolveDispatchTargets,
} from '../dispatch.js';
import { execCommand, workReachedRemote, type CommandRunner } from '../git.js';
import {
  batchExitCode,
  classifySnapshotItem,
  renderBatchSummary,
  renderSnapshotPlan,
  type BatchReconcile,
  type BatchRecord,
  type BatchStopReason,
  type BatchSummary,
  type ReconciledCard,
  type Snapshot,
  type SnapshotEntry,
  type SnapshotSkip,
} from '../batchPlan.js';
import type { DispatchItem, MotirClient } from '../client.js';

// `motir batch` — THE FROZEN SNAPSHOT (Story 7.9 · Subtask 7.9.10 · MOTIR-888).
// Take the ready set ONCE, print it, then implement exactly those items one at a
// time. See `batchPlan.ts` for why the snapshot needs no session branch; this
// module is the drain over it.
//
// ── the two rules that shape this file ──────────────────────────────────────
//  1. **The list is frozen before the first agent starts.** Every item is read
//     up front (`listReadyForDispatch` → `planSnapshot`) and nothing re-reads the
//     ready set to pick work afterwards. The only later read is the newly-ready
//     COUNT, which is reporting — it can never add an item to the run.
//  2. **No git, no lineage.** This module deliberately imports nothing from
//     `git.ts`: it creates no branch, pushes nothing, and opens no pull request.
//     Each item's server-generated prompt carries the per-item-PR GIT WORKFLOW,
//     so the AGENT branches off origin/main in its own repo and opens its own
//     pull request. `mark_integrated` is never called — two items in the same
//     repo simply open two independent pull requests.

export interface BatchOptions extends DeliveryOptions {
  kinds?: string;
  /** `--max <n>` — cap the dispatches this invocation makes. */
  max?: string;
  /** `--keep-going` — continue past a failed agent instead of halting. */
  keepGoing?: boolean;
  /** `--reset` — clear this project's persisted exclude list first. */
  reset?: boolean;
}

/** Injectable seams; never overridden in production. */
export interface BatchDeps {
  clock?: () => number;
  /** The agent launcher. Injected by the tests so the drain can be driven with
   *  a scripted agent — the fixture the acceptance criteria are written against. */
  runAgentFn?: typeof runAgent;
  /** The git runner the push check (MOTIR-3004) asks — the same seam
   *  `motir auto` takes, and deliberately NOT on `BatchOptions`, which is the
   *  FLAG surface (`optionRegistrationAudit` holds every field there to a
   *  registered option). */
  run?: CommandRunner;
}

type ResolvedAgent = NonNullable<ReturnType<typeof resolveAgent>>;

/**
 * `motir batch` REQUIRES an agent, for the same reason `motir auto` does:
 * `--print` is the copy-paste-into-your-agent mode, and there is nobody to paste
 * a snapshot of prompts. An error with guidance beats a silently degraded run.
 */
function requireAgent(opts: BatchOptions): ResolvedAgent {
  if (opts.print) {
    throw new CliError('`motir batch` cannot run in --print mode.', {
      hint: 'A batch has nobody to paste a prompt. Use `motir next --print` for one item, or pass --agent <cmd>.',
    });
  }
  const agent = resolveAgent(opts);
  if (!agent) {
    throw new CliError('`motir batch` needs an agent to run.', {
      hint: 'Pass --agent "<cmd>", set MOTIR_AGENT, or configure agentCommand. `motir doctor` checks it.',
    });
  }
  return agent;
}

// ── the snapshot ────────────────────────────────────────────────────────────

/**
 * The whole ready set, in the server's rank — the snapshot's raw material.
 *
 * ONE page walk (MOTIR-2398). It used to ask `next_ready` once per item with a
 * growing exclusion list — N requests to enumerate N items, plus a
 * stop-on-repeat guard against a server that ignored the exclusions. The
 * collection returns the same ranked set in pages, so neither is needed.
 */
/**
 * Split an enumerated ready set into what this run may take and what a previous
 * run's failure holds out, matching on KEY (MOTIR-2338).
 *
 * Both halves are returned because the held-out items are still part of the
 * snapshot BOUNDARY: they were ready when the run started, so an item that is
 * ready at the end and was held out did not "arrive during the run".
 */
function partitionByExclusion(
  items: readonly DispatchItem[],
  excludedKeys: ReadonlySet<string>,
): [DispatchItem[], DispatchItem[]] {
  const eligible: DispatchItem[] = [];
  const heldOut: DispatchItem[] = [];
  for (const item of items) {
    (excludedKeys.has(item.key.toUpperCase()) ? heldOut : eligible).push(item);
  }
  return [eligible, heldOut];
}

/** Freeze the ready set into the run's plan: what will be implemented, and
 *  what is left out with the reason. */
export function planSnapshot(items: DispatchItem[]): Snapshot {
  const taken: SnapshotEntry[] = [];
  const skipped: SnapshotSkip[] = [];
  for (const item of items) {
    const disposition = classifySnapshotItem(item);
    if (disposition === 'take') {
      taken.push({
        key: item.key,
        title: item.title,
        kind: item.kind,
        statusKey: item.status?.key,
      });
    } else {
      skipped.push({ key: item.key, title: item.title, reason: disposition });
    }
  }
  return { taken, skipped };
}

// ── the command ─────────────────────────────────────────────────────────────

export async function batchCommand(opts: BatchOptions, deps: BatchDeps = {}): Promise<void> {
  // `--auto-approve-replan` is registered here in order to be REFUSED
  // (MOTIR-3022), and the reason is `batch`'s defining contract: the snapshot is
  // frozen before the first agent starts and nothing re-reads the ready set, so
  // cards a newly-approved plan creates would be approved and then never
  // dispatched. Approving a change to a plan and declining to act on it is worse
  // than not offering the flag.
  if (opts.autoApproveReplan) {
    const { message, hint } = autoOnlyFlagError('batch');
    throw new CliError(message, { hint });
  }
  const kinds = parseKinds(opts.kinds);
  const max = parseMax(opts.max);
  const agent = requireAgent(opts);

  await withProjectSession(async (session) => {
    // ONE `whoami` for the whole run — see the note on `motir auto`'s.
    const ownerId = await resolveOwnerId(session.client);
    const summary = await runBatch({
      session,
      opts,
      kinds,
      max,
      agent,
      clock: deps.clock ?? Date.now,
      runAgentFn: deps.runAgentFn ?? runAgent,
      run: deps.run ?? execCommand,
      ownerId,
    });
    info('');
    info(renderBatchSummary(summary));
    info(renderFindingsPolicy(opts));
    process.exitCode = batchExitCode(summary);
  });
}

export interface BatchInput {
  session: ProjectSession;
  opts: BatchOptions;
  kinds: string[] | undefined;
  max: number | null;
  agent: ResolvedAgent;
  clock: () => number;
  runAgentFn: typeof runAgent;
  /** The token owner — every card this run takes is CLAIMED for them, and rows
   *  claimed by anyone else never enter the snapshot (MOTIR-2427). */
  ownerId: string;
  /** The git runner the MOTIR-3004 push check asks; defaults to the real one. */
  run?: CommandRunner;
}

/** Snapshot, print, drain. Exported so the whole command can be driven against
 *  a scripted client + agent, which is the only way the "never picks up an item
 *  that became ready mid-run" property can actually be asserted. */
export async function runBatch(input: BatchInput): Promise<BatchSummary> {
  const { session, opts, kinds, max, agent, clock, runAgentFn, ownerId } = input;
  const gitRun = input.run ?? execCommand;
  const { client, serverUrl, projectKey } = session;

  if (opts.reset) {
    const cleared = clearExcludes(serverUrl, projectKey);
    info(`Cleared ${cleared} excluded item${cleared === 1 ? '' : 's'}.`);
  }
  // Items a previous run's agent failed on are held out of the snapshot, exactly
  // as `motir next` / `motir auto` hold them out of a pick.
  // The PERSISTED list is keyed by KEY (MOTIR-2338). The page walk enumerates the
  // WHOLE ready set, so no id translation is needed here — the excluded items
  // are simply filtered out of what it returns, which is the same set as before.
  const persistedExcludes = new Set(
    readExcludes(serverUrl, projectKey).map((e) => e.key.toUpperCase()),
  );
  if (persistedExcludes.size > 0) {
    info(
      `Skipping ${persistedExcludes.size} previously-failed item(s) — \`--reset\` retries them.`,
    );
  }

  // The snapshot only ever contains rows this run may take (MOTIR-2427):
  // unassigned, or its own interrupted work, and in the to-do category. Applied
  // at ENUMERATION rather than at dispatch, because the snapshot is the frozen
  // boundary a human reads before the first agent starts — a teammate's card
  // listed there and skipped later would have been printed as work about to
  // happen.
  const enumerated = await client.listReadyForDispatch({
    projectKey,
    ownerId,
    ...(kinds ? { kinds } : {}),
  });
  const [eligible, heldOut] = partitionByExclusion(enumerated, persistedExcludes);
  const snapshot = planSnapshot(eligible);
  // Everything the snapshot saw — the frozen boundary. An item outside this set
  // at the end of the run became ready DURING it. The held-out items were seen,
  // so they belong to the boundary too.
  const snapshotKeys = new Set([
    ...snapshot.taken.map((e) => e.key.toUpperCase()),
    ...heldOut.map((item) => item.key.toUpperCase()),
  ]);
  const skippedKeys = new Set<string>();

  info(renderSnapshotPlan(snapshot));

  const records: BatchRecord[] = [];
  const skipped: SnapshotSkip[] = [...snapshot.skipped];
  let stopIndex = snapshot.taken.length;
  let stopReason: BatchStopReason = 'completed';

  let interrupted = false;
  const onSigint = (): void => {
    if (interrupted) process.exit(130);
    interrupted = true;
    info('');
    info('Interrupt received — finishing the item in flight, then stopping.');
    info('Press Ctrl-C again to exit immediately.');
  };
  process.on('SIGINT', onSigint);

  try {
    for (const [index, entry] of snapshot.taken.entries()) {
      if (interrupted) {
        stopReason = 'interrupted';
        stopIndex = index;
        break;
      }
      if (max !== null && records.length >= max) {
        stopReason = 'max';
        stopIndex = index;
        break;
      }

      const outcome = await dispatchOne({
        session,
        entry,
        opts,
        agent,
        clock,
        runAgentFn,
        run: gitRun,
      });
      if (outcome.kind === 'skipped') {
        skipped.push(outcome.skip);
        skippedKeys.add(entry.key.toUpperCase());
        continue;
      }

      records.push(outcome.record);
      if (outcome.record.outcome === 'failed') {
        addExclude(serverUrl, projectKey, { key: entry.key });
        if (!opts.keepGoing) {
          stopReason = interrupted ? 'interrupted' : 'halted';
          stopIndex = index + 1;
          break;
        }
      } else {
        removeExclude(serverUrl, projectKey, entry.key);
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
  }

  const notReached = snapshot.taken
    .slice(stopIndex)
    .filter((e) => !skippedKeys.has(e.key.toUpperCase()) && !records.some((r) => r.key === e.key));

  return {
    records,
    skipped,
    notReached,
    // Reporting only — read AFTER the drain, and never fed back into it.
    newlyReady: await countNewlyReady(client, projectKey, kinds, snapshotKeys, snapshot.skipped),
    ...(records.length > 0 ? { reconcile: await reconcileDispatched(client, records) } : {}),
    stopReason,
  };
}

/**
 * Read every dispatched card BACK, once, at exit (MOTIR-3197).
 *
 * ── Why this is one read per key, and what was ruled out ────────────────────
 * The cheaper shape would be one collection call narrowed to the dispatched
 * keys, and every `/api/v1` operation whose 200 embeds a work-item summary was
 * enumerated from the generated `src/api/schema.d.ts` before settling for this:
 *
 *   • `listProjectWorkItems` — the fattest one, and it takes a `filter`, but
 *     the FilterAST has NO key field (`lib/filters/ast.ts`'s
 *     `BuiltInFilterFieldId` is kind / status / priority / type / assignee /
 *     reporter / sprint / text / created / updated / due / storyPoints /
 *     estimate, plus `lbl` / `cmp` / `cf:*`). It cannot express a key SET at
 *     all, so narrowing would mean paging the whole project and discarding
 *     most of it.
 *   • `listSprintWorkItems` / `listProjectBacklog` — narrowed by MEMBERSHIP,
 *     which is not the run's set: a batch snapshot spans whatever was ready.
 *   • `getProjectReadySet` — cannot contain a dispatched card by construction.
 *     Every one of them left the to-do category when it was claimed.
 *   • `getWorkItem` — per key, and the only operation that can name this set.
 *
 * So the fallback the card allows for is the only door, and the bound is the
 * number of cards this run dispatched — which `--max` and the frozen snapshot
 * already cap. Sequential rather than concurrent: it is the tail of a run that
 * has just spent minutes per card, so there is nothing to win, and a burst
 * against the rate limiter at exit would be a poor trade for it.
 *
 * ⚠️ IT NEVER FAILS THE RUN. Every error is caught and rendered; none reaches
 * `batchExitCode`, which reads only `records` and `stopReason` — so a run's
 * exit code is exactly what it would have been before this existed.
 *
 * ── ONE failure, or ALL of them ────────────────────────────────────────────
 * A single card that will not read is a NULL STATUS with its reason, kept in
 * the block: the other rows are still facts, and dropping the odd one out is
 * how a summary starts lying quietly.
 *
 * When NO card could be read the answer is different in kind, not in degree —
 * the server is unreachable, the token was revoked, the process is coming down
 * — and printing N identical "could not be read" rows would bury one fact
 * under a list. That collapses to `unavailable`, which says once that nobody
 * looked. The run's own table above still carries every key.
 */
async function reconcileDispatched(
  client: MotirClient,
  records: readonly BatchRecord[],
): Promise<BatchReconcile> {
  const cards: ReconciledCard[] = [];
  for (const record of records) {
    try {
      const detail = await client.getWorkItem(record.key);
      cards.push({ key: record.key, status: detail.item.status });
    } catch (err) {
      // ⚠️ NOT `status: 'implemented'`, and not a dropped row. The run cannot
      // see where this card is, and saying so is the only honest column.
      cards.push({ key: record.key, status: null, detail: errorText(err) });
    }
  }
  const firstFailure = cards[0];
  if (firstFailure && cards.every((c) => c.status === null)) {
    return { cards: [], unavailable: firstFailure.detail ?? 'the read-back failed' };
  }
  return { cards };
}

/** An error's message for the summary — never a stack, never `[object Object]`. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Which items became ready DURING the run — the count that tells a human a
 * frozen snapshot cost them something.
 *
 * A fresh enumeration minus everything the snapshot saw. Items the run
 * dispatched are In Review / In Progress and so are no longer ready at all;
 * items the snapshot skipped are still ready and are excluded BY KEY, so a
 * needs-planning story is never miscounted as newly ready.
 */
async function countNewlyReady(
  client: MotirClient,
  projectKey: string,
  kinds: string[] | undefined,
  snapshotKeys: Set<string>,
  snapshotSkips: SnapshotSkip[],
): Promise<{ key: string; title: string | null }[]> {
  const skippedKeys = new Set(snapshotSkips.map((s) => s.key));
  const after = await client.listReadyForDispatch({ projectKey, ...(kinds ? { kinds } : {}) });
  return after
    .filter((item) => !snapshotKeys.has(item.key.toUpperCase()) && !skippedKeys.has(item.key))
    .map((item) => ({ key: item.key, title: item.title }));
}

interface DispatchOneInput {
  session: ProjectSession;
  entry: SnapshotEntry;
  /** The run's flags — read for the per-run findings policy alone (MOTIR-3022),
   *  which has to reach the PROMPT rather than stay in this process. */
  opts: BatchOptions;
  agent: ResolvedAgent;
  clock: () => number;
  runAgentFn: typeof runAgent;
  /** The git runner the push check uses (MOTIR-3004) — the same injection seam
   *  `motir auto` takes its runner through. */
  run: CommandRunner;
}

type DispatchOneResult =
  | { kind: 'record'; record: BatchRecord }
  | { kind: 'skipped'; skip: SnapshotSkip };

/** Run ONE snapshot item through the single-dispatch pipeline. */
async function dispatchOne(input: DispatchOneInput): Promise<DispatchOneResult> {
  const { session, entry, agent, clock, runAgentFn, run } = input;
  const { client, link } = session;

  // The prompt is fetched BEFORE the status flip, which is the opposite order to
  // `motir auto`. `dispatch_prompt` is a pure read (it never claims an item), so
  // fetching first lets the lineage check below refuse an item without having
  // touched it — no flip to undo. NO `sessionBranch` seed is passed, ever: this
  // command has no session branch to offer, and the server can then only answer
  // with the lineage the item genuinely has.
  const dispatch = await client.dispatchPrompt(entry.key, {
    findingsPolicy: findingsPolicyOf(input.opts),
  });

  if (dispatch.workflowMode === 'session_lineage') {
    // The snapshot filter already excluded every item with an inherited
    // lineage, so reaching here means one APPEARED between the snapshot and now
    // (a concurrent `motir auto` integrated a dependency). Running it would
    // integrate onto a session branch, which is precisely what `batch`
    // guarantees it never does — so refuse, untouched, and name it.
    info(
      `${entry.key}: skipped — a dependency was integrated on ${
        dispatch.sessionBranch ?? 'a session branch'
      } after the snapshot was taken.`,
    );
    return {
      kind: 'skipped',
      skip: { key: entry.key, title: entry.title, reason: 'integrated_dep' },
    };
  }

  // THE CLAIM, and it can say no (MOTIR-3048). It comes after the lineage check
  // for the same reason that check comes first: a refusal there must leave the
  // card untouched, and a claim already made would have to be undone. From here
  // on nothing else can refuse, so this is the last point at which the run can
  // walk away having changed nothing.
  const claim = await ensureInProgress(client, entry.key);
  if (!claimAllowsDispatch(claim)) {
    // A SKIP, not a failure: the snapshot froze a set this run could take, and
    // a sibling took one of them in between. No agent ran, nothing was
    // reverted, and `batchExitCode` reads only `records` — so the run's exit
    // code is unaffected, which is the honest report of "somebody else has it".
    info('');
    info(renderClaimRefusal(claim));
    return {
      kind: 'skipped',
      skip: { key: entry.key, title: entry.title, reason: 'claim_refused' },
    };
  }
  // MOTIR-3133 — the same per-repository resolution `deliver()` makes, from the
  // same function, rendered by the same block. Batch prints its own lines rather
  // than going through `deliver()`, and a second rendering of these facts is
  // exactly how the two would drift.
  const targets = resolveDispatchTargets(
    link.dir,
    link.config,
    (dispatch.targetRepos ?? []).map((repo) => repo.name),
  );
  const target = targets[0] ?? resolveDispatchTarget(link.dir, link.config, dispatch.targetRepo);

  info('');
  info(`── ${entry.key} — ${entry.title ?? ''}`);
  info(`   ${target.cwd}  (${cwdReasonLabel(target)})`);
  for (const line of renderRepositoriesBlock(targets)) info(`   ${line.trimStart()}`);
  info('   its own branch off origin/main, its own pull request');

  const started = clock();
  const result = await runAgentFn({
    command: agent.parsed,
    prompt: dispatch.prompt,
    cwd: target.cwd,
  });
  const durationMs = clock() - started;
  const base = { key: entry.key, title: entry.title, durationMs, repo: dispatch.targetRepo };

  if (result.exitCode !== 0) {
    info(`${entry.key}: agent exited ${result.exitCode} — left In Progress, nothing reverted.`);
    return {
      kind: 'record',
      record: {
        ...base,
        outcome: 'failed',
        detail: result.signal ? `killed by ${result.signal}` : `exit ${result.exitCode}`,
      },
    };
  }

  // A bootstrap dispatch that did not produce its checkout is a FAILED dispatch,
  // not a success with a warning: the prompt's whole job was to create it.
  const suspect = (targets.length > 0 ? targets : [target])
    .map((t) => checkBootstrapCheckout(t))
    .find((s) => s !== null);
  if (suspect) {
    info(`${entry.key}: ${suspect.message}`);
    info(`Hint: ${suspect.hint}`);
    return {
      kind: 'record',
      record: { ...base, outcome: 'failed', detail: 'bootstrap checkout missing' },
    };
  }

  // ⚠️ EXIT 0 IS NOT AN OUTCOME (MOTIR-3018). A finished card and a REFUSED one
  // both exit 0, so ask the card which it was before deciding anything else —
  // and ask BEFORE the push check, because a refusing agent reverts and pushes
  // nothing by design, so that check would otherwise report a correctly-refused
  // card as work that went missing. A skip, not a record: the run implemented
  // nothing, and `keepGoing` is not consulted because there was no failure.
  if (await agentSubmittedReplan(client, entry.key)) {
    info(renderReplanSubmitted(entry.key));
    return {
      kind: 'skipped',
      skip: { key: entry.key, title: entry.title, reason: 'replan_submitted' },
    };
  }

  // ⚠️ EXIT 0 IS NOT A PUSH (MOTIR-3004). `implemented` claims the code is on the
  // remote; an agent that exits 0 having pushed nothing must not produce a card
  // that says so. Refused rather than recorded — the item stays In Progress,
  // which is what an interrupted run looks like.
  if (workReachedRemote(target.cwd, entry.key, null, run) === 'nothing') {
    info(renderNothingPushed(entry.key, dispatch));
    return {
      kind: 'record',
      record: { ...base, outcome: 'failed', detail: 'nothing reached the remote' },
    };
  }

  // Exit 0 AND the work is on the remote: the agent completed the prompt's GIT
  // WORKFLOW, whose last step is opening the pull request — so Implemented is the
  // truthful status (built, pushed, waiting on CI), and the per-item close-out is
  // `motir done <key>` after the human merges it.
  await client.transitionStatus({ key: entry.key, status: 'implemented' });
  // What BUILT it, recorded as its own fact (MOTIR-2421). Two calls rather than
  // one because they assert different things: the transition says where the item
  // is, this says what ran. `motir auto` gets both from `mark_integrated`, which
  // can only speak while also claiming a session branch — and batch has none.
  // Same split by who-knows as the loop's (MOTIR-2419): the harness comes off
  // the command this run launched, the model off the agent's own report.
  await client.reportImplementation({
    key: entry.key,
    implementationSource: 'byok',
    implementationHarness: deriveAgentHarness(agent.parsed.binary),
    implementationModel: result.model,
  });
  info(`${entry.key}: Implemented via its own pull request — CI decides when it is reviewable.`);
  return { kind: 'record', record: { ...base, outcome: 'implemented' } };
}
