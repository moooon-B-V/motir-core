import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { importRepository } from '@/lib/repositories/importRepository';
import { importedIssueRepository } from '@/lib/repositories/importedIssueRepository';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture, createTestWorkItem } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';

// Repository-layer tests for the Story-7.16 issue-importer persistence leaves
// (MOTIR-939): importRepository + importedIssueRepository. Real Postgres (no
// mocks), per CLAUDE.md. These assert the repository CONTRACT — the single-op
// create/update reads/writes, the required-`tx` on writes (exercised inside a
// real `db.$transaction`), the idempotency lookup + upsert, the DB-level UNIQUE
// that makes a re-import a no-op/update (not a duplicate), the FOR UPDATE lock,
// and the onDelete semantics the schema declares (work_item CASCADE, import
// SET NULL). The mapping/persist ENGINE behaviour (dry-run, create-vs-update,
// P2002 translation) is MOTIR-941's suite; here we prove the leaves.

async function truncateAll(): Promise<void> {
  // imported_issue / import FK work_item + workspace (CASCADE), so the work_item
  // + workspace truncates carry them; mirror the sprints/work-item repo tests.
  await db.$executeRawUnsafe('TRUNCATE TABLE "work_item" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Insert an import RUN row through the repository's required-`tx` create. */
async function makeImport(
  fx: WorkItemFixture,
  overrides: Partial<{
    source: 'jira' | 'linear' | 'github' | 'plane' | 'csv';
    sourceRef: string;
  }> = {},
): Promise<string> {
  const row = await db.$transaction((tx) =>
    importRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        source: overrides.source ?? 'jira',
        sourceRef: overrides.sourceRef ?? 'ACME',
        createdById: fx.ownerId,
      },
      tx,
    ),
  );
  return row.id;
}

describe('importRepository', () => {
  it('create inserts a run with schema defaults (draft, zero counts) and findById reads it back', async () => {
    const fx = await makeWorkItemFixture();
    const created = await db.$transaction((tx) =>
      importRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          source: 'github',
          sourceRef: 'acme/repo',
          mapping: { status: { done: 'done' } },
          createdById: fx.ownerId,
        },
        tx,
      ),
    );

    expect(created.status).toBe('draft');
    expect(created.createdCount).toBe(0);
    expect(created.updatedCount).toBe(0);
    expect(created.skippedCount).toBe(0);
    expect(created.failedCount).toBe(0);
    expect(created.source).toBe('github');

    const read = await importRepository.findById(created.id);
    expect(read?.id).toBe(created.id);
    expect(read?.mapping).toEqual({ status: { done: 'done' } });
  });

  it('update patches status + the per-outcome counts in place', async () => {
    const fx = await makeWorkItemFixture();
    const id = await makeImport(fx);

    const updated = await db.$transaction((tx) =>
      importRepository.update(
        id,
        {
          status: 'partially_failed',
          createdCount: 7,
          updatedCount: 3,
          skippedCount: 1,
          failedCount: 2,
        },
        tx,
      ),
    );

    expect(updated.status).toBe('partially_failed');
    expect(updated.createdCount).toBe(7);
    expect(updated.updatedCount).toBe(3);
    expect(updated.skippedCount).toBe(1);
    expect(updated.failedCount).toBe(2);
  });

  it('createdBy is SET NULL when the initiator is deleted (import history survives)', async () => {
    const fx = await makeWorkItemFixture();
    const id = await makeImport(fx);

    // Deleting the user must not destroy the import run — createdBy SET NULL.
    await db.user.delete({ where: { id: fx.ownerId } });

    const read = await importRepository.findById(id);
    expect(read).not.toBeNull();
    expect(read?.createdById).toBeNull();
  });
});

describe('importedIssueRepository — the idempotency map', () => {
  async function seedWorkItem(fx: WorkItemFixture, title = 'Imported'): Promise<string> {
    const wi = await createTestWorkItem(fx, { kind: 'task', title });
    return wi.id;
  }

  it('upsert creates a mapping row and findBySourceId resolves it', async () => {
    const fx = await makeWorkItemFixture();
    const importId = await makeImport(fx);
    const workItemId = await seedWorkItem(fx);

    const mapped = await db.$transaction((tx) =>
      importedIssueRepository.upsert(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          source: 'jira',
          externalId: 'ACME-123',
          workItemId,
          importId,
          sourceHash: 'h1',
        },
        tx,
      ),
    );
    expect(mapped.workItemId).toBe(workItemId);

    const found = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'ACME-123');
    expect(found?.id).toBe(mapped.id);
    expect(found?.sourceHash).toBe('h1');

    // A different external id, same project/source, is a distinct lookup → null.
    const miss = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'ACME-999');
    expect(miss).toBeNull();
  });

  it('a re-import of the same (project, source, externalId) UPDATES the row — no duplicate', async () => {
    const fx = await makeWorkItemFixture();
    const firstImport = await makeImport(fx);
    const workItemId = await seedWorkItem(fx);

    const first = await db.$transaction((tx) =>
      importedIssueRepository.upsert(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          source: 'jira',
          externalId: 'ACME-1',
          workItemId,
          importId: firstImport,
          sourceHash: 'v1',
        },
        tx,
      ),
    );

    // Re-run: same identity, a NEW import run + a changed source hash.
    const secondImport = await makeImport(fx);
    const second = await db.$transaction((tx) =>
      importedIssueRepository.upsert(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          source: 'jira',
          externalId: 'ACME-1',
          workItemId,
          importId: secondImport,
          sourceHash: 'v2',
        },
        tx,
      ),
    );

    expect(second.id).toBe(first.id); // same row, updated in place
    expect(second.sourceHash).toBe('v2');
    expect(second.importId).toBe(secondImport);

    const count = await db.importedIssue.count({
      where: { projectId: fx.projectId, source: 'jira', externalId: 'ACME-1' },
    });
    expect(count).toBe(1);
  });

  it('the UNIQUE constraint enforces idempotency at the DB — a second INSERT of the same key throws', async () => {
    const fx = await makeWorkItemFixture();
    const workItemId = await seedWorkItem(fx);

    await db.importedIssue.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        source: 'linear',
        externalId: 'LIN-7',
        workItemId,
      },
    });

    // A raw second create of the SAME (project, source, externalId) must be
    // rejected by the unique index — proving the guarantee is at the DB, not
    // only in the application upsert. Prisma surfaces it as P2002.
    await expect(
      db.importedIssue.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          source: 'linear',
          externalId: 'LIN-7',
          workItemId,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    // Same externalId under a DIFFERENT source is a distinct identity → allowed.
    await expect(
      db.importedIssue.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          source: 'github',
          externalId: 'LIN-7',
          workItemId,
        },
      }),
    ).resolves.toBeTruthy();
  });

  it('lockBySourceId is a no-op when the row is absent, and locks it when present', async () => {
    const fx = await makeWorkItemFixture();
    const workItemId = await seedWorkItem(fx);

    // Absent row → no throw (a first-time import; the unique + P2002 catch
    // converge concurrent first inserts).
    await expect(
      db.$transaction((tx) =>
        importedIssueRepository.lockBySourceId(fx.projectId, 'csv', 'row-1', tx),
      ),
    ).resolves.toBeUndefined();

    await db.importedIssue.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        source: 'csv',
        externalId: 'row-1',
        workItemId,
      },
    });

    await expect(
      db.$transaction((tx) =>
        importedIssueRepository.lockBySourceId(fx.projectId, 'csv', 'row-1', tx),
      ),
    ).resolves.toBeUndefined();
  });

  it('two concurrent upserts of the same new key converge to exactly one row (unique race)', async () => {
    const fx = await makeWorkItemFixture();
    const workItemId = await seedWorkItem(fx);
    const input = {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      source: 'github' as const,
      externalId: 'acme/repo#42',
      workItemId,
    };

    const results = await Promise.allSettled([
      db.$transaction((tx) => importedIssueRepository.upsert({ ...input, sourceHash: 'a' }, tx)),
      db.$transaction((tx) => importedIssueRepository.upsert({ ...input, sourceHash: 'b' }, tx)),
    ]);

    // At least one must succeed; a loser may hit the unique race (P2002) — an
    // accepted outcome at this layer (MOTIR-941 translates it). What MUST hold:
    // exactly ONE mapping row exists — the DB never let the duplicate in.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    for (const r of results) {
      if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'P2002' });
    }
    const count = await db.importedIssue.count({
      where: { projectId: fx.projectId, source: 'github', externalId: 'acme/repo#42' },
    });
    expect(count).toBe(1);
  });

  it('deleting the work item CASCADES its mapping row away (so a re-import re-creates it)', async () => {
    const fx = await makeWorkItemFixture();
    const workItemId = await seedWorkItem(fx);
    await db.importedIssue.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        source: 'jira',
        externalId: 'ACME-5',
        workItemId,
      },
    });

    await db.workItem.delete({ where: { id: workItemId } });

    const found = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'ACME-5');
    expect(found).toBeNull();
  });

  it('deleting the import run SET NULLs importId but keeps the mapping row (idempotency survives)', async () => {
    const fx = await makeWorkItemFixture();
    const importId = await makeImport(fx);
    const workItemId = await seedWorkItem(fx);
    await db.importedIssue.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        source: 'jira',
        externalId: 'ACME-6',
        workItemId,
        importId,
      },
    });

    await db.import.delete({ where: { id: importId } });

    const found = await importedIssueRepository.findBySourceId(fx.projectId, 'jira', 'ACME-6');
    expect(found).not.toBeNull();
    expect(found?.importId).toBeNull();
    expect(found?.workItemId).toBe(workItemId);
  });
});
