import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { backlogService } from '@/lib/services/backlogService';
import { sprintsService } from '@/lib/services/sprintsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { WorkspaceContext } from '@/lib/workspaces';

// GET /api/sprints/[id]/points (Story 4.4 · Subtask 4.4.9 — finding #69). Real
// Postgres (no mocks), per CLAUDE.md; we stub ONLY `getWorkspaceContext` — the
// cookie-derived resolver the test env can't supply — so every read flows
// through the real estimationService → repository → Prisma chain. Asserts the
// transport contract: the `SprintPointsDto` shape, the wholly-unestimated
// `{ 0, 0, 0 }`, the cross-workspace 404 (the finding-#26 tenancy gate), and the
// 401 when unauthenticated. The roll-up math itself is covered in
// tests/integration/estimation/service.test.ts (`rollupForSprint`).

const wsCtx = { current: null as WorkspaceContext | null };
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => wsCtx.current };
});

// Import the handler AFTER the mock is registered.
const { GET } = await import('@/app/api/sprints/[id]/points/route');

const BASE = 'http://localhost:3000';
function req(id: string): Promise<Response> {
  return GET(new Request(`${BASE}/api/sprints/${id}/points`), {
    params: Promise.resolve({ id }),
  });
}

/** Give an issue a story-point estimate directly (mirrors the sibling
 *  start-sprint integration test's helper). */
async function setPoints(itemId: string, points: number): Promise<void> {
  await db.workItem.update({ where: { id: itemId }, data: { storyPoints: points } });
}

beforeEach(async () => {
  await truncateAuthTables();
  wsCtx.current = null;
});

afterAll(async () => {
  await db.$disconnect();
});

describe('GET /api/sprints/[id]/points', () => {
  it('returns the committed/completed/remaining roll-up for an estimated sprint', async () => {
    const fx = await makeWorkItemFixture();
    wsCtx.current = fx.ctx;
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S1' }, fx.ctx);
    const a = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'a' },
      fx.ctx,
    );
    const b = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'b' },
      fx.ctx,
    );
    await backlogService.assignToSprint(a.id, sprint.id, undefined, fx.ctx);
    await backlogService.assignToSprint(b.id, sprint.id, undefined, fx.ctx);
    await setPoints(a.id, 5);
    await setPoints(b.id, 8);

    const res = await req(sprint.id);
    expect(res.status).toBe(200);
    // Fresh issues sit in a non-done status → completed 0, remaining = committed.
    expect(await res.json()).toEqual({ committed: 13, completed: 0, remaining: 13 });
  });

  it('returns { 0, 0, 0 } for a wholly unestimated sprint (the DTO stays total)', async () => {
    const fx = await makeWorkItemFixture();
    wsCtx.current = fx.ctx;
    const sprint = await sprintsService.createSprint(fx.projectId, { name: 'S2' }, fx.ctx);
    const a = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'a' },
      fx.ctx,
    );
    await backlogService.assignToSprint(a.id, sprint.id, undefined, fx.ctx);

    const res = await req(sprint.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ committed: 0, completed: 0, remaining: 0 });
  });

  it('404s a sprint outside the active workspace (finding-#26 tenancy gate)', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture();
    const otherSprint = await sprintsService.createSprint(
      other.projectId,
      { name: 'X' },
      other.ctx,
    );
    // Query the other workspace's sprint with THIS workspace's context.
    wsCtx.current = fx.ctx;
    const res = await req(otherSprint.id);
    expect(res.status).toBe(404);
  });

  it('401s when unauthenticated', async () => {
    wsCtx.current = null;
    const res = await req('any');
    expect(res.status).toBe(401);
  });
});
