import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { RawUsageResponse } from '@/lib/ai/types';
import { adminDb } from './helpers/adminDb';

// The Agents billing line's read seam (MOTIR-6920): machine and storage credits
// crossing into `BillingStatusDTO.agents` off the ONE `getOrgUsage` call the
// panel already makes, plus whether the org may run agents at all. The boundary
// client is mocked (as `searchReadSeam.test.ts` mocks it); everything else runs
// against the real Postgres.

const getOrgUsageMock = vi.fn<(q: unknown) => Promise<RawUsageResponse>>();
const getOrgSubscriptionMock = vi.fn<(q: unknown) => Promise<unknown>>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  getOrgUsage: (q: unknown) => getOrgUsageMock(q),
  getOrgSubscription: (q: unknown) => getOrgSubscriptionMock(q),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
}));
vi.mock('@/lib/billing/seatSync', () => ({
  enqueueScaledTrackerSeatSync: vi.fn(),
}));

const { billingService } = await import('@/lib/services/billingService');
const { createTestWorkspace } = await import('./fixtures');
const { truncateAuthTables } = await import('./helpers/db');

function rawResponse(over: Partial<RawUsageResponse> = {}): RawUsageResponse {
  return {
    scope: 'org',
    coreOrganizationId: 'o',
    coreWorkspaceId: null,
    coreProjectId: null,
    balance: 12480,
    tier: { key: 'basic', name: 'Basic', monthlyCreditAllotment: 20000 },
    totalSpend: 147520,
    monthSpend: 7520,
    monthlyHistory: [],
    perModel: [],
    recentRuns: { runs: [], page: 1, pageSize: 10, total: 0 },
    search: { totalSpend: 40, monthSpend: 12 },
    searchRuns: {
      runs: [{ jobId: 'job_1', credits: 9, lastSearchAt: '2026-09-01T10:00:00.000Z' }],
      page: 1,
      pageSize: 10,
      total: 1,
      attributedSpend: 31,
      unattributedSpend: 9,
    },
    agentMachine: { totalSpend: 3000, monthSpend: 1240 },
    agentStorage: { totalSpend: 2000, monthSpend: 900 },
    ...over,
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  getOrgUsageMock.mockReset();
  getOrgSubscriptionMock.mockReset();
  getOrgSubscriptionMock.mockResolvedValue({
    status: 'active',
    currentPeriodEnd: '2026-10-01T00:00:00.000Z',
    priceId: 'basic_pool_monthly',
    planTier: { key: 'basic', name: 'Basic', monthlyCreditAllotment: 20000 },
  });
  // The billing panel is CLOUD-gated (`isCloudBilling()`), so the billing half
  // of this seam needs the flag the shipped billing suites set.
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

describe('BillingStatusDTO.agents', () => {
  it("carries this month's machine and storage credits from the existing read", async () => {
    const { workspace, owner } = await createTestWorkspace();
    getOrgUsageMock.mockResolvedValue(rawResponse());

    const res = await billingService.getBillingStatus({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });

    expect(res.agents).toEqual({
      spend: { machineMonthSpend: 1240, storageMonthSpend: 900 },
      hasPaidAiPlan: true,
    });
    expect(getOrgUsageMock).toHaveBeenCalledTimes(1);
  });

  it('reads an absent block as UNAVAILABLE, never as zero', async () => {
    const { workspace, owner } = await createTestWorkspace();
    getOrgUsageMock.mockResolvedValue(rawResponse({ agentStorage: undefined }));

    const res = await billingService.getBillingStatus({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });

    expect(res.agents.spend).toBeNull();
  });

  it('has no paid AI plan without a live subscription', async () => {
    const { workspace, owner } = await createTestWorkspace();
    getOrgUsageMock.mockResolvedValue(rawResponse());
    getOrgSubscriptionMock.mockResolvedValue({
      status: null,
      currentPeriodEnd: null,
      priceId: null,
      planTier: null,
    });

    const res = await billingService.getBillingStatus({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });

    expect(res.agents.hasPaidAiPlan).toBe(false);
  });

  it('counts an internal-billing org as able to run agents (agent-instance-storage.md §5)', async () => {
    const { workspace, owner } = await createTestWorkspace();
    getOrgUsageMock.mockResolvedValue(rawResponse());
    getOrgSubscriptionMock.mockResolvedValue({
      status: null,
      currentPeriodEnd: null,
      priceId: null,
      planTier: null,
    });
    await adminDb.organization.update({
      where: { id: workspace.organizationId },
      data: { internalBilling: true },
    });

    const res = await billingService.getBillingStatus({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });

    expect(res.agents.hasPaidAiPlan).toBe(true);
  });
});
