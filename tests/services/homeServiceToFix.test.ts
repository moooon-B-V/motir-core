import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { homeService } from '@/lib/services/homeService';
import { workspacesService } from '@/lib/services/workspacesService';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  createTestUser,
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures';
import { setProjectAccess } from '@/tests/helpers/projectAccess';

// The Workbench's TO FIX read (Story MOTIR-6588 · MOTIR-6604), over real Postgres.
//
// To fix is In progress's category with `fixReason` set, and In progress is that
// category with it unset — one read, two slices. What is under test is the promise
// that makes that worth doing: every in-progress card the reader owns is on exactly
// one of the two tabs, each count equals its list, and the tab reads only what the
// reader may browse, in their own workspace.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const hctx = (fx: WorkItemFixture, projectId: string = fx.projectId) => ({
  ...fx.ctx,
  projectId,
});

const DETAIL = {
  repair: 'fix',
  check: 'Vitest',
  queueReason: null,
  base: null,
  reviewerName: null,
  notePreview: null,
  gate: null,
  affected: 1,
  total: 1,
};

/** A card of the reader's at `status`, with `fixReason` stored as given. */
async function card(
  fx: WorkItemFixture,
  title: string,
  status: string,
  fixReason: 'queue_failed' | 'conflicted' | 'ci_failed' | 'changes_requested' | null = null,
) {
  const item = await createTestWorkItem(fx, { kind: 'task', title });
  await adminDb.workItem.update({
    where: { id: item.id },
    data: {
      status,
      assigneeId: fx.ownerId,
      fixReason,
      ...(fixReason ? { fixDetail: DETAIL } : {}),
    },
  });
  return item;
}

const ids = (page: { items: { id: string }[] }) => page.items.map((r) => r.id).sort();

describe('To fix and In progress PARTITION the in-progress set', () => {
  it('every in-progress card is on exactly one of the two, over a mixed set', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'FIX' });
    const stuck = [
      await card(fx, 'queue', 'implemented', 'queue_failed'),
      await card(fx, 'conflict', 'implemented', 'conflicted'),
      await card(fx, 'red', 'implemented', 'ci_failed'),
      await card(fx, 'sent back', 'in_review', 'changes_requested'),
    ];
    const moving = [
      await card(fx, 'building', 'in_progress'),
      await card(fx, 'green', 'implemented'),
      await card(fx, 'reviewing', 'in_review'),
    ];
    const toDo = await card(fx, 'not started', 'todo');

    const [toFix, inProgress, todo] = await Promise.all([
      homeService.listToFix(hctx(fx)),
      homeService.listInProgress(hctx(fx)),
      homeService.listToDo(hctx(fx)),
    ]);

    expect(ids(toFix)).toEqual(stuck.map((c) => c.id).sort());
    expect(ids(inProgress)).toEqual(moving.map((c) => c.id).sort());
    expect(ids(toFix).filter((id) => ids(inProgress).includes(id))).toEqual([]);
    expect(ids(todo)).toEqual([toDo.id]);
    // The rows carry the stored answer the UI draws.
    expect(toFix.items.find((r) => r.id === stuck[2]!.id)).toMatchObject({
      fixReason: 'ci_failed',
      fixDetail: DETAIL,
    });
    expect(inProgress.items.every((r) => r.fixReason === null && r.fixDetail === null)).toBe(true);
  });

  it('the counts equal the lists, and My work still counts everything unfinished', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'CNT' });
    await card(fx, 'a', 'implemented', 'ci_failed');
    await card(fx, 'b', 'in_review', 'changes_requested');
    await card(fx, 'c', 'in_progress');
    await card(fx, 'd', 'todo');

    const [counts, toFix, inProgress, myWork] = await Promise.all([
      homeService.tabCounts(hctx(fx)),
      homeService.listToFix(hctx(fx)),
      homeService.listInProgress(hctx(fx)),
      homeService.listMyWork(hctx(fx)),
    ]);

    expect(counts.toFix).toBe(toFix.total);
    expect(counts.toFix).toBe(2);
    expect(counts.inProgress).toBe(inProgress.total);
    expect(counts.inProgress).toBe(1);
    expect(counts.myWork).toBe(myWork.total);
    expect(counts.myWork).toBe(4);
  });

  it('a stored reason on a card OUTSIDE the in-progress category lists nowhere as To fix', async () => {
    // The recompute never writes one there; the slice does not trust that alone.
    const fx = await makeWorkItemFixture({ identifier: 'OUT' });
    await card(fx, 'done but stale', 'done', 'ci_failed');
    await card(fx, 'todo but stale', 'todo', 'ci_failed');

    expect((await homeService.listToFix(hctx(fx))).total).toBe(0);
    expect((await homeService.tabCounts(hctx(fx))).toFix).toBe(0);
  });

  it('lists by REASON PRIORITY first — queue, conflict, red, sent back (design § 30, Order)', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'ORD' });
    // Created in the REVERSE of the priority, so neither id nor kind order can pass it.
    const sentBack = await card(fx, 'sent back', 'in_review', 'changes_requested');
    const red = await card(fx, 'red', 'implemented', 'ci_failed');
    const conflict = await card(fx, 'conflict', 'implemented', 'conflicted');
    const queue = await card(fx, 'queue', 'implemented', 'queue_failed');

    const page = await homeService.listToFix(hctx(fx));

    expect(page.items.map((r) => r.id)).toEqual([queue.id, conflict.id, red.id, sentBack.id]);
  });

  it('pages like the other tabs, with the shipped total and clamp', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PGE' });
    for (let i = 0; i < 3; i++) await card(fx, `stuck ${i}`, 'implemented', 'ci_failed');

    const first = await homeService.listToFix(hctx(fx), { limit: 2 });
    const past = await homeService.listToFix(hctx(fx), { limit: 2, page: 9 });

    expect(first).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(first.items).toHaveLength(2);
    expect(past).toMatchObject({ total: 3, page: 2 });
    expect(past.items).toHaveLength(1);
  });
});

describe('To fix reads only what the reader may browse', () => {
  it('another workspace’s stuck card is neither listed nor counted', async () => {
    const mine = await makeWorkItemFixture({ identifier: 'MIN' });
    const theirs = await makeWorkItemFixture({ identifier: 'THR' });
    await card(theirs, 'theirs', 'implemented', 'ci_failed');

    // Point the reader at the OTHER workspace's project: the project axis alone must
    // not be what excludes the row.
    const foreign = { ...mine.ctx, projectId: theirs.projectId };
    expect((await homeService.listToFix(foreign)).total).toBe(0);
    expect((await homeService.tabCounts(foreign)).toFix).toBe(0);
  });

  it('a card in a private project the reader is not a member of is neither listed nor counted', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PRV' });
    const outsider = await createTestUser({
      email: `outsider-${Date.now()}@example.com`,
      name: 'Outsider',
    });
    await workspacesService.addMember({
      userId: outsider.id,
      workspaceId: fx.workspaceId,
      workspaceRole: 'member',
    });
    const item = await card(fx, 'private', 'implemented', 'ci_failed');
    await adminDb.workItem.update({ where: { id: item.id }, data: { assigneeId: outsider.id } });
    const ctx = { userId: outsider.id, workspaceId: fx.workspaceId, projectId: fx.projectId };
    // Positive control: while the project is open, the outsider sees their card.
    expect((await homeService.listToFix(ctx)).total).toBe(1);

    await setProjectAccess(adminDb, fx.projectId, 'members');

    expect((await homeService.listToFix(ctx)).total).toBe(0);
    expect((await homeService.tabCounts(ctx)).toFix).toBe(0);
  });
});
