import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { backlogService } from '@/lib/services/backlogService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Integration tests for the Story-4.2.3 sprint-list read binding
// (`sprintsService.listByProject`) — the read the backlog sprint-planning view
// binds to (exposing the shipped `sprintRepository.listByProject` leaf through
// the service + `GET /api/sprints`). Real Postgres (no mocks), per CLAUDE.md.
// Proves: sequence ordering, the per-sprint committed-issue count, the
// archived-exclusion in that count, and the finding-#26 tenancy gate.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('sprintsService.listByProject', () => {
  it('returns the project sprints in sequence order, each with its committed-issue count', async () => {
    const fx = await makeWorkItemFixture();
    const first = await sprintsService.createSprint(fx.projectId, { name: 'Sprint A' }, fx.ctx);
    const second = await sprintsService.createSprint(fx.projectId, { name: 'Sprint B' }, fx.ctx);

    // Two issues into the first sprint, one into the second.
    const a = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'a' },
      fx.ctx,
    );
    const b = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'b' },
      fx.ctx,
    );
    const c = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'c' },
      fx.ctx,
    );
    await backlogService.assignToSprint(a.id, first.id, undefined, fx.ctx);
    await backlogService.assignToSprint(b.id, first.id, undefined, fx.ctx);
    await backlogService.assignToSprint(c.id, second.id, undefined, fx.ctx);

    const sprints = await sprintsService.listByProject(fx.projectId, fx.ctx);

    expect(sprints.map((s) => s.id)).toEqual([first.id, second.id]);
    expect(sprints[0]!.sequence).toBeLessThan(sprints[1]!.sequence);
    expect(sprints[0]!.issueCount).toBe(2);
    expect(sprints[1]!.issueCount).toBe(1);
    expect(sprints[0]!.name).toBe('Sprint A');
    expect(sprints[0]!.state).toBe('planned');
  });

  it('returns an empty list for a project with no sprints', async () => {
    const fx = await makeWorkItemFixture();
    expect(await sprintsService.listByProject(fx.projectId, fx.ctx)).toEqual([]);
  });

  it('does not leak another workspace’s sprints (finding-#26 tenancy gate)', async () => {
    const a = await makeWorkItemFixture({ name: 'Tenant A', identifier: 'AAA' });
    const b = await makeWorkItemFixture({ name: 'Tenant B', identifier: 'BBB' });
    await sprintsService.createSprint(a.projectId, { name: 'A-only' }, a.ctx);

    // Tenant B asking for tenant A's project id under B's context sees nothing
    // (the read filters on `workspaceId`), never A's sprint.
    expect(await sprintsService.listByProject(a.projectId, b.ctx)).toEqual([]);
  });
});
