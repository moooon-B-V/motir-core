import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { batchCommand } from '../src/commands/batch.js';
import { setCredential } from '../src/config/userConfig.js';
import { CliError } from '../src/errors.js';
import {
  startTestMcpServer,
  type TestMcpServer,
  type ToolScript,
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
function planTools(keys: string[]): ToolScript {
  const statuses = new Map<string, string>();
  return {
    next_ready: (args) => {
      const excluded = new Set((args['excludeIds'] as string[] | undefined) ?? []);
      const key = keys.find(
        (k) => !excluded.has(`row-${k}`) && (statuses.get(k) ?? 'todo') === 'todo',
      );
      if (!key) return { structured: { item: null } };
      return {
        structured: {
          item: {
            id: `row-${key}`,
            key,
            kind: 'subtask',
            title: `Item ${key}`,
            priority: 'medium',
            status: { key: 'todo', category: 'todo' },
            type: 'code',
            executor: 'coding_agent',
            targetRepo: 'motir-core',
            sessionBranch: null,
          },
        },
      };
    },
    dispatch_prompt: (args) => ({
      structured: {
        key: String(args['key']),
        prompt: `PROMPT ${String(args['key'])}`,
        targetRepo: 'motir-core',
        workflowMode: 'per_item_pr',
        sessionBranch: null,
      },
    }),
    transition_status: (args) => {
      statuses.set(String(args['key']), String(args['status']));
      return { structured: { ok: true } };
    },
    mark_integrated: () => ({ error: '`motir batch` must NEVER integrate onto a session branch.' }),
  };
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
    server.script(planTools(['PROD-1', 'PROD-2']));
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
      server.calls.filter((c) => c.name === 'transition_status').map((c) => c.args['status']),
    ).toEqual(['in_progress', 'in_review', 'in_progress', 'in_review']);
    // No session branch was ever created: `mark_integrated` is scripted to fail,
    // so calling it at all would surface here.
    expect(server.calls.some((c) => c.name === 'mark_integrated')).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('runs on its OWN clock and its OWN agent launcher when nothing is injected', async () => {
    // The shape the binary runs in: no injected deps at all. The ready set is
    // empty, so the real `runAgent` is reached for but never launched — the run
    // still opens the session, prints the summary and reports cleanly.
    server.script(planTools([]));

    await batchCommand({ ...AGENT, kinds: 'subtask' });

    // `--kinds` reached the server's own filter rather than being dropped.
    expect(server.calls.find((c) => c.name === 'next_ready')?.args).toMatchObject({
      kinds: ['subtask'],
    });
    expect(server.calls.some((c) => c.name === 'dispatch_prompt')).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('exits non-zero when an agent failed, leaving the item In Progress', async () => {
    server.script(planTools(['PROD-1', 'PROD-2']));

    await batchCommand(
      { ...AGENT },
      { clock: () => 0, runAgentFn: async () => ({ exitCode: 7, signal: null }) },
    );

    expect(process.exitCode).toBe(1);
    // Halted on the first failure: the second item was never touched.
    const dispatched = server.calls.filter((c) => c.name === 'dispatch_prompt');
    expect(dispatched.map((c) => c.args['key'])).toEqual(['PROD-1']);
    expect(
      server.calls.filter((c) => c.name === 'transition_status').map((c) => c.args['status']),
    ).toEqual(['in_progress']);
  });

  it('--max caps the run and --keep-going carries it past a failure', async () => {
    server.script(planTools(['PROD-1', 'PROD-2', 'PROD-3']));
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
