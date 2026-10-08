import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { pagesService } from '@/lib/services/pagesService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { PageMentionCandidateDto } from '@/lib/dto/pages';
import type { WorkspaceContext } from '@/lib/workspaces';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { projectAccessData } from '@/tests/helpers/projectAccess';
import { truncateAuthTables } from '../helpers/db';
import { createCustomRoleAs, setProjectRoleDefinitionFor } from '../helpers/workspaceRoleFixtures';

// `GET /api/pages/mention-search` (Story MOTIR-7694 · MOTIR-7697) — the transport
// the route owns: 200 with the service's rows, 400 for a missing project or a
// short query, 403 without `page:view`, 404 for a project the caller cannot
// browse. Only `getWorkspaceContext` is stubbed (no cookies in tests).

const ctxRef = { current: null as WorkspaceContext | null };

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const { GET } = await import('@/app/api/pages/mention-search/route');

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ identifier: 'PMS' });
  ctxRef.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function search(params: Record<string, string>): Promise<Response> {
  const url = new URL('http://localhost:3000/api/pages/mention-search');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return GET(new Request(url));
}

describe('GET /api/pages/mention-search', () => {
  it('200 with the matching live pages', async () => {
    const page = await pagesService.createPage(fx.ctx, {
      projectId: fx.projectId,
      title: 'Roadmap',
    });
    const res = await search({ projectId: fx.projectId, q: 'ro' });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as PageMentionCandidateDto[];
    expect(rows).toEqual([
      { id: page.id, title: 'Roadmap', place: { folderPath: [], parentPageTitle: null } },
    ]);
  });

  it('400 without a project or under two characters', async () => {
    expect((await search({ q: 'roadmap' })).status).toBe(400);
    expect((await search({ projectId: fx.projectId, q: ' r ' })).status).toBe(400);
  });

  it('403 for a browser without page:view, 404 for a project the caller cannot browse', async () => {
    const role = await createCustomRoleAs({
      ctx: fx.ctx,
      name: 'Browser',
      permissions: ['project:browse', 'work_item:view'],
    });
    const user = await usersService.createUser({
      email: 'pms-browse@example.com',
      password: 'hunter2hunter2',
      name: 'Browse',
    });
    await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
    await setProjectRoleDefinitionFor(user.id, fx.projectId, {
      roleDefinitionId: role.id,
      role: 'member',
    });
    ctxRef.current = { userId: user.id, workspaceId: fx.workspaceId };
    expect((await search({ projectId: fx.projectId, q: 'ro' })).status).toBe(403);

    const priv = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'PRIV',
    });
    await adminDb.project.update({ where: { id: priv.id }, data: projectAccessData('members') });
    expect((await search({ projectId: priv.id, q: 'ro' })).status).toBe(404);
  });

  it('401 without a session', async () => {
    ctxRef.current = null;
    expect((await search({ projectId: fx.projectId, q: 'ro' })).status).toBe(401);
  });
});
