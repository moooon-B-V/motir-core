import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { backlogService } from '@/lib/services/backlogService';
import { boardsService } from '@/lib/services/boardsService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import {
  SprintAlreadyActiveError,
  SprintNotFoundError,
  SprintNotStartableError,
  SprintWindowInvalidError,
} from '@/lib/sprints/errors';

// Integration tests for Subtask 4.4.2 — `sprintsService.startSprint`, the head
// of the sprint lifecycle. Real Postgres (no mocks), per CLAUDE.md. Proves the
// transition + one-active guard + window validation + the immutable scope-lock
// baseline + the idempotent "board opens" scrum-board provisioning, plus the
// finding-#26 tenancy gate.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Give an issue a story-point estimate directly (the estimation service is a
 *  sibling Story 4.3 not yet on this branch; the column ships in 4.3.1). */
async function setPoints(itemId: string, points: number): Promise<void> {
  await db.workItem.update({ where: { id: itemId }, data: { storyPoints: points } });
}

describe('sprintsService.startSprint', () => {
  it('activates a planned sprint: stamps the window + the committed baseline and opens a scrum board', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Sprint 1' }, fx.ctx);

    // Two estimated issues + one unestimated, all committed to the sprint.
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
    await backlogService.assignToSprint(a.id, sprint.id, undefined, fx.ctx);
    await backlogService.assignToSprint(b.id, sprint.id, undefined, fx.ctx);
    await backlogService.assignToSprint(c.id, sprint.id, undefined, fx.ctx);
    await setPoints(a.id, 3);
    await setPoints(b.id, 1.5); // fractional — proves Decimal (not Int) baseline

    const start = '2026-06-09T00:00:00.000Z';
    const end = '2026-06-23T00:00:00.000Z';
    const started = await sprintsService.startSprint(
      sprint.id,
      { startDate: start, endDate: end },
      fx.ctx,
    );

    expect(started.state).toBe('active');
    expect(started.startDate).toBe(start);
    expect(started.endDate).toBe(end);
    expect(started.committedIssueCount).toBe(3);
    expect(started.committedPoints).toBe(4.5); // 3 + 1.5; the NULL issue adds 0

    // "Board opens": the project now has exactly one scrum board (alongside the
    // auto-seeded kanban board).
    const boards = await boardsService.listBoards(fx.projectId, fx.ctx);
    expect(boards.filter((board) => board.type === 'scrum')).toHaveLength(1);
  });

  it('defaults startDate to now when omitted, allows a null endDate, and renames on start', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'Old name' }, fx.ctx);

    const before = Date.now();
    const started = await sprintsService.startSprint(sprint.id, { name: 'Renamed' }, fx.ctx);
    const after = Date.now();

    expect(started.state).toBe('active');
    expect(started.name).toBe('Renamed');
    expect(started.endDate).toBeNull();
    expect(started.startDate).not.toBeNull();
    const stampedAt = new Date(started.startDate!).getTime();
    expect(stampedAt).toBeGreaterThanOrEqual(before);
    expect(stampedAt).toBeLessThanOrEqual(after);
  });

  it('stamps an edited goal in the activation transaction (finding #68), and persists it', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(
      fx.projectId,
      { name: 'Sprint 1', goal: 'Old goal' },
      fx.ctx,
    );

    const started = await sprintsService.startSprint(
      sprint.id,
      { goal: 'Ship the lifecycle' },
      fx.ctx,
    );

    // The DTO the service returns comes from the row written INSIDE the tx.
    expect(started.state).toBe('active');
    expect(started.goal).toBe('Ship the lifecycle');
    // …and it is durably persisted (re-read through the service).
    const all = await sprintsService.listByProject(fx.projectId, fx.ctx);
    const reloaded = all.find((s) => s.id === sprint.id);
    expect(reloaded?.goal).toBe('Ship the lifecycle');
  });

  it('clears the goal on start when given null', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(
      fx.projectId,
      { name: 'A', goal: 'A goal' },
      fx.ctx,
    );
    const started = await sprintsService.startSprint(sprint.id, { goal: null }, fx.ctx);
    expect(started.goal).toBeNull();
  });

  it('leaves the planned goal unchanged when goal is omitted on start', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(
      fx.projectId,
      { name: 'B', goal: 'Keep me' },
      fx.ctx,
    );
    // Omitting goal is `undefined`, NOT a clear — the planned goal survives.
    const started = await sprintsService.startSprint(sprint.id, { name: 'B2' }, fx.ctx);
    expect(started.goal).toBe('Keep me');
  });

  it('records a null committed-points baseline for a wholly unestimated sprint', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    const issue = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'no points' },
      fx.ctx,
    );
    await backlogService.assignToSprint(issue.id, sprint.id, undefined, fx.ctx);

    const started = await sprintsService.startSprint(sprint.id, {}, fx.ctx);

    expect(started.committedIssueCount).toBe(1);
    expect(started.committedPoints).toBeNull();
  });

  it('does not create a second scrum board when the project already has one (idempotent)', async () => {
    const fx = await makeWorkItemFixture();
    // Pre-provision a scrum board, then start a sprint.
    await boardsService.createBoard(
      fx.projectId,
      { name: 'Existing scrum', type: 'scrum' },
      fx.ctx,
    );
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);

    await sprintsService.startSprint(sprint.id, {}, fx.ctx);

    const boards = await boardsService.listBoards(fx.projectId, fx.ctx);
    expect(boards.filter((board) => board.type === 'scrum')).toHaveLength(1);
  });

  it('rejects a second active sprint in the same project (one-active guard, 409)', async () => {
    const fx = await makeWorkItemFixture();
    const first = await sprintsService.createSprint(fx.projectId, { name: 'A' }, fx.ctx);
    const second = await sprintsService.createSprint(fx.projectId, { name: 'B' }, fx.ctx);

    await sprintsService.startSprint(first.id, {}, fx.ctx);
    await expect(sprintsService.startSprint(second.id, {}, fx.ctx)).rejects.toBeInstanceOf(
      SprintAlreadyActiveError,
    );

    // The failed start left no orphan: still exactly one scrum board.
    const boards = await boardsService.listBoards(fx.projectId, fx.ctx);
    expect(boards.filter((board) => board.type === 'scrum')).toHaveLength(1);
  });

  it('lets a different project run its own active sprint concurrently', async () => {
    const a = await makeWorkItemFixture({ name: 'Tenant A', identifier: 'AAA' });
    const b = await makeWorkItemFixture({ name: 'Tenant B', identifier: 'BBB' });
    const sa = await sprintsService.createSprint(a.projectId, {}, a.ctx);
    const sb = await sprintsService.createSprint(b.projectId, {}, b.ctx);

    const startedA = await sprintsService.startSprint(sa.id, {}, a.ctx);
    const startedB = await sprintsService.startSprint(sb.id, {}, b.ctx);

    expect(startedA.state).toBe('active');
    expect(startedB.state).toBe('active');
  });

  it('rejects a window whose end precedes its start (422)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    await expect(
      sprintsService.startSprint(
        sprint.id,
        { startDate: '2026-06-23T00:00:00.000Z', endDate: '2026-06-09T00:00:00.000Z' },
        fx.ctx,
      ),
    ).rejects.toBeInstanceOf(SprintWindowInvalidError);
  });

  it('rejects starting a sprint that is not in the planned state (422)', async () => {
    const fx = await makeWorkItemFixture();
    const sprint = await sprintsService.createSprint(fx.projectId, {}, fx.ctx);
    await sprintsService.startSprint(sprint.id, {}, fx.ctx); // → active

    await expect(sprintsService.startSprint(sprint.id, {}, fx.ctx)).rejects.toBeInstanceOf(
      SprintNotStartableError,
    );
  });

  it('404s a sprint outside the active workspace (finding-#26 tenancy gate)', async () => {
    const a = await makeWorkItemFixture({ name: 'Tenant A', identifier: 'AAA' });
    const b = await makeWorkItemFixture({ name: 'Tenant B', identifier: 'BBB' });
    const sprint = await sprintsService.createSprint(a.projectId, {}, a.ctx);

    // Tenant B trying to start tenant A's sprint sees a 404, not A's sprint.
    await expect(sprintsService.startSprint(sprint.id, {}, b.ctx)).rejects.toBeInstanceOf(
      SprintNotFoundError,
    );
  });
});
