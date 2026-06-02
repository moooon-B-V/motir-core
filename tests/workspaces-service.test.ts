import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { AlreadyMemberError, LastMemberError } from '@/lib/workspaces/errors';
import { truncateAuthTables } from './helpers/db';

// Service-layer tests for the Workspace + WorkspaceMembership
// entities. Mirrors the layer split in CLAUDE.md.
const { createUser } = usersService;
const {
  addMember,
  createWorkspace,
  deleteWorkspace,
  findMembership,
  listMembers,
  listUserWorkspaces,
  removeMember,
  renameWorkspace,
} = workspacesService;
// Old name preserved so the test bodies don't need to change.
const findUserWorkspaces = listUserWorkspaces;

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
    // The workspace creator is its owner (Subtask 1.6.5 — replay gate tier).
    expect(membership.role).toBe('owner');

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
  it('deletes a non-last membership row and returns it', async () => {
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
    // Owner's membership is untouched.
    expect(await findMembership(owner.id, workspace.id)).not.toBeNull();
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

  it('throws LastMemberError when removing the only remaining member', async () => {
    const owner = await makeUser('owner@example.com');
    const { workspace } = await createWorkspace({
      name: 'Solo',
      ownerUserId: owner.id,
    });

    await expect(
      removeMember({ userId: owner.id, workspaceId: workspace.id }),
    ).rejects.toBeInstanceOf(LastMemberError);

    // The membership is preserved — the guard fires before the delete.
    expect(await findMembership(owner.id, workspace.id)).not.toBeNull();
  });

  it('lets the second-to-last member leave, then blocks the last one', async () => {
    const owner = await makeUser('owner@example.com');
    const invitee = await makeUser('invitee@example.com');
    const { workspace } = await createWorkspace({ name: 'Team', ownerUserId: owner.id });
    await addMember({ userId: invitee.id, workspaceId: workspace.id });

    // invitee leaves — fine, owner remains.
    await removeMember({ userId: invitee.id, workspaceId: workspace.id });
    // owner is now last — blocked.
    await expect(
      removeMember({ userId: owner.id, workspaceId: workspace.id }),
    ).rejects.toBeInstanceOf(LastMemberError);
  });
});

describe('renameWorkspace', () => {
  it('persists a new name and leaves the slug stable', async () => {
    const owner = await makeUser('owner@example.com');
    const { workspace } = await createWorkspace({ name: 'Old Name', ownerUserId: owner.id });

    const result = await renameWorkspace({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: '  New Name  ',
    });
    expect(result.name).toBe('New Name');
    expect(result.slug).toBe(workspace.slug);

    const persisted = await db.workspace.findUnique({ where: { id: workspace.id } });
    expect(persisted?.name).toBe('New Name');
  });

  it('rejects a rename from a non-member', async () => {
    const owner = await makeUser('owner@example.com');
    const stranger = await makeUser('stranger@example.com');
    const { workspace } = await createWorkspace({ name: 'Private', ownerUserId: owner.id });

    await expect(
      renameWorkspace({ workspaceId: workspace.id, actorUserId: stranger.id, name: 'Hacked' }),
    ).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
  });
});

describe('listMembers', () => {
  it('returns member DTOs ordered by membership creation, owner first', async () => {
    const owner = await makeUser('owner@example.com', 'Owner Person');
    const invitee = await makeUser('invitee@example.com', 'Invitee Person');
    const { workspace } = await createWorkspace({ name: 'Team', ownerUserId: owner.id });
    await addMember({ userId: invitee.id, workspaceId: workspace.id });

    const members = await listMembers(workspace.id, owner.id);
    expect(members).toEqual([
      { userId: owner.id, name: 'Owner Person', email: 'owner@example.com', role: 'owner' },
      { userId: invitee.id, name: 'Invitee Person', email: 'invitee@example.com', role: 'member' },
    ]);
  });
});

describe('deleteWorkspace', () => {
  it('deletes the workspace and cascades to memberships', async () => {
    const owner = await makeUser('owner@example.com');
    const invitee = await makeUser('invitee@example.com');
    const { workspace } = await createWorkspace({ name: 'Doomed', ownerUserId: owner.id });
    await addMember({ userId: invitee.id, workspaceId: workspace.id });

    await deleteWorkspace({ workspaceId: workspace.id, actorUserId: owner.id });

    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).toBeNull();
    expect(await db.workspaceMembership.count({ where: { workspaceId: workspace.id } })).toBe(0);
  });

  it('rejects a delete from a non-member', async () => {
    const owner = await makeUser('owner@example.com');
    const stranger = await makeUser('stranger@example.com');
    const { workspace } = await createWorkspace({ name: 'Private', ownerUserId: owner.id });

    await expect(
      deleteWorkspace({ workspaceId: workspace.id, actorUserId: stranger.id }),
    ).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
    expect(await db.workspace.findUnique({ where: { id: workspace.id } })).not.toBeNull();
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
