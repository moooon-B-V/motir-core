import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { createTestWorkItem, makeWorkItemFixture } from '../../fixtures';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// Subtask 6.14.3 — the epic-privacy flag `publicChildrenHidden` on `work_item`
// (per docs/decisions/epic-privacy.md §1). This card is the COLUMN + migration +
// regenerated Prisma types ONLY — no enforcement (6.14.4), no UI (6.14.5/6),
// no admin write (6.14.7). So this test pins exactly the schema contract:
//   • the column defaults to the non-private value (false) on create — for an
//     epic AND for a non-epic (it is stored regardless of kind; meaningful only
//     for an epic on a public project, ADR §2, but the no-op-elsewhere rule is a
//     read-layer concern, not a column default);
//   • it round-trips true→false on an epic-kind item through the repository.
// Everything runs against the REAL Postgres (Yue's no-mocks rule).

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('work_item.publicChildrenHidden — the epic-privacy flag (6.14.3)', () => {
  it('defaults to false on a newly-created epic', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Public roadmap' });
    expect(epic.publicChildrenHidden).toBe(false);
  });

  it('defaults to false on a non-epic item too (stored regardless of kind)', async () => {
    const fx = await makeWorkItemFixture();
    const task = await createTestWorkItem(fx, { kind: 'task', title: 'Wire the form' });
    expect(task.publicChildrenHidden).toBe(false);
  });

  it('round-trips true→false on an epic through the repository', async () => {
    const fx = await makeWorkItemFixture();
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Internal-only epic' });

    const hidden = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemRepository.update(epic.id, { publicChildrenHidden: true }, tx),
    );
    expect(hidden.publicChildrenHidden).toBe(true);

    // read back through a fresh read so we assert the persisted value, not the
    // in-memory return of the update
    const reread = await adminDb.workItem.findUniqueOrThrow({ where: { id: epic.id } });
    expect(reread.publicChildrenHidden).toBe(true);

    const unhidden = await withWorkspaceContext(fx.ctx, (tx) =>
      workItemRepository.update(epic.id, { publicChildrenHidden: false }, tx),
    );
    expect(unhidden.publicChildrenHidden).toBe(false);
  });
});
