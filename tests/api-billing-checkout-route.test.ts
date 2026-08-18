import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from './helpers/adminDb';

// Transport tests for POST /api/organizations/[orgId]/billing/checkout — the
// Stripe Checkout entry (Subtask 8.1.6), extended by MOTIR-2949 to carry the
// credit top-up's bundle QUANTITY. The COMPANION service test
// (`billingService.test.ts`) proves the cloud gate, the OWNER-only gate, the
// catalog allow-list and which prices may be multiplied; this file proves the
// things only the ROUTE owns and that the service test cannot reach:
//   - the session gate (401 before any service call),
//   - the body parsers — `priceLookupKey` required, `quantity` optional but a
//     positive INTEGER when present, both refused in the same 400 shape,
//   - that an absent `quantity` is NOT forwarded as null/NaN (the service, not
//     the wire, owns the default),
//   - the typed-error → HTTP mapping for the quantity guard (400, distinct from
//     the OWNER gate's 403).
// Real Postgres for the org/membership seed (the no-mocks rule); the two
// sanctioned boundary mocks are `getSession` (no cookie in the test env) and the
// motir-ai HTTP client leaf (an external network call).

const session = { current: null as { user: { id: string; email: string } } | null };
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));

const createCheckoutSessionMock = vi.fn<(i: unknown) => Promise<{ url: string }>>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  createCheckoutSession: (i: unknown) => createCheckoutSessionMock(i),
  createPortalSession: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  setSeatQuantity: vi.fn(),
}));
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

// Import the handler AFTER the mocks are registered.
const { POST } = await import('@/app/api/organizations/[orgId]/billing/checkout/route');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { organizationsService } = await import('@/lib/services/organizationsService');
const { createTestUser } = await import('./fixtures/userFixtures');
const { truncateAuthTables } = await import('./helpers/db');

const APP_ORIGIN = 'https://app.test';

function checkoutReq(orgId: string, body: unknown) {
  return {
    req: new Request(`http://localhost:3000/api/organizations/${orgId}/billing/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ orgId }) },
  };
}

function signInAs(user: { id: string; email: string }) {
  session.current = { user: { id: user.id, email: user.email } };
}

async function makeOrgWithRoles() {
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
  return { organizationId, owner, admin };
}

beforeEach(async () => {
  await truncateAuthTables();
  session.current = null;
  createCheckoutSessionMock.mockReset();
  createCheckoutSessionMock.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_BASE_URL'] = APP_ORIGIN;
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_BASE_URL'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('POST /api/organizations/[orgId]/billing/checkout', () => {
  it('401 when signed out — no service / motir-ai call', async () => {
    const { req, ctx } = checkoutReq('any-org', { priceLookupKey: 'credit_topup' });
    const res = await POST(req, ctx);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ code: 'UNAUTHENTICATED' });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('400 INVALID_REQUEST when priceLookupKey is missing', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    signInAs(owner);

    const { req, ctx } = checkoutReq(organizationId, { quantity: 5 });
    const res = await POST(req, ctx);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: 'INVALID_REQUEST',
      error: 'priceLookupKey is required',
    });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('200 — forwards the selected bundle QUANTITY to the boundary (MOTIR-2949)', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    signInAs(owner);

    const { req, ctx } = checkoutReq(organizationId, {
      priceLookupKey: 'credit_topup',
      quantity: 10,
    });
    const res = await POST(req, ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ priceId: 'credit_topup', quantity: 10 }),
    );
  });

  it('200 — an ABSENT quantity reaches the boundary as the service default of 1, never null', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    signInAs(owner);

    const { req, ctx } = checkoutReq(organizationId, { priceLookupKey: 'credit_topup' });
    const res = await POST(req, ctx);

    expect(res.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ priceId: 'credit_topup', quantity: 1 }),
    );
  });

  it('400 INVALID_REQUEST for a non-integer / zero / negative / non-numeric quantity', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    signInAs(owner);

    for (const quantity of [1.5, 0, -3, '10', true]) {
      const { req, ctx } = checkoutReq(organizationId, {
        priceLookupKey: 'credit_topup',
        quantity,
      });
      const res = await POST(req, ctx);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        code: 'INVALID_REQUEST',
        error: 'quantity must be an integer >= 1 when present',
      });
    }
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('400 BILLING_INVALID_QUANTITY — a well-shaped quantity the catalog will not sell', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    signInAs(owner);

    // Integer >= 1, so the route's shape check passes; the SERVICE refuses it,
    // because a recurring plan is never multiplied from the client.
    const { req, ctx } = checkoutReq(organizationId, {
      priceLookupKey: 'tracker_monthly',
      quantity: 6,
    });
    const res = await POST(req, ctx);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'BILLING_INVALID_QUANTITY' });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('400 INVALID_REQUEST for a body that is not JSON at all', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    signInAs(owner);

    const req = new Request(
      `http://localhost:3000/api/organizations/${organizationId}/billing/checkout`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' },
    );
    const res = await POST(req, { params: Promise.resolve({ orgId: organizationId }) });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: 'INVALID_REQUEST',
      error: 'priceLookupKey is required',
    });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('rethrows an error the billing mapper does not know — a genuine 500 the platform logs', async () => {
    const { organizationId, owner } = await makeOrgWithRoles();
    signInAs(owner);
    createCheckoutSessionMock.mockRejectedValue(new Error('kaboom'));

    const { req, ctx } = checkoutReq(organizationId, { priceLookupKey: 'credit_topup' });
    await expect(POST(req, ctx)).rejects.toThrow('kaboom');
  });

  it('403 for an admin — the OWNER gate runs before the quantity guard', async () => {
    const { organizationId, admin } = await makeOrgWithRoles();
    signInAs(admin);

    const { req, ctx } = checkoutReq(organizationId, {
      priceLookupKey: 'credit_topup',
      quantity: 10,
    });
    const res = await POST(req, ctx);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'BILLING_FORBIDDEN' });
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });
});
