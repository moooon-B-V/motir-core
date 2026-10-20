import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { REPO_ROOT } from '../helpers/importGraph';

// The agent auto-fix switch's column (Story MOTIR-8981 · MOTIR-9060) against a REAL
// Postgres. "Off" is a property of the column's DEFAULT and of the migration doing
// NO backfill, so both are asserted against the catalog and the migration file
// itself, not inferred from an insert.

const MIGRATION_DIR = path.join(REPO_ROOT, 'prisma', 'migrations');

function migrationSql(): string {
  const dir = readdirSync(MIGRATION_DIR).find((d) => d.endsWith('_project_agent_auto_fix_switch'));
  if (!dir) throw new Error('no *_project_agent_auto_fix_switch migration');
  return readFileSync(path.join(MIGRATION_DIR, dir, 'migration.sql'), 'utf8');
}

/** The migration with its `--` comments removed, so a word in prose cannot satisfy or fail a check. */
function statements(): string {
  return migrationSql()
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
}

beforeEach(async () => {
  await truncateAuthTables(adminDb);
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('Project.agentAutoFixEnabled', () => {
  it('is a required column that defaults to false, read from the catalog', async () => {
    const rows = await adminDb.$queryRaw<
      { column_default: string | null; is_nullable: 'YES' | 'NO'; data_type: string }[]
    >`SELECT column_default, is_nullable, data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'project'
        AND column_name = 'agent_auto_fix_enabled'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      is_nullable: 'NO',
      column_default: 'false',
      data_type: 'boolean',
    });
  });

  it('is added by exactly one ADD COLUMN … NOT NULL DEFAULT false, with no UPDATE, DROP or rename', () => {
    const sql = statements();
    const adds = sql.match(/ADD COLUMN\s+"agent_auto_fix_enabled"[^;]*;/g) ?? [];
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatch(/BOOLEAN NOT NULL DEFAULT false/);
    expect(sql).not.toMatch(/^\s*UPDATE\s/im);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
  });

  it('reads false for a project written without a value', async () => {
    const fx = await makeWorkItemFixture();
    const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(project.agentAutoFixEnabled).toBe(false);
  });

  it('reads false for a row that was already there when the column was added', async () => {
    // Replay the ADD COLUMN on a scratch table holding a pre-existing row: the
    // default alone must give it false, with no second statement.
    await adminDb.$executeRawUnsafe('CREATE TEMP TABLE t_pre (id int PRIMARY KEY)');
    await adminDb.$executeRawUnsafe('INSERT INTO t_pre VALUES (1)');
    await adminDb.$executeRawUnsafe(
      'ALTER TABLE t_pre ADD COLUMN "agent_auto_fix_enabled" BOOLEAN NOT NULL DEFAULT false',
    );
    const rows = await adminDb.$queryRaw<
      { agent_auto_fix_enabled: boolean }[]
    >`SELECT agent_auto_fix_enabled FROM t_pre`;
    expect(rows[0]!.agent_auto_fix_enabled).toBe(false);
    await adminDb.$executeRawUnsafe('DROP TABLE t_pre');
  });
});
