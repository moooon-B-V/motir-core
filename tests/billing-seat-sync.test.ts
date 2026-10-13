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
const { adminDb } = await import('./helpers/adminDb');
const { enqueueScaledTrackerSeatSync } = await import('@/lib/billing/seatSync');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { billingPropagationService } = await import('@/lib/services/billingPropagationService');
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
  const organizationId = (
    await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
  ).organizationId;
  return { organizationId, ownerId: owner.id, workspaceId: workspace.id };
}

beforeEach(async () => {
  await truncateAuthTables();
  enqueueMock.mockReset();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
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
    const row = await adminDb.verification.findFirstOrThrow({
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

// MOTIR-8403: an AI plan starting, ending or moving flips the AI-included-seat
// flag, and the seat subscription turning active or cleared decides whether
// seats bill at all — both change the billed seat target, so both pushes resync
// the seats at once. An unchanged push (a redelivered webhook) does not.
describe('seat-sync is enqueued when a billing push changes what the seats bill', () => {
  const ACTIVE = {
    status: 'active',
    priceId: 'tracker_monthly',
    currentPeriodEnd: 1893456000,
  } as const;

  it('the AI-included-seat flag turning on, then off, enqueues once each', async () => {
    const { organizationId } = await makeOrg();
    enqueueMock.mockReset();

    await billingPropagationService.setAiIncludedSeat({ organizationId, included: true });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock).toHaveBeenLastCalledWith(organizationId);

    await billingPropagationService.setAiIncludedSeat({ organizationId, included: false });
    expect(enqueueMock).toHaveBeenCalledTimes(2);
  });

  it('pushing the same AI-included-seat value again enqueues nothing', async () => {
    const { organizationId } = await makeOrg();
    await billingPropagationService.setAiIncludedSeat({ organizationId, included: true });
    enqueueMock.mockReset();

    await billingPropagationService.setAiIncludedSeat({ organizationId, included: true });
    // The flag starts false, so a false push is unchanged too.
    const other = await makeOrg();
    enqueueMock.mockReset();
    await billingPropagationService.setAiIncludedSeat({
      organizationId: other.organizationId,
      included: false,
    });

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('the seat subscription becoming active, then cleared, enqueues once each', async () => {
    const { organizationId } = await makeOrg();
    enqueueMock.mockReset();

    await billingPropagationService.setScaledTrackerState({
      organizationId,
      scaledTrackerSubscription: ACTIVE,
    });
    expect(enqueueMock).toHaveBeenCalledTimes(1);

    await billingPropagationService.setScaledTrackerState({
      organizationId,
      scaledTrackerSubscription: null,
    });
    expect(enqueueMock).toHaveBeenCalledTimes(2);
  });

  it('an unchanged seat-subscription push enqueues nothing', async () => {
    const { organizationId } = await makeOrg();
    await billingPropagationService.setScaledTrackerState({
      organizationId,
      scaledTrackerSubscription: ACTIVE,
    });
    enqueueMock.mockReset();

    await billingPropagationService.setScaledTrackerState({
      organizationId,
      scaledTrackerSubscription: ACTIVE,
    });

    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('a failing enqueue leaves both pushes successful and is logged', async () => {
    const { organizationId } = await makeOrg();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    enqueueMock.mockRejectedValue(new Error('queue down'));

    const seat = await billingPropagationService.setAiIncludedSeat({
      organizationId,
      included: true,
    });
    const scaled = await billingPropagationService.setScaledTrackerState({
      organizationId,
      scaledTrackerSubscription: ACTIVE,
    });

    expect(seat.aiIncludedSeat).toBe(true);
    expect(scaled.scaledTrackerSubscription).toEqual(ACTIVE);
    const row = await adminDb.organization.findUniqueOrThrow({ where: { id: organizationId } });
    expect(row.aiIncludedSeat).toBe(true);
    expect(errorSpy).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });
});
