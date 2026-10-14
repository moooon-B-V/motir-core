import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PG_TOP_STATEMENTS_MARKER } from '../../scripts/pgTopStatements';
import { PG_TOP_STATEMENTS_SQL, readTopStatementsWithin } from '../../scripts/pgTopStatementsQuery';
import { currentWorkerAdminUrl } from '../helpers/parallelDb';

// MOTIR-8556 — the `ok` read of `pg-top-statements` on a REAL Postgres.
//
// A real `pg_stat_statements` needs its library in `shared_preload_libraries`,
// which the CI Postgres does not set (`pg-top-statements-query.test.ts` proves the
// resulting `extension_not_loaded`). So this file builds the two views the read
// consumes — `pg_stat_statements` and `pg_stat_statements_info`, with the
// extension's column names — in a fixture schema, and answers the ONE question
// whose answer it cannot create, "which schema is the extension in?", with that
// schema. Every other statement — the rankings, their `$2` marker exclusion and
// `$1` limit, the privilege count, the info probe and read, the migration
// witness — runs as written against Postgres, inside a transaction that rolls
// back.

const SCHEMA = 'pgss_fixture_8556';

type Queryable = Parameters<typeof readTopStatementsWithin>[0];

let client: Client;

/** The admin client, except that the extension "lives" in the fixture schema. */
function withFixtureExtension(real: Client): Queryable {
  return {
    query: ((text: string, params?: unknown[]) =>
      text === PG_TOP_STATEMENTS_SQL.extensionSchema
        ? Promise.resolve({ rows: [{ schema: SCHEMA }] })
        : real.query(text, params)) as unknown as Client['query'],
  };
}

async function createStatementsView(rows: string): Promise<void> {
  await client.query(`CREATE SCHEMA ${SCHEMA}`);
  await client.query(
    `CREATE VIEW ${SCHEMA}.pg_stat_statements AS
       SELECT * FROM (VALUES ${rows})
       AS t(query, calls, total_exec_time, mean_exec_time, max_exec_time, rows)`,
  );
}

const ROWS = [
  // query, calls, total, mean, max, rows
  `('SELECT * FROM "work_item" WHERE id = $1'::text, 400::bigint, 900.0::float8, 2.25::float8, 40.0::float8, 400::bigint)`,
  `('UPDATE "plan" SET title = $1 WHERE id = $2', 10, 1500.0, 150.0, 900.0, 10)`,
  `('SELECT set_config($1, $2, true)', 5000, 300.0, 0.06, 4.0, 5000)`,
  `('<insufficient privilege>', 7, 50.0, 7.1, 9.0, 7)`,
  // The readout's own read: carries the marker, and must never be ranked.
  `('/* ${PG_TOP_STATEMENTS_MARKER} */ SELECT query FROM pg_stat_statements', 99999, 99999.0, 99999.0, 99999.0, 1)`,
].join(', ');

beforeEach(async () => {
  client = new Client({ connectionString: currentWorkerAdminUrl() });
  await client.connect();
  await client.query('BEGIN');
});

afterEach(async () => {
  await client.query('ROLLBACK');
  const left = await client.query(
    `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = '${SCHEMA}'`,
  );
  expect(left.rows[0].n).toBe(0);
  await client.end();
});

describe('readTopStatementsWithin on real views', () => {
  it('ranks three ways, honours the limit, excludes its own marker, and reads the coverage', async () => {
    await createStatementsView(ROWS);
    await client.query(
      `CREATE VIEW ${SCHEMA}.pg_stat_statements_info AS
         SELECT '2026-10-01T00:00:00Z'::timestamptz AS stats_reset, 12::bigint AS dealloc`,
    );

    const result = await readTopStatementsWithin(withFixtureExtension(client), 2, 'db.example');
    if (result.state !== 'ok') throw new Error(`expected ok, got ${result.state}`);

    expect(result.limit).toBe(2);
    expect(result.extensionSchema).toBe(SCHEMA);
    expect(result.byTotalTime.map((r) => r.totalMs)).toEqual([1500, 900]);
    expect(result.byMeanTime.map((r) => r.meanMs)).toEqual([150, 7.1]);
    expect(result.byCalls.map((r) => r.calls)).toEqual([5000, 400]);
    expect(result.byTotalTime[0]).toEqual({
      query: 'UPDATE "plan" SET title = $1 WHERE id = $2',
      calls: 10,
      totalMs: 1500,
      meanMs: 150,
      maxMs: 900,
      rows: 10,
    });
    // The marker row tops every column, so its absence is the exclusion working.
    for (const ranking of [result.byTotalTime, result.byMeanTime, result.byCalls]) {
      for (const row of ranking) expect(row.query).not.toContain(PG_TOP_STATEMENTS_MARKER);
    }

    expect(result.coverage).toEqual({
      statsReset: '2026-10-01T00:00:00.000Z',
      dealloc: 12,
      infoAvailable: true,
      insufficientPrivilegeRows: 1,
    });
    expect(result.answeredBy.host).toBe('db.example');
    expect(typeof result.answeredBy.database).toBe('string');
    expect(typeof result.answeredBy.serverVersion).toBe('string');
    expect(result.answeredBy.computeStartedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    // The test database is built by `prisma migrate deploy`, so it has a witness.
    expect(result.answeredBy.latestMigration?.name).toMatch(/^\d{14}_/);
  });

  it('with no pg_stat_statements_info view (pre-PG14): no reset, no dealloc, infoAvailable false', async () => {
    await createStatementsView(ROWS);
    const result = await readTopStatementsWithin(withFixtureExtension(client), 5, 'h');
    if (result.state !== 'ok') throw new Error(`expected ok, got ${result.state}`);
    expect(result.coverage).toEqual({
      statsReset: null,
      dealloc: null,
      infoAvailable: false,
      insufficientPrivilegeRows: 1,
    });
    expect(result.byCalls).toHaveLength(4);
  });

  it('an empty info view reads as no reset and no dealloc, never as zero', async () => {
    await createStatementsView(ROWS);
    await client.query(
      `CREATE VIEW ${SCHEMA}.pg_stat_statements_info AS
         SELECT NULL::timestamptz AS stats_reset, 0::bigint AS dealloc WHERE false`,
    );
    const result = await readTopStatementsWithin(withFixtureExtension(client), 5, 'h');
    if (result.state !== 'ok') throw new Error(`expected ok, got ${result.state}`);
    expect(result.coverage.infoAvailable).toBe(true);
    expect(result.coverage.statsReset).toBeNull();
    expect(result.coverage.dealloc).toBeNull();
  });

  it('a database with no _prisma_migrations table names no latest migration', async () => {
    await createStatementsView(ROWS);
    await client.query('ALTER TABLE public._prisma_migrations RENAME TO _prisma_migrations_8556');
    const result = await readTopStatementsWithin(withFixtureExtension(client), 5, 'h');
    if (result.state !== 'ok') throw new Error(`expected ok, got ${result.state}`);
    expect(result.answeredBy.latestMigration).toBeNull();
  });

  it('a migrations table with no finished, unrolled-back migration names none', async () => {
    await createStatementsView(ROWS);
    await client.query('UPDATE public._prisma_migrations SET rolled_back_at = now()');
    const result = await readTopStatementsWithin(withFixtureExtension(client), 5, 'h');
    if (result.state !== 'ok') throw new Error(`expected ok, got ${result.state}`);
    expect(result.answeredBy.latestMigration).toBeNull();
  });

  it('a failure that is not "library not loaded" is thrown, not reported as a state', async () => {
    // A view missing a ranked column: Postgres raises 42703, not 55000.
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`CREATE VIEW ${SCHEMA}.pg_stat_statements AS SELECT 'x'::text AS query`);
    await client.query('SAVEPOINT before_read');
    await expect(
      readTopStatementsWithin(withFixtureExtension(client), 5, 'h'),
    ).rejects.toMatchObject({ code: '42703' });
    await client.query('ROLLBACK TO SAVEPOINT before_read');
  });
});
