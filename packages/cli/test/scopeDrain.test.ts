import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainScope, type ScopeDrainInput } from '../src/commands/scopeDrain.js';
import { orderClaimedSet, unsatisfiedBlockers, type ScopeEdges } from '../src/scopedRun.js';
import { autoExitCode, renderAutoSummary, type AutoSummary } from '../src/autoLoop.js';
import { parseAgentCommand } from '../src/agentProfiles.js';
import { resolveFakeClaim } from './helpers/fakeClaim.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
import type { AgentRunResult } from '../src/agentRun.js';
import type { DispatchItem, DispatchPrompt, MotirClient } from '../src/client.js';
import type { ProjectSession } from '../src/session.js';

// The DRAIN of a claimed scope (Story MOTIR-3001 · MOTIR-3199), driven
// end-to-end against a scripted client + agent — the fixture shape
// `autoCommand.test.ts` already uses, and the only way the defining property of
// this loop can actually be asserted.
//
// ⚠️ THAT PROPERTY IS AN ABSENCE: the run must NEVER query a ready set after the
// claim. It orders a set it already owns from dependency edges, so a mid-drain
// ready read would silently reintroduce exactly the interleaving the up-front
// claim exists to prevent. The fake below THROWS from every ready read, so a
// regression fails by exception rather than by a forgotten assertion.

// ── the pure half, against plain objects ───────────────────────────────────

describe('orderClaimedSet', () => {
  it('orders by dependency, breaking ties by INPUT order (the server’s rank)', () => {
    const edges: ScopeEdges = { C: ['A'], D: ['C'], B: [] };
    expect(orderClaimedSet(['D', 'C', 'B', 'A'], edges)).toEqual(['B', 'A', 'C', 'D']);
  });

  it('ignores an edge pointing OUTSIDE the scope', () => {
    // Out-of-scope blockers were settled by the claim: `not_finishable` is
    // precisely the verdict that outside work gates inside work, and a scope
    // that got past it has none. Treating one as unsatisfiable here would
    // deadlock a set the server already cleared.
    const edges: ScopeEdges = { A: ['SOMEWHERE-ELSE'] };
    expect(orderClaimedSet(['A'], edges)).toEqual(['A']);
  });

  it('is TOTAL: a cycle keeps every card, in input order', () => {
    // ⚠️ A run that silently DROPPED a card it had claimed would leave it In
    // Progress forever with nobody working it — strictly worse than working it
    // in a debatable order. The caller still refuses to dispatch a card whose
    // blockers are unsatisfied, so the cycle is reported rather than built.
    const edges: ScopeEdges = { A: ['B'], B: ['A'] };
    expect(orderClaimedSet(['A', 'B'], edges)).toEqual(['A', 'B']);
  });
});

describe('unsatisfiedBlockers', () => {
  it('names only the IN-SCOPE blockers that have not landed', () => {
    const edges: ScopeEdges = { C: ['A', 'B', 'OUTSIDE-1'] };
    const inScope = new Set(['A', 'B', 'C']);
    expect(unsatisfiedBlockers('C', edges, new Set(['A']), inScope)).toEqual(['B']);
    expect(unsatisfiedBlockers('C', edges, new Set(['A', 'B']), inScope)).toEqual([]);
  });
});

// ── the driven loop ────────────────────────────────────────────────────────

const OWNER = 'user_me';
const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const GIT: CommandRunner = (_bin, args) => {
  if (args[0] === 'ls-remote') return ok('abc123\trefs/heads/motir/auto-x');
  if (args[0] === 'log' || args[0] === 'rev-list') return ok('abc123');
  return ok('');
};

function member(key: string, over: Partial<DispatchItem> = {}): DispatchItem {
  return {
    key,
    kind: 'subtask',
    title: `Item ${key}`,
    priority: 'medium',
    status: { key: 'in_progress', category: 'in_progress' },
    assigneeId: OWNER,
    type: 'code',
    executor: 'coding_agent',
    inheritedSessionBranch: null,
    ...over,
  };
}

interface Fake {
  calls: string[];
  dispatched: string[];
  stderr: string;
  root: string;
}

let fake: Fake;
let home: string;

function client(): MotirClient {
  const c = {
    // ⚠️ EVERY ready read throws. See the header: the absence is the property.
    nextReady: (): never => {
      throw new Error('a scoped drain must never query a ready set after the claim');
    },
    listReadyForDispatch: (): never => {
      throw new Error('a scoped drain must never query a ready set after the claim');
    },
    claimWorkItem: async (args: { key: string }) => {
      fake.calls.push(`claim:${args.key}`);
      const { claim } = resolveFakeClaim(
        { key: args.key, title: `Item ${args.key}`, status: 'in_progress', assigneeId: OWNER },
        { id: OWNER, name: 'Me' },
      );
      return claim;
    },
    dispatchPrompt: async (key: string): Promise<DispatchPrompt> => {
      fake.dispatched.push(key);
      return {
        key,
        prompt: `PROMPT ${key}`,
        parentKey: 'PROD-1',
        targetRepo: 'motir-core',
        workflowMode: 'session_lineage',
        sessionBranch: 'motir/auto-x',
      };
    },
    markIntegrated: async (args: { key: string }) => {
      fake.calls.push(`integrated:${args.key}`);
      return {};
    },
    reportImplementation: async () => ({}),
    getWorkItem: async (key: string) => ({ item: { identifier: key, status: 'in_review' } }),
  };
  return c as unknown as MotirClient;
}

function session(): ProjectSession {
  return {
    link: {
      dir: fake.root,
      path: join(fake.root, '.motir.json'),
      config: { serverUrl: 'https://app.motir.co', workspace: 'moooon', project: 'PROD' },
    },
    serverUrl: 'https://app.motir.co',
    projectKey: 'PROD',
    client: client(),
  };
}

async function drive(
  members: DispatchItem[],
  edges: ScopeEdges,
  over: {
    opts?: ScopeDrainInput['opts'];
    max?: number | null;
    agentResults?: (key: string) => Omit<AgentRunResult, 'model'> & { model?: string | null };
  } = {},
): Promise<AutoSummary> {
  return drainScope({
    session: session(),
    opts: over.opts ?? {},
    members,
    edges,
    max: over.max ?? null,
    agent: { parsed: parseAgentCommand('fake-agent')!, source: 'flag' },
    runId: 'x',
    branch: 'motir/auto-x',
    run: GIT,
    clock: () => 0,
    runAgentFn: async ({ prompt }) => {
      const key = prompt.replace('PROMPT ', '');
      const result = over.agentResults?.(key) ?? { exitCode: 0, signal: null };
      return { model: null, ...result };
    },
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'motir-drain-cfg-'));
  process.env['MOTIR_CONFIG_HOME'] = home;
  const root = mkdtempSync(join(tmpdir(), 'motir-drain-'));
  mkdirSync(join(root, 'motir-core'), { recursive: true });
  fake = { calls: [], dispatched: [], stderr: '', root };
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    fake.stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['MOTIR_CONFIG_HOME'];
  rmSync(home, { recursive: true, force: true });
  rmSync(fake.root, { recursive: true, force: true });
});

describe('drainScope', () => {
  it('works the set in blocked_by order and NEVER re-queries a ready set', async () => {
    // The members arrive in the server's rank, which is the WRONG build order —
    // so a loop that simply iterated the input would dispatch PROD-4 first and
    // the fake's ready reads would never be needed to prove anything. The
    // reorder is what this asserts; the absence of a ready read is what the
    // throwing fake asserts.
    const summary = await drive([member('PROD-4'), member('PROD-3'), member('PROD-2')], {
      'PROD-3': ['PROD-2'],
      'PROD-4': ['PROD-3'],
    });

    expect(fake.dispatched).toEqual(['PROD-2', 'PROD-3', 'PROD-4']);
    expect(summary.stopReason).toBe('drained');
    expect(summary.records.map((r) => r.outcome)).toEqual([
      'integrated',
      'integrated',
      'integrated',
    ]);
  });

  it('SKIPS and NAMES a card whose in-scope blocker did not land — never forces it', async () => {
    // The run OWNS PROD-3. That is not the same as being allowed to build it out
    // of order, and the difference is the whole reason this is a skip rather
    // than a dispatch.
    const summary = await drive(
      [member('PROD-2'), member('PROD-3')],
      { 'PROD-3': ['PROD-2'] },
      {
        opts: { keepGoing: true },
        agentResults: (k) => ({ exitCode: k === 'PROD-2' ? 1 : 0, signal: null }),
      },
    );

    expect(fake.dispatched).toEqual(['PROD-2']);
    expect(summary.skipped).toEqual([
      { key: 'PROD-3', title: 'Item PROD-3', reason: 'blocked_in_scope', blockedBy: ['PROD-2'] },
    ]);
    expect(renderAutoSummary(summary)).toContain('its blockers inside this scope did not land');
  });

  it('SKIPS and NAMES a manual / human card, using the shared vocabulary', async () => {
    // The same `classifyReadyItem` `auto` and `batch` use, so a scoped run
    // cannot disagree with them about what a coding agent may be handed. The
    // story stays open, correctly.
    const summary = await drive(
      [member('PROD-2'), member('PROD-3', { type: 'manual', executor: 'human' })],
      {},
    );

    expect(fake.dispatched).toEqual(['PROD-2']);
    expect(summary.skipped).toEqual([
      { key: 'PROD-3', title: 'Item PROD-3', reason: 'needs_human' },
    ]);
    expect(autoExitCode(summary)).toBe(0);
  });

  it('halts on the first failed agent, and --keep-going continues past one', async () => {
    const halting = await drive(
      [member('PROD-2'), member('PROD-3')],
      {},
      {
        agentResults: (k) => ({ exitCode: k === 'PROD-2' ? 1 : 0, signal: null }),
      },
    );
    expect(halting.stopReason).toBe('halted');
    expect(fake.dispatched).toEqual(['PROD-2']);
    // A failed card leaves nothing reverted and nothing transitioned past where
    // it got to — matching what `motir auto` already does.
    expect(halting.records[0]?.sessionBranch).toBeNull();
    expect(autoExitCode(halting)).not.toBe(0);

    fake.dispatched = [];
    const keepGoing = await drive(
      [member('PROD-2'), member('PROD-3')],
      {},
      {
        opts: { keepGoing: true },
        agentResults: (k) => ({ exitCode: k === 'PROD-2' ? 1 : 0, signal: null }),
      },
    );
    expect(keepGoing.stopReason).toBe('drained');
    expect(fake.dispatched).toEqual(['PROD-2', 'PROD-3']);
  });

  it('--max stops after n cards and the rest are simply not reached', async () => {
    const summary = await drive([member('PROD-2'), member('PROD-3')], {}, { max: 1 });

    expect(summary.stopReason).toBe('max');
    expect(fake.dispatched).toEqual(['PROD-2']);
  });

  it('opens ONE session branch per repo, lazily, and records the repos it touched', async () => {
    const summary = await drive([member('PROD-2'), member('PROD-3')], {});

    expect(summary.repos).toHaveLength(1);
    expect(summary.repos[0]?.branch).toBe('motir/auto-x');
    // Both cards ride the ONE branch — that is what makes one pull request the
    // review surface for the whole scope.
    expect(summary.repos[0]?.keys).toEqual(['PROD-2', 'PROD-3']);
  });

  it('every completed card is at implemented/integrated when the drain returns', async () => {
    const summary = await drive([member('PROD-2')], {});

    expect(summary.records[0]?.outcome).toBe('integrated');
    expect(fake.calls).toContain('integrated:PROD-2');
    // ⚠️ NOT In Review. The checks decide that, server-side, minutes later —
    // this loop does not wait for CI, poll it, or retry on it.
    expect(renderAutoSummary(summary)).not.toContain('CI is green');
  });
});
