import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { readProjectForService, readWorkItemForService } from '@/lib/workspaces/tenantRead';
import { automationEngineService } from '@/lib/services/automationEngineService';
import { mentionNotificationsService } from '@/lib/services/mentionNotificationsService';
import { notificationFanInService } from '@/lib/services/notificationFanInService';
import type {
  NotificationFanInRegistry,
  NotificationSourceEvent,
} from '@/lib/services/notificationFanInService';
import { watcherNotificationsService } from '@/lib/services/watcherNotificationsService';
import { projectsService } from '@/lib/services/projectsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { ProjectNotFoundError, ProjectWorkspaceMismatchError } from '@/lib/projects/errors';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { captureEmailEvents } from '../helpers/jobs';

// The USERLESS tenant reads, proved RETURNING under the non-bypass role
// (MOTIR-2685 · `docs/rls-runtime-role-inventory.md` Finding 4, second branch).
//
// MOTIR-2569 bound every tenant read whose caller carries an acting user. These do not
// have one: a webhook, a scheduled notification sweep, an automation rule firing on a
// change nobody is watching, and the `workspaceId`-only service helpers. Each takes a
// workspaceId off an event envelope or a service argument and used to read `project` /
// `work_item` on the `db` singleton — binding nothing, so under `motir_app` the
// workspace-keyed policies compared against NULL, the row was invisible, and the caller
// reported the tenant-correct answer as MISSING: a policy mode that could not be read, a
// legal transition reported as illegal, a fan-out that dropped every recipient. No RLS
// denial was logged, because nothing was denied — the query succeeded and returned zero
// rows. They now bind `withWorkspaceServiceContext` (workspace tier, no user).
//
// ⚠️ THE RETURN ASSERTIONS ARE THE POINT — the same trap `tenantRead.test.ts` names. A
// read that finds NOTHING passes every "a foreign tenant is not visible" test ever
// written; that is precisely the defect here, wearing the costume of a security
// property. So every path is asserted in BOTH directions and the ADMIT comes first.
//
// Like `tenantRead.test.ts` / `membershipGate.test.ts`, this file runs in BOTH modes:
// with `TEST_DB_APP_ROLE=1` it is the proof, with the flag unset (what CI runs today) it
// is the regression guard. Every assertion below holds identically in both — with ONE
// documented exception, on `assertProjectInWorkspace`'s refusal, explained at that test.
//
// The fixture writes through `adminDb` (the owner): it seeds two tenants, which is
// exactly what the policies forbid, and the code under test goes through `@/lib/db`.

interface Tenant {
  ownerId: string;
  memberId: string;
  workspaceId: string;
  projectId: string;
  workItemId: string;
}

let home: Tenant;
let neighbour: Tenant;
let capture: ReturnType<typeof captureEmailEvents>;

beforeEach(async () => {
  await truncateAuthTables();
  home = await seedTenant('home', 'HOME');
  neighbour = await seedTenant('nbr', 'NBR');
  // The one external seam: `sendEvent` publishes to Inngest, which has no dev server
  // here. Capturing it keeps the mention/watcher fan-outs off the network — it is not
  // a stub of anything under test.
  capture = captureEmailEvents();
});

afterEach(() => {
  capture.restore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the readers themselves', () => {
  it('readProjectForService RETURNS the project of the bound workspace', async () => {
    const project = await readProjectForService(home.projectId, home.workspaceId);
    expect(project?.id).toBe(home.projectId);
  });

  it('readProjectForService does not return another workspace’s project', async () => {
    // Under the app role RLS hides it; under the owner role it comes back and the
    // CALLER's `workspaceId` check refuses it. Both are correct, and both are why every
    // call site's explicit check must stay — assert on the tenant, not on null.
    const project = await readProjectForService(neighbour.projectId, home.workspaceId);
    expect(project?.workspaceId).not.toBe(home.workspaceId);
  });

  it('readWorkItemForService RETURNS the item of the bound workspace', async () => {
    const item = await readWorkItemForService(home.workItemId, home.workspaceId);
    expect(item?.id).toBe(home.workItemId);
  });

  it('readWorkItemForService does not return another workspace’s item', async () => {
    const item = await readWorkItemForService(neighbour.workItemId, home.workspaceId);
    expect(item?.workspaceId).not.toBe(home.workspaceId);
  });

  it('sees an item in ANY of the workspace’s projects — nothing binds app.project_id', async () => {
    // `withWorkspaceServiceContext` binds only `app.workspace_id`, so the RESTRICTIVE
    // `work_item_project_narrow` policy passes on its
    // `coalesce(current_setting('app.project_id', true), '') = ''` branch and every
    // project in the workspace stays visible. That is the property these callers need:
    // `automationEngineService.resolveProjectId` exists to LEARN the project from the
    // row, so a narrowed bind would hide the very row it is resolving.
    const second = await seedProject(home.workspaceId, 'HOME2');
    const item = await seedWorkItem(home, second.id, 'HOME2-1');
    const read = await readWorkItemForService(item.id, home.workspaceId);
    expect(read?.id).toBe(item.id);
  });
});

describe('workflowsService — the workspaceId-only helpers', () => {
  it('requirePolicyMode RESOLVES the project’s real policy mode (via getWorkflow)', async () => {
    // `requirePolicyMode` is module-private; `getWorkflow` is its shipped doorway and
    // returns the mode it resolved. `restricted` is the seed default, and it is the
    // answer that matters: unbound, this threw ProjectNotFoundError instead.
    const workflow = await workflowsService.getWorkflow(home.projectId, home.workspaceId);
    expect(workflow.policyMode).toBe('restricted');
  });

  it('requirePolicyMode refuses a cross-workspace project', async () => {
    await expect(
      workflowsService.getWorkflow(neighbour.projectId, home.workspaceId),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('canTransition ADMITS a seeded transition under a restricted policy', async () => {
    // The admit, first and deliberately. Under `restricted` the answer is a CONJUNCTION
    // of four reads — project, both statuses, the transition row — across three
    // workspace-keyed tables, which is why the whole body binds one context rather than
    // just the project read. Any one of them unbound returns this as `false`, i.e. a
    // legal move reported as illegal with nothing logged.
    await seedRestrictedWorkflow(home);
    expect(
      await workflowsService.canTransition(home.projectId, 'todo', 'doing', home.workspaceId),
    ).toBe(true);
  });

  it('canTransition refuses a pair with no transition row, in the same project', async () => {
    // The negative that is NOT about tenancy — it proves the admit above came from the
    // seeded EDGE and not from the method saying yes to everything it can now see.
    await seedRestrictedWorkflow(home);
    expect(
      await workflowsService.canTransition(home.projectId, 'doing', 'todo', home.workspaceId),
    ).toBe(false);
  });

  it('canTransition refuses a cross-workspace project, in both policy modes', async () => {
    await seedRestrictedWorkflow(neighbour);
    expect(
      await workflowsService.canTransition(neighbour.projectId, 'todo', 'doing', home.workspaceId),
    ).toBe(false);

    await adminDb.project.update({
      where: { id: neighbour.projectId },
      data: { workflowPolicyMode: 'open' },
    });
    // `open` is the arm that returns true on the project read ALONE, so it is the one a
    // cross-tenant caller could ride if the workspace check were dropped.
    expect(
      await workflowsService.canTransition(neighbour.projectId, 'todo', 'doing', home.workspaceId),
    ).toBe(false);
  });

  it('canTransition is legal for a no-op move without reading anything', async () => {
    // The short-circuit above the transaction: same key in, true out, even for a project
    // id that does not exist at all.
    expect(
      await workflowsService.canTransition('no-such-project', 'todo', 'todo', home.workspaceId),
    ).toBe(true);
  });
});

describe('projectsService.assertProjectInWorkspace', () => {
  it('RESOLVES the project of the given workspace', async () => {
    const project = await projectsService.assertProjectInWorkspace(
      home.projectId,
      home.workspaceId,
    );
    expect(project.id).toBe(home.projectId);
  });

  it('refuses a cross-workspace project', async () => {
    // ⚠️ The one place a role difference is OBSERVABLE, and it is the documented posture
    // rather than a mode-split expectation: under the owner role the foreign row comes
    // back and the explicit comparison throws `ProjectWorkspaceMismatchError`; under
    // `motir_app` RLS hides it first and the earlier branch throws
    // `ProjectNotFoundError`. `tests/e2e/project-isolation.spec.ts` records exactly this
    // for the in-tx variant ("Either typed error"), and the collapse is the BETTER
    // posture — it is the no-existence-leak `getByKey` deliberately makes. So this
    // asserts what holds in both roles: the call is REFUSED with one of the two typed
    // refusals, and no foreign project is ever returned.
    await expect(
      projectsService.assertProjectInWorkspace(neighbour.projectId, home.workspaceId),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ProjectWorkspaceMismatchError || err instanceof ProjectNotFoundError,
    );
  });

  it('throws ProjectNotFoundError for a project id that does not exist', async () => {
    await expect(
      projectsService.assertProjectInWorkspace('no-such-project', home.workspaceId),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('the job runtime — one test per path, both directions', () => {
  it('automationEngineService.resolveProjectId RESOLVES the item’s project', async () => {
    const projectId = await automationEngineService.resolveProjectId({
      trigger: 'transitioned',
      workspaceId: home.workspaceId,
      workItemId: home.workItemId,
      eventId: 'evt-1',
    });
    expect(projectId).toBe(home.projectId);
  });

  it('automationEngineService.resolveProjectId no-ops on a cross-workspace event', async () => {
    const projectId = await automationEngineService.resolveProjectId({
      trigger: 'transitioned',
      workspaceId: home.workspaceId,
      workItemId: neighbour.workItemId,
      eventId: 'evt-2',
    });
    expect(projectId).toBeNull();
  });

  it('mentionNotificationsService.fanOut RESOLVES the item and notifies the mentioned member', async () => {
    const result = await mentionNotificationsService.fanOut({
      workspaceId: home.workspaceId,
      workItemId: home.workItemId,
      authorId: home.ownerId,
      mentionedUserIds: [home.memberId],
      source: { kind: 'description', revisionId: 'rev-1' },
    });
    expect(result.notifiedUserIds).toEqual([home.memberId]);
  });

  it('mentionNotificationsService.fanOut no-ops on a cross-workspace event', async () => {
    const result = await mentionNotificationsService.fanOut({
      workspaceId: home.workspaceId,
      workItemId: neighbour.workItemId,
      authorId: home.ownerId,
      mentionedUserIds: [home.memberId],
      source: { kind: 'description', revisionId: 'rev-1' },
    });
    expect(result.notifiedUserIds).toEqual([]);
  });

  it('watcherNotificationsService.fanOut RESOLVES the item and notifies the watcher', async () => {
    await adminDb.watcher.create({ data: { workItemId: home.workItemId, userId: home.memberId } });
    const result = await watcherNotificationsService.fanOut({
      kind: 'transition',
      workspaceId: home.workspaceId,
      workItemId: home.workItemId,
      actorId: home.ownerId,
      revisionId: 'rev-1',
      fromStatusKey: 'todo',
      toStatusKey: 'doing',
    });
    expect(result.notifiedUserIds).toEqual([home.memberId]);
  });

  it('watcherNotificationsService.fanOut no-ops on a cross-workspace event', async () => {
    await adminDb.watcher.create({
      data: { workItemId: neighbour.workItemId, userId: neighbour.memberId },
    });
    const result = await watcherNotificationsService.fanOut({
      kind: 'transition',
      workspaceId: home.workspaceId,
      workItemId: neighbour.workItemId,
      actorId: home.ownerId,
      revisionId: 'rev-1',
      fromStatusKey: 'todo',
      toStatusKey: 'doing',
    });
    expect(result.notifiedUserIds).toEqual([]);
  });

  it('notificationFanInService.fanIn RESOLVES the item and hands it to the descriptor', async () => {
    // Driven through the registry INJECTION POINT the extensibility test uses, so the
    // observable is the descriptor's own input: `buildPlan` receives the resolved
    // `work_item`, which is the read this card binds. Returning null keeps the rest of
    // the pipeline out of the assertion — a plan-less descriptor is a documented clean
    // no-op, so a passing test cannot be confused with "it wrote some rows".
    const { registry, seen } = recordingRegistry();
    await notificationFanInService.fanIn(
      'test/probe',
      { workspaceId: home.workspaceId, workItemId: home.workItemId },
      registry,
    );
    expect(seen.map((i) => i.id)).toEqual([home.workItemId]);
  });

  it('notificationFanInService.fanIn no-ops on a cross-workspace event', async () => {
    const { registry, seen } = recordingRegistry();
    const result = await notificationFanInService.fanIn(
      'test/probe',
      { workspaceId: home.workspaceId, workItemId: neighbour.workItemId },
      registry,
    );
    expect(seen).toEqual([]);
    expect(result.writtenUserIds).toEqual([]);
  });
});

/** A synthetic one-entry registry that records the items its descriptor is handed. */
function recordingRegistry(): { registry: NotificationFanInRegistry; seen: WorkItem[] } {
  const seen: WorkItem[] = [];
  const registry: NotificationFanInRegistry = {
    'test/probe': {
      notificationType: 'probe',
      category: 'direct',
      async buildPlan(_event: NotificationSourceEvent, item: WorkItem) {
        seen.push(item);
        return null;
      },
    },
  };
  return { registry, seen };
}

async function seedProject(workspaceId: string, identifier: string) {
  return adminDb.project.create({
    data: {
      workspaceId,
      name: `Project ${identifier}`,
      slug: identifier.toLowerCase(),
      identifier,
    },
  });
}

async function seedWorkItem(t: Tenant, projectId: string, identifier: string) {
  return adminDb.workItem.create({
    data: {
      workspaceId: t.workspaceId,
      projectId,
      kind: 'task',
      identifier,
      key: Number(identifier.split('-')[1]),
      title: `${identifier} item`,
      reporterId: t.ownerId,
      position: 'a0',
      backlogRank: 'a0',
    },
  });
}

/** Two statuses and ONE directed edge between them, so `canTransition` has a real row. */
async function seedRestrictedWorkflow(t: Tenant): Promise<void> {
  const [todo, doing] = await Promise.all([
    adminDb.workflowStatus.create({
      data: {
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        key: 'todo',
        label: 'To Do',
        category: 'todo',
        position: 'a0',
        isInitial: true,
      },
    }),
    adminDb.workflowStatus.create({
      data: {
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        key: 'doing',
        label: 'Doing',
        category: 'in_progress',
        position: 'a1',
      },
    }),
  ]);
  await adminDb.workflowTransition.create({
    data: {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      fromStatusId: todo.id,
      toStatusId: doing.id,
    },
  });
}

/** The full tenant root chain, plus a second member, one project and one item. */
async function seedTenant(tag: string, identifier: string): Promise<Tenant> {
  const owner = await adminDb.user.create({
    data: { email: `${tag}-owner@example.com`, name: `${tag} owner` },
  });
  const member = await adminDb.user.create({
    data: { email: `${tag}-member@example.com`, name: `${tag} member` },
  });
  const organization = await adminDb.organization.create({
    data: { name: `Org ${tag}`, slug: `org-${tag}` },
  });
  await adminDb.organizationMembership.createMany({
    data: [
      { organizationId: organization.id, userId: owner.id, role: 'owner' },
      { organizationId: organization.id, userId: member.id, role: 'member' },
    ],
  });
  const workspace = await adminDb.workspace.create({
    data: { name: `Workspace ${tag}`, slug: `ws-${tag}`, organizationId: organization.id },
  });
  await adminDb.workspaceMembership.createMany({
    data: [
      { userId: owner.id, workspaceId: workspace.id, role: 'owner' },
      { userId: member.id, workspaceId: workspace.id, role: 'member' },
    ],
  });
  const project = await seedProject(workspace.id, identifier);
  const t: Tenant = {
    ownerId: owner.id,
    memberId: member.id,
    workspaceId: workspace.id,
    projectId: project.id,
    workItemId: '',
  };
  const workItem = await seedWorkItem(t, project.id, `${identifier}-1`);
  t.workItemId = workItem.id;
  return t;
}
