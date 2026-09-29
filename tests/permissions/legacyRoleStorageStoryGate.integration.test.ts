import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceRole } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { organizationsService } from '@/lib/services/organizationsService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import {
  INVITE_IDENTIFIER_PREFIX,
  workspaceInvitesService,
} from '@/lib/services/workspaceInvitesService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { WorkspaceContext } from '@/lib/workspaces/context';
import { InviteExpiredOrMissingError } from '@/lib/workspaces/errors';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { captureEmailEvents } from '../helpers/jobs';

// THE STORY GATE for MOTIR-6469 (Subtask MOTIR-6563) — the legacy role storage
// stops being read or written. The two code cards each tested their own units;
// this file drives the ASSEMBLED change: every path that creates a membership,
// through the real services, against the real database. `@/lib/db` connects as
// `motir_app`, so RLS is live on every call below (the harness asserts that in
// `tests/app-role-harness.test.ts`); only fixtures and reads-for-assertion use
// the owner client.
//
// For each path, two things hold:
//   * the row it wrote carries the expected `workspace_role` — the path named
//     no legacy role, and nothing reads the one the database defaulted;
//   * resolving that person's permissions in a project gives exactly the keys
//     of a CONTROL person put on the same workspace role directly, so the row
//     is not merely labelled right but acts right.
//
// The codebase half — nothing reads or writes the retired columns — is guard 2
// of `workspaceRoleArchitecture.test.ts`.

const PASSWORD = 'hunter2hunter2';
let seq = 0;
let emailEvents: ReturnType<typeof captureEmailEvents>;

beforeEach(async () => {
  await truncateAuthTables();
  emailEvents = captureEmailEvents();
});

afterEach(() => {
  emailEvents.restore();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function person(tag: string) {
  const n = seq++;
  return usersService.createUser({
    email: `lrs-${tag}-${n}@example.com`,
    password: PASSWORD,
    name: `LRS ${tag}`,
  });
}

interface Tenant {
  ownerId: string;
  workspaceId: string;
  organizationId: string;
  ownerCtx: WorkspaceContext;
  /** An `open` project: every workspace member reaches it by their role. */
  openProjectId: string;
  /** A `private` project: only people added to it reach it. */
  privateProject: { id: string; key: string };
}

async function tenant(): Promise<Tenant> {
  const owner = await person('owner');
  const { workspace } = await workspacesService.createWorkspace({
    name: `LRS ${seq}`,
    ownerUserId: owner.id,
  });
  const ownerCtx: WorkspaceContext = { userId: owner.id, workspaceId: workspace.id };
  const open = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Open ${seq}`,
  });
  const priv = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: `Private ${seq}`,
  });
  await projectMembersService.setAccessLevel({
    key: priv.identifier,
    actorUserId: owner.id,
    ctx: ownerCtx,
    level: 'private',
  });
  const { organizationId } = await adminDb.workspace.findUniqueOrThrow({
    where: { id: workspace.id },
  });
  return {
    ownerId: owner.id,
    workspaceId: workspace.id,
    organizationId: organizationId!,
    ownerCtx,
    openProjectId: open.id,
    privateProject: { id: priv.id, key: priv.identifier },
  };
}

/** A control person, put on `role` by the owner client — no service path involved. */
async function control(t: Tenant, role: WorkspaceRole, opts: { inPrivate?: boolean } = {}) {
  const u = await person(`control-${role}`);
  await adminDb.organizationMembership.create({
    data: { organizationId: t.organizationId, userId: u.id, role: 'member' },
  });
  await adminDb.workspaceMembership.create({
    data: { userId: u.id, workspaceId: t.workspaceId, workspaceRole: role },
  });
  if (opts.inPrivate) {
    await adminDb.projectMembership.create({
      data: { workspaceId: t.workspaceId, projectId: t.privateProject.id, userId: u.id },
    });
  }
  return u.id;
}

async function keys(t: Tenant, projectId: string, userId: string): Promise<string[]> {
  const held = await projectAccessService.getPermissions(projectId, {
    userId,
    workspaceId: t.workspaceId,
  });
  return [...held].sort();
}

async function workspaceRoleOf(t: Tenant, userId: string): Promise<WorkspaceRole | undefined> {
  const m = await adminDb.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId: t.workspaceId } },
  });
  return m?.workspaceRole;
}

/** The path's person holds `role` and acts exactly like a control on `role`. */
async function expectActsAs(t: Tenant, userId: string, role: WorkspaceRole) {
  expect(await workspaceRoleOf(t, userId)).toBe(role);
  const controlId = await control(t, role);
  const held = await keys(t, t.openProjectId, userId);
  expect(held).toEqual(await keys(t, t.openProjectId, controlId));
  expect(held.length).toBeGreaterThan(0);
}

describe('the roles are distinguishable, so matching a control proves something', () => {
  it('Manager, Member and Viewer each resolve a different key set on an open project', async () => {
    const t = await tenant();
    const sets = await Promise.all(
      (['manager', 'member', 'viewer'] as const).map(async (r) =>
        JSON.stringify(await keys(t, t.openProjectId, await control(t, r))),
      ),
    );
    expect(new Set(sets).size).toBe(3);
  });
});

describe('every membership-creating path writes the workspace role, and it acts as that role', () => {
  it('workspace creation → the creator is the Manager', async () => {
    const t = await tenant();
    await expectActsAs(t, t.ownerId, 'manager');
  });

  it('workspacesService.addMember → Member by default, or the role asked for', async () => {
    const t = await tenant();
    const plain = await person('add-plain');
    const viewer = await person('add-viewer');
    await workspacesService.addMember({ userId: plain.id, workspaceId: t.workspaceId });
    await workspacesService.addMember({
      userId: viewer.id,
      workspaceId: t.workspaceId,
      workspaceRole: 'viewer',
    });
    await expectActsAs(t, plain.id, 'member');
    await expectActsAs(t, viewer.id, 'viewer');
  });

  it('an org member added to a single-workspace org lands in it as a Member', async () => {
    const t = await tenant();
    const joiner = await person('org-add');
    await organizationsService.addMember({
      organizationId: t.organizationId,
      userId: joiner.id,
      role: 'member',
      actorUserId: t.ownerId,
    });
    await expectActsAs(t, joiner.id, 'member');
  });

  it('an invite minted by this build, accepted, lands as a Member', async () => {
    const t = await tenant();
    const invitee = await person('invitee');
    await workspaceInvitesService.sendInvite({
      inviterUserId: t.ownerId,
      inviterName: 'Owner',
      workspaceId: t.workspaceId,
      targetEmail: invitee.email,
    });
    const row = await adminDb.verification.findFirstOrThrow({
      where: { identifier: { startsWith: INVITE_IDENTIFIER_PREFIX } },
    });
    // The token names its workspace role, and no legacy `role` (MOTIR-6569).
    const payload = JSON.parse(row.value);
    expect(payload).toMatchObject({ workspaceRole: 'member' });
    expect(payload).not.toHaveProperty('role');
    await workspaceInvitesService.acceptInvite(
      row.identifier.slice(INVITE_IDENTIFIER_PREFIX.length),
      {
        id: invitee.id,
        email: invitee.email,
      },
    );
    await expectActsAs(t, invitee.id, 'member');
  });

  it('a project add creates the row, and the person’s keys there are their workspace role’s', async () => {
    const t = await tenant();
    const added = await person('project-add');
    const notAdded = await person('project-not-added');
    for (const u of [added, notAdded]) {
      await workspacesService.addMember({ userId: u.id, workspaceId: t.workspaceId });
    }
    await projectMembersService.addMember({
      key: t.privateProject.key,
      actorUserId: t.ownerId,
      ctx: t.ownerCtx,
      targetUserId: added.id,
    });

    const row = await adminDb.projectMembership.findUnique({
      where: { userId_projectId: { userId: added.id, projectId: t.privateProject.id } },
    });
    expect(row).not.toBeNull();
    const controlId = await control(t, 'member', { inPrivate: true });
    const held = await keys(t, t.privateProject.id, added.id);
    expect(held).toEqual(await keys(t, t.privateProject.id, controlId));
    expect(held).toContain('project:browse');
    // …and the add is what did it: a Member who was not added reaches nothing.
    expect(await keys(t, t.privateProject.id, notAdded.id)).toEqual([]);
  });
});

describe('the bulk edit answer reads the workspace role alone', () => {
  it('resolveCanEditForUsers: Manager and an added Member edit; an un-added Member, an added Viewer and a stranger do not', async () => {
    const t = await tenant();
    const added = await person('bulk-added');
    const notAdded = await person('bulk-not-added');
    const viewer = await person('bulk-viewer');
    const stranger = await person('bulk-stranger');
    await workspacesService.addMember({ userId: added.id, workspaceId: t.workspaceId });
    await workspacesService.addMember({ userId: notAdded.id, workspaceId: t.workspaceId });
    await workspacesService.addMember({
      userId: viewer.id,
      workspaceId: t.workspaceId,
      workspaceRole: 'viewer',
    });
    for (const u of [added, viewer]) {
      await projectMembersService.addMember({
        key: t.privateProject.key,
        actorUserId: t.ownerId,
        ctx: t.ownerCtx,
        targetUserId: u.id,
      });
    }

    const answer = await projectAccessService.resolveCanEditForUsers(
      t.privateProject.id,
      [t.ownerId, added.id, notAdded.id, viewer.id, stranger.id],
      t.ownerCtx,
    );
    expect(Object.fromEntries(answer)).toEqual({
      [t.ownerId]: true,
      [added.id]: true,
      [notAdded.id]: false,
      [viewer.id]: false,
      [stranger.id]: false,
    });
  });
});

describe('a pre-release invite no longer redeems (MOTIR-6569)', () => {
  // Every token minted before MOTIR-6562 lapsed after `INVITE_EXPIRY_MS` (7 days),
  // so MOTIR-6569 retired the fallback that mapped its legacy `role`.
  it('a token carrying only the legacy `role` key, as the pre-MOTIR-6562 build wrote it, is refused', async () => {
    const t = await tenant();
    const invitee = await person('pre-release');
    const token = `pre-release-${seq}`;
    // Exactly the payload the pre-MOTIR-6562 build minted: no `workspaceRole`.
    await adminDb.verification.create({
      data: {
        identifier: INVITE_IDENTIFIER_PREFIX + token,
        value: JSON.stringify({
          workspaceId: t.workspaceId,
          email: invitee.email,
          role: 'member',
          inviterUserId: t.ownerId,
        }),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });
    await expect(
      workspaceInvitesService.acceptInvite(token, { id: invitee.id, email: invitee.email }),
    ).rejects.toBeInstanceOf(InviteExpiredOrMissingError);
    expect(
      await adminDb.workspaceMembership.findUnique({
        where: { userId_workspaceId: { userId: invitee.id, workspaceId: t.workspaceId } },
      }),
    ).toBeNull();
  });
});
