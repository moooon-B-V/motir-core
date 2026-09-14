import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrMergeMode } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// MOTIR-4880 · MOTIR-5177 — the merge policy moves from `Workspace` to `Project`,
// and the BACKFILL is what makes the move safe (`approval-gates.md` §7 and its
// 2026-09-13 amendment).
//
// `Project.prMergeMode` defaults to `manual`, which is a FLOOR. On its own it would
// set every project under a workspace that holds `auto` to `manual` — a setting
// flipping itself on the day of a deploy. So the migration copies each project's
// workspace value forward, and then STAMPS `prMergeModeDecidedAt` on every project
// that is already established, so the establishment default (MOTIR-5178) can never
// overwrite the carried value later.
//
// ⚠️ THIS FILE EXECUTES THE MIGRATION'S OWN SQL, READ FROM THE MIGRATION — the
// precedent is `acceptance-video-project-tier-backfill.test.ts`. A retyped UPDATE
// would stay green while the shipped statement drifted.
//
// Real Postgres, `adminDb` for fixtures and direct-DB reads (the shipped rule in
// `tests/helpers/adminDb.ts`). Two workspaces that DISAGREE, because with one
// workspace a blanket write and a per-project copy look identical.

const MIGRATION = path.join(
  process.cwd(),
  'prisma/migrations/20260913120000_project_pr_merge_mode/migration.sql',
);

/** The migration's top-level statements, comments stripped, in file order. The two
 *  `DO $$ … $$` blocks carry inner semicolons, so they are dropped before splitting
 *  — they rename and rebuild the type, and have already run on the test database. */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .replace(/DO \$\$[\s\S]*?END \$\$;/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The two UPDATEs the deploy runs, in order — extracted, never retyped. */
function backfillStatements(): { copy: string; stamp: string } {
  const updates = migrationStatements().filter((s) => /^UPDATE\b/i.test(s));
  expect(
    updates,
    'the migration must carry EXACTLY TWO UPDATEs — the copy-forward, then the stamp',
  ).toHaveLength(2);
  return { copy: updates[0]!, stamp: updates[1]! };
}

let seq = 0;

/** A workspace holding `mode`, with one project under it. */
async function seedTenant(tag: string, mode: PrMergeMode) {
  const n = seq++;
  const org = await adminDb.organization.create({
    data: { name: `Org ${tag}`, slug: `pmm-org-${tag}-${n}` },
  });
  const workspace = await adminDb.workspace.create({
    data: { name: `WS ${tag}`, slug: `pmm-ws-${tag}-${n}`, organizationId: org.id },
  });
  // The workspace's value is written by SQL rather than through the generated
  // client: the column has no application writer after MOTIR-4880, and MOTIR-5505
  // `@ignore`s the field — while this file, which executes the migration's
  // copy-forward FROM that column, still needs it set.
  await adminDb.$executeRaw`
    UPDATE workspace SET "subtaskPrMergeMode" = ${mode}::pr_merge_mode WHERE id = ${workspace.id}`;
  const project = await seedProject(workspace.id, `${tag}${n}`);
  return { workspace, project };
}

async function seedProject(workspaceId: string, tag: string) {
  return adminDb.project.create({
    data: {
      name: `Project ${tag}`,
      slug: `pmm-p-${tag}`,
      identifier: `PMM${tag.toUpperCase().replace(/[^A-Z0-9]/g, '')}`,
      workspaceId,
    },
  });
}

async function seedRow(
  project: { id: string; workspaceId: string },
  state: 'proposed' | 'created' | 'connected' | 'skipped',
) {
  return adminDb.projectRepo.create({
    data: {
      workspaceId: project.workspaceId,
      projectId: project.id,
      role: 'web',
      name: `repo-${seq++}`,
      seedSource: 'platform-starter',
      state,
      position: `a${seq}`,
    },
  });
}

async function stored(projectId: string) {
  return adminDb.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { prMergeMode: true, prMergeModeDecidedAt: true },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('Project.prMergeMode inherits its workspace value', () => {
  it('copies each workspace value forward — auto stays auto, manual stays manual', async () => {
    const auto = await seedTenant('auto', 'auto');
    const manual = await seedTenant('manual', 'manual');

    // Both start at the FLOOR, which is the pre-backfill state.
    expect((await stored(auto.project.id)).prMergeMode).toBe('manual');

    await adminDb.$executeRawUnsafe(backfillStatements().copy);

    expect(
      (await stored(auto.project.id)).prMergeMode,
      'a project under a workspace holding auto must not come back manual',
    ).toBe('auto');
    expect((await stored(manual.project.id)).prMergeMode).toBe('manual');
  });

  it('is per-project: every project under one workspace takes its value', async () => {
    const { workspace, project } = await seedTenant('multi', 'auto');
    const second = await seedProject(workspace.id, `multib${seq++}`);

    await adminDb.$executeRawUnsafe(backfillStatements().copy);

    expect((await stored(project.id)).prMergeMode).toBe('auto');
    expect((await stored(second.id)).prMergeMode).toBe('auto');
  });

  it('stamps an ESTABLISHED project as decided, and leaves an unestablished one open', async () => {
    const { workspace, project: established } = await seedTenant('est', 'auto');
    await seedRow(established, 'connected');
    const pending = await seedProject(workspace.id, `pend${seq++}`);
    await seedRow(pending, 'proposed');
    const empty = await seedProject(workspace.id, `empty${seq++}`);
    const skipped = await seedProject(workspace.id, `skip${seq++}`);
    await seedRow(skipped, 'skipped');

    const { copy, stamp } = backfillStatements();
    await adminDb.$executeRawUnsafe(copy);
    await adminDb.$executeRawUnsafe(stamp);

    expect(
      (await stored(established.id)).prMergeModeDecidedAt,
      'an established project never meets an establishment event, so its carried value is decided',
    ).not.toBeNull();
    expect((await stored(skipped.id)).prMergeModeDecidedAt).not.toBeNull();
    expect(
      (await stored(pending.id)).prMergeModeDecidedAt,
      'a project still establishing must be left for the provenance default',
    ).toBeNull();
    expect((await stored(empty.id)).prMergeModeDecidedAt).toBeNull();
  });

  it('re-running the stamp moves nothing that is already decided', async () => {
    const { project } = await seedTenant('rerun', 'manual');
    await seedRow(project, 'created');
    const { stamp } = backfillStatements();
    await adminDb.$executeRawUnsafe(stamp);
    const first = (await stored(project.id)).prMergeModeDecidedAt;

    await adminDb.$executeRawUnsafe(stamp);

    expect((await stored(project.id)).prMergeModeDecidedAt).toEqual(first);
  });

  it('the migration renames the type in place, then rebuilds it without `review_on_fail`', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(sql).toMatch(/ALTER TYPE "subtask_pr_merge_mode" RENAME TO "pr_merge_mode"/);
    // The retirement maps the retired value to `manual` BEFORE the type swap, so a
    // workspace holding it keeps the behaviour it already had.
    const retire = sql.indexOf(`SET "subtaskPrMergeMode" = 'manual'`);
    expect(retire).toBeGreaterThan(sql.indexOf('RENAME TO "pr_merge_mode"'));
    expect(retire).toBeLessThan(
      sql.indexOf(`CREATE TYPE "pr_merge_mode_v2" AS ENUM ('auto', 'manual')`),
    );
    // …and it all happens before the project column is added, so one column moves.
    expect(sql.indexOf('DROP TYPE "pr_merge_mode"')).toBeLessThan(
      sql.indexOf('ALTER TABLE "project" ADD COLUMN'),
    );
  });

  it('the deployed type carries exactly the two live members', async () => {
    const rows = await adminDb.$queryRawUnsafe<Array<{ enumlabel: string }>>(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'pr_merge_mode' ORDER BY e.enumsortorder`,
    );
    expect(rows.map((r) => r.enumlabel)).toEqual(['auto', 'manual']);
  });
});

describe('projectRepository merge-mode leaf', () => {
  it('reads the floor as undecided, and a write is read back stamped', async () => {
    const { project } = await seedTenant('leaf', 'manual');

    expect(await projectRepository.findPrMergeMode(project.id, adminDb)).toEqual({
      prMergeMode: 'manual',
      prMergeModeDecidedAt: null,
    });

    const at = new Date('2026-09-13T12:00:00.000Z');
    await adminDb.$transaction((tx) =>
      projectRepository.setPrMergeMode(project.id, 'auto', at, tx),
    );

    expect(await projectRepository.findPrMergeMode(project.id, adminDb)).toEqual({
      prMergeMode: 'auto',
      prMergeModeDecidedAt: at,
    });
  });

  it('answers null for a project that does not exist', async () => {
    expect(await projectRepository.findPrMergeMode('no-such-project', adminDb)).toBeNull();
  });
});
