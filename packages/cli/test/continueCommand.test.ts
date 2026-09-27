import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandResult, CommandRunner } from '../src/git.js';
import type { DispatchPrompt, WorkItemContinueClaim, WorkItemDetail } from '../src/client.js';

// `motir continue <key>` (Story MOTIR-6526 · MOTIR-6533). The session, the agent
// and git are injected; what is under test is the PIPELINE — claim, then the dead
// run's branch checked out (reused as found, never reset), then the CONTINUE
// prompt, then `motir run`'s own delivery to Implemented — and that a refusal
// touches neither git nor the agent.

const { runAgentMock, sessionRef } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  sessionRef: { current: null as unknown },
}));

vi.mock('../src/agentRun.js', () => ({ runAgent: runAgentMock }));
vi.mock('../src/session.js', () => ({
  withProjectSession: async (fn: (s: unknown) => Promise<unknown>) => fn(sessionRef.current),
}));

const { continueCommand, prepareContinueCheckout, renderContinueRefusal } =
  await import('../src/commands/continue.js');

const SERVER = 'https://app.motir.co';
const BRANCH = 'subtask/PROD-7-add-the-thing';
const ok = (stdout = ''): CommandResult => ({ exitCode: 0, stdout, stderr: '' });

function claim(over: Partial<WorkItemContinueClaim> = {}): WorkItemContinueClaim {
  return {
    key: 'PROD-7',
    title: 'Add the thing',
    outcome: 'claimed',
    reason: null,
    parentKey: null,
    runId: 'run_continue_1',
    holder: { id: 'user_me', name: 'Me' },
    startedAt: '2026-09-27T10:00:00.000Z',
    deadRun: {
      id: 'run_dead',
      command: 'run',
      origin: 'local',
      status: 'timed_out',
      stopReason: 'abandoned',
      lastHeardAt: '2026-09-27T09:50:00.000Z',
      dispatcher: { id: 'user_mara', name: 'Mara S.' },
    },
    branch: BRANCH,
    pullRequest: null,
    previousAssignee: { id: 'user_mara', name: 'Mara S.' },
    ...over,
  };
}

interface Harness {
  root: string;
  calls: { tool: string; args: unknown }[];
  git: { args: string[]; cwd: string }[];
  stderr: string;
}
let h: Harness;

/** A git whose remote carries the branch; once a worktree is added it answers
 *  `rev-parse --abbrev-ref HEAD` with its branch. `onPath` pre-seeds a worktree. */
function fakeGit(onPath: Record<string, string> = {}): CommandRunner {
  const worktrees = new Map(Object.entries(onPath));
  return (_bin, args, cwd) => {
    h.git.push({ args, cwd });
    if (args[0] === 'rev-parse' && args[1] === '--verify')
      return { exitCode: 1, stdout: '', stderr: '' };
    if (args[0] === 'worktree' && args[1] === 'add') {
      const path = args[2] === '--track' ? args[5]! : args[2]!;
      const branch = args[2] === '--track' ? args[4]! : args[3]!;
      worktrees.set(path, branch);
      return ok();
    }
    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref')
      return ok(worktrees.get(cwd) ?? 'HEAD');
    // The push check (MOTIR-3004): the work is on the remote.
    if (args[0] === 'ls-remote') return ok(`abc123\trefs/heads/${BRANCH}`);
    if (args[0] === 'log') return ok('abc123');
    return ok();
  };
}

function setup(claims: WorkItemContinueClaim) {
  const root = mkdtempSync(join(tmpdir(), 'motir-continue-'));
  mkdirSync(join(root, 'motir-core'));
  const calls: Harness['calls'] = [];
  const prompt: DispatchPrompt = {
    key: 'PROD-7',
    prompt: 'CONTINUE — you are carrying on a run that DIED\nGIT WORKFLOW\n',
    parentKey: null,
    targetRepo: 'motir-core',
    workflowMode: 'per_item_pr',
    sessionBranch: null,
  };
  const client = {
    claimWorkItemContinue: async (key: string) => {
      calls.push({ tool: 'claim_continue', args: key });
      return claims;
    },
    dispatchPrompt: async (key: string, opts: unknown) => {
      calls.push({ tool: 'dispatch_prompt', args: { key, opts } });
      return prompt;
    },
    getWorkItem: async (key: string) => {
      calls.push({ tool: 'get_work_item', args: key });
      return {
        item: { identifier: key, status: 'in_progress', title: 'Add the thing' },
        deliveries: [],
      } as unknown as WorkItemDetail;
    },
    listWorkItemDesigns: async () => ({ designs: [] }),
    transitionStatus: async (args: unknown) => {
      calls.push({ tool: 'transition_status', args });
    },
    openDispatchRun: async (args: unknown) => {
      calls.push({ tool: 'open_run', args });
      return { runId: 'should-not-open', created: true };
    },
    appendDispatchRunEvents: async (args: { events: unknown[] }) => {
      calls.push({ tool: 'append', args });
      return { runId: 'x', appended: args.events.length, seq: 1 };
    },
    closeDispatchRun: async (args: unknown) => {
      calls.push({ tool: 'close_run', args });
    },
    heartbeatDispatchRun: async () => 'ok' as const,
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
  h = { root, calls, git: [], stderr: '' };
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    h.stderr += String(chunk);
    return true;
  });
}

const tools = () => h.calls.map((c) => c.tool);

beforeEach(() => {
  process.env['MOTIR_CONFIG_HOME'] = mkdtempSync(join(tmpdir(), 'motir-cfg-'));
  delete process.env['MOTIR_AGENT'];
  runAgentMock.mockReset();
  runAgentMock.mockImplementation(async () => ({ exitCode: 0, signal: null, model: null }));
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (h?.root) rmSync(h.root, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe('motir continue — the pipeline', () => {
  it('claims, checks the dead run’s branch out, runs the agent on the CONTINUE prompt, and delivers to Implemented', async () => {
    setup(claim());
    await continueCommand(
      'PROD-7',
      { agent: 'fake-agent' },
      { run: fakeGit(), maxCiPolls: 1, wait: async () => {} },
    );

    expect(tools().slice(0, 2)).toEqual(['claim_continue', 'dispatch_prompt']);
    // The prompt was asked for AS A CONTINUE of the dead run.
    expect(h.calls[1]!.args).toMatchObject({ key: 'PROD-7', opts: { continueFrom: 'run_dead' } });
    // The branch was checked out beside the repository, exactly where the prompt says.
    const add = h.git.find((g) => g.args[0] === 'worktree' && g.args[1] === 'add');
    expect(add?.args).toContain(join(h.root, 'motir-core-prod-7'));
    expect(add?.args).toContain(`origin/${BRANCH}`);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock.mock.calls[0]![0].prompt).toContain('CONTINUE — you are carrying on');
    // The same delivery `motir run` uses: the card moves to Implemented.
    expect(h.calls).toContainEqual({
      tool: 'transition_status',
      args: { key: 'PROD-7', status: 'implemented' },
    });
    // The run the SERVER opened is adopted, never a second one opened.
    expect(tools()).not.toContain('open_run');
    expect(h.stderr).toContain('Took PROD-7 over from Mara S.');
    expect(h.stderr).toContain(`Continuing on ${BRANCH}.`);
  });

  it('every refusal prints its sentence, exits non-zero, and touches neither git nor the agent', async () => {
    for (const reason of [
      'run_alive',
      'use_fix',
      'not_in_progress',
      'continue_the_parent',
      'no_dead_run',
      'no_branch',
    ] as const) {
      setup(
        claim({
          outcome: 'not_continuable',
          reason,
          parentKey: 'PROD-2',
          runId: null,
          deadRun: null,
          branch: null,
        }),
      );
      await continueCommand('PROD-7', { agent: 'fake-agent' }, { run: fakeGit() });
      expect(process.exitCode, reason).toBe(1);
      expect(h.git, reason).toEqual([]);
      expect(tools(), reason).toEqual(['claim_continue']);
      expect(h.stderr, reason).toContain('PROD-7: nothing to continue — ');
      process.exitCode = undefined;
      vi.restoreAllMocks();
    }
    expect(runAgentMock).not.toHaveBeenCalled();
  });
});

describe('motir continue — an interrupt closes the continue run `interrupted`', () => {
  it('Ctrl-C while the agent works closes the adopted run `interrupted` and exits 130', async () => {
    setup(claim());
    let handler: ((signal: 'SIGINT' | 'SIGTERM') => void) | null = null;
    const exits: number[] = [];
    let closed: Promise<void> = Promise.resolve();
    runAgentMock.mockImplementation(async () => {
      handler!('SIGINT');
      await closed;
      return { exitCode: 130, signal: 'SIGINT', model: null };
    });
    await continueCommand(
      'PROD-7',
      { agent: 'fake-agent' },
      {
        run: fakeGit(),
        onInterrupt: (fn) => {
          handler = fn;
          return () => undefined;
        },
        exit: (code) => {
          exits.push(code);
        },
      },
    );
    closed = Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const closes = h.calls.filter((c) => c.tool === 'close_run');
    expect(closes[0]?.args).toEqual({ runId: 'run_continue_1', stopReason: 'interrupted' });
    expect(exits).toEqual([130]);
  });
});

describe('renderContinueRefusal — each reason names what to do instead', () => {
  it.each([
    ['use_fix', 'motir fix PROD-7'],
    ['not_in_progress', 'motir run PROD-7'],
    ['continue_the_parent', 'motir continue PROD-2'],
    ['no_branch', 'set it to To Do'],
    ['run_alive', 'still alive'],
    ['no_dead_run', 'no run of it has died'],
  ] as const)('%s', (reason, words) => {
    expect(
      renderContinueRefusal(claim({ outcome: 'not_continuable', reason, parentKey: 'PROD-2' })),
    ).toContain(words);
  });

  it('taken names the holder', () => {
    expect(
      renderContinueRefusal(claim({ outcome: 'taken', holder: { id: 'u', name: 'Jo P.' } })),
    ).toContain('already being continued by Jo P.');
  });
});

describe('prepareContinueCheckout — reuse as found, add otherwise, never reset', () => {
  const base = (root: string, exists: (p: string) => boolean, run: CommandRunner) => ({
    key: 'PROD-7',
    branch: BRANCH,
    targetRepo: 'motir-core',
    rootDir: root,
    config: { serverUrl: SERVER, workspace: 'moooon', project: 'PROD' },
    run,
    exists,
  });

  it('reuses an existing worktree that is on the branch — dirty or clean, untouched', () => {
    setup(claim());
    const wt = join(h.root, 'motir-core-prod-7');
    const result = prepareContinueCheckout(
      base(h.root, (p) => p === join(h.root, 'motir-core') || p === wt, fakeGit({ [wt]: BRANCH })),
    );
    expect(result).toEqual({ ok: true, path: wt });
    expect(h.git.some((g) => g.args[0] === 'worktree')).toBe(false);
    for (const destructive of ['reset', 'clean', 'stash', 'checkout']) {
      expect(h.git.some((g) => g.args[0] === destructive)).toBe(false);
    }
  });

  it('refuses a worktree at that path on ANOTHER branch, naming it, and resets nothing', () => {
    setup(claim());
    const wt = join(h.root, 'motir-core-prod-7');
    const result = prepareContinueCheckout(
      base(
        h.root,
        (p) => p === join(h.root, 'motir-core') || p === wt,
        fakeGit({ [wt]: 'other/branch' }),
      ),
    );
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message).toContain('other/branch');
    expect(h.git.some((g) => ['reset', 'clean', 'stash'].includes(g.args[0]!))).toBe(false);
  });
});
