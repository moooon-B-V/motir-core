import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { AlreadyMemberError, LastMemberError } from '@/lib/workspaces/errors';
import { adminDb } from './helpers/adminDb';
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
  await adminDb.$disconnect();
});

async function makeUser(email: string, name = 'Owner') {
  return createUser({ email, password: 'hunter2hunter2', name });
}

// Force the pool to open ≥ n physical connections so two racing transactions
// each get their own and run truly concurrently — the FOR-UPDATE lock (not a
// single shared connection) is then what serializes them. A cold pool would
// serialize the writes and mask the last-member race.
async function warmPool(n = 6): Promise<void> {
  await Promise.all(Array.from({ length: n }, () => db.$queryRaw`SELECT 1`));
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

    const persistedMembership = await adminDb.workspaceMembership.findUnique({
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

    const count = await adminDb.workspaceMembership.count({
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

  it('two concurrent leaves of a 2-member workspace leave exactly ONE member — never zero (warm pool)', async () => {
    // Regression for the last-member analogue of bug-org-last-owner-race: a plain
    // COUNT let both leaves observe count = 2 and both delete, orphaning the
    // workspace. The guard now locks the membership rows FOR UPDATE, so the racers
    // serialize and exactly one leave is refused with LastMemberError.
    const owner = await makeUser('owner@example.com');
    const invitee = await makeUser('invitee@example.com');
    const { workspace } = await createWorkspace({ name: 'Team', ownerUserId: owner.id });
    await addMember({ userId: invitee.id, workspaceId: workspace.id });

    await warmPool();
    const results = await Promise.allSettled([
      removeMember({ userId: owner.id, workspaceId: workspace.id }),
      removeMember({ userId: invitee.id, workspaceId: workspace.id }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(LastMemberError);
    const workspaceMembershipCount = await adminDb.workspaceMembership.count({
      where: { workspaceId: workspace.id },
    });
    expect(workspaceMembershipCount).toBe(1);
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

    const persisted = await adminDb.workspace.findUnique({ where: { id: workspace.id } });
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

    const workspaceRow = await adminDb.workspace.findUnique({ where: { id: workspace.id } });
    expect(workspaceRow).toBeNull();
    const workspaceMembershipCount = await adminDb.workspaceMembership.count({
      where: { workspaceId: workspace.id },
    });
    expect(workspaceMembershipCount).toBe(0);
  });

  it('rejects a delete from a non-member', async () => {
    const owner = await makeUser('owner@example.com');
    const stranger = await makeUser('stranger@example.com');
    const { workspace } = await createWorkspace({ name: 'Private', ownerUserId: owner.id });

    await expect(
      deleteWorkspace({ workspaceId: workspace.id, actorUserId: stranger.id }),
    ).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
    const workspaceRow = await adminDb.workspace.findUnique({ where: { id: workspace.id } });
    expect(workspaceRow).not.toBeNull();
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

// MOTIR-2874 — `getActiveWorkspace` had NO test at all, which is how it shipped
// on a bare `db.$transaction` that binds no GUCs. Under `motir_app` that made
// `membership_visible_active_or_own` (`"workspaceId" = app.workspace_id` OR
// `"userId" = app.user_id`) match nothing, so both membership reads came back
// empty, the method resolved to `null`, and `GET /api/workspaces/current`
// returned a 404 for every signed-in user.
//
// Every assertion below is an ADMIT assertion — a NON-EMPTY result under the
// restricted role. A denial test would pass just as happily against a policy set
// that refuses everyone, which is the failure mode this class hides behind: RLS
// removes rows from a SELECT, it does not raise, so "nothing came back" and
// "nothing exists" are indistinguishable to the caller.
describe('getActiveWorkspace (bound read — MOTIR-2874)', () => {
  it('resolves the first membership, workspace row included, with no workspace pinned', async () => {
    const user = await makeUser('active-first@example.com', 'Active');
    const { workspace } = await createWorkspace({ name: 'Only', ownerUserId: user.id });

    const dto = await workspacesService.getActiveWorkspace(user.id, null);

    // Non-empty: the membership read was admitted by the `_or_own` arm...
    expect(dto).not.toBeNull();
    expect(dto!.membership.userId).toBe(user.id);
    expect(dto!.membership.workspaceId).toBe(workspace.id);
    expect(dto!.membership.role).toBe('owner');
    // ...and so was the `include: { workspace: true }` join, which
    // `workspace_membership_visible` gates on the same `app.user_id`. A DTO
    // whose workspace half came back empty is the other half of this bug.
    expect(dto!.workspace.id).toBe(workspace.id);
    expect(dto!.workspace.name).toBe('Only');
    expect(dto!.workspace.slug).toBe(workspace.slug);
  });

  it('resolves the COOKIE-PINNED workspace when the user is a member of it', async () => {
    const user = await makeUser('active-pinned@example.com', 'Pinned');
    await createWorkspace({ name: 'First', ownerUserId: user.id });
    const { workspace: second } = await createWorkspace({ name: 'Second', ownerUserId: user.id });

    const dto = await workspacesService.getActiveWorkspace(user.id, second.id);

    expect(dto).not.toBeNull();
    expect(dto!.workspace.id).toBe(second.id);
    expect(dto!.workspace.name).toBe('Second');
  });

  it('falls back to the first membership when the pin names a workspace the user is NOT in', async () => {
    const user = await makeUser('active-stale-pin@example.com', 'Stale');
    const stranger = await makeUser('active-stranger@example.com', 'Stranger');
    const { workspace: mine } = await createWorkspace({ name: 'Mine', ownerUserId: user.id });
    const { workspace: theirs } = await createWorkspace({
      name: 'Theirs',
      ownerUserId: stranger.id,
    });

    const dto = await workspacesService.getActiveWorkspace(user.id, theirs.id);

    // The fallback is the point: a stale pin must not strand the user at null,
    // and it must not leak the workspace they have no membership in.
    expect(dto).not.toBeNull();
    expect(dto!.workspace.id).toBe(mine.id);
  });

  it('returns null for a user with genuinely zero memberships', async () => {
    // The one legitimate null. Kept last so the three admits above are what
    // carries the file — this case passes whether or not anything is bound.
    const loner = await makeUser('active-loner@example.com', 'Loner');
    expect(await workspacesService.getActiveWorkspace(loner.id, null)).toBeNull();
  });
});

describe('cascade behavior', () => {
  it('removes membership rows when the parent Workspace is deleted', async () => {
    const owner = await makeUser('owner@example.com');
    const { workspace, membership } = await createWorkspace({
      name: 'To Delete',
      ownerUserId: owner.id,
    });

    await adminDb.workspace.delete({ where: { id: workspace.id } });

    const workspaceMembershipRow = await adminDb.workspaceMembership.findUnique({
      where: { id: membership.id },
    });
    expect(workspaceMembershipRow).toBeNull();
  });

  it('removes membership rows when the parent User is deleted', async () => {
    const owner = await makeUser('owner@example.com');
    const { membership } = await createWorkspace({
      name: 'Owner Workspace',
      ownerUserId: owner.id,
    });

    await adminDb.user.delete({ where: { id: owner.id } });

    const workspaceMembershipRow = await adminDb.workspaceMembership.findUnique({
      where: { id: membership.id },
    });
    expect(workspaceMembershipRow).toBeNull();
  });
});
