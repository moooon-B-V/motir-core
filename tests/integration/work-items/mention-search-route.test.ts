import type { WorkItem, WorkItemKind } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { usersService } from '@/lib/services/usersService';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';
import type { WorkspaceContext } from '@/lib/workspaces';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Subtask 5.8.4 — `GET /api/work-items/mention-search`, the candidate read behind
// the `@`-mention picker. The route is a thin transport over the SHARED
// `workItemsService.quickSearch` (whose key+title search, relevance order,
// permission scope, and guards are exhaustively covered in quick-search.test.ts).
// This file pins the TRANSPORT contract the route owns: the session/workspace
// gate (401), that a query returns the browsable-scoped matches, that a
// non-browsable-project item never leaks, that the result is capped, and that a
// short/empty query is a normal empty `[]`.
//
// We stub ONLY `getWorkspaceContext` — the session+active-workspace resolver the
// route reads, which the test env can't supply (no cookies). The mock is PARTIAL
// (importOriginal) so the real `withWorkspaceContext` — the RLS-binding the
// service depends on — is preserved untouched. (Same exception the ready-routes
// suite takes.)

const PASSWORD = 'hunter2hunter2';

const ctxRef = { current: null as WorkspaceContext | null };

vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

// Import the handler AFTER the mock is registered.
const { GET } = await import('@/app/api/work-items/mention-search/route');

const BASE = 'http://localhost:3000';

beforeEach(async () => {
  await truncateAuthTables();
  ctxRef.current = null;
});

afterAll(async () => {
  await db.$disconnect();
});

/** Sign the test in as a given actor scoped to a workspace. */
function signInAs(ctx: ServiceContext): void {
  ctxRef.current = { userId: ctx.userId, workspaceId: ctx.workspaceId };
}

/** Call the route with the given `q` (omit to send no param at all). */
function search(q?: string): Promise<Response> {
  const url = new URL(`${BASE}/api/work-items/mention-search`);
  if (q !== undefined) url.searchParams.set('q', q);
  return GET(new Request(url));
}

/** Read the route's JSON body as the summary-row array it returns. */
async function rows(res: Response): Promise<WorkItemSummaryDto[]> {
  return (await res.json()) as WorkItemSummaryDto[];
}

/**
 * Insert a non-archived top-level work item into a project the way the service
 * does — allocate the per-project key in a transaction, derive the identifier,
 * insert through the repository. Parameterised by project so one workspace can
 * hold items across several projects (the permission case).
 */
async function seedItem(args: {
  workspaceId: string;
  projectId: string;
  identifier: string;
  reporterId: string;
  title: string;
  kind?: WorkItemKind;
}): Promise<WorkItem> {
  return db.$transaction(async (tx) => {
    const key = await projectRepository.allocateWorkItemNumber(args.projectId, tx);
    return workItemRepository.create(
      {
        workspaceId: args.workspaceId,
        projectId: args.projectId,
        parentId: null,
        kind: args.kind ?? 'task',
        key,
        identifier: `${args.identifier}-${key}`,
        title: args.title,
        reporterId: args.reporterId,
        position: String(key).padStart(6, '0'),
      },
      tx,
    );
  });
}

const projectOf = (fx: WorkItemFixture) => ({
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
  identifier: fx.projectIdentifier,
});

describe('GET /api/work-items/mention-search — transport gate', () => {
  it('401s when there is no session / no resolvable workspace', async () => {
    ctxRef.current = null;
    const res = await search('anything');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED' });
  });
});

describe('GET /api/work-items/mention-search — candidate read', () => {
  it('returns the matching items as a 200 JSON array', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PROD' });
    signInAs(fx.ctx);
    const hit = await seedItem({
      ...projectOf(fx),
      reporterId: fx.ownerId,
      title: 'Search indexing pipeline',
    });
    await seedItem({ ...projectOf(fx), reporterId: fx.ownerId, title: 'Unrelated chore' });

    const res = await search('search');
    expect(res.status).toBe(200);
    const body = await rows(res);
    expect(body.map((r) => r.id)).toContain(hit.id);
    expect(body.map((r) => r.title)).not.toContain('Unrelated chore');
  });

  it('excludes an item in a project the actor cannot browse (the Story 6.4 scope)', async () => {
    const owner = await usersService.createUser({
      email: 'owner-ms@ex.com',
      password: PASSWORD,
      name: 'Owner',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'MS WS',
      ownerUserId: owner.id,
    });
    const ownerCtx: ServiceContext = { userId: owner.id, workspaceId: workspace.id };

    const pub = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Public',
      identifier: 'PUB',
    });
    const priv = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Private',
      identifier: 'PRIV',
    });
    // Make PRIV private BEFORE adding the outsider so they're not auto-seeded as a
    // member.
    await projectMembersService.setAccessLevel({
      key: priv.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      level: 'private',
    });

    const outsider = await usersService.createUser({
      email: 'outsider-ms@ex.com',
      password: PASSWORD,
      name: 'Outsider',
    });
    await workspacesService.addMember({ userId: outsider.id, workspaceId: workspace.id });

    const pubItem = await seedItem({
      workspaceId: workspace.id,
      projectId: pub.id,
      identifier: 'PUB',
      reporterId: owner.id,
      title: 'visible widget',
    });
    const privItem = await seedItem({
      workspaceId: workspace.id,
      projectId: priv.id,
      identifier: 'PRIV',
      reporterId: owner.id,
      title: 'secret widget',
    });

    // The outsider finds only the public-project match.
    signInAs({ userId: outsider.id, workspaceId: workspace.id });
    const asOutsider = await rows(await search('widget'));
    const outsiderIds = asOutsider.map((r) => r.id);
    expect(outsiderIds).toContain(pubItem.id);
    expect(outsiderIds).not.toContain(privItem.id);

    // The owner — who can browse both — finds both.
    signInAs(ownerCtx);
    const asOwner = (await rows(await search('widget'))).map((r) => r.id);
    expect(asOwner).toContain(pubItem.id);
    expect(asOwner).toContain(privItem.id);
  });

  it('caps the result at the mention-picker limit (8)', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PROD' });
    signInAs(fx.ctx);
    for (let i = 0; i < 15; i++) {
      await seedItem({ ...projectOf(fx), reporterId: fx.ownerId, title: `widget number ${i}` });
    }
    const body = await rows(await search('widget'));
    expect(body.length).toBeLessThanOrEqual(8);
    expect(body.length).toBe(8);
  });

  it('returns [] for a short, empty, whitespace, or missing query', async () => {
    const fx = await makeWorkItemFixture({ identifier: 'PROD' });
    signInAs(fx.ctx);
    await seedItem({ ...projectOf(fx), reporterId: fx.ownerId, title: 'anything goes' });

    expect(await rows(await search(''))).toEqual([]);
    expect(await rows(await search('   '))).toEqual([]);
    // One char is below QUICK_SEARCH_MIN_QUERY_LENGTH (2).
    expect(await rows(await search('a'))).toEqual([]);
    // No `q` param at all is treated as the empty query.
    expect(await rows(await search())).toEqual([]);
  });
});
