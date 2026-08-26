import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { organizationsService } from '@/lib/services/organizationsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { organizationMembershipRepository } from '@/lib/repositories/organizationMembershipRepository';
import {
  AlreadyOrgMemberError,
  LastOrgOwnerError,
  OrganizationNotFoundError,
  OrgForbiddenError,
} from '@/lib/organizations/errors';
import { createTestUser } from './fixtures/userFixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// Service-layer tests for Story 6.10.4 — the org tier's access gate +
// membership management. Real Postgres, no mocks (the project rule); the
// exhaustive matrix (incl. the RLS-policy assertions + the migration backfill)
// is Subtask 6.10.7. This suite locks the gate composition, the asymmetric
// membership direction, the last-owner guard, and the paginated roster — the
// load-bearing behaviour this subtask introduces.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// Resolve a workspace's organizationId without going through the gate.
async function orgIdOfWorkspace(workspaceId: string): Promise<string> {
  const ws = await adminDb.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  return ws.organizationId;
}

describe('resolveWorkspaceAccess (the org access gate)', () => {
  it('grants the workspace owner (org owner) full access', async () => {
    const owner = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });

    const access = await organizationsService.resolveWorkspaceAccess(owner.id, workspace.id);
    expect(access).not.toBeNull();
    expect(access!.effectiveRole).toBe('owner');
    expect(access!.orgRole).toBe('owner');
    expect(access!.isOrgAdmin).toBe(true);
  });

  it('grants an org owner/admin admin-equivalent access to EVERY workspace under the org, with no workspace membership', async () => {
    const owner = await createTestUser();
    const admin = await createTestUser();
    const { workspace: w1 } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(w1.id);
    // A second workspace under the SAME org.
    const { workspace: w2 } = await workspacesService.createWorkspace({
      name: 'Beta',
      ownerUserId: owner.id,
      organizationId: orgId,
    });
    // admin is an ORG admin only — no workspace membership anywhere.
    await organizationsService.addMember({
      organizationId: orgId,
      userId: admin.id,
      role: 'admin',
      actorUserId: owner.id,
    });

    for (const ws of [w1, w2]) {
      const access = await organizationsService.resolveWorkspaceAccess(admin.id, ws.id);
      expect(access, `admin should reach ${ws.name}`).not.toBeNull();
      expect(access!.effectiveRole).toBe('owner'); // admin-equivalent
      expect(access!.isOrgAdmin).toBe(true);
      expect(access!.workspaceRole).toBeNull(); // spans by org role, not membership
    }
  });

  it('grants a plain org member only the workspaces they are explicitly added to (falls back to their workspace role)', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const { workspace: w1 } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(w1.id);
    const { workspace: w2 } = await workspacesService.createWorkspace({
      name: 'Beta',
      ownerUserId: owner.id,
      organizationId: orgId,
    });
    // member is added to w1 only (which upward-auto-joins them to the org as `member`).
    await workspacesService.addMember({ userId: member.id, workspaceId: w1.id });

    const a1 = await organizationsService.resolveWorkspaceAccess(member.id, w1.id);
    expect(a1).not.toBeNull();
    expect(a1!.effectiveRole).toBe('member');
    expect(a1!.isOrgAdmin).toBe(false);

    // Same org, but no workspace membership in w2 → DENIED (org member reaches
    // only the workspaces they're explicitly in).
    const a2 = await organizationsService.resolveWorkspaceAccess(member.id, w2.id);
    expect(a2).toBeNull();
  });

  it('DENIES a user who is a member of a workspace but NOT of its org (org membership gates workspace access)', async () => {
    const owner = await createTestUser();
    const stale = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);
    // stale joins the workspace (auto-joins the org), then is removed from the ORG
    // — leaving the workspace membership intact (the asymmetry).
    await workspacesService.addMember({ userId: stale.id, workspaceId: workspace.id });
    await organizationsService.removeMember({
      organizationId: orgId,
      userId: stale.id,
      actorUserId: owner.id,
    });

    const access = await organizationsService.resolveWorkspaceAccess(stale.id, workspace.id);
    expect(access).toBeNull(); // denied → the route raises 404-not-403

    // The workspace membership row is still present (org-remove does not delete it).
    const wsm = await adminDb.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: stale.id, workspaceId: workspace.id } },
    });
    expect(wsm).not.toBeNull();
  });

  it('returns null for a non-existent workspace', async () => {
    const user = await createTestUser();
    const access = await organizationsService.resolveWorkspaceAccess(user.id, 'nonexistent-id');
    expect(access).toBeNull();
  });

  it('resolveActiveWorkspace honours a cookie pinned to a SECOND org-backed workspace (jobs-flow regression)', async () => {
    // A user who owns two workspaces in two different orgs: the cookie-pinned
    // one must win. Regression for the jobs-flow cross-workspace-isolation e2e —
    // the gate now skips a workspace whose org the user isn't in, so a directly-
    // created workspaceB without an org membership would fall back to A. Both
    // here are org-backed, so the cookie selects which one resolves.
    const owner = await createTestUser();
    const { workspace: wsA } = await workspacesService.createWorkspace({
      name: 'Alpha',
      ownerUserId: owner.id,
    });
    const orgB = await organizationsService.createOrganization({
      name: 'Beta Org',
      actorUserId: owner.id,
    });
    const { workspace: wsB } = await workspacesService.createWorkspace({
      name: 'Beta WS',
      ownerUserId: owner.id,
      organizationId: orgB.id,
    });

    // Cookie pinned to B → resolves to B (not the first-created A).
    expect(await workspacesService.resolveActiveWorkspace(owner.id, wsB.id)).toBe(wsB.id);
    // Cookie pinned to A → resolves to A.
    expect(await workspacesService.resolveActiveWorkspace(owner.id, wsA.id)).toBe(wsA.id);
  });
});

describe('membership direction (6.10.2 §5, asymmetric)', () => {
  it('adding a user to a WORKSPACE auto-creates their org membership (upward invariant)', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);

    await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });

    const orgm = await adminDb.$transaction((tx) =>
      organizationMembershipRepository.findByOrgAndUserInTx(orgId, member.id, tx),
    );
    expect(orgm).not.toBeNull();
    expect(orgm!.role).toBe('member');
  });

  it('adding a user to the ORG creates NO workspace membership at TWO workspaces (org-only members are valid)', async () => {
    // RE-POINTED at a TWO-workspace org by MOTIR-3501. §5's asymmetry is
    // unchanged at ≥ 2 and that is what this case has always defended; at ONE
    // workspace the count-1 arm now fires, which the case below asserts.
    //
    // ⚠️ THE ACTING ADMIN BELONGS TO EXACTLY ONE OF THE TWO, deliberately. A
    // fixture whose workspaces share an owner puts the actor in both, so an
    // ACTOR-scoped workspace count would read 2 and this case would pass for the
    // wrong reason — against an implementation that fires the arm in every
    // two-workspace org whose admin is in one of them. This is the only shape
    // that tells an org-scoped count from an actor-scoped one.
    const owner = await createTestUser();
    const other = await createTestUser();
    const orgOnly = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);

    const second = await adminDb.workspace.create({
      data: { name: 'Acme Beta', slug: 'acme-beta-org-only', organizationId: orgId },
    });
    await adminDb.workspaceMembership.create({
      data: { userId: other.id, workspaceId: second.id, role: 'owner' },
    });
    await adminDb.organizationMembership.create({
      data: { organizationId: orgId, userId: other.id, role: 'member' },
    });

    await organizationsService.addMember({
      organizationId: orgId,
      userId: orgOnly.id,
      role: 'member',
      actorUserId: owner.id,
    });

    // No workspace membership anywhere.
    expect(await adminDb.workspaceMembership.count({ where: { userId: orgOnly.id } })).toBe(0);
    // ...and they can't reach either workspace (org member, no workspace membership).
    expect(await organizationsService.resolveWorkspaceAccess(orgOnly.id, workspace.id)).toBeNull();
    expect(await organizationsService.resolveWorkspaceAccess(orgOnly.id, second.id)).toBeNull();
  });

  it('adding a user to the ORG at ONE workspace ALSO joins that workspace (§5 count-1 arm)', async () => {
    // MOTIR-3501. The dead end this closes: below two workspaces §6 hides the
    // workspace tier entirely, so an org-only member had no UI, no switcher and
    // no add-to-workspace action to repair it.
    //
    // This runs under the non-bypass runtime role like every other test here, so
    // the `bindWorkspaceContext` call inside `addMember` is LOAD-BEARING: without
    // it `membership_insert_active_or_bootstrap` refuses the insert outright and
    // this case fails rather than silently passing under an owner connection
    // (AC 7).
    const owner = await createTestUser();
    const invitee = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);

    await organizationsService.addMember({
      organizationId: orgId,
      userId: invitee.id,
      role: 'member',
      actorUserId: owner.id,
    });

    const wsm = await adminDb.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: invitee.id, workspaceId: workspace.id } },
    });
    expect(wsm).not.toBeNull();
    expect(wsm!.role).toBe('member');

    // The point of the arm: they can actually reach the workspace now.
    const access = await organizationsService.resolveWorkspaceAccess(invitee.id, workspace.id);
    expect(access).not.toBeNull();
  });

  it('the count-1 arm writes BOTH rows in ONE transaction', async () => {
    // AC 2, and the case that FOUND A REAL DEFECT rather than confirming one.
    //
    // The arm first swallowed a unique violation on the workspace membership, on
    // the reasoning that the invariant already held. It does not survive contact
    // with Postgres: a failed statement ABORTS the transaction, so catching the
    // error in JS leaves a dead transaction and the org-membership INSERT before
    // it is rolled back at commit. This assertion returned 0 org memberships, and
    // the arm now CHECKS FIRST instead.
    //
    // The shape it covers is a common path, not a race: the user was added to the
    // workspace directly (upward-joining them to the org) and is now being given
    // an explicit org role. Both rows must exist afterwards, exactly once.
    const owner = await createTestUser();
    const invitee = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);

    // Already a workspace member (added directly, which upward-joined them to the
    // org). Remove the org row so `addMember` runs its create path again.
    await workspacesService.addMember({ userId: invitee.id, workspaceId: workspace.id });
    await adminDb.organizationMembership.deleteMany({
      where: { organizationId: orgId, userId: invitee.id },
    });

    await organizationsService.addMember({
      organizationId: orgId,
      userId: invitee.id,
      role: 'member',
      actorUserId: owner.id,
    });

    // Exactly one workspace membership, and the org row committed.
    expect(
      await adminDb.workspaceMembership.count({
        where: { userId: invitee.id, workspaceId: workspace.id },
      }),
    ).toBe(1);
    expect(
      await adminDb.organizationMembership.count({
        where: { organizationId: orgId, userId: invitee.id },
      }),
    ).toBe(1);
  });

  it('is still idempotent-safe on a second add, leaving exactly one workspace membership', async () => {
    // AC 4.
    const owner = await createTestUser();
    const invitee = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);

    const add = () =>
      organizationsService.addMember({
        organizationId: orgId,
        userId: invitee.id,
        role: 'member',
        actorUserId: owner.id,
      });

    await add();
    await expect(add()).rejects.toBeInstanceOf(AlreadyOrgMemberError);

    expect(
      await adminDb.workspaceMembership.count({
        where: { userId: invitee.id, workspaceId: workspace.id },
      }),
    ).toBe(1);
  });

  it('rejects a duplicate org add with AlreadyOrgMemberError', async () => {
    const owner = await createTestUser();
    const u = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);
    await organizationsService.addMember({
      organizationId: orgId,
      userId: u.id,
      role: 'member',
      actorUserId: owner.id,
    });
    await expect(
      organizationsService.addMember({
        organizationId: orgId,
        userId: u.id,
        role: 'member',
        actorUserId: owner.id,
      }),
    ).rejects.toBeInstanceOf(AlreadyOrgMemberError);
  });
});

describe('org admin authorization + last-owner guard', () => {
  it('refuses a non-admin org member adding/renaming (OrgForbiddenError)', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const outsider = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);
    await organizationsService.addMember({
      organizationId: orgId,
      userId: member.id,
      role: 'member',
      actorUserId: owner.id,
    });

    await expect(
      organizationsService.renameOrganization({
        organizationId: orgId,
        actorUserId: member.id,
        name: 'Renamed',
      }),
    ).rejects.toBeInstanceOf(OrgForbiddenError);

    await expect(
      organizationsService.addMember({
        organizationId: orgId,
        userId: outsider.id,
        role: 'member',
        actorUserId: member.id,
      }),
    ).rejects.toBeInstanceOf(OrgForbiddenError);
  });

  it('hides the org from a non-member with OrganizationNotFoundError (404-not-403)', async () => {
    const owner = await createTestUser();
    const stranger = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);

    await expect(
      organizationsService.listMembers({ organizationId: orgId, actorUserId: stranger.id }),
    ).rejects.toBeInstanceOf(OrganizationNotFoundError);
  });

  it('refuses to remove or demote the last owner (LastOrgOwnerError)', async () => {
    const owner = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);

    await expect(
      organizationsService.removeMember({
        organizationId: orgId,
        userId: owner.id,
        actorUserId: owner.id,
      }),
    ).rejects.toBeInstanceOf(LastOrgOwnerError);

    await expect(
      organizationsService.changeMemberRole({
        organizationId: orgId,
        userId: owner.id,
        role: 'member',
        actorUserId: owner.id,
      }),
    ).rejects.toBeInstanceOf(LastOrgOwnerError);
  });

  it('allows removing an owner once another owner exists', async () => {
    const owner = await createTestUser();
    const second = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);
    await organizationsService.addMember({
      organizationId: orgId,
      userId: second.id,
      role: 'owner',
      actorUserId: owner.id,
    });

    await organizationsService.removeMember({
      organizationId: orgId,
      userId: owner.id,
      actorUserId: second.id,
    });
    const gone = await adminDb.$transaction((tx) =>
      organizationMembershipRepository.findByOrgAndUserInTx(orgId, owner.id, tx),
    );
    expect(gone).toBeNull();
  });
});

describe('cross-workspace member roster (paginated)', () => {
  it('paginates the roster and reports a stable next cursor + total', async () => {
    const owner = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);
    // Owner + 4 added members = 5 total.
    for (let i = 0; i < 4; i++) {
      const u = await createTestUser();
      await organizationsService.addMember({
        organizationId: orgId,
        userId: u.id,
        role: 'member',
        actorUserId: owner.id,
      });
    }

    const page1 = await organizationsService.listMembers({
      organizationId: orgId,
      actorUserId: owner.id,
      limit: 2,
    });
    expect(page1.members).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.nextCursor).not.toBeNull();
    // Owner (first membership) leads the roster and carries their workspace.
    expect(page1.members[0]!.userId).toBe(owner.id);
    expect(page1.members[0]!.workspaces.map((w) => w.name)).toContain('Acme');

    const page2 = await organizationsService.listMembers({
      organizationId: orgId,
      actorUserId: owner.id,
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.members).toHaveLength(2);
    // No overlap between pages.
    const ids1 = new Set(page1.members.map((m) => m.userId));
    expect(page2.members.every((m) => !ids1.has(m.userId))).toBe(true);
  });
});

describe('provisioning + the user-orgs surface', () => {
  it('provisionForNewUser creates an org of one + a default workspace + owner memberships', async () => {
    const user = await createTestUser({ name: 'Dana' });
    const { workspace } = await workspacesService.provisionForNewUser({
      userId: user.id,
      userName: 'Dana',
    });
    const orgId = await orgIdOfWorkspace(workspace.id);

    const orgm = await adminDb.$transaction((tx) =>
      organizationMembershipRepository.findByOrgAndUserInTx(orgId, user.id, tx),
    );
    expect(orgm!.role).toBe('owner');
    const wsm = await adminDb.workspaceMembership.findUnique({
      where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } },
    });
    expect(wsm!.role).toBe('owner');
  });

  it('lists the orgs a user belongs to and resolves the active one with its role', async () => {
    const user = await createTestUser();
    await workspacesService.createWorkspace({ name: 'Acme', ownerUserId: user.id });
    await organizationsService.createOrganization({ name: 'Second Co', actorUserId: user.id });

    const orgs = await organizationsService.listUserOrganizations(user.id);
    expect(orgs).toHaveLength(2);

    const active = await organizationsService.resolveActiveOrganization(user.id);
    expect(active).not.toBeNull();
    expect(active!.role).toBe('owner');
  });

  it('renames an organization as an owner', async () => {
    const owner = await createTestUser();
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Acme',
      ownerUserId: owner.id,
    });
    const orgId = await orgIdOfWorkspace(workspace.id);

    const renamed = await organizationsService.renameOrganization({
      organizationId: orgId,
      actorUserId: owner.id,
      name: 'Acme Renamed',
    });
    expect(renamed.name).toBe('Acme Renamed');
  });
});
