import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainScope, readScopeEdges, type ScopeDrainInput } from '../src/commands/scopeDrain.js';
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
  /** Whether each prompt read carried a session-branch seed, in order. */
  promptSeeds: boolean[];
  stderr: string;
  root: string;
}

/** Keys whose card reads back as `planning` — the agent refused it (MOTIR-3018). */
let replanned: Set<string>;
/** Keys whose per-card claim re-assert is REFUSED (defensive; see the test). */
let claimRefuses: Set<string>;
/** Per-key repository SET, for the multi-repository card (MOTIR-3135). */
let repoSets: Record<string, NonNullable<DispatchPrompt['targetRepos']>>;
/** Per-key primary repository, so a card can be routed at a missing checkout. */
let repoOf: Record<string, string>;

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
        {
          key: args.key,
          title: `Item ${args.key}`,
          status: claimRefuses.has(args.key) ? 'in_review' : 'in_progress',
          assigneeId: claimRefuses.has(args.key) ? null : OWNER,
        },
        { id: OWNER, name: 'Me' },
      );
      return claim;
    },
    dispatchPrompt: async (
      key: string,
      opts: { sessionBranch?: string | null } = {},
    ): Promise<DispatchPrompt> => {
      fake.dispatched.push(key);
      fake.promptSeeds.push(opts.sessionBranch !== undefined);
      const set = repoSets[key];
      return {
        key,
        prompt: `PROMPT ${key}`,
        parentKey: 'PROD-1',
        targetRepo: repoOf[key] ?? 'motir-core',
        ...(set ? { targetRepos: set } : {}),
        workflowMode: opts.sessionBranch ? 'session_lineage' : 'per_item_pr',
        sessionBranch: opts.sessionBranch ?? null,
      };
    },
    markIntegrated: async (args: { key: string }) => {
      fake.calls.push(`integrated:${args.key}`);
      return {};
    },
    reportImplementation: async () => ({}),
    getWorkItem: async (key: string) => ({
      item: { identifier: key, status: replanned.has(key) ? 'planning' : 'in_review' },
    }),
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
    run?: CommandRunner;
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
    run: over.run ?? GIT,
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
  fake = { calls: [], dispatched: [], promptSeeds: [], stderr: '', root };
  replanned = new Set();
  claimRefuses = new Set();
  repoSets = {};
  repoOf = {};
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

  it('SKIPS a container that somehow reached the set, with the planning vocabulary', async () => {
    // ⚠️ It should not be reachable — `wrong_shape` refuses a scope whose child
    // is a container before anything is claimed — and the classifier answers for
    // it anyway, so a scoped run can never disagree with `auto` and `batch`
    // about what a coding agent may be handed.
    const summary = await drive(
      [member('PROD-2'), member('PROD-3', { kind: 'story', type: null, executor: null })],
      {},
    );

    expect(fake.dispatched).toEqual(['PROD-2']);
    expect(summary.skipped).toEqual([
      { key: 'PROD-3', title: 'Item PROD-3', reason: 'needs_planning' },
    ]);
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

  it('Ctrl-C finishes the card in flight and stops, reporting `interrupted`', async () => {
    // ⚠️ THE INTERRUPT IS COOPERATIVE, and that is the design: the handler sets
    // a flag, the card already running finishes, and the loop stops at the top
    // of the next iteration — so the work in flight is not abandoned half-done
    // and the session pull request still gets opened. (A SECOND Ctrl-C exits
    // immediately; that arm calls `process.exit` and is the one line here no
    // test can drive without taking the runner with it.)
    const summary = await drive(
      [member('PROD-2'), member('PROD-3')],
      {},
      {
        agentResults: (key) => {
          if (key === 'PROD-2') process.emit('SIGINT');
          return { exitCode: 0, signal: null };
        },
      },
    );

    expect(summary.stopReason).toBe('interrupted');
    // The first card RAN and was recorded; the second was never started.
    expect(fake.dispatched).toEqual(['PROD-2']);
    expect(summary.records.map((r) => r.key)).toEqual(['PROD-2']);
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

describe('readScopeEdges — two scope kinds, two sources', () => {
  // ⚠️ The edges cannot come from the ready set. A claim takes every member in
  // the to-do CATEGORY (`blocked` included), while a ready row's `blockedBy` is
  // empty BY CONSTRUCTION — it is empty *because* the row is ready. So the order
  // is read from somewhere that knows the graph, once, before the first agent.

  it('a CONTAINER scope reads them off the child rows of ONE get_work_item', () => {
    // The same call the shape check already made. Note the asymmetry this
    // function has to survive: the child ROW is keyed `identifier`, the EDGE
    // rows on it are keyed `key`.
    const calls: string[] = [];
    const client = {
      getWorkItem: async (key: string) => {
        calls.push(key);
        return {
          children: [
            { identifier: 'PROD-2', dependencies: { blockedBy: [], blocks: [] } },
            {
              identifier: 'PROD-3',
              dependencies: {
                blockedBy: [{ key: 'PROD-2', title: 'x', status: 'todo' }],
                blocks: [],
              },
            },
            { identifier: 'PROD-4' }, // an older server: no edge block at all
          ],
        };
      },
    } as unknown as MotirClient;

    return readScopeEdges(client, { kind: 'work_item', key: 'PROD-1' }, 'PROD').then((edges) => {
      expect(calls).toEqual(['PROD-1']);
      expect(edges).toEqual({ 'PROD-2': [], 'PROD-3': ['PROD-2'], 'PROD-4': [] });
    });
  });

  it('a SPRINT scope reads them off the collection, filtered to the sprint, PAGED', () => {
    // A sprint spans several parents at mixed depths, so there is no one
    // container to read — and a walk that stopped at the first page would order
    // the run from half a graph.
    const filters: unknown[] = [];
    let page = 0;
    const client = {
      searchWorkItems: async (args: { filter?: unknown; cursor?: string }) => {
        filters.push(args.filter);
        page += 1;
        return page === 1
          ? {
              items: [{ identifier: 'PROD-2', dependencies: { blockedBy: [], blocks: [] } }],
              nextCursor: 'c1',
            }
          : {
              items: [
                {
                  identifier: 'PROD-3',
                  dependencies: {
                    blockedBy: [{ key: 'PROD-2', title: 'x', status: 'todo' }],
                    blocks: [],
                  },
                },
              ],
              nextCursor: null,
            };
      },
    } as unknown as MotirClient;

    return readScopeEdges(client, { kind: 'sprint', sprintId: 's1' }, 'PROD').then((edges) => {
      expect(page).toBe(2);
      expect(edges).toEqual({ 'PROD-2': [], 'PROD-3': ['PROD-2'] });
      expect(filters[0]).toEqual({
        version: 'v1',
        combinator: 'and',
        conditions: [{ field: 'sprint', operator: 'is_any_of', value: ['s1'] }],
      });
    });
  });
});

describe('drainScope — the paths a happy run does not take', () => {
  it('a REPLANNED card stops the run, and --keep-going does NOT override it', async () => {
    // That flag says one agent failing is not a reason to abandon the rest.
    // This is not a failure: it is the agent reporting that the PLAN is wrong,
    // and every card left in this scope is one the submitted plan may change.
    replanned.add('PROD-2');
    const summary = await drive(
      [member('PROD-2'), member('PROD-3')],
      {},
      {
        opts: { keepGoing: true },
      },
    );

    expect(summary.stopReason).toBe('replanned');
    expect(summary.records.map((r) => r.outcome)).toEqual(['replanned']);
    expect(fake.dispatched).toEqual(['PROD-2']);
    // Never integrated, so it is not among the cards the branch carries.
    expect(summary.records[0]?.sessionBranch).toBeNull();
  });

  it('a git failure creating a session branch HALTS, before any agent is spawned', async () => {
    // ⚠️ The PROMPT read still happened, and that is the shipped seed-first
    // order (MOTIR-2398): the prompt is a pure read that neither claims the card
    // nor moves its status, so paying for it before knowing whether a checkout
    // exists costs nothing. What must NOT have happened is a SPAWN — and the
    // card is left untouched, with no record.
    const spawned: string[] = [];
    const summary = await drive(
      [member('PROD-2')],
      {},
      {
        run: () => ({ exitCode: 1, stdout: '', stderr: 'fatal: not a git repository' }),
        agentResults: (key) => {
          spawned.push(key);
          return { exitCode: 0, signal: null };
        },
      },
    );

    expect(summary.stopReason).toBe('halted');
    expect(spawned).toEqual([]);
    expect(summary.records).toEqual([]);
  });
});

describe('drainScope — the shapes an older or richer server produces', () => {
  it('reads a MULTI-REPOSITORY card’s whole set, and records every repo on it', async () => {
    // A card can name a repository SET (MOTIR-3135), primary first. The record
    // has to carry all of them, because a FAILED card belongs in the pull-request
    // body of every repository it half-touched — not only the primary's.
    mkdirSync(join(fake.root, 'motir-ai'), { recursive: true });
    // ⚠️ THE WHOLE ROW, not just the name. `targetRepos` carries the clone URL,
    // the default branch and the delivery state alongside it, and a fixture that
    // supplied a name-only object would be typing a shape the server never
    // sends — which is exactly what `packages/cli`'s own typecheck catches.
    repoSets['PROD-2'] = [
      { name: 'motir-core', cloneUrl: null, defaultBranch: null, delivery: null },
      { name: 'motir-ai', cloneUrl: null, defaultBranch: null, delivery: null },
    ];

    const summary = await drive([member('PROD-2')], {});

    expect(summary.records[0]?.repos).toEqual(['motir-core', 'motir-ai']);
    expect(summary.repos.map((r) => r.repoName)).toEqual(['motir-core', 'motir-ai']);
  });

  it('re-reads the prompt WITHOUT the seed when no checkout can carry the lineage', async () => {
    // The seeded prompt names a branch that does not exist here, so the agent
    // would be told to integrate into nothing. The extra request buys
    // correctness on a path that was already the exception.
    repoOf['PROD-2'] = 'motir-nowhere';
    // The card routes at a checkout that does not exist, so the target falls
    // back to the workspace ROOT — and git refuses there, which is the
    // tolerated failure `RepoSessions` turns into "no lineage here".
    const gitFailsAtRoot: CommandRunner = (bin, args, cwd) =>
      cwd === fake.root
        ? { exitCode: 128, stdout: '', stderr: 'not a git repository' }
        : GIT(bin, args, cwd);

    const summary = await drive([member('PROD-2')], {}, { run: gitFailsAtRoot });

    const seeds = fake.promptSeeds;
    expect(seeds).toHaveLength(2);
    expect(seeds[0]).toBe(true); // seeded first, per MOTIR-2398
    expect(seeds[1]).toBe(false); // then re-read plain
    expect(summary.repos).toEqual([]); // and no stray branch anywhere
  });

  it('records a claim REFUSED mid-drain as a skip rather than swallowing it', async () => {
    // ⚠️ Unreachable on a healthy scoped run — this run already holds every
    // member — so it is recorded rather than ignored: if it ever fires, the
    // up-front claim did not hold, and the summary is where that has to show.
    claimRefuses.add('PROD-2');

    const summary = await drive([member('PROD-2'), member('PROD-3')], {});

    expect(summary.skipped).toEqual([
      { key: 'PROD-2', title: 'Item PROD-2', reason: 'claim_refused' },
    ]);
    // And the run carries on: one card refusing is not the set failing.
    expect(summary.records.map((r) => r.key)).toEqual(['PROD-3']);
  });

  it('treats an OLDER server’s missing edge block as no edges, not as a crash', async () => {
    const client = {
      searchWorkItems: async () => ({
        items: [{ identifier: 'PROD-2' }, { identifier: 'PROD-3' }],
        nextCursor: null,
      }),
    } as unknown as MotirClient;

    await expect(
      readScopeEdges(client, { kind: 'sprint', sprintId: 's1' }, 'PROD'),
    ).resolves.toEqual({ 'PROD-2': [], 'PROD-3': [] });
  });
});
