import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchCommand } from '../src/commands/batch.js';
import { buildProgram } from '../src/program.js';
import { setCredential } from '../src/config/userConfig.js';
import { CliError } from '../src/errors.js';
import {
  startTestMcpServer,
  v1Detail,
  v1DispatchPrompt,
  v1Page,
  v1ReadyRow,
  type TestMcpServer,
  type V1Request,
  type V1Script,
} from './helpers/mcpTestServer.js';

// `motir batch` as the COMMAND (Subtask 7.9.5b · MOTIR-1829).
//
// `batch.test.ts` drives the DRAIN directly with a scripted client, which is
// where the frozen-snapshot properties live. This file drives the command the
// way the binary does — through the real project session, the real MCP client
// and a real MCP server — so the parts the drain test cannot see are covered:
// that the run refuses to start without an agent (before a session is even
// opened), that the session wraps the drain, that the summary is printed after
// it, and that the run's outcome reaches `process.exitCode`.
//
// It also pins the two INJECTED SEAMS: `batchCommand` runs on its own clock and
// its own agent launcher when nothing is passed, which is the shape the binary
// actually runs in and the one no injected-deps test exercises.

let server: TestMcpServer;
let root: string;
let cwd: string;
let exitCode: typeof process.exitCode;

const TOKEN = 'pat_batch_token';

beforeAll(async () => {
  server = await startTestMcpServer({ token: TOKEN });
  cwd = process.cwd();
});

afterAll(async () => {
  process.chdir(cwd);
  await server.close();
});

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), 'motir-batchcmd-'));
  root = join(base, 'workspace');
  mkdirSync(join(root, 'motir-core'), { recursive: true });
  vi.stubEnv('MOTIR_CONFIG_HOME', join(base, 'config'));
  process.chdir(root);
  setCredential(server.url, { token: TOKEN });
  writeFileSync(
    join(root, '.motir.json'),
    JSON.stringify({ serverUrl: server.url, workspace: 'acme', project: 'PROD' }),
  );
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  server.calls.length = 0;
  server.v1Calls.length = 0;
  server.resetV1();
  // `batchCommand` reports the run through `process.exitCode`; restoring it in
  // afterEach keeps a scripted failure from failing the test PROCESS.
  exitCode = process.exitCode;
});

afterEach(() => {
  process.chdir(cwd);
  process.exitCode = exitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** An agent that exits 0 without doing anything — `node -e ""`. */
const AGENT = { agent: `${process.execPath} -e ""` };

/** A ready set of `keys`, served over the real protocol. The enumeration
 *  advances by `excludeIds`, so the tool honours it exactly as the server
 *  does — otherwise the snapshot could never terminate. */
function planScripts(keys: string[]): { v1: V1Script } {
  const statuses = new Map<string, string>();
  const v1: V1Script = {
    // The whole ready set, ranked — `motir batch` enumerates it once and
    // freezes it. An item leaves the set once its status moves off `todo`.
    'GET /api/v1/projects/{projectKey}/ready': () => ({
      body: v1Page(
        keys
          .filter((k) => (statuses.get(k) ?? 'todo') === 'todo')
          .map((k) => v1ReadyRow(k, { title: `Item ${k}` })),
      ),
    }),
    'GET /api/v1/work-items/{key}/dispatch-prompt': (req) => ({
      body: v1DispatchPrompt(String(req.params['key']), {
        prompt: `PROMPT ${String(req.params['key'])}`,
        targetRepo: 'motir-core',
      }),
    }),
    'POST /api/v1/work-items/{key}/transitions': (req) => {
      const key = String(req.params['key']);
      const status = String((req.body as { status: string }).status);
      statuses.set(key, status);
      return { body: v1Detail(key, { status }) };
    },
    // A TRIPWIRE, not a fixture: `motir batch` opens a pull request per item and
    // must never record one onto a session lineage. Scripted to refuse, so a
    // regression that starts integrating fails loudly here.
    'POST /api/v1/work-items/{key}/integration': {
      status: 422,
      body: {
        code: 'UNPROCESSABLE',
        error: '`motir batch` must NEVER integrate onto a session branch.',
      },
    },
  };
  return { v1 };
}

/** Script both halves of the plan onto the server. */
function scriptPlan(keys: string[]): void {
  server.scriptV1(planScripts(keys).v1);
}

/** Every `/api/v1` request to one operation, in order. */
function v1CallsTo(method: string, suffix: string): V1Request[] {
  return server.v1Calls.filter((c) => c.method === method && c.path.endsWith(suffix));
}

describe('motir batch refuses to start without an agent', () => {
  it('rejects --print: a snapshot has nobody to paste a prompt', async () => {
    await expect(batchCommand({ print: true, ...AGENT })).rejects.toMatchObject({
      message: expect.stringContaining('cannot run in --print mode'),
      hint: expect.stringContaining('motir next --print'),
    });
    // It failed BEFORE opening a session — nothing was read or claimed.
    expect(server.calls).toHaveLength(0);
  });

  // The guard above is only worth anything if the flag actually REACHES it.
  // MOTIR-1830: `--print` was never registered on `batch`, so commander rejected
  // it first with a bare `unknown option '--print'` and the guard — with the hint
  // that tells the user what to do instead — was dead code from the command line.
  // This is the SAME defect MOTIR-1828 fixed on `auto`; it survived here because
  // `batch` merged after that sweep. Calling `batchCommand({ print: true })`
  // directly, as the test above does, cannot catch this class: it bypasses the
  // parser that is doing the rejecting. Drive the REAL program instead.
  it('rejects --print through the REAL program, delivering the guard’s hint', async () => {
    const program = buildProgram();
    // Without this, an unregistered `--print` would take the test runner down
    // with commander's own `process.exit` instead of failing the assertion.
    const noExit = (command: Command): void => {
      command.exitOverride();
      command.commands.forEach(noExit);
    };
    noExit(program);

    await expect(
      program.parseAsync(['batch', '--print', '--agent', 'echo'], { from: 'user' }),
    ).rejects.toMatchObject({
      name: 'CliError',
      message: expect.stringContaining('cannot run in --print mode'),
      hint: expect.stringContaining('motir next --print'),
    });
    expect(server.calls).toHaveLength(0);
  });

  it('rejects a run with no agent configured anywhere, naming the three sources', async () => {
    vi.stubEnv('MOTIR_AGENT', '');
    await expect(batchCommand({})).rejects.toMatchObject({
      hint: expect.stringMatching(/MOTIR_AGENT.*agentCommand|--agent/),
    });
    expect(server.calls).toHaveLength(0);
  });

  it('rejects a malformed --max before any work is snapshotted', async () => {
    await expect(batchCommand({ ...AGENT, max: '0' })).rejects.toThrow(CliError);
    expect(server.calls).toHaveLength(0);
  });

  it('rejects a malformed --kinds before any work is snapshotted', async () => {
    await expect(batchCommand({ ...AGENT, kinds: 'subtask,nonsense' })).rejects.toThrow(CliError);
    expect(server.calls).toHaveLength(0);
  });
});

describe('motir batch — a whole run through the real session', () => {
  it('drains the snapshot, prints the summary, and exits 0', async () => {
    scriptPlan(['PROD-1', 'PROD-2']);
    const prompts: string[] = [];

    await batchCommand(
      { ...AGENT },
      {
        clock: () => 0,
        runAgentFn: async ({ prompt }) => {
          prompts.push(prompt);
          return { exitCode: 0, signal: null };
        },
      },
    );

    expect(prompts).toEqual(['PROMPT PROD-1', 'PROMPT PROD-2']);
    // Each item walked its own lifecycle to In Review — its own pull request.
    expect(
      v1CallsTo('POST', '/transitions').map((c) => (c.body as { status: string }).status),
    ).toEqual(['in_progress', 'in_review', 'in_progress', 'in_review']);
    // No session branch was ever created: the integration route is scripted to
    // refuse, so calling it at all would surface here.
    expect(v1CallsTo('POST', '/integration')).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('runs on its OWN clock and its OWN agent launcher when nothing is injected', async () => {
    // The shape the binary runs in: no injected deps at all. The ready set is
    // empty, so the real `runAgent` is reached for but never launched — the run
    // still opens the session, prints the summary and reports cleanly.
    scriptPlan([]);

    await batchCommand({ ...AGENT, kinds: 'subtask' });

    // `--kinds` reached the server's own filter rather than being dropped —
    // the ready collection's own REPEATED `kind` parameter (MOTIR-2398).
    expect(v1CallsTo('GET', '/ready')[0]?.query.getAll('kind')).toEqual(['subtask']);
    expect(v1CallsTo('GET', '/dispatch-prompt')).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('exits non-zero when an agent failed, leaving the item In Progress', async () => {
    scriptPlan(['PROD-1', 'PROD-2']);

    await batchCommand(
      { ...AGENT },
      { clock: () => 0, runAgentFn: async () => ({ exitCode: 7, signal: null }) },
    );

    expect(process.exitCode).toBe(1);
    // Halted on the first failure: the second item was never touched.
    expect(v1CallsTo('GET', '/dispatch-prompt').map((c) => c.params['key'])).toEqual(['PROD-1']);
    expect(
      v1CallsTo('POST', '/transitions').map((c) => (c.body as { status: string }).status),
    ).toEqual(['in_progress']);
  });

  it('--max caps the run and --keep-going carries it past a failure', async () => {
    scriptPlan(['PROD-1', 'PROD-2', 'PROD-3']);
    const prompts: string[] = [];

    await batchCommand(
      { ...AGENT, max: '2', keepGoing: true },
      {
        clock: () => 0,
        runAgentFn: async ({ prompt }) => {
          prompts.push(prompt);
          return { exitCode: prompt.endsWith('PROD-1') ? 5 : 0, signal: null };
        },
      },
    );

    expect(prompts).toEqual(['PROMPT PROD-1', 'PROMPT PROD-2']);
    expect(process.exitCode).toBe(1);
  });
});
