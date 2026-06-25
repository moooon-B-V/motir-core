import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { RawSubscriptionResponse, RawUsageResponse } from '@/lib/ai/types';

// ─────────────────────────────────────────────────────────────────────────────
// Subtask 8.1.9 (MOTIR-1151) — the billing-boundary DTO key-drift SEAM guard.
//
// This is the one piece of 8.1 test coverage no per-subtask test exercises. The
// 8.1.6 service suite (billingService.test.ts) MOCKS @/lib/ai/motirAiClient with
// a hand-shaped object, and motirAiClient reads the wire body via an UNCHECKED
// `as RawUsageResponse` / `as RawSubscriptionResponse` cast (no zod, no runtime
// validation — see lib/ai/motirAiClient.ts getOrgUsage/getOrgSubscription). So a
// field rename on EITHER side of the open-core boundary is caught by NOBODY:
// motir-ai keeps serializing, motir-core keeps reading `undefined`, every
// existing test stays green, production silently breaks.
//
// This guard reads motir-ai's REAL writer output back through motir-core's
// consumer (billingService's DTO mapping), the integration-seam-catches-DTO-drift
// pattern. It bites in two layers:
//
//   (1) COMPILE-TIME — the contract fixtures below are typed as motir-core's
//       consumer types (RawUsageResponse / RawSubscriptionResponse) but written
//       to mirror motir-ai's ACTUAL producer DTOs field-for-field
//       (usageService.UsageResponseDto / stripeBillingService.SubscriptionDto).
//       If either side renames/removes a field, `pnpm build` (tsc) fails here —
//       whoever edits the motir-ai DTO must update this motir-core-side mirror.
//
//   (2) RUNTIME — the round-trip tests drive the REAL billingService mapping
//       with the boundary returning the contract fixture, asserting every
//       CONSUMED field maps correctly; the "the guard bites" tests then drift a
//       consumed key and prove the DTO field breaks (no silent fallback), so the
//       round-trip assertions are demonstrably drift-sensitive — the same shape
//       as motir-ai/tests/contract.test.ts's "drift simulation (the guard must
//       bite)" describe.
//
// notes.html #90 (this card's own re-plan): the per-subtask floors already cover
// the webhook/checkout/portal/gate matrix; the seam is the only residue.
// ─────────────────────────────────────────────────────────────────────────────

const getOrgUsageMock = vi.fn<(q: unknown) => Promise<RawUsageResponse>>();
const getOrgSubscriptionMock = vi.fn<(q: unknown) => Promise<RawSubscriptionResponse>>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  getOrgUsage: (q: unknown) => getOrgUsageMock(q),
  getOrgSubscription: (q: unknown) => getOrgSubscriptionMock(q),
  // billingService also imports these from the client module; stub them so the
  // module shape is intact (they are not exercised by this seam guard).
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
}));
// Silence the post-commit seat-sync enqueue that org-membership writes fire under
// MOTIR_CLOUD (8.1.12); the wiring is covered in billing-seat-sync.test.ts.
vi.mock('@/lib/billing/seatSync', () => ({
  enqueueScaledTrackerSeatSync: vi.fn(),
}));

const { billingService } = await import('@/lib/services/billingService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { createTestUser } = await import('./fixtures/userFixtures');
const { truncateAuthTables } = await import('./helpers/db');

// ── The CONTRACT fixtures — motir-ai's REAL wire shapes, pinned ──────────────
// Source of truth: motir-ai/src/services/usageService.ts:46 (UsageResponseDto)
// and motir-ai/src/services/stripeBillingService.ts:144 (SubscriptionDto). These
// MUST be updated in lockstep with those DTOs (the contract); the type annotation
// makes a motir-core-side drift a compile error, this file makes a motir-ai-side
// drift a review-forcing fixture edit.

// A paid (Pro) org, fully populated incl. the nested recentRuns/perModel shapes.
const USAGE_CONTRACT: RawUsageResponse = {
  scope: 'org',
  coreOrganizationId: 'org_contract', // motir-ai echoes the query's id; the consumer ignores it
  coreWorkspaceId: null,
  coreProjectId: null,
  balance: 1420,
  tier: { key: 'pro', name: 'Pro', monthlyCreditAllotment: 8000 },
  totalSpend: 6580,
  monthSpend: 120,
  monthlyHistory: [{ yearMonth: '2026-06', credits: 120 }],
  perModel: [{ model: 'claude-opus-4-8', inputTokens: 1000, outputTokens: 500, credits: 120 }],
  recentRuns: {
    runs: [
      {
        jobId: 'job_1',
        jobKind: 'plan_generation',
        model: 'claude-opus-4-8',
        coreWorkspaceId: 'ws_1',
        coreProjectId: 'pj_1',
        inputTokens: 1000,
        outputTokens: 500,
        credits: 120,
        startedAt: '2026-06-20T00:00:00.000Z',
      },
    ],
    page: 1,
    pageSize: 10,
    total: 1,
  },
};

const SUBSCRIPTION_CONTRACT: RawSubscriptionResponse = {
  status: 'active',
  currentPeriodEnd: '2026-07-22T00:00:00.000Z',
  priceId: 'pro_pool_monthly',
  planTier: { key: 'pro', name: 'Pro', monthlyCreditAllotment: 8000 },
};

// The EMPTY shape a free / never-transacted org resolves to (NOT a 404 — see the
// motir-ai EMPTY_SUBSCRIPTION + usageService.emptyResponse). Part of the contract.
const USAGE_FREE_CONTRACT: RawUsageResponse = {
  ...USAGE_CONTRACT,
  balance: 300,
  tier: { key: 'free', name: 'Free', monthlyCreditAllotment: 300 },
  totalSpend: 0,
  monthSpend: 0,
  monthlyHistory: [],
  perModel: [],
  recentRuns: { runs: [], page: 1, pageSize: 10, total: 0 },
};
const SUBSCRIPTION_EMPTY_CONTRACT: RawSubscriptionResponse = {
  status: null,
  currentPeriodEnd: null,
  priceId: null,
  planTier: null,
};

// An org with an owner (admin enough for the getBillingStatus VIEW gate, and any
// member passes the getAiAccess membership gate).
async function makeOrg() {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  const organizationId = (await db.workspace.findUniqueOrThrow({ where: { id: workspace.id } }))
    .organizationId;
  return { organizationId, owner };
}

beforeEach(async () => {
  await truncateAuthTables();
  getOrgUsageMock.mockReset();
  getOrgSubscriptionMock.mockReset();
  getOrgUsageMock.mockResolvedValue(USAGE_CONTRACT);
  getOrgSubscriptionMock.mockResolvedValue(SUBSCRIPTION_CONTRACT);
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['BETTER_AUTH_URL'] = 'https://app.test';
});

afterEach(() => {
  delete process.env['MOTIR_CLOUD'];
  delete process.env['BETTER_AUTH_URL'];
});

afterAll(async () => {
  await db.$disconnect();
});

describe('billing boundary contract — getBillingStatus consumes motir-ai usage+subscription', () => {
  it('maps every consumed field from the real wire shape into BillingStatusDTO.motirAi', async () => {
    const { organizationId, owner } = await makeOrg();

    const res = await billingService.getBillingStatus({ organizationId, actorUserId: owner.id });

    // The consumer reads usage.balance, usage.tier, and the WHOLE subscription
    // object straight off the wire (billingService.getBillingStatus). Deep-equal
    // each so a renamed/dropped key on either side fails here.
    expect(res.motirAi.balance).toBe(USAGE_CONTRACT.balance);
    expect(res.motirAi.tier).toEqual(USAGE_CONTRACT.tier);
    expect(res.motirAi.subscription).toEqual(SUBSCRIPTION_CONTRACT);
  });

  it('the guard bites — a motir-ai usage `balance` rename corrupts the DTO (round-trip is drift-sensitive)', async () => {
    const { organizationId, owner } = await makeOrg();
    // Simulate motir-ai renaming usage.balance → usage.credits (the unchecked
    // `as` cast at the boundary lets the off-contract body through).
    getOrgUsageMock.mockResolvedValue({
      ...USAGE_CONTRACT,
      balance: undefined,
      credits: 1420,
    } as unknown as RawUsageResponse);

    const res = await billingService.getBillingStatus({ organizationId, actorUserId: owner.id });

    // The consumer has no fallback — a silent rename surfaces as an undefined DTO
    // field, which is exactly what the contract pin + the round-trip above catch.
    expect(res.motirAi.balance).toBeUndefined();
    expect(res.motirAi.balance).not.toBe(1420);
  });
});

describe('billing boundary contract — getAiAccess folds usage tier/balance + subscription lifecycle', () => {
  it('maps a paid (active) subscription into the entitlement DTO', async () => {
    const { organizationId, owner } = await makeOrg();

    const access = await billingService.getAiAccess({ organizationId, actorUserId: owner.id });

    expect(access.applicable).toBe(true);
    expect(access.balance).toBe(USAGE_CONTRACT.balance);
    expect(access.tierName).toBe(USAGE_CONTRACT.tier?.name);
    expect(access.tierAllotment).toBe(USAGE_CONTRACT.tier?.monthlyCreditAllotment);
    expect(access.hasPaidAiPlan).toBe(true); // status 'active' ∈ PAID_AI_SUBSCRIPTION_STATUSES
    expect(access.renewsAt).toBe(SUBSCRIPTION_CONTRACT.currentPeriodEnd);
  });

  it('maps the EMPTY (free / never-transacted) wire shape — null tier, no paid plan', async () => {
    const { organizationId, owner } = await makeOrg();
    getOrgUsageMock.mockResolvedValue(USAGE_FREE_CONTRACT);
    getOrgSubscriptionMock.mockResolvedValue(SUBSCRIPTION_EMPTY_CONTRACT);

    const access = await billingService.getAiAccess({ organizationId, actorUserId: owner.id });

    expect(access.balance).toBe(USAGE_FREE_CONTRACT.balance);
    expect(access.tierName).toBe('Free');
    expect(access.tierAllotment).toBe(300);
    expect(access.hasPaidAiPlan).toBe(false); // status null → not paid
    expect(access.renewsAt).toBeNull();
  });

  it('the guard bites — a tier `monthlyCreditAllotment` rename drops tierAllotment', async () => {
    const { organizationId, owner } = await makeOrg();
    // motir-ai renames tier.monthlyCreditAllotment → tier.allotment.
    getOrgUsageMock.mockResolvedValue({
      ...USAGE_CONTRACT,
      tier: { key: 'pro', name: 'Pro', allotment: 8000 },
    } as unknown as RawUsageResponse);

    const access = await billingService.getAiAccess({ organizationId, actorUserId: owner.id });

    // The consumer reads tier.monthlyCreditAllotment; under the rename it is null.
    expect(access.tierAllotment).toBeNull();
  });

  it('the guard bites — a subscription `currentPeriodEnd` rename drops renewsAt', async () => {
    const { organizationId, owner } = await makeOrg();
    // motir-ai renames subscription.currentPeriodEnd → subscription.periodEnd.
    getOrgSubscriptionMock.mockResolvedValue({
      status: 'active',
      periodEnd: '2026-07-22T00:00:00.000Z',
      priceId: 'pro_pool_monthly',
      planTier: null,
    } as unknown as RawSubscriptionResponse);

    const access = await billingService.getAiAccess({ organizationId, actorUserId: owner.id });

    // The consumer reads subscription.currentPeriodEnd; under the rename it is undefined.
    expect(access.renewsAt).toBeUndefined();
  });
});
