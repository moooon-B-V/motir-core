import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDb } from '../helpers/adminDb';

// MOTIR-6310 — transfer ownership, the one door by which an organization's Owner
// changes. Real Postgres for the org, its memberships and the row locks. Three
// boundary seams are stubbed, each the conventional one: the compliance gate
// (a route test has no cookie jar), the post-commit seat-sync enqueue every
// org-membership write fires, and `sendEvent` — the durable email queue — so
// the test can see what was enqueued and force it to fail.
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));
const { requireCompliantSession } = vi.hoisted(() => ({ requireCompliantSession: vi.fn() }));
vi.mock('@/lib/auth/requireCompliantSession', () => ({ requireCompliantSession }));
const sendEventImpl = vi.hoisted(() => ({
  current: vi.fn(async (_name: string, _data: Record<string, unknown>) => undefined),
}));
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: (name: string, data: Record<string, unknown>) => sendEventImpl.current(name, data),
}));

const { db } = await import('@/lib/db');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');
const { OwnershipChangedError } = await import('@/lib/organizations/errors');
const { POST } = await import('@/app/api/organizations/[orgId]/ownership-transfer/route');

const ORG_NAME = 'Acme';

async function makeOrgWithRoles() {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme ws',
    ownerUserId: owner.id,
  });
  const organizationId = (
    await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
  ).organizationId;
  await adminDb.organization.update({ where: { id: organizationId }, data: { name: ORG_NAME } });
  const admin = await createTestUser();
  await organizationsService.addMember({
    organizationId,
    userId: admin.id,
    role: 'admin',
    actorUserId: owner.id,
  });
  const member = await createTestUser();
  await organizationsService.addMember({
    organizationId,
    userId: member.id,
    role: 'member',
    actorUserId: owner.id,
  });
  const outsider = await createTestUser();
  return { organizationId, owner, admin, member, outsider };
}

async function roleOf(organizationId: string, userId: string) {
  const row = await adminDb.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  return row?.role ?? null;
}

async function owners(organizationId: string) {
  return adminDb.organizationMembership.findMany({
    where: { organizationId, role: 'owner' },
    select: { userId: true },
  });
}

function transferAs(
  actor: { id: string; email: string },
  orgId: string,
  body: Record<string, unknown>,
) {
  requireCompliantSession.mockResolvedValue({
    ok: true,
    session: { user: { id: actor.id, email: actor.email } },
  });
  return POST(
    new Request(`http://localhost:3000/api/organizations/${orgId}/ownership-transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ orgId }) },
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  sendEventImpl.current = vi.fn(async () => undefined);
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('transferOwnership — the Owner hands the organization over whole', () => {
  for (const targetRole of ['admin', 'member'] as const) {
    it(`to an ${targetRole}: exactly one owner row, the target's, and the previous Owner is an admin`, async () => {
      const org = await makeOrgWithRoles();
      const target = org[targetRole];
      const res = await transferAs(org.owner, org.organizationId, {
        toUserId: target.id,
        confirmName: ORG_NAME,
      });
      expect(res.status).toBe(200);
      expect(await owners(org.organizationId)).toEqual([{ userId: target.id }]);
      expect(await roleOf(org.organizationId, org.owner.id)).toBe('admin');
    });
  }

  it('emails both people after the commit, each with their own side of it', async () => {
    const org = await makeOrgWithRoles();
    await organizationsService.transferOwnership({
      organizationId: org.organizationId,
      actorUserId: org.owner.id,
      toUserId: org.admin.id,
      confirmName: ORG_NAME,
    });
    const sent = sendEventImpl.current.mock.calls.map(([name, data]) => ({ name, data }));
    expect(sent.map((s) => s.name)).toEqual(['email.send', 'email.send']);
    expect(
      sent.map((s) => [s.data['to'], (s.data['data'] as { audience: string }).audience]),
    ).toEqual([
      [org.admin.email, 'new-owner'],
      [org.owner.email, 'previous-owner'],
    ]);
    for (const { data } of sent) {
      expect(data['template']).toBe('ownership-transferred');
      expect(data['data']).toMatchObject({
        organizationName: ORG_NAME,
        previousOwnerName: org.owner.name,
        newOwnerName: org.admin.name,
      });
    }
  });

  it('a forced send failure leaves the transfer committed and logs the failure', async () => {
    const org = await makeOrgWithRoles();
    sendEventImpl.current = vi.fn(async () => {
      throw new Error('queue down');
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await organizationsService.transferOwnership({
        organizationId: org.organizationId,
        actorUserId: org.owner.id,
        toUserId: org.member.id,
        confirmName: ORG_NAME,
      });
      expect(await owners(org.organizationId)).toEqual([{ userId: org.member.id }]);
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('ownership-transferred email could not be enqueued'),
        expect.objectContaining({ organizationId: org.organizationId }),
      );
    } finally {
      logged.mockRestore();
    }
  });
});

describe('transferOwnership — refusals, and nothing changes on any of them', () => {
  it('403 for an Admin and for a Member; 404 for a non-member', async () => {
    const org = await makeOrgWithRoles();
    const cases = [
      [org.admin, 403],
      [org.member, 403],
      [org.outsider, 404],
    ] as const;
    for (const [actor, status] of cases) {
      const res = await transferAs(actor, org.organizationId, {
        toUserId: org.member.id === actor.id ? org.admin.id : org.member.id,
        confirmName: ORG_NAME,
      });
      expect(res.status).toBe(status);
    }
    expect(await owners(org.organizationId)).toEqual([{ userId: org.owner.id }]);
  });

  it('422 INVALID_OWNERSHIP_TARGET naming `not_member` for someone outside the org', async () => {
    const org = await makeOrgWithRoles();
    const res = await transferAs(org.owner, org.organizationId, {
      toUserId: org.outsider.id,
      confirmName: ORG_NAME,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      code: 'INVALID_OWNERSHIP_TARGET',
      reason: 'not_member',
    });
    expect(await owners(org.organizationId)).toEqual([{ userId: org.owner.id }]);
  });

  it('422 INVALID_OWNERSHIP_TARGET naming `self` for the Owner themselves', async () => {
    const org = await makeOrgWithRoles();
    const res = await transferAs(org.owner, org.organizationId, {
      toUserId: org.owner.id,
      confirmName: ORG_NAME,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'INVALID_OWNERSHIP_TARGET', reason: 'self' });
  });

  it('400 for a confirmName that is not EXACTLY the organization name', async () => {
    const org = await makeOrgWithRoles();
    for (const confirmName of ['acme', 'Acme ', 'Other']) {
      const res = await transferAs(org.owner, org.organizationId, {
        toUserId: org.admin.id,
        confirmName,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'OWNERSHIP_CONFIRMATION_MISMATCH' });
    }
    expect(await owners(org.organizationId)).toEqual([{ userId: org.owner.id }]);
    expect(sendEventImpl.current).not.toHaveBeenCalled();
  });

  it('400 for a malformed body', async () => {
    const org = await makeOrgWithRoles();
    expect(
      (await transferAs(org.owner, org.organizationId, { confirmName: ORG_NAME })).status,
    ).toBe(400);
    expect(
      (await transferAs(org.owner, org.organizationId, { toUserId: org.admin.id })).status,
    ).toBe(400);
  });
});

describe('concurrency — two transfers from the same Owner at once', () => {
  it('exactly one commits; the other gets OwnershipChangedError (409), the index never raises, one Owner remains', async () => {
    const org = await makeOrgWithRoles();

    // Make the two transfers OVERLAP deterministically: a third transaction holds
    // the Owner's row lock while both start. Both then pass the (unlocked)
    // capability read — the Owner is still the Owner — and both block on the
    // row. When the holder commits, one transfer takes the lock and commits;
    // the other takes it next and must re-read the COMMITTED role.
    let lockHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      lockHeld = resolve;
    });
    const holder = adminDb.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "organization_membership"
          WHERE "organizationId" = ${org.organizationId} AND "userId" = ${org.owner.id}
          FOR UPDATE`;
        lockHeld();
        await tx.$executeRawUnsafe('SELECT pg_sleep(0.5)');
      },
      { timeout: 10_000 },
    );
    await held;

    const transfer = (toUserId: string) =>
      organizationsService.transferOwnership({
        organizationId: org.organizationId,
        actorUserId: org.owner.id,
        toUserId,
        confirmName: ORG_NAME,
      });
    const results = await Promise.allSettled([transfer(org.admin.id), transfer(org.member.id)]);
    await holder;

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(OwnershipChangedError);

    const remaining = await owners(org.organizationId);
    expect(remaining).toHaveLength(1);
    expect([org.admin.id, org.member.id]).toContain(remaining[0]!.userId);
    expect(await roleOf(org.organizationId, org.owner.id)).toBe('admin');
  });
});

describe('ownershipTransferredEmail — the template', () => {
  const base = {
    recipientName: 'Dana',
    organizationName: 'Acme',
    previousOwnerName: 'Dana',
    newOwnerName: 'Rui',
    settingsUrl: 'https://app.test/settings/organization',
  };

  it('tells the NEW owner they are the Owner, and links the settings page in both bodies', async () => {
    const { ownershipTransferredEmail } = await import('@/lib/emailTemplates/ownershipTransferred');
    const mail = await ownershipTransferredEmail({
      ...base,
      recipientName: 'Rui',
      audience: 'new-owner',
    });
    expect(mail.subject).toBe('Ownership of Acme has moved to Rui');
    expect(mail.text).toContain(
      'Dana transferred ownership of Acme to you. You are now its Owner.',
    );
    expect(mail.text).toContain(base.settingsUrl);
    expect(mail.html).toContain(base.settingsUrl);
  });

  it('tells the PREVIOUS owner they are now an Admin', async () => {
    const { ownershipTransferredEmail } = await import('@/lib/emailTemplates/ownershipTransferred');
    const mail = await ownershipTransferredEmail({ ...base, audience: 'previous-owner' });
    expect(mail.text).toContain('You transferred ownership of Acme to Rui. You are now an Admin.');
  });

  it('renders the zh twin', async () => {
    const { ownershipTransferredEmail } = await import('@/lib/emailTemplates/ownershipTransferred');
    const mail = await ownershipTransferredEmail({
      ...base,
      audience: 'previous-owner',
      locale: 'zh',
    });
    expect(mail.subject).toBe('Acme 的所有权已转移给 Rui');
    expect(mail.text).toContain('你现在是管理员');
  });
});
