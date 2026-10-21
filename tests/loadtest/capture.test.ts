import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';
import { PG_TOP_STATEMENTS_MARKER } from '@/scripts/pgTopStatements';
import { PG_TOP_STATEMENTS_SQL, readTopStatementsWithin } from '@/scripts/pgTopStatementsQuery';
import {
  APP_LOGS_FILE,
  APP_LOGS_GAPS_FILE,
  logsArgs,
  startAppLogCapture,
  type LogRunner,
} from '@/loadtest/capture/appLogs';
import { DB_SAMPLER_SQL, startDbSampler, type SamplerClient } from '@/loadtest/capture/dbSampler';
import {
  NEON_API_DEFAULT,
  assertDirectUrl,
  readEndpointState,
  resolveBranchDirectUrl,
} from '@/loadtest/capture/neon';
import { snapshotPgss } from '@/loadtest/capture/pgss';
import { redact } from '@/loadtest/capture/redact';
import type { Exec } from '@/loadtest/run/fly';
import { currentWorkerAdminUrl } from '../helpers/parallelDb';

// The run-window recorders (Story MOTIR-8538 · MOTIR-8683): the log stream over a
// stubbed `fly logs`, the database sampler against the real test Postgres, the
// Neon endpoint read against a stub API, and the pg_stat_statements snapshots.

const ROOT = resolve(__dirname, '../..');
const out = () => mkdtempSync(join(tmpdir(), 'loadtest-capture-'));
const SECRET = 'npg_s3cretPassw0rd';
const line = (instance: string, message: string, timestamp: string) =>
  JSON.stringify({ timestamp, instance, region: 'iad', level: 'info', message });

/** A scripted `fly logs`: each session emits its lines, then exits with its code (or waits to be killed). */
function scriptedRunner(sessions: { lines: string[]; exitCode?: number }[]) {
  const calls: string[][] = [];
  const runner: LogRunner = (args, onLine) => {
    calls.push([...args]);
    const s = sessions[calls.length - 1] ?? { lines: [] };
    let kill: () => void = () => undefined;
    const exited = new Promise<number>((r) => {
      kill = () => r(0);
      queueMicrotask(() => {
        for (const l of s.lines) onLine(l);
        if (s.exitCode !== undefined) r(s.exitCode);
      });
    });
    return { exited, kill };
  };
  return { runner, calls };
}

describe('the app log capture', () => {
  it('refuses motir-core before any runner call', async () => {
    const { runner, calls } = scriptedRunner([]);
    await expect(startAppLogCapture({ app: 'motir-core', runner, outDir: out() })).rejects.toThrow(
      /never reads production/,
    );
    expect(calls).toEqual([]);
  });

  it('issues one unfiltered `fly logs -a <app> --json` and attributes both machines’ lines', async () => {
    const dir = out();
    const { runner, calls } = scriptedRunner([
      {
        lines: [
          line('m-aaa', 'GET /workbench 200', 't1'),
          line('m-bbb', 'POST /api/mcp 200', 't1'),
        ],
      },
    ]);
    const cap = await startAppLogCapture({ app: 'motir-core-staging', runner, outDir: dir });
    await new Promise((r) => setTimeout(r, 10));
    const res = await cap.stop();
    expect(calls).toEqual([logsArgs('motir-core-staging')]);
    expect(calls[0]).not.toContain('--machine');
    expect(res.instances).toEqual(['m-aaa', 'm-bbb']);
    const written = readFileSync(join(dir, APP_LOGS_FILE), 'utf8').trim().split('\n');
    expect(written.map((l) => JSON.parse(l).instance)).toEqual(['m-aaa', 'm-bbb']);
    expect(JSON.parse(readFileSync(join(dir, APP_LOGS_GAPS_FILE), 'utf8'))).toEqual([]);
  });

  it('restarts a stream that exits, records the gap, and writes replayed lines once', async () => {
    const dir = out();
    let clock = Date.parse('2026-10-15T20:00:00Z');
    const { runner, calls } = scriptedRunner([
      { lines: [line('m-aaa', 'one', 't1'), line('m-aaa', 'two', 't2')], exitCode: 1 },
      // The buffer replays `two` on reconnect.
      { lines: [line('m-aaa', 'two', 't2'), line('m-bbb', 'three', 't3')] },
    ]);
    const cap = await startAppLogCapture({
      app: 'motir-core-staging',
      runner,
      outDir: dir,
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms;
      },
      backoffMs: 3000,
    });
    await new Promise((r) => setTimeout(r, 20));
    const res = await cap.stop();
    expect(calls).toHaveLength(2);
    expect(res.gaps).toEqual([
      { from: '2026-10-15T20:00:00.000Z', to: '2026-10-15T20:00:03.000Z', exitCode: 1 },
    ]);
    const messages = readFileSync(join(dir, APP_LOGS_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).message);
    expect(messages).toEqual(['one', 'two', 'three']);
    expect(JSON.parse(readFileSync(join(dir, APP_LOGS_GAPS_FILE), 'utf8'))).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, 'app-logs.state.json'), 'utf8')).state).toBe(
      'partial',
    );
  });
});

describe('the database sampler (real Postgres)', () => {
  it('writes at least two rows in 25 s at a 10 s interval, without counting its own backend', async () => {
    const dir = out();
    const url = currentWorkerAdminUrl();
    const probe = new Client({ connectionString: url });
    await probe.connect();
    const sent: string[] = [];
    const recording = (u: string): SamplerClient => {
      const c = new Client({ connectionString: u });
      return {
        connect: () => c.connect(),
        end: () => c.end(),
        query: async (sql: string) => {
          sent.push(sql);
          return c.query(sql);
        },
      };
    };
    try {
      const sampler = await startDbSampler({ directUrl: url, outDir: dir, client: recording });
      await new Promise((r) => setTimeout(r, 1000));
      // The probe counts itself, the sampler and anything else on this database.
      const all = await probe.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()',
      );
      await new Promise((r) => setTimeout(r, 24_000));
      const res = await sampler.stop();
      expect(res.rows).toBeGreaterThanOrEqual(2);
      const rows = readFileSync(join(dir, 'db-samples.csv'), 'utf8').trim().split('\n');
      expect(rows[0]).toBe(
        'at,backends,active,idle_in_transaction,lock_waiting,max_connections,xact_commit,xact_rollback,deadlocks,blks_read,blks_hit',
      );
      const first = rows[1]!.split(',');
      // The sampler's first sample saw the probe and every other backend, not itself.
      expect(Number(first[1])).toBe(all.rows[0]!.n - 1);
      expect(Number(first[5])).toBeGreaterThan(0);
      for (const sql of sent)
        expect(sql.startsWith(`/* ${PG_TOP_STATEMENTS_MARKER} */`)).toBe(true);
    } finally {
      await probe.end();
    }
  }, 40_000);

  it('the shipped pg_stat_statements read ranks none of the sampler’s statements', async () => {
    const client = new Client({ connectionString: currentWorkerAdminUrl() });
    await client.connect();
    try {
      await client.query('BEGIN');
      const schema = 'pgss_fixture_8683';
      await client.query(`CREATE SCHEMA ${schema}`);
      const values = Object.values(DB_SAMPLER_SQL)
        .map(
          (q) =>
            `(${client.escapeLiteral(q)}::text, 1000::bigint, 9999.0::float8, 9.9::float8, 99.0::float8, 1::bigint)`,
        )
        .concat(`('SELECT 1'::text, 1::bigint, 1.0::float8, 1.0::float8, 1.0::float8, 1::bigint)`)
        .join(', ');
      await client.query(
        `CREATE VIEW ${schema}.pg_stat_statements AS SELECT * FROM (VALUES ${values}) AS t(query, calls, total_exec_time, mean_exec_time, max_exec_time, rows)`,
      );
      const fixture = {
        query: ((text: string, params?: unknown[]) =>
          text === PG_TOP_STATEMENTS_SQL.extensionSchema
            ? Promise.resolve({ rows: [{ schema }] })
            : client.query(text, params)) as unknown as Client['query'],
      };
      const res = await readTopStatementsWithin(fixture, 200, 'localhost');
      expect(res.state).toBe('ok');
      if (res.state === 'ok') {
        expect(res.byTotalTime.map((r) => r.query)).toEqual(['SELECT 1']);
      }
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  it('a sampler that cannot connect writes its state and the CSV header, and never throws', async () => {
    const dir = out();
    const sampler = await startDbSampler({
      directUrl: `postgresql://u:${SECRET}@127.0.0.1:1/db`,
      outDir: dir,
      intervalMs: 50,
    });
    const res = await sampler.stop();
    expect(res.rows).toBe(0);
    expect(readFileSync(join(dir, 'db-samples.csv'), 'utf8')).toMatch(/^at,backends/);
    const state = readFileSync(join(dir, 'db-samples.state.json'), 'utf8');
    expect(JSON.parse(state).state).toBe('failed');
    expect(state).not.toContain(SECRET);
  });
});

describe('the capture writes nothing', () => {
  it('no reset, INSERT, UPDATE or DELETE appears anywhere in loadtest/capture/', () => {
    const dir = join(ROOT, 'loadtest/capture');
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8');
      for (const word of ['pg_stat_statements_reset', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(src, `${f} contains ${word}`).not.toContain(word);
      }
    }
  });
});

describe('the Neon reads', () => {
  it('without LOADTEST_NEON_API_KEY the endpoint reading is unmeasured', async () => {
    const r = await readEndpointState({ env: {}, project: 'p', branchId: 'br' });
    expect(r).toMatchObject({ state: 'unmeasured', reason: 'LOADTEST_NEON_API_KEY is not set' });
  });

  it('goes to LOADTEST_NEON_API_URL when set, and reads the endpoint fields', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return new Response(
        JSON.stringify({
          endpoints: [
            {
              id: 'ep-quiet-sky-123456',
              type: 'read_write',
              current_state: 'active',
              autoscaling_limit_min_cu: 0.25,
              autoscaling_limit_max_cu: 4,
              host: 'ep-quiet-sky-123456.us-east-2.aws.neon.tech',
            },
          ],
        }),
      );
    }) as unknown as typeof fetch;
    const r = await readEndpointState({
      env: {
        LOADTEST_NEON_API_KEY: 'neon-key',
        LOADTEST_NEON_API_URL: 'http://stub.local/api/v2/',
      },
      project: 'proj-1',
      branchId: 'br-1',
      fetchImpl,
    });
    expect(seen).toEqual([
      {
        url: 'http://stub.local/api/v2/projects/proj-1/branches/br-1/endpoints',
        auth: 'Bearer neon-key',
      },
    ]);
    expect(r).toMatchObject({
      state: 'ok',
      endpoints: [
        {
          id: 'ep-quiet-sky-123456',
          current_state: 'active',
          autoscaling_limit_min_cu: 0.25,
          autoscaling_limit_max_cu: 4,
        },
      ],
    });
    expect(NEON_API_DEFAULT).toBe('https://console.neon.tech/api/v2');
  });

  it('an API refusal is unmeasured, with the status and never the key', async () => {
    const fetchImpl = (async () => new Response('no', { status: 401 })) as unknown as typeof fetch;
    const r = await readEndpointState({
      env: { LOADTEST_NEON_API_KEY: 'neon-key' },
      project: 'p',
      branchId: 'b',
      fetchImpl,
    });
    expect(r).toMatchObject({ state: 'unmeasured', reason: 'the Neon API answered 401' });
  });

  it('passes the branch positionally, never --pooled, and refuses a pooler host', async () => {
    const calls: string[][] = [];
    const stub =
      (url: string): Exec =>
      async (bin, args) => {
        calls.push([bin, ...args]);
        return { code: 0, stdout: `${url}\n`, stderr: '' };
      };
    const direct = `postgresql://motir_app:${SECRET}@ep-a.us-east-2.aws.neon.tech/motir`;
    expect(await resolveBranchDirectUrl(stub(direct), 'proj', 'loadtest')).toBe(direct);
    expect(calls[0]).toEqual([
      'neonctl',
      'connection-string',
      'loadtest',
      '--project-id',
      'proj',
      '--role-name',
      'motir_app',
    ]);
    expect(calls.flat()).not.toContain('--pooled');
    expect(calls.flat()).not.toContain('--branch');
    await expect(
      resolveBranchDirectUrl(stub(direct.replace('ep-a.', 'ep-a-pooler.')), 'proj', 'loadtest'),
    ).rejects.toThrow(/pooler host/);
    expect(() => assertDirectUrl('not a url')).toThrow(/not a URL/);
  });
});

describe('the pg_stat_statements snapshots', () => {
  it('writes the readout as-is, a non-ok state included', async () => {
    const dir = out();
    await snapshotPgss({
      name: 'pgss-before',
      directUrl: 'postgresql://x@h/db',
      outDir: dir,
      read: async () => ({ state: 'extension_not_loaded', detail: 'no preload' }),
    });
    expect(JSON.parse(readFileSync(join(dir, 'pgss-before.json'), 'utf8'))).toEqual({
      state: 'extension_not_loaded',
      detail: 'no preload',
    });
  });

  it('a failed read writes its state file, without the URL', async () => {
    const dir = out();
    const url = `postgresql://motir_app:${SECRET}@ep-a.us-east-2.aws.neon.tech/motir`;
    await snapshotPgss({
      name: 'pgss-after',
      directUrl: url,
      outDir: dir,
      read: async () => {
        throw new Error(`could not connect to ${url}`);
      },
    });
    const state = readFileSync(join(dir, 'pgss-after.state.json'), 'utf8');
    expect(JSON.parse(state).state).toBe('failed');
    expect(state).not.toContain(SECRET);
    expect(readFileSync(join(dir, 'pgss-after.json'), 'utf8')).not.toContain(SECRET);
  });

  it('redact masks secrets and URL credentials', () => {
    expect(redact(`postgres://a:${SECRET}@h/db and key-1`, ['key-1'])).toBe(
      'postgres://[redacted]@h/db and [redacted]',
    );
  });
});
