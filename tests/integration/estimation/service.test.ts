import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { estimationService } from '@/lib/services/estimationService';
import { workItemsService } from '@/lib/services/workItemsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { backlogService } from '@/lib/services/backlogService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { SprintNotFoundError } from '@/lib/sprints/errors';
import {
  EstimationConfigForbiddenError,
  InvalidEstimateError,
  InvalidScaleConfigError,
} from '@/lib/estimation/errors';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { WorkItemDto } from '@/lib/dto/workItems';

// Integration tests for the Story-4.3 estimationService (Subtask 4.3.3): the
// per-issue story-point WRITE, the project estimation-config CRUD, and the
// BOUNDED sprint/epic roll-up aggregates (the reusable `rollupForSprint` Story
// 4.5.2 consumes). Real Postgres (no mocks), per CLAUDE.md. The component +
// at-SCALE (`db:seed:large`) + E2E coverage is Story 4.3.7; here we prove the
// estimate/config/roll-up BEHAVIOUR + the finding-#26 tenancy gate + the
// finding-#21 done-category predicate + the statistic switch.

async function revisionCount(workItemId: string): Promise<number> {
  return db.workItemRevision.count({ where: { workItemId } });
}

/** Stamp a `done`-category status on an issue (the test-direct status set the
 *  work-item suites use), so the sprint `completed` predicate counts it. */
async function markDone(id: string): Promise<void> {
  await db.workItem.update({ where: { id }, data: { status: 'done' } });
}

async function createTask(fx: WorkItemFixture, title: string): Promise<WorkItemDto> {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('estimationService.setEstimate', () => {
  it('writes storyPoints in one transaction, records a 1.4.6 revision, and maps the DTO', async () => {
    const fx = await makeWorkItemFixture({ name: 'Estimate' });
    const item = await createTask(fx, 'A');
    const before = await revisionCount(item.id);

    const updated = await estimationService.setEstimate(item.id, 5, fx.ctx);

    expect(updated.storyPoints).toBe(5);
    expect(await revisionCount(item.id)).toBe(before + 1);
    const reread = await workItemRepository.findById(item.id);
    expect(reread?.storyPoints?.toString()).toBe('5');
  });

  it('accepts a decimal (Jira-faithful 0.5 increments)', async () => {
    const fx = await makeWorkItemFixture({ name: 'Half' });
    const item = await createTask(fx, 'A');
    const updated = await estimationService.setEstimate(item.id, 0.5, fx.ctx);
    expect(updated.storyPoints).toBe(0.5);
  });

  it('clears the estimate when points is null', async () => {
    const fx = await makeWorkItemFixture({ name: 'Clear' });
    const item = await createTask(fx, 'A');
    await estimationService.setEstimate(item.id, 8, fx.ctx);
    const cleared = await estimationService.setEstimate(item.id, null, fx.ctx);
    expect(cleared.storyPoints).toBeNull();
  });

  it('rejects a negative, out-of-range, or over-precise value with InvalidEstimateError', async () => {
    const fx = await makeWorkItemFixture({ name: 'Bad' });
    const item = await createTask(fx, 'A');
    await expect(estimationService.setEstimate(item.id, -1, fx.ctx)).rejects.toBeInstanceOf(
      InvalidEstimateError,
    );
    await expect(estimationService.setEstimate(item.id, 100000, fx.ctx)).rejects.toBeInstanceOf(
      InvalidEstimateError,
    );
    await expect(estimationService.setEstimate(item.id, 1.234, fx.ctx)).rejects.toBeInstanceOf(
      InvalidEstimateError,
    );
    await expect(estimationService.setEstimate(item.id, Number.NaN, fx.ctx)).rejects.toBeInstanceOf(
      InvalidEstimateError,
    );
  });

  it('is denied cross-workspace (finding #26) with WorkItemNotFoundError', async () => {
    const fx = await makeWorkItemFixture({ name: 'Owner' });
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const item = await createTask(fx, 'A');
    await expect(estimationService.setEstimate(item.id, 3, other.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });
});

describe('estimationService getEstimationConfig / updateEstimationConfig', () => {
  it('defaults to Story Points + Fibonacci on a fresh project', async () => {
    const fx = await makeWorkItemFixture({ name: 'Config' });
    const config = await estimationService.getEstimationConfig(fx.projectId, fx.ctx);
    expect(config).toEqual({
      estimationStatistic: 'story_points',
      pointScale: 'fibonacci',
      customScaleValues: [],
    });
  });

  it('round-trips the statistic + scale + custom values (admin)', async () => {
    const fx = await makeWorkItemFixture({ name: 'RT' });
    const updated = await estimationService.updateEstimationConfig(
      fx.projectId,
      { estimationStatistic: 'time_estimate', pointScale: 'custom', customScaleValues: [1, 2, 4] },
      fx.ctx,
    );
    expect(updated).toEqual({
      estimationStatistic: 'time_estimate',
      pointScale: 'custom',
      customScaleValues: [1, 2, 4],
    });
    const reread = await estimationService.getEstimationConfig(fx.projectId, fx.ctx);
    expect(reread.pointScale).toBe('custom');
  });

  it('rejects an empty custom-scale deck (the empty-input guard) and bad enums with InvalidScaleConfigError', async () => {
    const fx = await makeWorkItemFixture({ name: 'BadCfg' });
    await expect(
      estimationService.updateEstimationConfig(
        fx.projectId,
        { pointScale: 'custom', customScaleValues: [] },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidScaleConfigError);
    await expect(
      estimationService.updateEstimationConfig(fx.projectId, { customScaleValues: [-3] }, fx.ctx),
    ).rejects.toBeInstanceOf(InvalidScaleConfigError);
    await expect(
      estimationService.updateEstimationConfig(
        fx.projectId,
        { estimationStatistic: 'bogus' as never },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidScaleConfigError);
    await expect(
      estimationService.updateEstimationConfig(
        fx.projectId,
        { pointScale: 'bogus' as never },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidScaleConfigError);
  });

  it('rejects a non-admin actor with EstimationConfigForbiddenError', async () => {
    const fx = await makeWorkItemFixture({ name: 'Gate' });
    const stranger = { userId: 'not-a-member', workspaceId: fx.workspaceId };
    await expect(
      estimationService.updateEstimationConfig(fx.projectId, { pointScale: 'linear' }, stranger),
    ).rejects.toBeInstanceOf(EstimationConfigForbiddenError);
  });

  it('404s an unknown / cross-workspace project', async () => {
    const fx = await makeWorkItemFixture({ name: 'CfgWS' });
    const other = await makeWorkItemFixture({ name: 'CfgOther', identifier: 'OTH2' });
    await expect(
      estimationService.getEstimationConfig(fx.projectId, other.ctx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('estimationService.rollupForSprint (bounded — finding #57)', () => {
  it('returns committed / completed / remaining, counting only done-category issues as completed', async () => {
    const fx = await makeWorkItemFixture({ name: 'Sprint' });
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    const a = await createTask(fx, 'A');
    const b = await createTask(fx, 'B');
    const c = await createTask(fx, 'C');
    await estimationService.setEstimate(a.id, 3, fx.ctx);
    await estimationService.setEstimate(b.id, 5, fx.ctx);
    await estimationService.setEstimate(c.id, 2, fx.ctx);
    for (const i of [a, b, c])
      await backlogService.assignToSprint(i.id, sprint.id, undefined, fx.ctx);
    await markDone(a.id); // only A is done → completed = 3

    const roll = await estimationService.rollupForSprint(sprint.id, fx.ctx);
    expect(roll).toEqual({ committed: 10, completed: 3, remaining: 7 });
  });

  it('returns {0,0,0} for a wholly unestimated sprint (no NaN)', async () => {
    const fx = await makeWorkItemFixture({ name: 'EmptySprint' });
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    const a = await createTask(fx, 'A');
    await backlogService.assignToSprint(a.id, sprint.id, undefined, fx.ctx);
    expect(await estimationService.rollupForSprint(sprint.id, fx.ctx)).toEqual({
      committed: 0,
      completed: 0,
      remaining: 0,
    });
  });

  it('handles a sprint with no issues at all (the empty-aggregate guard)', async () => {
    const fx = await makeWorkItemFixture({ name: 'ZeroSprint' });
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    expect(await estimationService.rollupForSprint(sprint.id, fx.ctx)).toEqual({
      committed: 0,
      completed: 0,
      remaining: 0,
    });
  });

  it('sums the TIME estimate when the statistic is switched to time_estimate', async () => {
    const fx = await makeWorkItemFixture({ name: 'TimeStat' });
    await estimationService.updateEstimationConfig(
      fx.projectId,
      { estimationStatistic: 'time_estimate' },
      fx.ctx,
    );
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    const a = await createTask(fx, 'A');
    const b = await createTask(fx, 'B');
    await db.workItem.update({ where: { id: a.id }, data: { estimateMinutes: 60 } });
    await db.workItem.update({ where: { id: b.id }, data: { estimateMinutes: 30 } });
    await estimationService.setEstimate(a.id, 99, fx.ctx); // story points ignored under time stat
    for (const i of [a, b]) await backlogService.assignToSprint(i.id, sprint.id, undefined, fx.ctx);
    await markDone(b.id);

    expect(await estimationService.rollupForSprint(sprint.id, fx.ctx)).toEqual({
      committed: 90,
      completed: 30,
      remaining: 60,
    });
  });

  it('counts issues when the statistic is switched to issue_count', async () => {
    const fx = await makeWorkItemFixture({ name: 'CountStat' });
    await estimationService.updateEstimationConfig(
      fx.projectId,
      { estimationStatistic: 'issue_count' },
      fx.ctx,
    );
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    const a = await createTask(fx, 'A');
    const b = await createTask(fx, 'B');
    for (const i of [a, b]) await backlogService.assignToSprint(i.id, sprint.id, undefined, fx.ctx);
    await markDone(a.id);
    expect(await estimationService.rollupForSprint(sprint.id, fx.ctx)).toEqual({
      committed: 2,
      completed: 1,
      remaining: 1,
    });
  });

  it('404s an unknown / cross-workspace sprint', async () => {
    const fx = await makeWorkItemFixture({ name: 'SprintWS' });
    const other = await makeWorkItemFixture({ name: 'SprintOther', identifier: 'OTH3' });
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    await expect(estimationService.rollupForSprint(sprint.id, other.ctx)).rejects.toBeInstanceOf(
      SprintNotFoundError,
    );
  });
});

describe('estimationService.rollupForParent (recursive subtree — finding #57)', () => {
  it('sums story points over the whole subtree (a grandchild rolls into the epic)', async () => {
    const fx = await makeWorkItemFixture({ name: 'Tree' });
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story', parentId: epic.id },
      fx.ctx,
    );
    const task = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Task', parentId: story.id },
      fx.ctx,
    );
    await estimationService.setEstimate(story.id, 5, fx.ctx);
    await estimationService.setEstimate(task.id, 3, fx.ctx); // a grandchild of the epic
    await estimationService.setEstimate(epic.id, 99, fx.ctx); // the epic's OWN estimate is excluded

    expect(await estimationService.rollupForParent(epic.id, fx.ctx)).toEqual({ total: 8 });
  });

  it('returns {total:0} for a parent with no children (the empty-subtree guard)', async () => {
    const fx = await makeWorkItemFixture({ name: 'Leaf' });
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
      fx.ctx,
    );
    expect(await estimationService.rollupForParent(epic.id, fx.ctx)).toEqual({ total: 0 });
  });

  it('counts subtree issues when the statistic is issue_count', async () => {
    const fx = await makeWorkItemFixture({ name: 'TreeCount' });
    await estimationService.updateEstimationConfig(
      fx.projectId,
      { estimationStatistic: 'issue_count' },
      fx.ctx,
    );
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
      fx.ctx,
    );
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Story', parentId: epic.id },
      fx.ctx,
    );
    await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Task', parentId: story.id },
      fx.ctx,
    );
    expect(await estimationService.rollupForParent(epic.id, fx.ctx)).toEqual({ total: 2 });
  });

  it('404s an unknown / cross-workspace parent', async () => {
    const fx = await makeWorkItemFixture({ name: 'ParentWS' });
    const other = await makeWorkItemFixture({ name: 'ParentOther', identifier: 'OTH4' });
    const epic = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Epic' },
      fx.ctx,
    );
    await expect(estimationService.rollupForParent(epic.id, other.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });
});
