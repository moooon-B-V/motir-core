import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { truncateAuthTables } from '../helpers/db';
import { makeWorkItemFixture, createTestWorkItem } from '../fixtures';

// Subtask 7.10.6 / MOTIR-894 — unit coverage for `workItemsService.setCiState`,
// the CI verification-signal write the GitHub check webhook drives. Real Postgres
// (the motir-core convention). Covers all branches: the write, the idempotent
// no-op (same value), the null-clear, and the tenant gate (a cross-workspace id
// is a 404, never a leak — mirrors `updateStatus`).

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

async function ciStateOf(id: string): Promise<string | null> {
  const row = await db.workItem.findUnique({ where: { id } });
  return row!.ciState;
}

describe('workItemsService.setCiState (MOTIR-894)', () => {
  it('sets the passing / failing signal and clears it back to null', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'A task' });
    expect(await ciStateOf(item.id)).toBeNull();

    await workItemsService.setCiState(item.id, 'passing', fx.ctx);
    expect(await ciStateOf(item.id)).toBe('passing');

    await workItemsService.setCiState(item.id, 'failing', fx.ctx);
    expect(await ciStateOf(item.id)).toBe('failing');

    await workItemsService.setCiState(item.id, null, fx.ctx);
    expect(await ciStateOf(item.id)).toBeNull();
  });

  it('is an idempotent no-op when the value is unchanged', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'A task' });
    await workItemsService.setCiState(item.id, 'passing', fx.ctx);
    const before = await db.workItem.findUnique({ where: { id: item.id } });

    // Same value again — no write (the updatedAt stays put).
    await workItemsService.setCiState(item.id, 'passing', fx.ctx);
    const after = await db.workItem.findUnique({ where: { id: item.id } });
    expect(after!.ciState).toBe('passing');
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
  });

  it('tenant-gates: a work item in ANOTHER workspace is a 404, never written', async () => {
    const fx = await makeWorkItemFixture({ name: 'Owner co', identifier: 'AAA' });
    const other = await makeWorkItemFixture({ name: 'Other co', identifier: 'BBB' });
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'A task' });

    await expect(workItemsService.setCiState(item.id, 'passing', other.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
    expect(await ciStateOf(item.id)).toBeNull(); // untouched
  });
});
