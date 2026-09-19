import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { POST } from '@/app/api/internal/ai/work-items/route';
import { PLANNER_BUG_HOME_MARKER, PLANNER_BUG_HOME_STORY_TITLE } from '@/lib/ai/plannerBugHome';
import { db } from '@/lib/db';
import { bugDestinationService } from '@/lib/services/bugDestinationService';
import { foldersService } from '@/lib/services/foldersService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { seededBugsFolderId } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The BUG DESTINATION resolver and the filer that reads it — Story MOTIR-4927 ·
// Subtask MOTIR-4937. `POST /api/internal/ai/work-items` (`aiWorkItemsService.
// fileBug`) files a bug that names NO parent into the project's destination: its
// folder, or the project root. A literal parent key is kept exactly as before and
// never also filed. The `@planner-bug-home` marker is not a parent at all since
// MOTIR-5822: it FILES, through `resolvePlannerBug`'s ladder. Driven through the
// real route and the real filer, against real Postgres.

const SECRET = 'core-callback-secret-test';

beforeEach(async () => {
  await truncateAuthTables();
  process.env['CORE_CALLBACK_SECRET'] = SECRET;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The seed's shape: a workspace, the `MOTIR` project, and the system principal. */
async function makeTenant() {
  const owner = await usersService.createUser({
    email: 'dest-owner@example.com',
    password: 'hunter2hunter2',
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
  await seedSystemPrincipal({ workspaceId: workspace.id, projectId: project.id });
  const ctx: ServiceContext = { userId: owner.id, workspaceId: workspace.id };
  return { ctx, workspace, project };
}

async function fileBug(extra: Record<string, unknown> = {}) {
  const res = await POST(
    new Request('http://internal/api/internal/ai/work-items', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ projectKey: 'MOTIR', kind: 'bug', title: 'A filed bug', ...extra }),
    }),
  );
  expect(res.status).toBe(201);
  const { id } = (await res.json()) as { id: string };
  return adminDb.workItem.findUniqueOrThrow({ where: { id } });
}

async function pointAt(projectId: string, folderId: string | null) {
  await adminDb.project.update({
    where: { id: projectId },
    data: { bugDestinationFolderId: folderId },
  });
}

describe('bugDestinationService.resolvePlannerBug — the planner-bug ladder (MOTIR-5822)', () => {
  const resolvePlanner = (projectId: string, workspaceId: string) =>
    withWorkspaceServiceContext(workspaceId, (tx) =>
      bugDestinationService.resolvePlannerBug(projectId, tx),
    );

  it('rung 1 — the planner-bug pointer, when it is set', async () => {
    const { ctx, workspace, project } = await makeTenant();
    const planning = await foldersService.createFolder(
      { projectId: project.id, parentFolderId: null, name: 'Planning bugs' },
      ctx,
    );
    await adminDb.project.update({
      where: { id: project.id },
      data: { plannerBugDestinationFolderId: planning.id },
    });

    expect(await resolvePlanner(project.id, workspace.id)).toEqual({ folderId: planning.id });
  });

  it('rung 2 — unset ⇒ the PRODUCT bug destination', async () => {
    const { workspace, project } = await makeTenant();
    const bugs = await seededBugsFolderId(project.id);

    expect(await resolvePlanner(project.id, workspace.id)).toEqual({ folderId: bugs });
  });

  it('rung 3 — both unset ⇒ the project root', async () => {
    const { workspace, project } = await makeTenant();
    await pointAt(project.id, null);

    expect(await resolvePlanner(project.id, workspace.id)).toEqual({ folderId: null });
  });
});

describe('bugDestinationService.resolve', () => {
  it('returns the folder the pointer names, and null for a deliberate root', async () => {
    const { workspace, project } = await makeTenant();
    const bugs = await seededBugsFolderId(project.id);

    await expect(
      withWorkspaceServiceContext(workspace.id, (tx) =>
        bugDestinationService.resolve(project.id, tx),
      ),
    ).resolves.toEqual({ folderId: bugs });

    await pointAt(project.id, null);
    await expect(
      withWorkspaceServiceContext(workspace.id, (tx) =>
        bugDestinationService.resolve(project.id, tx),
      ),
    ).resolves.toEqual({ folderId: null });
  });
});

describe('fileBug with no parentKey files into the bug destination', () => {
  it('lands in the seeded Bugs folder, unparented', async () => {
    const { project } = await makeTenant();

    const bug = await fileBug();

    expect(bug.folderId).toBe(await seededBugsFolderId(project.id));
    expect(bug.parentId).toBeNull();
  });

  it('follows a re-pointed destination to the NEXT bug', async () => {
    const { ctx, project } = await makeTenant();
    const bugs = await seededBugsFolderId(project.id);
    const first = await fileBug();
    const triage = await foldersService.createFolder(
      { projectId: project.id, parentFolderId: bugs, name: 'Triage' },
      ctx,
    );

    await pointAt(project.id, triage.id);
    const second = await fileBug();

    expect(first.folderId).toBe(bugs);
    expect(second.folderId).toBe(triage.id);
  });

  it('files UNPLACED at the project root when the destination deliberately names none', async () => {
    const { project } = await makeTenant();
    await pointAt(project.id, null);

    const bug = await fileBug();

    expect(bug.folderId).toBeNull();
    expect(bug.parentId).toBeNull();
  });
});

describe('a named parent key is kept, and the destination is ignored', () => {
  it('the @planner-bug-home marker is NOT a parent — it FILES, falling back to this destination when its own pointer is unset (MOTIR-5822)', async () => {
    const { ctx, project } = await makeTenant();
    const bugs = await seededBugsFolderId(project.id);
    // A story titled like the OLD home no longer attracts the marker.
    await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'story', title: PLANNER_BUG_HOME_STORY_TITLE },
      ctx,
    );

    const bug = await fileBug({ parentKey: PLANNER_BUG_HOME_MARKER });

    expect(bug.parentId).toBeNull();
    expect(bug.folderId).toBe(bugs);
  });

  it('a literal parent key still files under that parent, not into the destination', async () => {
    const { ctx, project } = await makeTenant();
    const story = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'story', title: 'Checkout' },
      ctx,
    );

    const bug = await fileBug({ parentKey: story.identifier });

    expect(bug.parentId).toBe(story.id);
    expect(bug.folderId).toBeNull();
  });
});
