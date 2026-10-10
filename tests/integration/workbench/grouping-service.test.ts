import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { homeService, type HomeActorContext } from '@/lib/services/homeService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { HomePageDto, HomeWorkItemRowDto } from '@/lib/dto/home';
import { truncateAuthTables } from '../../helpers/db';
import { spyOnJobDispatch } from '../../helpers/jobs';
import { flattenHomePage, homePageItems } from '../../helpers/homePage';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestUser } from '../../fixtures/userFixtures';

// THE GROUPED WORK TABS (Story MOTIR-8012 · MOTIR-8015; `design/workbench/design-notes.md`
// § 36), against a real Postgres. To do, In progress and Recently finished come back as
// GROUPS: a runnable container heading the tab's items under it, or a standalone row.
//
// Rows are created and moved through the service (`completedAt` is stamped by the
// transition); only ownership, archiving and a back-dated completion — which no product
// path sets in a test — are written with `adminDb`.

let fx: WorkItemFixture;
let otherId: string;

beforeEach(async () => {
  spyOnJobDispatch();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "watcher", "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'GRS' });
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

/** Hand a card to somebody else entirely — the reader neither reports nor holds it. */
async function theirs(id: string): Promise<void> {
  await adminDb.workItem.update({
    where: { id },
    data: { reporterId: otherId, assigneeId: otherId },
  });
}

const key = (r: HomeWorkItemRowDto) => r.identifier;
const shape = (page: HomePageDto) =>
  page.items.map((r) => ({
    head: r.identifier,
    groupHead: r.groupHead,
    members: r.groupMembers.map(key),
  }));

describe('In progress groups by runnable container', () => {
  it('S (3) and T (1) as CONTEXT heads, members in ready order, total counting groups', async () => {
    const s = await item('story', 'Per-key API quotas');
    const t = await item('story', 'Audit log export');
    await theirs(s.id);
    await theirs(t.id);
    const s1 = await item('subtask', 'Quota table', s.id);
    const s2 = await item('subtask', 'Enforce the quota', s.id);
    const s3 = await item('subtask', 'Quota settings page', s.id);
    const t1 = await item('subtask', 'CSV export', t.id);
    for (const m of [s1, s2, s3, t1]) await move(m.id, 'in_progress');
    // Priority breaks the kind tie inside a group: the highest-priority member leads.
    await adminDb.workItem.update({ where: { id: s3.id }, data: { priority: 'highest' } });

    const page = await homeService.listInProgress(ctx());
    expect(shape(page)).toEqual([
      { head: s.identifier, groupHead: 'context', members: [s3, s1, s2].map((m) => m.identifier) },
      { head: t.identifier, groupHead: 'context', members: [t1.identifier] },
    ]);
    expect(page.total).toBe(2);
    // The strip still counts ITEMS.
    expect((await homeService.tabCounts(ctx())).inProgress).toBe(4);
  });

  it('a container on the tab is a MEMBER head, drawn exactly once', async () => {
    const s = await item('story', 'Per-key API quotas');
    const members = [
      await item('subtask', 'Quota table', s.id),
      await item('subtask', 'Enforce the quota', s.id),
      await item('subtask', 'Quota settings page', s.id),
    ];
    for (const m of [s, ...members]) await move(m.id, 'in_progress');

    const page = await homeService.listInProgress(ctx());
    expect(shape(page)).toEqual([
      { head: s.identifier, groupHead: 'member', members: members.map((m) => m.identifier) },
    ]);
    expect(flattenHomePage(page).filter((r) => r.id === s.id)).toHaveLength(1);
    expect(page.total).toBe(1);
  });
});

describe('To do — what heads a group and what never does', () => {
  it('epic-parented tasks and non-runnable stories stand alone; a runnable task or bug heads its subtasks', async () => {
    const epic = await item('epic', 'Billing');
    const underEpic = await item('task', 'Retire the legacy invoice job', epic.id);
    // A story holding a task that has subtasks is NOT a runnable container.
    const story = await item('story', 'Checklists');
    const task = await item('task', 'Checklist API', story.id);
    const g1 = await item('subtask', 'The read', task.id);
    const g2 = await item('subtask', 'The write', task.id);
    const bug = await item('bug', 'Usage feed double-counts');
    const b1 = await item('subtask', 'Idempotency key', bug.id);
    const lone = await item('bug', 'Search loses focus');
    const root = await item('task', 'Rotate the certificates');

    const page = await homeService.listToDo(ctx());
    const byHead = new Map(shape(page).map((g) => [g.head, g]));
    expect(byHead.get(task.identifier)).toEqual({
      head: task.identifier,
      groupHead: 'member',
      members: [g1.identifier, g2.identifier],
    });
    expect(byHead.get(bug.identifier)).toEqual({
      head: bug.identifier,
      groupHead: 'member',
      members: [b1.identifier],
    });
    for (const standalone of [underEpic, story, lone, root, epic]) {
      expect(byHead.get(standalone.identifier), standalone.identifier).toEqual({
        head: standalone.identifier,
        groupHead: null,
        members: [],
      });
    }
    // No row anywhere is headed by the epic or the non-runnable story.
    const heads = page.items.filter((r) => r.groupHead !== null).map(key);
    expect(heads).not.toContain(epic.identifier);
    expect(heads).not.toContain(story.identifier);
    // Every item on the tab exactly once, and the strip count unchanged.
    const items = homePageItems(page).map(key);
    expect(new Set(items).size).toBe(items.length);
    expect(items).toHaveLength((await homeService.tabCounts(ctx())).toDo);
    expect(page.total).toBe(7);
  });
});

describe('Recently finished groups newest first', () => {
  it('the group holding the newest completion leads, members newest first, inside the window only', async () => {
    const s = await item('story', 'Per-key API quotas');
    const t = await item('story', 'Audit log export');
    const s1 = await item('subtask', 'Quota table', s.id);
    const s2 = await item('subtask', 'Quota docs', s.id);
    const t1 = await item('subtask', 'CSV export', t.id);
    const old = await item('subtask', 'Old export', t.id);
    const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);
    for (const [m, d] of [
      [s1, 3],
      [s2, 2],
      [t1, 1],
      [old, 12],
    ] as const) {
      await move(m.id, 'in_progress', 'done');
      await adminDb.workItem.update({ where: { id: m.id }, data: { completedAt: daysAgo(d) } });
    }

    const page = await homeService.listRecentlyFinished(ctx());
    expect(shape(page)).toEqual([
      { head: t.identifier, groupHead: 'context', members: [t1.identifier] },
      { head: s.identifier, groupHead: 'context', members: [s2.identifier, s1.identifier] },
    ]);
  });
});

describe('the pager pages WHOLE groups', () => {
  it('splits no group, repeats and drops nothing, and clamps past the end', async () => {
    const big = await item('story', 'The big one');
    const bigMembers: Made[] = [];
    for (let i = 0; i < 4; i += 1) bigMembers.push(await item('subtask', `Big ${i}`, big.id));
    const loose: Made[] = [];
    for (let i = 0; i < 4; i += 1) loose.push(await item('task', `Loose ${i}`));
    const all = [big, ...bigMembers, ...loose].map((m) => m.identifier);

    const seen: string[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const window = await homeService.listToDo(ctx(), { limit: 2, page });
      expect(window.total, `page ${page}`).toBe(5);
      expect(window.page).toBe(page);
      const groups = shape(window);
      for (const g of groups) {
        if (g.head === big.identifier)
          expect(g.members).toEqual(bigMembers.map((m) => m.identifier));
      }
      seen.push(...homePageItems(window).map(key));
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...all].sort());

    const past = await homeService.listToDo(ctx(), { limit: 2, page: 9 });
    expect(past.page).toBe(3);
    expect(past.items).toHaveLength(1);
  });
});

describe('a context head that does not come back', () => {
  it('leaves its members as standalone rows in the group’s slot, the total unchanged', async () => {
    const s = await item('story', 'Archived story');
    const s1 = await item('subtask', 'One', s.id);
    const s2 = await item('subtask', 'Two', s.id);
    await theirs(s.id);
    await adminDb.workItem.update({ where: { id: s.id }, data: { archivedAt: new Date() } });

    const page = await homeService.listToDo(ctx());
    expect(page.total).toBe(1);
    expect(shape(page)).toEqual([
      { head: s1.identifier, groupHead: null, members: [] },
      { head: s2.identifier, groupHead: null, members: [] },
    ]);
  });
});

describe('every other tab is untouched', () => {
  it('Watching and To fix rows carry no group', async () => {
    const s = await item('story', 'Watched story');
    const s1 = await item('subtask', 'Stuck', s.id);
    await move(s1.id, 'in_progress');
    await adminDb.workItem.update({ where: { id: s1.id }, data: { fixReason: 'ci_failed' } });

    const watching = await homeService.listWatching(ctx());
    const toFix = await homeService.listToFix(ctx());
    expect(watching.items.length + toFix.items.length).toBeGreaterThan(0);
    for (const row of [...watching.items, ...toFix.items]) {
      expect(row.groupHead).toBeNull();
      expect(row.groupMembers).toEqual([]);
    }
  });
});
