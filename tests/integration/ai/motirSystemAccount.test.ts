import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { seedSystemPrincipal } from '@/scripts/plan-seed/systemPrincipal';
import { isMotirSystemUser, MOTIR_SYSTEM_USER_EMAIL } from '@/lib/ai/systemPrincipal';
import { motirSystemContext, resolveSystemPrincipal } from '@/lib/ai/serviceAuth';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE MOTIR SYSTEM ACCOUNT ENTERS ANY WORKSPACE (Story MOTIR-9220 · MOTIR-9329). One
// account with no membership in the customer workspace writes there under its own
// name, admitted by the gates by IDENTITY — and every real non-member is still
// refused. Real Postgres, no repository mocks; under `TEST_DB_APP_ROLE=1` every read
// and write here runs as the non-bypass app role, so a membership-keyed RLS policy
// cannot be what lets the account through.

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function user(tag: string) {
  return usersService.createUser({ email: `${tag}@example.com`, password: PASSWORD, name: tag });
}

/** A customer workspace + project the Motir account is NOT a member of, and the
 *  account itself — provisioned the way the seed does, into a separate meta tenant. */
async function fixture() {
  const owner = await user('owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: 'acme',
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    name: 'web',
    identifier: 'WEB',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  const metaOwner = await user('meta-owner');
  const { workspace: metaWs } = await workspacesService.createWorkspace({
    name: 'moooon',
    ownerUserId: metaOwner.id,
  });
  const metaProject = await projectsService.createProject({
    name: 'motir',
    identifier: 'MOTIR',
    workspaceId: metaWs.id,
    actorUserId: metaOwner.id,
  });
  const { userId: motirId } = await seedSystemPrincipal({
    workspaceId: metaWs.id,
    projectId: metaProject.id,
  });
  return { owner, workspace, project, metaWs, motirId };
}

describe('the Motir account writes into a workspace it is no member of', () => {
  it('has no membership row in the customer workspace', async () => {
    const { workspace, motirId } = await fixture();
    const row = await adminDb.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: motirId, workspaceId: workspace.id } },
    });
    expect(row).toBeNull();
  });

  it('creates, comments on and updates a work item — every write recorded as Motir', async () => {
    const { workspace, project, motirId } = await fixture();
    const ctx = await motirSystemContext(workspace.id);
    expect(ctx).toEqual({ userId: motirId, workspaceId: workspace.id });

    const bug = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'bug', title: 'Saving drops the mention' },
      ctx,
    );
    expect(bug.reporterId).toBe(motirId);

    const comment = await commentsService.addComment(
      bug.id,
      { bodyMd: 'Found in lib/comments/save.ts.' },
      ctx,
    );
    expect(comment.author).toMatchObject({ id: motirId, name: 'Motir' });

    await workItemsService.updateWorkItem(
      bug.id,
      { title: 'Saving a comment drops the mention' },
      ctx,
    );
    const revisions = await adminDb.workItemRevision.findMany({ where: { workItemId: bug.id } });
    expect(revisions.length).toBeGreaterThan(0);
    expect(new Set(revisions.map((r) => r.changedById))).toEqual(new Set([motirId]));

    const author = await adminDb.user.findUniqueOrThrow({ where: { id: motirId } });
    expect(author.name).toBe('Motir');
  });

  it('passes the project gate on any key, as a Manager does', async () => {
    const { workspace, project } = await fixture();
    const ctx = await motirSystemContext(workspace.id);
    await expect(
      projectAccessService.assertPermission(project.id, ctx, 'work_item:edit'),
    ).resolves.toBeUndefined();
  });
});

describe('every real non-member is still refused', () => {
  it('a non-member cannot create, comment or pass the project gate', async () => {
    const { workspace, project, owner } = await fixture();
    const outsider = await user('outsider');
    const ctx = { userId: outsider.id, workspaceId: workspace.id };
    const bug = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'bug', title: 'An owner bug' },
      { userId: owner.id, workspaceId: workspace.id },
    );

    await expect(
      workItemsService.createWorkItem({ projectId: project.id, kind: 'bug', title: 'x' }, ctx),
    ).rejects.toThrow();
    await expect(commentsService.addComment(bug.id, { bodyMd: 'hi' }, ctx)).rejects.toThrow();
    await expect(
      projectAccessService.assertPermission(project.id, ctx, 'work_item:edit'),
    ).rejects.toThrow();
    expect(await isMotirSystemUser(outsider.id)).toBe(false);
  });

  it('identity is the stored account, not a name: a user called Motir gains nothing', async () => {
    const { workspace, project } = await fixture();
    const impostor = await usersService.createUser({
      email: 'motir@example.com',
      password: PASSWORD,
      name: 'Motir',
    });
    expect(await isMotirSystemUser(impostor.id)).toBe(false);
    await expect(
      workItemsService.createWorkItem(
        { projectId: project.id, kind: 'bug', title: 'x' },
        { userId: impostor.id, workspaceId: workspace.id },
      ),
    ).rejects.toThrow();
  });
});

describe('Motir never shows as a person', () => {
  it('is in no member list of the workspace it writes into', async () => {
    const { workspace, owner, motirId } = await fixture();
    await motirSystemContext(workspace.id);
    const members = await workspacesService.listMembers(workspace.id, owner.id);
    expect(members.map((m) => m.userId)).not.toContain(motirId);
  });
});

describe('resolveSystemPrincipal names the META workspace', () => {
  it('by the meta project key in an isMeta organisation — never a customer project keyed the same', async () => {
    const { metaWs, motirId } = await fixture();
    // A CUSTOMER tenant with a project keyed MOTIR, created first.
    const other = await user('other');
    const { workspace: customerWs } = await workspacesService.createWorkspace({
      name: 'customer',
      ownerUserId: other.id,
    });
    await projectsService.createProject({
      name: 'their motir',
      identifier: 'MOTIR',
      workspaceId: customerWs.id,
      actorUserId: other.id,
    });
    const metaOrgId = (await adminDb.workspace.findUniqueOrThrow({ where: { id: metaWs.id } }))
      .organizationId;
    await adminDb.organization.update({ where: { id: metaOrgId }, data: { isMeta: true } });
    // Drop the membership: the meta resolution no longer depends on it.
    await adminDb.workspaceMembership.deleteMany({ where: { userId: motirId } });

    expect(await resolveSystemPrincipal()).toEqual({ userId: motirId, workspaceId: metaWs.id });
  });

  it('falls back to the account’s own membership where no organisation is flagged', async () => {
    const { metaWs, motirId } = await fixture();
    expect(await resolveSystemPrincipal()).toEqual({ userId: motirId, workspaceId: metaWs.id });
  });

  it('the account’s email is the reserved one', async () => {
    const { motirId } = await fixture();
    const row = await adminDb.user.findUniqueOrThrow({ where: { id: motirId } });
    expect(row.email).toBe(MOTIR_SYSTEM_USER_EMAIL);
    expect(await isMotirSystemUser(motirId)).toBe(true);
  });
});
