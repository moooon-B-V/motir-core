import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../src/errors.js';
import { startTestServer, type TestServer } from './helpers/testServer.js';

// `withHostedProjectSession` (MOTIR-6558 · MOTIR-6559) — the one entry a HOSTED
// command goes through. Driven for real against an HTTP server: the credential
// ladder's hosted rungs, the run read and its adoption check, and the link
// synthesised at the workspace. Only `prepareHostedRun` is stubbed — it writes a
// git config and a `gh` shim, which `test/hostedGit.test.ts` drives for real —
// so what is asserted here is the ORDER and the arguments it is handed.

const prepareHostedRun = vi.hoisted(() => vi.fn(async () => ({ dispatchedBy: 'Zhu Yue' })));
vi.mock('../src/hostedGit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/hostedGit.js')>()),
  prepareHostedRun,
}));

const { withHostedProjectSession } = await import('../src/session.js');

const HOSTED_ENV = [
  'MOTIR_TOKEN',
  'MOTIR_RUN_TOKEN',
  'MOTIR_SERVER',
  'MOTIR_API_URL',
  'MOTIR_CONFIG_HOME',
  'MOTIR_WORKSPACE',
] as const;

let server: TestServer;
let home: string;
let workspace: string;
const saved: Partial<Record<(typeof HOSTED_ENV)[number], string | undefined>> = {};

function run(over: { status?: 'running' | 'failed'; endedAt?: string | null } = {}) {
  const card = (key: string, position: number) => ({
    id: `card-${position}`,
    key,
    workItemId: `wi-${position}`,
    position,
    disposition: 'queued' as const,
    skipReason: null,
    sessionBranch: null,
    startedAt: null,
    endedAt: null,
    exitCode: null,
  });
  return {
    id: 'run-7',
    projectId: 'proj-1',
    command: 'run_scope' as const,
    origin: 'hosted' as const,
    scopeWorkItemId: 'wi-parent',
    scopeLabel: 'ACME-1',
    status: over.status ?? ('running' as const),
    stopReason: null,
    agent: 'opencode',
    model: 'claude-opus-5-5',
    startedAt: '2026-09-27T00:00:00.000Z',
    endedAt: over.endedAt ?? null,
    createdById: 'user-1',
    cards: [card('ACME-3', 2), card('ACME-2', 1)],
    seq: 1,
  };
}

beforeAll(async () => {
  server = await startTestServer({ token: 'run-token' });
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  for (const name of HOSTED_ENV) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  home = mkdtempSync(join(tmpdir(), 'motir-session-home-'));
  workspace = mkdtempSync(join(tmpdir(), 'motir-session-ws-'));
  // The HOSTED rungs of the ladder — the names a container is booted with.
  process.env['MOTIR_API_URL'] = server.url;
  process.env['MOTIR_RUN_TOKEN'] = 'run-token';
  process.env['MOTIR_CONFIG_HOME'] = home;
  process.env['MOTIR_WORKSPACE'] = workspace;
  server.v1Calls.length = 0;
  server.resetV1();
  server.scriptV1({ 'GET /api/v1/dispatch-runs/{id}': { body: run() } });
  prepareHostedRun.mockClear();
});

afterEach(() => {
  for (const name of HOSTED_ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe('withHostedProjectSession', () => {
  it('reads the run, prepares GitHub access for it, then hands the command a session on the run’s project', async () => {
    const fn = vi.fn(async () => 'done');

    await expect(withHostedProjectSession('run-7', fn, 'ACME-2')).resolves.toBe('done');

    // The run is read FIRST, with the run credential, and nothing else is.
    expect(server.v1Calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/v1/dispatch-runs/run-7',
    ]);
    expect(prepareHostedRun).toHaveBeenCalledTimes(1);
    expect(prepareHostedRun).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: server.url,
        token: 'run-token',
        runId: 'run-7',
        targetKey: 'ACME-2',
      }),
    );

    const [session, adopted] = fn.mock.calls[0] as unknown as [
      { projectKey: string; serverUrl: string; link: { dir: string; config: unknown } },
      { runId: string; projectKey: string; legs: string[] },
    ];
    // The project comes from the run's own cards, and the legs keep its order.
    expect(adopted).toEqual({ runId: 'run-7', projectKey: 'ACME', legs: ['ACME-2', 'ACME-3'] });
    expect(session.projectKey).toBe('ACME');
    expect(session.serverUrl).toBe(server.url);
    // No `.motir.json` in the container: the link is SYNTHESISED at the workspace.
    expect(session.link.dir).toBe(workspace);
    expect(session.link.config).toEqual({
      serverUrl: server.url,
      workspace: '',
      project: 'ACME',
    });
  });

  it('attributes the run’s pull requests to its FIRST leg when the command named no card', async () => {
    await withHostedProjectSession('run-7', async () => undefined);

    expect(prepareHostedRun).toHaveBeenCalledWith(expect.objectContaining({ targetKey: 'ACME-2' }));
  });

  it('refuses before any network call when no credential is on the ladder', async () => {
    delete process.env['MOTIR_RUN_TOKEN'];
    const fn = vi.fn();

    const refused = withHostedProjectSession('run-7', fn);

    await expect(refused).rejects.toBeInstanceOf(CliError);
    await expect(refused).rejects.toThrow(`Not logged in to ${server.url}.`);
    expect(server.v1Calls).toEqual([]);
    expect(prepareHostedRun).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses a run that has already ended, and prepares nothing for it', async () => {
    server.scriptV1({
      'GET /api/v1/dispatch-runs/{id}': {
        body: run({ status: 'failed', endedAt: '2026-09-27T00:30:00.000Z' }),
      },
    });
    const fn = vi.fn();

    await expect(withHostedProjectSession('run-7', fn)).rejects.toThrow(
      'Run run-7 has already ended (failed); nothing to adopt.',
    );
    expect(prepareHostedRun).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });
});
