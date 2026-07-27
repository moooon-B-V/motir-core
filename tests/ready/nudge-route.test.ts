import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// GET /api/ready/nudge — the transport the /ready expansion-nudge banner reads
// (Subtask 7.11.7 / MOTIR-904). Real Postgres; the whole route → service →
// repository → Prisma chain runs, which is the point: the endpoint returned
// **500** for every drained project until MOTIR-1744, because
// `findExpandableStubs` compared `status_category` against a label the enum does
// not have. The route has no try/catch for that error, so the throw escaped as an
// unhandled 500 — and only in the drained state, since the healthy path returns
// null before the stub query is ever reached. That asymmetry is why a
// happy-path-only check never saw it, and why the drained case below is the
// load-bearing assertion.
//
// We stub ONLY the two context resolvers the test env cannot supply via cookies
// (`getSession`, `getActiveProject`) — the same exception the other route suites
// take. `@/lib/projects` is mocked PARTIALLY so everything else in it stays real.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return { ...actual, getActiveProject: async () => activeCtx.current };
});

const { GET } = await import('@/app/api/ready/nudge/route');

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  activeCtx.current = null;
});

afterAll(async () => {
  await db.$disconnect();
});

function signInAs(fx: WorkItemFixture) {
  session.current = { user: { id: fx.ownerId, email: 'nudge@example.com', name: 'Nudge Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

async function story(fx: WorkItemFixture, title: string) {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'story', title }, fx.ctx);
}

async function task(fx: WorkItemFixture, title: string) {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

describe('GET /api/ready/nudge', () => {
  it('returns 200 with the nudge for a DRAINED project (MOTIR-1744: this was a 500)', async () => {
    const fx = await makeWorkItemFixture();
    const s = await story(fx, 'Expand me');
    signInAs(fx);

    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      readyCount: 1,
      nominatedKey: s.identifier,
      nominatedTitle: 'Expand me',
      threshold: 3,
    });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('returns 200 + null when the ready set is healthy', async () => {
    const fx = await makeWorkItemFixture();
    await story(fx, 'Expand me');
    await task(fx, 'One');
    await task(fx, 'Two');
    await task(fx, 'Three');
    signInAs(fx);

    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toBeNull();
  });

  it('401s without a session', async () => {
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('404s with no active project', async () => {
    const fx = await makeWorkItemFixture();
    session.current = { user: { id: fx.ownerId, email: 'nudge@example.com', name: 'Nudge Owner' } };

    const res = await GET();

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 'NO_ACTIVE_PROJECT' });
  });
});
