import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_LOGS_FILE,
  APP_LOGS_STATE_FILE,
  lineKey,
  startAppLogCapture,
  type LogRunner,
} from '@/loadtest/capture/appLogs';
import {
  DB_SAMPLER_SQL,
  DB_SAMPLES_FILE,
  DB_SAMPLES_STATE_FILE,
  startDbSampler,
  type SamplerClient,
} from '@/loadtest/capture/dbSampler';
import { CAPTURE_FILES, startRecorders } from '@/loadtest/capture/index';
import { readEndpointState } from '@/loadtest/capture/neon';
import { snapshotPgss } from '@/loadtest/capture/pgss';
import { redact } from '@/loadtest/capture/redact';
import type { Exec } from '@/loadtest/run/fly';
import {
  RUN_RECORD_FILE,
  UNMEASURED,
  newRunRecord,
  readRunRecord,
  windowFrom,
  writeRunRecord,
} from '@/loadtest/run/runRecord';

// The capture recorders' remaining branches (Story MOTIR-8538 · MOTIR-8681): the
// orchestration in capture/index.ts over stubbed fly / neonctl / Neon API / pg
// client seams, and the edge cases of each recorder. No database is touched — the
// sampler and the pg_stat_statements read go through their injected client.

const out = () => mkdtempSync(join(tmpdir(), 'loadtest-capture-cov-'));
const SECRET = 'npg_c0verageSecret';
const DIRECT = `postgresql://motir_app:${SECRET}@ep-a.us-east-2.aws.neon.tech/motir`;
const readJson = (dir: string, f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

/** A `fly logs` stub that emits its lines and runs until killed. */
const holdingRunner = (lines: string[]) => {
  const emitted = deferred();
  const runner: LogRunner = (_args, onLine) => {
    let kill: () => void = () => undefined;
    const exited = new Promise<number>((r) => {
      kill = () => r(0);
      queueMicrotask(() => {
        lines.forEach(onLine);
        emitted.resolve();
      });
    });
    return { exited, kill };
  };
  return { runner, emitted: emitted.promise };
};

/** A sampler client answering each statement from `sample`, and recording them. */
function fakeClient(opts: {
  sample: () => Promise<{ rows: Record<string, unknown>[] }>;
  end?: () => Promise<unknown>;
}) {
  const sent: string[] = [];
  const client: SamplerClient = {
    connect: async () => undefined,
    end: opts.end ?? (async () => undefined),
    query: async (sql) => {
      sent.push(sql);
      return sql === DB_SAMPLER_SQL.sample ? opts.sample() : { rows: [] };
    },
  };
  return { client, sent };
}

const okExec =
  (url: string): Exec =>
  async () => ({ code: 0, stdout: `${url}\n`, stderr: '' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('lineKey', () => {
  it('is null for a non-JSON line and for JSON that is not an object', () => {
    expect(lineKey('plain text')).toBeNull();
    expect(lineKey('null')).toBeNull();
    expect(lineKey('42')).toBeNull();
  });

  it('keys on (timestamp, instance, message), nulls for the missing ones', () => {
    expect(lineKey('{"instance": 7}')).toEqual({
      key: JSON.stringify([null, null, null]),
      instance: null,
    });
    expect(lineKey('{"timestamp":"t","instance":"m-1","message":"hi"}')).toEqual({
      key: JSON.stringify(['t', 'm-1', 'hi']),
      instance: 'm-1',
    });
  });
});

describe('the app log capture, edge cases', () => {
  it('writes non-JSON lines verbatim, skips blank ones, and names no instance for them', async () => {
    const dir = out();
    const { runner, emitted } = holdingRunner([
      'not json',
      '   ',
      '{"message":"no instance"}',
      'not json',
    ]);
    const cap = await startAppLogCapture({ app: 'motir-core-staging', runner, outDir: dir });
    await emitted;
    const res = await cap.stop();
    // A non-JSON line has no dedupe key, so its repeat is written too.
    expect(readFileSync(join(dir, APP_LOGS_FILE), 'utf8')).toBe(
      'not json\n{"message":"no instance"}\nnot json\n',
    );
    expect(res).toEqual({ lines: 3, gaps: [], instances: [] });
    expect(existsSync(join(dir, APP_LOGS_STATE_FILE))).toBe(false);
  });

  it('a stream that never produced a line and keeps exiting is `failed`, with the default clock and sleep', async () => {
    const dir = out();
    let calls = 0;
    const second = deferred();
    const runner: LogRunner = () => {
      calls += 1;
      if (calls === 2) second.resolve();
      return { exited: Promise.resolve(calls === 1 ? 1 : 0), kill: () => undefined };
    };
    const cap = await startAppLogCapture({
      app: 'motir-core-staging',
      runner,
      outDir: dir,
      backoffMs: 1,
    });
    await second.promise;
    const res = await cap.stop();
    expect(res.lines).toBe(0);
    expect(res.gaps.length).toBeGreaterThanOrEqual(1);
    expect(res.gaps[0]!.exitCode).toBe(1);
    expect(Date.parse(res.gaps[0]!.to)).toBeGreaterThanOrEqual(Date.parse(res.gaps[0]!.from));
    const state = readJson(dir, APP_LOGS_STATE_FILE);
    expect(state.state).toBe('failed');
    expect(state.reason).toMatch(/^fly logs exited \d+ time\(s\) during the run$/);
  });
});

describe('the database sampler, over an injected client', () => {
  it('samples on its interval, writes empty cells for missing columns, and survives a failing end()', async () => {
    const dir = out();
    let n = 0;
    const twice = deferred();
    const { client, sent } = fakeClient({
      sample: async () => {
        n += 1;
        if (n === 2) twice.resolve();
        return n === 1 ? { rows: [] } : { rows: [{ backends: 3, max_connections: 100 }] };
      },
      end: async () => {
        throw new Error('already closed');
      },
    });
    const sampler = await startDbSampler({
      directUrl: DIRECT,
      outDir: dir,
      intervalMs: 5,
      client: () => client,
    });
    await twice.promise;
    const res = await sampler.stop();
    expect(res.failures).toBe(0);
    expect(res.rows).toBeGreaterThanOrEqual(2);
    const rows = readFileSync(join(dir, DB_SAMPLES_FILE), 'utf8').trim().split('\n');
    // The first sample had no row at all: every cell after `at` is empty.
    expect(rows[1]!.split(',').slice(1)).toEqual(Array(10).fill(''));
    expect(rows[2]!.split(',').slice(1)).toEqual(['3', '', '', '', '100', '', '', '', '', '']);
    expect(Number.isNaN(Date.parse(rows[1]!.split(',')[0]!))).toBe(false);
    expect(sent.slice(0, 4)).toEqual([
      DB_SAMPLER_SQL.begin,
      DB_SAMPLER_SQL.timeout,
      DB_SAMPLER_SQL.sample,
      DB_SAMPLER_SQL.rollback,
    ]);
    expect(existsSync(join(dir, DB_SAMPLES_STATE_FILE))).toBe(false);
  });

  it('a failing sample still rolls back, and the state is `partial` once a row landed', async () => {
    const dir = out();
    let n = 0;
    const failedOnce = deferred();
    const { client, sent } = fakeClient({
      sample: async () => {
        n += 1;
        if (n === 1) return { rows: [{ backends: 1 }] };
        failedOnce.resolve();
        throw new Error(`canceling statement on ${DIRECT}`);
      },
    });
    const sampler = await startDbSampler({
      directUrl: DIRECT,
      outDir: dir,
      intervalMs: 5,
      now: () => new Date('2026-10-15T20:00:00Z'),
      client: () => client,
    });
    await failedOnce.promise;
    const res = await sampler.stop();
    expect(res.rows).toBe(1);
    expect(res.failures).toBeGreaterThanOrEqual(1);
    // Every BEGIN was matched by a ROLLBACK, the failing one included.
    expect(sent.filter((s) => s === DB_SAMPLER_SQL.rollback)).toHaveLength(
      sent.filter((s) => s === DB_SAMPLER_SQL.begin).length,
    );
    const raw = readFileSync(join(dir, DB_SAMPLES_STATE_FILE), 'utf8');
    expect(raw).not.toContain(SECRET);
    const state = JSON.parse(raw);
    expect(state.state).toBe('partial');
    expect(state.samples).toBe(1);
    expect(state.failures[0]).toEqual({
      at: '2026-10-15T20:00:00.000Z',
      error: 'canceling statement on [redacted]',
    });
  });
});

describe('the Neon endpoint read, edge cases', () => {
  it('an answer without an endpoints array is unmeasured', async () => {
    const r = await readEndpointState({
      env: { LOADTEST_NEON_API_KEY: 'k' },
      project: 'p',
      branchId: 'b',
      now: () => new Date('2026-10-15T20:00:00Z'),
      fetchImpl: (async () => new Response('{}')) as unknown as typeof fetch,
    });
    expect(r).toEqual({
      state: 'unmeasured',
      readAt: '2026-10-15T20:00:00.000Z',
      reason: 'the Neon API answer has no endpoints array',
    });
  });

  it('a missing field reads `unmeasured`, and a blank API URL falls back to the default (global fetch)', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ endpoints: [{ id: 'ep-1', extra: 'dropped' }] }));
    });
    const r = await readEndpointState({
      env: { LOADTEST_NEON_API_KEY: ' k ', LOADTEST_NEON_API_URL: '  ' },
      project: 'my proj',
      branchId: 'br/1',
    });
    expect(seen).toEqual([
      'https://console.neon.tech/api/v2/projects/my%20proj/branches/br%2F1/endpoints',
    ]);
    expect(r).toMatchObject({
      state: 'ok',
      endpoints: [
        {
          id: 'ep-1',
          type: 'unmeasured',
          current_state: 'unmeasured',
          autoscaling_limit_min_cu: 'unmeasured',
          autoscaling_limit_max_cu: 'unmeasured',
        },
      ],
    });
    if (r.state === 'ok') expect(r.endpoints[0]).not.toHaveProperty('extra');
  });

  it('a thrown fetch is unmeasured, with the key redacted from the reason', async () => {
    const r = await readEndpointState({
      env: { LOADTEST_NEON_API_KEY: 'neon-secret-key' },
      project: 'p',
      branchId: 'b',
      fetchImpl: (async () => {
        throw new Error('fetch failed for Bearer neon-secret-key');
      }) as unknown as typeof fetch,
    });
    expect(r).toMatchObject({
      state: 'unmeasured',
      reason: 'fetch failed for Bearer [redacted]',
    });
  });
});

describe('the pg_stat_statements snapshot, edge cases', () => {
  it('with no direct URL it writes the unread reason, or a default one', async () => {
    const dir = out();
    const r1 = await snapshotPgss({
      name: 'pgss-before',
      directUrl: null,
      outDir: dir,
      unreadReason: 'neonctl exited 1',
    });
    expect(r1).toEqual({ state: 'failed', reason: 'neonctl exited 1' });
    expect(readJson(dir, 'pgss-before.state.json')).toEqual(r1);
    const r2 = await snapshotPgss({ name: 'pgss-after', directUrl: null, outDir: dir });
    expect(r2).toEqual({ state: 'failed', reason: 'no direct connection string' });
    expect(readJson(dir, 'pgss-after.json')).toEqual(r2);
  });

  it('passes the shipped top-N limit to the read, and writes no state file for an ok readout', async () => {
    const dir = out();
    const limits: number[] = [];
    const r = await snapshotPgss({
      name: 'pgss-before',
      directUrl: DIRECT,
      outDir: dir,
      read: async (_url, limit) => {
        limits.push(limit);
        return { state: 'extension_not_installed' };
      },
    });
    expect(limits).toEqual([200]);
    expect(r).toEqual({ state: 'extension_not_installed' });
    expect(existsSync(join(dir, 'pgss-before.state.json'))).toBe(false);
  });

  it('the default read against an unreachable host fails into the state file, URL redacted', async () => {
    const dir = out();
    const url = `postgresql://u:${SECRET}@127.0.0.1:1/db`;
    const r = await snapshotPgss({ name: 'pgss-after', directUrl: url, outDir: dir });
    expect(r.state).toBe('failed');
    const raw = readFileSync(join(dir, 'pgss-after.state.json'), 'utf8');
    expect(raw).not.toContain(SECRET);
  });
});

describe('redact, edge cases', () => {
  it('skips empty secrets and defaults to none', () => {
    expect(redact('postgresql://u:p@h/db', [null, undefined, ''])).toBe(
      'postgresql://[redacted]@h/db',
    );
    expect(redact('nothing secret here')).toBe('nothing secret here');
  });
});

describe('startRecorders', () => {
  const base = (dir: string) => ({
    app: 'motir-core-staging',
    outDir: dir,
    env: { LOADTEST_NEON_API_KEY: 'neon-key', LOADTEST_NEON_API_URL: 'http://stub.local/v2' },
    project: 'proj',
    branch: 'loadtest',
    branchId: 'br-1',
    now: () => new Date('2026-10-15T20:00:00Z'),
  });

  it('starts every recorder, writes every capture file, and reports the counts on stop', async () => {
    const dir = out();
    const log: string[] = [];
    let pgssReads = 0;
    const sampled = deferred();
    const logs = holdingRunner([
      JSON.stringify({ timestamp: 't1', instance: 'm-b', message: 'x' }),
      JSON.stringify({ timestamp: 't1', instance: 'm-a', message: 'y' }),
    ]);
    const { client } = fakeClient({
      sample: async () => {
        sampled.resolve();
        return { rows: [{ backends: 2 }] };
      },
    });
    const rec = await startRecorders({
      ...base(dir),
      exec: okExec(DIRECT),
      log: (l) => log.push(l),
      deps: {
        logRunner: logs.runner,
        fetchImpl: (async () =>
          new Response(JSON.stringify({ endpoints: [] }))) as unknown as typeof fetch,
        readTopStatements: async (url, limit) => {
          pgssReads += 1;
          expect(url).toBe(DIRECT);
          expect(limit).toBe(200);
          return { state: 'extension_not_loaded', detail: 'no preload' };
        },
        dbClient: () => client,
        sampleIntervalMs: 60_000,
      },
    });
    await Promise.all([sampled.promise, logs.emitted]);
    const res = await rec.stop();
    expect(res).toEqual({ logLines: 2, logGaps: 0, logInstances: ['m-a', 'm-b'], dbSamples: 1 });
    expect(log).toEqual([]);
    expect(pgssReads).toBe(2);
    for (const f of CAPTURE_FILES) expect(existsSync(join(dir, f)), f).toBe(true);
    expect(readJson(dir, 'neon-endpoint-start.json')).toEqual({
      state: 'ok',
      readAt: '2026-10-15T20:00:00.000Z',
      endpoints: [],
    });
    expect(readJson(dir, 'pgss-after.json')).toEqual({
      state: 'extension_not_loaded',
      detail: 'no preload',
    });
    expect(existsSync(join(dir, DB_SAMPLES_STATE_FILE))).toBe(false);
    expect(existsSync(join(dir, APP_LOGS_STATE_FILE))).toBe(false);
  });

  it('with no deps, a refused log capture and an unreadable direct URL still leave every file, and never throw', async () => {
    const dir = out();
    const log: string[] = [];
    const rec = await startRecorders({
      ...base(dir),
      app: 'motir-core',
      env: {},
      exec: async () => ({ code: 1, stdout: '', stderr: 'boom' }),
      log: (l) => log.push(l),
    });
    const res = await rec.stop();
    expect(res).toEqual({ logLines: 0, logGaps: 0, logInstances: [], dbSamples: 0 });
    expect(log).toEqual([
      'capture: the log capture failed — refused: the log capture never reads production (motir-core) (the run goes on; the report reads it as unmeasured)',
      'capture: resolving the branch direct URL failed — neonctl connection-string exited 1 (the run goes on; the report reads it as unmeasured)',
    ]);
    for (const f of CAPTURE_FILES) expect(existsSync(join(dir, f)), f).toBe(true);
    expect(readFileSync(join(dir, 'app-logs.ndjson'), 'utf8')).toBe('');
    expect(readJson(dir, 'app-logs.gaps.json')).toEqual([]);
    expect(readJson(dir, APP_LOGS_STATE_FILE)).toEqual({
      state: 'failed',
      reason: 'refused: the log capture never reads production (motir-core)',
    });
    expect(readFileSync(join(dir, DB_SAMPLES_FILE), 'utf8')).toMatch(/^at,backends,/);
    expect(readJson(dir, DB_SAMPLES_STATE_FILE)).toEqual({
      state: 'failed',
      reason: 'neonctl connection-string exited 1',
    });
    expect(readJson(dir, 'neon-endpoint-end.json')).toMatchObject({ state: 'unmeasured' });
    expect(readJson(dir, 'pgss-before.json')).toEqual({
      state: 'failed',
      reason: 'neonctl connection-string exited 1',
    });
  });

  it('a sampler that throws on start is recorded as failed with the URL redacted, and the run goes on', async () => {
    const dir = out();
    const log: string[] = [];
    let clockCalls = 0;
    const rec = await startRecorders({
      ...base(dir),
      env: {},
      exec: okExec(DIRECT),
      // The sampler's first clock read (on its connect failure) throws out of it.
      now: () => {
        clockCalls += 1;
        if (clockCalls === 1) throw new Error(`clock unavailable for ${DIRECT}`);
        return new Date('2026-10-15T20:00:00Z');
      },
      log: (l) => log.push(l),
      deps: {
        logRunner: holdingRunner([]).runner,
        dbClient: () => ({
          connect: async () => {
            throw new Error('connect refused');
          },
          query: async () => ({ rows: [] }),
          end: async () => undefined,
        }),
        readTopStatements: async () => ({ state: 'extension_not_installed' }),
      },
    });
    const res = await rec.stop();
    expect(res.dbSamples).toBe(0);
    expect(log).toEqual([
      'capture: the database sampler failed — clock unavailable for [redacted] (the run goes on; the report reads it as unmeasured)',
    ]);
    expect(readJson(dir, DB_SAMPLES_STATE_FILE)).toEqual({
      state: 'failed',
      reason: 'clock unavailable for [redacted]',
    });
    expect(readFileSync(join(dir, DB_SAMPLES_FILE), 'utf8')).toMatch(/^at,backends,/);
    // The direct URL was resolved, so the pg_stat_statements read still ran.
    expect(readJson(dir, 'pgss-before.json')).toEqual({ state: 'extension_not_installed' });
  });
});

describe('the run record', () => {
  const init = {
    runId: 'run-1',
    profile: { name: 'p', path: 'loadtest/profiles/p.json', sha256: 'abc' },
    instances: 2,
    app: 'motir-core-staging',
    candidateSize: true,
    neonProject: 'proj',
    generatorApp: 'gen',
    requiredConcurrency: { hard: 50, soft: 40 },
    offered: {
      rpsUpperBound: 100,
      perWorkspaceRps: 10,
      perTokenRps: { mcp: 5, apiV1: 5 },
      readerStreamsPerInstance: 2,
    },
    baseline: null,
  };

  it('a new record marks everything unread as unmeasured, and round-trips through run.json', async () => {
    const rec = newRunRecord(init);
    expect(rec.capture).toBe(UNMEASURED);
    expect(rec.app).toEqual({ name: 'motir-core-staging', machines: UNMEASURED });
    expect(rec.generator.app).toBe('gen');
    expect(rec.exitCode).toBeNull();
    const dir = join(out(), 'nested', 'run-1');
    const path = await writeRunRecord(dir, rec);
    expect(path).toBe(join(dir, RUN_RECORD_FILE));
    expect(await readRunRecord(dir)).toEqual(rec);
  });

  it('windowFrom derives the ramp and steady ends, or is unmeasured for an unreadable start', () => {
    expect(
      windowFrom('2026-10-15T20:00:00Z', UNMEASURED, { rampSeconds: 60, steadySeconds: 300 }),
    ).toEqual({
      startedAt: '2026-10-15T20:00:00.000Z',
      rampEndedAt: '2026-10-15T20:01:00.000Z',
      steadyEndedAt: '2026-10-15T20:06:00.000Z',
      endedAt: UNMEASURED,
    });
    expect(
      windowFrom('not a time', '2026-10-15T20:07:00.000Z', { rampSeconds: 1, steadySeconds: 1 }),
    ).toEqual({
      startedAt: UNMEASURED,
      rampEndedAt: UNMEASURED,
      steadyEndedAt: UNMEASURED,
      endedAt: '2026-10-15T20:07:00.000Z',
    });
  });
});
