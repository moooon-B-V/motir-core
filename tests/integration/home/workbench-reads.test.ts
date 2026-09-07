import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { homeService, HOME_FINISHED_WINDOW_DAYS } from '@/lib/services/homeService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { watcherRepository } from '@/lib/repositories/watcherRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../../helpers/db';
import { spyOnJobDispatch } from '../../helpers/jobs';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';

// THE WORKBENCH'S FOUR PERSONAL READS (Story MOTIR-4777 · MOTIR-4781), against a
// real Postgres (the motir-core no-mocks rule).
//
// `personal-reads.test.ts` beside this file covers the MEMBERSHIP predicate —
// assignee OR reporter, deduped, active-project-scoped — and none of that
// changed. What is new is the PARTITION over it, and the three properties this
// file exists for are the three that a small fixture hides:
//
//   * the partition keys on `workflow_status.CATEGORY`, so a project that
//     renamed its columns still sorts correctly;
//   * the three work reads are TOTAL over the membership set and pairwise
//     disjoint — every row lands in exactly one tab, including a row whose
//     status names no category at all;
//   * the finished window reads a STORED completion time, so re-touching an old
//     row does not bring it back.
//
// ⚠️ EVERY ROW HERE IS CREATED AND MOVED THROUGH THE SERVICE, never by writing
// `work_item.status` with `adminDb`. That is not fastidiousness: `completedAt`
// is stamped by `applyStatusTransition` (MOTIR-4780), so a fixture that sets the
// column directly produces rows that are `done` with no completion time — which
// would make every finished-window assertion here pass for the wrong reason.
// Back-dating is done to `completedAt` ALONE, after a real transition.

let fx: WorkItemFixture;

beforeEach(async () => {
  // The status paths emit `work-item/transitioned` post-commit and the test env
  // has no Inngest key — the comments-suite pattern.
  spyOnJobDispatch();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "watcher", "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'WBN' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctx = () => ({ ...fx.ctx, projectId: fx.projectId });
const ids = (page: { items: { identifier: string }[] }) => page.items.map((r) => r.identifier);

/** A card the reader reports — created THROUGH the service, so it lands in the project's initial status. */
async function card(title: string): Promise<{ id: string; identifier: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return { id: item.id, identifier: item.identifier };
}

/** Move a card the way the product does. */
async function move(id: string, ...keys: string[]): Promise<void> {
  for (const key of keys) await workItemsService.updateStatus(id, key, fx.ctx);
}

/**
 * Finish a card N days ago: a REAL transition (which stamps `completedAt`),
 * then back-date the stamp alone. The status is never written directly.
 */
async function finishedDaysAgo(id: string, days: number): Promise<Date> {
  await move(id, 'in_progress', 'done');
  const at = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  await adminDb.workItem.update({ where: { id }, data: { completedAt: at } });
  return at;
}

async function statusId(key: string): Promise<string> {
  const s = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    workflowsRepository.findStatusByKey(fx.projectId, key, fx.workspaceId, tx),
  );
  if (!s) throw new Error(`seeded status ${key} missing`);
  return s.id;
}

async function allowTransition(fromKey: string, toKey: string): Promise<void> {
  await workflowsService.addTransition({
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    fromStatusId: await statusId(fromKey),
    toStatusId: await statusId(toKey),
  });
}

describe('the three work tabs partition ONE membership set', () => {
  it('puts each row in exactly one tab, and together they hold everything unfinished plus the week', async () => {
    const waiting = await card('Not started');
    const blocked = await card('Blocked on something');
    await move(blocked.id, 'blocked');
    const moving = await card('Being built');
    await move(moving.id, 'in_progress');
    const built = await card('Agent finished, nobody looked');
    await move(built.id, 'in_progress', 'implemented');
    const shipped = await card('Landed on Tuesday');
    await finishedDaysAgo(shipped.id, 2);

    const toDo = ids(await homeService.listToDo(ctx()));
    const inProgress = ids(await homeService.listInProgress(ctx()));
    const finished = ids(await homeService.listRecentlyFinished(ctx()));

    expect(toDo.sort()).toEqual([blocked.identifier, waiting.identifier].sort());
    // ⚠️ `implemented` is IN PROGRESS, and this is the assertion the tab exists
    // for: on this product a card whose pull request is open is an agent's
    // finished output waiting for a person, not idle work.
    expect(inProgress.sort()).toEqual([built.identifier, moving.identifier].sort());
    expect(finished).toEqual([shipped.identifier]);

    // PAIRWISE DISJOINT — no row appears in two tabs…
    const pairs: ReadonlyArray<readonly [string[], string[]]> = [
      [toDo, inProgress],
      [toDo, finished],
      [inProgress, finished],
    ];
    for (const [a, b] of pairs) {
      expect(a.filter((k) => b.includes(k))).toEqual([]);
    }
    // …and TOTAL: the union is every row the old list held, plus the finished one.
    const union = [...toDo, ...inProgress, ...finished].sort();
    const unfinished = ids(await homeService.listMyWork(ctx()));
    expect(union).toEqual([...unfinished, shipped.identifier].sort());
  });

  it('holds a row whose status names NO category, rather than dropping it from all three', async () => {
    // ⚠️ THE TOTALITY CASE, and the reason To do is written as a COMPLEMENT.
    // Three `IN` predicates are total only if every `work_item.status` in the
    // database names a live `workflow_status` row — a property of the DATA, not
    // of the query. `work_item.status` carries a schema default of `"open"`,
    // which no default workflow defines, and a legacy or orphaned key behaves
    // the same way. Under three inclusions such a row is in NO tab at all:
    // invisible on the one surface that exists to say what is on you.
    const orphan = await card('Status nobody registered');
    await adminDb.workItem.update({ where: { id: orphan.id }, data: { status: 'open' } });

    expect(ids(await homeService.listToDo(ctx()))).toContain(orphan.identifier);
    expect(ids(await homeService.listInProgress(ctx()))).not.toContain(orphan.identifier);
    expect(ids(await homeService.listRecentlyFinished(ctx()))).not.toContain(orphan.identifier);
    // It is also where the shipped `/home` list put it, so nothing a reader can
    // see today disappears.
    expect(ids(await homeService.listMyWork(ctx()))).toContain(orphan.identifier);
  });

  it('reads the CATEGORY, not the key — a project whose in-progress column is renamed still sorts', async () => {
    // ⚠️ THE TEST THAT MATTERS FOR ANYBODY BUT US. A partition keyed on the
    // literal `'in_progress'` passes every other case in this file and puts a
    // renamed column's rows in the wrong tab — silently, on a real customer's
    // workflow, with no error anywhere.
    await workflowsService.createStatus({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      key: 'shipping',
      label: 'Shipping',
      category: 'in_progress',
    });
    await allowTransition('todo', 'shipping');

    const item = await card('Out for delivery');
    await move(item.id, 'shipping');

    expect(ids(await homeService.listInProgress(ctx()))).toEqual([item.identifier]);
    expect(ids(await homeService.listToDo(ctx()))).not.toContain(item.identifier);
  });
});

describe('Recently finished reads a STORED completion time', () => {
  it('holds a card finished 2 days ago and not one finished 8 days ago', async () => {
    const recent = await card('Finished on Tuesday');
    const old = await card('Finished last month, near enough');
    await finishedDaysAgo(recent.id, 2);
    await finishedDaysAgo(old.id, HOME_FINISHED_WINDOW_DAYS + 1);

    expect(ids(await homeService.listRecentlyFinished(ctx()))).toEqual([recent.identifier]);
  });

  it('does NOT bring the 8-day-old row back when its `updatedAt` is touched', async () => {
    // The whole reason MOTIR-4780 exists. A window built on `updatedAt` lists
    // work finished in June that somebody re-titled today — and does it without
    // ever erroring, which is why it survives for months.
    const old = await card('Finished long ago, re-titled today');
    await finishedDaysAgo(old.id, HOME_FINISHED_WINDOW_DAYS + 1);
    await adminDb.workItem.update({ where: { id: old.id }, data: { updatedAt: new Date() } });

    expect(ids(await homeService.listRecentlyFinished(ctx()))).toEqual([]);
  });

  it('orders by `completedAt` DESC and pages on the SAME pair', async () => {
    // ⚠️ ORDER AND CURSOR ARE ONE DECISION. A read ordered by `completedAt` and
    // paged on `updatedAt` repeats and drops rows as items are touched
    // underneath the reader — and the drops are silent, so the list simply
    // "sometimes ends early".
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const c = await card(`Finished ${i}`);
      // Finished 1..5 days ago, but UPDATED in the opposite order — so a read
      // that fell back to `updatedAt` would return them reversed.
      await finishedDaysAgo(c.id, i + 1);
      await adminDb.workItem.update({
        where: { id: c.id },
        data: { updatedAt: new Date(Date.now() - (5 - i) * 60_000) },
      });
      made.push(c.identifier);
    }

    const first = await homeService.listRecentlyFinished(ctx(), { limit: 2 });
    expect(ids(first)).toEqual([made[0], made[1]]); // newest completion first
    expect(first.nextCursor).not.toBeNull();

    const second = await homeService.listRecentlyFinished(ctx(), {
      limit: 2,
      cursor: first.nextCursor,
    });
    const third = await homeService.listRecentlyFinished(ctx(), {
      limit: 2,
      cursor: second.nextCursor,
    });

    const seen = [...ids(first), ...ids(second), ...ids(third)];
    expect(new Set(seen).size).toBe(seen.length); // no repeats across boundaries
    expect(seen).toEqual(made); // and no drops, in completion order
    expect(third.nextCursor).toBeNull();
  });
});

describe('Watching gains an ORDER, not a filter', () => {
  /** Watch `id` as the reader. */
  async function watch(id: string): Promise<void> {
    await adminDb.$transaction((tx) => watcherRepository.add(id, fx.ownerId, tx));
  }

  it('returns the same membership it always did, with what is moving ahead of what is waiting', async () => {
    const waiting1 = await card('Waiting A');
    const waiting2 = await card('Waiting B');
    const moving1 = await card('Moving A');
    const moving2 = await card('Moving B');
    await move(moving1.id, 'in_progress');
    await move(moving2.id, 'in_progress', 'in_review');
    for (const c of [waiting1, waiting2, moving1, moving2]) await watch(c.id);

    const order = ids(await homeService.listWatching(ctx()));

    // MEMBERSHIP is unchanged — nothing is dropped, which is what makes this an
    // order rather than a filter. (`toSorted`, not `sort`: the ORDER assertion
    // below reads the same array, and an in-place sort would hand it the
    // alphabetical order instead of the one under test.)
    expect(order.toSorted()).toEqual(
      [waiting1.identifier, waiting2.identifier, moving1.identifier, moving2.identifier].sort(),
    );
    // …and every moving row sits ahead of every waiting one.
    const lastMoving = Math.max(
      order.indexOf(moving1.identifier),
      order.indexOf(moving2.identifier),
    );
    const firstWaiting = Math.min(
      order.indexOf(waiting1.identifier),
      order.indexOf(waiting2.identifier),
    );
    expect(lastMoving).toBeLessThan(firstWaiting);
  });

  it('keeps the group order STABLE across a page boundary', async () => {
    // ⚠️ THE PROPERTY A SERVICE-SIDE SORT CANNOT GIVE. Re-ordering the rows
    // after the read groups them WITHIN a page and says nothing about the next
    // one — so page two arrives holding `todo` rows the reader has not reached
    // yet, interleaved with `in_progress` rows page one already showed.
    const moving: string[] = [];
    const waiting: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const m = await card(`Moving ${i}`);
      await move(m.id, 'in_progress');
      await watch(m.id);
      moving.push(m.identifier);
      const w = await card(`Waiting ${i}`);
      await watch(w.id);
      waiting.push(w.identifier);
    }

    const pages: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 4; i += 1) {
      const page: Awaited<ReturnType<typeof homeService.listWatching>> =
        await homeService.listWatching(ctx(), { limit: 2, cursor });
      pages.push(...ids(page));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }

    expect(new Set(pages).size).toBe(pages.length); // no repeats
    expect(pages.sort()).toEqual([...moving, ...waiting].sort()); // no drops
    // Read back in order: the three moving rows come first, across the boundary.
    const inOrder: string[] = [];
    let c: string | null = null;
    for (let i = 0; i < 4; i += 1) {
      const page: Awaited<ReturnType<typeof homeService.listWatching>> =
        await homeService.listWatching(ctx(), { limit: 2, cursor: c });
      inOrder.push(...ids(page));
      c = page.nextCursor;
      if (c === null) break;
    }
    expect(inOrder.slice(0, 3).sort()).toEqual([...moving].sort());
    expect(inOrder.slice(3).sort()).toEqual([...waiting].sort());
  });
});

describe('paging is exact on every read', () => {
  it('returns `limit` rows and drops none, while rows are updated underneath', async () => {
    // The access and lifecycle predicates are QUERY INPUTS, never post-read
    // filters: a filtered-out row would shorten the page instead of erroring,
    // and "the list sometimes ends early" is a bug nobody traces.
    const mine: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const c = await card(`Waiting ${i}`);
      mine.push(c.identifier);
      // Interleave a finished row, so a read that leaked the done category into
      // To do would shorten page one.
      const done = await card(`Finished ${i}`);
      await finishedDaysAgo(done.id, 1);
    }

    const first = await homeService.listToDo(ctx(), { limit: 4 });
    expect(first.items).toHaveLength(4); // asked for 4, got 4

    // ⚠️ MOVE A ROW UNDERNEATH THE READER, between the two pages — which is the
    // whole reason the boundary is a KEYSET rather than an offset. Touching a
    // row the reader has ALREADY passed re-sorts it to the front of the order;
    // an offset-paged read would then repeat one row and drop another, and the
    // keyset must not.
    const alreadySeen = first.items[0]!.id;
    await adminDb.workItem.update({
      where: { id: alreadySeen },
      data: { updatedAt: new Date() },
    });

    const second = await homeService.listToDo(ctx(), { limit: 4, cursor: first.nextCursor });
    const seen = [...ids(first), ...ids(second)];
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(mine.sort());
    expect(second.nextCursor).toBeNull();
  });
});

describe('every row carries its completion time', () => {
  it('is null on unfinished rows and an ISO string on finished ones', async () => {
    const open = await card('Still going');
    const shipped = await card('Landed');
    const at = await finishedDaysAgo(shipped.id, 1);

    const [live] = (await homeService.listToDo(ctx())).items;
    const [finished] = (await homeService.listRecentlyFinished(ctx())).items;

    expect(live?.identifier).toBe(open.identifier);
    expect(live?.completedAt).toBeNull();
    expect(finished?.completedAt).toBe(at.toISOString());
  });
});

describe('the five tab counts agree with the lists they sit beside', () => {
  it('counts each SET, not the current page — and Approvals is the sibling story s', async () => {
    await card('Waiting');
    const moving = await card('Moving');
    await move(moving.id, 'in_progress');
    const shipped = await card('Shipped');
    await finishedDaysAgo(shipped.id, 1);
    const stale = await card('Shipped a while ago');
    await finishedDaysAgo(stale.id, HOME_FINISHED_WINDOW_DAYS + 1);

    const counts = await homeService.tabCounts(ctx());
    expect(counts).toEqual({
      toDo: 1,
      inProgress: 1,
      recentlyFinished: 1, // the 8-day-old one is outside the window
      // The sibling story's number (MOTIR-4778) — this story draws the slot and
      // ships nothing behind it, so zero is the honest value rather than a
      // placeholder somebody has to remember to replace.
      approvals: 0,
      // Creating a card auto-watches its reporter, so the reader watches all
      // four; Watching excludes finished work (MOTIR-2758), leaving the two
      // unfinished ones. Asserting the number the AUTO-WATCH produces, rather
      // than adding a watcher by hand and expecting one, is what keeps this from
      // measuring the fixture instead of the read.
      watching: 2,
      // Transitional, and derived rather than counted again, so it cannot
      // disagree with the two above it (MOTIR-4782 removes it with `/home`).
      myWork: 2,
    });

    // Each badge is the size of its SET, which is what the lists return.
    expect(ids(await homeService.listToDo(ctx()))).toHaveLength(counts.toDo);
    expect(ids(await homeService.listInProgress(ctx()))).toHaveLength(counts.inProgress);
    expect(ids(await homeService.listRecentlyFinished(ctx()))).toHaveLength(
      counts.recentlyFinished,
    );
  });
});

describe('access is enforced server-side on every read', () => {
  it('gives an actor who may not browse their active project an EMPTY page, not an error', async () => {
    // The no-existence-leak convention every other project gate follows: an
    // empty scope produces an empty read rather than a 404 that would confirm
    // the project exists.
    const outsider = { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: 'proj_nope' };
    for (const read of [
      homeService.listToDo,
      homeService.listInProgress,
      homeService.listRecentlyFinished,
      homeService.listWatching,
    ]) {
      await expect(read(outsider)).resolves.toEqual({ items: [], nextCursor: null });
    }
    expect((await homeService.tabCounts(outsider)).toDo).toBe(0);
  });
});
