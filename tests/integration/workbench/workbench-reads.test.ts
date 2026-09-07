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
    // It is also where the shipped `/workbench` list put it, so nothing a reader can
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
    expect(first.total).toBe(made.length);

    const second = await homeService.listRecentlyFinished(ctx(), { limit: 2, page: 2 });
    const third = await homeService.listRecentlyFinished(ctx(), { limit: 2, page: 3 });

    const seen = [...ids(first), ...ids(second), ...ids(third)];
    expect(new Set(seen).size).toBe(seen.length); // no repeats across boundaries
    expect(seen).toEqual(made); // and no drops, in completion order
    // ⚠️ Recently finished is the ONE tab MOTIR-4852 left on its time axis —
    // `completedAt DESC` — because *what did I just finish* IS a time question.
    // Its siblings moved to the kind rank; this assertion is what says so.
    expect(third.page).toBe(3);
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

    // Walked by page NUMBER (MOTIR-4852). The BAND is the outer key, and under
    // an offset it has to hold ACROSS a page boundary rather than merely within
    // a group's own walk — with three moving rows and a page size of 2, page 2
    // is exactly the straddling page (`design/workbench/` Panel 11).
    const inOrder: string[] = [];
    const first = await homeService.listWatching(ctx(), { limit: 2 });
    const pageCount = Math.max(1, Math.ceil(first.total / first.pageSize));
    for (let page = 1; page <= pageCount; page += 1) {
      const window = await homeService.listWatching(ctx(), { limit: 2, page });
      inOrder.push(...ids(window));
    }

    expect(new Set(inOrder).size).toBe(inOrder.length); // no repeats
    expect([...inOrder].sort()).toEqual([...moving, ...waiting].sort()); // no drops
    // The three moving rows come first, ACROSS the boundary — page 1 is wholly
    // moving, page 2 carries the last moving row then the first waiting one.
    expect(inOrder.slice(0, 3).sort()).toEqual([...moving].sort());
    expect(inOrder.slice(3).sort()).toEqual([...waiting].sort());
    expect(pageCount).toBeGreaterThan(1); // there IS a boundary to be wrong at
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

    // ⚠️ MOVE A ROW UNDERNEATH THE READER, between the two pages. This used to
    // be the argument FOR the keyset: touching a row the reader had already
    // passed re-sorted it to the front of an `updatedAt` order, and an offset
    // would then repeat one row and drop another.
    //
    // MOTIR-4852 moved these tabs off `updatedAt` entirely — the order is now
    // `(kind rank, id DESC)` — so this churn cannot move the boundary at all:
    // BOTH keys are immutable for the life of a row. The offset inherits the
    // property the keyset was chosen for, on this axis, for free.
    //
    // What it does NOT inherit, said plainly rather than left to be discovered:
    // a row ENTERING or LEAVING the set between two pages (a status change, a
    // new item, an archive) still shifts the offset, and can repeat or drop one
    // row. That is the trade this card made with open eyes — the Workbench is a
    // bounded personal list, and page numbers, a total and a back button are
    // worth it. It would be the wrong side of the trade on an unbounded feed.
    const alreadySeen = first.items[0]!.id;
    await adminDb.workItem.update({
      where: { id: alreadySeen },
      data: { updatedAt: new Date() },
    });

    const second = await homeService.listToDo(ctx(), { limit: 4, page: 2 });
    const seen = [...ids(first), ...ids(second)];
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(mine.sort());
    expect(second.page).toBe(2);
  });
});

describe('the three work tabs order by KIND, and the offset boundary is exact', () => {
  /** A card of a given KIND the reader reports. `parentId` where the matrix demands one. */
  async function kinded(
    kind: 'epic' | 'story' | 'task' | 'bug' | 'subtask',
    title: string,
    parentId?: string,
  ) {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
      fx.ctx,
    );
    return { id: item.id, identifier: item.identifier, kind };
  }

  it('returns `subtask → bug → task → story → epic` ACROSS a page boundary, repeating and dropping nothing', async () => {
    // ⚠️ SEEDED IN THE WRONG ORDER ON PURPOSE — epics first, subtasks last. A
    // read that had quietly kept `updatedAt DESC` would return this exact
    // sequence REVERSED, and a fixture seeded in rank order would pass either
    // way. Five of each, so the run crosses every boundary between two ranks.
    const seeded: { identifier: string; kind: string; id: string }[] = [];
    for (const kind of ['epic', 'story', 'task', 'bug'] as const) {
      for (let i = 0; i < 5; i += 1) seeded.push(await kinded(kind, `${kind} ${i}`));
    }
    // A subtask REQUIRES a parent (the kind-parent matrix), so the five hang
    // under one of the stories already seeded above. That story is a member of
    // the set in its own right — the count below is 25 either way.
    const host = seeded.find((r) => r.kind === 'story')!.id;
    for (let i = 0; i < 5; i += 1) seeded.push(await kinded('subtask', `subtask ${i}`, host));

    // Twenty-five rows at 10 a page is three pages — the card asks for MORE than
    // two, because a single boundary can be right by accident.
    const first = await homeService.listToDo(ctx(), { limit: 10 });
    expect(first.total).toBe(25);
    const pageCount = Math.ceil(first.total / first.pageSize);
    expect(pageCount).toBe(3);

    const walked: string[] = [];
    for (let page = 1; page <= pageCount; page += 1) {
      walked.push(...ids(await homeService.listToDo(ctx(), { limit: 10, page })));
    }

    // No repeat, no drop — the property a shared `kind` key would break without
    // the total `id` tiebreak after it.
    expect(new Set(walked).size, 'a row was repeated across a page boundary').toBe(walked.length);
    expect([...walked].sort(), 'a row was dropped across a page boundary').toEqual(
      seeded.map((r) => r.identifier).sort(),
    );

    // And the CONCATENATION is in rank order — the assertion a per-page check
    // cannot make, which is the whole reason the walk above exists.
    const kindOf = new Map(seeded.map((r) => [r.identifier, r.kind]));
    const RANK = { subtask: 0, bug: 1, task: 2, story: 3, epic: 4 } as const;
    const ranks = walked.map((id) => RANK[kindOf.get(id) as keyof typeof RANK]);
    expect(ranks, 'the concatenated pages are not in READY_KIND_RANK order').toEqual(
      [...ranks].sort((a, b) => a - b),
    );
    // SENSITIVITY: the run really does contain every rank, so the assertion
    // above is not vacuously true of a single-kind list.
    expect(new Set(ranks).size).toBe(5);
  });

  it('leaves Recently finished on `completedAt DESC` while its siblings move to the rank', async () => {
    // The one tab the ordering change does NOT touch — asserted here rather
    // than only in prose, because "unchanged" is the claim nobody re-checks.
    const older = await kinded('task', 'Finished first');
    const newer = await kinded('epic', 'Finished second');
    await finishedDaysAgo(older.id, 3);
    await finishedDaysAgo(newer.id, 1);

    // By KIND the task would come first; by completion time the epic does.
    expect(ids(await homeService.listRecentlyFinished(ctx()))).toEqual([
      newer.identifier,
      older.identifier,
    ]);
  });
});

describe("each read's TOTAL is the same predicate as its list", () => {
  // ⚠️ ASSERTED BY MAKING THEM DISAGREE IF THE PREDICATE DRIFTS, not by reading
  // the two call sites. The fixture puts a row in every category AND one whose
  // status names no category at all, so a `total` counted with a different
  // slice — or without the finished WINDOW — comes back a different number than
  // the walk. MOTIR-2758 is the shape: a badge read ~2 019 where its list read
  // ~263, and nothing errored.
  it('agrees with a full walk of the same tab, on all four', async () => {
    const waiting = await card('Waiting');
    const blocked = await card('Blocked');
    await move(blocked.id, 'blocked');
    const moving = await card('Moving');
    await move(moving.id, 'in_progress');
    const inside = await card('Finished inside the window');
    await finishedDaysAgo(inside.id, 2);
    const outside = await card('Finished outside the window');
    await finishedDaysAgo(outside.id, HOME_FINISHED_WINDOW_DAYS + 3);
    for (const id of [waiting.id, moving.id, inside.id]) {
      await adminDb.$transaction((tx) => watcherRepository.add(id, fx.ownerId, tx));
    }

    const reads = [
      ['toDo', homeService.listToDo],
      ['inProgress', homeService.listInProgress],
      ['recentlyFinished', homeService.listRecentlyFinished],
      ['watching', homeService.listWatching],
    ] as const;

    for (const [name, read] of reads) {
      const probe = await read(ctx(), { limit: 1 });
      const walked: string[] = [];
      for (let page = 1; page <= Math.max(1, probe.total); page += 1) {
        walked.push(...ids(await read(ctx(), { limit: 1, page })));
      }
      expect(new Set(walked).size, `${name} repeated a row`).toBe(walked.length);
      expect(
        walked.length,
        `${name}: total ${probe.total} but the walk found ${walked.length}`,
      ).toBe(probe.total);
    }

    // SENSITIVITY: the numbers are not all the same, and none is zero — so the
    // loop above ran over four genuinely different sets.
    const counts = await homeService.tabCounts(ctx());
    expect([counts.toDo, counts.inProgress, counts.recentlyFinished, counts.watching]).toEqual([
      2, 1, 1, 3,
    ]);
    // And the window really is excluding something, so `recentlyFinished`'s
    // agreement above is about a FILTERED set rather than an unfiltered one.
    expect(ids(await homeService.listRecentlyFinished(ctx()))).toEqual([inside.identifier]);
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
      // disagree with the two above it (MOTIR-4782 removes it with `/workbench`).
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
      await expect(read(outsider)).resolves.toMatchObject({ items: [], total: 0 });
    }
    expect((await homeService.tabCounts(outsider)).toDo).toBe(0);
  });
});

describe('the story GATE — the seams the two code cards meet at (MOTIR-4854)', () => {
  it('a row leaving the slice BETWEEN the count and the list degrades to a short page, not an error', async () => {
    // ⚠️ THE COUNT AND THE LIST ARE TWO STATEMENTS ABOUT ONE SET, TAKEN AT TWO
    // MOMENTS. `homeService` counts first — that is what lets an out-of-range
    // page clamp to the last one instead of fetching an empty offset — and then
    // reads the window. Between them a row can leave the slice, which is the
    // drift the offset accepts and the keyset did not.
    //
    // What must NOT happen is an error, or a page that reports a length it does
    // not have. This drives the race deliberately rather than waiting to meet
    // it: move a row out of the `todo` slice after the total is known, and read
    // the same page again.
    for (let i = 0; i < 6; i += 1) await card(`Row ${i}`);

    const before = await homeService.listToDo(ctx(), { limit: 4 });
    expect(before.total).toBe(6);
    expect(before.items).toHaveLength(4);

    // The row leaves the slice — a real transition, the way the product moves it.
    const [first] = before.items;
    await move(first!.id, 'in_progress');

    // Page 2 now holds ONE row where the earlier total implied two. A short page
    // is the correct degradation; the read re-counts, so its own `total` is
    // honest about the set as it now stands.
    const after = await homeService.listToDo(ctx(), { limit: 4, page: 2 });
    expect(after.total).toBe(5);
    expect(after.items).toHaveLength(1);
    // And nothing threw, which is the half of this that a green run could hide
    // if the assertion were only about the count.
    expect(after.page).toBe(2);
  });

  it("Watching's MOVING group alone overflows a page — page 1 is entirely `in_progress`", async () => {
    // The arrangement the keyset could never produce, at the size that produces
    // it: the first group is longer than one page, so page 1 cannot reach the
    // boundary at all and page 2 is where the two bands meet.
    const moving: string[] = [];
    const waiting: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const m = await card(`Moving ${i}`);
      await move(m.id, 'in_progress');
      await adminDb.$transaction((tx) => watcherRepository.add(m.id, fx.ownerId, tx));
      moving.push(m.identifier);
      const w = await card(`Waiting ${i}`);
      await adminDb.$transaction((tx) => watcherRepository.add(w.id, fx.ownerId, tx));
      waiting.push(w.identifier);
    }

    const p1 = await homeService.listWatching(ctx(), { limit: 3, page: 1 });
    const p2 = await homeService.listWatching(ctx(), { limit: 3, page: 2 });
    const p3 = await homeService.listWatching(ctx(), { limit: 3, page: 3 });
    const p4 = await homeService.listWatching(ctx(), { limit: 3, page: 4 });

    expect(p1.total).toBe(10);
    // (a) page 1 is WHOLLY inside the moving group — it does not reach the boundary.
    expect(
      ids(p1).every((id) => moving.includes(id)),
      'page 1 leaked a waiting row',
    ).toBe(true);
    // (b) page 2 is where the boundary falls: the tail of moving, then the head
    //     of waiting, IN THAT ORDER — the group is the outer key across a page.
    const straddle = ids(p2);
    const boundary = straddle.findIndex((id) => waiting.includes(id));
    expect(boundary, 'page 2 does not straddle the boundary').toBeGreaterThan(0);
    expect(straddle.slice(0, boundary).every((id) => moving.includes(id))).toBe(true);
    expect(straddle.slice(boundary).every((id) => waiting.includes(id))).toBe(true);
    // (c) a later page is WHOLLY inside the waiting group.
    expect(
      ids(p4).every((id) => waiting.includes(id)),
      'page 4 leaked a moving row',
    ).toBe(true);

    // And the walk as a whole repeats nothing and drops nothing.
    const walked = [...ids(p1), ...ids(p2), ...ids(p3), ...ids(p4)];
    expect(new Set(walked).size).toBe(walked.length);
    expect([...walked].sort()).toEqual([...moving, ...waiting].sort());
  });

  it('tenant isolation holds on all four reads AND on their TOTALS', async () => {
    // ⚠️ THE FIXTURE IS ASYMMETRIC ON PURPOSE, which is the whole point of
    // asserting the totals separately. If the actor's visible set and the true
    // population were the same size, a SCOPED count and an UNSCOPED one would
    // return the same number and this test would pass against a read that had
    // lost its scope entirely. So the sibling project holds rows the actor is
    // the assignee of — membership alone would return them — and only the
    // project scope keeps them out.
    const mine = await card('Mine, here');
    await adminDb.$transaction((tx) => watcherRepository.add(mine.id, fx.ownerId, tx));
    const finished = await card('Mine, finished here');
    await finishedDaysAgo(finished.id, 1);
    const moving = await card('Mine, moving here');
    await move(moving.id, 'in_progress');

    const elsewhere = await makeWorkItemFixture({ identifier: 'OTHR' });
    for (let i = 0; i < 4; i += 1) {
      const strangerRow = await workItemsService.createWorkItem(
        { projectId: elsewhere.projectId, kind: 'task', title: `Not mine ${i}` },
        elsewhere.ctx,
      );
      // The actor is the ASSIGNEE, so the membership predicate alone matches it.
      await adminDb.workItem.update({
        where: { id: strangerRow.id },
        data: { assigneeId: fx.ownerId },
      });
      await adminDb.$transaction((tx) => watcherRepository.add(strangerRow.id, fx.ownerId, tx));
    }

    const counts = await homeService.tabCounts(ctx());
    const reads = [
      ['toDo', homeService.listToDo, counts.toDo],
      ['inProgress', homeService.listInProgress, counts.inProgress],
      ['recentlyFinished', homeService.listRecentlyFinished, counts.recentlyFinished],
      ['watching', homeService.listWatching, counts.watching],
    ] as const;

    for (const [name, read, count] of reads) {
      const window = await read(ctx(), { limit: 100 });
      // No row from the sibling project, on the LIST…
      expect(
        ids(window).some((id) => id.startsWith('OTHR-')),
        `${name} leaked a row`,
      ).toBe(false);
      // …and the TOTAL agrees with the list AND with the tab strip's own count.
      expect(window.total, `${name}: total disagrees with its list`).toBe(window.items.length);
      expect(count, `${name}: the strip disagrees with the read`).toBe(window.total);
    }

    // SENSITIVITY: the rows really are there and really do match the membership
    // predicate, so the four assertions above ran against a population that a
    // lost scope would have returned.
    const reachable = await adminDb.workItem.count({ where: { assigneeId: fx.ownerId } });
    expect(reachable).toBeGreaterThan(counts.toDo + counts.inProgress + counts.recentlyFinished);
  });
});
