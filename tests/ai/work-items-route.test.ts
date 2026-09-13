import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
import { adminDb } from '../helpers/adminDb';
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
  await adminDb.$disconnect();
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

    const row = await adminDb.workItem.findUnique({ where: { id: json.id } });
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
    const row = await adminDb.workItem.findUnique({ where: { id: json.id } });
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

describe('POST /api/internal/ai/work-items — the planner-bug-home marker resolves through the project’s BUG DESTINATION (MOTIR-1466 · MOTIR-2201 · MOTIR-4937)', () => {
  // ⚠️ WHAT CHANGED, AND WHY THIS BLOCK LOOKS DIFFERENT FROM ITS HISTORY.
  //
  // `@planner-bug-home` is unchanged as a marker — motir-ai still passes the
  // same literal — but MOTIR-4937 changed what it RESOLVES TO. It used to be a
  // project-wide match on a story titled `PLANNER_BUG_HOME_STORY_TITLE`; it is
  // now `bugDestinationService.resolve`, which reads the project's POINTER
  // first and keeps that title lookup only as a documented transitional branch.
  //
  // Two consequences this block is organised around:
  //
  //   1. Every project created through `createProject` now carries a SEEDED
  //      container and a pointer at it (MOTIR-4935), so the pointer is set in
  //      the common case and the legacy branch is not reached. The legacy tests
  //      below therefore CLEAR the pointer first — which is exactly the state
  //      the branch exists for: a project MOTIR-4936's backfill has not reached.
  //   2. An absent home no longer 500s. It files at the PROJECT ROOT. That is a
  //      deliberate contract change, and the test that used to assert the 500
  //      now asserts the root; see its own comment for the argument.

  /** A story titled like the legacy home. `parentId` lets a test place it
   *  anywhere — the legacy branch must not care where it sits. */
  async function createHomeStory(
    projectId: string,
    ctx: ServiceContext,
    parentId?: string,
  ): Promise<{ id: string }> {
    return workItemsService.createWorkItem(
      {
        projectId,
        kind: 'story',
        title: PLANNER_BUG_HOME_STORY_TITLE,
        ...(parentId ? { parentId } : {}),
      },
      ctx,
    );
  }

  async function createHomeEpic(projectId: string, ctx: ServiceContext): Promise<{ id: string }> {
    return workItemsService.createWorkItem(
      { projectId, kind: 'epic', title: PLANNER_BUG_HOME_EPIC_TITLE },
      ctx,
    );
  }

  /** Put the project back into the pre-backfill state the legacy branch serves:
   *  no pointer. Written through `adminDb` because this is fixture setup
   *  standing in for "a project that predates MOTIR-4934", not a user action. */
  async function clearDestination(projectId: string): Promise<void> {
    await adminDb.project.update({ where: { id: projectId }, data: { bugDestinationId: null } });
  }

  /** The container `createProject` seeded — read off the POINTER, never by
   *  title, which is the lookup this story exists to remove. */
  async function seededContainerId(projectId: string): Promise<string> {
    const row = await adminDb.project.findUniqueOrThrow({ where: { id: projectId } });
    if (row.bugDestinationId == null) throw new Error('project has no seeded destination');
    return row.bugDestinationId;
  }

  async function fileViaMarker(title: string, marker = PLANNER_BUG_HOME_MARKER) {
    const res = await post({ projectKey: 'MOTIR', kind: 'bug', title, parentKey: marker });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: string };
    return adminDb.workItem.findUnique({ where: { id: json.id } });
  }

  // ── the POINTER, which is now the primary answer ────────────────────────

  it('files under the SEEDED container — the pointer is what the marker resolves through', async () => {
    const { project } = await makeMetaTenant();
    const container = await seededContainerId(project.id);

    const row = await fileViaMarker('auto-filed planner bug');
    expect(row?.parentId).toBe(container);
  });

  it('follows a RE-POINTED destination — the whole point of a pointer over a title', async () => {
    const { ownerCtx, project } = await makeMetaTenant();
    const elsewhere = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'Triage', explanationMd: null },
      ownerCtx,
    );
    await adminDb.project.update({
      where: { id: project.id },
      data: { bugDestinationId: elsewhere.id },
    });

    const row = await fileViaMarker('filed after re-pointing');
    expect(row?.parentId).toBe(elsewhere.id);
  });

  it('files at the ROOT when the destination is deliberately null and nothing legacy exists', async () => {
    const { project } = await makeMetaTenant();
    await clearDestination(project.id);

    const row = await fileViaMarker('root by choice');
    // `null` is a DESTINATION, not a failure. A parentless bug is top-level and
    // impossible to miss, which is the case the story says teams will pick more
    // often than it looks.
    expect(row?.parentId).toBeNull();
  });

  it('recovers to the ROOT when the pointed-at container is ARCHIVED — never a dangling parent', async () => {
    const { project } = await makeMetaTenant();
    const container = await seededContainerId(project.id);
    await adminDb.workItem.update({
      where: { id: container },
      data: { archivedAt: new Date() },
    });

    const row = await fileViaMarker('container archived under us');
    // Archiving is a soft remove, so no foreign key can see it; the resolver is
    // the only thing that can. A person tidying their board must not be able to
    // turn filing into an outage.
    expect(row?.parentId).toBeNull();
  });

  it('recovers to the ROOT when the pointed-at container is DELETED — the FK nulls the pointer', async () => {
    const { project } = await makeMetaTenant();
    const container = await seededContainerId(project.id);
    await adminDb.workItem.delete({ where: { id: container } });

    const row = await fileViaMarker('container deleted under us');
    expect(row?.parentId).toBeNull();
    // The truth landed IN the column (`ON DELETE SET NULL`, MOTIR-4934) rather
    // than being inferred from a lookup miss.
    const project2 = await adminDb.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(project2.bugDestinationId).toBeNull();
  });

  it('resolves the marker case-insensitively (config value casing is not load-bearing)', async () => {
    const { project } = await makeMetaTenant();
    const container = await seededContainerId(project.id);

    const row = await fileViaMarker('upper-cased marker', PLANNER_BUG_HOME_MARKER.toUpperCase());
    expect(row?.parentId).toBe(container);
  });

  // ── the LEGACY title branch, which survives only until the backfill ──────

  it('falls through to the legacy home STORY when the project has NO pointer yet', async () => {
    // The transitional branch, and the state it exists for: a project
    // MOTIR-4936's backfill has not reached. Asserted rather than assumed —
    // this is what makes MOTIR-4937 safe to ship before the backfill has run
    // everywhere.
    const { ownerCtx, project } = await makeMetaTenant();
    await clearDestination(project.id);
    const home = await createHomeStory(project.id, ownerCtx);

    const row = await fileViaMarker('pre-backfill filing still lands at the home');
    expect(row?.parentId).toBe(home.id);
  });

  it('finds the legacy home wherever it SITS — no move_to_parent can void the fallback', async () => {
    const { ownerCtx, project } = await makeMetaTenant();
    await clearDestination(project.id);
    const epic = await createHomeEpic(project.id, ownerCtx);
    const home = await createHomeStory(project.id, ownerCtx, epic.id);
    // The 2026-08-05 move, replayed: the story goes somewhere else entirely.
    const elsewhere = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'epic', title: 'Some other epic' },
      ownerCtx,
    );
    await workItemsService.moveWorkItem(home.id, { newParentId: elsewhere.id }, ownerCtx);

    const row = await fileViaMarker('filed after the home story moved');
    expect(row?.parentId).toBe(home.id);
  });

  it('ignores the home EPIC — the epic was never a resolution input', async () => {
    const { ownerCtx, project } = await makeMetaTenant();
    await clearDestination(project.id);
    const epic = await createHomeEpic(project.id, ownerCtx);
    await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'a triage task', parentId: epic.id },
      ownerCtx,
    );
    const storyChildren = await adminDb.workItem.count({
      where: { parentId: epic.id, kind: 'story' },
    });
    expect(storyChildren).toBe(0); // the precondition this test exists to cover

    const row = await fileViaMarker('epic present, no home story');
    // No home STORY and no pointer ⇒ the root. The epic contributes nothing.
    expect(row?.parentId).toBeNull();
  });

  it('an ABSENT home no longer fails loudly — it files at the ROOT', async () => {
    // ⚠️ THE DELIBERATE CONTRACT CHANGE (MOTIR-4937). This assertion was a 500
    // (`planner_bug_home_not_provisioned`) and is now the root.
    //
    // The 500 was RIGHT while an absent home meant the loop was silently deaf:
    // there was nowhere else for the bug to go, motir-ai's filing path swallows
    // failures by design, and a quiet 404 would have let the self-learning loop
    // rot for weeks. There IS somewhere else now. Refusing to file a bug because
    // a container is missing would lose the bug outright, which is strictly
    // worse than filing it parentless where somebody will see it.
    //
    // `PlannerBugHomeNotProvisionedError` and its 500 mapping in the route are
    // KEPT, not deleted — the marker contract is public and the route must keep
    // translating the error for as long as anything can throw it.
    const { ownerCtx, project } = await makeMetaTenant();
    await clearDestination(project.id);
    await createHomeEpic(project.id, ownerCtx); // an epic alone is not a home

    const row = await fileViaMarker('no home yet');
    expect(row?.parentId).toBeNull();
  });

  it('never adopts a same-titled home from ANOTHER workspace (tenant gate)', async () => {
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
    await createHomeStory(otherProject.id, { userId: other.id, workspaceId: otherWs.id });

    const { project } = await makeMetaTenant();
    await clearDestination(project.id);

    const row = await fileViaMarker('cross-tenant home must not be used');
    // The meta tenant has no home of its own, so the answer is its own root —
    // never the neighbour's story. The legacy lookup is project-scoped, and the
    // pointer could not name a foreign row even if something tried (the
    // database refuses it: `trg_project_bug_destination_tenancy`).
    expect(row?.parentId).toBeNull();
  });
});
