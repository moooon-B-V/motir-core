import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { REPO_ROOT } from '../helpers/importGraph';

// The auto-translate SUBSTRATE (Story MOTIR-7738 · MOTIR-8825) against a REAL
// Postgres: `project.auto_translate_work_content` and the
// `project_auto_translate_change` trail. Nothing writes either yet — the service
// card does — so this file drives them directly. Like the content-language
// substrate it is twin to, "off" is a property of the column's DEFAULT and of the
// migration doing NO backfill, so both are asserted against the catalog and the
// migration file itself, not inferred from an insert.

const MIGRATION_DIR = path.join(REPO_ROOT, 'prisma', 'migrations');

function migrationSql(): string {
  const dir = readdirSync(MIGRATION_DIR).find((d) => d.endsWith('_project_auto_translate_switch'));
  if (!dir) throw new Error('no *_project_auto_translate_switch migration');
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

describe('Project.autoTranslateWorkContent', () => {
  it('is a required column that defaults to false, read from the catalog', async () => {
    const rows = await adminDb.$queryRaw<
      { column_default: string | null; is_nullable: 'YES' | 'NO'; data_type: string }[]
    >`SELECT column_default, is_nullable, data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'project'
        AND column_name = 'auto_translate_work_content'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      is_nullable: 'NO',
      column_default: 'false',
      data_type: 'boolean',
    });
  });

  it('is added by exactly one ADD COLUMN … NOT NULL DEFAULT false, with no UPDATE, DROP or rename', () => {
    const sql = statements();
    const adds = sql.match(/ADD COLUMN\s+"auto_translate_work_content"[^;]*;/g) ?? [];
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatch(/BOOLEAN NOT NULL DEFAULT false/);
    expect(sql).not.toMatch(/^\s*UPDATE\s/im);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
  });

  it('reads false for a project written without a value', async () => {
    const fx = await makeWorkItemFixture();
    const project = await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } });
    expect(project.autoTranslateWorkContent).toBe(false);
  });

  it('reads false for a row that was already there when the column was added', async () => {
    // Replay the ADD COLUMN on a scratch table holding a pre-existing row: the
    // default alone must give it false, with no second statement.
    await adminDb.$executeRawUnsafe('CREATE TEMP TABLE t_pre (id int PRIMARY KEY)');
    await adminDb.$executeRawUnsafe('INSERT INTO t_pre VALUES (1)');
    await adminDb.$executeRawUnsafe(
      'ALTER TABLE t_pre ADD COLUMN "auto_translate_work_content" BOOLEAN NOT NULL DEFAULT false',
    );
    const rows = await adminDb.$queryRaw<
      { auto_translate_work_content: boolean }[]
    >`SELECT auto_translate_work_content FROM t_pre`;
    expect(rows[0]!.auto_translate_work_content).toBe(false);
    await adminDb.$executeRawUnsafe('DROP TABLE t_pre');
  });
});

describe('ProjectAutoTranslateChange', () => {
  async function seed() {
    const fx = await makeWorkItemFixture();
    const actor = await adminDb.user.create({
      data: { email: 'flip@example.com', name: 'Flip', emailVerified: true },
    });
    return { fx, actor };
  }

  it('accepts a who / from / to / when row and reads all four back', async () => {
    const { fx, actor } = await seed();
    const before = new Date();
    const row = await adminDb.projectAutoTranslateChange.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        changedByUserId: actor.id,
        fromEnabled: false,
        toEnabled: true,
      },
    });
    const back = await adminDb.projectAutoTranslateChange.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(back).toMatchObject({
      changedByUserId: actor.id,
      fromEnabled: false,
      toEnabled: true,
    });
    expect(back.changedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
  });

  it('is removed with its project', async () => {
    const { fx, actor } = await seed();
    const row = await adminDb.projectAutoTranslateChange.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        changedByUserId: actor.id,
        fromEnabled: false,
        toEnabled: true,
      },
    });
    await adminDb.project.delete({ where: { id: fx.projectId } });
    expect(await adminDb.projectAutoTranslateChange.count({ where: { id: row.id } })).toBe(0);
  });

  it('keeps the row with a null actor when the actor is deleted', async () => {
    const { fx, actor } = await seed();
    const row = await adminDb.projectAutoTranslateChange.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        changedByUserId: actor.id,
        fromEnabled: true,
        toEnabled: false,
      },
    });
    await adminDb.user.delete({ where: { id: actor.id } });
    const back = await adminDb.projectAutoTranslateChange.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(back.changedByUserId).toBeNull();
    expect([back.fromEnabled, back.toEnabled]).toEqual([true, false]);
  });

  it('admits a no-op row (from = to): the service decides whether to write one', async () => {
    const { fx } = await seed();
    await expect(
      adminDb.projectAutoTranslateChange.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          fromEnabled: false,
          toEnabled: false,
        },
      }),
    ).resolves.toBeTruthy();
  });

  it('is under forced row-level security with the project-scoped policy pair', async () => {
    const cls = await adminDb.$queryRaw<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE relname = 'project_auto_translate_change' AND relkind = 'r'`;
    expect(cls).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);

    const policies = await adminDb.$queryRaw<
      {
        policyname: string;
        permissive: string;
        cmd: string;
        qual: string;
        with_check: string | null;
      }[]
    >`SELECT policyname, permissive, cmd, qual, with_check FROM pg_policies
      WHERE tablename = 'project_auto_translate_change' ORDER BY policyname`;
    expect(policies).toHaveLength(2);
    const all = policies.find((p) => p.cmd === 'ALL')!;
    expect(all.permissive).toBe('PERMISSIVE');
    expect(all.qual).toContain('app.workspace_id');
    expect(all.with_check).toContain('app.workspace_id');
    const narrow = policies.find((p) => p.cmd === 'SELECT')!;
    expect(narrow.permissive).toBe('RESTRICTIVE');
    expect(narrow.qual).toContain('app.project_id');
  });

  it("a workspace-bound read returns that workspace's rows and cannot see another's", async () => {
    const a = await seed();
    const b = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    await adminDb.projectAutoTranslateChange.create({
      data: {
        workspaceId: a.fx.workspaceId,
        projectId: a.fx.projectId,
        changedByUserId: a.actor.id,
        fromEnabled: false,
        toEnabled: true,
      },
    });
    await adminDb.projectAutoTranslateChange.create({
      data: {
        workspaceId: b.workspaceId,
        projectId: b.projectId,
        fromEnabled: false,
        toEnabled: true,
      },
    });
    // The true population differs from the bound view, so the policy is measured.
    expect(await adminDb.projectAutoTranslateChange.count()).toBe(2);

    const seen = await withWorkspaceContext(
      { userId: a.actor.id, workspaceId: a.fx.workspaceId },
      (tx) => tx.projectAutoTranslateChange.findMany(),
    );
    expect(seen.map((r) => r.workspaceId)).toEqual([a.fx.workspaceId]);
  });
});
