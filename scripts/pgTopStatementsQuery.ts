import { Client } from 'pg';
import {
  hostOf,
  PG_TOP_STATEMENTS_MARKER,
  PG_TOP_STATEMENTS_MARKER_COMMENT as M,
  type StatementRow,
  type TopStatementsResult,
} from './pgTopStatements';

// THE `pg_stat_statements` READ (MOTIR-8552).
//
// ⚠️ ONE `pg.Client` ON THE DIRECT URL, NEVER `@/lib/db`. Importing the app's
// client would build the pooled runtime `pg.Pool` from `DATABASE_URL` — the very
// connection budget this epic measures — and the catalog views read here are not
// RLS-scoped, so the workspace context helpers would add nothing.
//
// ⚠️ READ-ONLY BY CONSTRUCTION: the whole read runs in `BEGIN READ ONLY` under a
// `SET LOCAL statement_timeout`, and ends in a rollback. It never enables the
// extension, never clears its counters and never writes. Every statement carries
// the marker comment, and every ranking excludes rows containing the marker, so
// the readout never ranks its own reads.

const STATEMENT_TIMEOUT = '15s';

/** Every statement this module sends, by name — asserted by the unit test. */
export const PG_TOP_STATEMENTS_SQL = {
  begin: `${M} BEGIN READ ONLY`,
  timeout: `${M} SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`,
  rollback: `${M} ROLLBACK`,
  extensionSchema: `${M} SELECT n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pg_stat_statements'`,
  answeredBy: `${M} SELECT current_database() AS database, current_setting('server_version') AS server_version, pg_postmaster_start_time() AS started_at, to_regclass('public._prisma_migrations') IS NOT NULL AS has_migrations`,
  latestMigration: `${M} SELECT migration_name, finished_at FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1`,
  infoExists: `${M} SELECT to_regclass($1) IS NOT NULL AS present`,
} as const;

export type RankingColumn = 'total_exec_time' | 'mean_exec_time' | 'calls';
export const RANKINGS: readonly RankingColumn[] = ['total_exec_time', 'mean_exec_time', 'calls'];

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** The view, schema-qualified — the extension need not live in `public`. */
export function statementsView(schema: string): string {
  return `${quoteIdent(schema)}.pg_stat_statements`;
}

/** A ranking: `$1` is the limit, `$2` the marker its own reads are excluded by. */
export function rankingSql(schema: string, orderBy: RankingColumn): string {
  return `${M} SELECT query, calls, total_exec_time, mean_exec_time, max_exec_time, rows FROM ${statementsView(schema)} WHERE strpos(query, $2) = 0 ORDER BY ${orderBy} DESC LIMIT $1`;
}

export function insufficientPrivilegeSql(schema: string): string {
  return `${M} SELECT count(*)::int AS n FROM ${statementsView(schema)} WHERE query = '<insufficient privilege>'`;
}

export function infoSql(schema: string): string {
  return `${M} SELECT stats_reset, dealloc FROM ${quoteIdent(schema)}.pg_stat_statements_info`;
}

/** The SQLSTATE PostgreSQL raises when the view is read without the library preloaded. */
const OBJECT_NOT_IN_PREREQUISITE_STATE = '55000';

type Queryable = Pick<Client, 'query'>;

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

interface RawRow {
  query: string;
  calls: string | number;
  total_exec_time: number;
  mean_exec_time: number;
  max_exec_time: number;
  rows: string | number;
}

function toRow(r: RawRow): StatementRow {
  return {
    query: r.query,
    calls: Number(r.calls),
    totalMs: Number(r.total_exec_time),
    meanMs: Number(r.mean_exec_time),
    maxMs: Number(r.max_exec_time),
    rows: Number(r.rows),
  };
}

/**
 * The read itself, on a client whose transaction the CALLER opened. Split from
 * {@link readTopStatements} so a test can run it inside its own rolled-back
 * transaction.
 */
export async function readTopStatementsWithin(
  client: Queryable,
  limit: number,
  host: string,
): Promise<TopStatementsResult> {
  const ext = await client.query<{ schema: string }>(PG_TOP_STATEMENTS_SQL.extensionSchema);
  const schema = ext.rows[0]?.schema;
  if (!schema) return { state: 'extension_not_installed' };

  const witness = await client.query<{
    database: string;
    server_version: string;
    started_at: Date | null;
    has_migrations: boolean;
  }>(PG_TOP_STATEMENTS_SQL.answeredBy);
  const w = witness.rows[0]!;
  let latestMigration: { name: string; finishedAt: string | null } | null = null;
  if (w.has_migrations) {
    const mig = await client.query<{ migration_name: string; finished_at: Date | null }>(
      PG_TOP_STATEMENTS_SQL.latestMigration,
    );
    const row = mig.rows[0];
    if (row) latestMigration = { name: row.migration_name, finishedAt: iso(row.finished_at) };
  }

  try {
    const rankings: StatementRow[][] = [];
    for (const column of RANKINGS) {
      const res = await client.query<RawRow>(rankingSql(schema, column), [
        limit,
        PG_TOP_STATEMENTS_MARKER,
      ]);
      rankings.push(res.rows.map(toRow));
    }
    const denied = await client.query<{ n: number }>(insufficientPrivilegeSql(schema));

    const infoPresent = await client.query<{ present: boolean }>(PG_TOP_STATEMENTS_SQL.infoExists, [
      `${quoteIdent(schema)}.pg_stat_statements_info`,
    ]);
    let statsReset: string | null = null;
    let dealloc: number | null = null;
    const infoAvailable = infoPresent.rows[0]?.present === true;
    if (infoAvailable) {
      const info = await client.query<{ stats_reset: Date | null; dealloc: string | number }>(
        infoSql(schema),
      );
      statsReset = iso(info.rows[0]?.stats_reset);
      dealloc = info.rows[0] ? Number(info.rows[0].dealloc) : null;
    }

    return {
      state: 'ok',
      readAt: new Date().toISOString(),
      limit,
      extensionSchema: schema,
      answeredBy: {
        host,
        database: w.database,
        serverVersion: w.server_version,
        computeStartedAt: iso(w.started_at),
        latestMigration,
      },
      coverage: {
        statsReset,
        dealloc,
        infoAvailable,
        insufficientPrivilegeRows: denied.rows[0]?.n ?? 0,
      },
      byTotalTime: rankings[0]!,
      byMeanTime: rankings[1]!,
      byCalls: rankings[2]!,
    };
  } catch (err) {
    if ((err as { code?: unknown }).code === OBJECT_NOT_IN_PREREQUISITE_STATE) {
      return { state: 'extension_not_loaded', detail: (err as Error).message };
    }
    throw err;
  }
}

/** Open one client on `url`, read in a read-only transaction, and close it. */
export async function readTopStatements(url: string, limit: number): Promise<TopStatementsResult> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(PG_TOP_STATEMENTS_SQL.begin);
    try {
      await client.query(PG_TOP_STATEMENTS_SQL.timeout);
      return await readTopStatementsWithin(client, limit, hostOf(url));
    } finally {
      await client.query(PG_TOP_STATEMENTS_SQL.rollback);
    }
  } finally {
    await client.end();
  }
}
