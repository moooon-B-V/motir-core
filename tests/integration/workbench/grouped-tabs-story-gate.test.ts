import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import {
  finishedWindowStart,
  HOME_FINISHED_WINDOW_DAYS,
  HOME_PAGE_SIZE,
  homeService,
  resolveActiveProjectScope,
  type HomeActorContext,
} from '@/lib/services/homeService';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  HOME_SLICE_DONE,
  HOME_SLICE_IN_PROGRESS,
  HOME_SLICE_TODO,
  workItemRepository,
  type HomeMembershipOptions,
} from '@/lib/repositories/workItemRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type { HomePageDto, HomeWorkItemRowDto } from '@/lib/dto/home';
import { truncateAuthTables } from '../../helpers/db';
import { spyOnJobDispatch } from '../../helpers/jobs';
import { flattenHomePage, homePageItems } from '../../helpers/homePage';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestUser } from '../../fixtures/userFixtures';

// THE STORY GATE for Story MOTIR-8012 (MOTIR-8017): the Workbench's To do, In progress and
// Recently finished tabs, grouped by runnable container (`design/workbench/design-notes.md`
// § 36), asserted ASSEMBLED — the projection (MOTIR-8014), the grouping service
// (MOTIR-8015) and the pager — against a real Postgres. Each card's own suite covers its
// own surface; this file holds what exists only once all of them have merged: whole
// groups across REAL page sizes, the strip still counting items, the partition, and
// tenant isolation of the one new kind of row the story reads, a container the reader
// does not hold.
//
// Status is driven through `workItemsService.updateStatus`, so `completedAt` is the
// transition's own stamp. `adminDb` writes only what no product path sets in a test:
// another person as owner, an archive, and a back-dated completion a real transition
// already wrote.
//
// Every load-bearing claim carries a MEASURED counterfactual — a fixture that could not
// fail proves nothing.

let fx: WorkItemFixture;
let otherId: string;

beforeEach(async () => {
  spyOnJobDispatch();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "watcher", "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'GTS' });
  otherId = (await createTestUser({ name: 'Somebody else' })).id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctx = (): HomeActorContext => ({ ...fx.ctx, projectId: fx.projectId });

type Kind = 'epic' | 'story' | 'task' | 'bug' | 'subtask';
interface Made {
  id: string;
  identifier: string;
}

async function item(kind: Kind, title: string, parentId?: string): Promise<Made> {
  const created = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
  return { id: created.id, identifier: created.identifier };
}

async function move(id: string, ...keys: string[]): Promise<void> {
  for (const key of keys) await workItemsService.updateStatus(id, key, fx.ctx);
}

/** Hand a card to another person — the reader neither reports nor holds it. */
async function theirs(id: string): Promise<void> {
  await adminDb.workItem.update({
    where: { id },
    data: { reporterId: otherId, assigneeId: otherId },
  });
}

const shape = (page: HomePageDto) =>
  page.items.map((r) => ({
    head: r.identifier,
    groupHead: r.groupHead,
    members: r.groupMembers.map((m) => m.identifier),
  }));

type Read = (c: HomeActorContext, o?: { limit?: number; page?: number }) => Promise<HomePageDto>;

/** Every page of a grouped tab at the REAL page size, in order. */
async function allPages(read: Read): Promise<HomePageDto[]> {
  const first = await read(ctx());
  const count = Math.max(1, Math.ceil(first.total / first.pageSize));
  const pages = [first];
  for (let page = 2; page <= count; page += 1) pages.push(await read(ctx(), { page }));
  return pages;
}

/** The tab's own items over every page — member heads and members, context heads out. */
const itemsOf = (pages: HomePageDto[]) => pages.flatMap((p) => homePageItems(p));

/** The projection's id set for one tab, in the reader's own context. */
async function projectionIds(options: HomeMembershipOptions): Promise<string[]> {
  return withWorkspaceContext(ctx(), async (tx) => {
    const scopes = await resolveActiveProjectScope(ctx(), tx);
    const rows = await workItemRepository.listHomeGroupingRowsByAssigneeOrReporterInWorkspace(
      fx.ownerId,
      fx.workspaceId,
      scopes,
      options,
      tx,
    );
    return rows.map((r) => r.id);
  });
}

async function countOf(options: HomeMembershipOptions): Promise<number> {
  return withWorkspaceContext(ctx(), async (tx) => {
    const scopes = await resolveActiveProjectScope(ctx(), tx);
    return workItemRepository.countByAssigneeOrReporterInWorkspace(
      fx.ownerId,
      fx.workspaceId,
      scopes,
      options,
      tx,
    );
  });
}

const OPTIONS = {
  toDo: (): HomeMembershipOptions => ({ slice: HOME_SLICE_TODO }),
  inProgress: (): HomeMembershipOptions => ({ slice: HOME_SLICE_IN_PROGRESS }),
  finished: (): HomeMembershipOptions => ({
    slice: HOME_SLICE_DONE,
    sortField: 'completedAt',
    since: finishedWindowStart(),
  }),
};

const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);

describe('A · the grouping seam, assembled', () => {
  it('A1 · S (3) and T (1) come back as context heads in group order, total 2', async () => {
    const s = await item('story', 'Per-key API quotas');
    const t = await item('story', 'Audit log export');
    const s1 = await item('subtask', 'Quota table', s.id);
    const s2 = await item('subtask', 'Enforce the quota', s.id);
    const s3 = await item('subtask', 'Quota settings page', s.id);
    const t1 = await item('subtask', 'CSV export', t.id);
    await theirs(s.id);
    await theirs(t.id);
    for (const m of [s1, s2, s3, t1]) await move(m.id, 'in_progress');
    // Priority breaks the tie inside S: the highest-priority member leads its group.
    await adminDb.workItem.update({ where: { id: s2.id }, data: { priority: 'highest' } });

    const page = await homeService.listInProgress(ctx());
    expect(shape(page)).toEqual([
      { head: s.identifier, groupHead: 'context', members: [s2, s1, s3].map((m) => m.identifier) },
      { head: t.identifier, groupHead: 'context', members: [t1.identifier] },
    ]);
    expect(page.total).toBe(2);
  });

  it('A2 · S moved into the reader’s In progress heads ONCE, as a member, on every page', async () => {
    const s = await item('story', 'Per-key API quotas');
    const members = [
      await item('subtask', 'Quota table', s.id),
      await item('subtask', 'Enforce the quota', s.id),
      await item('subtask', 'Quota settings page', s.id),
    ];
    for (const m of members) await move(m.id, 'in_progress');
    await move(s.id, 'in_progress');

    const pages = await allPages(homeService.listInProgress);
    const occurrences = pages.flatMap((p) => flattenHomePage(p)).filter((r) => r.id === s.id);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.groupHead).toBe('member');
    expect(occurrences[0]!.groupMembers.map((m) => m.identifier)).toEqual(
      members.map((m) => m.identifier),
    );
  });

  it('A3 · an epic or a story holding grandchildren never heads; a runnable task or bug does', async () => {
    const epic = await item('epic', 'Billing');
    const underEpic = await item('task', 'Retire the legacy invoice job', epic.id);
    const story = await item('story', 'Checklists');
    const task = await item('task', 'Checklist API', story.id);
    const g1 = await item('subtask', 'The read', task.id);
    const bug = await item('bug', 'Usage feed double-counts');
    const b1 = await item('subtask', 'Idempotency key', bug.id);
    const lone = await item('bug', 'Search loses focus');
    // The same shape on the other two tabs, so "no tab" is measured rather than assumed.
    const epic2 = await item('epic', 'Search');
    const doing = await item('task', 'Reindex', epic2.id);
    await move(doing.id, 'in_progress');
    const shipped = await item('task', 'Old reindex', epic2.id);
    await move(shipped.id, 'in_progress', 'done');

    const toDo = await homeService.listToDo(ctx());
    const byHead = new Map(shape(toDo).map((g) => [g.head, g]));
    expect(byHead.get(task.identifier)?.members).toEqual([g1.identifier]);
    expect(byHead.get(bug.identifier)?.members).toEqual([b1.identifier]);
    for (const standalone of [underEpic, lone, story, epic]) {
      expect(byHead.get(standalone.identifier)?.groupHead, standalone.identifier).toBeNull();
    }

    for (const read of [
      homeService.listToDo,
      homeService.listInProgress,
      homeService.listRecentlyFinished,
    ]) {
      for (const page of await allPages(read)) {
        for (const head of page.items.filter((r) => r.groupHead !== null)) {
          expect(head.kind).not.toBe('epic');
          expect(head.id).not.toBe(story.id);
        }
      }
    }
  });

  it('A4 · Recently finished: newest group first, members newest first, the window only', async () => {
    const s = await item('story', 'Per-key API quotas');
    const t = await item('story', 'Audit log export');
    const s1 = await item('subtask', 'Quota table', s.id);
    const s2 = await item('subtask', 'Quota docs', s.id);
    const t1 = await item('subtask', 'CSV export', t.id);
    const tOld = await item('subtask', 'Old export', t.id);
    const u = await item('story', 'Archive the exports');
    const uOld = await item('subtask', 'Only member, long ago', u.id);
    for (const [m, d] of [
      [s1, 3],
      [s2, 2],
      [t1, 1],
      [tOld, HOME_FINISHED_WINDOW_DAYS + 3],
      [uOld, HOME_FINISHED_WINDOW_DAYS + 1],
    ] as const) {
      await move(m.id, 'in_progress', 'done');
      await adminDb.workItem.update({ where: { id: m.id }, data: { completedAt: daysAgo(d) } });
    }

    const page = await homeService.listRecentlyFinished(ctx());
    expect(shape(page)).toEqual([
      { head: t.identifier, groupHead: 'context', members: [t1.identifier] },
      { head: s.identifier, groupHead: 'context', members: [s2.identifier, s1.identifier] },
    ]);
    // Out of the window means out of every group, and a group of none is no group.
    const ids = flattenHomePage(page).map((r) => r.id);
    expect(ids).not.toContain(tOld.id);
    expect(ids).not.toContain(uOld.id);
    expect(ids).not.toContain(u.id);
  });

  it('A4b · Recently finished breaks a tie: members by id DESC, groups by head key', async () => {
    const s = await item('story', 'First story');
    const t = await item('story', 'Second story');
    const s1 = await item('subtask', 'S one', s.id);
    const s2 = await item('subtask', 'S two', s.id);
    const t1 = await item('subtask', 'T one', t.id);
    // One instant for all three: every ordering decision below is a tie-break.
    const at = daysAgo(1);
    for (const m of [s1, s2, t1]) {
      await move(m.id, 'in_progress', 'done');
      await adminDb.workItem.update({ where: { id: m.id }, data: { completedAt: at } });
    }

    const page = await homeService.listRecentlyFinished(ctx());
    const byIdDesc = [s1, s2].sort((a, b) => (a.id < b.id ? 1 : -1)).map((m) => m.identifier);
    expect(shape(page)).toEqual([
      { head: s.identifier, groupHead: 'context', members: byIdDesc },
      { head: t.identifier, groupHead: 'context', members: [t1.identifier] },
    ]);
  });

  it('A5 · whole groups across REAL pages, where a row cut would split one', async () => {
    // 22 one-member groups, then ONE six-member group, then five more: 28 groups, which
    // is HOME_PAGE_SIZE + 3. Every head is someone else's story (a context head), every
    // member an in-progress subtask, so groups rank by their best member's KEY — the
    // creation order — and the big group's items sit at positions 23–28.
    const heads: Made[] = [];
    const members = new Map<string, Made[]>();
    const group = async (size: number, label: string) => {
      const head = await item('story', `Story ${label}`);
      const made: Made[] = [];
      for (let i = 0; i < size; i += 1) made.push(await item('subtask', `${label}.${i}`, head.id));
      for (const m of made) await move(m.id, 'in_progress');
      await theirs(head.id);
      heads.push(head);
      members.set(head.id, made);
      return head;
    };
    for (let i = 0; i < 22; i += 1) await group(1, `small ${i}`);
    const big = await group(6, 'big');
    for (let i = 0; i < 5; i += 1) await group(1, `late ${i}`);
    expect(heads).toHaveLength(HOME_PAGE_SIZE + 3);

    const pages = await allPages(homeService.listInProgress);
    expect(pages).toHaveLength(2);
    for (const page of pages) expect(page.total).toBe(HOME_PAGE_SIZE + 3);

    // Every group's members on exactly ONE page, whole and in order.
    for (const head of heads) {
      const holding = pages.filter((p) => p.items.some((r) => r.id === head.id));
      expect(holding, head.identifier).toHaveLength(1);
      const row = holding[0]!.items.find((r) => r.id === head.id)!;
      expect(row.groupMembers.map((m) => m.id)).toEqual(members.get(head.id)!.map((m) => m.id));
    }
    // The union over pages IS the projection: no duplicate, nothing missing.
    const walked = itemsOf(pages).map((r) => r.id);
    expect(new Set(walked).size).toBe(walked.length);
    expect([...walked].sort()).toEqual((await projectionIds(OPTIONS.inProgress())).sort());

    // A page past the last clamps to it.
    const past = await homeService.listInProgress(ctx(), { page: 9 });
    expect(past.page).toBe(2);
    expect(past.items.map((r) => r.id)).toEqual(pages[1]!.items.map((r) => r.id));

    // COUNTERFACTUAL, measured: the same ordered items cut by ROW at HOME_PAGE_SIZE put
    // the big group on both sides of the cut — the fixture can catch a row-based pager.
    const bigIds = new Set(members.get(big.id)!.map((m) => m.id));
    const rowCut = [walked.slice(0, HOME_PAGE_SIZE), walked.slice(HOME_PAGE_SIZE)];
    expect(rowCut.filter((page) => page.some((id) => bigIds.has(id)))).toHaveLength(2);
    expect(pages.filter((p) => homePageItems(p).some((r) => bigIds.has(r.id)))).toHaveLength(1);
  }, 120_000);

  it('A6 · the strip still counts ITEMS while the pager counts groups', async () => {
    const s = await item('story', 'Per-key API quotas');
    const doing = [
      await item('subtask', 'Quota table', s.id),
      await item('subtask', 'Enforce the quota', s.id),
      await item('subtask', 'Quota settings page', s.id),
    ];
    for (const m of doing) await move(m.id, 'in_progress');
    await theirs(s.id);
    const loose = await item('task', 'Rotate the certificates');
    await move(loose.id, 'in_progress');
    const t = await item('story', 'Audit log export');
    await item('subtask', 'CSV export', t.id);
    await item('subtask', 'Export docs', t.id);
    const f = await item('story', 'Shipped');
    const f1 = await item('subtask', 'Shipped one', f.id);
    const f2 = await item('subtask', 'Shipped two', f.id);
    for (const m of [f1, f2]) await move(m.id, 'in_progress', 'done');

    const counts = await homeService.tabCounts(ctx());
    for (const [count, read, options] of [
      [counts.toDo, homeService.listToDo, OPTIONS.toDo()],
      [counts.inProgress, homeService.listInProgress, OPTIONS.inProgress()],
      [counts.recentlyFinished, homeService.listRecentlyFinished, OPTIONS.finished()],
    ] as const) {
      expect(count).toBe(await countOf(options));
      expect(count).toBe(itemsOf(await allPages(read)).length);
    }

    // COUNTERFACTUAL, measured: the two numbers are different QUANTITIES here, not
    // coincidentally equal — 4 items in 2 groups.
    const inProgress = await homeService.listInProgress(ctx());
    expect(counts.inProgress).toBe(4);
    expect(inProgress.total).toBe(2);
    expect(counts.inProgress).not.toBe(inProgress.total);
  });

  it('A7 · no item is on two tabs; a context head is the one allowed overlap', async () => {
    // S is the reader's and In progress; one subtask is In progress, one To do, one Done.
    const s = await item('story', 'Per-key API quotas');
    const sDoing = await item('subtask', 'Quota table', s.id);
    const sWaiting = await item('subtask', 'Quota docs', s.id);
    const sDone = await item('subtask', 'Quota spike', s.id);
    await move(sDoing.id, 'in_progress');
    await move(sDone.id, 'in_progress', 'done');
    await move(s.id, 'in_progress');
    // Every other category of the default workflow, standalone.
    const review = await item('task', 'In review');
    await move(review.id, 'in_progress', 'in_review');
    const blocked = await item('task', 'Blocked');
    await move(blocked.id, 'blocked');
    const cancelled = await item('task', 'Cancelled');
    await move(cancelled.id, 'cancelled');

    const tabs = {
      toDo: await allPages(homeService.listToDo),
      inProgress: await allPages(homeService.listInProgress),
      finished: await allPages(homeService.listRecentlyFinished),
    };
    const seen = new Map<string, string>();
    for (const [name, pages] of Object.entries(tabs)) {
      for (const row of itemsOf(pages)) {
        expect(seen.get(row.id), `${row.identifier} on ${seen.get(row.id)} and ${name}`).toBe(
          undefined,
        );
        seen.set(row.id, name);
      }
    }
    expect(seen.get(sDoing.id)).toBe('inProgress');
    expect(seen.get(sWaiting.id)).toBe('toDo');
    expect(seen.get(sDone.id)).toBe('finished');

    // THE ALLOWED OVERLAP, asserted so nobody mistakes it for a partition break: S is a
    // ROW (a member head) on In progress, and CONTEXT on To do and Recently finished.
    const headOf = (pages: HomePageDto[]) =>
      pages.flatMap((p) => p.items).find((r) => r.id === s.id);
    expect(headOf(tabs.inProgress)?.groupHead).toBe('member');
    expect(headOf(tabs.toDo)?.groupHead).toBe('context');
    expect(headOf(tabs.finished)?.groupHead).toBe('context');
  });

  it('A8 · Watching, To fix and To resume rows carry no group', async () => {
    const s = await item('story', 'Watched story');
    const stuck = await item('subtask', 'Stuck on CI', s.id);
    await move(stuck.id, 'in_progress');
    await adminDb.workItem.update({ where: { id: stuck.id }, data: { fixReason: 'ci_failed' } });
    const waiting = await item('subtask', 'Waiting at a gate', s.id);
    await move(waiting.id, 'in_progress');
    await adminDb.workItem.update({
      where: { id: waiting.id },
      data: { resumeState: 'waiting_on_gate' },
    });
    await item('subtask', 'Plain member', s.id);

    const rows: HomeWorkItemRowDto[] = [
      ...(await homeService.listWatching(ctx())).items,
      ...(await homeService.listToFix(ctx())).items,
      ...(await homeService.listToResume(ctx())).items,
    ];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.groupHead).toBeNull();
      expect(row.groupMembers).toEqual([]);
    }
  });
});

describe('B · tenant isolation of context heads', () => {
  /** Workspace B: a story and an in-progress subtask the reader REPORTS by a raw write. */
  async function otherWorkspace() {
    const b = await makeWorkItemFixture({ identifier: 'OTH', name: 'Elsewhere' });
    const story = await workItemsService.createWorkItem(
      { projectId: b.projectId, kind: 'story', title: 'Their story' },
      b.ctx,
    );
    const sub = await workItemsService.createWorkItem(
      { projectId: b.projectId, kind: 'subtask', title: 'Their subtask', parentId: story.id },
      b.ctx,
    );
    await workItemsService.updateStatus(sub.id, 'in_progress', b.ctx);
    // The reader is not a member of B; a stray row naming them is excluded by the
    // workspace gate alone.
    await adminDb.workItem.update({ where: { id: sub.id }, data: { reporterId: fx.ownerId } });
    return { b, story, sub };
  }

  it('B1 · the reader’s three tabs never return a row of another workspace', async () => {
    const s = await item('story', 'Mine');
    const s1 = await item('subtask', 'Mine, in progress', s.id);
    await move(s1.id, 'in_progress');
    const { b, story, sub } = await otherWorkspace();

    const theirIds = new Set([story.id, sub.id]);
    for (const read of [
      homeService.listToDo,
      homeService.listInProgress,
      homeService.listRecentlyFinished,
    ]) {
      for (const row of (await allPages(read)).flatMap((p) => flattenHomePage(p))) {
        expect(theirIds.has(row.id), row.identifier).toBe(false);
        expect(row.project.id).not.toBe(b.projectId);
      }
    }
    // SENSITIVITY: the reader's own group IS there, so the walk was not empty. S is the
    // reader's but in To do, so on In progress it is context.
    expect(shape(await homeService.listInProgress(ctx()))).toEqual([
      { head: s.identifier, groupHead: 'context', members: [s1.identifier] },
    ]);
  });

  it('B2 · under the reader’s workspace, B’s ids read as nothing — rows and shapes alike', async () => {
    const { story, sub } = await otherWorkspace();
    const mine = await item('story', 'Mine');
    await item('subtask', 'Mine too', mine.id);
    const { rows, shapes, ownShapes } = await withWorkspaceContext(ctx(), async (tx) => ({
      rows: await workItemRepository.findHomeRowsByIds(fx.workspaceId, [story.id, sub.id], tx),
      shapes: await workItemRepository.findContainerShapes([story.id], fx.workspaceId, tx),
      ownShapes: await workItemRepository.findContainerShapes([mine.id], fx.workspaceId, tx),
    }));
    expect(rows).toEqual([]);
    expect(shapes.filter((s) => s.id === story.id)).toEqual([]);
    // SENSITIVITY: the same read DOES answer for the reader's own container.
    expect(ownShapes.map((s) => s.id)).toEqual([mine.id]);
  });

  it('B3 · another member’s container comes back as context, holding neither role', async () => {
    const s = await item('story', 'Their story');
    const s1 = await item('subtask', 'My subtask', s.id);
    await theirs(s.id);
    await move(s1.id, 'in_progress');
    const [head] = (await homeService.listInProgress(ctx())).items;
    expect(head).toMatchObject({
      id: s.id,
      groupHead: 'context',
      viewerIsAssignee: false,
      viewerIsReporter: false,
    });
  });

  it('B4 · an archived parent never heads; its members stand alone and the total holds', async () => {
    const s = await item('story', 'Soon archived');
    const s1 = await item('subtask', 'One', s.id);
    const s2 = await item('subtask', 'Two', s.id);
    await theirs(s.id);
    for (const m of [s1, s2]) await move(m.id, 'in_progress');

    const live = await homeService.listInProgress(ctx());
    expect(shape(live)).toEqual([
      { head: s.identifier, groupHead: 'context', members: [s1.identifier, s2.identifier] },
    ]);

    await adminDb.workItem.update({ where: { id: s.id }, data: { archivedAt: new Date() } });
    const archived = await homeService.listInProgress(ctx());
    expect(archived.total).toBe(live.total);
    expect(shape(archived)).toEqual([
      { head: s1.identifier, groupHead: null, members: [] },
      { head: s2.identifier, groupHead: null, members: [] },
    ]);
  });
});
