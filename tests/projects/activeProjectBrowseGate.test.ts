import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// MOTIR-6319 — three reads trusted the WORKSPACE tier where the PROJECT tier is
// the gate: `setActiveProject` let a workspace member pin a project they cannot
// enter, `getActiveProject` handed that pinned project back, and
// `listCandidateParents` returned its work-item titles. The reproduction below
// is the bug card's own fixture (a private — Members-only — project with a task
// and a story, and a workspace member never added to it), run against the real
// database; every assertion is the FIXED behaviour. `listReady`, which the
// inventory also suspected, is measured against a fixture WITH a ready leaf.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function setup() {
  const fx = await makeWorkItemFixture({ name: `APB ${seq}`, identifier: `APB${seq++}` });
  const task = await createTestWorkItem(fx, { kind: 'task', title: 'secret task' });
  const story = await createTestWorkItem(fx, { kind: 'story', title: 'secret story' });
  // The fixture helper writes the placeholder status `open`; a READY leaf is a
  // `todo` one, so the
  // task is given the project's initial status (the bug card's own fixture had
  // no ready leaf, which is why its `listReady` measurement was empty for the
  // owner too).
  await adminDb.workItem.update({ where: { id: task.id }, data: { status: 'todo' } });
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: projectAccessData('members'),
  });
  const outsider = await usersService.createUser({
    email: `apb-outsider-${seq++}@example.com`,
    password: 'hunter2hunter2',
    name: 'Outsider',
  });
  await workspacesService.addMember({ userId: outsider.id, workspaceId: fx.workspaceId });
  const outsiderCtx = { userId: outsider.id, workspaceId: fx.workspaceId };
  return { fx, task, story, outsider, outsiderCtx };
}

const activeOf = async (userId: string, workspaceId: string) =>
  (
    await adminDb.workspaceMembership.findUniqueOrThrow({
      where: { userId_workspaceId: { userId, workspaceId } },
    })
  ).activeProjectId;

describe('setActiveProject', () => {
  it('refuses a project the actor cannot enter as not-found, and leaves the pointer unchanged', async () => {
    const s = await setup();
    const before = await activeOf(s.outsider.id, s.fx.workspaceId);
    await expect(
      projectsService.setActiveProject({
        userId: s.outsider.id,
        workspaceId: s.fx.workspaceId,
        projectId: s.fx.projectId,
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(await activeOf(s.outsider.id, s.fx.workspaceId)).toBe(before);
  });

  it('still accepts a project the actor can enter', async () => {
    const s = await setup();
    await projectsService.setActiveProject({
      userId: s.fx.ownerId,
      workspaceId: s.fx.workspaceId,
      projectId: s.fx.projectId,
    });
    expect(await activeOf(s.fx.ownerId, s.fx.workspaceId)).toBe(s.fx.projectId);
  });
});

describe('getActiveProject', () => {
  const pinFor = (userId: string, workspaceId: string, projectId: string) =>
    adminDb.workspaceMembership.update({
      where: { userId_workspaceId: { userId, workspaceId } },
      data: { activeProjectId: projectId },
    });

  it('does not hand back a stored active project the actor can no longer enter, and recovers to one they can', async () => {
    const s = await setup();
    const open = await projectsService.createProject({
      actorUserId: s.fx.ownerId,
      workspaceId: s.fx.workspaceId,
      name: 'Open to all',
    });
    await adminDb.project.update({
      where: { id: open.id },
      data: projectAccessData('workspace'),
    });
    // The pointer as a forged call (or a revoked access) would have left it.
    await pinFor(s.outsider.id, s.fx.workspaceId, s.fx.projectId);

    const resolved = await projectsService.getActiveProject(s.outsider.id, s.fx.workspaceId);
    expect(resolved?.id).toBe(open.id);
    expect(await activeOf(s.outsider.id, s.fx.workspaceId)).toBe(open.id);
  });

  it('with NOTHING enterable, resolves to NO project and leaves the stale pointer unread (MOTIR-6548)', async () => {
    // Every project-scoped page sends this reader to the no-project landing
    // (`NO_PROJECT_PATH`) rather than to `/sign-in`, which bounced a signed-in
    // reader straight back — the loop MOTIR-6319's first cut hit in CI.
    const s = await setup();
    await pinFor(s.outsider.id, s.fx.workspaceId, s.fx.projectId);

    expect(await projectsService.getActiveProject(s.outsider.id, s.fx.workspaceId)).toBeNull();
    // …and the project's reads still refuse them.
    await expect(
      workItemsService.listCandidateParents(s.fx.projectId, 'subtask', s.outsiderCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('listCandidateParents', () => {
  it('refuses an actor without project:browse — no titles leak', async () => {
    const s = await setup();
    await expect(
      workItemsService.listCandidateParents(s.fx.projectId, 'subtask', s.outsiderCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('still lists the candidates for someone who can browse', async () => {
    const s = await setup();
    const rows = await workItemsService.listCandidateParents(s.fx.projectId, 'subtask', s.fx.ctx);
    expect(rows.map((r) => r.title).sort()).toEqual(['secret story', 'secret task']);
  });
});

describe('listReady — measured with a ready leaf', () => {
  it('lists the ready leaf for a browser and refuses an outsider as not-found', async () => {
    const s = await setup();
    const asOwner = await workItemsService.listReady(s.fx.projectId, {}, s.fx.ctx);
    expect(asOwner.items.map((i) => i.title)).toContain('secret task');
    await expect(
      workItemsService.listReady(s.fx.projectId, {}, s.outsiderCtx),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});
