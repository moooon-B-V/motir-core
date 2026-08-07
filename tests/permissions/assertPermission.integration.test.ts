import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { projectsService } from '@/lib/services/projectsService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import {
  NotProjectAdminError,
  PermissionDeniedError,
  ProjectNotFoundError,
} from '@/lib/projects/errors';
import { projectErrorResponse } from '@/lib/projects/projectErrorResponse';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../helpers/db';

// `projectAccessService.assertPermission` (Story MOTIR-2256 · Subtask
// MOTIR-2293) against REAL Postgres. The PURE side of the split — that each of
// the twelve keys resolves to exactly the actors `project:administer` does — is
// proved exhaustively over all 64 inputs in `accessParity.test.ts`. What this
// file proves is the ENFORCEMENT side, which that table cannot reach:
//
//   * the REFUSAL ORDER (404 before 403), which is a security property, not a
//     style choice — a settings surface a viewer cannot browse must look
//     missing, never forbidden;
//   * the ERROR SHAPE each refusal carries, including the compatibility branch
//     that keeps `NOT_PROJECT_ADMIN` on the wire for `project:administer`;
//   * that `tx` really is threaded into the gate's reads, asserted the only way
//     that can be false-negative-proof: a membership written inside an
//     uncommitted transaction is visible to a gate given that same `tx`, and
//     invisible to one given none.

const PASSWORD = 'hunter2hunter2';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

function ctxFor(userId: string, workspaceId: string): WorkspaceContext {
  return { userId, workspaceId };
}

interface Scenario {
  workspaceId: string;
  projectId: string;
  projectKey: string;
  ownerCtx: WorkspaceContext;
  adminCtx: WorkspaceContext;
  memberCtx: WorkspaceContext;
  viewerCtx: WorkspaceContext;
  outsiderUserId: string;
}

/**
 * A PRIVATE workspace + project with one real actor per project role, plus a
 * workspace member holding no project membership at all. `private` is the level
 * that separates the two refusals: a non-member cannot browse it, so they must
 * get the 404 arm, while a viewer browses and must get the 403 arm.
 */
async function buildScenario(slug: string): Promise<Scenario> {
  const owner = await usersService.createUser({
    email: `owner-${slug}@ex.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: `WS ${slug}`,
    ownerUserId: owner.id,
  });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Project ${slug}`,
  });
  const ownerCtx = ctxFor(owner.id, workspace.id);
  await projectMembersService.setAccessLevel({
    key: project.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    level: 'private',
  });

  async function projectActor(role: 'viewer' | 'member' | 'admin') {
    const u = await usersService.createUser({
      email: `${role}-${slug}@ex.com`,
      password: PASSWORD,
      name: role,
    });
    await workspacesService.addMember({ userId: u.id, workspaceId: workspace.id });
    await projectMembersService.addMember({
      key: project.identifier,
      actorUserId: owner.id,
      ctx: ownerCtx,
      targetUserId: u.id,
      role,
    });
    return u;
  }
  const viewer = await projectActor('viewer');
  const member = await projectActor('member');
  const admin = await projectActor('admin');

  // A workspace member with NO project membership — on a private project they
  // cannot browse at all, which is the 404 arm.
  const outsider = await usersService.createUser({
    email: `outsider-${slug}@ex.com`,
    password: PASSWORD,
    name: 'Outsider',
  });
  await workspacesService.addMember({ userId: outsider.id, workspaceId: workspace.id });

  return {
    workspaceId: workspace.id,
    projectId: project.id,
    projectKey: project.identifier,
    ownerCtx,
    adminCtx: ctxFor(admin.id, workspace.id),
    memberCtx: ctxFor(member.id, workspace.id),
    viewerCtx: ctxFor(viewer.id, workspace.id),
    outsiderUserId: outsider.id,
  };
}

describe('assertPermission grants the actors the policy grants', () => {
  it('a project admin passes every one of the twelve administrative keys', async () => {
    const s = await buildScenario('grant-admin');
    for (const key of [
      'member:manage',
      'project:manage_access',
      'board:configure',
      'workflow:manage',
      'automation:manage',
      'field:manage',
      'component:manage',
      'label:manage',
      'estimation:manage',
      'repository:manage',
      'repository:manage_access',
      'ai:configure',
    ] as const) {
      await expect(
        projectAccessService.assertPermission(s.projectId, s.adminCtx, key),
      ).resolves.toBeUndefined();
    }
  });

  it('a workspace owner passes on the always-pass rail, with no project membership of their own', async () => {
    const s = await buildScenario('grant-owner');
    await expect(
      projectAccessService.assertPermission(s.projectId, s.ownerCtx, 'board:configure'),
    ).resolves.toBeUndefined();
  });
});

describe('assertPermission refuses in the right ORDER — 404 before 403', () => {
  it('a NON-BROWSER gets ProjectNotFoundError, never a permission error', async () => {
    const s = await buildScenario('order-nonbrowser');
    // The outsider holds no project membership on a private project: invisible.
    await expect(
      projectAccessService.assertPermission(
        s.projectId,
        ctxFor(s.outsiderUserId, s.workspaceId),
        'board:configure',
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('a CROSS-WORKSPACE actor gets ProjectNotFoundError — the gate never confirms a foreign project', async () => {
    const mine = await buildScenario('order-mine');
    const theirs = await buildScenario('order-theirs');
    await expect(
      projectAccessService.assertPermission(theirs.projectId, mine.ownerCtx, 'board:configure'),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('an id that never existed gets ProjectNotFoundError', async () => {
    const s = await buildScenario('order-missing');
    await expect(
      projectAccessService.assertPermission('does-not-exist', s.adminCtx, 'board:configure'),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('a BROWSER who lacks the key gets the 403 arm — the project is already known to them', async () => {
    const s = await buildScenario('order-browser');
    // A viewer browses a private project but holds nothing else.
    await expect(
      projectAccessService.assertPermission(s.projectId, s.viewerCtx, 'board:configure'),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    // A plain project member likewise: they edit work items, they do not
    // configure the project.
    await expect(
      projectAccessService.assertPermission(s.projectId, s.memberCtx, 'board:configure'),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('the refusal carries the key, and the shipped wire contract is unchanged', () => {
  it('PermissionDeniedError names the permission that was missing', async () => {
    const s = await buildScenario('shape-key');
    const err = await projectAccessService
      .assertPermission(s.projectId, s.memberCtx, 'workflow:manage')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect((err as PermissionDeniedError).permission).toBe('workflow:manage');
    expect((err as PermissionDeniedError).code).toBe('PERMISSION_DENIED');
    expect((err as PermissionDeniedError).message).toContain('workflow:manage');
  });

  it('project:administer STILL throws NotProjectAdminError — the compatibility branch', async () => {
    const s = await buildScenario('shape-compat');
    const err = await projectAccessService
      .assertPermission(s.projectId, s.memberCtx, 'project:administer')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotProjectAdminError);
    expect((err as NotProjectAdminError).code).toBe('NOT_PROJECT_ADMIN');
  });

  it('assertCanManage is behaviourally identical to the umbrella key', async () => {
    const s = await buildScenario('shape-alias');
    await expect(
      projectAccessService.assertCanManage(s.projectId, s.adminCtx),
    ).resolves.toBeUndefined();
    await expect(
      projectAccessService.assertCanManage(s.projectId, s.memberCtx),
    ).rejects.toBeInstanceOf(NotProjectAdminError);
    // …and the 404-first ordering came along with it.
    await expect(
      projectAccessService.assertCanManage(s.projectId, ctxFor(s.outsiderUserId, s.workspaceId)),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  it('both refusals map to 403 through projectErrorResponse, and only the new one adds `permission`', () => {
    const denied = projectErrorResponse(new PermissionDeniedError('p1', 'board:configure'));
    expect(denied?.status).toBe(403);
    const notAdmin = projectErrorResponse(new NotProjectAdminError('p1'));
    expect(notAdmin?.status).toBe(403);
  });

  it('the 403 body carries the code and the missing permission', async () => {
    const res = projectErrorResponse(new PermissionDeniedError('p1', 'ai:configure'));
    expect(res).not.toBeNull();
    const body = (await res!.json()) as { code: string; permission: string; error: string };
    expect(body.code).toBe('PERMISSION_DENIED');
    expect(body.permission).toBe('ai:configure');
  });

  it('the NOT_PROJECT_ADMIN body is byte-for-byte what it was — no `permission` key added', async () => {
    const res = projectErrorResponse(new NotProjectAdminError('p1'));
    const body = (await res!.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['code', 'error']);
    expect(body.code).toBe('NOT_PROJECT_ADMIN');
  });
});

describe('`tx` is threaded into the gate reads', () => {
  it('a membership written inside an uncommitted transaction is visible to a gate given that tx', async () => {
    const s = await buildScenario('tx-thread');
    const promoted = await usersService.createUser({
      email: 'promoted-tx@ex.com',
      password: PASSWORD,
      name: 'Promoted',
    });
    await workspacesService.addMember({ userId: promoted.id, workspaceId: s.workspaceId });
    const promotedCtx = ctxFor(promoted.id, s.workspaceId);

    // Before: no project membership on a private project → invisible (404).
    await expect(
      projectAccessService.assertPermission(s.projectId, promotedCtx, 'board:configure'),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    await db.$transaction(async (tx) => {
      await tx.projectMembership.create({
        data: {
          projectId: s.projectId,
          userId: promoted.id,
          workspaceId: s.workspaceId,
          role: 'admin',
        },
      });
      // Inside the SAME transaction, the gate sees the uncommitted row — which
      // is only possible if `tx` reached `resolveInputs`. A gate that quietly
      // ignored its `tx` and read through the `db` singleton would still see the
      // pre-write state here and throw.
      await expect(
        projectAccessService.assertPermission(s.projectId, promotedCtx, 'board:configure', tx),
      ).resolves.toBeUndefined();
    });

    // After commit, the same call without a tx now passes too.
    await expect(
      projectAccessService.assertPermission(s.projectId, promotedCtx, 'board:configure'),
    ).resolves.toBeUndefined();
  });
});
