import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runCloseOutHowToTest, checkoutsSection } from '../src/closeOutHowToTest.js';
import { closeOutRepos } from '../src/commands/auto.js';
import { renderSessionPrBody, type AutoSummary, type DispatchRecord } from '../src/autoLoop.js';
import { parseAgentCommand } from '../src/agentProfiles.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
import type { AgentRunResult } from '../src/agentRun.js';
import type { HowToTestRecord, MotirClient } from '../src/client.js';

// The scoped run's HOW TO TEST close-out step (Story MOTIR-4906 · MOTIR-5358).
//
// What must hold, each asserted on a recorded command log rather than on the
// step's own report:
//   1. ONE close-out agent, spawned AFTER the last card and BEFORE any pull
//      request is marked ready;
//   2. a failed close-out never strands the run — the pull requests still go ready;
//   3. a resumed run whose record this run already wrote spawns nothing;
//   4. every session pull request body carries `## How to test`, rendered from
//      the record — or a sentence naming the target when there is none;
//   5. `motir auto` (no run target) never calls the step at all.

const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: '' });
const RUN_ID = 'run_server_1';

let log: string[];
let stderr: string;

beforeEach(() => {
  log = [];
  stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const run: CommandRunner = (bin, args, cwd) => {
  log.push(`${bin} ${args.join(' ')} @${cwd}`);
  if (bin === 'gh' && args[1] === 'list') {
    if (args.includes('isDraft')) return ok('true');
    return ok('https://github.test/pull/7');
  }
  if (bin === 'git' && args[0] === 'rev-list') return ok('2');
  if (bin === 'git' && args[0] === 'log') return ok('');
  return ok('');
};

function record(over: Partial<DispatchRecord> = {}): DispatchRecord {
  return {
    key: 'PROD-2',
    title: 'Web half',
    outcome: 'integrated',
    durationMs: 1,
    sessionBranch: 'motir/run-web',
    repo: 'web',
    repos: ['web'],
    parentKey: 'PROD-1',
    ...over,
  } as DispatchRecord;
}

function summary(records: DispatchRecord[] = [record()]): AutoSummary {
  return {
    runId: '20260913-120000',
    records,
    skipped: [],
    planning: [],
    repos: [
      { repoName: 'web', cwd: '/wt/web', branch: 'motir/run-web', keys: ['PROD-2'] },
      { repoName: 'api', cwd: '/wt/api', branch: 'motir/run-api', keys: ['PROD-3'] },
    ],
    prs: [],
    approvals: [],
    lanes: [],
  } as unknown as AutoSummary;
}

const BODY =
  '## Precondition\n\nSign in as a member.\n\n## Locally\n\n```sh\npnpm i\n```\n\n## Click-path\n\n1. Open PROD-1\n2. Scroll to How to test';

const RECORD: HowToTestRecord = {
  dispatchRunId: RUN_ID,
  createdAt: '2026-09-13T12:00:00.000Z',
  bodyMd: BODY,
  previewPath: '/items/PROD-1',
  repos: [
    { repo: 'acme/web', commitSha: 'a'.repeat(40) },
    { repo: 'acme/api', commitSha: 'b'.repeat(40) },
  ],
};

function fakeClient(opts: { before: HowToTestRecord | null; after: HowToTestRecord | null }) {
  let reads = 0;
  const calls: string[] = [];
  const client = {
    workItemHowToTest: async (key: string) => {
      calls.push(`read:${key}`);
      reads += 1;
      return reads === 1 ? opts.before : opts.after;
    },
    dispatchRunCloseOutPrompt: async (runId: string) => {
      calls.push(`prompt:${runId}`);
      return { targetKey: 'PROD-1', prompt: 'CLOSE-OUT PROMPT\n', landedKeys: ['PROD-2'] };
    },
  } as unknown as MotirClient;
  return { client, calls };
}

function agentFn(exitCode = 0) {
  const prompts: string[] = [];
  const fn = vi.fn(async (o: { prompt: string; cwd: string }): Promise<AgentRunResult> => {
    log.push(`agent @${o.cwd}`);
    prompts.push(o.prompt);
    return { exitCode, signal: null, model: null } as AgentRunResult;
  });
  return { fn, prompts };
}

const agent = parseAgentCommand('claude')!;

describe('runCloseOutHowToTest → closeOutRepos', () => {
  it('spawns ONE close-out agent before any pull request is marked ready, and renders the record into every body', async () => {
    const { client, calls } = fakeClient({ before: null, after: RECORD });
    const { fn, prompts } = agentFn();
    const s = summary();

    const howToTest = await runCloseOutHowToTest({
      client,
      dispatchRunId: RUN_ID,
      targetKey: 'PROD-1',
      summary: s,
      agent: { parsed: agent },
      runAgentFn: fn as never,
    });
    closeOutRepos(s, run, null, howToTest);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls).toContain(`prompt:${RUN_ID}`);
    expect(prompts[0]).toContain('CLOSE-OUT PROMPT');
    expect(prompts[0]).toContain('- web: /wt/web — branch motir/run-web');
    expect(prompts[0]).toContain('- api: /wt/api — branch motir/run-api');

    const spawned = log.findIndex((l) => l.startsWith('agent '));
    const readied = log.map((l, i) => (l.startsWith('gh pr ready') ? i : -1)).filter((i) => i >= 0);
    expect(readied.length).toBeGreaterThan(0);
    expect(readied.every((i) => i > spawned)).toBe(true);

    const bodies = log.filter((l) => l.startsWith('gh pr edit'));
    expect(bodies.length).toBe(2);
    expect(howToTest.record).toEqual(RECORD);
  });

  it('a FAILED close-out agent is logged and the run still marks every pull request ready', async () => {
    const { client } = fakeClient({ before: null, after: null });
    const { fn } = agentFn(1);
    const s = summary();

    const howToTest = await runCloseOutHowToTest({
      client,
      dispatchRunId: RUN_ID,
      targetKey: 'PROD-1',
      summary: s,
      agent: { parsed: agent },
      runAgentFn: fn as never,
    });
    closeOutRepos(s, run, null, howToTest);

    expect(stderr).toContain('The close-out agent exited 1.');
    expect(stderr).toContain('No How to test was published on PROD-1 by this run');
    expect(log.filter((l) => l.startsWith('gh pr ready'))).toHaveLength(2);
    expect(s.prs.every((pr) => pr.draft === undefined)).toBe(true);
  });

  it('a RESUMED run whose record this run already wrote spawns no second agent', async () => {
    const { client, calls } = fakeClient({ before: RECORD, after: RECORD });
    const { fn } = agentFn();
    const howToTest = await runCloseOutHowToTest({
      client,
      dispatchRunId: RUN_ID,
      targetKey: 'PROD-1',
      summary: summary(),
      agent: { parsed: agent },
      runAgentFn: fn as never,
    });
    expect(fn).not.toHaveBeenCalled();
    expect(calls).not.toContain(`prompt:${RUN_ID}`);
    expect(howToTest.record).toEqual(RECORD);
  });

  it('a run that landed nothing, or was never recorded on the server, spawns no agent', async () => {
    const { fn } = agentFn();
    await runCloseOutHowToTest({
      client: fakeClient({ before: null, after: null }).client,
      dispatchRunId: RUN_ID,
      targetKey: 'PROD-1',
      summary: summary([record({ outcome: 'failed', sessionBranch: null })]),
      agent: { parsed: agent },
      runAgentFn: fn as never,
    });
    await runCloseOutHowToTest({
      client: fakeClient({ before: null, after: null }).client,
      dispatchRunId: null,
      targetKey: 'PROD-1',
      summary: summary(),
      agent: { parsed: agent },
      runAgentFn: fn as never,
    });
    expect(fn).not.toHaveBeenCalled();
  });

  it('`motir auto` has no run target, so it never calls the step', () => {
    const autoSource = readFileSync(new URL('../src/commands/auto.ts', import.meta.url), 'utf8');
    expect(autoSource).not.toContain('runCloseOutHowToTest(');
    const dispatchSource = readFileSync(
      new URL('../src/commands/dispatch.ts', import.meta.url),
      'utf8',
    );
    expect(dispatchSource).toContain('runCloseOutHowToTest(');
  });
});

describe('renderSessionPrBody — the `## How to test` section', () => {
  it('renders the record’s rich-text body VERBATIM, then this repository’s branch fetch', () => {
    const body = renderSessionPrBody('r1', 'motir/run-web', [record()], [], {
      targetKey: 'PROD-1',
      record: RECORD,
      repoName: 'web',
    });
    expect(body).toContain('## How to test');
    expect(body).toContain('Written onto PROD-1 by the run.');
    expect(body).toContain(BODY);
    expect(body.indexOf(BODY)).toBeLessThan(
      body.indexOf('git fetch origin motir/run-web && git checkout motir/run-web'),
    );
  });

  it('with no record, says so naming the run target', () => {
    const body = renderSessionPrBody('r1', 'motir/run-web', [record()], [], {
      targetKey: 'PROD-1',
      record: null,
      repoName: 'web',
    });
    expect(body).toContain('## How to test');
    expect(body).toContain('No run has written How to test onto PROD-1');
  });

  it('a body with no run target keeps its old shape — no section', () => {
    const body = renderSessionPrBody('r1', 'motir/auto-x', [record()]);
    expect(body).not.toContain('## How to test');
  });

  it('lists every checkout for the close-out agent', () => {
    expect(checkoutsSection([{ repoName: null, cwd: '/wt', branch: 'b', keys: [] }])).toContain(
      '- (the project repository): /wt — branch b',
    );
  });
});

describe('runCloseOutHowToTest — every failure is LOGGED and the run carries on (MOTIR-5337)', () => {
  const throwing = (what: unknown) => async () => {
    throw what;
  };

  it('an unreadable record, an unfetchable prompt and an agent that cannot start are each logged', async () => {
    const { fn } = agentFn();
    const unreadable = {
      workItemHowToTest: throwing(new Error('503 from motir')),
      dispatchRunCloseOutPrompt: throwing('offline'),
    } as unknown as MotirClient;
    const result = await runCloseOutHowToTest({
      client: unreadable,
      dispatchRunId: RUN_ID,
      targetKey: 'PROD-1',
      summary: summary(),
      agent: { parsed: agent },
      runAgentFn: fn as never,
    });
    expect(result).toEqual({ targetKey: 'PROD-1', record: null });
    expect(stderr).toContain('Could not read How to test on PROD-1: 503 from motir');
    expect(stderr).toContain('Could not fetch the close-out prompt: offline');
    expect(fn).not.toHaveBeenCalled();

    const spawnFails = vi.fn(throwing('spawn ENOENT'));
    const after = await runCloseOutHowToTest({
      client: {
        workItemHowToTest: throwing(42),
        dispatchRunCloseOutPrompt: async () => ({
          targetKey: 'PROD-1',
          prompt: 'P\n',
          landedKeys: [],
        }),
      } as unknown as MotirClient,
      dispatchRunId: RUN_ID,
      targetKey: 'PROD-1',
      summary: { ...summary(), repos: [] } as unknown as AutoSummary,
      agent: { parsed: agent },
      runAgentFn: spawnFails as never,
    });
    expect(spawnFails).toHaveBeenCalledWith(expect.objectContaining({ cwd: process.cwd() }));
    expect(stderr).toContain('Could not read How to test on PROD-1: 42');
    expect(stderr).toContain('The close-out agent could not run: spawn ENOENT');
    expect(after.record).toBeNull();
  });

  it('an agent error object is logged by its message', async () => {
    const { client } = fakeClient({ before: null, after: null });
    await runCloseOutHowToTest({
      client,
      dispatchRunId: RUN_ID,
      targetKey: 'PROD-1',
      summary: summary(),
      agent: { parsed: agent },
      runAgentFn: vi.fn(throwing(new Error('killed'))) as never,
    });
    expect(stderr).toContain('The close-out agent could not run: killed');
  });
});
