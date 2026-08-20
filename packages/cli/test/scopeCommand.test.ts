import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliError } from '../src/errors.js';
import type { DispatchItem, ScopeClaim, WorkItemDetail } from '../src/client.js';

// `motir run <scope>` — the FRONT HALF, driven through the real `runCommand`
// against a scripted client (Story MOTIR-3001 · MOTIR-3198).
//
// What these tests are for, and what they deliberately are NOT for:
//
//   • They assert the PIPELINE — which requests happen, in what order, and what
//     the run does with each typed answer. The rendering of those answers is
//     asserted against plain objects in `scopedRun.test.ts`, and the atomicity
//     of the claim itself is `tests/ready/claimScope.test.ts`'s, over real
//     Postgres. Nothing here re-tests either.
//   • The one thing they DO have to prove about the shape of the requests is
//     that the container's own key never reaches `dispatchPrompt`, and that the
//     claim is ONE call for the whole set rather than one per card. Both are
//     properties of the run, invisible in any single function.

const { runAgentMock, sessionRef } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  sessionRef: { current: null as unknown },
}));

vi.mock('../src/agentRun.js', () => ({ runAgent: runAgentMock }));
vi.mock('../src/session.js', () => ({
  withProjectSession: async (fn: (s: unknown) => Promise<unknown>) => fn(sessionRef.current),
}));

const { runCommand } = await import('../src/commands/dispatch.js');

const SERVER = 'https://app.motir.co';
const OWNER = 'user_me';

function detail(
  over: Partial<WorkItemDetail['item']> = {},
  children: string[] = [],
): WorkItemDetail {
  return {
    item: {
      identifier: 'PROD-1',
      kind: 'story',
      title: 'The story',
      status: 'todo',
      priority: 'high',
      assigneeId: null,
      type: null,
      executor: null,
      storyPoints: null,
      estimateMinutes: null,
      targetRepo: 'motir-core',
      sprintId: null,
      descriptionMd: null,
      ...over,
    },
    ancestors: [],
    children: children.map((key) => ({
      key,
      kind: 'subtask',
      title: `Item ${key}`,
      status: 'todo',
      priority: 'medium',
      assigneeId: null,
      estimateMinutes: null,
      storyPoints: null,
      dependencies: { blockedBy: [], blocks: [] },
    })) as WorkItemDetail['children'],
    blockedBy: [],
    blocks: [],
    relatesTo: [],
    readiness: { ready: true, openBlockers: [], blockedByAncestor: null },
  };
}

function readyRow(key: string): DispatchItem {
  return {
    key,
    kind: 'subtask',
    title: `Item ${key}`,
    priority: 'medium',
    status: { key: 'todo', category: 'todo' },
    assigneeId: null,
    type: 'code',
    executor: 'coding_agent',
    inheritedSessionBranch: null,
  };
}

function scopeClaim(over: Partial<ScopeClaim> = {}): ScopeClaim {
  return {
    scope: { kind: 'work_item', key: 'PROD-1', sprintId: null, name: 'The story' },
    outcome: 'claimed',
    claimed: true,
    members: [
      {
        key: 'PROD-1',
        title: 'The story',
        status: { key: 'in_progress', category: 'in_progress' },
      },
      {
        key: 'PROD-2',
        title: 'Item PROD-2',
        status: { key: 'in_progress', category: 'in_progress' },
      },
    ],
    offender: null,
    shape: null,
    blockers: [],
    ...over,
  };
}

interface Harness {
  calls: { tool: string; args: unknown }[];
  stderr: string;
  root: string;
  /** Every page of ready rows, served in order; the walk is inside the client. */
  ready: DispatchItem[];
}

let harness: Harness;
let home: string;

function setup(
  opts: {
    detail?: WorkItemDetail;
    ready?: DispatchItem[];
    claim?: ScopeClaim;
    planError?: Error;
    expandError?: Error;
  } = {},
) {
  const calls: Harness['calls'] = [];
  const root = mkdtempSync(join(tmpdir(), 'motir-scope-'));
  mkdirSync(join(root, 'motir-core'));
  const ready = opts.ready ?? [readyRow('PROD-2')];

  const client = {
    whoami: async () => {
      calls.push({ tool: 'whoami', args: undefined });
      return { user: { id: OWNER, name: 'Me', email: 'me@motir.test' }, workspace: null };
    },
    getWorkItem: async (key: string) => {
      calls.push({ tool: 'get_work_item', args: key });
      return opts.detail ?? detail({}, ['PROD-2']);
    },
    listReadyForDispatch: async (args: unknown) => {
      calls.push({ tool: 'list_ready', args });
      return ready;
    },
    claimScope: async (args: unknown) => {
      calls.push({ tool: 'claim_scope', args });
      return opts.claim ?? scopeClaim();
    },
    claimWorkItem: async (args: unknown) => {
      calls.push({ tool: 'claim', args });
      throw new Error('a scoped run must never claim card-by-card');
    },
    dispatchPrompt: async (key: string) => {
      calls.push({ tool: 'dispatch_prompt', args: key });
      throw new Error('this card launches no agent');
    },
    submitPlanSession: async (args: unknown) => {
      calls.push({ tool: 'submit_plan', args });
      if (opts.planError) throw opts.planError;
      return { jobId: 'job_1', planId: 'plan_1' };
    },
    expandItem: async (key: string) => {
      calls.push({ tool: 'expand_item', args: key });
      if (opts.expandError) throw opts.expandError;
      return { jobId: 'job_2', planId: 'plan_2' };
    },
  };

  sessionRef.current = {
    client,
    serverUrl: SERVER,
    projectKey: 'PROD',
    link: {
      dir: root,
      path: join(root, '.motir.json'),
      config: { serverUrl: SERVER, workspace: 'moooon', project: 'PROD' },
    },
  };

  harness = { calls, stderr: '', root, ready };
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    harness.stderr += String(chunk);
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return harness;
}

const toolNames = () => harness.calls.map((c) => c.tool);
const callsTo = (tool: string) => harness.calls.filter((c) => c.tool === tool);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'motir-scope-cfg-'));
  process.env['MOTIR_CONFIG_HOME'] = home;
  runAgentMock.mockReset();
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['MOTIR_CONFIG_HOME'];
  rmSync(home, { recursive: true, force: true });
  if (harness?.root) rmSync(harness.root, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('motir run <container> — the happy path', () => {
  it('resolves through the ANCESTOR facet, claims the whole set in ONE call, and prints it', async () => {
    setup();

    await runCommand('PROD-1', {});

    expect(toolNames()).toEqual([
      'get_work_item', // the shape read `runCommand` already made
      'whoami',
      'list_ready',
      'claim_scope',
    ]);
    // The scope is resolved through the facet its sibling published — not by
    // reading the children and filtering client-side, which would re-derive the
    // parent-ready cascade in the wrong place.
    expect(callsTo('list_ready')[0]?.args).toMatchObject({
      projectKey: 'PROD',
      ownerId: OWNER,
      ancestor: ['PROD-1'],
    });
    // ⚠️ ONE claim for the whole set. A card-by-card claim is what the up-front
    // claim exists to prevent, and `claimWorkItem` throws in this harness so a
    // regression to it fails loudly rather than passing quietly.
    expect(callsTo('claim_scope')).toHaveLength(1);
    expect(callsTo('claim_scope')[0]?.args).toEqual({ kind: 'work_item', key: 'PROD-1' });
    expect(harness.stderr).toContain('Claimed PROD-1 "The story"');
    expect(harness.stderr).toContain('Every card above now reads In Progress');
  });

  it('NEVER sends the container’s own key to dispatchPrompt', async () => {
    // A story is a scope, not work. The harness throws from `dispatchPrompt`,
    // so any path that reached it would fail this test by exception rather than
    // by assertion — which is the stronger form.
    setup();

    await runCommand('PROD-1', {});

    expect(toolNames()).not.toContain('dispatch_prompt');
    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it('`sprint` claims the ACTIVE sprint, with no work-item read at all', async () => {
    setup({ ready: [readyRow('PROD-2'), readyRow('PROD-3')] });

    await runCommand('sprint', {});

    // No `get_work_item`: the reserved word is not a key, so there is nothing
    // to resolve before asking for the sprint's ready set.
    expect(toolNames()).toEqual(['whoami', 'list_ready', 'claim_scope']);
    expect(callsTo('list_ready')[0]?.args).toMatchObject({ sprintId: 'active' });
    expect(callsTo('claim_scope')[0]?.args).toEqual({ kind: 'sprint', projectKey: 'PROD' });
  });

  it('a `mine` claim RESUMES rather than refusing', async () => {
    setup({ claim: scopeClaim({ outcome: 'mine', claimed: false }) });

    await runCommand('PROD-1', {});

    expect(harness.stderr).toContain('Claimed PROD-1');
    expect(harness.stderr).not.toContain('NOT claimed');
  });
});

describe('motir run <container> — the refusals', () => {
  it('a scope held by a SECOND run is refused BY NAME, and nothing was locked', async () => {
    setup({
      claim: scopeClaim({
        outcome: 'taken',
        claimed: false,
        members: [],
        offender: {
          key: 'PROD-2',
          title: 'Item PROD-2',
          status: { key: 'in_progress', category: 'in_progress' },
          assignee: { id: 'u2', name: 'Rival Runner' },
          transitionedBy: null,
          transitionedAt: null,
        },
      }),
    });

    await runCommand('PROD-1', {});

    expect(harness.stderr).toContain('already held by Rival Runner');
    expect(harness.stderr).toContain('PROD-2');
    expect(toolNames()).not.toContain('submit_plan');
    // A refusal is an ordinary state, not a failure.
    expect(process.exitCode).toBeUndefined();
  });

  it('`not_finishable` stops and does NOT submit a re-plan', async () => {
    // Out-of-scope work gating in-scope work is a fact about the rest of the
    // tree; re-planning the container would be re-planning the wrong thing.
    setup({
      claim: scopeClaim({
        outcome: 'not_finishable',
        claimed: false,
        members: [],
        blockers: [
          { item: 'PROD-2', blockedBy: 'PROD-99', blockerStatus: 'todo', blockerSprintId: null },
        ],
      }),
    });

    await runCommand('PROD-1', {});

    expect(harness.stderr).toContain('PROD-2 is blocked by PROD-99');
    expect(toolNames()).not.toContain('submit_plan');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('motir run <container> — a WRONG SHAPE submits a re-plan, once', () => {
  const wrongShape = () =>
    scopeClaim({
      outcome: 'wrong_shape',
      claimed: false,
      members: [],
      shape: { child: 'PROD-5', childTitle: 'A task of its own', depth: 2 },
    });

  it('prints the offending child and submits a DETACHED re-plan of the story', async () => {
    setup({ claim: wrongShape() });

    await runCommand('PROD-1', {});

    expect(harness.stderr).toContain('PROD-5 — A task of its own is itself a container');
    expect(callsTo('submit_plan')).toHaveLength(1);
    expect(callsTo('submit_plan')[0]?.args).toEqual({ projectKey: 'PROD', targetKeys: ['PROD-1'] });
    // The review URL, so the plan is one click away rather than an id to paste.
    expect(harness.stderr).toContain(`${SERVER}/plans/plan_1`);
    expect(process.exitCode).toBeUndefined();
  });

  it('--disable-replan suppresses the WRITE, not the diagnosis', async () => {
    // The operator asked not to have a plan submitted on their behalf, not to
    // be kept in the dark — the same meaning MOTIR-3017 gave the flag on the
    // per-card path.
    setup({ claim: wrongShape() });

    await runCommand('PROD-1', { disableReplan: true });

    expect(harness.stderr).toContain('PROD-5 — A task of its own is itself a container');
    expect(toolNames()).not.toContain('submit_plan');
    expect(harness.stderr).toContain('No re-plan was submitted (--disable-replan)');
  });

  it('a failed submit reports and does not become the run’s problem', async () => {
    setup({ claim: wrongShape(), planError: new CliError('the planner is unavailable') });

    await runCommand('PROD-1', {});

    expect(harness.stderr).toContain('the planner is unavailable');
    // The shape finding is the valuable thing here, and it still stands.
    expect(harness.stderr).toContain('is itself a container');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('motir run <container> — the shapes that are not scopes', () => {
  it('an EPIC is refused by kind, before anything is read or claimed', async () => {
    setup({ detail: detail({ kind: 'epic', identifier: 'PROD-9' }, ['PROD-2']) });

    await expect(runCommand('PROD-9', {})).rejects.toThrow(/never a run target/);
    expect(toolNames()).toEqual(['get_work_item']);
  });

  it('a CHILDLESS story is refused as a planning item', async () => {
    setup({ detail: detail({ kind: 'story', identifier: 'PROD-3' }, []) });

    await expect(runCommand('PROD-3', {})).rejects.toThrow(/planning item, not work/);
    expect(toolNames()).not.toContain('claim_scope');
  });

  it('--include-planning turns that refusal into ONE expansion, and never waits', async () => {
    setup({ detail: detail({ kind: 'story', identifier: 'PROD-3' }, []) });

    await runCommand('PROD-3', { includePlanning: true });

    expect(callsTo('expand_item')).toHaveLength(1);
    expect(callsTo('expand_item')[0]?.args).toBe('PROD-3');
    expect(harness.stderr).toContain('an expansion was triggered');
    expect(harness.stderr).toContain('the plan needs your approval');
    expect(toolNames()).not.toContain('claim_scope');
  });

  it('an EMPTY scope reports a plan state, claims nothing, and exits 0', async () => {
    setup({ ready: [] });

    await runCommand('PROD-1', {});

    expect(harness.stderr).toContain('nothing is ready to start');
    expect(harness.stderr).toContain('Nothing was claimed and nothing was changed.');
    // ⚠️ Distinguishable from a refusal, and nothing was locked: the claim is
    // never even attempted.
    expect(toolNames()).not.toContain('claim_scope');
    expect(harness.stderr).not.toContain('NOT claimed');
    expect(process.exitCode).toBeUndefined();
  });
});

describe('motir run <scope> — the leaf-only flags', () => {
  it.each([
    ['--print', { print: true }, /`--print` needs one prompt/],
    ['--force', { force: true }, /`--force` applies to a single work item/],
    ['--kinds', { kinds: 'subtask' }, /`--kinds` filters a ready-set PICK/],
  ])('refuses %s with a REASON rather than `unknown option`', async (_flag, opts, expected) => {
    setup();

    await expect(runCommand('PROD-1', opts)).rejects.toThrow(expected);
  });

  it('leaves the LEAF path untouched — those flags still work on one card', async () => {
    // The ADR's central promise: for a leaf key, which is what every dispatched
    // card is, nothing about this command changed.
    setup({ detail: detail({ kind: 'subtask', identifier: 'PROD-2' }, []) });

    // It reaches the leaf path (and then the harness's `claimWorkItem`, which
    // throws) rather than being refused by the scope guard.
    await expect(runCommand('PROD-2', { print: true })).rejects.toThrow(
      /must never claim card-by-card/,
    );
    expect(toolNames()).toContain('claim');
  });
});
