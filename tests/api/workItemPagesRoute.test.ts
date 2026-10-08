import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { pagesService } from '@/lib/services/pagesService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { WorkspaceContext } from '@/lib/workspaces';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { createCustomRoleAs, setProjectRoleDefinitionFor } from '../helpers/workspaceRoleFixtures';

// `GET /api/work-items/[id]/pages` (Story MOTIR-7565 · MOTIR-7573) — the
// transport over `pageLinksService.listPagesForWorkItem`, whose grouping,
// paging and archive rules `tests/services/pageLinksService.test.ts` covers. This
// file pins what the route owns: 401 with no session, the 200 body, `?limit=`
// clamped, and the refusals' statuses with no page title in their bodies.
//
// Only `getWorkspaceContext` is stubbed (the test env has no cookies); the mock
// is partial so the real RLS-binding `withWorkspaceContext` stays in place.

const ctxRef = { current: null as WorkspaceContext | null };

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const { GET } = await import('@/app/api/work-items/[id]/pages/route');

const BASE = 'http://localhost:3000';

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
  fx = await makeWorkItemFixture({ identifier: 'PGR' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function get(id: string, query = ''): Promise<Response> {
  return GET(new Request(`${BASE}/api/work-items/${id}/pages${query}`), {
    params: Promise.resolve({ id }),
  });
}

async function linkedTarget(pageTitles: string[]): Promise<string> {
  const target = await createTestWorkItem(fx, { kind: 'task', title: 'Target' });
  for (const title of pageTitles) {
    const page = await pagesService.createPage(fx.ctx, { projectId: fx.projectId, title });
    await adminDb.pageWorkItemLink.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        pageId: page.id,
        workItemId: target.id,
        source: 'mention',
      },
    });
  }
  return target.id;
}

describe('GET /api/work-items/[id]/pages', () => {
  it('401s with no session', async () => {
    expect((await get('anything')).status).toBe(401);
  });

  it('returns the rows and a cursor, and clamps ?limit=', async () => {
    const id = await linkedTarget(['Alpha', 'Beta', 'Gamma']);
    ctxRef.current = fx.ctx;

    const res = await get(id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: Array<{ title: string }>;
      nextCursor: string | null;
    };
    expect(body.rows.map((r) => r.title).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(body.nextCursor).toBeNull();

    const paged = (await (await get(id, '?limit=2')).json()) as {
      rows: unknown[];
      nextCursor: string | null;
    };
    expect(paged.rows).toHaveLength(2);
    const rest = (await (await get(id, `?cursor=${paged.nextCursor}`)).json()) as {
      rows: unknown[];
    };
    expect(rest.rows).toHaveLength(1);
  });

  it('answers 403 to a reader without page:view, with no page title in the body', async () => {
    const id = await linkedTarget(['Secret page title']);
    const user = await usersService.createUser({
      email: 'browse-only@example.com',
      password: 'hunter2hunter2',
      name: 'Browse only',
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
    const role = await createCustomRoleAs({
      ctx: fx.ctx,
      name: 'Browser',
      permissions: ['project:browse', 'work_item:view'],
    });
    await setProjectRoleDefinitionFor(user.id, fx.projectId, {
      roleDefinitionId: role.id,
      role: 'member',
    });
    ctxRef.current = { userId: user.id, workspaceId: fx.workspaceId };

    const res = await get(id);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('Secret page title');
  });

  it('answers 404 to an unknown work item and to a stranger to the workspace', async () => {
    const id = await linkedTarget(['Secret page title']);
    ctxRef.current = fx.ctx;
    expect((await get('ckunknownworkitem0000000')).status).toBe(404);

    const stranger = await usersService.createUser({
      email: 'stranger@example.com',
      password: 'hunter2hunter2',
      name: 'Stranger',
    });
    const other = await workspacesService.createWorkspace({
      name: 'Elsewhere',
      ownerUserId: stranger.id,
    });
    ctxRef.current = { userId: stranger.id, workspaceId: other.workspace.id };
    const res = await get(id);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('Secret page title');
  });

  it('answers 400 to a cursor it did not issue', async () => {
    const id = await linkedTarget([]);
    ctxRef.current = fx.ctx;
    expect((await get(id, '?cursor=garbage')).status).toBe(400);
  });
});
