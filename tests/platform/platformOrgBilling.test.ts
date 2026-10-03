import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { NotPlatformStaffError, PlatformOrganizationNotFoundError } from '@/lib/platform/errors';

/**
 * The org page's BILLING & PLANS tab (Story MOTIR-727 · MOTIR-7289) —
 * `platformOrgBillingService` over the real database, motir-ai's billing reads
 * faked: one audit row naming the org, read-only by construction, off-cloud
 * disabled, and the TENANT gate unchanged.
 */

let currentPrincipal: PlatformPrincipal | null = null;
const getOrgUsage = vi.fn();
const getOrgSubscription = vi.fn();
const getBillingHistory = vi.fn();

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        if (!currentPrincipal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum))
          throw new NotPlatformStaffError();
        return currentPrincipal;
      },
    ),
  };
});

vi.mock('@/lib/ai/motirAiClient', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/ai/motirAiClient')>('@/lib/ai/motirAiClient');
  return {
    ...actual,
    getOrgUsage: (q: unknown) => getOrgUsage(q),
    getOrgSubscription: (q: unknown) => getOrgSubscription(q),
    getBillingHistory: (q: unknown) => getBillingHistory(q),
  };
});

vi.mock('@/lib/services/ciAllowanceService', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/ciAllowanceService')>(
    '@/lib/services/ciAllowanceService',
  );
  return {
    ...actual,
    ciAllowanceService: {
      ...actual.ciAllowanceService,
      getEntitlementState: vi.fn(async () => ({ chargedCredits: 12 })),
    },
  };
});

const { db } = await import('@/lib/db');
const { platformOrgBillingService } = await import('@/lib/services/platformOrgBillingService');
const { billingService } = await import('@/lib/services/billingService');
const { createTestUser } = await import('../fixtures/userFixtures');
const { createTestWorkspace } = await import('../fixtures/workspaceFixtures');
const { adminDb } = await import('../helpers/adminDb');
const { truncateAuthTables } = await import('../helpers/db');

beforeEach(async () => {
  await adminDb.platformAuditLog.deleteMany();
  await truncateAuthTables();
  const user = await createTestUser({ email: 'ops+billing@moooon.net' });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'support' } });
  currentPrincipal = { userId: user.id, email: user.email, role: 'support' };
  vi.stubEnv('MOTIR_CLOUD', 'true');
  getOrgUsage.mockReset().mockResolvedValue({
    balance: 900,
    tier: { key: 'pro', name: 'Pro', monthlyCreditAllotment: 8000 },
    monthSpend: 0,
    search: { monthSpend: 4, totalSpend: 9 },
    agentMachine: { monthSpend: 10 },
    agentStorage: { monthSpend: 5 },
  });
  getOrgSubscription.mockReset().mockResolvedValue({
    status: 'active',
    currentPeriodEnd: '2026-10-15T00:00:00.000Z',
    priceId: 'pro_pool_monthly',
    planTier: { key: 'pro', name: 'Pro', monthlyCreditAllotment: 8000 },
  });
  getBillingHistory.mockReset().mockResolvedValue({ paymentMethod: null, invoices: [] });
});

afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('platformOrgBillingService.getOrgBilling', () => {
  it('reads another org’s billing — the AI plan, the bill — under ONE estate.read naming the org', async () => {
    const { workspace } = await createTestWorkspace({ name: 'Acme' });
    const orgId = workspace.organizationId;
    const billing = await platformOrgBillingService.getOrgBilling(currentPrincipal!, orgId);
    if (!billing.enabled) throw new Error('expected billing');
    expect(billing.memberCount).toBe(1);
    expect(billing.status!.motirAi.balance).toBe(900);
    expect('access' in billing.status!).toBe(false);
    // The Payment & invoices slot (MOTIR-7304): an org with no Stripe customer.
    expect(billing.billingHistory).toEqual({ state: 'none' });
    expect(getBillingHistory).toHaveBeenCalledWith({ coreOrganizationId: orgId });
    expect(billing.bill!.money).toEqual([
      expect.objectContaining({ key: 'aiPlan', amountCents: 7_500 }),
    ]);
    expect(billing.bill!.credits).toEqual([
      { key: 'ci', credits: 12 },
      { key: 'search', credits: 4 },
      { key: 'agents', credits: 15 },
    ]);
    const audit = await adminDb.platformAuditLog.findMany();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'estate.read',
      targetKind: 'organization',
      targetId: orgId,
      targetLabel: 'billing',
    });
  });

  it('is read-only by construction: one method, and no billing write is reachable', async () => {
    expect(Object.keys(platformOrgBillingService)).toEqual(['getOrgBilling']);
    const writes = [
      'createCheckoutSession',
      'createPortalSession',
      'changeAiPlan',
      'syncScaledTrackerSeatQuantity',
    ].filter((m) => typeof (billingService as Record<string, unknown>)[m] === 'function');
    const spies = writes.map((m) => vi.spyOn(billingService as never, m as never));
    const { workspace } = await createTestWorkspace({ name: 'Acme' });
    await platformOrgBillingService.getOrgBilling(currentPrincipal!, workspace.organizationId);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('Payment & invoices: connected from motir-ai, amounts in integer cents, under the same one audit row', async () => {
    const { workspace } = await createTestWorkspace({ name: 'Acme' });
    const orgId = workspace.organizationId;
    getBillingHistory.mockResolvedValue({
      paymentMethod: { brand: 'visa', last4: '4242', expMonth: 8, expYear: 2028 },
      invoices: [
        {
          id: 'in_2',
          createdAt: '2026-09-01T00:04:11.000Z',
          status: 'paid',
          amountCents: 44_800,
          currency: 'usd',
        },
        {
          id: 'in_1',
          createdAt: '2026-08-31T23:59:59.000Z',
          status: 'open',
          amountCents: 1_999,
          currency: 'usd',
        },
      ],
    });
    const billing = await platformOrgBillingService.getOrgBilling(currentPrincipal!, orgId);
    if (!billing.enabled) throw new Error('expected billing');
    expect(billing.billingHistory).toEqual({
      state: 'connected',
      paymentMethod: { brand: 'visa', last4: '4242', expMonth: 8, expYear: 2028 },
      invoices: [
        { id: 'in_2', month: '2026-09', status: 'paid', amountCents: 44_800, currency: 'usd' },
        { id: 'in_1', month: '2026-08', status: 'open', amountCents: 1_999, currency: 'usd' },
      ],
    });
    const audit = await adminDb.platformAuditLog.findMany();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'estate.read', targetId: orgId });
  });

  it('Payment & invoices: a payment method with no invoice yet is still connected', async () => {
    const { workspace } = await createTestWorkspace({ name: 'Acme' });
    getBillingHistory.mockResolvedValue({
      paymentMethod: { brand: 'visa', last4: '4242', expMonth: 8, expYear: 2028 },
      invoices: [],
    });
    const billing = await platformOrgBillingService.getOrgBilling(
      currentPrincipal!,
      workspace.organizationId,
    );
    if (!billing.enabled) throw new Error('expected billing');
    expect(billing.billingHistory).toMatchObject({ state: 'connected', invoices: [] });
  });

  it('Payment & invoices: motir-ai or Stripe down is unavailable, and the rest of the tab renders', async () => {
    const { workspace } = await createTestWorkspace({ name: 'Acme' });
    getBillingHistory.mockRejectedValue(new Error('down'));
    const billing = await platformOrgBillingService.getOrgBilling(
      currentPrincipal!,
      workspace.organizationId,
    );
    if (!billing.enabled) throw new Error('expected billing');
    expect(billing.billingHistory).toEqual({ state: 'unavailable' });
    expect(billing.status!.motirAi.balance).toBe(900);
    expect(billing.bill).not.toBeNull();
    expect(await adminDb.platformAuditLog.count()).toBe(1);
  });

  it('billing reads down: the tab says so while the org renders', async () => {
    const { workspace } = await createTestWorkspace({ name: 'Acme' });
    getOrgUsage.mockRejectedValue(new Error('down'));
    const billing = await platformOrgBillingService.getOrgBilling(
      currentPrincipal!,
      workspace.organizationId,
    );
    expect(billing).toMatchObject({
      enabled: true,
      status: null,
      bill: null,
      organization: { name: 'Acme' },
    });
  });

  it('off-cloud the tab says billing is not enabled — and asks nothing', async () => {
    vi.stubEnv('MOTIR_CLOUD', 'false');
    const { workspace } = await createTestWorkspace({ name: 'Acme' });
    const billing = await platformOrgBillingService.getOrgBilling(
      currentPrincipal!,
      workspace.organizationId,
    );
    expect(billing.enabled).toBe(false);
    expect(getOrgUsage).not.toHaveBeenCalled();
    expect(getBillingHistory).not.toHaveBeenCalled();
  });

  it('an unknown org throws inside the read — no audit row — and a non-staff caller is refused', async () => {
    await expect(
      platformOrgBillingService.getOrgBilling(currentPrincipal!, 'org_nope'),
    ).rejects.toBeInstanceOf(PlatformOrganizationNotFoundError);
    expect(await adminDb.platformAuditLog.count()).toBe(0);
    const principal = currentPrincipal!;
    currentPrincipal = null;
    await expect(
      platformOrgBillingService.getOrgBilling(principal, 'org_x'),
    ).rejects.toBeInstanceOf(NotPlatformStaffError);
  });
});

describe('the TENANT billing gate is unchanged', () => {
  it('still refuses a member of another org', async () => {
    const theirs = await createTestWorkspace({ name: 'Theirs' });
    const outsider = await createTestUser({ email: 'outsider@example.com' });
    await expect(
      billingService.getBillingStatus({
        organizationId: theirs.workspace.organizationId,
        actorUserId: outsider.id,
      }),
    ).rejects.toThrow();
    expect(getOrgUsage).not.toHaveBeenCalled();
  });
});
