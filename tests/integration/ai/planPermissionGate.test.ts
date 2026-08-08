import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { PermissionDeniedError } from '@/lib/projects/errors';
import { createTestProject } from '../../fixtures/projectFixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { ProjectContext } from '@/lib/projects';

// The `ai:plan` GATE (Story MOTIR-2291 · Subtask MOTIR-2355) — the two
// conversational planners.
//
// TWO actors are refused, and only one of them follows from the other. A project
// `viewer` losing the planner is the obvious case. The one this card is really
// about is the WORKSPACE MEMBER WITH NO PROJECT MEMBERSHIP on an `open` project:
// they hold `work_item:edit` through
// `IMPLICIT_WORKSPACE_MEMBER_PERMISSIONS`, which is what these paths used to ask
// for — so until now they could open a plan-change thread on somebody else's
// project and spend the workspace's AI credits on it. `ai:plan` is deliberately
// NOT in that implicit set (`docs/decisions/member-facing-permissions.md` §2).

const PASSWORD = 'hunter2hunter2';

interface Fixture {
  ownerPctx: ProjectContext;
  memberPctx: ProjectContext;
  viewerPctx: ProjectContext;
  outsiderPctx: ProjectContext;
}

let seq = 0;

async function makeFixture(label: string): Promise<Fixture> {
  seq += 1;
  const owner = await usersService.createUser({
    email: `plan-owner-${label}-${seq}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const ws = await workspacesService.createWorkspace({
    name: `Plan WS ${label} ${seq}`,
    ownerUserId: owner.id,
  });
  const workspaceId = ws.workspace.id;
  const project = await createTestProject({ workspaceId, actorUserId: owner.id });
  const ownerCtx = { userId: owner.id, workspaceId };

  const pctx = (userId: string): ProjectContext =>
    ({ userId, workspaceId, projectId: project.id, project }) as ProjectContext;

  async function actor(slug: string, role: 'member' | 'viewer' | null): Promise<ProjectContext> {
    const u = await usersService.createUser({
      email: `plan-${slug}-${label}-${seq}@example.com`,
      password: PASSWORD,
      name: slug,
    });
    await db.workspaceMembership.create({ data: { userId: u.id, workspaceId, role: 'member' } });
    if (role) {
      await projectMembersService.addMember({
        key: project.identifier,
        actorUserId: owner.id,
        ctx: ownerCtx,
        targetUserId: u.id,
        role,
      });
    }
    return pctx(u.id);
  }

  return {
    ownerPctx: pctx(owner.id),
    memberPctx: await actor('member', 'member'),
    viewerPctx: await actor('viewer', 'viewer'),
    outsiderPctx: await actor('outsider', null),
  };
}

beforeEach(async () => {
  await truncateAuthTables();
});
afterAll(async () => {
  await db.$disconnect();
});

describe('the plan-change session asks ai:plan', () => {
  it('refuses a project VIEWER opening a thread, appending to it and submitting it', async () => {
    const fx = await makeFixture('viewer');
    await expect(
      planChangeSessionsService.getOrCreateForProject(fx.viewerPctx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      planChangeSessionsService.appendTurn('do a thing', fx.viewerPctx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(planChangeSessionsService.submit(fx.viewerPctx)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
  });

  it('refuses a workspace member with NO project membership — the case that does not follow from the viewer one', async () => {
    const fx = await makeFixture('implicit');
    // They DO hold `work_item:edit` here, which is what these paths asked for
    // until this card — so the refusal is specifically about the new key.
    const held = await projectAccessService.getPermissions(fx.outsiderPctx.projectId, {
      userId: fx.outsiderPctx.userId,
      workspaceId: fx.outsiderPctx.workspaceId,
    });
    expect(held.has('work_item:edit')).toBe(true);
    expect(held.has('ai:plan')).toBe(false);

    await expect(
      planChangeSessionsService.getOrCreateForProject(fx.outsiderPctx),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('still admits a project MEMBER — the planner is member-facing, not administrative', async () => {
    const fx = await makeFixture('member');
    const session = await planChangeSessionsService.getOrCreateForProject(fx.memberPctx);
    expect(session.id).toBeTruthy();
    await expect(
      planChangeSessionsService.appendTurn('split the auth story', fx.memberPctx),
    ).resolves.toBeTruthy();
  });
});
