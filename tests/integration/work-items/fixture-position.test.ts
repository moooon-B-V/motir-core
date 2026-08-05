import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { isValidOrderKey } from '@/lib/workItems/positioning';
import { workItemsService } from '@/lib/services/workItemsService';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture, createTestWorkItem, type WorkItemFixture } from '../../fixtures';

// The `position` contract of the shared work-item fixture (MOTIR-2196).
//
// `createTestWorkItem` used to write `String(key).padStart(6, '0')` — a string
// nothing in the shipped code can emit, and one `generateKeyBetween` rejects
// outright ("invalid order key head: 0"). A suite seeded through it was
// therefore asserting against a state the application cannot reach, and the
// first real service create that appended after such a row threw a raw Error
// the API wrapper rendered as a bare 500.
//
// These tests pin the two properties that replaced it: every seeded row's
// position is a key the product could have minted, and siblings still sort in
// creation order. Real Postgres, no mocks.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(truncateAll);
afterAll(() => db.$disconnect());

const positionsOf = (fx: WorkItemFixture, parentId: string | null) =>
  db.workItem.findMany({
    where: { projectId: fx.projectId, parentId },
    orderBy: { position: 'asc' },
    select: { identifier: true, position: true },
  });

describe('createTestWorkItem — the seeded `position` is a real fractional-index key', () => {
  it('mints a VALID key, never a zero-padded number', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'story', title: 'Only' });

    expect(isValidOrderKey(item.position)).toBe(true);
    expect(item.position.startsWith('0')).toBe(false);
  });

  it('chains top-level siblings so they sort in CREATION order', async () => {
    const fx = await makeWorkItemFixture();
    const a = await createTestWorkItem(fx, { kind: 'story', title: 'First' });
    const b = await createTestWorkItem(fx, { kind: 'story', title: 'Second' });
    const c = await createTestWorkItem(fx, { kind: 'story', title: 'Third' });

    const rows = await positionsOf(fx, null);
    expect(rows.map((r) => r.identifier)).toEqual([a.identifier, b.identifier, c.identifier]);
    expect(rows.every((r) => isValidOrderKey(r.position))).toBe(true);
  });

  it('keeps every key DISTINCT across parents, and each parent ordered', async () => {
    // The chain is global per project, not per parent: two rows sharing a key
    // is the second half of the trap (a board column orders across parents, so
    // dropping between two equal-keyed neighbours calls keyBetween(k, k)).
    const fx = await makeWorkItemFixture();
    const left = await createTestWorkItem(fx, { kind: 'story', title: 'Left' });
    const right = await createTestWorkItem(fx, { kind: 'story', title: 'Right' });
    const l1 = await createTestWorkItem(fx, { kind: 'task', title: 'L1', parentId: left.id });
    const r1 = await createTestWorkItem(fx, { kind: 'task', title: 'R1', parentId: right.id });
    const l2 = await createTestWorkItem(fx, { kind: 'task', title: 'L2', parentId: left.id });

    const all = await db.workItem.findMany({
      where: { projectId: fx.projectId },
      select: { position: true },
    });
    expect(new Set(all.map((r) => r.position)).size).toBe(all.length);

    expect((await positionsOf(fx, left.id)).map((r) => r.identifier)).toEqual([
      l1.identifier,
      l2.identifier,
    ]);
    expect((await positionsOf(fx, right.id)).map((r) => r.identifier)).toEqual([r1.identifier]);
    expect((await positionsOf(fx, null)).map((r) => r.identifier)).toEqual([
      left.identifier,
      right.identifier,
    ]);
  });

  it('a SERVICE create appends after a seeded sibling instead of throwing', async () => {
    const fx = await makeWorkItemFixture();
    const seeded = await createTestWorkItem(fx, { kind: 'story', title: 'Seeded' });

    // This is the call that threw `invalid order key head: 0` before the fix:
    // `createWorkItem` reads the last sibling's position as the append bound.
    const created = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Created through the service' },
      fx.ctx,
    );

    expect((await positionsOf(fx, null)).map((r) => r.identifier)).toEqual([
      seeded.identifier,
      created.identifier,
    ]);
  });
});
