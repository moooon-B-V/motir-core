import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { levelPageSize } from '@/lib/pages';
import { db } from '@/lib/db';
import { pagesService } from '@/lib/services/pagesService';
import { encodeWorkItemPagesCursor } from '@/lib/pages/workItemPagesCursor';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// `GET /api/pages/[pageId]/work-items` (Story MOTIR-7567 · MOTIR-9198) — the
// transport over `pageLinksService.listWorkItemsForPage`, whose rules
// `tests/services/pageLinksService.pageWorkItems.test.ts` covers. This file pins
// what the route owns: 401 with no session, 400 with no active project, the 200
// body, `?limit=` clamped, and the refusals' statuses with no page title or
// work-item identifier in their bodies. The session and active-project readers
// are stubbed (the test env has no cookies); the service and database are real.

const sessionRef = { ok: true as boolean };
const projectRef = {
  current: null as { userId: string; workspaceId: string; projectId: string } | null,
};

vi.mock('@/lib/auth/requireCompliantSession', () => ({
  requireCompliantSession: async () =>
    sessionRef.ok
      ? { ok: true }
      : {
          ok: false,
          response: new Response(JSON.stringify({ code: 'UNAUTHENTICATED' }), { status: 401 }),
        },
}));
vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return { ...actual, getActiveProject: async () => projectRef.current };
});

const { GET } = await import('@/app/api/pages/[pageId]/work-items/route');

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  sessionRef.ok = true;
  fx = await makeWorkItemFixture({ identifier: 'PWR' });
  projectRef.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
  };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const get = (pageId: string, query = ''): Promise<Response> =>
  GET(new Request(`http://localhost:3000/api/pages/${pageId}/work-items${query}`), {
    params: Promise.resolve({ pageId }),
  });

async function seed(count: number): Promise<string> {
  const page = await pagesService.createPage(fx.ctx, {
    projectId: fx.projectId,
    title: 'Secret page title',
  });
  for (let i = 0; i < count; i++) {
    const w = await createTestWorkItem(fx, { kind: 'task', title: `T${i}` });
    await adminDb.pageWorkItemLink.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        pageId: page.id,
        workItemId: w.id,
        source: 'manual',
        createdById: fx.ownerId,
      },
    });
  }
  return page.id;
}

describe('GET /api/pages/[pageId]/work-items', () => {
  it('401 with no session, 400 with no active project', async () => {
    const id = await seed(0);
    sessionRef.ok = false;
    expect((await get(id)).status).toBe(401);
    sessionRef.ok = true;
    projectRef.current = null;
    const res = await get(id);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('NO_ACTIVE_PROJECT');
  });

  it('200 with { rows, nextCursor, canLink }', async () => {
    const id = await seed(2);
    const res = await get(id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toEqual({
      workItemId: expect.any(String),
      linkedAt: expect.any(String),
      summary: expect.objectContaining({ accessible: true }),
    });
    expect(body.nextCursor).toBeNull();
    expect(body.canLink).toBe(true);
  });

  it('clamps ?limit= to the tree level cap and pages through a cursor', async () => {
    const id = await seed(3);
    const one = await (await get(id, '?limit=1')).json();
    expect(one.rows).toHaveLength(1);
    expect(one.nextCursor).toEqual(expect.any(String));
    const rest = await (await get(id, `?limit=5&cursor=${one.nextCursor}`)).json();
    expect(rest.rows).toHaveLength(2);
    const big = await (await get(id, '?limit=500')).json();
    expect(big.rows.length).toBeLessThanOrEqual(levelPageSize(500));
    expect((await (await get(id, '?limit=abc')).json()).rows).toHaveLength(3);
  });

  it('400 PAGE_CURSOR_INVALID for a cursor the read did not issue', async () => {
    const id = await seed(1);
    for (const cursor of [
      'garbage',
      encodeWorkItemPagesCursor({ updatedAt: new Date(), id: 'x' }),
    ]) {
      const res = await get(id, `?cursor=${cursor}`);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('PAGE_CURSOR_INVALID');
    }
  });

  it('404 PAGE_NOT_FOUND for an unknown page, naming nothing', async () => {
    const res = await get('nope');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe('PAGE_NOT_FOUND');
    expect(JSON.stringify(body)).not.toMatch(/Secret page title|PWR-/);
  });
});
