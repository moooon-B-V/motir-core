import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { backlogService } from '@/lib/services/backlogService';
import { estimationService } from '@/lib/services/estimationService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-1495 (AC #2) — the ACTIVE sprint's scope-lock committed baseline is an
// IMMUTABLE stored `sprint.committedPoints` stamped once at activation (Jira-style
// scope lock), distinct from the planned-sprint committed figure the backlog badge
// re-computes ON-READ. The MOTIR-1495 fix is client-side ONLY (the badge re-fetch);
// it must not — and does not — move this baseline. This test pins that guarantee:
// changing an active-sprint item's story points shifts the LIVE roll-up but leaves
// the stored `committedPoints` snapshot exactly where activation stamped it.
// Real Postgres, no mocks (the project convention).

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

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

describe('active sprint committed-points baseline is immutable (MOTIR-1495 AC #2)', () => {
  it('an in-sprint point edit changes the live roll-up but NOT the stored baseline', async () => {
    const fx = await makeWorkItemFixture();

    // Plan a sprint with two estimated issues (3 + 5 = 8 committed points).
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Sprint 1' }, fx.ctx);
    const [a, b] = await seedSprintIssues(fx, sprint.id, 2);
    await estimationService.setEstimate(a!, 3, fx.ctx);
    await estimationService.setEstimate(b!, 5, fx.ctx);

    // Start: the scope-lock committed baseline is stamped (8) and frozen.
    const started = await sprintsService.startSprint(sprint.id, {}, fx.ctx);
    expect(started.state).toBe('active');
    expect(started.committedPoints).toBe(8);

    // Re-estimate an in-sprint item AFTER activation (3 → 13): the live roll-up
    // reflects it (8 → 18)…
    await estimationService.setEstimate(a!, 13, fx.ctx);
    const liveRollup = await estimationService.rollupForSprint(sprint.id, fx.ctx);
    expect(liveRollup.committed).toBe(18);

    // …but the stored scope-lock baseline is UNCHANGED — still the 8 stamped at
    // activation (read straight from the row, not the live compute).
    const row = await db.sprint.findUniqueOrThrow({ where: { id: sprint.id } });
    expect(row.committedPoints === null ? null : Number(row.committedPoints)).toBe(8);
  });
});
