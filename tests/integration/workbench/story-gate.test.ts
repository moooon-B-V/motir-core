import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { homeService, HOME_FINISHED_WINDOW_DAYS } from '@/lib/services/homeService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import {
  workItemRepository,
  HOME_SLICE_IN_PROGRESS,
  HOME_SLICE_TODO,
} from '@/lib/repositories/workItemRepository';
import { withWorkspaceContext } from '@/lib/workspaces';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../../helpers/db';
import { spyOnJobDispatch } from '../../helpers/jobs';
import { createTestUser, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import type { StatusCategoryDto } from '@/lib/dto/workflows';

// THE WORKBENCH STORY GATE (Story MOTIR-4777 · MOTIR-4784) — the properties that
// belong to no single card, against real Postgres and the shipped services.
//
// The three sibling suites cover each card's own surface: `personal-reads` the
// membership predicate, `workbench-reads` the partition and the window,
// `story-seams` the access matrix and the dedupe. What is left — and what this
// file is for — is what only exists once all three have merged:
//
//   1. THE STAMP AND THE WINDOW ARE ONE SEAM. MOTIR-4780 writes `completedAt`
//      and MOTIR-4781 reads it, and every test on either side arranges the
//      column itself. So the one thing nobody asserts is the join: that a REAL
//      transition produces a value the REAL window accepts. Everything here
//      drives `updateStatus` and never writes `status` or `completedAt` as a
//      fixture — except where a test back-dates a stamp a real transition
//      already wrote, which is a different act.
//   2. THE PARTITION IS A PROPERTY OF THE SET, not of any read. A status nobody
//      thought about lands its rows in no tab at all, and nothing errors: the
//      work simply stops appearing. Only an assertion over the WHOLE workflow
//      can see it.
//   3. A CUSTOMER'S WORKFLOW IS NOT OURS. Motir's project uses the default
//      status names, so a predicate written against `'in_progress'` passes every
//      test we would naturally write.
//
// ⚠️ EVERY CLAIM HERE CARRIES ITS OWN COUNTERFACTUAL, and the counterfactual is
// MEASURED rather than argued. The card asks that the window, the partition and
// the custom-workflow cases each fail if the implementation were written against
// a status literal or against `updatedAt` — so each one runs the WRONG
// implementation against the same fixture and asserts it gives a different
// answer. A "this would have failed" written in a comment is a claim; a
// wrong-implementation read beside the right one is a measurement.

let fx: WorkItemFixture;

beforeEach(async () => {
  spyOnJobDispatch();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "watcher", "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'WBG' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctx = () => ({ ...fx.ctx, projectId: fx.projectId });
const ids = (page: { items: { identifier: string }[] }) => page.items.map((r) => r.identifier);
const DAY = 24 * 60 * 60 * 1000;

async function card(title: string): Promise<{ id: string; identifier: string }> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  return { id: item.id, identifier: item.identifier };
}

/** Move a card the way the product does — never a direct `status` write. */
async function move(id: string, ...keys: string[]): Promise<void> {
  for (const key of keys) await workItemsService.updateStatus(id, key, fx.ctx);
}

async function statusId(key: string): Promise<string> {
  const s = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    workflowsRepository.findStatusByKey(fx.projectId, key, fx.workspaceId, tx),
  );
  if (!s) throw new Error(`status ${key} missing`);
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

async function addStatus(key: string, label: string, category: string): Promise<void> {
  await workflowsService.createStatus({
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    key,
    label,
    category: category as 'todo' | 'in_progress' | 'done',
  });
}

/** The project's whole workflow, as the reads resolve it. */
async function statusKeysByCategory(): Promise<
  Readonly<Record<StatusCategoryDto, readonly string[]>>
> {
  const byProject = await withWorkspaceContext(fx.ctx, (tx) =>
    workflowsService.getStatusKeysByCategoryByProjects([fx.projectId], fx.workspaceId, tx),
  );
  const got = byProject.get(fx.projectId);
  if (!got) throw new Error('no workflow resolved for the fixture project');
  return got;
}

/**
 * THE WRONG IMPLEMENTATION, on purpose — the read as it would be if somebody
 * had written the partition against the DEFAULT status keys instead of
 * resolving them from the project's own workflow. Same repository, same
 * fixture, same slice: only the key set is hardcoded.
 *
 * This is what turns "a literal would break for a customer" from a sentence in
 * a comment into an assertion. It is the shape `story-seams.test.ts` calls a
 * POSITIVE CONTROL, pointed the other way: that file widens a guard's input to
 * prove a row is really there; this narrows an implementation to prove the
 * right one is really doing the work.
 */
const DEFAULT_KEYS = {
  todo: ['todo', 'blocked'],
  in_progress: ['in_progress', 'in_review', 'implemented', 'planning'],
  done: ['done', 'cancelled'],
} as const;

async function readWithHardcodedKeys(
  slice: typeof HOME_SLICE_IN_PROGRESS,
  take = 100,
): Promise<string[]> {
  return withWorkspaceContext(fx.ctx, async (tx) => {
    const rows = await workItemRepository.findByAssigneeOrReporterInWorkspace(
      fx.ownerId,
      fx.workspaceId,
      {
        projectScopes: [{ projectId: fx.projectId, statusKeysByCategory: DEFAULT_KEYS }],
        slice,
        take,
      },
      tx,
    );
    return rows.map((r) => r.identifier);
  });
}

describe('the stamp and the window are ONE seam', () => {
  it('a REAL transition produces a completion time the REAL window accepts', async () => {
    // Nothing here writes `completedAt`. Every other test on this axis arranges
    // the column and then reads it, which asserts the read and assumes the
    // write; this is the only place the two meet.
    const shipped = await card('Finished just now, for real');
    const before = Date.now();
    await move(shipped.id, 'in_progress', 'done');

    const [row] = (await homeService.listRecentlyFinished(ctx())).items;
    expect(row?.identifier).toBe(shipped.identifier);
    expect(row?.completedAt).not.toBeNull();

    // The stamp is the SERVICE's, taken at the transition — so it sits between
    // the two clock readings this test took around it. A fixture-written value
    // could satisfy the window while the service wrote nothing at all.
    const stamped = new Date(row!.completedAt!).getTime();
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  it('REOPENING a card takes it back out of the window, and into In progress', async () => {
    // The clear arm of the same seam. A stamp that is written and never cleared
    // leaves a card that is being worked on sitting in "Recently finished" for a
    // week — which reads as an accomplishment rather than as work in flight.
    const reopened = await card('Shipped, then not');
    await move(reopened.id, 'in_progress', 'done');
    expect(ids(await homeService.listRecentlyFinished(ctx()))).toEqual([reopened.identifier]);

    await move(reopened.id, 'in_progress');

    expect(ids(await homeService.listRecentlyFinished(ctx()))).toEqual([]);
    expect(ids(await homeService.listInProgress(ctx()))).toEqual([reopened.identifier]);
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: reopened.id } });
    expect(after.completedAt).toBeNull();
  });

  it('no row this read returns can have a null completion time — the cursor rests on it', async () => {
    // THE INVARIANT BEHIND AN IGNORE DIRECTIVE. `listRecentlyFinished` mints its
    // page cursor from `row.completedAt ?? row.updatedAt`, and the fallback is
    // UNREACHABLE: the read filters on `completedAt >= <window>`, so a null
    // could not have matched. Coverage cannot tell "nobody tested this" from
    // "nothing can test this" — both render as a gap — so the arm carries a
    // `v8 ignore` citing this test by name, and this is the test.
    //
    // It asserts the PREDICATE's guarantee rather than the fallback's absence,
    // which is what makes it survive a refactor: if somebody ever widens the
    // slice so an unstamped row can match, this goes red and the directive
    // above the arm stops being true at the same moment.
    for (let i = 0; i < 4; i += 1) {
      const c = await card(`Finished ${i}`);
      await move(c.id, 'in_progress', 'done');
    }
    // …plus rows that are done-category with NO stamp at all, which is the state
    // the fallback would exist for. They are written directly, deliberately: this
    // is the one place a fixture must produce what a real transition cannot.
    const unstamped = await card('Done, somehow never stamped');
    await move(unstamped.id, 'in_progress', 'done');
    await adminDb.workItem.update({ where: { id: unstamped.id }, data: { completedAt: null } });

    // Walk every page by NUMBER (MOTIR-4852 retired the keyset). `total` is what
    // bounds the walk now, which is stricter than the old `nextCursor !== null`
    // loop: it cannot terminate early because a page came back short.
    const probe = await homeService.listRecentlyFinished(ctx(), { limit: 2 });
    const pageCount = Math.max(1, Math.ceil(probe.total / probe.pageSize));
    for (let page = 1; page <= pageCount; page += 1) {
      const window = await homeService.listRecentlyFinished(ctx(), { limit: 2, page });
      for (const row of window.items) expect(row.completedAt, `page ${page}`).not.toBeNull();
    }

    // SENSITIVITY: the unstamped row exists, is done-category, and is excluded —
    // so the loop above ran over a real corpus rather than an empty one.
    const rows = await homeService.listRecentlyFinished(ctx(), { limit: 100 });
    expect(rows.items).toHaveLength(4);
    expect(ids(rows)).not.toContain(unstamped.identifier);
  });

  it('a `done → cancelled` hop keeps the ORIGINAL stamp — it did not finish twice', async () => {
    await allowTransition('done', 'cancelled');
    const item = await card('Done, then written off');
    await move(item.id, 'in_progress', 'done');
    const first = (await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } }))
      .completedAt;

    await move(item.id, 'cancelled');

    const second = (await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } }))
      .completedAt;
    expect(second).toEqual(first);
    // Both are `done`-category, so it never leaves the tab — but the DATE it
    // sorts by must not jump to the day somebody tidied the board.
    expect(ids(await homeService.listRecentlyFinished(ctx()))).toEqual([item.identifier]);
  });
});

describe('the finished window, at the exact boundary', () => {
  it('holds 7 days minus a second and drops 7 days plus a second', async () => {
    // ⚠️ A CLOCK THE TEST CONTROLS, and only the clock: `toFake: ['Date']`
    // leaves `setTimeout` and friends real, because Prisma's pool runs on them
    // and a fully faked timer environment deadlocks the query rather than
    // failing it.
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = new Date('2026-06-15T12:00:00.000Z');
    vi.setSystemTime(now);

    const inside = await card('Finished a second inside the window');
    const outside = await card('Finished a second outside it');
    for (const c of [inside, outside]) await move(c.id, 'in_progress', 'done');

    // Back-dating a stamp a REAL transition already wrote — the column is never
    // conjured, only moved.
    await adminDb.workItem.update({
      where: { id: inside.id },
      data: { completedAt: new Date(now.getTime() - (HOME_FINISHED_WINDOW_DAYS * DAY - 1000)) },
    });
    await adminDb.workItem.update({
      where: { id: outside.id },
      data: {
        completedAt: new Date(now.getTime() - (HOME_FINISHED_WINDOW_DAYS * DAY + 1000)),
        // …and TOUCHED right now, which is the counterfactual below.
        updatedAt: now,
      },
    });

    expect(ids(await homeService.listRecentlyFinished(ctx()))).toEqual([inside.identifier]);
  });

  it('is keyed on `completedAt` — the same fixture read on `updatedAt` disagrees', async () => {
    // THE COUNTERFACTUAL, measured. The excluded row's `updatedAt` is INSIDE the
    // window, so a predicate written against the last-touch column would return
    // it — which is precisely the bug MOTIR-4780 exists to end, and precisely
    // the bug that never errors.
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = new Date('2026-06-15T12:00:00.000Z');
    vi.setSystemTime(now);
    const windowStart = new Date(now.getTime() - HOME_FINISHED_WINDOW_DAYS * DAY);

    const stale = await card('Finished in April, re-titled today');
    await move(stale.id, 'in_progress', 'done');
    await adminDb.workItem.update({
      where: { id: stale.id },
      data: { completedAt: new Date(now.getTime() - 40 * DAY), updatedAt: now },
    });

    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: stale.id } });
    // The wrong implementation's predicate, evaluated on the same row…
    expect(row.updatedAt.getTime()).toBeGreaterThanOrEqual(windowStart.getTime());
    // …and the right one's.
    expect(row.completedAt!.getTime()).toBeLessThan(windowStart.getTime());
    // The two disagree, and the read follows the second.
    expect(ids(await homeService.listRecentlyFinished(ctx()))).toEqual([]);
  });
});

describe('a CUSTOMER s workflow — every column renamed', () => {
  /** Shipping · Parked · Landed — one per category, none of them a default key. */
  async function customWorkflow(): Promise<{
    parked: { id: string; identifier: string };
    shipping: { id: string; identifier: string };
    landed: { id: string; identifier: string };
  }> {
    await addStatus('parked', 'Parked', 'todo');
    await addStatus('shipping', 'Shipping', 'in_progress');
    await addStatus('landed', 'Landed', 'done');
    await allowTransition('todo', 'parked');
    await allowTransition('todo', 'shipping');
    await allowTransition('shipping', 'landed');

    const parked = await card('Waiting on the depot');
    await move(parked.id, 'parked');
    const shipping = await card('Out for delivery');
    await move(shipping.id, 'shipping');
    const landed = await card('Delivered');
    await move(landed.id, 'shipping', 'landed');
    return { parked, shipping, landed };
  }

  it('lands every row in the right tab, on statuses no default workflow defines', async () => {
    const { parked, shipping, landed } = await customWorkflow();

    expect(ids(await homeService.listToDo(ctx()))).toEqual([parked.identifier]);
    expect(ids(await homeService.listInProgress(ctx()))).toEqual([shipping.identifier]);
    expect(ids(await homeService.listRecentlyFinished(ctx()))).toEqual([landed.identifier]);

    // The stamp works on a custom done-category status too — it is the CATEGORY
    // that decides, on the write side as well as the read side.
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: landed.id } });
    expect(row.completedAt).not.toBeNull();
  });

  it('the same fixture, read with HARDCODED default keys, gets it wrong', async () => {
    // THE INVERSION. Same rows, same repository, same slices — only the key set
    // is the literal one somebody would have typed. In progress comes back
    // EMPTY (nothing is in a default in-progress status) and To do comes back
    // holding all three (the complement of a set that matches none of them),
    // which is the silent misfiling this whole axis exists to prevent.
    const { parked, shipping, landed } = await customWorkflow();

    expect(await readWithHardcodedKeys(HOME_SLICE_IN_PROGRESS)).toEqual([]);
    expect((await readWithHardcodedKeys(HOME_SLICE_TODO)).sort()).toEqual(
      [parked.identifier, shipping.identifier, landed.identifier].sort(),
    );

    // …and the resolved workflow really does carry them, so the difference is
    // the key set and nothing else.
    const resolved = await statusKeysByCategory();
    expect(resolved.in_progress).toContain('shipping');
    expect(resolved.done).toContain('landed');
    expect(resolved.todo).toContain('parked');
  });
});

describe('the partition, over EVERY status the project defines', () => {
  it('puts each row in exactly one tab and loses none — across the whole workflow', async () => {
    await addStatus('parked', 'Parked', 'todo');
    await addStatus('shipping', 'Shipping', 'in_progress');
    await addStatus('landed', 'Landed', 'done');
    for (const to of ['parked', 'shipping']) await allowTransition('todo', to);
    await allowTransition('shipping', 'landed');
    await allowTransition('todo', 'blocked');
    await allowTransition('todo', 'in_progress');
    await allowTransition('in_progress', 'in_review');
    await allowTransition('in_review', 'done');
    await allowTransition('todo', 'cancelled');

    // One row per reachable status, plus a row whose status names NO workflow
    // row at all — the schema default `"open"`, which is what a legacy or
    // orphaned key looks like and the reason To do is a COMPLEMENT.
    const placed: Record<string, string> = {};
    for (const path of [
      ['todo'],
      ['parked'],
      ['blocked'],
      ['shipping'],
      ['in_progress'],
      ['in_progress', 'in_review'],
      ['shipping', 'landed'],
      ['in_progress', 'in_review', 'done'],
      ['cancelled'],
    ]) {
      const c = await card(`At ${path.at(-1)}`);
      await move(c.id, ...path);
      placed[path.at(-1)!] = c.identifier;
    }
    const orphan = await card('A status nobody registered');
    await adminDb.workItem.update({ where: { id: orphan.id }, data: { status: 'open' } });

    const toDo = ids(await homeService.listToDo(ctx()));
    const inProgress = ids(await homeService.listInProgress(ctx()));
    const finished = ids(await homeService.listRecentlyFinished(ctx()));

    // PAIRWISE DISJOINT.
    for (const [a, b] of [
      [toDo, inProgress],
      [toDo, finished],
      [inProgress, finished],
    ] as const) {
      expect(a.filter((k) => b.includes(k))).toEqual([]);
    }

    // TOTAL — nothing the reader owns is in no tab, the orphan included.
    const everything = [...toDo, ...inProgress, ...finished].sort();
    const owned = (
      await adminDb.workItem.findMany({
        where: { projectId: fx.projectId },
        select: { identifier: true },
      })
    )
      .map((r) => r.identifier)
      .sort();
    expect(everything).toEqual(owned);
    expect(toDo).toContain(orphan.identifier);

    // SENSITIVITY — the fixture has to span the axis, or the property above is
    // true of a set too small to break it.
    expect(new Set([toDo.length, inProgress.length, finished.length]).size).toBeGreaterThan(1);
    expect(toDo.length).toBeGreaterThanOrEqual(4); // todo · parked · blocked · orphan
    expect(inProgress.length).toBeGreaterThanOrEqual(3); // in_progress · in_review · shipping
    expect(finished.length).toBeGreaterThanOrEqual(3); // done · cancelled · landed
    expect(Object.keys(placed)).toHaveLength(9);
  });
});

describe('every read is exact at a page boundary', () => {
  it('returns `limit` rows, repeats none and drops none — on all four', async () => {
    // Each read has its own ORDER and therefore its own cursor: three on
    // `(updatedAt, id)`, Recently finished on `(completedAt, id)`, and Watching
    // on a pair PLUS its group. A boundary bug in any one of them is a list that
    // "sometimes ends early", which is the failure nobody traces.
    const finishedIds: string[] = [];
    const movingIds: string[] = [];
    const waitingIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      waitingIds.push((await card(`Waiting ${i}`)).identifier);
      const m = await card(`Moving ${i}`);
      await move(m.id, 'in_progress');
      movingIds.push(m.identifier);
      const f = await card(`Finished ${i}`);
      await move(f.id, 'in_progress', 'done');
      finishedIds.push(f.identifier);
    }

    const reads = [
      ['toDo', homeService.listToDo, waitingIds],
      ['inProgress', homeService.listInProgress, movingIds],
      ['recentlyFinished', homeService.listRecentlyFinished, finishedIds],
      // Creating a card auto-watches its reporter, and Watching excludes
      // finished work — so it holds the ten unfinished ones.
      ['watching', homeService.listWatching, [...waitingIds, ...movingIds]],
    ] as const;

    for (const [name, read, expected] of reads) {
      const seen: string[] = [];
      const first: { items: { identifier: string }[]; total: number; pageSize: number } =
        await read(ctx(), { limit: 2 });
      const pageCount = Math.max(1, Math.ceil(first.total / first.pageSize));
      for (let page = 1; page <= pageCount; page += 1) {
        const got: { items: { identifier: string }[]; total: number } = await read(ctx(), {
          limit: 2,
          page,
        });
        // REQUEST N, GET N until the last page — a predicate applied after the
        // limit would shorten a page instead of erroring.
        if (page < pageCount) expect(got.items, `${name} page ${page}`).toHaveLength(2);
        seen.push(...ids(got));
      }
      expect(new Set(seen).size, `${name} repeated a row`).toBe(seen.length);
      expect(seen.sort(), `${name} dropped a row`).toEqual([...expected].sort());
    }
  });
});

describe('tenant isolation holds on every read, not just the one', () => {
  it('gives a NON-MEMBER an empty page on all four — while the rows are demonstrably there', async () => {
    const mine = await card('Mine, in my workspace');
    const moving = await card('Also mine, moving');
    await move(moving.id, 'in_progress');
    const shipped = await card('And one finished');
    await move(shipped.id, 'in_progress', 'done');

    // ⚠️ THE FIXTURE IS ASYMMETRIC ON PURPOSE. The stranger is made the ASSIGNEE
    // of all three, so the membership predicate alone would return them: only
    // the browsable-project filter excludes them, and a scoped read and an
    // unscoped one cannot come back with the same number.
    const stranger = await createTestUser({ email: `wbg-${Date.now()}@example.com` });
    await adminDb.workItem.updateMany({
      where: { projectId: fx.projectId },
      data: { assigneeId: stranger.id },
    });
    const strangerCtx = {
      userId: stranger.id,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    };

    // THE CONTROL: with the access filter's input widened to the project the
    // stranger is not a member of, the rows are right there.
    const reachable = await withWorkspaceContext(
      { userId: stranger.id, workspaceId: fx.workspaceId },
      async (tx) => {
        const rows = await workItemRepository.findByAssigneeOrReporterInWorkspace(
          stranger.id,
          fx.workspaceId,
          {
            projectScopes: [
              { projectId: fx.projectId, statusKeysByCategory: await statusKeysByCategory() },
            ],
            slice: { notIn: [] },
            take: 100,
          },
          tx,
        );
        return rows.map((r) => r.identifier);
      },
    );
    expect(reachable.sort()).toEqual(
      [mine.identifier, moving.identifier, shipped.identifier].sort(),
    );

    // …and every shipped read returns nothing, rather than an error that would
    // confirm the project exists.
    for (const read of [
      homeService.listToDo,
      homeService.listInProgress,
      homeService.listRecentlyFinished,
      homeService.listWatching,
    ]) {
      await expect(read(strangerCtx)).resolves.toMatchObject({ items: [], total: 0 });
    }
    const counts = await homeService.tabCounts(strangerCtx);
    expect([counts.toDo, counts.inProgress, counts.recentlyFinished, counts.watching]).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it('does not reach into a SECOND workspace on any read', async () => {
    const here = fx;
    const elsewhere = await makeWorkItemFixture({ identifier: 'WBX' });
    const mine = await card('Here');

    // The same person, holding the same relation to a row in each workspace.
    const theirs = await workItemsService.createWorkItem(
      { projectId: elsewhere.projectId, kind: 'task', title: 'There' },
      elsewhere.ctx,
    );
    await adminDb.workItem.update({
      where: { id: theirs.id },
      data: { assigneeId: here.ownerId, reporterId: here.ownerId },
    });

    expect(ids(await homeService.listToDo(ctx()))).toEqual([mine.identifier]);
    expect(ids(await homeService.listWatching(ctx()))).toEqual([mine.identifier]);
    // The control: the row IS the reader's, in the other workspace.
    const there = await adminDb.workItem.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(there.assigneeId).toBe(here.ownerId);
  });
});
