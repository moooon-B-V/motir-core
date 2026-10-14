import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exitCodeFor } from '../../scripts/pgTopStatements';
import { currentWorkerAdminUrl } from '../helpers/parallelDb';
import { readTopStatements, readTopStatementsWithin } from '../../scripts/pgTopStatementsQuery';

// MOTIR-8552 — the read against a real Postgres (the CI test database).
//
// The test database has no `pg_stat_statements`, and CI's Postgres does not
// preload its library (the parent story's assumption (c)), so the two non-ok
// states are the ones a real server can produce here. The `ok` shape is the unit
// test's, from a fixture.

const ROOT = join(__dirname, '..', '..');

function url(): string {
  const value = process.env['DATABASE_URL'];
  if (!value) throw new Error('DATABASE_URL is not set for the test worker');
  return value;
}

async function extensionPresent(client: Client): Promise<boolean> {
  const res = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'pg_stat_statements'`,
  );
  return res.rows[0]!.n > 0;
}

let client: Client;

beforeEach(async () => {
  // The owner: creating the extension needs privileges the runtime role lacks.
  client = new Client({ connectionString: currentWorkerAdminUrl() });
  await client.connect();
});

afterEach(async () => {
  // Whatever a case did, the database is left without the extension.
  expect(await extensionPresent(client)).toBe(false);
  await client.end();
});

describe('readTopStatements against the test Postgres', () => {
  it('returns extension_not_installed where the extension is absent, and the CLI exits 2', async () => {
    expect(await extensionPresent(client)).toBe(false);
    const result = await readTopStatements(url(), 5);
    expect(result).toEqual({ state: 'extension_not_installed' });
    expect(exitCodeFor(result)).toBe(2);

    const cli = spawnSync(
      join(ROOT, 'node_modules', '.bin', 'tsx'),
      ['--tsconfig', 'tsconfig.node.json', 'scripts/pg-top-statements.ts'],
      {
        cwd: ROOT,
        env: { ...process.env, DATABASE_URL_UNPOOLED: url() },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    expect(cli.status).toBe(2);
    expect(cli.stderr.trim().split('\n')).toHaveLength(1);
    expect(cli.stderr).toContain('pg_stat_statements is not installed');
  }, 90_000);

  it('returns extension_not_loaded when the extension exists but its library is not preloaded', async (ctx) => {
    await client.query('BEGIN');
    try {
      try {
        await client.query('CREATE EXTENSION pg_stat_statements');
      } catch (err) {
        const reason = `cannot install pg_stat_statements on this server: ${(err as Error).message}`;
        console.warn(`[pg-top-statements-query.test] skipped: ${reason}`);
        ctx.skip(reason);
        return;
      }
      const preloaded = await client.query<{ v: string }>(
        `SELECT current_setting('shared_preload_libraries') AS v`,
      );
      if (preloaded.rows[0]!.v.includes('pg_stat_statements')) {
        const reason = 'this server preloads pg_stat_statements, so it cannot be not-loaded';
        console.warn(`[pg-top-statements-query.test] skipped: ${reason}`);
        ctx.skip(reason);
        return;
      }
      const result = await readTopStatementsWithin(client, 5, 'test-host');
      expect(result.state).toBe('extension_not_loaded');
      expect(result.state === 'extension_not_loaded' && result.detail).toMatch(
        /shared_preload_libraries/,
      );
      expect(exitCodeFor(result)).toBe(3);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
