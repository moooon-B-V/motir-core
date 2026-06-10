import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { reportsService } from '@/lib/services/reportsService';
import { sprintRepository } from '@/lib/repositories/sprintRepository';
import { workItemsService } from '@/lib/services/workItemsService';
import { toVelocityDto } from '@/lib/mappers/reportsMappers';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { WorkspaceContext } from '@/lib/workspaces';

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
  const sprint = await db.sprint.create({
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
    await db.workItem.update({
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
    await db.project.update({
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

  it('404s a project outside the active workspace (finding-#26 tenancy gate)', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    // fx's actor cannot read other's project — an indistinguishable 404.
    await expect(
      reportsService.getVelocity({ projectId: other.projectId }, fx.ctx),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });
});

describe('sprintRepository.listCompletedByProject (bounded read + empty-input guard)', () => {
  it('returns [] for a project with no completed sprints', async () => {
    const fx = await makeWorkItemFixture();
    const rows = await sprintRepository.listCompletedByProject(fx.projectId, fx.workspaceId, 7);
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
    const rows = await sprintRepository.listCompletedByProject(fx.projectId, fx.workspaceId, 0);
    expect(rows).toEqual([]);
  });

  it('excludes non-complete sprints and is workspace-scoped', async () => {
    const fx = await makeWorkItemFixture();
    await db.sprint.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        name: 'Active',
        state: 'active',
        sequence: 1,
      },
    });
    const rows = await sprintRepository.listCompletedByProject(fx.projectId, fx.workspaceId, 7);
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
