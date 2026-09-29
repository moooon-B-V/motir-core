import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import {
  InvalidReadyCursorError,
  decodeReadyLaneCursor,
  encodeReadyCursor,
  encodeReadyLaneCursor,
  groupRank,
  isBugWork,
  isReadyLane,
  isRunnableContainer,
} from '@/lib/workItems/readyFilter';
import { projectAccessData } from '@/tests/helpers/projectAccess';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { consentedVisitor } from '../visitor/_consentedVisitor';

// The ready LANES (Story MOTIR-6829 · MOTIR-6830) over the real datastore: the
// leaves, containers and bugs lanes PARTITION the one readiness walk `listReady`
// reads, group by runnable container, and page with a lane-aware cursor.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let previousCloud: string | undefined;
beforeEach(async () => {
  await truncateAuthTables();
  previousCloud = process.env['MOTIR_CLOUD'];
});
afterEach(() => {
  if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
  else process.env['MOTIR_CLOUD'] = previousCloud;
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

type Kind = 'epic' | 'story' | 'task' | 'bug' | 'subtask';
type Priority = 'lowest' | 'low' | 'medium' | 'high' | 'highest';

async function item(
  fx: WorkItemFixture,
  kind: Kind,
  title: string,
  opts: { parent?: WorkItem; priority?: Priority; assigneeId?: string } = {},
): Promise<WorkItem> {
  const row = await createTestWorkItem(fx, { kind, title, parentId: opts.parent?.id ?? null });
  return adminDb.workItem.update({
    where: { id: row.id },
    data: {
      status: 'todo',
      priority: opts.priority ?? 'medium',
      assigneeId: opts.assigneeId ?? null,
    },
  });
}

const keys = (rows: Array<{ key: string }>) => rows.map((r) => r.key);

/**
 * The shared tree. Epic E holds story S (three ready subtasks) and task T (a
 * leaf directly under the epic); story S2's best subtask is `highest`; bug B is
 * a childless ready bug and bug B2 holds one ready subtask; story DEEP holds a
 * task that has subtasks, plus a leaf of its own.
 */
async function tree(fx: WorkItemFixture) {
  const E = await item(fx, 'epic', 'E');
  const S = await item(fx, 'story', 'S', { parent: E });
  const s1 = await item(fx, 'subtask', 's1', { parent: S });
  const s2 = await item(fx, 'subtask', 's2', { parent: S });
  const s3 = await item(fx, 'subtask', 's3', { parent: S });
  const T = await item(fx, 'task', 'T', { parent: E });
  const S2 = await item(fx, 'story', 'S2', { parent: E });
  const t1 = await item(fx, 'subtask', 't1', { parent: S2, priority: 'highest' });
  const B = await item(fx, 'bug', 'B');
  const B2 = await item(fx, 'bug', 'B2');
  const b1 = await item(fx, 'subtask', 'b1', { parent: B2 });
  const DEEP = await item(fx, 'story', 'DEEP');
  const inner = await item(fx, 'task', 'inner', { parent: DEEP });
  const i1 = await item(fx, 'subtask', 'i1', { parent: inner });
  const d1 = await item(fx, 'task', 'd1', { parent: DEEP });
  return { E, S, s1, s2, s3, T, S2, t1, B, B2, b1, DEEP, inner, i1, d1 };
}

describe('the lane contract — pure helpers', () => {
  it('a runnable container is a story / task / bug with no grandchild; an epic never is', () => {
    expect(isRunnableContainer({ kind: 'story', hasGrandchildren: false })).toBe(true);
    expect(isRunnableContainer({ kind: 'task', hasGrandchildren: false })).toBe(true);
    expect(isRunnableContainer({ kind: 'bug', hasGrandchildren: false })).toBe(true);
    expect(isRunnableContainer({ kind: 'story', hasGrandchildren: true })).toBe(false);
    expect(isRunnableContainer({ kind: 'epic', hasGrandchildren: false })).toBe(false);
  });

  it('bug work is a bug, or a leaf under a bug', () => {
    expect(isBugWork({ kind: 'bug' }, null)).toBe(true);
    expect(isBugWork({ kind: 'subtask' }, { kind: 'bug' })).toBe(true);
    expect(isBugWork({ kind: 'subtask' }, { kind: 'story' })).toBe(false);
    expect(isBugWork({ kind: 'task' }, null)).toBe(false);
  });

  it('isReadyLane accepts exactly the three lanes', () => {
    expect(['leaf', 'container', 'bug'].every(isReadyLane)).toBe(true);
    expect(isReadyLane('epic')).toBe(false);
    expect(isReadyLane(undefined)).toBe(false);
  });

  it('groupRank orders by best member, then by the head key', () => {
    const hi = { best: { kind: 'subtask', priority: 'highest', key: 9 }, headKey: 9 } as const;
    const mid = { best: { kind: 'subtask', priority: 'medium', key: 1 }, headKey: 1 } as const;
    expect(groupRank(hi, mid)).toBeLessThan(0);
    const sameBest = { best: hi.best, headKey: 3 } as const;
    expect(groupRank(sameBest, hi)).toBeLessThan(0);
  });

  it('a lane cursor round-trips, and is refused by another lane or when garbled', () => {
    const cursor = {
      lane: 'leaf' as const,
      group: { best: { kind: 'subtask' as const, priority: 'high' as const, key: 4 }, headKey: 2 },
      member: { kind: 'subtask' as const, priority: 'low' as const, key: 7 },
    };
    const raw = encodeReadyLaneCursor(cursor);
    expect(decodeReadyLaneCursor(raw, 'leaf')).toEqual(cursor);
    expect(() => decodeReadyLaneCursor(raw, 'bug')).toThrow(InvalidReadyCursorError);
    expect(() => decodeReadyLaneCursor(raw, 'container')).toThrow(InvalidReadyCursorError);
    expect(() => decodeReadyLaneCursor('%%%', 'leaf')).toThrow(InvalidReadyCursorError);
    const flat = encodeReadyCursor({ kind: 'subtask', priority: 'high', key: 4 });
    expect(() => decodeReadyLaneCursor(flat, 'leaf')).toThrow(InvalidReadyCursorError);

    const container = encodeReadyLaneCursor({ ...cursor, lane: 'container', member: null });
    expect(decodeReadyLaneCursor(container, 'container').member).toBeNull();
    expect(() => decodeReadyLaneCursor(container, 'leaf')).toThrow(InvalidReadyCursorError);
  });
});

describe('the leaves lane', () => {
  it("groups a story's ready subtasks consecutively under it; the containers lane counts them", async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const { items } = await workItemsService.listReadyLeaves(fx.projectId, {}, fx.ctx);
    const at = keys(items).indexOf(t.s1.identifier);
    expect(keys(items).slice(at, at + 3)).toEqual([
      t.s1.identifier,
      t.s2.identifier,
      t.s3.identifier,
    ]);
    for (const k of [t.s1, t.s2, t.s3]) {
      expect(items.find((i) => i.key === k.identifier)?.container?.key).toBe(t.S.identifier);
    }

    const containers = await workItemsService.listReadyContainers(fx.projectId, {}, fx.ctx);
    const s = containers.items.find((c) => c.key === t.S.identifier)!;
    expect(s.readyLeafCount).toBe(3);
    expect(s.childCount).toBe(3);
    expect(s.kind).toBe('story');
  });

  it('a task directly under an epic stands alone, and the epic is in no lane', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const leaves = await workItemsService.listReadyLeaves(fx.projectId, {}, fx.ctx);
    const containers = await workItemsService.listReadyContainers(fx.projectId, {}, fx.ctx);
    const bugs = await workItemsService.listReadyBugs(fx.projectId, {}, fx.ctx);
    expect(leaves.items.find((i) => i.key === t.T.identifier)?.container).toBeNull();
    for (const lane of [leaves.items, containers.items, bugs.items]) {
      expect(keys(lane)).not.toContain(t.E.identifier);
    }
  });

  it('a story holding a task with subtasks is not a runnable container; that task is', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const leaves = await workItemsService.listReadyLeaves(fx.projectId, {}, fx.ctx);
    expect(leaves.items.find((i) => i.key === t.d1.identifier)?.container).toBeNull();
    expect(leaves.items.find((i) => i.key === t.i1.identifier)?.container?.key).toBe(
      t.inner.identifier,
    );
    const containers = await workItemsService.listReadyContainers(fx.projectId, {}, fx.ctx);
    expect(keys(containers.items)).not.toContain(t.DEEP.identifier);
    expect(keys(containers.items)).toContain(t.inner.identifier);
  });

  it('ranks groups by their best member, members by the flat comparator inside a group', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    await adminDb.workItem.update({ where: { id: t.s3.id }, data: { priority: 'high' } });
    const { items } = await workItemsService.listReadyLeaves(fx.projectId, {}, fx.ctx);
    const order = keys(items);
    // S2's best is `highest`, so its group comes before S's (best `high`).
    expect(order.indexOf(t.t1.identifier)).toBeLessThan(order.indexOf(t.s3.identifier));
    // Inside S: the `high` member first, then the two `medium` ones by key.
    const at = order.indexOf(t.s3.identifier);
    expect(order.slice(at, at + 3)).toEqual([t.s3.identifier, t.s1.identifier, t.s2.identifier]);
    // The first row is still the flat set's first pick.
    const flat = await workItemsService.listReady(fx.projectId, {}, fx.ctx);
    expect(order[0]).toBe(flat.items[0]!.key);

    const containers = await workItemsService.listReadyContainers(fx.projectId, {}, fx.ctx);
    const ck = keys(containers.items);
    expect(ck.indexOf(t.S2.identifier)).toBeLessThan(ck.indexOf(t.S.identifier));
  });
});

describe('the bugs lane', () => {
  it("holds a childless bug and a bug's subtasks, and neither other lane does", async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const bugs = await workItemsService.listReadyBugs(fx.projectId, {}, fx.ctx);
    expect(keys(bugs.items).sort()).toEqual([t.B.identifier, t.b1.identifier].sort());
    expect(bugs.items.find((i) => i.key === t.B.identifier)?.container).toBeNull();
    expect(bugs.items.find((i) => i.key === t.b1.identifier)?.container?.key).toBe(t.B2.identifier);
    const leaves = await workItemsService.listReadyLeaves(fx.projectId, {}, fx.ctx);
    const containers = await workItemsService.listReadyContainers(fx.projectId, {}, fx.ctx);
    for (const k of [t.B, t.b1, t.B2]) {
      expect(keys(leaves.items)).not.toContain(k.identifier);
      expect(keys(containers.items)).not.toContain(k.identifier);
    }
  });

  it('a bug leaf under a story is its own group, and does not count toward the story', async () => {
    const fx = await makeWorkItemFixture();
    const S = await item(fx, 'story', 'S');
    const leaf = await item(fx, 'subtask', 'leaf', { parent: S });
    const bug = await item(fx, 'bug', 'bug under story', { parent: S });
    const bugs = await workItemsService.listReadyBugs(fx.projectId, {}, fx.ctx);
    expect(bugs.items.map((i) => [i.key, i.container])).toEqual([[bug.identifier, null]]);
    const leaves = await workItemsService.listReadyLeaves(fx.projectId, {}, fx.ctx);
    expect(keys(leaves.items)).toEqual([leaf.identifier]);
    const containers = await workItemsService.listReadyContainers(fx.projectId, {}, fx.ctx);
    expect(containers.items[0]).toMatchObject({
      key: S.identifier,
      readyLeafCount: 1,
      childCount: 2,
    });
  });
});

describe('the partition guard', () => {
  it("leaves ∪ bugs is exactly listReady's set, and the two are disjoint", async () => {
    const fx = await makeWorkItemFixture();
    await tree(fx);
    const flat = await workItemsService.listReady(fx.projectId, { limit: 200 }, fx.ctx);
    const leaves = await workItemsService.listReadyLeaves(fx.projectId, { limit: 200 }, fx.ctx);
    const bugs = await workItemsService.listReadyBugs(fx.projectId, { limit: 200 }, fx.ctx);
    const l = new Set(leaves.items.map((i) => i.id));
    const b = new Set(bugs.items.map((i) => i.id));
    expect([...l].filter((id) => b.has(id))).toEqual([]);
    expect([...l, ...b].sort()).toEqual(flat.items.map((i) => i.id).sort());
  });

  it('holds under a facet and under allowSoftBlock too', async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    const gate = await item(fx, 'task', 'gate');
    await workItemsService.linkWorkItems(
      { fromId: t.S.id, toId: gate.id, kind: 'is_blocked_by' },
      fx.ctx,
    );
    for (const filter of [{ priority: ['medium' as const] }, { allowSoftBlock: true }, {}]) {
      const flat = await workItemsService.listReady(fx.projectId, filter, fx.ctx);
      const leaves = await workItemsService.listReadyLeaves(fx.projectId, filter, fx.ctx);
      const bugs = await workItemsService.listReadyBugs(fx.projectId, filter, fx.ctx);
      expect([...leaves.items, ...bugs.items].map((i) => i.id).sort()).toEqual(
        flat.items.map((i) => i.id).sort(),
      );
    }
    // The cascade is kept: S is blocked, so its subtasks are in no lane…
    const plain = await workItemsService.listReadyLeaves(fx.projectId, {}, fx.ctx);
    expect(keys(plain.items)).not.toContain(t.s1.identifier);
    // …and appear only when the caller widens past the soft block.
    const soft = await workItemsService.listReadyLeaves(
      fx.projectId,
      { allowSoftBlock: true },
      fx.ctx,
    );
    expect(keys(soft.items)).toContain(t.s1.identifier);
  });
});

describe('paging a lane', () => {
  it('limit: 2 walks the same sequence as one unpaged read, in every lane', async () => {
    const fx = await makeWorkItemFixture();
    await tree(fx);
    for (const lane of ['leaves', 'bugs', 'containers'] as const) {
      const read = (f: { cursor?: string; limit?: number }) =>
        lane === 'leaves'
          ? workItemsService.listReadyLeaves(fx.projectId, f, fx.ctx)
          : lane === 'bugs'
            ? workItemsService.listReadyBugs(fx.projectId, f, fx.ctx)
            : workItemsService.listReadyContainers(fx.projectId, f, fx.ctx);
      const whole = await read({ limit: 200 });
      const walked: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 50; guard++) {
        const page = await read({ limit: 2, cursor });
        walked.push(...keys(page.items));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      expect(walked).toEqual(keys(whole.items));
    }
  });

  it('refuses a cursor from another lane and a garbled one', async () => {
    const fx = await makeWorkItemFixture();
    await tree(fx);
    const page = await workItemsService.listReadyLeaves(fx.projectId, { limit: 1 }, fx.ctx);
    expect(page.nextCursor).not.toBeNull();
    await expect(
      workItemsService.listReadyBugs(fx.projectId, { cursor: page.nextCursor! }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidReadyCursorError);
    await expect(
      workItemsService.listReadyContainers(fx.projectId, { cursor: page.nextCursor! }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidReadyCursorError);
    await expect(
      workItemsService.listReadyLeaves(fx.projectId, { cursor: 'garbage' }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidReadyCursorError);
  });
});

describe('the containers lane facets and the counts', () => {
  it("filters on the container's own priority and assignee", async () => {
    const fx = await makeWorkItemFixture();
    const t = await tree(fx);
    await adminDb.workItem.update({
      where: { id: t.S.id },
      data: { priority: 'highest', assigneeId: fx.ownerId },
    });
    const hi = await workItemsService.listReadyContainers(
      fx.projectId,
      { priority: ['highest'] },
      fx.ctx,
    );
    expect(keys(hi.items)).toEqual([t.S.identifier]);
    const mine = await workItemsService.listReadyContainers(
      fx.projectId,
      { assigneeId: fx.ownerId },
      fx.ctx,
    );
    expect(keys(mine.items)).toEqual([t.S.identifier]);
    expect(mine.items[0]!.assignee?.id).toBe(fx.ownerId);
    const nobody = await workItemsService.listReadyContainers(
      fx.projectId,
      { assigneeId: null },
      fx.ctx,
    );
    expect(keys(nobody.items)).not.toContain(t.S.identifier);
  });

  it('countReadyLanes agrees with the lanes it counts', async () => {
    const fx = await makeWorkItemFixture();
    await tree(fx);
    const counts = await workItemsService.countReadyLanes(fx.projectId, fx.ctx);
    const leaves = await workItemsService.listReadyLeaves(fx.projectId, { limit: 200 }, fx.ctx);
    const bugs = await workItemsService.listReadyBugs(fx.projectId, { limit: 200 }, fx.ctx);
    const containers = await workItemsService.listReadyContainers(
      fx.projectId,
      { limit: 200 },
      fx.ctx,
    );
    expect(counts).toEqual({
      leaves: leaves.items.length,
      bugs: bugs.items.length,
      containers: containers.items.length,
      hasMore: false,
    });
  });

  it('an empty project answers three empty lanes without error', async () => {
    const fx = await makeWorkItemFixture();
    expect((await workItemsService.listReadyLeaves(fx.projectId, {}, fx.ctx)).items).toEqual([]);
    expect((await workItemsService.listReadyBugs(fx.projectId, {}, fx.ctx)).items).toEqual([]);
    expect((await workItemsService.listReadyContainers(fx.projectId, {}, fx.ctx)).items).toEqual(
      [],
    );
    expect(await workItemsService.countReadyLanes(fx.projectId, fx.ctx)).toEqual({
      leaves: 0,
      containers: 0,
      bugs: 0,
      hasMore: false,
    });
  });
});

describe('findContainerShapes', () => {
  it('issues ONE query for N parents', async () => {
    const fx = await makeWorkItemFixture();
    await tree(fx);
    const spy = vi.spyOn(workItemRepository, 'findContainerShapes');
    try {
      await workItemsService.listReadyLeaves(fx.projectId, {}, fx.ctx);
      expect(spy).toHaveBeenCalledTimes(1);
      // Every distinct parent of a ready leaf, in that one call.
      expect(spy.mock.calls[0]![0].length).toBeGreaterThan(3);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the Visitor read', () => {
  it("hides a private epic's descendants in every lane, as listReady does", async () => {
    process.env['MOTIR_CLOUD'] = 'true';
    const fx = await makeWorkItemFixture({ name: 'Lanes public', identifier: 'LNP' });
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: projectAccessData('public'),
    });
    const privateEpic = await item(fx, 'epic', 'private');
    const hiddenStory = await item(fx, 'story', 'hidden story', { parent: privateEpic });
    const hiddenLeaf = await item(fx, 'subtask', 'hidden leaf', { parent: hiddenStory });
    const hiddenBug = await item(fx, 'bug', 'hidden bug', { parent: privateEpic });
    const openStory = await item(fx, 'story', 'open story');
    const openLeaf = await item(fx, 'subtask', 'open leaf', { parent: openStory });
    await adminDb.workItem.update({
      where: { id: privateEpic.id },
      data: { publicChildrenHidden: true },
    });
    const visitor = await consentedVisitor('LNP');

    const leaves = await workItemsService.listReadyLeaves(fx.projectId, {}, visitor);
    const bugs = await workItemsService.listReadyBugs(fx.projectId, {}, visitor);
    const containers = await workItemsService.listReadyContainers(fx.projectId, {}, visitor);
    expect(keys(leaves.items)).toEqual([openLeaf.identifier]);
    expect(bugs.items).toEqual([]);
    expect(keys(containers.items)).toEqual([openStory.identifier]);

    const member = await workItemsService.listReadyLeaves(fx.projectId, {}, fx.ctx);
    expect(keys(member.items)).toContain(hiddenLeaf.identifier);
    const memberBugs = await workItemsService.listReadyBugs(fx.projectId, {}, fx.ctx);
    expect(keys(memberBugs.items)).toContain(hiddenBug.identifier);
  });
});
