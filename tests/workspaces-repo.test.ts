import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { createUser } from '@/lib/users/repo';
import {
  addMember,
  createWorkspace,
  findMembership,
  findUserWorkspaces,
  removeMember,
} from '@/lib/workspaces/repo';
import { AlreadyMemberError } from '@/lib/workspaces/errors';
import { truncateAuthTables } from './helpers/db';

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeUser(email: string, name = 'Owner') {
  return createUser({ email, password: 'hunter2hunter2', name });
}

describe('createWorkspace', () => {
  it('creates the workspace and the owner membership in a transaction', async () => {
    const owner = await makeUser('owner@example.com');
    const { workspace, membership } = await createWorkspace({
      name: "Alice's Workspace",
      ownerUserId: owner.id,
    });

    expect(workspace.name).toBe("Alice's Workspace");
    expect(workspace.slug).toBe('alice-s-workspace');
    expect(workspace.subtaskPrMergeMode).toBe('manual');
    expect(membership.userId).toBe(owner.id);
    expect(membership.workspaceId).toBe(workspace.id);
    expect(membership.role).toBe('member');

    const persistedMembership = await db.workspaceMembership.findUnique({
      where: { id: membership.id },
    });
    expect(persistedMembership).not.toBeNull();
  });

  it('appends a random suffix when the base slug collides', async () => {
    const a = await makeUser('a@example.com');
    const b = await makeUser('b@example.com');

    const first = await createWorkspace({ name: 'Acme', ownerUserId: a.id });
    expect(first.workspace.slug).toBe('acme');

    const second = await createWorkspace({ name: 'Acme', ownerUserId: b.id });
    expect(second.workspace.slug).not.toBe('acme');
    expect(second.workspace.slug).toMatch(/^acme-[a-z0-9]{4}$/);
    expect(second.workspace.id).not.toBe(first.workspace.id);
  });

  it('normalizes a name with non-alphanumeric runs into a clean slug', async () => {
    const owner = await makeUser('owner@example.com');
    const { workspace } = await createWorkspace({
      name: '   Hello, World!! ',
      ownerUserId: owner.id,
    });
    expect(workspace.slug).toBe('hello-world');
  });

  it('falls back to "workspace" when the name produces an empty slug', async () => {
    const owner = await makeUser('owner@example.com');
    const { workspace } = await createWorkspace({
      name: '!!!',
      ownerUserId: owner.id,
    });
    expect(workspace.slug).toBe('workspace');
  });
});

describe('addMember', () => {
  it('adds a second user to an existing workspace', async () => {
    const owner = await makeUser('owner@example.com');
    const invitee = await makeUser('invitee@example.com', 'Invitee');
    const { workspace } = await createWorkspace({
      name: 'Team',
      ownerUserId: owner.id,
    });

    const membership = await addMember({
      userId: invitee.id,
      workspaceId: workspace.id,
    });
    expect(membership.userId).toBe(invitee.id);
    expect(membership.role).toBe('member');

    const count = await db.workspaceMembership.count({
      where: { workspaceId: workspace.id },
    });
    expect(count).toBe(2);
  });

  it('throws AlreadyMemberError when the (userId, workspaceId) pair already exists', async () => {
    const owner = await makeUser('owner@example.com');
    const { workspace } = await createWorkspace({
      name: 'Team',
      ownerUserId: owner.id,
    });

    await expect(addMember({ userId: owner.id, workspaceId: workspace.id })).rejects.toBeInstanceOf(
      AlreadyMemberError,
    );
  });
});

describe('removeMember', () => {
  it('deletes the membership row and returns it', async () => {
    const owner = await makeUser('owner@example.com');
    const invitee = await makeUser('invitee@example.com');
    const { workspace } = await createWorkspace({
      name: 'Team',
      ownerUserId: owner.id,
    });
    await addMember({ userId: invitee.id, workspaceId: workspace.id });

    const removed = await removeMember({
      userId: invitee.id,
      workspaceId: workspace.id,
    });
    expect(removed?.userId).toBe(invitee.id);

    expect(await findMembership(invitee.id, workspace.id)).toBeNull();
  });

  it('returns null when the membership does not exist (idempotent leave)', async () => {
    const stranger = await makeUser('stranger@example.com');
    const owner = await makeUser('owner@example.com');
    const { workspace } = await createWorkspace({
      name: 'Team',
      ownerUserId: owner.id,
    });

    const result = await removeMember({
      userId: stranger.id,
      workspaceId: workspace.id,
    });
    expect(result).toBeNull();
  });
});

describe('findUserWorkspaces', () => {
  it('returns workspaces in membership.createdAt asc order', async () => {
    const user = await makeUser('user@example.com');
    const first = await createWorkspace({ name: 'First', ownerUserId: user.id });
    const second = await createWorkspace({ name: 'Second', ownerUserId: user.id });

    const found = await findUserWorkspaces(user.id);
    expect(found.map((w) => w.id)).toEqual([first.workspace.id, second.workspace.id]);
  });

  it('returns an empty array for a user with no memberships', async () => {
    const loner = await makeUser('loner@example.com');
    expect(await findUserWorkspaces(loner.id)).toEqual([]);
  });
});

describe('cascade behavior', () => {
  it('removes membership rows when the parent Workspace is deleted', async () => {
    const owner = await makeUser('owner@example.com');
    const { workspace, membership } = await createWorkspace({
      name: 'To Delete',
      ownerUserId: owner.id,
    });

    await db.workspace.delete({ where: { id: workspace.id } });

    expect(await db.workspaceMembership.findUnique({ where: { id: membership.id } })).toBeNull();
  });

  it('removes membership rows when the parent User is deleted', async () => {
    const owner = await makeUser('owner@example.com');
    const { membership } = await createWorkspace({
      name: 'Owner Workspace',
      ownerUserId: owner.id,
    });

    await db.user.delete({ where: { id: owner.id } });

    expect(await db.workspaceMembership.findUnique({ where: { id: membership.id } })).toBeNull();
  });
});
