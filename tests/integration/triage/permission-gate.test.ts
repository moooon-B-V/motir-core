import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { triageService } from '@/lib/services/triageService';
import { workItemsService } from '@/lib/services/workItemsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { PermissionDeniedError, ProjectAccessDeniedError } from '@/lib/projects/errors';
import { createTestProject } from '../../fixtures/projectFixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// `work_item:triage` + `work_item:delete` (Story MOTIR-2291 · Subtask MOTIR-2354).
//
// Both keys govern operations that ALREADY reached a gate, so the guard's counts
// do not move — what changes is WHICH gate, and the two corrections that matters
// are only visible from a test:
//
//   * a project MEMBER keeps every field edit and loses the delete cascade. That
//     pairing is the assertion: a test that only proved the refusal could not
//     tell "delete is narrower" from "the member lost the work item entirely".
//   * a project VIEWER can neither triage nor delete, and the triage QUEUE goes
//     with the actions — its contents are requests from outside the team that
//     nobody has accepted yet.

const PASSWORD = 'hunter2hunter2';

interface Fixture {
  projectId: string;
  projectKey: string;
  adminCtx: ServiceContext;
  memberCtx: ServiceContext;
  viewerCtx: ServiceContext;
}

let seq = 0;

async function makeFixture(label: string): Promise<Fixture> {
  seq += 1;
  const owner = await usersService.createUser({
    email: `tri-owner-${label}-${seq}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const ws = await workspacesService.createWorkspace({
    name: `Tri WS ${label} ${seq}`,
    ownerUserId: owner.id,
  });
  const workspaceId = ws.workspace.id;
  const project = await createTestProject({ workspaceId, actorUserId: owner.id });
  const ownerCtx: ServiceContext = { userId: owner.id, workspaceId };

  async function actor(role: 'admin' | 'member' | 'viewer'): Promise<ServiceContext> {
    const u = await usersService.createUser({
      email: `tri-${role}-${label}-${seq}@example.com`,
      password: PASSWORD,
      name: role,
    });
    await db.workspaceMembership.create({ data: { userId: u.id, workspaceId, role: 'member' } });
    await projectMembersService.addMember({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: u.id,
      role,
    });
    return { userId: u.id, workspaceId };
  }

  return {
    projectId: project.id,
    projectKey: project.identifier,
    adminCtx: await actor('admin'),
    memberCtx: await actor('member'),
    viewerCtx: await actor('viewer'),
  };
}

/** A plain work item authored by the admin — the row the delete cases act on. */
async function itemFor(fx: Fixture): Promise<string> {
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, title: 'Deletable', kind: 'task' },
    fx.adminCtx,
  );
  return item.id;
}

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
});

describe('work_item:delete — a member keeps every edit and loses the cascade', () => {
  it('lets a MEMBER edit the item and refuses them archive, unarchive and delete', async () => {
    const fx = await makeFixture('del-member');
    const id = await itemFor(fx);

    // The pairing that makes the key mean something: editing still works.
    await expect(
      workItemsService.updateWorkItem(id, { title: 'Renamed by a member' }, fx.memberCtx),
    ).resolves.toBeTruthy();

    await expect(workItemsService.archiveWorkItem(id, fx.memberCtx)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(workItemsService.deleteWorkItem(id, fx.memberCtx)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(workItemsService.getDeletePreview(id, fx.memberCtx)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    // nothing was destroyed
    expect(await db.workItem.findUnique({ where: { id } })).not.toBeNull();
  });

  it('refuses a VIEWER the same three, and admits the ADMIN', async () => {
    const fx = await makeFixture('del-admin');
    const id = await itemFor(fx);
    await expect(workItemsService.archiveWorkItem(id, fx.viewerCtx)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );

    // The preview and the destroy now ask the SAME key — the correction this card
    // makes. Both work for an admin; neither did for the member above.
    await expect(workItemsService.getDeletePreview(id, fx.adminCtx)).resolves.toBeTruthy();
    const archived = await workItemsService.archiveWorkItem(id, fx.adminCtx);
    expect(archived.archivedAt).not.toBeNull();
    await expect(workItemsService.unarchiveWorkItem(id, fx.adminCtx)).resolves.toBeTruthy();
    await expect(workItemsService.deleteWorkItem(id, fx.adminCtx)).resolves.toBeUndefined();
  });
});

describe('work_item:triage — the queue is a moderation surface', () => {
  it('refuses a VIEWER the queue and its detail read', async () => {
    const fx = await makeFixture('tri-viewer');
    await expect(
      triageService.getTriageQueue(fx.projectId, {}, fx.viewerCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      triageService.getTriageQueueByKey(fx.projectKey, {}, fx.viewerCtx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('still admits a project MEMBER — triaging is member-facing, not administrative', async () => {
    const fx = await makeFixture('tri-member');
    await expect(
      triageService.getTriageQueue(fx.projectId, {}, fx.memberCtx),
    ).resolves.toBeTruthy();
  });

  it('leaves SUBMITTING exactly where it was — the triage key never reaches it', async () => {
    // The correction: submitting is not triaging, so `createSubmission` does NOT
    // assert `work_item:triage` and its gate is byte-for-byte the shipped one —
    // a browse check here, then `workItemsService.createWorkItem`'s own edit
    // authority. A member files a request as before…
    const fx = await makeFixture('tri-submit');
    await expect(
      triageService.createSubmission(
        { projectKey: fx.projectKey, title: 'Please fix the thing', kind: 'bug' },
        fx.memberCtx,
      ),
    ).resolves.toBeTruthy();

    // …and a viewer is refused by that SAME pre-existing gate, not by the new
    // key. The error class is the assertion: `ProjectAccessDeniedError`, never
    // `PermissionDeniedError`, which is what proves the row moved in the
    // inventory and nowhere else.
    await expect(
      triageService.createSubmission(
        { projectKey: fx.projectKey, title: 'Nope', kind: 'bug' },
        fx.viewerCtx,
      ),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
  });
});
