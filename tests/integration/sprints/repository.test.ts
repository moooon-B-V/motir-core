import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture, createTestWorkItem } from '../../fixtures';
import type { WorkItem } from '@prisma/client';

// Repository-layer tests for the Story-4.1 sprint + backlog-rank data-access
// leaves (Subtask 4.1.2): sprintRepository + the new work_item sprint/rank
// methods on workItemRepository. Real Postgres (no mocks), per CLAUDE.md.
//
// These assert the repository CONTRACT — single-Prisma-op reads/writes, the
// required-`tx` on writes (exercised inside a real `db.$transaction`), the
// explicit `workspaceId` gate (finding #26 — a cross-workspace read returns
// [] / null under the BYPASSRLS superuser, proving the WHERE-clause gate not
// the RLS policy), the bounded/cursor backlog reads (finding #57 — take+1),
// and the empty-input short-circuit the coverage gate needs covered. The
// state-machine + association BEHAVIOUR (guards, carry-over, scale) is Story
// 4.1.5's dedicated suite; here we prove the leaves.

async function truncateAll(): Promise<void> {
  // sprint FKs workspace/project (onDelete Cascade) so the workspace truncate
  // carries it; the explicit work_item truncate mirrors the work-item repo test.
  await db.$executeRawUnsafe('TRUNCATE TABLE "work_item" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Insert a sprint row directly (sprintsService is 4.1.3 — not built yet; the
 *  repo under test only reads/writes these rows, mirroring the board repo test). */
async function makeSprint(args: {
  workspaceId: string;
  projectId: string;
  name: string;
  sequence: number;
  state?: 'planned' | 'active' | 'complete';
}): Promise<string> {
  const row = await db.sprint.create({
    data: {
      workspaceId: args.workspaceId,
      projectId: args.projectId,
      name: args.name,
      sequence: args.sequence,
      state: args.state ?? 'planned',
    },
  });
  return row.id;
}

/** Set a work item's backlogRank through the repository's required-`tx` write. */
async function setRank(itemId: string, rank: string): Promise<void> {
  await db.$transaction((tx) => workItemRepository.setBacklogRank(itemId, rank, tx));
}

describe('sprintRepository — reads + workspace gate', () => {
  it('findById returns the sprint, null cross-workspace', async () => {
    const a = await makeWorkItemFixture({ name: 'A', identifier: 'AAA' });
    const b = await makeWorkItemFixture({ name: 'B', identifier: 'BBB' });
    const s = await makeSprint({
      workspaceId: a.workspaceId,
      projectId: a.projectId,
      name: 'Sprint 1',
      sequence: 1,
    });
    expect((await sprintRepository.findById(s, a.workspaceId))?.id).toBe(s);
    expect(await sprintRepository.findById(s, b.workspaceId)).toBeNull();
  });

  it('findActiveByProject returns the single active sprint, null when none active', async () => {
    const fx = await makeWorkItemFixture();
    await makeSprint({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'Planned',
      sequence: 1,
    });
    expect(await sprintRepository.findActiveByProject(fx.projectId, fx.workspaceId)).toBeNull();
    const active = await makeSprint({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'Active',
      sequence: 2,
      state: 'active',
    });
    expect((await sprintRepository.findActiveByProject(fx.projectId, fx.workspaceId))?.id).toBe(
      active,
    );
    // cross-workspace gate
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    expect(await sprintRepository.findActiveByProject(fx.projectId, other.workspaceId)).toBeNull();
  });

  it('listByProject returns sprints in sequence order, workspace-gated', async () => {
    const fx = await makeWorkItemFixture();
    await makeSprint({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'Second',
      sequence: 2,
    });
    await makeSprint({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'First',
      sequence: 1,
    });
    const list = await sprintRepository.listByProject(fx.projectId, fx.workspaceId);
    expect(list.map((s) => s.name)).toEqual(['First', 'Second']);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    expect(await sprintRepository.listByProject(fx.projectId, other.workspaceId)).toEqual([]);
  });

  it('countByProjectAndState counts per state', async () => {
    const fx = await makeWorkItemFixture();
    await makeSprint({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'P1',
      sequence: 1,
    });
    await makeSprint({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'P2',
      sequence: 2,
    });
    await makeSprint({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'A1',
      sequence: 3,
      state: 'active',
    });
    expect(
      await sprintRepository.countByProjectAndState(fx.projectId, fx.workspaceId, 'planned'),
    ).toBe(2);
    expect(
      await sprintRepository.countByProjectAndState(fx.projectId, fx.workspaceId, 'active'),
    ).toBe(1);
  });

  it('maxSequenceForProject returns 0 when empty, else the max', async () => {
    const fx = await makeWorkItemFixture();
    expect(await sprintRepository.maxSequenceForProject(fx.projectId, fx.workspaceId)).toBe(0);
    await makeSprint({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'S5',
      sequence: 5,
    });
    await makeSprint({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'S3',
      sequence: 3,
    });
    expect(await sprintRepository.maxSequenceForProject(fx.projectId, fx.workspaceId)).toBe(5);
  });
});

describe('sprintRepository — writes (required tx) + FOR-UPDATE lock', () => {
  it('create / update / delete round-trip inside a transaction', async () => {
    const fx = await makeWorkItemFixture();
    const created = await db.$transaction((tx) =>
      sprintRepository.create(
        {
          workspaceId: fx.workspaceId,
          projectId: fx.projectId,
          name: 'Sprint 1',
          sequence: 1,
          goal: 'Ship 4.1',
        },
        tx,
      ),
    );
    expect(created.state).toBe('planned');
    expect(created.goal).toBe('Ship 4.1');

    const renamed = await db.$transaction((tx) =>
      sprintRepository.update(created.id, { name: 'Renamed', state: 'active' }, tx),
    );
    expect(renamed.name).toBe('Renamed');
    expect(renamed.state).toBe('active');

    const deleted = await db.$transaction((tx) => sprintRepository.delete(created.id, tx));
    expect(deleted.id).toBe(created.id);
    expect(await sprintRepository.findById(created.id, fx.workspaceId)).toBeNull();
  });

  it('findActiveByProjectForUpdate locks the active row, null when none active', async () => {
    const fx = await makeWorkItemFixture();
    // no active sprint yet → null
    const none = await db.$transaction((tx) =>
      sprintRepository.findActiveByProjectForUpdate(fx.projectId, fx.workspaceId, tx),
    );
    expect(none).toBeNull();

    const active = await makeSprint({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'Active',
      sequence: 1,
      state: 'active',
    });
    const locked = await db.$transaction((tx) =>
      sprintRepository.findActiveByProjectForUpdate(fx.projectId, fx.workspaceId, tx),
    );
    expect(locked?.id).toBe(active);
    // cross-workspace gate keeps the lock tenant-scoped
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const foreign = await db.$transaction((tx) =>
      sprintRepository.findActiveByProjectForUpdate(fx.projectId, other.workspaceId, tx),
    );
    expect(foreign).toBeNull();
  });
});

describe('workItemRepository — sprint association (setSprint)', () => {
  it('assigns an issue to a sprint and moves it back to the backlog', async () => {
    const fx = await makeWorkItemFixture();
    const sprintId = await makeSprint({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'S1',
      sequence: 1,
    });
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'T' });

    const assigned = await db.$transaction((tx) =>
      workItemRepository.setSprint(item.id, sprintId, tx),
    );
    expect(assigned.sprintId).toBe(sprintId);

    const backToBacklog = await db.$transaction((tx) =>
      workItemRepository.setSprint(item.id, null, tx),
    );
    expect(backToBacklog.sprintId).toBeNull();
  });

  it('setSprint on a missing item throws WorkItemNotFoundError', async () => {
    await expect(
      db.$transaction((tx) => workItemRepository.setSprint('nope', null, tx)),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});

describe('workItemRepository — backlog rank (setBacklogRank)', () => {
  it('persists the rank string (single-row write)', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'T' });
    await setRank(item.id, 'a5');
    const reread = await db.workItem.findUnique({ where: { id: item.id } });
    expect(reread?.backlogRank).toBe('a5');
  });

  it('setBacklogRank on a missing item throws WorkItemNotFoundError', async () => {
    await expect(
      db.$transaction((tx) => workItemRepository.setBacklogRank('nope', 'a0', tx)),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});

describe('workItemRepository — bounded backlog/sprint reads (finding #57)', () => {
  // Four backlog issues ranked a0..a3, one sprint issue, one archived issue.
  async function seedBacklog(): Promise<{
    fx: Awaited<ReturnType<typeof makeWorkItemFixture>>;
    sprintId: string;
    backlog: WorkItem[];
    sprintItem: WorkItem;
  }> {
    const fx = await makeWorkItemFixture();
    const sprintId = await makeSprint({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'S1',
      sequence: 1,
    });
    const backlog: WorkItem[] = [];
    for (let i = 0; i < 4; i++) {
      const item = await createTestWorkItem(fx, { kind: 'task', title: `B${i}` });
      await setRank(item.id, `a${i}`);
      backlog.push(item);
    }
    // one issue committed to the sprint (ranked between the backlog ranks)
    const sprintItem = await createTestWorkItem(fx, { kind: 'task', title: 'InSprint' });
    await setRank(sprintItem.id, 'b0');
    await db.$transaction((tx) => workItemRepository.setSprint(sprintItem.id, sprintId, tx));
    // one archived backlog issue — must be excluded from reads/counts
    const archived = await createTestWorkItem(fx, { kind: 'task', title: 'Gone' });
    await setRank(archived.id, 'a9');
    await db.$transaction((tx) => workItemRepository.archive(archived.id, tx));
    return { fx, sprintId, backlog, sprintItem };
  }

  it('findBacklogPage returns backlog issues in rank order, fetching take+1', async () => {
    const { fx, backlog } = await seedBacklog();
    // take=2 → take+1=3 rows so the service can detect a next page
    const page = await workItemRepository.findBacklogPage(fx.projectId, fx.workspaceId, {
      take: 2,
    });
    expect(page).toHaveLength(3);
    expect(page.map((w) => w.id)).toEqual([backlog[0]!.id, backlog[1]!.id, backlog[2]!.id]);
    // excludes sprint-committed + archived issues
    expect(page.every((w) => w.sprintId === null)).toBe(true);
  });

  it('findBacklogPage honours the cursor (skips the cursor row)', async () => {
    const { fx, backlog } = await seedBacklog();
    const page = await workItemRepository.findBacklogPage(fx.projectId, fx.workspaceId, {
      take: 2,
      cursor: backlog[0]!.id,
    });
    expect(page.map((w) => w.id)).toEqual([backlog[1]!.id, backlog[2]!.id, backlog[3]!.id]);
  });

  it('findBacklogPage is workspace-gated', async () => {
    const { fx } = await seedBacklog();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    expect(
      await workItemRepository.findBacklogPage(fx.projectId, other.workspaceId, { take: 50 }),
    ).toEqual([]);
  });

  it('countBacklog counts only non-archived backlog issues', async () => {
    const { fx } = await seedBacklog();
    expect(await workItemRepository.countBacklog(fx.projectId, fx.workspaceId)).toBe(4);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    expect(await workItemRepository.countBacklog(fx.projectId, other.workspaceId)).toBe(0);
  });

  it('findSprintIssues + countSprintIssues return the sprint set (cursor honoured)', async () => {
    const { fx, sprintId, sprintItem } = await seedBacklog();
    const page = await workItemRepository.findSprintIssues(sprintId, fx.workspaceId, { take: 50 });
    expect(page.map((w) => w.id)).toEqual([sprintItem.id]);
    expect(await workItemRepository.countSprintIssues(sprintId, fx.workspaceId)).toBe(1);
    // cursor branch: skipping the only row yields an empty page
    const empty = await workItemRepository.findSprintIssues(sprintId, fx.workspaceId, {
      take: 50,
      cursor: sprintItem.id,
    });
    expect(empty).toEqual([]);
  });

  it('findBacklogRankByIds returns ranks; empty input short-circuits', async () => {
    const { fx, backlog } = await seedBacklog();
    expect(await workItemRepository.findBacklogRankByIds([], fx.workspaceId)).toEqual([]);
    const ranks = await workItemRepository.findBacklogRankByIds(
      [backlog[0]!.id, backlog[2]!.id],
      fx.workspaceId,
    );
    expect(ranks.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [
        { id: backlog[0]!.id, backlogRank: 'a0' },
        { id: backlog[2]!.id, backlogRank: 'a2' },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it('findBoundaryBacklogRank returns min/max of the scope, null when empty', async () => {
    const { fx, sprintId } = await seedBacklog();
    expect(
      await workItemRepository.findBoundaryBacklogRank(fx.projectId, fx.workspaceId, null, 'min'),
    ).toBe('a0');
    expect(
      await workItemRepository.findBoundaryBacklogRank(fx.projectId, fx.workspaceId, null, 'max'),
    ).toBe('a3'); // a9 is archived → excluded
    // the sprint scope has one ranked issue
    expect(
      await workItemRepository.findBoundaryBacklogRank(
        fx.projectId,
        fx.workspaceId,
        sprintId,
        'max',
      ),
    ).toBe('b0');
    // empty scope (a fresh project) → null
    const fresh = await makeWorkItemFixture({ name: 'Fresh', identifier: 'FRS' });
    expect(
      await workItemRepository.findBoundaryBacklogRank(
        fresh.projectId,
        fresh.workspaceId,
        null,
        'min',
      ),
    ).toBeNull();
  });
});
