import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-5614 — the `supersede_awaiting_pull_request_merge_gates` forward data
// migration (Bug MOTIR-5603; `approval-gates.md` §8's SECOND AMENDMENT).
//
// MOTIR-5611 stopped raising the per-pull-request merge gate; this migration closes
// the rows it already made, so nobody is left holding a decision that nothing can
// decide. The suite runs the shipped SQL against real Postgres and pins the
// predicate from BOTH sides — it supersedes exactly the awaiting merge gates, and
// it leaves a decided one and another kind's awaiting gate alone — with the blast
// radius asserted as a NUMBER rather than assumed.

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260916000000_supersede_awaiting_pull_request_merge_gates/migration.sql',
  ),
  'utf8',
);

/** Apply it exactly as `migrate deploy` would, and answer how many rows it wrote. */
const runMigration = () => adminDb.$executeRawUnsafe(MIGRATION_SQL);

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Kind = 'pull_request_merge' | 'design_result';

async function gate(kind: Kind, state: 'awaiting' | 'approved', subjectId: string) {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: `Holder of ${subjectId}` },
    fx.ctx,
  );
  return adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: item.id,
      kind,
      subjectId,
      state,
      ...(state === 'approved'
        ? { decidedById: fx.ownerId, decidedAt: new Date('2026-09-01T10:00:00.000Z') }
        : {}),
    },
  });
}

const row = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });

describe('the awaiting merge gates, and only those', () => {
  it('supersedes the awaiting merge gate; the decided one and another kind are untouched', async () => {
    const awaitingMerge = await gate('pull_request_merge', 'awaiting', 'pr-1');
    const decidedMerge = await gate('pull_request_merge', 'approved', 'pr-2');
    const awaitingDesign = await gate('design_result', 'awaiting', 'ev-1');

    // The blast radius is a number, not a hope.
    expect(await runMigration()).toBe(1);

    expect((await row(awaitingMerge.id)).state).toBe('superseded');
    // ⚠️ A DECIDED ROW IS AN AUDIT RECORD OF A MERGE THAT REALLY HAPPENED.
    expect(await row(decidedMerge.id)).toMatchObject({
      state: 'approved',
      decidedAt: new Date('2026-09-01T10:00:00.000Z'),
    });
    expect((await row(awaitingDesign.id)).state).toBe('awaiting');
  });

  it('is idempotent: a second run finds nothing awaiting and writes zero rows', async () => {
    const awaitingMerge = await gate('pull_request_merge', 'awaiting', 'pr-1');
    const awaitingDesign = await gate('design_result', 'awaiting', 'ev-1');

    expect(await runMigration()).toBe(1);
    const afterFirst = await row(awaitingMerge.id);

    expect(await runMigration()).toBe(0);

    // Not merely "still superseded": the row was not rewritten at all.
    expect(await row(awaitingMerge.id)).toEqual(afterFirst);
    expect((await row(awaitingDesign.id)).state).toBe('awaiting');
  });

  it('a gate raised while the migration was mid-deploy is closed by the SECOND run', async () => {
    // Two deploys of the same file are the realistic recovery path, so the
    // idempotence above must not be idempotence about the WORLD.
    expect(await runMigration()).toBe(0);
    await gate('pull_request_merge', 'awaiting', 'pr-late');
    expect(await runMigration()).toBe(1);
  });
});

describe('the enum member the superseded rows still reference', () => {
  it('`pull_request_merge` survives the migration — read from the catalog, not the schema file', async () => {
    await gate('pull_request_merge', 'awaiting', 'pr-1');
    await runMigration();

    const labels = await adminDb.$queryRawUnsafe<Array<{ enumlabel: string }>>(
      `SELECT e.enumlabel
         FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'approval_gate_kind'
        ORDER BY e.enumsortorder`,
    );

    // ⚠️ KEPT ON PURPOSE (decision 8): the rows just superseded reference it, so
    // dropping the member would orphan exactly what this migration wrote. The
    // kind retires at the registry tier instead (MOTIR-5616).
    expect(labels.map((l) => l.enumlabel)).toContain('pull_request_merge');
  });

  it('the migration says so where the next editor will read it', () => {
    expect(MIGRATION_SQL).toMatch(/ENUM MEMBER `pull_request_merge` IS DELIBERATELY KEPT/);
    expect(MIGRATION_SQL).toMatch(/MOTIR-5603/);
    expect(MIGRATION_SQL).toMatch(/SECOND AMENDMENT/);
    // The scope is stated so nobody widens it.
    expect(MIGRATION_SQL).toMatch(/state" = 'awaiting'/);
  });
});
