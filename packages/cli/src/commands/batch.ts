import { CliError } from '../errors.js';
import { info } from '../output.js';
import { parseKinds } from './read.js';
import { ensureInProgress, resolveAgent, type DeliveryOptions } from './dispatch.js';
import { parseMax } from './auto.js';
import { withProjectSession, type ProjectSession } from '../session.js';
import { runAgent } from '../agentRun.js';
import { addExclude, clearExcludes, readExcludes, removeExclude } from '../sessionExcludes.js';
import { checkBootstrapCheckout, cwdReasonLabel, resolveDispatchTarget } from '../dispatch.js';
import {
  batchExitCode,
  classifySnapshotItem,
  renderBatchSummary,
  renderSnapshotPlan,
  type BatchRecord,
  type BatchStopReason,
  type BatchSummary,
  type Snapshot,
  type SnapshotEntry,
  type SnapshotSkip,
} from '../batchPlan.js';
import type { DispatchItem, MotirClient } from '../mcpClient.js';

// `motir batch` — THE FROZEN SNAPSHOT (Story 7.9 · Subtask 7.9.10 · MOTIR-888).
// Take the ready set ONCE, print it, then implement exactly those items one at a
// time. See `batchPlan.ts` for why the snapshot needs no session branch; this
// module is the drain over it.
//
// ── the two rules that shape this file ──────────────────────────────────────
//  1. **The list is frozen before the first agent starts.** Every item is read
//     up front (`enumerateReady` → `planSnapshot`) and nothing re-reads the
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
 * Enumerate the ready set as DISPATCH payloads, in the server's dispatch order.
 *
 * `next_ready` is the source rather than `list_ready` because only the dispatch
 * payload carries the four facts the snapshot must classify on: `type` and
 * `executor` (the human/planning split), `targetRepo` (which checkout each item
 * routes into), and above all the inherited `sessionBranch` — the one signal
 * that separates "ready from main" from "ready only via an integrated
 * dependency". Both tools read the SAME ready set through the same service, so
 * the enumeration is the list `motir ready` shows, decorated.
 *
 * Advancing via `excludeIds` is what makes it an enumeration rather than a
 * repeated pick: each answer is excluded from the next question, so the loop
 * walks the whole set exactly once and terminates when the server has nothing
 * left to offer.
 */
async function enumerateReady(
  client: MotirClient,
  projectKey: string,
  kinds: string[] | undefined,
  seedExcludeIds: Set<string>,
): Promise<DispatchItem[]> {
  const seen = new Set(seedExcludeIds);
  const items: DispatchItem[] = [];
  for (;;) {
    const { item } = await client.nextReady({
      projectKey,
      ...(kinds ? { kinds } : {}),
      ...(seen.size > 0 ? { excludeIds: [...seen] } : {}),
    });
    if (!item) return items;
    // A server that ignored `excludeIds` would loop forever; stopping on a
    // repeat is the cheap guard that keeps an unattended command terminating.
    if (seen.has(item.id)) return items;
    seen.add(item.id);
    items.push(item);
  }
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
        id: item.id,
        key: item.key,
        title: item.title,
        kind: item.kind,
        targetRepo: item.targetRepo,
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
  const kinds = parseKinds(opts.kinds);
  const max = parseMax(opts.max);
  const agent = requireAgent(opts);

  await withProjectSession(async (session) => {
    const summary = await runBatch({
      session,
      opts,
      kinds,
      max,
      agent,
      clock: deps.clock ?? Date.now,
      runAgentFn: deps.runAgentFn ?? runAgent,
    });
    info('');
    info(renderBatchSummary(summary));
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
}

/** Snapshot, print, drain. Exported so the whole command can be driven against
 *  a scripted client + agent, which is the only way the "never picks up an item
 *  that became ready mid-run" property can actually be asserted. */
export async function runBatch(input: BatchInput): Promise<BatchSummary> {
  const { session, opts, kinds, max, agent, clock, runAgentFn } = input;
  const { client, serverUrl, projectKey } = session;

  if (opts.reset) {
    const cleared = clearExcludes(serverUrl, projectKey);
    info(`Cleared ${cleared} excluded item${cleared === 1 ? '' : 's'}.`);
  }
  // Items a previous run's agent failed on are held out of the snapshot, exactly
  // as `motir next` / `motir auto` hold them out of a pick.
  const persistedExcludes = new Set(readExcludes(serverUrl, projectKey).map((e) => e.id));
  if (persistedExcludes.size > 0) {
    info(
      `Skipping ${persistedExcludes.size} previously-failed item(s) — \`--reset\` retries them.`,
    );
  }

  const snapshot = planSnapshot(await enumerateReady(client, projectKey, kinds, persistedExcludes));
  // Everything the snapshot saw — the frozen boundary. An item outside this set
  // at the end of the run became ready DURING it.
  const snapshotIds = new Set([...snapshot.taken.map((e) => e.id), ...persistedExcludes]);
  const skippedIds = new Set<string>();

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
        agent,
        clock,
        runAgentFn,
      });
      if (outcome.kind === 'skipped') {
        skipped.push(outcome.skip);
        skippedIds.add(entry.id);
        continue;
      }

      records.push(outcome.record);
      if (outcome.record.outcome === 'failed') {
        addExclude(serverUrl, projectKey, { id: entry.id, key: entry.key });
        if (!opts.keepGoing) {
          stopReason = interrupted ? 'interrupted' : 'halted';
          stopIndex = index + 1;
          break;
        }
      } else {
        removeExclude(serverUrl, projectKey, entry.id);
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
  }

  const notReached = snapshot.taken
    .slice(stopIndex)
    .filter((e) => !skippedIds.has(e.id) && !records.some((r) => r.key === e.key));

  return {
    records,
    skipped,
    notReached,
    // Reporting only — read AFTER the drain, and never fed back into it.
    newlyReady: await countNewlyReady(client, projectKey, kinds, snapshotIds, snapshot.skipped),
    stopReason,
  };
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
  snapshotIds: Set<string>,
  snapshotSkips: SnapshotSkip[],
): Promise<{ key: string; title: string | null }[]> {
  const skippedKeys = new Set(snapshotSkips.map((s) => s.key));
  const after = await enumerateReady(client, projectKey, kinds, new Set());
  return after
    .filter((item) => !snapshotIds.has(item.id) && !skippedKeys.has(item.key))
    .map((item) => ({ key: item.key, title: item.title }));
}

interface DispatchOneInput {
  session: ProjectSession;
  entry: SnapshotEntry;
  agent: ResolvedAgent;
  clock: () => number;
  runAgentFn: typeof runAgent;
}

type DispatchOneResult =
  | { kind: 'record'; record: BatchRecord }
  | { kind: 'skipped'; skip: SnapshotSkip };

/** Run ONE snapshot item through the single-dispatch pipeline. */
async function dispatchOne(input: DispatchOneInput): Promise<DispatchOneResult> {
  const { session, entry, agent, clock, runAgentFn } = input;
  const { client, link } = session;

  // The prompt is fetched BEFORE the status flip, which is the opposite order to
  // `motir auto`. `dispatch_prompt` is a pure read (it never claims an item), so
  // fetching first lets the lineage check below refuse an item without having
  // touched it — no flip to undo. NO `sessionBranch` seed is passed, ever: this
  // command has no session branch to offer, and the server can then only answer
  // with the lineage the item genuinely has.
  const dispatch = await client.dispatchPrompt(entry.key);

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

  await ensureInProgress(client, entry.key, entry.statusKey);
  const target = resolveDispatchTarget(link.dir, link.config, dispatch.targetRepo);

  info('');
  info(`── ${entry.key} — ${entry.title ?? ''}`);
  info(`   ${target.cwd}  (${cwdReasonLabel(target)})`);
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
  const suspect = checkBootstrapCheckout(target);
  if (suspect) {
    info(`${entry.key}: ${suspect.message}`);
    info(`Hint: ${suspect.hint}`);
    return {
      kind: 'record',
      record: { ...base, outcome: 'failed', detail: 'bootstrap checkout missing' },
    };
  }

  // Exit 0 means the agent completed the prompt's GIT WORKFLOW, whose last step
  // is opening the pull request — so In Review is the truthful status, and the
  // per-item close-out is `motir done <key>` after the human merges it.
  await client.transitionStatus({ key: entry.key, status: 'in_review' });
  info(`${entry.key}: In Review via its own pull request.`);
  return { kind: 'record', record: { ...base, outcome: 'in_review' } };
}
