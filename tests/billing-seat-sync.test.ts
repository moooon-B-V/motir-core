import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Wiring/sweep test for the scaled-tracker SEAT SYNC (Subtask 8.1.12): every
// org-membership add/remove path must enqueue a resync, and paths that do NOT
// change the org's member count must NOT. The enqueue helper is mocked to a spy
// so this asserts the CALL SITES (the "sweep ALL membership creators" rule) —
// the helper's own cloud gate + the sync behaviour are tested elsewhere
// (seatSync's gate runs inside the real helper; the sync in billingService.test).
vi.mock('@/lib/billing/seatSync', () => ({
  enqueueScaledTrackerSeatSync: vi.fn(),
}));

const { db } = await import('@/lib/db');
const { enqueueScaledTrackerSeatSync } = await import('@/lib/billing/seatSync');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { workspaceInvitesService, INVITE_IDENTIFIER_PREFIX } =
  await import('@/lib/services/workspaceInvitesService');
const { createTestUser } = await import('./fixtures/userFixtures');
const { truncateAuthTables } = await import('./helpers/db');

const enqueueMock = vi.mocked(enqueueScaledTrackerSeatSync);

async function makeOrg(): Promise<{
  organizationId: string;
  ownerId: string;
  workspaceId: string;
}> {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  const organizationId = (await db.workspace.findUniqueOrThrow({ where: { id: workspace.id } }))
    .organizationId;
  return { organizationId, ownerId: owner.id, workspaceId: workspace.id };
}

beforeEach(async () => {
  await truncateAuthTables();
  enqueueMock.mockReset();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('seat-sync is enqueued on every org-membership COUNT change', () => {
  it('organizationsService.addMember enqueues a resync for the org', async () => {
    const { organizationId, ownerId } = await makeOrg();
    const member = await createTestUser();

    await organizationsService.addMember({
      organizationId,
      userId: member.id,
      role: 'member',
      actorUserId: ownerId,
    });

    expect(enqueueMock).toHaveBeenCalledWith(organizationId);
  });

  it('organizationsService.removeMember enqueues a resync for the org', async () => {
    const { organizationId, ownerId } = await makeOrg();
    const member = await createTestUser();
    await organizationsService.addMember({
      organizationId,
      userId: member.id,
      role: 'member',
      actorUserId: ownerId,
    });
    enqueueMock.mockReset();

    await organizationsService.removeMember({
      organizationId,
      userId: member.id,
      actorUserId: ownerId,
    });

    expect(enqueueMock).toHaveBeenCalledWith(organizationId);
  });

  it('workspacesService.addMember enqueues a resync (the upward org auto-join may grow the count)', async () => {
    const { organizationId, workspaceId } = await makeOrg();
    const joiner = await createTestUser();

    await workspacesService.addMember({ userId: joiner.id, workspaceId });

    expect(enqueueMock).toHaveBeenCalledWith(organizationId);
  });

  it('workspaceInvitesService.acceptInvite enqueues a resync (a new org enrolment)', async () => {
    const { organizationId, ownerId, workspaceId } = await makeOrg();
    const invitee = await createTestUser();
    await workspaceInvitesService.sendInvite({
      inviterUserId: ownerId,
      inviterName: 'Inviter',
      workspaceId,
      targetEmail: invitee.email,
    });
    const row = await db.verification.findFirstOrThrow({
      where: {
        identifier: { startsWith: INVITE_IDENTIFIER_PREFIX },
        value: { contains: invitee.email },
      },
    });
    const token = row.identifier.slice(INVITE_IDENTIFIER_PREFIX.length);
    enqueueMock.mockReset();

    await workspaceInvitesService.acceptInvite(token, { id: invitee.id, email: invitee.email });

    expect(enqueueMock).toHaveBeenCalledWith(organizationId);
  });
});

describe('seat-sync is NOT enqueued when the member COUNT is unchanged', () => {
  it('changeMemberRole does not enqueue (a role change is not a count change)', async () => {
    const { organizationId, ownerId } = await makeOrg();
    const member = await createTestUser();
    await organizationsService.addMember({
      organizationId,
      userId: member.id,
      role: 'member',
      actorUserId: ownerId,
    });
    enqueueMock.mockReset();

    await organizationsService.changeMemberRole({
      organizationId,
      userId: member.id,
      role: 'admin',
      actorUserId: ownerId,
    });

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('creating a brand-new org (owner bootstrap) does not enqueue — a new org cannot be scaled', async () => {
    const owner = await createTestUser();
    enqueueMock.mockReset();

    await organizationsService.createOrganization({ name: 'Fresh Co', actorUserId: owner.id });

    expect(enqueueMock).not.toHaveBeenCalled();
  });
});
