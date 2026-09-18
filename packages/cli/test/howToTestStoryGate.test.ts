import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCloseOutHowToTest } from '../src/closeOutHowToTest.js';
import { closeOutRepos } from '../src/commands/auto.js';
import type { AutoSummary, DispatchRecord } from '../src/autoLoop.js';
import { parseAgentCommand } from '../src/agentProfiles.js';
import type { CommandResult, CommandRunner } from '../src/git.js';
import type { AgentRunResult } from '../src/agentRun.js';
import type { HowToTestRecord, MotirClient } from '../src/client.js';

// THE STORY GATE — seam 5, the CLI close-out (Story MOTIR-4906 · MOTIR-5337).
//
// This package cannot import `lib/`, so the server is a fake here — shaped as the
// v1 read (`GET /work-items/{key}/how-to-test`) answers, which the server half of
// the gate (`tests/howToTest/storyGate.test.ts`, seams 1 and 4) proves against real
// Postgres. What THIS file owns is the seam between the close-out step and the
// shipped close-out: `runCloseOutHowToTest` hands its record to `closeOutRepos`,
// which writes each session pull request's body and only then marks it ready.
//
// Asserted on the recorded `gh` / agent log, never on the step's own report:
//   - ONE close-out agent, before `markSessionPrReady` probes or readies anything;
//   - each repository's body, as the exact `--body` argument `gh` received, carries
//     `## How to test`, the record's `bodyMd` VERBATIM, and THAT repository's fetch
//     block — never another repository's, and never the earlier run's body.

const RUN_ID = 'run_story_gate_2';
const EARLIER_RUN_ID = 'run_story_gate_1';

const SETUP =
  "pnpm install --frozen-lockfile && DATABASE_URL='postgres://u:p@localhost:5433/motir' pnpm db:seed";
const LOOP = 'for f in "a b" c; do\n  echo "$f → <ok> & done"\t| tee -a out.txt\ndone';
const BODY = [
  '## Precondition',
  '',
  'Sign in as the **workspace owner**.',
  '',
  '## Locally',
  '',
  '```bash',
  SETUP,
  '```',
  '',
  '```sh',
  LOOP,
  '```',
  '',
  '## Click-path',
  '',
  '1. Open the story.',
].join('\n');

const record = (dispatchRunId: string, bodyMd: string): HowToTestRecord => ({
  dispatchRunId,
  author: { kind: 'run', runId: dispatchRunId, label: `motir run · ${dispatchRunId}` },
  createdAt: '2026-09-13T12:30:00.000Z',
  bodyMd,
  previewPath: '/items/PROD-1',
  repos: [
    { repo: 'acme/web', commitSha: 'a1'.repeat(20) },
    { repo: 'acme-gl/api', commitSha: 'b2'.repeat(20) },
  ],
});

interface Call {
  bin: string;
  args: string[];
  cwd: string;
}

let calls: Call[];

const ok = (stdout: string): CommandResult => ({ exitCode: 0, stdout, stderr: '' });

const run: CommandRunner = (bin, args, cwd) => {
  calls.push({ bin, args: [...args], cwd });
  if (bin === 'gh' && args[0] === 'pr' && args[1] === 'list') {
    // `markSessionPrReady` asks for isDraft; `openSessionPr` asks for the url.
    return args.includes('isDraft') ? ok('true') : ok('https://git.test/pull/7');
  }
  if (bin === 'git' && args[0] === 'rev-list') return ok('3');
  return ok('');
};

beforeEach(() => {
  calls = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function summary(): AutoSummary {
  const leg = (key: string, repo: string, branch: string): DispatchRecord =>
    ({
      key,
      title: `${repo} half`,
      outcome: 'integrated',
      durationMs: 1,
      sessionBranch: branch,
      repo,
      repos: [repo],
      parentKey: 'PROD-1',
    }) as DispatchRecord;
  return {
    runId: '20260913-120000',
    records: [leg('PROD-2', 'web', 'motir/run-web'), leg('PROD-3', 'api', 'motir/run-api')],
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

/** The server: an EARLIER run's record until the agent publishes, then this run's. */
function fakeServer() {
  let published = false;
  const client = {
    workItemHowToTest: async () =>
      published ? record(RUN_ID, BODY) : record(EARLIER_RUN_ID, '## Earlier run\n\nstale'),
    dispatchRunCloseOutPrompt: async (runId: string) => ({
      targetKey: 'PROD-1',
      prompt: `CLOSE-OUT for ${runId}\n`,
      landedKeys: ['PROD-2', 'PROD-3'],
    }),
  } as unknown as MotirClient;
  const agent = vi.fn(async (o: { prompt: string; cwd: string }): Promise<AgentRunResult> => {
    calls.push({ bin: 'agent', args: [o.prompt], cwd: o.cwd });
    published = true;
    return { exitCode: 0, signal: null, model: null } as AgentRunResult;
  });
  return { client, agent };
}

const isReadyProbe = (c: Call) =>
  c.bin === 'gh' && c.args[1] === 'list' && c.args.includes('isDraft');
const isReady = (c: Call) => c.bin === 'gh' && c.args[0] === 'pr' && c.args[1] === 'ready';
const isBodyWrite = (c: Call) =>
  c.bin === 'gh' && c.args[0] === 'pr' && (c.args[1] === 'edit' || c.args[1] === 'create');
const bodyOf = (c: Call) => c.args[c.args.indexOf('--body') + 1]!;

async function closeOut() {
  const { client, agent } = fakeServer();
  const s = summary();
  const howToTest = await runCloseOutHowToTest({
    client,
    dispatchRunId: RUN_ID,
    targetKey: 'PROD-1',
    summary: s,
    agent: { parsed: parseAgentCommand('claude')! },
    runAgentFn: agent as never,
  });
  closeOutRepos(s, run, null, howToTest);
  return { agent, s };
}

describe('seam 5 — the CLI close-out: one agent, then bodies, then ready', () => {
  it('the close-out agent runs ONCE, before markSessionPrReady probes or readies any pull request', async () => {
    const { agent } = await closeOut();
    expect(agent).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.bin === 'agent')).toHaveLength(1);

    const spawned = calls.findIndex((c) => c.bin === 'agent');
    const readinessCalls = calls
      .map((c, i) => (isReadyProbe(c) || isReady(c) ? i : -1))
      .filter((i) => i >= 0);
    expect(calls.filter(isReady).map((c) => c.cwd)).toEqual(['/wt/web', '/wt/api']);
    expect(readinessCalls.every((i) => i > spawned)).toBe(true);
    // And every body write — which carries what the agent published — is after it too.
    const writes = calls.map((c, i) => (isBodyWrite(c) ? i : -1)).filter((i) => i >= 0);
    expect(writes).toHaveLength(2);
    expect(writes.every((i) => i > spawned)).toBe(true);
  });

  it('each repository’s body carries ## How to test, the record’s bodyMd VERBATIM, and its own fetch block, before that PR goes ready', async () => {
    await closeOut();
    for (const [cwd, branch, other] of [
      ['/wt/web', 'motir/run-web', 'motir/run-api'],
      ['/wt/api', 'motir/run-api', 'motir/run-web'],
    ] as const) {
      const writeIndex = calls.findIndex((c) => isBodyWrite(c) && c.cwd === cwd);
      const readyIndex = calls.findIndex((c) => isReady(c) && c.cwd === cwd);
      expect(writeIndex).toBeGreaterThan(-1);
      expect(readyIndex).toBeGreaterThan(writeIndex);

      const body = bodyOf(calls[writeIndex]!);
      const section = body.slice(body.indexOf('## How to test'));
      expect(body).toContain('## How to test');
      expect(section).toContain(BODY);
      expect(section.indexOf(BODY)).toBeGreaterThan(0);
      const fetchBlock = `\`\`\`sh\ngit fetch origin ${branch} && git checkout ${branch}\n\`\`\``;
      expect(section).toContain(fetchBlock);
      expect(section.indexOf(fetchBlock)).toBeGreaterThan(section.indexOf(BODY));
      expect(body).not.toContain(`git fetch origin ${other}`);
      // Never the superseded run's record.
      expect(body).not.toContain('## Earlier run');
    }
  });
});
