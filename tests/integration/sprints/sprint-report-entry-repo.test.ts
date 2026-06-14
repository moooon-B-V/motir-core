import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { backlogService } from '@/lib/services/backlogService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { sprintReportEntryRepository } from '@/lib/repositories/sprintReportEntryRepository';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Direct repository coverage for the frozen sprint-report snapshot
// (bug-sprint-report-incomplete-list-zero-after-carry-over). Real Postgres (no
// mocks), per CLAUDE.md. Covers the `db`-singleton (no-`tx`) read path of the
// new revision method and the snapshot repo's empty-input edges — the branches
// the service integration tests (which always pass a `tx` / a populated sprint)
// don't reach.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function addIssue(fx: WorkItemFixture, sprintId: string, title: string): Promise<string> {
  const issue = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title },
    fx.ctx,
  );
  await backlogService.assignToSprint(issue.id, sprintId, undefined, fx.ctx);
  return issue.id;
}

describe('workItemRevisionRepository.findItemIdsAddedToSprintAfter (no tx)', () => {
  it('returns the ids of issues associated with the sprint after its startDate', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S' }, fx.ctx);
    const before = await addIssue(fx, sprint.id, 'before'); // committed before start
    await sprintsService.startSprint(sprint.id, {}, fx.ctx);
    const after = await addIssue(fx, sprint.id, 'after'); // associated after start

    const row = await db.sprint.findUniqueOrThrow({
      where: { id: sprint.id },
      select: { startDate: true },
    });
    // Called WITHOUT a tx → the `db` singleton read path.
    const ids = await workItemRevisionRepository.findItemIdsAddedToSprintAfter(
      sprint.id,
      fx.ctx.workspaceId,
      row.startDate!,
    );
    expect(ids).toEqual([after]);
    expect(ids).not.toContain(before);
  });
});

describe('sprintReportEntryRepository read edges (empty snapshot)', () => {
  it('returns 0 / [] for a sprint with no snapshot rows (the totals stay total)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S' }, fx.ctx);

    const ws = fx.ctx.workspaceId;
    expect(await sprintReportEntryRepository.countByCompletion(sprint.id, ws, true)).toBe(0);
    expect(await sprintReportEntryRepository.countByCompletion(sprint.id, ws, false)).toBe(0);
    expect(await sprintReportEntryRepository.countAddedAfterStart(sprint.id, ws)).toBe(0);
    expect(
      await sprintReportEntryRepository.findByCompletion(sprint.id, ws, {
        completed: false,
        take: 50,
      }),
    ).toEqual([]);
    expect(
      await sprintReportEntryRepository.sumPointsByCompletion(sprint.id, ws, 'story_points'),
    ).toEqual({ completed: 0, notCompleted: 0 });
  });
});
