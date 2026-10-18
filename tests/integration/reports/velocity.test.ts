import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { reportsService } from '@/lib/services/reportsService';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { toVelocityDto } from '@/lib/mappers/reportsMappers';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestProject } from '../../fixtures/projectFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import type { WorkspaceContext } from '@/lib/workspaces';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';

// Stub ONLY `getWorkspaceContext` (the cookie-derived resolver the test env
// can't supply) — the single allowed mock, per CLAUDE.md. The service-level
// tests below pass `ctx` explicitly and never touch it; the route transport
// tests drive it via `wsCtx.current`. Declared at top level so the factory sees
// it initialised before the route module is (dynamically) imported.
const wsCtx = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => wsCtx.current };
});

// Story 4.6 · Subtask 4.6.4 — the cross-sprint VELOCITY aggregate
// (`reportsService.getVelocity`) + its bounded sprint read + the pure DTO
// assembler. Real Postgres (no mocks except `getWorkspaceContext` for the route
// transport), per CLAUDE.md — every read flows through the real reportsService →
// estimationService → repository → Prisma chain.
//
// Asserts: the committed (4.4.2 baseline) vs completed (4.3.3 done-category
// roll-up) bars per completed sprint, oldest→newest; the average; the `LIMIT N`
// bound; the 0/1-sprint low-history states; unestimated → 0 (no `NaN`); and the
// cross-workspace 404 (finding-#26 tenancy gate). The at-scale combined Scrum
// journey is Story 4.7's, not duplicated here.

/**
 * Seed a COMPLETED sprint with a committed baseline + issues. `points`/`done`
 * per issue drive the done-category roll-up; the sprint row carries the
 * immutable committed snapshot directly (we are reconstructing post-completion
 * history, so we stamp the baseline rather than replay `startSprint`).
 */
async function seedCompletedSprint(
  fx: WorkItemFixture,
  opts: {
    name: string;
    sequence: number;
    completedAt: Date;
    committedPoints: number | null;
    committedIssueCount: number | null;
    issues: Array<{ points: number | null; done: boolean }>;
  },
): Promise<string> {
  const sprint = await adminDb.sprint.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      name: opts.name,
      state: 'complete',
      completedAt: opts.completedAt,
      sequence: opts.sequence,
      committedPoints: opts.committedPoints,
      committedIssueCount: opts.committedIssueCount,
    },
  });
  for (const iss of opts.issues) {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'issue' },
      fx.ctx,
    );
    await adminDb.workItem.update({
      where: { id: item.id },
      data: {
        sprintId: sprint.id,
        storyPoints: iss.points,
        status: iss.done ? 'done' : 'todo',
      },
    });
  }
  return sprint.id;
}

const D = (iso: string) => new Date(iso);

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('reportsService.getVelocity', () => {
  it('returns committed vs completed per completed sprint, oldest→newest, with the average', async () => {
    const fx = await makeWorkItemFixture();
    // Seed two completed sprints out of completion order to prove the ordering.
    await seedCompletedSprint(fx, {
      name: 'Sprint 1',
      sequence: 1,
      completedAt: D('2026-01-10T00:00:00Z'),
      committedPoints: 20,
      committedIssueCount: 3,
      issues: [
        { points: 5, done: true },
        { points: 8, done: true },
        { points: 7, done: false }, // committed but not completed
      ],
    });
    await seedCompletedSprint(fx, {
      name: 'Sprint 2',
      sequence: 2,
      completedAt: D('2026-01-24T00:00:00Z'),
      committedPoints: 18,
      committedIssueCount: 2,
      issues: [
        { points: 13, done: true },
        { points: 5, done: true },
      ],
    });

    const dto = await reportsService.getVelocity({ projectId: fx.projectId }, fx.ctx);

    expect(dto.statistic).toBe('story_points');
    expect(dto.sprints.map((s) => s.name)).toEqual(['Sprint 1', 'Sprint 2']); // oldest→newest
    expect(dto.sprints[0]).toMatchObject({ name: 'Sprint 1', committed: 20, completed: 13 });
    expect(dto.sprints[1]).toMatchObject({ name: 'Sprint 2', committed: 18, completed: 18 });
    // average completed = (13 + 18) / 2 = 15.5
    expect(dto.averageCompleted).toBe(15.5);
  });

  it('is bounded — returns at most `lastN` completed sprints, the most recent', async () => {
    const fx = await makeWorkItemFixture();
    for (let i = 1; i <= 5; i++) {
      await seedCompletedSprint(fx, {
        name: `Sprint ${i}`,
        sequence: i,
        completedAt: D(`2026-0${i}-01T00:00:00Z`),
        committedPoints: i,
        committedIssueCount: 1,
        issues: [{ points: i, done: true }],
      });
    }

    const dto = await reportsService.getVelocity({ projectId: fx.projectId, lastN: 3 }, fx.ctx);

    // The most recent 3 (Sprints 3, 4, 5), oldest→newest.
    expect(dto.sprints.map((s) => s.name)).toEqual(['Sprint 3', 'Sprint 4', 'Sprint 5']);
    expect(dto.averageCompleted).toBe(4); // (3 + 4 + 5) / 3
  });

  it('returns the low-history state for 0 completed sprints (no axis-of-one, no crash)', async () => {
    const fx = await makeWorkItemFixture();
    const dto = await reportsService.getVelocity({ projectId: fx.projectId }, fx.ctx);
    expect(dto).toEqual({ sprints: [], averageCompleted: 0, statistic: 'story_points' });
  });

  it('returns a single bar whose completed is the average for 1 completed sprint', async () => {
    const fx = await makeWorkItemFixture();
    await seedCompletedSprint(fx, {
      name: 'Only',
      sequence: 1,
      completedAt: D('2026-03-01T00:00:00Z'),
      committedPoints: 10,
      committedIssueCount: 1,
      issues: [{ points: 9, done: true }],
    });
    const dto = await reportsService.getVelocity({ projectId: fx.projectId }, fx.ctx);
    expect(dto.sprints).toHaveLength(1);
    expect(dto.sprints[0]).toMatchObject({ committed: 10, completed: 9 });
    expect(dto.averageCompleted).toBe(9);
  });

  it('treats an unestimated sprint as 0 committed / 0 completed (never NaN)', async () => {
    const fx = await makeWorkItemFixture();
    await seedCompletedSprint(fx, {
      name: 'Unestimated',
      sequence: 1,
      completedAt: D('2026-04-01T00:00:00Z'),
      committedPoints: null,
      committedIssueCount: 2,
      issues: [
        { points: null, done: true },
        { points: null, done: false },
      ],
    });
    const dto = await reportsService.getVelocity({ projectId: fx.projectId }, fx.ctx);
    expect(dto.sprints[0]).toMatchObject({ committed: 0, completed: 0 });
    expect(Number.isNaN(dto.averageCompleted)).toBe(false);
    expect(dto.averageCompleted).toBe(0);
  });

  it('clamps a non-positive / non-finite lastN to the default window', async () => {
    const fx = await makeWorkItemFixture();
    for (let i = 1; i <= 2; i++) {
      await seedCompletedSprint(fx, {
        name: `S${i}`,
        sequence: i,
        completedAt: D(`2026-05-0${i}T00:00:00Z`),
        committedPoints: i,
        committedIssueCount: 1,
        issues: [{ points: i, done: true }],
      });
    }
    // lastN = 0 → default 7 → both sprints returned (not zero).
    const dto = await reportsService.getVelocity({ projectId: fx.projectId, lastN: 0 }, fx.ctx);
    expect(dto.sprints).toHaveLength(2);
  });

  it('counts issues for an issue_count project (the configured statistic)', async () => {
    const fx = await makeWorkItemFixture();
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { estimationStatistic: 'issue_count' },
    });
    await seedCompletedSprint(fx, {
      name: 'Counted',
      sequence: 1,
      completedAt: D('2026-06-01T00:00:00Z'),
      committedPoints: 99, // ignored under issue_count
      committedIssueCount: 4,
      issues: [
        { points: 5, done: true },
        { points: 5, done: true },
        { points: 5, done: false },
      ],
    });
    const dto = await reportsService.getVelocity({ projectId: fx.projectId }, fx.ctx);
    expect(dto.statistic).toBe('issue_count');
    // committed = the committedIssueCount baseline (4), completed = done count (2).
    expect(dto.sprints[0]).toMatchObject({ committed: 4, completed: 2 });
  });

  it('reads the committedPoints baseline for a time_estimate project (the best-available snapshot)', async () => {
    // 4.6.4's documented narrowing: there is no committed-time snapshot, so a
    // time_estimate project's committed bar reads the committedPoints baseline.
    const fx = await makeWorkItemFixture();
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { estimationStatistic: 'time_estimate' },
    });
    await seedCompletedSprint(fx, {
      name: 'Timed',
      sequence: 1,
      completedAt: D('2026-06-01T00:00:00Z'),
      committedPoints: 12,
      committedIssueCount: 3,
      issues: [{ points: null, done: true }],
    });
    const dto = await reportsService.getVelocity({ projectId: fx.projectId }, fx.ctx);
    expect(dto.statistic).toBe('time_estimate');
    expect(dto.sprints[0]!.committed).toBe(12);
    expect(Number.isFinite(dto.sprints[0]!.completed)).toBe(true);
  });

  it('a null committedIssueCount on an issue_count project reads as 0, never NaN (the ?? 0 guard)', async () => {
    const fx = await makeWorkItemFixture();
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { estimationStatistic: 'issue_count' },
    });
    await seedCompletedSprint(fx, {
      name: 'NoBaseline',
      sequence: 1,
      completedAt: D('2026-06-01T00:00:00Z'),
      committedPoints: null,
      committedIssueCount: null, // defensive — a completed sprint normally has one
      issues: [{ points: null, done: true }],
    });
    const dto = await reportsService.getVelocity({ projectId: fx.projectId }, fx.ctx);
    expect(dto.sprints[0]!.committed).toBe(0);
    expect(dto.averageCompleted).not.toBeNaN();
  });

  it('404s a project outside the active workspace (finding-#26 tenancy gate)', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    // fx's actor cannot read other's project — an indistinguishable 404.
    await expect(
      reportsService.getVelocity({ projectId: other.projectId }, fx.ctx),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });
});

async function seedTen(fx: WorkItemFixture): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= 10; i++) {
    ids.push(
      await seedCompletedSprint(fx, {
        name: `S${i}`,
        sequence: i,
        completedAt: D(`2026-02-${String(i).padStart(2, '0')}T00:00:00Z`),
        committedPoints: i,
        committedIssueCount: 1,
        issues: [{ points: i, done: true }],
      }),
    );
  }
  return ids;
}

describe('reportsService.getVelocity — a range ending at a chosen completed sprint', () => {
  it('returns the `lastN` completed sprints at or before the end sprint, oldest→newest', async () => {
    const fx = await makeWorkItemFixture();
    const ids = await seedTen(fx);
    const dto = await reportsService.getVelocity(
      { projectId: fx.projectId, lastN: 3, endSprintId: ids[5] },
      fx.ctx,
    );
    expect(dto.sprints.map((s) => s.name)).toEqual(['S4', 'S5', 'S6']);
    // The end sprint is the right-most bar.
    expect(dto.sprints[dto.sprints.length - 1]!.sprintId).toBe(ids[5]);
  });

  it('returns fewer than the count when history runs out', async () => {
    const fx = await makeWorkItemFixture();
    const ids = await seedTen(fx);
    const dto = await reportsService.getVelocity(
      { projectId: fx.projectId, lastN: 5, endSprintId: ids[1] },
      fx.ctx,
    );
    expect(dto.sprints.map((s) => s.name)).toEqual(['S1', 'S2']);
  });

  it('with no end sprint returns exactly the default window (the last 7)', async () => {
    const fx = await makeWorkItemFixture();
    await seedTen(fx);
    const dto = await reportsService.getVelocity({ projectId: fx.projectId }, fx.ctx);
    expect(dto.sprints.map((s) => s.name)).toEqual(['S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10']);
  });

  it('breaks a tie on completedAt by sequence, as the unbounded read does', async () => {
    const fx = await makeWorkItemFixture();
    const same = D('2026-03-01T00:00:00Z');
    const a = await seedCompletedSprint(fx, {
      name: 'Tie-A',
      sequence: 1,
      completedAt: same,
      committedPoints: 1,
      committedIssueCount: 1,
      issues: [],
    });
    await seedCompletedSprint(fx, {
      name: 'Tie-B',
      sequence: 2,
      completedAt: same,
      committedPoints: 1,
      committedIssueCount: 1,
      issues: [],
    });
    // Ending at the LOWER sequence excludes the higher one with the same timestamp.
    const dto = await reportsService.getVelocity(
      { projectId: fx.projectId, lastN: 5, endSprintId: a },
      fx.ctx,
    );
    expect(dto.sprints.map((s) => s.name)).toEqual(['Tie-A']);
  });

  it('falls back to the default window for an id that is not a completed sprint of this project', async () => {
    const fx = await makeWorkItemFixture();
    await seedTen(fx);
    const active = await adminDb.sprint.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'Active',
        state: 'active',
        sequence: 11,
      },
    });
    const planned = await adminDb.sprint.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'Planned',
        state: 'planned',
        sequence: 12,
      },
    });
    // Another project in the SAME workspace, with its own completed sprint.
    const sibling = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'SIBL',
    });
    const foreign = await adminDb.sprint.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: sibling.id,
        name: 'Foreign',
        state: 'complete',
        completedAt: D('2026-02-05T12:00:00Z'),
        sequence: 1,
      },
    });
    const expected = ['S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'];
    for (const endSprintId of [active.id, planned.id, foreign.id, 'no-such-sprint']) {
      const dto = await reportsService.getVelocity(
        { projectId: fx.projectId, endSprintId },
        fx.ctx,
      );
      expect(dto.sprints.map((s) => s.name)).toEqual(expected);
    }
  });

  it("never returns another workspace's sprint, even when its id is the end sprint", async () => {
    const fx = await makeWorkItemFixture();
    await seedTen(fx);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const theirs = await seedCompletedSprint(other, {
      name: 'Theirs',
      sequence: 1,
      completedAt: D('2026-02-09T00:00:00Z'),
      committedPoints: 1,
      committedIssueCount: 1,
      issues: [],
    });
    const dto = await reportsService.getVelocity(
      { projectId: fx.projectId, endSprintId: theirs },
      fx.ctx,
    );
    expect(dto.sprints.map((s) => s.name)).not.toContain('Theirs');
    expect(dto.sprints).toHaveLength(7);
  });
});

describe('sprintRepository.listCompletedByProjectEndingAt', () => {
  it('issues one bounded read (take = limit) newest first, and is workspace-scoped', async () => {
    const fx = await makeWorkItemFixture();
    const ids = await seedTen(fx);
    const end = await adminDb.sprint.findUniqueOrThrow({ where: { id: ids[7]! } });
    const rows = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      sprintRepository.listCompletedByProjectEndingAt(
        fx.projectId,
        fx.workspaceId,
        { completedAt: end.completedAt!, sequence: end.sequence },
        4,
        tx,
      ),
    );
    expect(rows.map((r) => r.name)).toEqual(['S8', 'S7', 'S6', 'S5']);

    // The same query run for a different workspace returns nothing of this one's.
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const leaked = await withWorkspaceServiceContext(other.workspaceId, (tx) =>
      sprintRepository.listCompletedByProjectEndingAt(
        fx.projectId,
        other.workspaceId,
        { completedAt: end.completedAt!, sequence: end.sequence },
        4,
        tx,
      ),
    );
    expect(leaked).toEqual([]);
  });
});

describe('sprintRepository.listCompletedByProject (bounded read + empty-input guard)', () => {
  it('returns [] for a project with no completed sprints', async () => {
    const fx = await makeWorkItemFixture();
    const rows = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      sprintRepository.listCompletedByProject(fx.projectId, fx.workspaceId, 7, tx),
    );
    expect(rows).toEqual([]);
  });

  it('returns [] when the limit is 0 (the take:0 guard)', async () => {
    const fx = await makeWorkItemFixture();
    await seedCompletedSprint(fx, {
      name: 'C',
      sequence: 1,
      completedAt: D('2026-01-01T00:00:00Z'),
      committedPoints: 1,
      committedIssueCount: 1,
      issues: [],
    });
    const rows = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      sprintRepository.listCompletedByProject(fx.projectId, fx.workspaceId, 0, tx),
    );
    expect(rows).toEqual([]);
  });

  it('excludes non-complete sprints and is workspace-scoped', async () => {
    const fx = await makeWorkItemFixture();
    await adminDb.sprint.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'Active',
        state: 'active',
        sequence: 1,
      },
    });
    const rows = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      sprintRepository.listCompletedByProject(fx.projectId, fx.workspaceId, 7, tx),
    );
    expect(rows).toEqual([]); // the active sprint is not a completed one
  });
});

describe('toVelocityDto (pure)', () => {
  it('averages completed over the returned sprints, rounded to 2 decimals', () => {
    const dto = toVelocityDto(
      [
        { sprintId: 'a', name: 'A', committed: 10, completed: 4 },
        { sprintId: 'b', name: 'B', committed: 10, completed: 7 },
        { sprintId: 'c', name: 'C', committed: 10, completed: 8 },
      ],
      'story_points',
    );
    // (4 + 7 + 8) / 3 = 6.333… → 6.33
    expect(dto.averageCompleted).toBe(6.33);
    expect(dto.statistic).toBe('story_points');
  });

  it('returns averageCompleted 0 for an empty window (the low-history state)', () => {
    expect(toVelocityDto([], 'issue_count')).toEqual({
      sprints: [],
      averageCompleted: 0,
      statistic: 'issue_count',
    });
  });
});

describe('GET /api/projects/[key]/velocity (transport)', () => {
  // Import the handler AFTER the mock is registered.
  const routePromise = import('@/app/api/projects/[key]/velocity/route');

  function req(key: string, qs = ''): Promise<Response> {
    return routePromise.then(({ GET }) =>
      GET(new Request(`http://localhost:3000/api/projects/${key}/velocity${qs}`), {
        params: Promise.resolve({ key }),
      }),
    );
  }

  beforeEach(() => {
    wsCtx.current = null;
  });

  it('401s when unauthenticated', async () => {
    const res = await req('PROD');
    expect(res.status).toBe(401);
  });

  it('200s with the velocity DTO for a real project key', async () => {
    const fx = await makeWorkItemFixture();
    wsCtx.current = fx.ctx;
    await seedCompletedSprint(fx, {
      name: 'Sprint 1',
      sequence: 1,
      completedAt: D('2026-01-10T00:00:00Z'),
      committedPoints: 10,
      committedIssueCount: 1,
      issues: [{ points: 6, done: true }],
    });
    const res = await req(fx.projectIdentifier);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sprints).toHaveLength(1);
    expect(body.sprints[0]).toMatchObject({ committed: 10, completed: 6 });
    expect(body.averageCompleted).toBe(6);
  });

  it('404s an unknown project key', async () => {
    const fx = await makeWorkItemFixture();
    wsCtx.current = fx.ctx;
    const res = await req('NOPE');
    expect(res.status).toBe(404);
  });
});
