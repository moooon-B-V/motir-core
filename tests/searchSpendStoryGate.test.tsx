// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { db } from '@/lib/db';
import type { RawUsageResponse } from '@/lib/ai/types';
import { adminDb } from './helpers/adminDb';
import { renderWithIntl } from './helpers/renderWithIntl';
import enMessages from '@/messages/en.json';

// THE STORY TEST GATE for motir-core (MOTIR-4559), above the three code cards'
// own units. It does NOT re-derive them — each ships its own floor — and exists
// for the space BETWEEN them, which no per-card suite can reach.
//
// ⚠️ THE PROPERTY THAT MAKES THIS FILE DIFFERENT: it is happy-dom AND real
// Postgres in one file, so a REAL `aiUsageService` / `billingService` output —
// built from real org / workspace / project rows, through the real mapping and
// the real name-enrichment pass — is what reaches the REAL component. No
// hand-built DTO stands in for the service's output anywhere below. That is the
// one thing a per-card unit structurally cannot do: `aiUsageService.test.ts`
// stops at the DTO and `BillingClient.test.tsx` starts from one, so a key the
// service spells differently from the component would pass both.

const getOrgUsageMock = vi.fn<(q: unknown) => Promise<RawUsageResponse>>();
const getOrgSubscriptionMock = vi.fn<(q: unknown) => Promise<unknown>>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  getOrgUsage: (q: unknown) => getOrgUsageMock(q),
  getOrgSubscription: (q: unknown) => getOrgSubscriptionMock(q),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
}));
vi.mock('@/lib/billing/seatSync', () => ({ enqueueScaledTrackerSeatSync: vi.fn() }));

const { aiUsageService } = await import('@/lib/services/aiUsageService');
const { billingService } = await import('@/lib/services/billingService');
const { createTestWorkspace, createTestProject, createTestUser } = await import('./fixtures');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { truncateAuthTables } = await import('./helpers/db');
const { OrgUsageClient } =
  await import('@/app/(authed)/settings/organization/usage/_components/OrgUsageClient');
const { BillingClient } =
  await import('@/app/(authed)/settings/organization/billing/_components/BillingClient');
const { ToastProvider } = await import('@/components/ui/Toast');

const sum = enMessages.aiUsage.summary;
const act = enMessages.aiUsage.activity;
const bill = enMessages.billing.search;

/**
 * ⚠️ motir-ai's REAL wire shape, field for field — `usageService.UsageResponseDto`
 * as `GET /v1/usage` serializes it, including the two blocks MOTIR-4552 added.
 * Typed as motir-core's consumer type so a rename on EITHER side is a tsc error
 * here, the `billingBoundaryContract.test.ts` pattern.
 */
function upstream(over: Partial<RawUsageResponse> = {}): RawUsageResponse {
  return {
    scope: 'org',
    coreOrganizationId: 'org_gate',
    coreWorkspaceId: null,
    coreProjectId: null,
    balance: 12480,
    tier: { key: 'basic', name: 'Basic', monthlyCreditAllotment: 20000 },
    totalSpend: 147520,
    monthSpend: 7520,
    monthlyHistory: [{ yearMonth: '2026-09', credits: 7520 }],
    perModel: [],
    recentRuns: { runs: [], page: 1, pageSize: 10, total: 0 },
    search: { totalSpend: 1204, monthSpend: 312 },
    searchRuns: {
      runs: [{ jobId: 'job_seam_1', credits: 9, lastSearchAt: '2026-09-05T10:00:00.000Z' }],
      page: 1,
      pageSize: 10,
      total: 1,
      attributedSpend: 246,
      unattributedSpend: 66,
    },
    ...over,
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  getOrgUsageMock.mockReset();
  getOrgSubscriptionMock.mockReset();
  getOrgUsageMock.mockResolvedValue(upstream());
  getOrgSubscriptionMock.mockResolvedValue({
    status: 'active',
    currentPeriodEnd: '2026-10-01T00:00:00.000Z',
    priceId: 'basic_pool_monthly',
    planTier: { key: 'basic', name: 'Basic', monthlyCreditAllotment: 20000 },
  });
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_BASE_URL'] = 'https://app.test';
});

afterEach(() => {
  cleanup();
  delete process.env['MOTIR_CLOUD'];
  delete process.env['MOTIR_BASE_URL'];
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** Render a component against a DTO the REAL service produced. */
function renderWithDto(node: React.ReactElement, dto: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(dto), { status: 200 })),
  );
  renderWithIntl(node, { messages: enMessages });
}

// ── (1) The service → dashboard seam, with NO hand-built DTO (AC 2) ──────────

describe('the usage seam — a real upstream response, through the real service, into the real page', () => {
  it('carries the search figures through the mapping AND the name-enrichment pass', async () => {
    const { workspace, owner } = await createTestWorkspace();
    await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });

    // The REAL service: real org/workspace/project rows, the real scope decision,
    // the real enrichment. Its output is what the component receives.
    const dto = await aiUsageService.getUsage({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });

    // The seam, at the DTO: the writer's field and the reader's field are the
    // same field. A service that spelled `searchRuns` differently would arrive
    // here as undefined, and both per-card suites would still pass.
    expect(dto.search).toEqual({ totalSpend: 1204, monthSpend: 312 });
    expect(dto.searchRuns?.attributedSpend).toBe(246);
    expect(dto.searchRuns?.unattributedSpend).toBe(66);

    renderWithDto(<OrgUsageClient orgId={workspace.organizationId} orgName="Acme" />, dto);
    await waitFor(() => expect(screen.getByText(sum.balance)).toBeTruthy());

    // …and at the SCREEN.
    expect(screen.getByText(sum.searchThisMonth)).toBeTruthy();
    expect(screen.getByText('1,204 credits all time')).toBeTruthy();
    expect(screen.getByText('66 credits not attributed to a run')).toBeTruthy();
    expect(screen.getByText(act.webSearch)).toBeTruthy();
  });
});

// ── (2) The SAME upstream response, through the OTHER reader (AC 3) ──────────

describe('one wire shape, two DTO readers', () => {
  it('drives the same response through billingService into the rendered billed line', async () => {
    const { workspace, owner } = await createTestWorkspace();

    const status = await billingService.getBillingStatus({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });
    expect(status.search).toEqual({ totalSpend: 1204, monthSpend: 312 });

    renderWithDto(
      <ToastProvider>
        <BillingClient orgId={workspace.organizationId} orgName="Acme" memberCount={6} />
      </ToastProvider>,
      status,
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Motir Search', level: 2 })).toBeTruthy(),
    );
    expect(screen.getByText('312')).toBeTruthy();
  });

  it('⚠️ the two readers AGREE about the one upstream shape', async () => {
    // The property neither card's own units can assert, because each MOCKS the
    // other's output: `aiUsageService` and `billingService` consume ONE
    // `RawUsageResponse` into two DTOs, and a rename on the wire must move both
    // or neither. Driven from a single mocked response, read twice.
    const { workspace, owner } = await createTestWorkspace();
    await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });

    const usage = await aiUsageService.getUsage({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });
    const status = await billingService.getBillingStatus({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });

    expect(usage.search).toEqual(status.search);
  });
});

// ── (3) UNAVAILABLE ≠ ZERO, at EVERY layer (AC 6) ────────────────────────────

describe('unavailable is not zero — walked layer by layer', () => {
  it('holds at the MIRROR TYPE, both DTOs, and both rendered surfaces', async () => {
    const { workspace, owner } = await createTestWorkspace();
    await createTestProject({ workspaceId: workspace.id, actorUserId: owner.id });

    // LAYER 1 — the mirror type. `search` is optional on `RawUsageResponse`, so
    // an omitted block and a reported zero are DIFFERENT values on the wire.
    const absent = upstream({ search: undefined, searchRuns: undefined });
    const zeroed = upstream({
      search: { totalSpend: 0, monthSpend: 0 },
      searchRuns: {
        runs: [],
        page: 1,
        pageSize: 10,
        total: 0,
        attributedSpend: 0,
        unattributedSpend: 0,
      },
    });
    expect(absent.search).toBeUndefined();
    expect(zeroed.search).toEqual({ totalSpend: 0, monthSpend: 0 });

    // LAYER 2 — OrgUsageDTO.
    getOrgUsageMock.mockResolvedValue(absent);
    const usageAbsent = await aiUsageService.getUsage({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });
    getOrgUsageMock.mockResolvedValue(zeroed);
    const usageZero = await aiUsageService.getUsage({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });
    expect(usageAbsent.search).toBeNull();
    expect(usageZero.search).toEqual({ totalSpend: 0, monthSpend: 0 });

    // LAYER 3 — BillingStatusDTO, the other reader.
    getOrgUsageMock.mockResolvedValue(absent);
    const billAbsent = await billingService.getBillingStatus({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });
    getOrgUsageMock.mockResolvedValue(zeroed);
    const billZero = await billingService.getBillingStatus({
      organizationId: workspace.organizationId,
      actorUserId: owner.id,
    });
    expect(billAbsent.search).toBeNull();
    expect(billZero.search).toEqual({ totalSpend: 0, monthSpend: 0 });

    // LAYER 4a — the rendered DASHBOARD. A dash with an accessible name, and NOT
    // the zero treatment.
    renderWithDto(<OrgUsageClient orgId={workspace.organizationId} orgName="Acme" />, usageAbsent);
    await waitFor(() => expect(screen.getByText(sum.balance)).toBeTruthy());
    expect(screen.getAllByLabelText(sum.searchUnavailableValue).length).toBe(2);
    cleanup();

    renderWithDto(<OrgUsageClient orgId={workspace.organizationId} orgName="Acme" />, usageZero);
    await waitFor(() => expect(screen.getByText(sum.balance)).toBeTruthy());
    expect(screen.queryByLabelText(sum.searchUnavailableValue)).toBeNull();
    cleanup();

    // LAYER 4b — the rendered BILLED LINE.
    renderWithDto(
      <ToastProvider>
        <BillingClient orgId={workspace.organizationId} orgName="Acme" memberCount={6} />
      </ToastProvider>,
      billAbsent,
    );
    await waitFor(() => expect(screen.getByText(bill.unavailable)).toBeTruthy());
    expect(screen.getAllByLabelText(bill.unavailableValue).length).toBe(2);
    cleanup();

    renderWithDto(
      <ToastProvider>
        <BillingClient orgId={workspace.organizationId} orgName="Acme" memberCount={6} />
      </ToastProvider>,
      billZero,
    );
    await waitFor(() => expect(screen.getByText(bill.zeroTitle)).toBeTruthy());
    expect(screen.queryByText(bill.unavailable)).toBeNull();
  });
});

// ── (4) The SCOPING test, with a member whose population differs (AC 5) ──────

describe('the member narrowing, against a population that is genuinely smaller', () => {
  it('sends the MEMBER`s own project scope, never the org`s, and renders no org-wide search figure', async () => {
    // The fixture the criterion asks for: the org has TWO workspaces with a
    // project each, and the member can reach only ONE. So the member's visible
    // population is a strict subset of the org's — a fixture where they coincide
    // would pass whether or not the narrowing works.
    const { workspace: visible, owner } = await createTestWorkspace();
    const theirs = await createTestProject({
      workspaceId: visible.id,
      actorUserId: owner.id,
    });
    // A second workspace needs the caps lifted: `PM_ENTITLEMENTS.free` allows
    // ONE (`maxWorkspaces: 1`). `aiIncludedSeat` is the shipped signal that
    // lifts them (ADR §4 as amended 8.1.22 — a paid AI plan bundles a seat), so
    // the fixture reaches the two-workspace shape through the product's own rule
    // rather than around it.
    await adminDb.organization.update({
      where: { id: visible.organizationId },
      data: { aiIncludedSeat: true },
    });
    const { workspace: hidden } = await workspacesService.createWorkspace({
      name: 'Not theirs',
      ownerUserId: owner.id,
      organizationId: visible.organizationId,
    });
    const notTheirs = await createTestProject({ workspaceId: hidden.id, actorUserId: owner.id });

    const member = await createTestUser();
    await workspacesService.addMember({ userId: member.id, workspaceId: visible.id });

    getOrgUsageMock.mockResolvedValue(upstream({ scope: 'project' }));
    const dto = await aiUsageService.getUsage({
      organizationId: visible.organizationId,
      actorUserId: member.id,
      // A client-sent ORG scope must not be honoured.
      scope: 'org',
    });

    expect(dto.access.isAdmin).toBe(false);
    expect(dto.scope).toBe('project');
    // What the member may see is decided by THIS argument and nothing else — the
    // search figures ride the same resolved scope as every other figure.
    expect(getOrgUsageMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ scope: 'project', coreProjectId: theirs.id }),
    );
    // ⚠️ THE FIXTURE'S POINT: the org's true population is TWO projects across
    // TWO workspaces, and the member can reach ONE. A fixture where the two
    // coincide passes whether or not the narrowing works.
    expect(dto.drill.projects.map((p) => p.id)).toEqual([theirs.id]);
    expect(dto.drill.projects.map((p) => p.id)).not.toContain(notTheirs.id);
    // And they are offered no cross-workspace drill to widen it with.
    expect(dto.drill.workspaces).toHaveLength(0);

    // The RENDERED page carries no org-wide search figure either: what reaches
    // the screen is this narrowed DTO and nothing else.
    renderWithDto(<OrgUsageClient orgId={visible.organizationId} orgName="Acme" />, dto);
    await waitFor(() => expect(screen.getByText(sum.balance)).toBeTruthy());
    expect(screen.getByText(sum.searchThisMonth)).toBeTruthy();
    // The org-level tag is present and says so — the figure is not hidden from a
    // member, it is LABELLED, which is the asset's decision. What they cannot do
    // is mistake it for their project's.
    expect(screen.getByText(sum.scopeOrg)).toBeTruthy();
    expect(screen.queryByText('Not theirs')).toBeNull();
  });
});

// ── (5) The open-core invariant (AC 4) ───────────────────────────────────────

describe('the open-core invariant', () => {
  it('adds NO billing table to motir-core — the ledger lives in motir-ai', () => {
    // The story added a search DEBIT and its attribution, and every one of those
    // rows lives in motir-ai. A `CreditTransaction` / `CreditLedger` model
    // appearing in this schema would mean the boundary had been crossed the
    // wrong way, and it would be invisible to every behavioural test above.
    const schema = readFileSync('prisma/schema.prisma', 'utf8');
    for (const model of ['CreditTransaction', 'CreditLedger', 'PlanningRun', 'AiOrganization']) {
      expect(schema, `motir-core must not model ${model}`).not.toMatch(
        new RegExp(`^model\\s+${model}\\b`, 'm'),
      );
    }
  });

  it('reads the ledger ONLY across the boundary — no direct credit query in motir-core', () => {
    // Every search figure on both surfaces arrives through `motirAiClient`. If a
    // service ever reached for a credit table directly it would still render,
    // and only this guard would notice.
    const usage = readFileSync('lib/services/aiUsageService.ts', 'utf8');
    const billing = readFileSync('lib/services/billingService.ts', 'utf8');
    for (const [name, src] of [
      ['aiUsageService', usage],
      ['billingService', billing],
    ] as const) {
      expect(src, `${name} must read usage over the boundary`).toContain('motirAiClient');
      expect(src, `${name} must not query a credit table`).not.toMatch(
        /db\.credit(Transaction|Ledger)\b/,
      );
    }
  });
});
