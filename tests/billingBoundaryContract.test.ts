import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { RawSubscriptionResponse, RawUsageResponse } from '@/lib/ai/types';
import type {
  CalculatorCategoriesDTO,
  CalculatorEmptyCategoryDTO,
  CalculatorEstimateDTO,
} from '@/lib/dto/billing';
import { adminDb } from './helpers/adminDb';

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
// The REAL client underneath (MOTIR-8637): the calculator reads below go through
// its shape validation with `fetch` stubbed, so the seam guarded there is the one
// that ships. Only the reads this file fakes at the module level are replaced.
vi.mock('@/lib/ai/motirAiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/motirAiClient')>()),
  getOrgUsage: (q: unknown) => getOrgUsageMock(q),
  getOrgSubscription: (q: unknown) => getOrgSubscriptionMock(q),
  getPendingPlanChange: async () => ({ pendingDowngrade: null }),
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
  // ⚠️ The two SEARCH blocks (MOTIR-4552 producer / MOTIR-4555 consumer).
  // motir-ai sends both on EVERY response — `usageService.UsageResponseDto`
  // declares them non-optional — so they belong in this mirror like every other
  // field. They are optional on `RawUsageResponse` for one reason: a ROLLING
  // DEPLOY, where motir-core has shipped and the motir-ai half has not.
  //
  // ⚠️ SO LAYER (1) — the compile-time bite — DOES NOT COVER THESE TWO. An
  // optional field cannot make an omission a tsc error. Layer (2) still does:
  // the round-trip test below reads them through the real mapping, so a
  // producer-side rename turns the assertion red rather than silent.
  search: { totalSpend: 40, monthSpend: 12 },
  searchRuns: {
    runs: [{ jobId: 'job_1', credits: 9, lastSearchAt: '2026-06-20T00:05:00.000Z' }],
    page: 1,
    pageSize: 10,
    total: 1,
    attributedSpend: 31,
    unattributedSpend: 9,
  },
  // The agent blocks (MOTIR-6915 producer / MOTIR-6920 consumer) — optional on
  // the mirror for the same rolling-deploy reason as `search`.
  agentMachine: { totalSpend: 3000, monthSpend: 1240 },
  agentStorage: { totalSpend: 2000, monthSpend: 900 },
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
  // Zero SPEND, blocks PRESENT — the never-transacted org. Distinct from the
  // absent-block case below, which is a rolling deploy rather than a customer.
  search: { totalSpend: 0, monthSpend: 0 },
  searchRuns: {
    runs: [],
    page: 1,
    pageSize: 10,
    total: 0,
    attributedSpend: 0,
    unattributedSpend: 0,
  },
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
  const organizationId = (
    await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } })
  ).organizationId;
  return { organizationId, owner };
}

beforeEach(async () => {
  await truncateAuthTables();
  getOrgUsageMock.mockReset();
  getOrgSubscriptionMock.mockReset();
  getOrgUsageMock.mockResolvedValue(USAGE_CONTRACT);
  getOrgSubscriptionMock.mockResolvedValue(SUBSCRIPTION_CONTRACT);
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

  it('maps the SEARCH block off the same wire response (MOTIR-4555)', async () => {
    const { organizationId, owner } = await makeOrg();

    const res = await billingService.getBillingStatus({ organizationId, actorUserId: owner.id });

    // The fourth billed line rides the getOrgUsage call `motirAi` above already
    // makes — one read, four lines.
    expect(res.search).toEqual(USAGE_CONTRACT.search);
  });

  it('the guard bites — a motir-ai `search` rename reads as UNAVAILABLE, never as zero', async () => {
    const { organizationId, owner } = await makeOrg();
    getOrgUsageMock.mockResolvedValue({
      ...USAGE_CONTRACT,
      search: undefined,
      searchSpend: { totalSpend: 40, monthSpend: 12 },
    } as unknown as RawUsageResponse);

    const res = await billingService.getBillingStatus({ organizationId, actorUserId: owner.id });

    // ⚠️ THE DIRECTION OF THE FALLBACK IS THE WHOLE POINT. A renamed or absent
    // block must degrade to `null` — figures UNAVAILABLE — and never to a
    // populated zero, which would tell a customer they spent nothing on search
    // on a boundary that never answered. Same shape as the `balance` bite above:
    // no silent fallback, and here the absence is legible rather than plausible.
    expect(res.search).toBeNull();
    expect(res.search).not.toEqual({ totalSpend: 0, monthSpend: 0 });
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

// ── The public calculator (MOTIR-8637) ───────────────────────────────────────
//
// motir-ai's PRODUCER DTOs, copied field for field from
// motir-ai/src/services/calculatorService.ts (CalculatorEstimateDto,
// CalculatorEmptyCategoryDto, CalculatorCategoriesDto) and
// src/billing/calculatorTypes.ts (CalculatorTopUpAmount, CalculatorSplit,
// CalculatorCeiling) at contract version 2 (MOTIR-9002 · MOTIR-9004). The
// two-way assignability below makes a rename on motir-core's side a compile
// error; a rename on motir-ai's side is a review-forcing edit of this mirror.

type EngineLane = 'planning' | 'running';
type EngineCadence = 'annual' | 'monthly';
interface EngineTopUpAmount {
  units: number;
  credits: number;
  priceUsd: number;
}
interface EngineEstimateDto {
  version: number;
  kind: 'estimate';
  profilesVersion: string;
  categoryRuleVersion: string;
  cadence: EngineCadence;
  plannedPerMonth: { low: number; high: number };
  runPerMonth: { low: number; high: number };
  credits: { low: number; high: number };
  perItemCredits: Record<EngineLane, number>;
  split: { count: number; categories: { key: string; weight: number; models: string[] }[] };
  recommendation: { planKey: string | null; planName: string | null; monthlyPriceUsd: number };
  topUp: { low: EngineTopUpAmount; high: EngineTopUpAmount };
  ceiling: {
    credits: number | null;
    exceeded: boolean;
    excessCredits: number;
    outcome: 'within_ladder' | 'larger_pool' | 'largest_pool' | 'top_ups_only';
  };
}
interface EngineEmptyCategoryDto {
  version: number;
  kind: 'empty_category';
  categoryRuleVersion: string;
  categories: string[];
}
interface EngineCategoriesDto {
  version: number;
  categoryRuleVersion: string;
  modelsReadAt: string;
  cadences: EngineCadence[];
  defaultCadence: EngineCadence;
  categories: { key: string; models: { id: string; provider: string }[] }[];
}

// Exact, both ways: an extra, missing or renamed key on either side fails tsc.
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const ESTIMATE_MIRROR: Exact<EngineEstimateDto, CalculatorEstimateDTO> = true;
const EMPTY_MIRROR: Exact<EngineEmptyCategoryDto, CalculatorEmptyCategoryDTO> = true;
const CATEGORIES_MIRROR: Exact<EngineCategoriesDto, CalculatorCategoriesDTO> = true;

const ESTIMATE_CONTRACT: EngineEstimateDto = {
  version: 2,
  kind: 'estimate',
  profilesVersion: 'profiles-contract',
  categoryRuleVersion: 'rule-contract',
  cadence: 'annual',
  plannedPerMonth: { low: 10, high: 40 },
  runPerMonth: { low: 10, high: 40 },
  credits: { low: 300, high: 2400 },
  perItemCredits: { planning: 10, running: 20 },
  split: {
    count: 2,
    categories: [
      { key: 'band-1', weight: 0.5, models: ['p-1'] },
      { key: 'band-2', weight: 0.5, models: ['r-1', 'r-2'] },
    ],
  },
  recommendation: { planKey: 'key-contract', planName: 'Name Contract', monthlyPriceUsd: 7 },
  topUp: {
    low: { units: 0, credits: 0, priceUsd: 0 },
    high: { units: 1, credits: 1000, priceUsd: 5 },
  },
  ceiling: { credits: 4000, exceeded: false, excessCredits: 0, outcome: 'within_ladder' },
};

const EMPTY_CONTRACT: EngineEmptyCategoryDto = {
  version: 2,
  kind: 'empty_category',
  categoryRuleVersion: 'rule-contract',
  categories: ['band-2'],
};

const CATEGORIES_CONTRACT: EngineCategoriesDto = {
  version: 2,
  categoryRuleVersion: 'rule-contract',
  modelsReadAt: '2026-10-15T00:00:00.000Z',
  cadences: ['annual', 'monthly'],
  defaultCadence: 'annual',
  categories: [
    { key: 'band-1', models: [{ id: 'p-1', provider: 'prov' }] },
    { key: 'band-2', models: [] },
  ],
};

const CALCULATOR_REQUEST = {
  plannedPerMonth: { low: 10, high: 40 },
  runPerMonth: { low: 10, high: 40 },
  categories: ['band-1', 'band-2'],
  cadence: 'annual' as const,
};

describe('billing boundary contract — the public calculator through the real client', () => {
  const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();
  function answer(status: number, body: unknown): void {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    process.env['MOTIR_AI_URL'] = 'http://motir-ai.contract';
    process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env['MOTIR_AI_URL'];
    delete process.env['MOTIR_AI_SERVICE_TOKEN'];
  });

  it('the producer DTOs and motir-core’s consumer DTOs are the same shape', () => {
    expect([ESTIMATE_MIRROR, EMPTY_MIRROR, CATEGORIES_MIRROR]).toEqual([true, true, true]);
  });

  it('round-trips an estimate, an empty_category and the categories key for key', async () => {
    const { organizationId, owner } = await makeOrg();
    const actor = { organizationId, actorUserId: owner.id };

    answer(200, ESTIMATE_CONTRACT);
    await expect(
      billingService.estimateCalculator({ ...actor, body: CALCULATOR_REQUEST }),
    ).resolves.toStrictEqual(ESTIMATE_CONTRACT);
    answer(200, EMPTY_CONTRACT);
    await expect(
      billingService.estimateCalculator({ ...actor, body: CALCULATOR_REQUEST }),
    ).resolves.toStrictEqual(EMPTY_CONTRACT);
    answer(200, CATEGORIES_CONTRACT);
    await expect(billingService.getCalculatorCategories(actor)).resolves.toStrictEqual(
      CATEGORIES_CONTRACT,
    );
  });

  it('the request is the engine’s four keys and nothing else', async () => {
    const { organizationId, owner } = await makeOrg();
    answer(200, ESTIMATE_CONTRACT);
    await billingService.estimateCalculator({
      organizationId,
      actorUserId: owner.id,
      body: CALCULATOR_REQUEST,
    });
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual([
      'cadence',
      'categories',
      'plannedPerMonth',
      'runPerMonth',
    ]);
  });

  it('the strict-key refusal: an unknown key is refused by name and never sent', async () => {
    const { organizationId, owner } = await makeOrg();
    await expect(
      billingService.estimateCalculator({
        organizationId,
        actorUserId: owner.id,
        body: { ...CALCULATOR_REQUEST, quantity: 2 },
      }),
    ).rejects.toMatchObject({ code: 'CALCULATOR_REQUEST_INVALID', field: 'quantity' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the `calculator_unavailable:` detail is recognised as the engine’s own answer', async () => {
    const { organizationId, owner } = await makeOrg();
    answer(500, {
      type: 'about:blank',
      title: 'Internal error',
      status: 500,
      code: 'internal_error',
      detail: 'calculator_unavailable: catalog',
    });
    await expect(
      billingService.estimateCalculator({
        organizationId,
        actorUserId: owner.id,
        body: CALCULATOR_REQUEST,
      }),
    ).rejects.toMatchObject({ code: 'CALCULATOR_UNAVAILABLE' });
  });

  it('the guard bites — a `ceiling.excessCredits` rename is refused, never half-read', async () => {
    const { organizationId, owner } = await makeOrg();
    // motir-ai renames ceiling.excessCredits → ceiling.excess.
    answer(200, {
      ...ESTIMATE_CONTRACT,
      ceiling: { credits: 4000, exceeded: false, excess: 0, outcome: 'within_ladder' },
    });
    await expect(
      billingService.estimateCalculator({
        organizationId,
        actorUserId: owner.id,
        body: CALCULATOR_REQUEST,
      }),
    ).rejects.toMatchObject({ code: 'MOTIR_AI_UNAVAILABLE' });
  });

  it('the guard bites — a categories `models[].provider` rename is refused', async () => {
    const { organizationId, owner } = await makeOrg();
    answer(200, {
      ...CATEGORIES_CONTRACT,
      categories: [{ key: 'band-1', models: [{ id: 'p-1', vendor: 'prov' }] }],
    });
    await expect(
      billingService.getCalculatorCategories({ organizationId, actorUserId: owner.id }),
    ).rejects.toMatchObject({ code: 'MOTIR_AI_UNAVAILABLE' });
  });
});
