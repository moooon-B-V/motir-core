import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { backlogService } from '@/lib/services/backlogService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import {
  InvalidCarryOverTargetError,
  SprintNotCompletableError,
  SprintNotFoundError,
} from '@/lib/sprints/errors';

// Integration tests for Subtask 4.4.3 — `sprintsService.completeSprint`, the
// close half of the sprint lifecycle. Real Postgres (no mocks except the one
// injected repo-spy that forces a mid-batch rollback), per CLAUDE.md. Proves
// the active→complete transition, the done/unfinished split via the project's
// done-category set, carry-over to the backlog AND into a planned sprint (one
// transaction, rollback on partial failure), the freed one-active slot, the
// no-incomplete case, the carry-over-target + state guards, the per-move
// revisions, and the finding-#26 tenancy gate.

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Move an issue directly into a done-category status (the default workflow
 *  seeds `done`/`cancelled` as `category = done`). Bypasses the transition
 *  service — that's a sibling concern; here we only need the issue to read as
 *  finished for the done/unfinished split. */
async function markDone(itemId: string): Promise<void> {
  await db.workItem.update({ where: { id: itemId }, data: { status: 'done' } });
}

/** How many revision rows an issue has accumulated. */
function revisionCount(workItemId: string): Promise<number> {
  return db.workItemRevision.count({ where: { workItemId } });
}

/** Create N issues committed to `sprintId`, returning their ids in order. */
async function seedSprintIssues(
  fx: WorkItemFixture,
  sprintId: string,
  count: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const issue = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: `issue ${i}` },
      fx.ctx,
    );
    await backlogService.assignToSprint(issue.id, sprintId, undefined, fx.ctx);
    ids.push(issue.id);
  }
  return ids;
}

describe('sprintsService.completeSprint', () => {
  it('completes an active sprint, carries unfinished issues to the backlog, leaves done issues on the sprint', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Sprint 1' }, fx.ctx);
    const [a, b, c] = await seedSprintIssues(fx, sprint.id, 3);
    await markDone(c!); // c is finished; a + b are not
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);

    const completed = await sprintsService.completeSprint(sprint.id, {}, fx.ctx); // default backlog

    expect(completed.state).toBe('complete');
    expect(completed.completedAt).not.toBeNull();
    // The done issue stayed on the sprint; the two unfinished went to the backlog.
    expect(completed.issueCount).toBe(1);
    expect((await db.workItem.findUnique({ where: { id: a! } }))!.sprintId).toBeNull();
    expect((await db.workItem.findUnique({ where: { id: b! } }))!.sprintId).toBeNull();
    expect((await db.workItem.findUnique({ where: { id: c! } }))!.sprintId).toBe(sprint.id);

    // The freed one-active slot lets a new sprint start.
    const next = await sprintsService.createSprint(fx.projectId, { name: 'Sprint 2' }, fx.ctx);
    const started = await sprintsService.startSprint(next.id, {}, fx.ctx);
    expect(started.state).toBe('active');
  });

  it('records a sprintId-clearing revision per carried-over issue (and none for the done issue)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    const [a, done] = await seedSprintIssues(fx, sprint.id, 2);
    await markDone(done!);
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);

    const beforeA = await revisionCount(a!);
    const beforeDone = await revisionCount(done!);
    await sprintsService.completeSprint(sprint.id, { carryOverTo: 'backlog' }, fx.ctx);

    expect(await revisionCount(a!)).toBe(beforeA + 1); // the carry-over move
    expect(await revisionCount(done!)).toBe(beforeDone); // untouched
  });

  it('carries unfinished issues into a same-project planned sprint, appended to its rank tail in order', async () => {
    const fx = await makeWorkItemFixture();
    const active = await sprintsService.createSprint(fx.projectId, { name: 'Active' }, fx.ctx);
    const target = await sprintsService.createSprint(fx.projectId, { name: 'Next' }, fx.ctx);
    const [a, b, c] = await seedSprintIssues(fx, active.id, 3);
    await markDone(c!);
    await sprintsService.startSprint(active.id, {}, fx.ctx);

    await sprintsService.completeSprint(
      active.id,
      { carryOverTo: { sprintId: target.id } },
      fx.ctx,
    );

    // a + b moved into the target sprint; c (done) stayed on the completed one.
    expect((await db.workItem.findUnique({ where: { id: a! } }))!.sprintId).toBe(target.id);
    expect((await db.workItem.findUnique({ where: { id: b! } }))!.sprintId).toBe(target.id);
    expect((await db.workItem.findUnique({ where: { id: c! } }))!.sprintId).toBe(active.id);

    // They are appended in their original order (a before b by backlogRank).
    const page = await backlogService.getSprintIssues(target.id, {}, fx.ctx);
    expect(page.items.map((i) => i.id)).toEqual([a, b]);
  });

  it('completes a sprint with no incomplete work items (no-op carry-over)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    const [a, b] = await seedSprintIssues(fx, sprint.id, 2);
    await markDone(a!);
    await markDone(b!);
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);

    const completed = await sprintsService.completeSprint(sprint.id, {}, fx.ctx);

    expect(completed.state).toBe('complete');
    expect(completed.issueCount).toBe(2); // both done issues stay
    expect((await db.workItem.findUnique({ where: { id: a! } }))!.sprintId).toBe(sprint.id);
    expect((await db.workItem.findUnique({ where: { id: b! } }))!.sprintId).toBe(sprint.id);
  });

  it('moves the WHOLE unfinished set in ONE transaction — a mid-batch failure rolls back all of it', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    const ids = await seedSprintIssues(fx, sprint.id, 3); // all unfinished
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);

    // Inject a failure on the SECOND setSprint call (first succeeds, mid-batch).
    const original = workItemRepository.setSprint.bind(workItemRepository);
    let calls = 0;
    vi.spyOn(workItemRepository, 'setSprint').mockImplementation(async (itemId, sprintId, tx) => {
      calls += 1;
      if (calls === 2) throw new Error('injected mid-batch failure');
      return original(itemId, sprintId, tx);
    });

    await expect(sprintsService.completeSprint(sprint.id, {}, fx.ctx)).rejects.toThrow(
      'injected mid-batch failure',
    );
    vi.restoreAllMocks();

    // Atomic rollback: the sprint is still active and NONE of the issues moved.
    const sprintRow = await db.sprint.findUnique({ where: { id: sprint.id } });
    expect(sprintRow!.state).toBe('active');
    expect(sprintRow!.completedAt).toBeNull();
    for (const id of ids) {
      expect((await db.workItem.findUnique({ where: { id } }))!.sprintId).toBe(sprint.id);
    }
  });

  it('rejects completing a sprint that is not active (planned → 422)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    await expect(sprintsService.completeSprint(sprint.id, {}, fx.ctx)).rejects.toBeInstanceOf(
      SprintNotCompletableError,
    );
  });

  it('rejects completing an already-complete sprint (422)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);
    await sprintsService.completeSprint(sprint.id, {}, fx.ctx);

    await expect(sprintsService.completeSprint(sprint.id, {}, fx.ctx)).rejects.toBeInstanceOf(
      SprintNotCompletableError,
    );
  });

  it('rejects a carry-over target in another project (InvalidCarryOverTargetError)', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const active = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    // A planned sprint, but in the OTHER project (same workspace would still be
    // wrong-project; here it's another workspace entirely — doubly invalid).
    const foreignTarget = await sprintsService.createSprint(other.projectId, {}, other.ctx);
    await sprintsService.startSprint(active.id, {}, fx.ctx);

    await expect(
      sprintsService.completeSprint(
        active.id,
        { carryOverTo: { sprintId: foreignTarget.id } },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidCarryOverTargetError);
  });

  it('rejects a carry-over target that is not in the planned state', async () => {
    const fx = await makeWorkItemFixture();
    const active = await sprintsService.createSprint(fx.projectId, { name: 'Active' }, fx.ctx);
    await sprintsService.startSprint(active.id, {}, fx.ctx);
    // The only other sprint is the active one itself → not a planned target.
    await expect(
      sprintsService.completeSprint(active.id, { carryOverTo: { sprintId: active.id } }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidCarryOverTargetError);
  });

  it('rejects an unknown carry-over target', async () => {
    const fx = await makeWorkItemFixture();
    const active = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    await sprintsService.startSprint(active.id, {}, fx.ctx);
    await expect(
      sprintsService.completeSprint(
        active.id,
        { carryOverTo: { sprintId: 'nonexistent' } },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidCarryOverTargetError);
  });

  it('404s a sprint outside the active workspace (finding-#26 tenancy gate)', async () => {
    const a = await makeWorkItemFixture({ name: 'Tenant A', identifier: 'AAA' });
    const b = await makeWorkItemFixture({ name: 'Tenant B', identifier: 'BBB' });
    const sprint = await sprintsService.createSprint(a.projectId, {}, a.ctx);
    await sprintsService.startSprint(sprint.id, {}, a.ctx);

    // Tenant B trying to complete tenant A's sprint sees a 404, not A's sprint.
    await expect(sprintsService.completeSprint(sprint.id, {}, b.ctx)).rejects.toBeInstanceOf(
      SprintNotFoundError,
    );
  });
});
