import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { makeWorkItemFixture, createTestWorkItem } from '../../fixtures';
import type { Prisma, WorkItem } from '@/generated/prisma/client';

// Repository-layer tests for the Story-4.1 sprint + backlog-rank data-access
// leaves (Subtask 4.1.2): sprintRepository + the new work_item sprint/rank
// methods on workItemRepository. Real Postgres (no mocks), per CLAUDE.md.
//
// ⚠️ THIS FILE RUNS ITS WRITES THROUGH `adminDb` ON PURPOSE (MOTIR-2739/2747).
// Its subject, stated below, is the application's explicit `workspaceId` WHERE-clause
// gate — asserted with RLS deliberately OUT of the picture. Under the non-bypass role
// a cross-workspace read returns [] because the POLICY hid the row, which is the same
// observation for a different reason and would make every gate assertion here vacuous.
// This is the one shape where keeping the code under test on the admin client is what
// PRESERVES the claim rather than weakening it; the policy's own behaviour is proved
// separately, under the role, in the *-rls suites.
//
// These assert the repository CONTRACT — single-Prisma-op reads/writes, the
// required-`tx` on writes (exercised inside a real `db.$transaction`), the
// explicit `workspaceId` gate (finding #26 — a cross-workspace read returns
// [] / null under the BYPASSRLS superuser, proving the WHERE-clause gate not
// the RLS policy), the bounded/cursor backlog reads (finding #57 — take+1),
// and the empty-input short-circuit the coverage gate needs covered. The
// state-machine + association BEHAVIOUR (guards, carry-over, scale) is Story
// 4.1.5's dedicated suite; here we prove the leaves.
//
// ⚠️ AND THE READS RUN THROUGH IT TOO (MOTIR-2881). MOTIR-2739/2747 migrated the
// WRITES and left the assertion-side READS on the `@/lib/db` singleton — which under
// the role is `motir_app`, binds no workspace GUC, and returns NOTHING. A refused
// write says so (`42501`); a refused read just returns `null` / `[]` / `0`, so eleven
// assertions here went red while every cross-workspace gate probe passed for the
// wrong reason. Passing `a.workspaceId` as an ARGUMENT does not save them: that is
// the application's WHERE clause, not the RLS GUC, which is exactly the distinction
// this file exists to test. `readAsOwner` routes the reads through the SAME owner
// client the writes use, so a `null` here is still the WHERE-clause gate.

async function truncateAll(): Promise<void> {
  // sprint FKs workspace/project (onDelete Cascade) so the workspace truncate
  // carries it; the explicit work_item truncate mirrors the work-item repo test.
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "work_item" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
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
  const row = await adminDb.sprint.create({
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

/**
 * Run a repository READ through the OWNER client, exactly as this file's writes run.
 * The repository method under test is still what is exercised — only the connection
 * changes, so RLS stays out of the picture (see the header) and a cross-workspace
 * `null` / `[]` is the explicit `workspaceId` gate, finding #26's subject.
 */
function readAsOwner<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return adminDb.$transaction(fn);
}

/** Set a work item's backlogRank through the repository's required-`tx` write. */
async function setRank(itemId: string, rank: string): Promise<void> {
  await adminDb.$transaction((tx) => workItemRepository.setBacklogRank(itemId, rank, tx));
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
    expect((await readAsOwner((tx) => sprintRepository.findById(s, a.workspaceId, tx)))?.id).toBe(
      s,
    );
    expect(await readAsOwner((tx) => sprintRepository.findById(s, b.workspaceId, tx))).toBeNull();
  });

  it('findActiveByProject returns the single active sprint, null when none active', async () => {
    const fx = await makeWorkItemFixture();
    await makeSprint({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'Planned',
      sequence: 1,
    });
    expect(
      await readAsOwner((tx) =>
        sprintRepository.findActiveByProject(fx.projectId, fx.workspaceId, tx),
      ),
    ).toBeNull();
    const active = await makeSprint({
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: 'Active',
      sequence: 2,
      state: 'active',
    });
    expect(
      (
        await readAsOwner((tx) =>
          sprintRepository.findActiveByProject(fx.projectId, fx.workspaceId, tx),
        )
      )?.id,
    ).toBe(active);
    // cross-workspace gate
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    expect(
      await readAsOwner((tx) =>
        sprintRepository.findActiveByProject(fx.projectId, other.workspaceId, tx),
      ),
    ).toBeNull();
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
    const list = await readAsOwner((tx) =>
      sprintRepository.listByProject(fx.projectId, fx.workspaceId, tx),
    );
    expect(list.map((s) => s.name)).toEqual(['First', 'Second']);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    expect(
      await readAsOwner((tx) =>
        sprintRepository.listByProject(fx.projectId, other.workspaceId, tx),
      ),
    ).toEqual([]);
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
      await readAsOwner((tx) =>
        sprintRepository.countByProjectAndState(fx.projectId, fx.workspaceId, 'planned', tx),
      ),
    ).toBe(2);
    expect(
      await readAsOwner((tx) =>
        sprintRepository.countByProjectAndState(fx.projectId, fx.workspaceId, 'active', tx),
      ),
    ).toBe(1);
  });

  it('maxSequenceForProject returns 0 when empty, else the max', async () => {
    const fx = await makeWorkItemFixture();
    expect(
      await readAsOwner((tx) =>
        sprintRepository.maxSequenceForProject(fx.projectId, fx.workspaceId, tx),
      ),
    ).toBe(0);
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
    expect(
      await readAsOwner((tx) =>
        sprintRepository.maxSequenceForProject(fx.projectId, fx.workspaceId, tx),
      ),
    ).toBe(5);
  });
});

describe('sprintRepository — writes (required tx) + FOR-UPDATE lock', () => {
  it('create / update / delete round-trip inside a transaction', async () => {
    const fx = await makeWorkItemFixture();
    const created = await adminDb.$transaction((tx) =>
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

    const renamed = await adminDb.$transaction((tx) =>
      sprintRepository.update(created.id, { name: 'Renamed', state: 'active' }, tx),
    );
    expect(renamed.name).toBe('Renamed');
    expect(renamed.state).toBe('active');

    const deleted = await adminDb.$transaction((tx) => sprintRepository.delete(created.id, tx));
    expect(deleted.id).toBe(created.id);
    expect(
      await readAsOwner((tx) => sprintRepository.findById(created.id, fx.workspaceId, tx)),
    ).toBeNull();
  });

  it('findActiveByProjectForUpdate locks the active row, null when none active', async () => {
    const fx = await makeWorkItemFixture();
    // no active sprint yet → null
    const none = await adminDb.$transaction((tx) =>
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
    const locked = await adminDb.$transaction((tx) =>
      sprintRepository.findActiveByProjectForUpdate(fx.projectId, fx.workspaceId, tx),
    );
    expect(locked?.id).toBe(active);
    // cross-workspace gate keeps the lock tenant-scoped
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const foreign = await adminDb.$transaction((tx) =>
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

    const assigned = await adminDb.$transaction((tx) =>
      workItemRepository.setSprint(item.id, sprintId, tx),
    );
    expect(assigned.sprintId).toBe(sprintId);

    const backToBacklog = await adminDb.$transaction((tx) =>
      workItemRepository.setSprint(item.id, null, tx),
    );
    expect(backToBacklog.sprintId).toBeNull();
  });

  it('setSprint on a missing item throws WorkItemNotFoundError', async () => {
    await expect(
      adminDb.$transaction((tx) => workItemRepository.setSprint('nope', null, tx)),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});

describe('workItemRepository — backlog rank (setBacklogRank)', () => {
  it('persists the rank string (single-row write)', async () => {
    const fx = await makeWorkItemFixture();
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'T' });
    await setRank(item.id, 'a5');
    const reread = await adminDb.workItem.findUnique({ where: { id: item.id } });
    expect(reread?.backlogRank).toBe('a5');
  });

  it('setBacklogRank on a missing item throws WorkItemNotFoundError', async () => {
    await expect(
      adminDb.$transaction((tx) => workItemRepository.setBacklogRank('nope', 'a0', tx)),
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
    await adminDb.$transaction((tx) => workItemRepository.setSprint(sprintItem.id, sprintId, tx));
    // one archived backlog issue — must be excluded from reads/counts
    const archived = await createTestWorkItem(fx, { kind: 'task', title: 'Gone' });
    await setRank(archived.id, 'a9');
    await adminDb.$transaction((tx) => workItemRepository.archive(archived.id, tx));
    return { fx, sprintId, backlog, sprintItem };
  }

  it('findBacklogPage returns backlog issues in rank order, fetching take+1', async () => {
    const { fx, backlog } = await seedBacklog();
    // take=2 → take+1=3 rows so the service can detect a next page
    const page = await readAsOwner((tx) =>
      workItemRepository.findBacklogPage(fx.projectId, fx.workspaceId, { take: 2 }, tx),
    );
    expect(page).toHaveLength(3);
    expect(page.map((w) => w.id)).toEqual([backlog[0]!.id, backlog[1]!.id, backlog[2]!.id]);
    // excludes sprint-committed + archived issues
    expect(page.every((w) => w.sprintId === null)).toBe(true);
  });

  it('findBacklogPage honours the cursor (skips the cursor row)', async () => {
    const { fx, backlog } = await seedBacklog();
    const page = await readAsOwner((tx) =>
      workItemRepository.findBacklogPage(
        fx.projectId,
        fx.workspaceId,
        { take: 2, cursor: backlog[0]!.id },
        tx,
      ),
    );
    expect(page.map((w) => w.id)).toEqual([backlog[1]!.id, backlog[2]!.id, backlog[3]!.id]);
  });

  it('findBacklogPage is workspace-gated', async () => {
    const { fx } = await seedBacklog();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    expect(
      await readAsOwner((tx) =>
        workItemRepository.findBacklogPage(fx.projectId, other.workspaceId, { take: 50 }, tx),
      ),
    ).toEqual([]);
  });

  it('countBacklog counts only non-archived backlog issues', async () => {
    const { fx } = await seedBacklog();
    expect(
      await readAsOwner((tx) =>
        workItemRepository.countBacklog(fx.projectId, fx.workspaceId, [], undefined, tx),
      ),
    ).toBe(4);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    expect(
      await readAsOwner((tx) =>
        workItemRepository.countBacklog(fx.projectId, other.workspaceId, [], undefined, tx),
      ),
    ).toBe(0);
  });

  it('findSprintIssues + countSprintIssues return the sprint set (cursor honoured)', async () => {
    const { fx, sprintId, sprintItem } = await seedBacklog();
    const page = await readAsOwner((tx) =>
      workItemRepository.findSprintIssues(sprintId, fx.workspaceId, { take: 50 }, tx),
    );
    expect(page.map((w) => w.id)).toEqual([sprintItem.id]);
    expect(
      await readAsOwner((tx) =>
        workItemRepository.countSprintIssues(sprintId, fx.workspaceId, undefined, tx),
      ),
    ).toBe(1);
    // cursor branch: skipping the only row yields an empty page
    const empty = await readAsOwner((tx) =>
      workItemRepository.findSprintIssues(
        sprintId,
        fx.workspaceId,
        { take: 50, cursor: sprintItem.id },
        tx,
      ),
    );
    expect(empty).toEqual([]);
  });

  it('findBacklogRankByIds returns ranks; empty input short-circuits', async () => {
    const { fx, backlog } = await seedBacklog();
    expect(
      await readAsOwner((tx) => workItemRepository.findBacklogRankByIds([], fx.workspaceId, tx)),
    ).toEqual([]);
    const ranks = await readAsOwner((tx) =>
      workItemRepository.findBacklogRankByIds([backlog[0]!.id, backlog[2]!.id], fx.workspaceId, tx),
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
      await readAsOwner((tx) =>
        workItemRepository.findBoundaryBacklogRank(fx.projectId, fx.workspaceId, null, 'min', tx),
      ),
    ).toBe('a0');
    expect(
      await readAsOwner((tx) =>
        workItemRepository.findBoundaryBacklogRank(fx.projectId, fx.workspaceId, null, 'max', tx),
      ),
    ).toBe('a3'); // a9 is archived → excluded
    // the sprint scope has one ranked issue
    expect(
      await readAsOwner((tx) =>
        workItemRepository.findBoundaryBacklogRank(
          fx.projectId,
          fx.workspaceId,
          sprintId,
          'max',
          tx,
        ),
      ),
    ).toBe('b0');
    // empty scope (a fresh project) → null
    const fresh = await makeWorkItemFixture({ name: 'Fresh', identifier: 'FRS' });
    expect(
      await readAsOwner((tx) =>
        workItemRepository.findBoundaryBacklogRank(
          fresh.projectId,
          fresh.workspaceId,
          null,
          'min',
          tx,
        ),
      ),
    ).toBeNull();
  });
});
