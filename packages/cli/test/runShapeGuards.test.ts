import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { runAgent } from '../src/agentRun.js';
import { COMMAND_CATALOG } from '../src/commandCatalog.js';
import { buildProgram } from '../src/program.js';
import { resolveFakeClaim } from './helpers/fakeClaim.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
import type { DispatchItem, DispatchPrompt, ScopeClaim, WorkItemDetail } from '../src/client.js';

// The RUN-SHAPE guards (Story MOTIR-3001 · MOTIR-3204).
//
// Three of this story's guarantees are not behaviour coverage can measure —
// they are properties of HOW the run behaves, and two of them are true today by
// CONSTRUCTION and asserted by nothing. Left that way they are incidental: a
// refactor that breaks any of them leaves every test green, every card
// shipping, and the guarantee silently gone.
//
//   1. A FRESH agent process per card, with its own prompt file and report path.
//      The failure it prevents is a wrong answer wearing the shape of a right
//      one — card N's self-reported model carried onto card N+1 whenever an
//      agent writes no report.
//   2. NO ready query after the claim. The scoped run's whole ordering design
//      rests on holding a fixed set; a mid-flight ready read would reintroduce
//      exactly the interleaving the up-front claim exists to prevent, and would
//      be invisible in the output.
//   3. The container is NEVER dispatched. A story is a scope, not work.
//
// ⚠️ NOTHING REAL IS SPAWNED AND NOTHING IS SENT. Every assertion runs through
// the shipped injectable seams — `runAgent`'s `spawnFn`, the commands'
// `runAgentFn` / `run` deps — which is what makes these guards cheap enough to
// live in the fast suite rather than in an integration lane.
//
// ── Each guard was demonstrated RED before this card closed ────────────────
// A guard that cannot fail is not evidence, it is a tautology. The deliberately
// broken variant for each is named at the guard, and the failure it produced is
// quoted in the pull-request body.

const { runAgentSpy, sessionRef } = vi.hoisted(() => ({
  runAgentSpy: vi.fn(),
  sessionRef: { current: null as unknown },
}));

vi.mock('../src/session.js', () => ({
  withProjectSession: async (fn: (s: unknown) => Promise<unknown>) => fn(sessionRef.current),
}));

const { runCommand } = await import('../src/commands/dispatch.js');

const OWNER = 'user_me';
const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const GIT: CommandRunner = (_bin, args) => {
  if (args[0] === 'ls-remote') return ok('abc123\trefs/heads/motir/auto-x');
  if (args[0] === 'log' || args[0] === 'rev-list') return ok('abc123');
  return ok('');
};

let root: string;
let home: string;
/** Every key that reached the dispatch-prompt read, in order. */
let dispatched: string[];
/** True once the scope claim has returned — guard 2's window opens here. */
let claimed: boolean;

function member(key: string, over: Partial<DispatchItem> = {}): DispatchItem {
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
    ...over,
  };
}

function containerDetail(children: string[]): WorkItemDetail {
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
    },
    ancestors: [],
    children: children.map((key) => ({
      identifier: key,
      kind: 'subtask',
      title: `Item ${key}`,
      status: 'todo',
      dependencies: { blockedBy: [], blocks: [] },
    })),
    blockedBy: [],
    blocks: [],
    relatesTo: [],
    readiness: { ready: true, openBlockers: [], blockedByAncestor: null },
  };
}

function scopeClaim(keys: string[]): ScopeClaim {
  return {
    scope: { kind: 'work_item', key: 'PROD-1', sprintId: null, name: 'The story' },
    outcome: 'claimed',
    claimed: true,
    members: ['PROD-1', ...keys].map((key) => ({
      key,
      title: `Item ${key}`,
      status: { key: 'in_progress', category: 'in_progress' },
    })),
    offender: null,
    shape: null,
    blockers: [],
  };
}

/** A scripted server holding a container with `keys` beneath it. */
function scriptedSession(keys: string[]) {
  const client = {
    whoami: async () => ({
      user: { id: OWNER, name: 'Me', email: 'me@motir.test' },
      workspace: null,
    }),
    getWorkItem: async (key: string) =>
      key === 'PROD-1'
        ? containerDetail(keys)
        : ({ item: { identifier: key, status: 'in_review' } } as unknown as WorkItemDetail),
    // ── GUARD 2 ────────────────────────────────────────────────────────────
    // Every ready read is legal BEFORE the claim (that is how the scope is
    // resolved) and a hard failure after it. Throwing rather than counting is
    // deliberate: a counter can be forgotten in an assertion, an exception
    // cannot be.
    listReadyForDispatch: async () => {
      if (claimed) throw new Error('READY READ AFTER THE CLAIM');
      return keys.map((k) => member(k));
    },
    nextReady: async () => {
      throw new Error('READY READ AFTER THE CLAIM');
    },
    claimScope: async () => {
      claimed = true;
      return scopeClaim(keys);
    },
    claimWorkItem: async (args: { key: string }) => {
      const { claim } = resolveFakeClaim(
        { key: args.key, title: `Item ${args.key}`, status: 'in_progress', assigneeId: OWNER },
        { id: OWNER, name: 'Me' },
      );
      return claim;
    },
    // ── GUARD 3 ────────────────────────────────────────────────────────────
    // The container's own key reaching here is the failure. Recorded AND
    // thrown: the record makes the assertion readable, the throw makes a
    // regression fail even if somebody deletes the assertion.
    dispatchPrompt: async (key: string): Promise<DispatchPrompt> => {
      dispatched.push(key);
      if (key === 'PROD-1') throw new Error('THE CONTAINER WAS DISPATCHED');
      return {
        key,
        prompt: `PROMPT ${key}`,
        parentKey: 'PROD-1',
        targetRepo: 'motir-core',
        workflowMode: 'session_lineage',
        sessionBranch: 'motir/auto-x',
      };
    },
    markIntegrated: async () => ({}),
    reportImplementation: async () => ({}),
    searchWorkItems: async () => ({ items: [], nextCursor: null }),
  };

  sessionRef.current = {
    client,
    serverUrl: 'https://app.motir.co',
    projectKey: 'PROD',
    link: {
      dir: root,
      path: join(root, '.motir.json'),
      config: { serverUrl: 'https://app.motir.co', workspace: 'moooon', project: 'PROD' },
    },
  };
}

/** A child process that is never really a process: it closes cleanly, at once. */
function fakeChild(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & { stdin: null };
  child.stdin = null;
  queueMicrotask(() => child.emit('close', 0, null));
  return child as unknown as ChildProcess;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'motir-guard-'));
  mkdirSync(join(root, 'motir-core'), { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'motir-guard-cfg-'));
  process.env['MOTIR_CONFIG_HOME'] = home;
  dispatched = [];
  claimed = false;
  runAgentSpy.mockReset();
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['MOTIR_CONFIG_HOME'];
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('GUARD 1 — a FRESH agent process per card', () => {
  it('launches once per card, with a DISTINCT prompt file and report path each time', async () => {
    // ⚠️ THIS DRIVES THE REAL `runAgent`, with only `spawnFn` replaced. The
    // temp dir under test is the one `defaultTempDir` really creates — injecting
    // `tempDirFactory` here would be the test supplying the very distinctness it
    // claims to be checking.
    //
    // RED variant: `tempDirFactory: () => fixedDir` inside the wrapper below.
    // Both launches then share one dir and `expect(new Set(...)).toHaveLength(2)`
    // fails at 1 — the exact shape of the defect (card N's report inherited by
    // card N+1) the per-run dir exists to prevent.
    const launches: { prompt: string; report: string; previousPromptExisted: boolean }[] = [];
    let previousPrompt: string | null = null;

    scriptedSession(['PROD-2', 'PROD-3']);
    await runCommand(
      'PROD-1',
      { agent: 'fake-agent' },
      {
        run: GIT,
        clock: () => 0,
        now: () => new Date(0),
        runAgentFn: (opts) =>
          runAgent({
            ...opts,
            spawnFn: (_cmd: string, _args: string[], spawnOpts: SpawnOptions) => {
              const env = (spawnOpts.env ?? {}) as Record<string, string>;
              launches.push({
                prompt: env['MOTIR_PROMPT_FILE'] as string,
                report: env['MOTIR_AGENT_REPORT'] as string,
                // ⚠️ The interesting half: at the moment launch N+1 starts,
                // launch N's prompt file must already be GONE. A distinct path
                // that still resolves to a readable file would leave the
                // previous card's report inheritable by anything that guessed
                // the name.
                previousPromptExisted: previousPrompt !== null && existsSync(previousPrompt),
              });
              previousPrompt = env['MOTIR_PROMPT_FILE'] as string;
              return fakeChild();
            },
          }),
      },
    );

    // ONE launch per card, and only for the cards — never for the container.
    expect(launches).toHaveLength(2);
    expect(dispatched).toEqual(['PROD-2', 'PROD-3']);

    const prompts = new Set(launches.map((l) => l.prompt));
    const reports = new Set(launches.map((l) => l.report));
    expect(prompts.size).toBe(2);
    expect(reports.size).toBe(2);
    // And the two channels are distinct from each other within one launch.
    for (const launch of launches) expect(launch.prompt).not.toBe(launch.report);

    // Nothing from iteration one is readable in iteration two.
    expect(launches[1]?.previousPromptExisted).toBe(false);
    // Nor after the run: the dirs are gone, not merely unused.
    for (const launch of launches) {
      expect(existsSync(launch.prompt)).toBe(false);
      expect(existsSync(launch.report)).toBe(false);
    }
  });
});

describe('GUARD 2 — no ready query after the claim', () => {
  it('issues no ready read once the claim has returned, over a multi-card scope', async () => {
    // RED variant: a `client.listReadyForDispatch(...)` call inserted at the top
    // of `drainScope`'s loop body. The scripted client throws `READY READ AFTER
    // THE CLAIM` and the run rejects — which is the point of throwing rather
    // than counting: the failure cannot be forgotten into a green run.
    scriptedSession(['PROD-2', 'PROD-3']);

    await runCommand(
      'PROD-1',
      { agent: 'fake-agent' },
      {
        run: GIT,
        clock: () => 0,
        now: () => new Date(0),
        runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      },
    );

    // Reaching here at all is the assertion — the client throws on any ready
    // read after `claimed` flips. The explicit checks below say WHY the run is
    // considered to have got far enough for that to mean something.
    expect(claimed).toBe(true);
    expect(dispatched).toEqual(['PROD-2', 'PROD-3']);
  });
});

describe('GUARD 3 — the container is never dispatched', () => {
  it('sends no container key to the dispatch-prompt read on any path', async () => {
    // RED variant: `dispatchOne` called with the container's own row before the
    // loop. The scripted client throws `THE CONTAINER WAS DISPATCHED`.
    scriptedSession(['PROD-2']);

    await runCommand(
      'PROD-1',
      { agent: 'fake-agent' },
      {
        run: GIT,
        clock: () => 0,
        now: () => new Date(0),
        runAgentFn: async () => ({ exitCode: 0, signal: null, model: null }),
      },
    );

    expect(dispatched).not.toContain('PROD-1');
    expect(dispatched).toEqual(['PROD-2']);
  });
});

describe('the scoped command is COVERED by the record walks, not exempted from them', () => {
  // Confirmed rather than assumed: `run` gained a signature, four options and a
  // new meaning, and the two audits that keep the published table honest have to
  // still be looking at it.
  it('appears in COMMAND_CATALOG with the scope signature and the four new options', () => {
    const entry = COMMAND_CATALOG.find((c) => c.path === 'run');
    expect(entry).toBeDefined();
    expect(entry?.signature).toBe('<scope>');
    const flags = entry?.options.map((o) => o.flags) ?? [];
    expect(flags).toEqual(
      expect.arrayContaining(['--max <n>', '--keep-going', '--include-planning', '--kinds <list>']),
    );
  });

  it('is registered on the built program with exactly the record’s options, in order', () => {
    // This is `commandCatalog.test.ts`'s own comparison, re-stated here on the
    // ONE command this story changed — so a future exemption of `run` from that
    // walk cannot pass unnoticed.
    const entry = COMMAND_CATALOG.find((c) => c.path === 'run');
    const command = buildProgram().commands.find((c) => c.name() === 'run');
    expect(command).toBeDefined();
    expect(command!.options.map((o) => o.flags)).toEqual(entry!.options.map((o) => o.flags));
  });
});
