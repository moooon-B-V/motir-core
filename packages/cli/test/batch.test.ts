import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planSnapshot,
  runBatch,
  type BatchInput,
  type BatchOptions,
} from '../src/commands/batch.js';
import {
  batchExitCode,
  classifySnapshotItem,
  renderBatchSummary,
  renderSnapshotPlan,
  type BatchSummary,
} from '../src/batchPlan.js';
import { parseMax } from '../src/commands/auto.js';
import { addExclude, readExcludes } from '../src/sessionExcludes.js';
import { CliError } from '../src/errors.js';
import type { AgentRunResult } from '../src/agentRun.js';
import type { DispatchItem, DispatchPrompt, MotirClient } from '../src/mcpClient.js';
import type { ProjectSession } from '../src/session.js';

// `motir batch` — the FROZEN snapshot (Subtask 7.9.10 · MOTIR-888).
//
// Driven end-to-end against a scripted server + agent, because the properties
// that define the command are invisible in any single function: that the list is
// frozen BEFORE the first agent starts, that an item which becomes ready during
// the run is counted but never dispatched (the exact inverse of 7.9.4's
// re-query proof), that no session branch is ever created and `mark_integrated`
// is never called, and that every item lands its own per-item pull request.
//
// The fake server models the REAL readiness rules rather than replaying a fixed
// sequence: a dependency counts as satisfied once it is integrated OR in review,
// and an item inherits the single session branch its integrated dependencies
// live on — which is what makes "ready only via an integrated dep" a real state
// the snapshot filter has to recognise rather than a flag the test sets.

// ── the fake server ─────────────────────────────────────────────────────────

interface FakeItem {
  id: string;
  key: string;
  kind: string;
  title: string;
  type: string | null;
  executor: string | null;
  targetRepo: string | null;
  deps: string[];
  status: string;
  /** This item's OWN recorded integration branch (set by `mark_integrated` in
   *  the real system; pre-set here to build an integrated-dependency fixture). */
  sessionBranch: string | null;
}

function leaf(id: string, key: string, over: Partial<FakeItem> = {}): FakeItem {
  return {
    id,
    key,
    kind: 'subtask',
    title: `Item ${key}`,
    type: 'code',
    executor: 'coding_agent',
    targetRepo: 'motir-core',
    deps: [],
    status: 'todo',
    sessionBranch: null,
    ...over,
  };
}

class FakeServer {
  readonly transitions: { key: string; status: string }[] = [];
  readonly promptCalls: { key: string; seeded: boolean }[] = [];
  readonly nextReadyCalls: { kinds?: string[]; excluded: number }[] = [];
  /** Set to make every write fail the way a read-only PAT does. */
  readOnly = false;
  /** Model a server that IGNORES `excludeIds` — it keeps answering with the
   *  same item. The enumeration must still terminate. */
  ignoreExcludes = false;
  /** Keys the server reports as `session_lineage` WITHOUT naming the branch.
   *  `sessionBranch` is nullable on the dispatch payload, so the refusal has to
   *  read without a name rather than printing `null`. */
  readonly unnamedLineage = new Set<string>();

  constructor(private readonly items: FakeItem[]) {}

  byKey(key: string): FakeItem {
    const item = this.items.find((i) => i.key === key);
    if (!item) throw new Error(`no such item ${key}`);
    return item;
  }

  /** A dependency is satisfied when it is done OR integrated/awaiting review —
   *  the 7.8.11 integrated-dep readiness rule. This is what makes finishing one
   *  item genuinely unlock the next, so "batch does not pick it up" is a real
   *  restraint rather than an absent fixture. */
  private satisfied(depId: string): boolean {
    const dep = this.items.find((i) => i.id === depId);
    return !!dep && (dep.status === 'done' || dep.status === 'in_review');
  }

  /** The single lineage an item INHERITS from its integrated dependencies —
   *  the server's `readiness.inheritedSessionBranch`, which is the field the
   *  snapshot's strict-main-readiness filter reads. */
  private inherited(item: FakeItem): string | null {
    for (const depId of item.deps) {
      const dep = this.items.find((i) => i.id === depId);
      if (dep?.sessionBranch) return dep.sessionBranch;
    }
    return null;
  }

  asClient(): MotirClient {
    const fake = {
      listReady: (): never => {
        throw new Error(
          'batch snapshots via next_ready dispatch payloads — list_ready cannot carry the lineage/type/executor facts it filters on.',
        );
      },
      markIntegrated: (): never => {
        throw new Error('`motir batch` must NEVER integrate onto a session branch.');
      },
      completeSession: (): never => {
        throw new Error('`motir batch` has no session to complete.');
      },
      nextReady: async (args: { kinds?: string[]; excludeIds?: string[] }) => {
        this.nextReadyCalls.push({
          ...(args.kinds ? { kinds: args.kinds } : {}),
          excluded: args.excludeIds?.length ?? 0,
        });
        const excluded = new Set(this.ignoreExcludes ? [] : (args.excludeIds ?? []));
        const item = this.items.find(
          (i) =>
            i.status === 'todo' &&
            !excluded.has(i.id) &&
            (!args.kinds || args.kinds.includes(i.kind)) &&
            i.deps.every((d) => this.satisfied(d)),
        );
        if (!item) return { item: null };
        const payload: DispatchItem = {
          id: item.id,
          key: item.key,
          kind: item.kind,
          title: item.title,
          priority: 'medium',
          status: { key: item.status, category: 'todo' },
          type: item.type,
          executor: item.executor,
          targetRepo: item.targetRepo,
          sessionBranch: this.inherited(item),
        };
        return { item: payload };
      },
      dispatchPrompt: async (
        key: string,
        opts: { sessionBranch?: string | null } = {},
      ): Promise<DispatchPrompt> => {
        const item = this.byKey(key);
        this.promptCalls.push({ key, seeded: opts.sessionBranch !== undefined });
        if (this.unnamedLineage.has(key)) {
          return {
            key,
            prompt: `PROMPT ${key}`,
            targetRepo: item.targetRepo,
            workflowMode: 'session_lineage',
            sessionBranch: null,
          };
        }
        // The server rule: the item's real lineage decides the workflow mode.
        const branch = this.inherited(item) ?? item.sessionBranch ?? opts.sessionBranch ?? null;
        return {
          key,
          prompt: `PROMPT ${key}`,
          targetRepo: item.targetRepo,
          workflowMode: branch ? 'session_lineage' : 'per_item_pr',
          sessionBranch: branch,
        };
      },
      transitionStatus: async (args: { key: string; status: string }) => {
        if (this.readOnly) {
          throw new CliError('FORBIDDEN: this token cannot write to the project.');
        }
        this.transitions.push(args);
        this.byKey(args.key).status = args.status;
        return {};
      },
    };
    return fake as unknown as MotirClient;
  }
}

// ── harness ─────────────────────────────────────────────────────────────────

let root: string;
let configHome: string;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'motir-batch-'));
  mkdirSync(join(root, 'motir-core'), { recursive: true });
  configHome = mkdtempSync(join(tmpdir(), 'motir-batch-cfg-'));
  process.env['MOTIR_CONFIG_HOME'] = configHome;
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
  delete process.env['MOTIR_CONFIG_HOME'];
  rmSync(root, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function session(server: FakeServer): ProjectSession {
  return {
    link: {
      dir: root,
      path: join(root, '.motir.json'),
      config: { serverUrl: 'https://app.motir.co', workspace: 'moooon', project: 'PROD' },
    },
    serverUrl: 'https://app.motir.co',
    projectKey: 'PROD',
    client: server.asClient(),
  };
}

interface DriveOptions {
  opts?: BatchOptions;
  kinds?: string[];
  agentResults?: (key: string, index: number) => AgentRunResult;
  onDispatch?: (key: string, index: number) => void;
}

async function drive(
  server: FakeServer,
  drives: DriveOptions = {},
): Promise<{ summary: BatchSummary; dispatched: string[] }> {
  const dispatched: string[] = [];
  let tick = 0;
  const input: BatchInput = {
    session: session(server),
    opts: drives.opts ?? {},
    kinds: drives.kinds,
    max: drives.opts?.max ? parseMax(drives.opts.max) : null,
    agent: { parsed: { command: 'fake-agent', binary: 'fake-agent', args: [] }, source: 'flag' },
    clock: () => (tick += 1000),
    runAgentFn: async ({ prompt }) => {
      const key = prompt.replace('PROMPT ', '');
      const index = dispatched.length;
      dispatched.push(key);
      drives.onDispatch?.(key, index);
      return drives.agentResults?.(key, index) ?? { exitCode: 0, signal: null };
    },
  };
  const summary = await runBatch(input);
  return { summary, dispatched };
}

/** Everything the run wrote to stderr — the sink `info()` prints to. */
function printed(): string {
  const chunks: string[] = [];
  for (const call of stderrSpy.mock.calls) chunks.push(String(call[0]));
  return chunks.join('');
}

// ── the snapshot filter ─────────────────────────────────────────────────────

describe('classifySnapshotItem', () => {
  it('takes an ordinary coding leaf whose dependencies are all done on main', () => {
    expect(
      classifySnapshotItem({
        kind: 'subtask',
        type: 'code',
        executor: 'coding_agent',
        sessionBranch: null,
      }),
    ).toBe('take');
    expect(classifySnapshotItem({ kind: 'bug', type: null, executor: null })).toBe('take');
  });

  it('EXCLUDES an item that is ready only via an integrated dependency', () => {
    // The dependency's code is not on main, so a pull request of its own against
    // main could not build. That lineage belongs to `motir auto`.
    expect(
      classifySnapshotItem({
        kind: 'subtask',
        type: 'code',
        executor: 'coding_agent',
        sessionBranch: 'motir/auto-20260729-010203',
      }),
    ).toBe('integrated_dep');
  });

  it('defers the planning / human split to the shared 7.9.4 rule', () => {
    expect(classifySnapshotItem({ kind: 'story' })).toBe('needs_planning');
    expect(classifySnapshotItem({ kind: 'Epic' })).toBe('needs_planning');
    expect(classifySnapshotItem({ kind: 'subtask', type: 'manual' })).toBe('needs_human');
    expect(classifySnapshotItem({ kind: 'subtask', executor: 'human' })).toBe('needs_human');
    // A container reports as needing PLANNING even when it also inherits a
    // lineage — the more actionable answer of the two.
    expect(classifySnapshotItem({ kind: 'story', sessionBranch: 'motir/auto-x' })).toBe(
      'needs_planning',
    );
  });
});

describe('planSnapshot', () => {
  it('splits a ready page into the frozen list and the named exclusions', () => {
    const snapshot = planSnapshot([
      {
        id: 'i1',
        key: 'PROD-1',
        kind: 'subtask',
        title: 'A',
        priority: 'medium',
        status: { key: 'todo', category: 'todo' },
        type: 'code',
        executor: 'coding_agent',
        targetRepo: 'motir-core',
        sessionBranch: null,
      },
      {
        id: 'i2',
        key: 'PROD-2',
        kind: 'subtask',
        title: 'B',
        priority: 'medium',
        status: { key: 'todo', category: 'todo' },
        type: 'code',
        executor: 'coding_agent',
        targetRepo: 'motir-core',
        sessionBranch: 'motir/auto-x',
      },
    ]);
    expect(snapshot.taken.map((e) => e.key)).toEqual(['PROD-1']);
    expect(snapshot.taken[0]?.statusKey).toBe('todo');
    expect(snapshot.skipped).toEqual([{ key: 'PROD-2', title: 'B', reason: 'integrated_dep' }]);
  });
});

// ── the defining property: the list is FROZEN ───────────────────────────────

describe('motir batch — the frozen snapshot', () => {
  it('never dispatches an item that became ready DURING the run, and counts it', async () => {
    // PROD-2 depends on PROD-1. Finishing PROD-1 genuinely makes PROD-2 ready
    // (the fake models the real rule) — `motir auto` would follow it. `batch`
    // must not: PROD-2 was not in the snapshot.
    const server = new FakeServer([
      leaf('idA', 'PROD-1'),
      leaf('idB', 'PROD-2', { deps: ['idA'] }),
    ]);
    const { dispatched, summary } = await drive(server);

    expect(dispatched).toEqual(['PROD-1']);
    expect(summary.stopReason).toBe('completed');
    expect(summary.newlyReady).toEqual([{ key: 'PROD-2', title: 'Item PROD-2' }]);
    expect(server.byKey('PROD-2').status).toBe('todo');

    const text = renderBatchSummary(summary);
    expect(text).toContain('1 became ready during the run — NOT dispatched');
    expect(text).toContain('PROD-2');
    expect(text).toContain('or use `motir auto`');
  });

  it('prints the whole snapshot UP FRONT, before any agent starts', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    const printedBeforeFirstAgent: string[] = [];
    await drive(server, {
      onDispatch: (_key, index) => {
        if (index !== 0) return;
        for (const call of stderrSpy.mock.calls) printedBeforeFirstAgent.push(String(call[0]));
      },
    });

    const upFront = printedBeforeFirstAgent.join('');
    expect(upFront).toContain('Snapshot: 2 work items');
    // BOTH items are named before the first one is touched — that is what lets a
    // human Ctrl-C out of a plan they did not want.
    expect(upFront).toContain('PROD-1');
    expect(upFront).toContain('PROD-2');
    expect(upFront).toContain('Items that become ready during the run are NOT picked up');
  });

  it('freezes the list with ONE enumeration, then never re-reads it to pick work', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    await drive(server);
    // Two items + the terminating empty answer = 3 to build the snapshot; the
    // remaining calls are the after-the-fact newly-ready count (reporting only).
    expect(server.nextReadyCalls.length).toBeGreaterThanOrEqual(3);
    expect(server.nextReadyCalls[0]?.excluded).toBe(0);
    expect(server.nextReadyCalls[1]?.excluded).toBe(1);
    expect(server.nextReadyCalls[2]?.excluded).toBe(2);
  });

  it('passes --kinds through to the enumeration', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idS', 'PROD-5', { kind: 'bug' })]);
    const { dispatched } = await drive(server, { kinds: ['bug'] });
    expect(dispatched).toEqual(['PROD-5']);
    expect(server.nextReadyCalls.every((c) => c.kinds?.includes('bug'))).toBe(true);
  });
});

// ── per-item pull requests, and NO session branch ───────────────────────────

describe('motir batch — per-item pull requests', () => {
  it('gives every item its OWN pull request and never touches a session branch', async () => {
    // Two items in the SAME repo: two independent pull requests off origin/main,
    // not one shared branch.
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    const { dispatched, summary } = await drive(server);

    expect(dispatched).toEqual(['PROD-1', 'PROD-2']);
    expect(summary.records.map((r) => r.outcome)).toEqual(['in_review', 'in_review']);
    // The prompt is requested with NO session-branch seed, so the server can only
    // answer with the per-item-PR workflow. (`markIntegrated` on the fake throws,
    // so calling it at all would fail this test.)
    expect(server.promptCalls).toEqual([
      { key: 'PROD-1', seeded: false },
      { key: 'PROD-2', seeded: false },
    ]);
    // Each item walks its own todo → in_progress → in_review lifecycle.
    expect(server.transitions).toEqual([
      { key: 'PROD-1', status: 'in_progress' },
      { key: 'PROD-1', status: 'in_review' },
      { key: 'PROD-2', status: 'in_progress' },
      { key: 'PROD-2', status: 'in_review' },
    ]);
    expect(batchExitCode(summary)).toBe(0);

    const text = renderBatchSummary(summary);
    expect(text).toContain('In Review — each has its OWN pull request to merge (2)');
    expect(text).toContain('motir done PROD-1');
    expect(text).toContain('motir done PROD-2');
  });

  it('refuses an item whose lineage APPEARED after the snapshot was frozen', async () => {
    // Both items are strictly main-ready, so both enter the snapshot. While
    // PROD-1 is running, a CONCURRENT `motir auto` claims and integrates PROD-2
    // onto a session branch. Running it now would integrate onto that branch —
    // exactly what batch guarantees it never does — so it is refused UNTOUCHED.
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    const { dispatched, summary } = await drive(server, {
      onDispatch: (key) => {
        if (key !== 'PROD-1') return;
        const stolen = server.byKey('PROD-2');
        stolen.status = 'in_review';
        stolen.sessionBranch = 'motir/auto-20260729-010203';
      },
    });

    expect(dispatched).toEqual(['PROD-1']);
    expect(summary.skipped).toContainEqual({
      key: 'PROD-2',
      title: 'Item PROD-2',
      reason: 'integrated_dep',
    });
    // Refused UNTOUCHED: batch made no transition of its own on PROD-2, so the
    // other session's state stands exactly as that session left it.
    expect(server.transitions.filter((t) => t.key === 'PROD-2')).toEqual([]);
    expect(renderBatchSummary(summary)).toContain('Run these with `motir auto`');
  });
});

// ── what the snapshot leaves out ────────────────────────────────────────────

describe('motir batch — exclusions', () => {
  it('excludes an integrated-dep item and an unexpanded story, and names both', async () => {
    const server = new FakeServer([
      { ...leaf('idS', 'PROD-5'), kind: 'story', type: null, executor: null },
      leaf('idH', 'PROD-6', { type: 'manual' }),
      // PROD-8's dependency is integrated on a session branch but NOT on main.
      leaf('idDep', 'PROD-7', { status: 'in_review', sessionBranch: 'motir/auto-20260729-010203' }),
      leaf('idL', 'PROD-8', { deps: ['idDep'] }),
      leaf('idA', 'PROD-9'),
    ]);
    const { dispatched, summary } = await drive(server);

    expect(dispatched).toEqual(['PROD-9']);
    expect(summary.skipped).toEqual([
      { key: 'PROD-5', title: 'Item PROD-5', reason: 'needs_planning' },
      { key: 'PROD-6', title: 'Item PROD-6', reason: 'needs_human' },
      { key: 'PROD-8', title: 'Item PROD-8', reason: 'integrated_dep' },
    ]);
    // Excluded means UNTOUCHED — no status flip, no prompt fetched.
    expect(server.transitions.map((t) => t.key)).toEqual(['PROD-9', 'PROD-9']);
    expect(server.promptCalls.map((c) => c.key)).toEqual(['PROD-9']);

    const text = renderBatchSummary(summary);
    expect(text).toContain('Not in the snapshot — needs planning (1)');
    expect(text).toContain('Not in the snapshot — needs a human (1)');
    expect(text).toContain(
      'Not in the snapshot — ready only via an integrated dependency (not on main) (1)',
    );
  });

  it('a read-only PAT cannot dispatch: the write fails and no agent is launched', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1')]);
    server.readOnly = true;
    const dispatched: string[] = [];

    await expect(
      runBatch({
        session: session(server),
        opts: {},
        kinds: undefined,
        max: null,
        agent: {
          parsed: { command: 'fake-agent', binary: 'fake-agent', args: [] },
          source: 'flag',
        },
        clock: () => 0,
        runAgentFn: async ({ prompt }) => {
          dispatched.push(prompt);
          return { exitCode: 0, signal: null };
        },
      }),
    ).rejects.toThrow(/FORBIDDEN/);

    // The snapshot READ succeeded (a read-only token can read), the first WRITE
    // did not, and the agent never ran — nothing was mutated.
    expect(dispatched).toEqual([]);
    expect(server.transitions).toEqual([]);
    expect(server.byKey('PROD-1').status).toBe('todo');
  });
});

// ── the persisted exclude list ──────────────────────────────────────────────

describe('motir batch — previously-failed items', () => {
  it('holds a persisted exclude OUT of the snapshot and says how many', async () => {
    // An item a previous run's agent failed on is excluded at ENUMERATION time,
    // so it is not merely skipped later — it never enters the frozen list, and
    // so can never be counted as "newly ready" either.
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    addExclude('https://app.motir.co', 'PROD', { key: 'PROD-1' });

    const { dispatched, summary } = await drive(server);

    expect(dispatched).toEqual(['PROD-2']);
    expect(summary.newlyReady).toEqual([]);
    expect(printed()).toContain('Skipping 1 previously-failed item(s) — `--reset` retries them.');
  });

  it('--reset clears the list first, counting it in singular and plural', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1')]);
    addExclude('https://app.motir.co', 'PROD', { key: 'PROD-90' });
    addExclude('https://app.motir.co', 'PROD', { key: 'PROD-91' });

    await drive(server, { opts: { reset: true } });
    expect(printed()).toContain('Cleared 2 excluded items.');
    expect(readExcludes('https://app.motir.co', 'PROD')).toEqual([]);

    // …and again with exactly one held back, so the singular arm is real copy
    // rather than a plural with an `s` a reader has to forgive.
    stderrSpy.mockClear();
    server.byKey('PROD-1').status = 'todo';
    addExclude('https://app.motir.co', 'PROD', { key: 'PROD-92' });
    await drive(server, { opts: { reset: true } });
    expect(printed()).toContain('Cleared 1 excluded item.');
  });

  it('records a failure in the exclude list and drops it again on a later success', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1')]);
    await drive(server, { agentResults: () => ({ exitCode: 4, signal: null }) });
    expect(readExcludes('https://app.motir.co', 'PROD').map((e) => e.key)).toEqual(['PROD-1']);

    // The re-run has to be told to retry it, which is what `--reset` is for.
    server.byKey('PROD-1').status = 'todo';
    await drive(server, { opts: { reset: true } });
    expect(readExcludes('https://app.motir.co', 'PROD')).toEqual([]);
  });
});

// ── the enumeration terminates, whatever the server does ────────────────────

describe('motir batch — the enumeration', () => {
  it('stops on a repeat rather than looping forever when the server ignores excludeIds', async () => {
    // `enumerateReady` advances by EXCLUDING each answer from the next question.
    // A server that ignored `excludeIds` would answer with the same item every
    // time, and an unattended command would spin until it was killed. Seeing the
    // same id twice ends the enumeration instead.
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    server.ignoreExcludes = true;

    const { dispatched, summary } = await drive(server);

    expect(dispatched).toEqual(['PROD-1']);
    expect(summary.stopReason).toBe('completed');
    expect(printed()).toContain('Snapshot: 1 work item');
  });
});

// ── shared loop mechanics (7.9.4) ───────────────────────────────────────────

describe('motir batch — failure policy and caps', () => {
  const three = (): FakeServer =>
    new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2'), leaf('idC', 'PROD-3')]);

  it('halts on the first agent failure by default, naming what it never reached', async () => {
    const server = three();
    const { dispatched, summary } = await drive(server, {
      agentResults: (key) =>
        key === 'PROD-2' ? { exitCode: 3, signal: null } : { exitCode: 0, signal: null },
    });

    expect(dispatched).toEqual(['PROD-1', 'PROD-2']);
    expect(summary.stopReason).toBe('halted');
    // The failed item is left In Progress — nothing reverted.
    expect(server.byKey('PROD-2').status).toBe('in_progress');
    expect(summary.notReached.map((e) => e.key)).toEqual(['PROD-3']);
    expect(batchExitCode(summary)).toBe(1);

    const text = renderBatchSummary(summary);
    expect(text).toContain('motir run PROD-2');
    expect(text).toContain('Not reached — still in the snapshot, never started (1)');
  });

  it('--keep-going finishes the rest of the snapshot and never re-dispatches the failure', async () => {
    const server = three();
    const { dispatched, summary } = await drive(server, {
      opts: { keepGoing: true },
      agentResults: (key) =>
        key === 'PROD-1' ? { exitCode: 1, signal: null } : { exitCode: 0, signal: null },
    });

    expect(dispatched).toEqual(['PROD-1', 'PROD-2', 'PROD-3']);
    expect(dispatched.filter((k) => k === 'PROD-1')).toHaveLength(1);
    expect(summary.stopReason).toBe('completed');
    expect(summary.records.filter((r) => r.outcome === 'failed').map((r) => r.key)).toEqual([
      'PROD-1',
    ]);
    expect(summary.notReached).toEqual([]);
    expect(batchExitCode(summary)).toBe(1);
  });

  it('honours --max and leaves the remainder of the snapshot named', async () => {
    const server = three();
    const { dispatched, summary } = await drive(server, { opts: { max: '1' } });

    expect(dispatched).toEqual(['PROD-1']);
    expect(summary.stopReason).toBe('max');
    expect(summary.notReached.map((e) => e.key)).toEqual(['PROD-2', 'PROD-3']);
    expect(renderBatchSummary(summary)).toContain('Re-run `motir batch`');
  });

  it('a Ctrl-C between items exits cleanly with the summary so far', async () => {
    const server = three();
    const { dispatched, summary } = await drive(server, {
      onDispatch: (_key, index) => {
        if (index === 0) process.emit('SIGINT');
      },
    });

    // The in-flight item completes; the run stops before starting another.
    expect(dispatched).toEqual(['PROD-1']);
    expect(summary.stopReason).toBe('interrupted');
    expect(server.byKey('PROD-1').status).toBe('in_review');
    expect(server.byKey('PROD-2').status).toBe('todo');
    expect(summary.notReached.map((e) => e.key)).toEqual(['PROD-2', 'PROD-3']);
    expect(batchExitCode(summary)).toBe(130);
  });

  it('reports an interrupt that arrives DURING a failing agent as interrupted, not halted', async () => {
    // Both stop conditions fire on the same item: the agent failed (which halts
    // without --keep-going) and a Ctrl-C landed while it ran. The interrupt is
    // the more truthful reason — the human stopped the run, and saying "halted
    // on the first agent failure (--keep-going continues past one)" would offer
    // a flag that would not have changed anything.
    const server = three();
    const { dispatched, summary } = await drive(server, {
      onDispatch: (key) => {
        if (key === 'PROD-1') process.emit('SIGINT');
      },
      agentResults: () => ({ exitCode: 2, signal: null }),
    });

    expect(dispatched).toEqual(['PROD-1']);
    expect(summary.stopReason).toBe('interrupted');
    expect(summary.notReached.map((e) => e.key)).toEqual(['PROD-2', 'PROD-3']);
    // A failure outranks the interrupt in the EXIT CODE — something needs fixing.
    expect(batchExitCode(summary)).toBe(1);
    expect(renderBatchSummary(summary)).toContain('interrupted (Ctrl-C)');
  });

  it('a SECOND Ctrl-C exits immediately instead of finishing the item in flight', async () => {
    const server = three();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      await drive(server, {
        onDispatch: (_key, index) => {
          if (index !== 0) return;
          process.emit('SIGINT');
          process.emit('SIGINT');
        },
      });
      expect(exitSpy).toHaveBeenCalledWith(130);
    } finally {
      exitSpy.mockRestore();
    }
    // The first interrupt still printed the "press again" contract it offered.
    expect(printed()).toContain('Press Ctrl-C again to exit immediately.');
  });
});

// ── how one item can end ────────────────────────────────────────────────────

describe('motir batch — a single item’s outcomes', () => {
  it('reports an agent killed by a SIGNAL with the signal, not a bare exit code', async () => {
    const server = new FakeServer([leaf('idA', 'PROD-1')]);
    const { summary } = await drive(server, {
      agentResults: () => ({ exitCode: 1, signal: 'SIGKILL' }),
    });

    expect(summary.records).toEqual([
      expect.objectContaining({ key: 'PROD-1', outcome: 'failed', detail: 'killed by SIGKILL' }),
    ]);
    expect(renderBatchSummary(summary)).toContain('FAILED (killed by SIGKILL)');
    // Killed is still failed: In Progress, nothing reverted.
    expect(server.byKey('PROD-1').status).toBe('in_progress');
  });

  it('counts a bootstrap dispatch that never produced its checkout as FAILED', async () => {
    // `motir-ai` has no checkout under the root, so the item routes to the
    // workspace root for the prompt to CREATE it. The agent exits 0 without
    // creating anything — the dispatch did not do its job, so a clean exit code
    // must not be read as success, and the item must not go to In Review.
    const server = new FakeServer([leaf('idA', 'PROD-1', { targetRepo: 'motir-ai' })]);
    const { summary } = await drive(server);

    expect(summary.records).toEqual([
      expect.objectContaining({
        key: 'PROD-1',
        outcome: 'failed',
        detail: 'bootstrap checkout missing',
        repo: 'motir-ai',
      }),
    ]);
    expect(server.transitions).toEqual([{ key: 'PROD-1', status: 'in_progress' }]);
    expect(printed()).toContain('still has no checkout');
    expect(printed()).toContain('motir link add motir-ai');
  });

  it('names the refusal readably when the server reports lineage without a branch name', async () => {
    // `sessionBranch` is nullable on the dispatch payload, so the refusal cannot
    // assume a name to print. It must still say what happened rather than
    // interpolating `null` into the sentence.
    const server = new FakeServer([leaf('idA', 'PROD-1'), leaf('idB', 'PROD-2')]);
    server.unnamedLineage.add('PROD-1');

    const { dispatched, summary } = await drive(server);

    expect(dispatched).toEqual(['PROD-2']);
    expect(summary.skipped).toContainEqual({
      key: 'PROD-1',
      title: 'Item PROD-1',
      reason: 'integrated_dep',
    });
    expect(printed()).toContain(
      'PROD-1: skipped — a dependency was integrated on a session branch after the snapshot was taken.',
    );
    // Refused UNTOUCHED — the refusal precedes the status flip.
    expect(server.transitions.map((t) => t.key)).toEqual(['PROD-2', 'PROD-2']);
  });
});

// ── rendering ───────────────────────────────────────────────────────────────

describe('the snapshot plan block', () => {
  it('says plainly when there is nothing to implement', () => {
    expect(renderSnapshotPlan({ taken: [], skipped: [] })).toContain(
      'Snapshot: no work items to implement.',
    );
  });

  it('tables the taken items and groups the exclusions by reason', () => {
    const text = renderSnapshotPlan({
      taken: [
        {
          id: 'i1',
          key: 'PROD-1',
          title: 'Add the thing',
          kind: 'subtask',
          targetRepo: 'motir-core',
        },
      ],
      skipped: [{ key: 'PROD-2', title: 'A story', reason: 'needs_planning' }],
    });
    expect(text).toContain('Snapshot: 1 work item');
    expect(text).toContain('PROD-1');
    expect(text).toContain('motir-core');
    expect(text).toContain('Not in the snapshot — needs planning (1)');
  });

  it('renders an unpinned repo and an absent title as placeholders, never "null"', () => {
    // `targetRepo` and `title` are both nullable on a work item, and this table
    // is the first thing a human reads before deciding to let the run proceed.
    const text = renderSnapshotPlan({
      taken: [{ id: 'i1', key: 'PROD-1', title: null, kind: 'subtask', targetRepo: null }],
      skipped: [{ key: 'PROD-2', title: null, reason: 'needs_human' }],
    });
    expect(text).toContain('—');
    expect(text).toContain('Not in the snapshot — needs a human (1)');
    expect(text).not.toContain('null');
  });
});

describe('the end-of-run summary block', () => {
  const summary = (over: Partial<BatchSummary> = {}): BatchSummary => ({
    records: [],
    skipped: [],
    notReached: [],
    newlyReady: [],
    stopReason: 'completed',
    ...over,
  });

  it('says plainly when nothing was dispatched', () => {
    const text = renderBatchSummary(summary());
    expect(text).toContain('Batch finished — stopped: the whole snapshot was attempted.');
    expect(text).toContain('No work items were dispatched.');
    // Nothing is In Review, so the merge-these block is absent rather than empty.
    expect(text).not.toContain('OWN pull request to merge');
  });

  it('tables a run where everything FAILED, with no In Review block', () => {
    const text = renderBatchSummary(
      summary({
        records: [{ key: 'PROD-1', title: null, outcome: 'failed', durationMs: 1000, repo: null }],
        stopReason: 'halted',
      }),
    );
    expect(text).toContain('halted on the first agent failure');
    expect(text).toContain('Failed — still In Progress, nothing reverted (1)');
    expect(text).toContain('motir run PROD-1');
    expect(text).not.toContain('OWN pull request to merge');
    expect(text).not.toContain('null');
  });

  it('names a not-reached and a newly-ready item that carry no title', () => {
    const text = renderBatchSummary(
      summary({
        notReached: [{ id: 'i2', key: 'PROD-2', title: null, kind: 'subtask', targetRepo: null }],
        newlyReady: [{ key: 'PROD-3', title: null }],
        stopReason: 'max',
      }),
    );
    expect(text).toContain('--max reached');
    expect(text).toContain('Not reached — still in the snapshot, never started (1)');
    expect(text).toContain('PROD-2');
    expect(text).toContain('1 became ready during the run — NOT dispatched');
    expect(text).toContain('PROD-3');
    expect(text).not.toContain('null');
  });
});
