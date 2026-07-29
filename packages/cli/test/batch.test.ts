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
        const excluded = new Set(args.excludeIds ?? []);
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
});
