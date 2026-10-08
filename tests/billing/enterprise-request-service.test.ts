import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  BillingForbiddenError,
  BillingNotAvailableError,
  EnterpriseRequestOpenError,
  EnterpriseRequestValidationError,
} from '@/lib/billing/errors';
import { OrganizationClosingError, OrganizationNotFoundError } from '@/lib/organizations/errors';
import { enterpriseRequestService } from '@/lib/services/enterpriseRequestService';
import { organizationsService } from '@/lib/services/organizationsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { warmPool } from '../helpers/warmPool';
import { seedControlOrg, seedSiblingWorkspaceRepo } from '../helpers/siblingWorkspaceRepo';

// The ORG side of an Enterprise request (Story MOTIR-7602 · Subtask MOTIR-7605) —
// `enterpriseRequestService`, against the real Postgres. Pins the billing
// surface's gates (cloud, membership, `manageBilling`), the input schema, the
// contact default, the tier snapshot, and — the load-bearing one — that ONE open
// request per org holds under a real race, with the loser told which request
// won.

async function makeOrg() {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  const organizationId = (
    await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
  ).organizationId;
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
  const actor = (u: { id: string; email: string }) => ({ userId: u.id, email: u.email });
  return { organizationId, owner: actor(owner), admin: actor(admin), member: actor(member) };
}

async function rowsOf(organizationId: string) {
  return adminDb.enterpriseRequest.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'asc' },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  process.env['MOTIR_CLOUD'] = 'true';
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('enterpriseRequestService.create', () => {
  it('records a request from the owner with status new, the tier snapshot and the email as contact', async () => {
    const { organizationId, owner } = await makeOrg();

    const dto = await enterpriseRequestService.create(owner, organizationId, {
      note: 'We want to run our whole backlog.',
    });

    expect(dto).toMatchObject({
      status: 'received',
      contact: owner.email,
      note: 'We want to run our whole backlog.',
      cardsPerDay: null,
      parallelAgents: null,
      agentPath: null,
      autonomy: null,
      startWhen: null,
      teamSize: null,
    });
    expect(Date.parse(dto.createdAt)).not.toBeNaN();

    const [row] = await rowsOf(organizationId);
    expect(row).toMatchObject({
      id: dto.id,
      status: 'new',
      requestedById: owner.userId,
      tierKeyAtRequest: 'free',
      closedAt: null,
    });
  });

  it('lets an admin send, and round-trips every answer it is given', async () => {
    const { organizationId, admin } = await makeOrg();

    const dto = await enterpriseRequestService.create(admin, organizationId, {
      cardsPerDay: 40,
      parallelAgents: 8,
      agentPath: 'both',
      autonomy: 'autonomous_lead',
      startWhen: 'within_quarter',
      teamSize: 'size_51_200',
      contact: '  sales-contact@acme.test  ',
      note: '  Call us.  ',
    });

    expect(dto).toMatchObject({
      cardsPerDay: 40,
      parallelAgents: 8,
      agentPath: 'both',
      autonomy: 'autonomous_lead',
      startWhen: 'within_quarter',
      teamSize: 'size_51_200',
      contact: 'sales-contact@acme.test',
      note: 'Call us.',
    });
  });

  it('defaults a blank or null contact to the sender email', async () => {
    const { organizationId, owner } = await makeOrg();
    const dto = await enterpriseRequestService.create(owner, organizationId, {
      contact: '   ',
      note: 'x',
    });
    expect(dto.contact).toBe(owner.email);
  });

  it.each([
    [{}, 'note'],
    [{ note: '   ' }, 'note'],
    [{ note: 'x'.repeat(4001) }, 'note'],
    [{ note: 'x', cardsPerDay: 0 }, 'cardsPerDay'],
    [{ note: 'x', cardsPerDay: 2.5 }, 'cardsPerDay'],
    [{ note: 'x', parallelAgents: 10_001 }, 'parallelAgents'],
    [{ note: 'x', agentPath: 'robots' }, 'agentPath'],
    [{ note: 'x', autonomy: 'always' }, 'autonomy'],
    [{ note: 'x', startWhen: 'tomorrow' }, 'startWhen'],
    [{ note: 'x', teamSize: '5' }, 'teamSize'],
    [{ note: 'x', price: 100 }, 'body'],
    [null, 'body'],
  ])('refuses %j naming %s, and writes nothing', async (body, field) => {
    const { organizationId, owner } = await makeOrg();
    const err = await enterpriseRequestService.create(owner, organizationId, body).catch((e) => e);
    expect(err).toBeInstanceOf(EnterpriseRequestValidationError);
    expect((err as EnterpriseRequestValidationError).field).toBe(field);
    expect(await rowsOf(organizationId)).toHaveLength(0);
  });

  it('refuses a plain member with the billing surface permission error', async () => {
    const { organizationId, member } = await makeOrg();
    await expect(
      enterpriseRequestService.create(member, organizationId, { note: 'x' }),
    ).rejects.toBeInstanceOf(BillingForbiddenError);
    expect(await rowsOf(organizationId)).toHaveLength(0);
  });

  it('hides the org from a non-member (404, the no-leak rule)', async () => {
    const { organizationId } = await makeOrg();
    const stranger = await createTestUser();
    await expect(
      enterpriseRequestService.create(
        { userId: stranger.id, email: stranger.email },
        organizationId,
        {
          note: 'x',
        },
      ),
    ).rejects.toBeInstanceOf(OrganizationNotFoundError);
  });

  it('is unavailable off-cloud', async () => {
    const { organizationId, owner } = await makeOrg();
    delete process.env['MOTIR_CLOUD'];
    await expect(
      enterpriseRequestService.create(owner, organizationId, { note: 'x' }),
    ).rejects.toBeInstanceOf(BillingNotAvailableError);
    await expect(enterpriseRequestService.getOpen(owner, organizationId)).rejects.toBeInstanceOf(
      BillingNotAvailableError,
    );
  });

  it('refuses while the organization is closing', async () => {
    const { organizationId, owner } = await makeOrg();
    await adminDb.organization.update({
      where: { id: organizationId },
      data: { closingSince: new Date() },
    });
    await expect(
      enterpriseRequestService.create(owner, organizationId, { note: 'x' }),
    ).rejects.toBeInstanceOf(OrganizationClosingError);
  });

  it('refuses a second request while one is open, naming the open one', async () => {
    const { organizationId, owner, admin } = await makeOrg();
    const first = await enterpriseRequestService.create(owner, organizationId, { note: 'one' });

    const err = await enterpriseRequestService
      .create(admin, organizationId, { note: 'two' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(EnterpriseRequestOpenError);
    expect((err as EnterpriseRequestOpenError).openRequestId).toBe(first.id);
    expect(await rowsOf(organizationId)).toHaveLength(1);
  });

  it.each(['contacted', 'offer_sent'] as const)(
    'still refuses while the open request is %s',
    async (status) => {
      const { organizationId, owner } = await makeOrg();
      const first = await enterpriseRequestService.create(owner, organizationId, { note: 'one' });
      await adminDb.enterpriseRequest.update({ where: { id: first.id }, data: { status } });
      await expect(
        enterpriseRequestService.create(owner, organizationId, { note: 'two' }),
      ).rejects.toBeInstanceOf(EnterpriseRequestOpenError);
    },
  );

  it.each(['won', 'lost'] as const)(
    'accepts a new request once the open one is %s',
    async (status) => {
      const { organizationId, owner } = await makeOrg();
      const first = await enterpriseRequestService.create(owner, organizationId, { note: 'one' });
      await adminDb.enterpriseRequest.update({
        where: { id: first.id },
        data: { status, closedAt: new Date() },
      });

      const second = await enterpriseRequestService.create(owner, organizationId, { note: 'two' });
      expect(second.id).not.toBe(first.id);
      expect((await rowsOf(organizationId)).map((r) => r.status)).toEqual([status, 'new']);
    },
  );

  it('two concurrent sends for one org produce exactly ONE row; the loser is told which', async () => {
    const { organizationId, owner, admin } = await makeOrg();
    // A cold pool serialises the racers and the test passes regardless; warm it
    // so the partial unique index is the only thing separating the two sends.
    await warmPool();

    const outcomes = await Promise.allSettled([
      enterpriseRequestService.create(owner, organizationId, { note: 'tab one' }),
      enterpriseRequestService.create(admin, organizationId, { note: 'tab two' }),
    ]);

    const fulfilled = outcomes.filter(
      (
        o,
      ): o is PromiseFulfilledResult<Awaited<ReturnType<typeof enterpriseRequestService.create>>> =>
        o.status === 'fulfilled',
    );
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const reason = rejected[0]!.reason as Error;
    expect(reason).toBeInstanceOf(EnterpriseRequestOpenError);
    expect(reason.constructor.name).not.toBe('PrismaClientKnownRequestError');
    expect((reason as EnterpriseRequestOpenError).openRequestId).toBe(fulfilled[0]!.value.id);

    const rows = await rowsOf(organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(fulfilled[0]!.value.id);
  });
});

describe('enterpriseRequestService.getOpen', () => {
  it('returns null when nothing is open, then the open request in the org words', async () => {
    const { organizationId, owner, admin } = await makeOrg();
    expect(await enterpriseRequestService.getOpen(owner, organizationId)).toBeNull();

    const sent = await enterpriseRequestService.create(owner, organizationId, { note: 'x' });
    expect(await enterpriseRequestService.getOpen(admin, organizationId)).toEqual(sent);

    await adminDb.enterpriseRequest.update({
      where: { id: sent.id },
      data: { status: 'contacted' },
    });
    expect((await enterpriseRequestService.getOpen(owner, organizationId))?.status).toBe(
      'in_conversation',
    );
    await adminDb.enterpriseRequest.update({
      where: { id: sent.id },
      data: { status: 'offer_sent' },
    });
    expect((await enterpriseRequestService.getOpen(owner, organizationId))?.status).toBe(
      'offer_sent',
    );
    await adminDb.enterpriseRequest.update({ where: { id: sent.id }, data: { status: 'won' } });
    expect(await enterpriseRequestService.getOpen(owner, organizationId)).toBeNull();
  });

  it('refuses a plain member', async () => {
    const { organizationId, member } = await makeOrg();
    await expect(enterpriseRequestService.getOpen(member, organizationId)).rejects.toBeInstanceOf(
      BillingForbiddenError,
    );
  });

  it('never shows one org the request of another', async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    await enterpriseRequestService.create(a.owner, a.organizationId, { note: 'a' });
    expect(await enterpriseRequestService.getOpen(b.owner, b.organizationId)).toBeNull();
  });
});

// The read-only half of the Contact-sales form (MOTIR-7607): who sent the open
// request, and the org's connected-repository count, both read on the server.
describe("enterpriseRequestService — the form's read-only facts (MOTIR-7607)", () => {
  it('names the sender on the open request, and the same name on the send', async () => {
    const { organizationId, owner, admin } = await makeOrg();
    await adminDb.user.update({ where: { id: owner.userId }, data: { name: 'Sam Rivera' } });

    const sent = await enterpriseRequestService.create(owner, organizationId, { note: 'x' });
    expect(sent.requestedByName).toBe('Sam Rivera');
    expect((await enterpriseRequestService.getOpen(admin, organizationId))?.requestedByName).toBe(
      'Sam Rivera',
    );

    // The sender's account is gone (SetNull): the request stands, the name does not.
    await adminDb.enterpriseRequest.update({
      where: { id: sent.id },
      data: { requestedById: null },
    });
    expect(
      (await enterpriseRequestService.getOpen(admin, organizationId))?.requestedByName,
    ).toBeNull();
  });

  it("counts the repositories linked across ALL the org's workspaces, and only its own", async () => {
    // The link row lives in a SIBLING workspace of the org (W2), so a count
    // scoped to one workspace would miss it; the control org's link must not
    // be counted at all.
    const fx = await seedSiblingWorkspaceRepo();
    await seedControlOrg();
    const user = await adminDb.user.findUniqueOrThrow({ where: { id: fx.userId } });

    expect(
      await enterpriseRequestService.getFormContext(
        { userId: user.id, email: user.email },
        fx.organizationId,
      ),
    ).toEqual({ repositoryCount: 1 });
  });

  it('is null for a viewer who cannot send, and off-cloud — never a refusal', async () => {
    const { organizationId, owner, member } = await makeOrg();
    expect(await enterpriseRequestService.getFormContext(member, organizationId)).toBeNull();
    expect(await enterpriseRequestService.getFormContext(owner, organizationId)).toEqual({
      repositoryCount: 0,
    });
    delete process.env['MOTIR_CLOUD'];
    expect(await enterpriseRequestService.getFormContext(owner, organizationId)).toBeNull();
  });
});
