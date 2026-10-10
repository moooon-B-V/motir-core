import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import {
  finishedWindowStart,
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
import { truncateAuthTables } from '../../helpers/db';
import { spyOnJobDispatch } from '../../helpers/jobs';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestUser } from '../../fixtures/userFixtures';

// THE GROUPING PROJECTION (Story MOTIR-8012 · MOTIR-8014), against a real Postgres.
//
// The grouped work tabs read their WHOLE slice as six narrow fields, group it in
// memory, and only then read full rows for one page. The read is safe only if its
// set IS the tab's set, so every case below compares it against the list and the
// count over the same options — and the fixture carries every row the shared
// predicate must exclude, because on a fixture of the reader's own live rows alone
// a projection with no predicate at all would pass the same equality.
//
// Rows move through the service: `completedAt` is stamped by the transition
// (MOTIR-4780). Only the columns no product path sets in a test (`archivedAt`,
// `triagedAt`, `fixReason`, `resumeState`, a back-dated `completedAt`, another
// person as reporter) are written with `adminDb`.

let fx: WorkItemFixture;

beforeEach(async () => {
  spyOnJobDispatch();
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "watcher", "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'GRP' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const ctx = (): HomeActorContext => ({ ...fx.ctx, projectId: fx.projectId });

async function item(
  kind: 'story' | 'task' | 'subtask' | 'bug',
  title: string,
  parentId?: string,
): Promise<string> {
  const created = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
  return created.id;
}

async function move(id: string, ...keys: string[]): Promise<void> {
  for (const key of keys) await workItemsService.updateStatus(id, key, fx.ctx);
}

const SLICES: ReadonlyArray<readonly [string, () => HomeMembershipOptions]> = [
  ['To do', () => ({ slice: HOME_SLICE_TODO })],
  ['In progress', () => ({ slice: HOME_SLICE_IN_PROGRESS })],
  [
    'Recently finished',
    () => ({ slice: HOME_SLICE_DONE, sortField: 'completedAt', since: finishedWindowStart() }),
  ],
];

/** The projection, the list and the count over ONE options object, in one context. */
async function readAll(options: HomeMembershipOptions) {
  return withWorkspaceContext(ctx(), async (tx) => {
    const projectScopes = await resolveActiveProjectScope(ctx(), tx);
    const projection = await workItemRepository.listHomeGroupingRowsByAssigneeOrReporterInWorkspace(
      fx.ownerId,
      fx.workspaceId,
      projectScopes,
      options,
      tx,
    );
    const list = await workItemRepository.findByAssigneeOrReporterInWorkspace(
      fx.ownerId,
      fx.workspaceId,
      { projectScopes, take: 1000, ...options },
      tx,
    );
    const count = await workItemRepository.countByAssigneeOrReporterInWorkspace(
      fx.ownerId,
      fx.workspaceId,
      projectScopes,
      options,
      tx,
    );
    return { projection, list, count };
  });
}

/** Every row the shared predicate must leave out; returns their ids. */
async function seedExcluded(): Promise<string[]> {
  const other = await createTestUser({ name: 'Somebody else' });

  const theirs = await item('task', 'Somebody else’s task');
  await adminDb.workItem.update({
    where: { id: theirs },
    data: { reporterId: other.id, assigneeId: null },
  });

  const archived = await item('task', 'Archived');
  await adminDb.workItem.update({ where: { id: archived }, data: { archivedAt: new Date() } });

  const triaged = await item('task', 'Still in triage');
  await adminDb.workItem.update({ where: { id: triaged }, data: { triagedAt: new Date() } });

  const toFix = await item('task', 'Stuck on CI');
  await move(toFix, 'in_progress');
  await adminDb.workItem.update({ where: { id: toFix }, data: { fixReason: 'ci_failed' } });

  const toResume = await item('task', 'Waiting at a gate');
  await move(toResume, 'in_progress');
  await adminDb.workItem.update({
    where: { id: toResume },
    data: { resumeState: 'waiting_on_gate' },
  });

  const old = await item('task', 'Finished last month');
  await move(old, 'in_progress', 'done');
  await adminDb.workItem.update({
    where: { id: old },
    data: { completedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) },
  });

  // Another tenant's item the reader REPORTS — excluded by the workspace gate alone.
  const elsewhere = await makeWorkItemFixture({ identifier: 'OTH', name: 'Elsewhere' });
  const foreign = await workItemsService.createWorkItem(
    { projectId: elsewhere.projectId, kind: 'task', title: 'Another workspace' },
    elsewhere.ctx,
  );
  await adminDb.workItem.update({ where: { id: foreign.id }, data: { reporterId: fx.ownerId } });

  return [theirs, archived, triaged, toFix, toResume, old, foreign.id];
}

describe('listHomeGroupingRowsByAssigneeOrReporterInWorkspace', () => {
  it('returns the tab’s own set on all three grouped tabs, and none of the excluded rows', async () => {
    const story = await item('story', 'Per-key API quotas');
    const s1 = await item('subtask', 'Quota table', story);
    const s2 = await item('subtask', 'Enforce the quota', story);
    await move(s1, 'in_progress');
    await move(s2, 'in_progress', 'implemented');
    await item('subtask', 'Quota docs', story);
    await item('task', 'Rotate the certificates');
    const done = await item('bug', 'Search loses focus');
    await move(done, 'in_progress', 'done');
    const excluded = await seedExcluded();

    for (const [name, options] of SLICES) {
      const { projection, list, count } = await readAll(options());
      const projected = projection.map((r) => r.id).sort();
      expect(projected, name).toEqual(list.map((r) => r.id).sort());
      expect(projection.length, name).toBe(count);
      expect(projection.length, `${name} is not empty`).toBeGreaterThan(0);
      expect(
        projected.filter((id) => excluded.includes(id)),
        name,
      ).toEqual([]);
    }
  });

  it('selects exactly the six fields, with the real parent and a completion only on done rows', async () => {
    const story = await item('story', 'Audit log export');
    const sub = await item('subtask', 'CSV export', story);
    const root = await item('task', 'Filed root');
    const finished = await item('task', 'Shipped');
    await move(finished, 'in_progress', 'done');

    const todo = (await readAll({ slice: HOME_SLICE_TODO })).projection;
    const byId = new Map(todo.map((r) => [r.id, r]));
    expect(Object.keys(byId.get(sub)!).sort()).toEqual(
      ['completedAt', 'id', 'key', 'kind', 'parentId', 'priority'].sort(),
    );
    expect(byId.get(sub)).toMatchObject({ parentId: story, kind: 'subtask', completedAt: null });
    expect(byId.get(root)).toMatchObject({ parentId: null, kind: 'task', completedAt: null });
    expect(typeof byId.get(root)!.key).toBe('number');

    const [done] = (await readAll(SLICES[2]![1]())).projection;
    expect(done).toMatchObject({ id: finished });
    expect(done!.completedAt).toBeInstanceOf(Date);
  });

  it('short-circuits an empty project scope to [] without a query', async () => {
    const rows = await withWorkspaceContext(ctx(), (tx) =>
      workItemRepository.listHomeGroupingRowsByAssigneeOrReporterInWorkspace(
        fx.ownerId,
        fx.workspaceId,
        [],
        { slice: HOME_SLICE_TODO },
        tx,
      ),
    );
    expect(rows).toEqual([]);
  });
});

describe('findHomeRowsByIds reaches a CONTEXT HEAD', () => {
  it('returns a parent the reader does not hold, and not an archived or foreign one', async () => {
    const other = await createTestUser({ name: 'Story owner' });
    const head = await item('story', 'Their story, in progress');
    await move(head, 'in_progress');
    await adminDb.workItem.update({
      where: { id: head },
      data: { reporterId: other.id, assigneeId: other.id },
    });
    await item('subtask', 'My to-do subtask', head);

    const archived = await item('story', 'Archived story');
    await adminDb.workItem.update({ where: { id: archived }, data: { archivedAt: new Date() } });

    const elsewhere = await makeWorkItemFixture({ identifier: 'OTH', name: 'Elsewhere' });
    const foreign = await workItemsService.createWorkItem(
      { projectId: elsewhere.projectId, kind: 'story', title: 'Another workspace' },
      elsewhere.ctx,
    );

    const rows = await withWorkspaceContext(ctx(), (tx) =>
      workItemRepository.findHomeRowsByIds(fx.workspaceId, [head, archived, foreign.id], tx),
    );
    expect(rows.map((r) => r.id)).toEqual([head]);
    expect(rows[0]).toMatchObject({ status: 'in_progress', parentId: null, kind: 'story' });
  });
});
