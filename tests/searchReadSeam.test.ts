import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { RawUsageResponse } from '@/lib/ai/types';
import { adminDb } from './helpers/adminDb';

// THE READ SEAM (MOTIR-4555) — search spend crossing the 7.1 boundary into BOTH
// `OrgUsageDTO` and `BillingStatusDTO`, off the ONE `getOrgUsage` call each
// surface already makes.
//
// The boundary client is an external HTTP leaf and is mocked, as the shipped
// `aiUsageService` / `billingService` suites mock it; everything else runs
// against the real Postgres.
//
// THE ONE THING THIS FILE EXISTS FOR, above the field being carried at all:
// **UNAVAILABLE MUST NOT COLLAPSE INTO ZERO.** motir-ai sends both blocks on
// every response, so the only way they go missing is a ROLLING DEPLOY where the
// motir-ai half has not landed. Defaulting the absent block to zeroes is how a
// fetch failure becomes an authoritative-looking "you spent nothing on search" —
// the same failure `ciFigures.ts`'s `balanceUnavailable` exists to prevent one
// billed line over.

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

const { aiUsageService } = await import('@/lib/services/aiUsageService');
const { billingService } = await import('@/lib/services/billingService');
const { createTestWorkspace, createTestProject, createTestUser } = await import('./fixtures');
const { workspacesService } = await import('@/lib/services/workspacesService');
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

// ── AC 1–2 — the usage dashboard's DTO carries both halves ───────────────────

describe('OrgUsageDTO', () => {
  it('carries the org-level block AND the per-run rows, keyed by the same jobId', async () => {
    const { workspace, owner } = await createTestWorkspace();
    await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    getOrgUsageMock.mockResolvedValue(rawResponse());

    const res = await aiUsageService.getUsage({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });

    expect(res.search).toEqual({ totalSpend: 40, monthSpend: 12 });
    expect(res.searchRuns).toEqual({
      runs: [{ jobId: 'job_1', credits: 9, lastSearchAt: '2026-09-01T10:00:00.000Z' }],
      page: 1,
      pageSize: 10,
      total: 1,
      attributedSpend: 31,
      unattributedSpend: 9,
    });
    // The rows are keyed on the SAME `jobId` `recentRuns` carries, so the run log
    // joins them without a second call.
    expect(res.searchRuns?.runs[0]?.jobId).toBe('job_1');
  });

  it('preserves the remainder identity the surface renders', async () => {
    const { workspace, owner } = await createTestWorkspace();
    await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    getOrgUsageMock.mockResolvedValue(rawResponse());

    const res = await aiUsageService.getUsage({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });

    // attributed + unattributed === the org total, carried across the seam
    // unaltered. The DTO does not re-derive it — re-deriving would let the two
    // sides of the boundary disagree about a number the customer reconciles by
    // eye.
    const runs = res.searchRuns!;
    expect(runs.attributedSpend + runs.unattributedSpend).toBe(res.search!.totalSpend);
  });

  it('makes NO second outbound call for the search figures', async () => {
    const { workspace, owner } = await createTestWorkspace();
    await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    getOrgUsageMock.mockResolvedValue(rawResponse());

    await aiUsageService.getUsage({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });

    expect(getOrgUsageMock).toHaveBeenCalledTimes(1);
  });
});

// ── AC 5 — UNAVAILABLE is not ZERO, on both surfaces ─────────────────────────

describe('an absent block on the wire', () => {
  it('reaches OrgUsageDTO as null, distinctly from a genuinely zero month', async () => {
    const { workspace, owner } = await createTestWorkspace();
    await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });

    // An older motir-ai, or a deployment where the two halves have not both
    // rolled: the response simply has no `search` key.
    getOrgUsageMock.mockResolvedValue(rawResponse({ search: undefined, searchRuns: undefined }));
    const absent = await aiUsageService.getUsage({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });

    getOrgUsageMock.mockResolvedValue(
      rawResponse({
        search: { totalSpend: 0, monthSpend: 0 },
        searchRuns: {
          runs: [],
          page: 1,
          pageSize: 10,
          total: 0,
          attributedSpend: 0,
          unattributedSpend: 0,
        },
      }),
    );
    const zero = await aiUsageService.getUsage({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });

    // THE ASSERTION THIS FILE EXISTS FOR. The two must not be the same DTO value:
    // "we could not fetch this" and "you spent nothing" are opposite messages to
    // put in front of a customer, and only one of them is reassuring.
    expect(absent.search).toBeNull();
    expect(absent.searchRuns).toBeNull();
    expect(zero.search).toEqual({ totalSpend: 0, monthSpend: 0 });
    expect(zero.searchRuns?.total).toBe(0);
    expect(absent.search).not.toEqual(zero.search);
  });

  it('reaches BillingStatusDTO as null, distinctly from a zero-spend period', async () => {
    const { workspace, owner } = await createTestWorkspace();

    getOrgUsageMock.mockResolvedValue(rawResponse({ search: undefined }));
    const absent = await billingService.getBillingStatus({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });

    getOrgUsageMock.mockResolvedValue(rawResponse({ search: { totalSpend: 0, monthSpend: 0 } }));
    const zero = await billingService.getBillingStatus({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });

    expect(absent.search).toBeNull();
    expect(zero.search).toEqual({ totalSpend: 0, monthSpend: 0 });
  });

  it('an EMPTY-SCOPE dashboard reports ZERO, not unavailable — it never called the boundary', async () => {
    // A member with no accessible project short-circuits before the fetch. There
    // is provably nothing to fetch, so zero is the true answer; reporting
    // "unavailable" here would send the reader looking for an outage that is not
    // happening.
    // A workspace with NO project — the member can reach the workspace and has
    // no project slice, the shipped empty/limited branch.
    const { workspace } = await createTestWorkspace();
    const member = await createTestUser();
    await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });

    const res = await aiUsageService.getUsage({
      organizationId: workspace.organizationId,
      actorUserId: member.id,
    });

    expect(getOrgUsageMock).not.toHaveBeenCalled();
    expect(res.search).toEqual({ totalSpend: 0, monthSpend: 0 });
    expect(res.searchRuns).toEqual({
      runs: [],
      page: 1,
      pageSize: 10,
      total: 0,
      attributedSpend: 0,
      unattributedSpend: 0,
    });
  });
});

// ── AC 3 — the billing panel's figures come off the read it ALREADY makes ────

describe('BillingStatusDTO', () => {
  it('carries the org-level search block beside `ci`, from the existing getOrgUsage call', async () => {
    const { workspace, owner } = await createTestWorkspace();
    getOrgUsageMock.mockResolvedValue(rawResponse());

    const res = await billingService.getBillingStatus({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });

    expect(res.search).toEqual({ totalSpend: 40, monthSpend: 12 });
    // One call feeds `motirAi.balance`, `motirAi.tier` AND this line — no second
    // outbound request was added at this site.
    expect(getOrgUsageMock).toHaveBeenCalledTimes(1);
    // And the CI line is untouched beside it: this story adds a FOURTH line, it
    // does not re-open the third.
    expect(res.ci).toBeDefined();
  });

  it('carries ONLY the org-level figures — the per-run rows are the dashboard`s', async () => {
    const { workspace, owner } = await createTestWorkspace();
    getOrgUsageMock.mockResolvedValue(rawResponse());

    const res = await billingService.getBillingStatus({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });

    // The billing panel answers "what am I charged for"; "where did it go" is the
    // usage dashboard's question, and putting the run rows on both invites two
    // surfaces to disagree about the same list.
    expect(res).not.toHaveProperty('searchRuns');
  });
});

// ── AC 6 — the server-side scope decision is unchanged ───────────────────────

describe('the non-admin narrowing', () => {
  it('asks the boundary for the MEMBER`s own project scope, never an org-wide drill', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const project = await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });
    const member = await createTestUser();
    await workspacesService.addMember({ userId: member.id, workspaceId: workspace.id });
    getOrgUsageMock.mockResolvedValue(rawResponse({ scope: 'project' }));

    const res = await aiUsageService.getUsage({
      organizationId: workspace.organizationId,
      actorUserId: member.id,
      // A client-sent org scope must not be honoured — the shipped rule, asserted
      // here because the search figures ride the SAME resolved scope.
      scope: 'org',
    });

    expect(res.access.isAdmin).toBe(false);
    expect(res.scope).toBe('project');
    // The per-run search rows are narrowed by motir-ai from the scope THIS call
    // sends, so what the member may see is decided by this argument and nothing
    // else. Nothing here widens it, and no org-wide drill is requested on their
    // behalf.
    expect(getOrgUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'project', coreProjectId: project.id }),
    );
  });
});
