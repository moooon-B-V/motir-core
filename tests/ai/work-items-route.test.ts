import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import {
  PLANNER_BUG_HOME_MARKER,
  PLANNER_BUG_HOME_EPIC_TITLE,
  PLANNER_BUG_HOME_STORY_TITLE,
} from '@/lib/ai/plannerBugHome';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { POST } from '@/app/api/internal/ai/work-items/route';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-1450 — the internal service-auth bug-filing route `POST
// /api/internal/ai/work-items`. Real Postgres (no DB mocks). Exercises the route
// end-to-end (which covers `aiWorkItemsService.fileBug` + the MOTIR-1451 auth +
// `createWorkItem`): a successful bug create as the system principal, the auth
// rejections, body validation, and the create/parent guard failures.

const SECRET = 'core-callback-secret-test';
const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
  process.env['CORE_CALLBACK_SECRET'] = SECRET;
});

afterAll(async () => {
  await db.$disconnect();
});

/** A META workspace + `MOTIR` project + the system principal — the seed's shape. */
async function makeMetaTenant() {
  const owner = await usersService.createUser({
    email: 'owner@example.com',
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'moooon',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'motir',
    identifier: 'MOTIR',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  const { userId: systemUserId } = await seedSystemPrincipal({
    workspaceId: workspace.id,
    projectId: project.id,
  });
  const ownerCtx: ServiceContext = { userId: owner.id, workspaceId: workspace.id };
  return { owner, ownerCtx, workspace, project, systemUserId };
}

function post(
  bodyObj: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${SECRET}` },
) {
  return POST(
    new Request('http://internal/api/internal/ai/work-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(bodyObj),
    }),
  );
}

describe('POST /api/internal/ai/work-items — success', () => {
  it('files a `kind: bug` into the named project AS the system principal → 201 + key', async () => {
    const { project, systemUserId } = await makeMetaTenant();
    const res = await post({
      projectKey: 'MOTIR',
      kind: 'bug',
      title: 'Planner mis-scoped a card',
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { key: string; id: string };
    expect(json.key).toMatch(/^MOTIR-\d+$/);

    const row = await db.workItem.findUnique({ where: { id: json.id } });
    expect(row?.kind).toBe('bug');
    expect(row?.projectId).toBe(project.id);
    expect(row?.reporterId).toBe(systemUserId);
    expect(row?.parentId).toBeNull(); // project-root (no parentKey)
  });

  it('resolves the project key case-insensitively', async () => {
    await makeMetaTenant();
    const res = await post({ projectKey: 'motir', kind: 'bug', title: 'lowercase key' });
    expect(res.status).toBe(201);
  });

  it('files under a valid parent when parentKey is supplied', async () => {
    const { ownerCtx, project } = await makeMetaTenant();
    const story = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'story', title: 'A story' },
      ownerCtx,
    );
    const res = await post({
      projectKey: 'MOTIR',
      kind: 'bug',
      title: 'bug under the story',
      parentKey: story.identifier,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string };
    const row = await db.workItem.findUnique({ where: { id: json.id } });
    expect(row?.parentId).toBe(story.id);
  });
});

describe('POST /api/internal/ai/work-items — auth (MOTIR-1451 service bearer only)', () => {
  it('rejects a missing bearer → 401', async () => {
    await makeMetaTenant();
    const res = await post({ projectKey: 'MOTIR', kind: 'bug', title: 'x' }, {});
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('service_unauthorized');
  });

  it('rejects a wrong bearer → 401', async () => {
    await makeMetaTenant();
    const res = await post(
      { projectKey: 'MOTIR', kind: 'bug', title: 'x' },
      { authorization: 'Bearer nope' },
    );
    expect(res.status).toBe(401);
  });

  it('fails closed when CORE_CALLBACK_SECRET is unset → 401', async () => {
    await makeMetaTenant();
    delete process.env['CORE_CALLBACK_SECRET'];
    const res = await post(
      { projectKey: 'MOTIR', kind: 'bug', title: 'x' },
      { authorization: 'Bearer anything' },
    );
    expect(res.status).toBe(401);
  });

  it('returns 500 when the system principal is not provisioned', async () => {
    // A project exists but NO seedSystemPrincipal → the principal can't resolve.
    const owner = await usersService.createUser({
      email: 'o@example.com',
      password: PASSWORD,
      name: 'O',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'moooon',
      ownerUserId: owner.id,
    });
    await projectsService.createProject({
      name: 'motir',
      identifier: 'MOTIR',
      workspaceId: workspace.id,
      actorUserId: owner.id,
    });
    const res = await post({ projectKey: 'MOTIR', kind: 'bug', title: 'x' });
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe('system_principal_not_provisioned');
  });
});

describe('POST /api/internal/ai/work-items — validation + guards (typed, never 500)', () => {
  it('rejects a non-bug kind → 422', async () => {
    await makeMetaTenant();
    const res = await post({ projectKey: 'MOTIR', kind: 'story', title: 'x' });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('WORK_ITEMS_UNSUPPORTED_KIND');
  });

  it('rejects a missing title → 400', async () => {
    await makeMetaTenant();
    const res = await post({ projectKey: 'MOTIR', kind: 'bug' });
    expect(res.status).toBe(400);
  });

  it('rejects malformed JSON → 400', async () => {
    await makeMetaTenant();
    const res = await POST(
      new Request('http://internal/api/internal/ai/work-items', {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
        body: 'not json',
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown projectKey (no existence leak)', async () => {
    await makeMetaTenant();
    const res = await post({ projectKey: 'NOPE', kind: 'bug', title: 'x' });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('PROJECT_NOT_FOUND');
  });

  it('returns 404 for an unknown parentKey', async () => {
    await makeMetaTenant();
    const res = await post({
      projectKey: 'MOTIR',
      kind: 'bug',
      title: 'x',
      parentKey: 'MOTIR-9999',
    });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('WORK_ITEM_NOT_FOUND');
  });

  it('returns 422 for a parent the kind-parent matrix forbids (bug under bug)', async () => {
    const { ownerCtx, project } = await makeMetaTenant();
    // The matrix allows `subtask` under a bug, but not another `bug`.
    const topBug = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'bug', title: 'parent bug' },
      ownerCtx,
    );
    const res = await post({
      projectKey: 'MOTIR',
      kind: 'bug',
      title: 'child bug',
      parentKey: topBug.identifier,
    });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('ILLEGAL_PARENT_TYPE');
  });
});

describe('POST /api/internal/ai/work-items — planner-bug-home marker (MOTIR-1466 · MOTIR-2201)', () => {
  /** The home: the root epic the marker resolves to. It IS the bug parent — no
   *  child row participates in resolution (MOTIR-2201). */
  async function createHomeEpic(projectId: string, ctx: ServiceContext): Promise<{ id: string }> {
    return workItemsService.createWorkItem(
      { projectId, kind: 'epic', title: PLANNER_BUG_HOME_EPIC_TITLE },
      ctx,
    );
  }

  it('files under the home EPIC when the epic has ONLY non-story children — the live 2026-08-05 state (MOTIR-2201)', async () => {
    const { ownerCtx, project } = await makeMetaTenant();
    const epic = await createHomeEpic(project.id, ownerCtx);
    // Exactly the shape that broke the old two-hop resolution: the home story was
    // re-parented away, leaving the epic with `bug` + `task` children only. Under
    // the old `getFirstChildOfKind(epic, 'story')` this 404'd; the marker must
    // still resolve.
    await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: 'bug',
        title: 'a previously auto-filed bug',
        parentId: epic.id,
      },
      ownerCtx,
    );
    await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'a triage task', parentId: epic.id },
      ownerCtx,
    );
    const storyChildren = await db.workItem.count({
      where: { parentId: epic.id, kind: 'story' },
    });
    expect(storyChildren).toBe(0); // the precondition this test exists to cover

    const res = await post({
      projectKey: 'MOTIR',
      kind: 'bug',
      title: 'auto-filed planner bug',
      parentKey: PLANNER_BUG_HOME_MARKER,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string };
    const row = await db.workItem.findUnique({ where: { id: json.id } });
    expect(row?.parentId).toBe(epic.id); // landed under the home epic, not root
  });

  it('files under the home EPIC when it has NO children at all', async () => {
    const { ownerCtx, project } = await makeMetaTenant();
    const epic = await createHomeEpic(project.id, ownerCtx);
    const res = await post({
      projectKey: 'MOTIR',
      kind: 'bug',
      title: 'first bug in an empty home',
      parentKey: PLANNER_BUG_HOME_MARKER,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string };
    const row = await db.workItem.findUnique({ where: { id: json.id } });
    expect(row?.parentId).toBe(epic.id);
  });

  it('files under the EPIC even when a story child exists — no child row is load-bearing', async () => {
    const { ownerCtx, project } = await makeMetaTenant();
    const epic = await createHomeEpic(project.id, ownerCtx);
    // The migration-created home story. Resolution must NOT prefer it: reading a
    // child row back into the path is the regression this asserts against.
    const story = await workItemsService.createWorkItem(
      {
        projectId: project.id,
        kind: 'story',
        title: PLANNER_BUG_HOME_STORY_TITLE,
        parentId: epic.id,
      },
      ownerCtx,
    );
    const res = await post({
      projectKey: 'MOTIR',
      kind: 'bug',
      title: 'bug filed while a story child exists',
      parentKey: PLANNER_BUG_HOME_MARKER,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string };
    const row = await db.workItem.findUnique({ where: { id: json.id } });
    expect(row?.parentId).toBe(epic.id);
    expect(row?.parentId).not.toBe(story.id);
  });

  it('resolves the marker case-insensitively (config value casing is not load-bearing)', async () => {
    const { ownerCtx, project } = await makeMetaTenant();
    const epic = await createHomeEpic(project.id, ownerCtx);
    const res = await post({
      projectKey: 'MOTIR',
      kind: 'bug',
      title: 'upper-cased marker',
      parentKey: PLANNER_BUG_HOME_MARKER.toUpperCase(),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string };
    const row = await db.workItem.findUnique({ where: { id: json.id } });
    expect(row?.parentId).toBe(epic.id);
  });

  it('an ABSENT home epic fails LOUDLY — 500 `planner_bug_home_not_provisioned`, logged at error level (MOTIR-2201)', async () => {
    await makeMetaTenant(); // system principal present, but NO planner-bug home
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await post({
        projectKey: 'MOTIR',
        kind: 'bug',
        title: 'no home yet',
        parentKey: PLANNER_BUG_HOME_MARKER,
      });

      // A server invariant, NOT a caller error: never the 404 an unknown
      // `parentKey` gets, because the consumer swallows a failed file by design
      // and a 404 there reads as "that parent doesn't exist" rather than "core's
      // meta tenant is broken".
      expect(res.status).toBe(500);
      const body = (await res.json()) as { code: string; error: string };
      expect(body.code).toBe('planner_bug_home_not_provisioned');
      expect(body.error).toContain(PLANNER_BUG_HOME_EPIC_TITLE);

      // The failure signal a human actually sees in the logs.
      expect(logged).toHaveBeenCalledTimes(1);
      const [message, detail] = logged.mock.calls[0]!;
      expect(message).toContain('planner-bug home epic is missing');
      expect(detail).toMatchObject({
        projectKey: 'MOTIR',
        marker: PLANNER_BUG_HOME_MARKER,
        expectedEpicTitle: PLANNER_BUG_HOME_EPIC_TITLE,
      });
    } finally {
      logged.mockRestore();
    }
  });

  it('a home epic in ANOTHER workspace does not resolve the marker (tenant gate)', async () => {
    // The meta tenant the route acts in has no home; a same-titled epic in an
    // unrelated workspace must not be adopted.
    const other = await usersService.createUser({
      email: 'other@example.com',
      password: PASSWORD,
      name: 'Other',
    });
    const { workspace: otherWs } = await workspacesService.createWorkspace({
      name: 'acme',
      ownerUserId: other.id,
    });
    const otherProject = await projectsService.createProject({
      name: 'acme-app',
      identifier: 'ACME',
      workspaceId: otherWs.id,
      actorUserId: other.id,
    });
    await workItemsService.createWorkItem(
      { projectId: otherProject.id, kind: 'epic', title: PLANNER_BUG_HOME_EPIC_TITLE },
      { userId: other.id, workspaceId: otherWs.id },
    );
    await makeMetaTenant();

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await post({
        projectKey: 'MOTIR',
        kind: 'bug',
        title: 'cross-tenant home must not be used',
        parentKey: PLANNER_BUG_HOME_MARKER,
      });
      expect(res.status).toBe(500);
      expect((await res.json()).code).toBe('planner_bug_home_not_provisioned');
    } finally {
      logged.mockRestore();
    }
  });
});
