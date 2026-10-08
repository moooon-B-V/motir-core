import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';

// Platform staff are EMAILED when an Enterprise request lands (Story MOTIR-7602 ·
// Subtask MOTIR-7606). Real Postgres; the one boundary stubbed is the job
// publisher, `sendEvent`, so the test can see each `email.send` event — and, at
// the moment it is published, whether the request it describes has COMMITTED.
// That check reads through `adminDb`, a separate connection: a send made inside
// the create transaction would find no row there, and fail the assertion.

type Sent = {
  name: string;
  idempotencyKey: string;
  to: string;
  template: string;
  workspaceId: string | null;
  data: Record<string, unknown>;
  rowCommitted: boolean;
};
const sent: Sent[] = [];
const sendBehaviour = { fail: false };

vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (name: string, payload: Record<string, unknown>) => {
    if (sendBehaviour.fail) throw new Error('queue unavailable');
    const requestId = String(payload['idempotencyKey']).split(':')[1]!;
    const rowCommitted =
      (await adminDb.enterpriseRequest.findUnique({ where: { id: requestId } })) !== null;
    sent.push({ name, ...(payload as Omit<Sent, 'name' | 'rowCommitted'>), rowCommitted });
  },
}));

const { enterpriseRequestService } = await import('@/lib/services/enterpriseRequestService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { truncateAuthTables } = await import('../helpers/db');

async function makeOrg() {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme Robotics',
    ownerUserId: owner.id,
  });
  const organizationId = (
    await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
  ).organizationId;
  return { organizationId, owner: { userId: owner.id, email: owner.email, name: owner.name } };
}

async function makeStaff(role: 'support' | 'operator' | 'superadmin', emailVerified = true) {
  const user = await createTestUser();
  await adminDb.user.update({
    where: { id: user.id },
    data: { platformRole: role, emailVerified },
  });
  return user;
}

beforeEach(async () => {
  await truncateAuthTables();
  sent.length = 0;
  sendBehaviour.fail = false;
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_BASE_URL'] = 'https://app.test';
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_BASE_URL'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the staff email on a new Enterprise request', () => {
  it('sends one email.send per verified staff member, every role, AFTER the request commits', async () => {
    const { organizationId, owner } = await makeOrg();
    const support = await makeStaff('support');
    const operator = await makeStaff('operator');
    const superadmin = await makeStaff('superadmin');
    await makeStaff('operator', false); // unverified — not a recipient
    await createTestUser(); // not staff

    const dto = await enterpriseRequestService.create(owner, organizationId, {
      cardsPerDay: 25,
      teamSize: 'size_11_50',
      note: 'Please call.',
    });

    expect(sent.map((s) => s.to).sort()).toEqual(
      [support.email, operator.email, superadmin.email].sort(),
    );
    for (const s of sent) {
      expect(s.name).toBe('email.send');
      expect(s.template).toBe('enterprise-request-received');
      expect(s.workspaceId).toBeNull();
      expect(s.rowCommitted).toBe(true);
      expect(s.data).toMatchObject({
        organizationName: 'Acme Robotics',
        requesterEmail: owner.email,
        cardsPerDay: 25,
        parallelAgents: null,
        teamSize: 'size_11_50',
        note: 'Please call.',
        requestUrl: `https://app.test/admin/enterprise-requests/${dto.id}`,
      });
    }
  });

  it('keys each event enterprise-request:<requestId>:<userId>', async () => {
    const { organizationId, owner } = await makeOrg();
    const a = await makeStaff('support');
    const b = await makeStaff('operator');

    const dto = await enterpriseRequestService.create(owner, organizationId, { note: 'x' });

    const byRecipient = Object.fromEntries(sent.map((s) => [s.to, s.idempotencyKey]));
    expect(byRecipient[a.email]).toBe(`enterprise-request:${dto.id}:${a.id}`);
    expect(byRecipient[b.email]).toBe(`enterprise-request:${dto.id}:${b.id}`);
  });

  it('sends nothing, and still succeeds, when there are no staff', async () => {
    const { organizationId, owner } = await makeOrg();
    const dto = await enterpriseRequestService.create(owner, organizationId, { note: 'x' });
    expect(dto.status).toBe('received');
    expect(sent).toHaveLength(0);
  });

  it('a failed send neither fails nor rolls back the request', async () => {
    const { organizationId, owner } = await makeOrg();
    await makeStaff('operator');
    sendBehaviour.fail = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dto = await enterpriseRequestService.create(owner, organizationId, { note: 'x' });

    expect(dto.status).toBe('received');
    expect(await adminDb.enterpriseRequest.count({ where: { id: dto.id } })).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a refused request (one already open) emails nobody', async () => {
    const { organizationId, owner } = await makeOrg();
    await makeStaff('operator');
    await enterpriseRequestService.create(owner, organizationId, { note: 'one' });
    sent.length = 0;

    await expect(
      enterpriseRequestService.create(owner, organizationId, { note: 'two' }),
    ).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
});
