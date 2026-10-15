// THE DATABASE LOAD SAMPLE, EVERY 10 s (Story MOTIR-8538 · MOTIR-8683).
//
// One `pg.Client` on the branch's DIRECT endpoint — never the app's pool, never the
// pooler — reading, for the branch's database:
//   · backends: total, active, idle in transaction, waiting on a `Lock`, and
//     `max_connections` (its OWN backend excluded: `pid <> pg_backend_pid()`);
//   · `pg_stat_database`: xact_commit, xact_rollback, deadlocks, blks_read, blks_hit.
//
// READ-ONLY BY CONSTRUCTION: each sample is `BEGIN READ ONLY`, a
// `SET LOCAL statement_timeout`, one SELECT and a ROLLBACK. Every statement carries
// the shipped `PG_TOP_STATEMENTS_MARKER_COMMENT`, so the pg_stat_statements read
// (scripts/pgTopStatementsQuery.ts) excludes the sampler's own statements.
//
// ⚠️ It sees the direct endpoint only. The app connects through the pooler, so
// `active` against `max_connections` cannot show pooler saturation; the app-side
// pool reading (`db_pool_waiting_at_acquire`) is the likelier first limit.
//
// A sampler that cannot connect, or whose sample fails, writes
// `db-samples.state.json` naming the failure and never fails the run. The CSV
// header is written first, so the file exists whatever happens.

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from 'pg';
import { PG_TOP_STATEMENTS_MARKER_COMMENT as M } from '../../scripts/pgTopStatements';
import { redact } from './redact';

export const DB_SAMPLES_FILE = 'db-samples.csv';
export const DB_SAMPLES_STATE_FILE = 'db-samples.state.json';

/** Every statement the sampler sends, by name — the unit test reads them. */
export const DB_SAMPLER_SQL = {
  begin: `${M} BEGIN READ ONLY`,
  timeout: `${M} SET LOCAL statement_timeout = '5s'`,
  sample: `${M} SELECT
  (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()) AS backends,
  (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname = current_database() AND a.pid <> pg_backend_pid() AND a.state = 'active') AS active,
  (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname = current_database() AND a.pid <> pg_backend_pid() AND a.state = 'idle in transaction') AS idle_in_transaction,
  (SELECT count(*)::int FROM pg_stat_activity a WHERE a.datname = current_database() AND a.pid <> pg_backend_pid() AND a.wait_event_type = 'Lock') AS lock_waiting,
  current_setting('max_connections')::int AS max_connections,
  d.xact_commit, d.xact_rollback, d.deadlocks, d.blks_read, d.blks_hit
FROM pg_stat_database d WHERE d.datname = current_database()`,
  rollback: `${M} ROLLBACK`,
} as const;

export const DB_SAMPLE_COLUMNS = [
  'at',
  'backends',
  'active',
  'idle_in_transaction',
  'lock_waiting',
  'max_connections',
  'xact_commit',
  'xact_rollback',
  'deadlocks',
  'blks_read',
  'blks_hit',
] as const;

/** The part of a `pg.Client` the sampler uses — injected so a test can count statements. */
export interface SamplerClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<unknown>;
}

export interface DbSampler {
  stop(): Promise<{ rows: number; failures: number }>;
}

export async function startDbSampler(opts: {
  directUrl: string;
  outDir: string;
  intervalMs?: number;
  now?: () => Date;
  client?: (url: string) => SamplerClient;
}): Promise<DbSampler> {
  const intervalMs = opts.intervalMs ?? 10_000;
  const now = opts.now ?? (() => new Date());
  await mkdir(opts.outDir, { recursive: true });
  const csv = join(opts.outDir, DB_SAMPLES_FILE);
  await writeFile(csv, `${DB_SAMPLE_COLUMNS.join(',')}\n`);
  const failures: { at: string; error: string }[] = [];
  const fail = (err: unknown) =>
    failures.push({
      at: now().toISOString(),
      error: redact((err as Error).message, [opts.directUrl]),
    });

  let rows = 0;
  let client: SamplerClient | null = null;
  try {
    const c = (opts.client ?? ((url) => new Client({ connectionString: url })))(opts.directUrl);
    await c.connect();
    client = c;
  } catch (err) {
    fail(err);
  }

  let busy: Promise<void> = Promise.resolve();
  const sampleOnce = async () => {
    if (!client) return;
    try {
      await client.query(DB_SAMPLER_SQL.begin);
      try {
        await client.query(DB_SAMPLER_SQL.timeout);
        const r = (await client.query(DB_SAMPLER_SQL.sample)).rows[0] ?? {};
        const line = [
          now().toISOString(),
          ...DB_SAMPLE_COLUMNS.slice(1).map((k) => String(r[k] ?? '')),
        ];
        await appendFile(csv, `${line.join(',')}\n`);
        rows += 1;
      } finally {
        await client.query(DB_SAMPLER_SQL.rollback);
      }
    } catch (err) {
      fail(err);
    }
  };

  busy = sampleOnce();
  const timer = setInterval(() => {
    busy = busy.then(sampleOnce);
  }, intervalMs);

  return {
    async stop() {
      clearInterval(timer);
      await busy;
      await client?.end().catch(() => undefined);
      if (failures.length > 0) {
        await writeFile(
          join(opts.outDir, DB_SAMPLES_STATE_FILE),
          `${JSON.stringify({ state: rows > 0 ? 'partial' : 'failed', samples: rows, failures }, null, 2)}\n`,
        );
      }
      return { rows, failures: failures.length };
    },
  };
}
