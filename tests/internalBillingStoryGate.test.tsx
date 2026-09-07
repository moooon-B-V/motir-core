// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { Prisma } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import type { RawUsageResponse } from '@/lib/ai/types';
import { adminDb } from './helpers/adminDb';
import { renderWithIntl } from './helpers/renderWithIntl';
import { stripSourceComments } from './helpers/stripSourceComments';
import enMessages from '@/messages/en.json';

// THE STORY TEST GATE for motir-core (MOTIR-4573), above the five code cards'
// own units. It does not re-derive them — each ships its own floor — and exists
// for the space BETWEEN them, which no per-card suite can reach.
//
// ⚠️ THE PROPERTY THAT MAKES THIS FILE DIFFERENT: happy-dom AND real Postgres in
// one file, so the classification written by the REAL service through the REAL
// policy arms is what reaches the REAL components. No hand-built DTO stands in
// for a service's output anywhere below. That is the one thing a per-card unit
// structurally cannot do: `organizationClassification.test.ts` stops at the
// service, `BillingClient.test.tsx` starts from a fixture, and a column the
// writer spells one way and the reader another would pass both.
//
// ⚠️ AND HALF OF IT IS GUARDS, WHICH DEFEND THE STORY'S ARGUMENT RATHER THAN ITS
// CODE. The thesis is that a SUPPRESSION flag is dangerous: it creates a second,
// untested path that quietly diverges. The cheapest way to reintroduce that is a
// helpful-looking `|| internalBilling` beside an existing `isMeta` in the
// metering path, or a figure re-hidden behind a flag on a screen. Neither would
// fail a test that does not exist.

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

// The one `vi.mock` `CLAUDE.md` allows, at the platform tier's `getSession`
// equivalent — the test environment has no cookies. The DEGREE is honoured, not
// waved through, so a call below that reaches past its rung still refuses.
vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        const { NotPlatformStaffError } = await import('@/lib/platform/errors');
        if (!principal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(principal.role, minimum)) throw new NotPlatformStaffError();
        return principal;
      },
    ),
  };
});

const { aiUsageService } = await import('@/lib/services/aiUsageService');
const { billingService } = await import('@/lib/services/billingService');
const { platformBillingClassificationService } =
  await import('@/lib/services/platformBillingClassificationService');
const { resolveTenantOrg } = await import('@/lib/ai/tenantOrg');
const { createTestWorkspace, createTestUser } = await import('./fixtures');
const { truncateAuthTables } = await import('./helpers/db');
const { OrgUsageClient } =
  await import('@/app/(authed)/settings/organization/usage/_components/OrgUsageClient');
const { BillingClient } =
  await import('@/app/(authed)/settings/organization/billing/_components/BillingClient');
const { ToastProvider } = await import('@/components/ui/Toast');

const sum = enMessages.aiUsage.summary;
const bill = enMessages.billing;

let principal: PlatformPrincipal | null = null;
let seq = 0;

/** motir-ai's real wire shape, typed as motir-core's consumer type. */
function upstream(over: Partial<RawUsageResponse> = {}): RawUsageResponse {
  return {
    scope: 'org',
    coreOrganizationId: 'org_gate',
    coreWorkspaceId: null,
    coreProjectId: null,
    balance: 914,
    tier: { key: 'basic', name: 'Basic', monthlyCreditAllotment: 1000 },
    totalSpend: 147520,
    monthSpend: 7520,
    monthlyHistory: [{ yearMonth: '2026-09', credits: 7520 }],
    perModel: [],
    recentRuns: { runs: [], page: 1, pageSize: 10, total: 0 },
    search: { totalSpend: 1204, monthSpend: 312 },
    ...over,
  };
}

async function seedSuperadmin(role: PlatformPrincipal['role'] = 'superadmin') {
  const user = await createTestUser({ email: `ops+gate-${role}-${seq++}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  getOrgUsageMock.mockReset();
  getOrgSubscriptionMock.mockReset();
  getOrgUsageMock.mockResolvedValue(upstream());
  getOrgSubscriptionMock.mockResolvedValue({
    status: 'active',
    currentPeriodEnd: '2026-10-01T00:00:00.000Z',
    priceId: 'basic_pool_monthly',
    planTier: { key: 'basic', name: 'Basic', monthlyCreditAllotment: 1000 },
  });
  principal = await seedSuperadmin();
  process.env['MOTIR_CLOUD'] = 'true';
  process.env['MOTIR_BASE_URL'] = 'https://app.test';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

// ─────────────────────────────────────────────────────────────────────────────
// (1) THE SEAM — column → repository → service → DTO → rendered chip (AC 2)
// ─────────────────────────────────────────────────────────────────────────────

describe('the classification seam — written by the real service, read by the real screens', () => {
  it('carries the flag from the audited WRITE all the way to both customer surfaces', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const orgId = workspace.organizationId;

    // ── THE WRITE. The real service, the real `FOR UPDATE` lock, the real audit
    //    row — not `adminDb.organization.update`, which would prove nothing
    //    about the path an operator actually takes.
    const written = await platformBillingClassificationService.setInternalBilling(
      principal!,
      orgId,
      true,
      'Dogfood org (MOTIR-4337)',
    );
    expect(written.internalBilling).toBe(true);
    // …and the two flags stay separate all the way down. A write that set the
    // wrong column would satisfy every assertion below except this one.
    expect(written.isMeta).toBe(false);
    expect(
      (await adminDb.organization.findUniqueOrThrow({ where: { id: orgId } })).internalBilling,
    ).toBe(true);

    // ── THE OPERATOR'S OWN READ-BACK, through the audited read path.
    const detail = await platformBillingClassificationService.getOrganization(principal!, orgId);
    expect(detail.internalBilling).toBe(true);

    // ── THE TENANT ENVELOPE. The producer for every AI job this org submits.
    expect(await resolveTenantOrg({ userId: owner.id, workspaceId: workspace.id })).toMatchObject({
      organizationId: orgId,
      isMeta: false,
      internalBilling: true,
    });

    // ── THE TWO CUSTOMER DTOs, from the real services.
    const usage = await aiUsageService.getUsage({ organizationId: orgId, actorUserId: owner.id });
    const status = await billingService.getBillingStatus({
      organizationId: orgId,
      actorUserId: owner.id,
    });
    expect(usage.internalBilling).toBe(true);
    expect(status.internalBilling).toBe(true);
    // ⚠️ The property neither service's own units can assert, because each
    // mocks the other away: ONE column feeds TWO readers, and a rename must
    // move both or neither.
    expect(usage.internalBilling).toBe(status.internalBilling);

    // ── THE SCREENS, from those same DTOs. This is the join a key rename
    //    breaks silently: the service would still answer, the component would
    //    still render, and the chip would simply not be there.
    renderWithDto(<OrgUsageClient orgId={orgId} orgName="Acme" />, usage);
    await waitFor(() => expect(screen.getByText(sum.balance)).toBeTruthy());
    expect(screen.getByText(sum.internalBilling)).toBeTruthy();
    // The FIGURE beside it — the whole story, in one assertion.
    expect(screen.getByText('914')).toBeTruthy();
    cleanup();

    renderWithDto(
      <ToastProvider>
        <BillingClient orgId={orgId} orgName="Acme" memberCount={6} />
      </ToastProvider>,
      status,
    );
    await waitFor(() => expect(screen.getByText(bill.internalBilling.badge)).toBeTruthy());
    // …and the ordinary storefront around it, which the deleted branch replaced.
    expect(screen.getByRole('heading', { name: 'Motir AI', level: 2 })).toBeTruthy();
  });

  it('the UNCLASSIFY direction travels the same seam — nothing is one-way', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const orgId = workspace.organizationId;

    await platformBillingClassificationService.setInternalBilling(
      principal!,
      orgId,
      true,
      'Dogfood org',
    );
    await platformBillingClassificationService.setInternalBilling(
      principal!,
      orgId,
      false,
      'Moved to a paying plan',
    );

    const usage = await aiUsageService.getUsage({ organizationId: orgId, actorUserId: owner.id });
    expect(usage.internalBilling).toBe(false);
    expect(await resolveTenantOrg({ userId: owner.id, workspaceId: workspace.id })).toMatchObject({
      internalBilling: false,
    });

    renderWithDto(<OrgUsageClient orgId={orgId} orgName="Acme" />, usage);
    await waitFor(() => expect(screen.getByText(sum.balance)).toBeTruthy());
    expect(screen.queryByText(sum.internalBilling)).toBeNull();
    // The BALANCE is still a figure. It was one before the classification and
    // it is one after — the story removed the branch, not just its `true` arm.
    expect(screen.getByText('914')).toBeTruthy();

    // Both writes are on the record, in order, each with its own action.
    const rows = await adminDb.platformAuditLog.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.action)).toEqual([
      'org.internal_billing_set',
      'org.internal_billing_unset',
    ]);
    expect(rows.every((r) => (r.reason ?? '').length > 0)).toBe(true);
  });

  it('an UNCLASSIFIED org is untouched by any of it — the story`s ninth criterion', async () => {
    const { workspace, owner } = await createTestWorkspace();
    const orgId = workspace.organizationId;

    const usage = await aiUsageService.getUsage({ organizationId: orgId, actorUserId: owner.id });
    const status = await billingService.getBillingStatus({
      organizationId: orgId,
      actorUserId: owner.id,
    });
    expect(usage.internalBilling).toBe(false);
    expect(status.internalBilling).toBe(false);
    // The column defaults false and nothing on the read path invents a value —
    // an org nobody has ever classified is exactly a customer.
    expect(usage.isMeta).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (2) THE POLICY ARMS ARE NARROW (AC 7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run `fn` under the non-bypass `motir_app` role, optionally with the tenant
 * GUCs bound. Without the role switch the dev container's superuser bypasses RLS
 * even under `FORCE ROW LEVEL SECURITY`, and every assertion below would pass on
 * a database with no policies at all.
 */
async function asAppRole<T>(
  ctx: { userId?: string; organizationId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.organizationId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.organization_id', ${ctx.organizationId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

describe('the new `organization` policy arms widen `app.platform_staff` and nothing else', () => {
  it('a tenant context still reads ZERO organization rows for an org it is not in', async () => {
    // ⚠️ RLS FAILS IN THE REASSURING DIRECTION. A read that is too wide returns
    // MORE rows and no error, and nothing on any screen looks wrong. This is the
    // assertion that would notice — and it is written AFTER the two new arms
    // exist, which is the only moment it is evidence about them.
    const { workspace: mine, owner } = await createTestWorkspace();
    const { workspace: theirs } = await createTestWorkspace();

    const rows = await asAppRole({ userId: owner.id, organizationId: mine.organizationId }, (tx) =>
      tx.organization.findMany({ where: { id: theirs.organizationId } }),
    );
    expect(rows).toEqual([]);
  });

  it('and the platform-staff arm is not reachable by BINDING the tenant GUCs', async () => {
    // The arms key on `app.platform_staff`, which no tenant context sets. A
    // policy written against the wrong GUC — say `app.user_id IS NOT NULL` —
    // would pass the case above (the user is in no org) and fail here.
    const { workspace: theirs } = await createTestWorkspace();
    const outsider = await createTestUser();

    const rows = await asAppRole({ userId: outsider.id }, (tx) => tx.organization.findMany());
    expect(rows.map((r) => r.id)).not.toContain(theirs.organizationId);
  });

  it('with `app.platform_staff` bound, the READ arm admits the row — the arm is live', async () => {
    // The other direction, so a green above cannot be produced by an arm that
    // never matches anything.
    const { workspace } = await createTestWorkspace();

    const rows = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.platform_staff', 'true', true)`;
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return tx.organization.findMany({ where: { id: workspace.organizationId } });
    });
    expect(rows.map((r) => r.id)).toEqual([workspace.organizationId]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3) THE GUARDS — the guarantees a coverage percentage cannot see
// ─────────────────────────────────────────────────────────────────────────────

const read = (path: string) => stripSourceComments(readFileSync(path, 'utf8'));

/** Every `.ts`/`.tsx` file under `dir` whose raw source contains `needle`. */
function filesContaining(needle: string, dir: string): string[] {
  const hits: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) hits.push(...filesContaining(needle, path));
    else if (/\.tsx?$/.test(entry.name) && readFileSync(path, 'utf8').includes(needle)) {
      hits.push(path);
    }
  }
  return hits;
}

const BILLING_CLIENT = 'app/(authed)/settings/organization/billing/_components/BillingClient.tsx';
const USAGE_CLIENT = 'app/(authed)/settings/organization/usage/_components/OrgUsageClient.tsx';

/**
 * THE SUPPRESSION DETECTOR — written over the BEHAVIOUR, not over a name.
 *
 * What it forbids is a VALUE selected by the flag: a branch keyed on it, a
 * ternary whose arms are not markup, the flag used as a predicate. What it
 * permits is the one form MOTIR-4572 allows — a CHIP, i.e. the flag choosing
 * between markup and nothing — because a label names what an organization is
 * and changes no figure on the page.
 *
 * A guard keyed on `InternalPlanCard`, or on `summary.unlimited`, would pass the
 * moment somebody wrote the same defect with different words. This one fails at
 * the shape, which is why its own failing cases are asserted below rather than
 * described.
 */
const SUPPRESSION_SHAPES: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'a branch keyed on the flag', re: /if\s*\([^)]*\bisMeta\b[^)]*\)/ },
  { name: 'a ternary choosing between two VALUES', re: /\bisMeta\b\s*\?(?!\s*<)/ },
  { name: 'the flag used as a predicate', re: /\bisMeta\b\s*(?:&&|\|\|)(?!\s*<)/ },
  { name: 'the flag WIDENED by another flag', re: /(?:&&|\|\|)\s*!?[\w.?]*\bisMeta\b/ },
];

function suppressions(source: string): string[] {
  return SUPPRESSION_SHAPES.filter(({ re }) => re.test(source)).map(({ name }) => name);
}

describe('GUARD — no figure on the billing or usage client is derived from `isMeta` (AC 4)', () => {
  it('detects each suppression SHAPE, in a source written to contain it', () => {
    // ⚠️ THE GUARD'S OWN FAILING CASE, asserted rather than described. A guard
    // that has never been seen to fail is a guard nobody has checked, and this
    // one exists precisely because the defect it looks for was shipped once.
    expect(suppressions('if (data.isMeta) { return <InternalPlanCard />; }')).toContain(
      'a branch keyed on the flag',
    );
    expect(suppressions("const n = data.isMeta ? t('unlimited') : fmt(data.balance);")).toContain(
      'a ternary choosing between two VALUES',
    );
    expect(suppressions('const outOfCredits = !data.isMeta && data.balance <= 0;')).toContain(
      'the flag used as a predicate',
    );
    expect(suppressions('if (org.internalBilling || org.isMeta) return null;')).toContain(
      'the flag WIDENED by another flag',
    );
  });

  it('permits the one form MOTIR-4572 allows — a CHIP, which changes no figure', () => {
    // The permitted shape must actually pass, or the guard would forbid the
    // label the story deliberately keeps and the next author would delete the
    // guard instead of the defect.
    expect(
      suppressions('{org.isMeta ? <Pill severity="info">{t(\'orgs.chip.isMeta\')}</Pill> : null}'),
    ).toEqual([]);
    expect(suppressions('{org.isMeta && <Pill>{label}</Pill>}')).toEqual([]);
  });

  it('finds NONE of them in either shipped client', () => {
    for (const path of [BILLING_CLIENT, USAGE_CLIENT]) {
      expect(suppressions(read(path)), `${path} must derive no value from isMeta`).toEqual([]);
    }
  });

  it('and the count is pinned at ZERO, so any reintroduction is deliberate', () => {
    // The ratchet beside the behaviour predicate. Today neither client reads the
    // flag at all; a future card that wants a second chip has to move this
    // number and say why, which is the right amount of friction for putting a
    // flag read back on a screen this story just cleared.
    for (const path of [BILLING_CLIENT, USAGE_CLIENT]) {
      expect((read(path).match(/\bisMeta\b/g) ?? []).length, `${path} reads isMeta`).toBe(0);
    }
  });
});

describe('GUARD — the metering and paywall paths are NOT widened (AC 5)', () => {
  // The story's own "no branch in the metering path", held where it could
  // regress. `ci-minutes-allowance.md` §4.4 records WHY the CI bypass keys on
  // `isMeta` alone: moooon B.V. pays its own GitHub bill, so charging a minute
  // Motir never paid for and then offsetting it would put an invented figure on
  // the very screen this story exists to make honest.
  const MUST_NOT_SEE_THE_FLAG = [
    'lib/ciMetering/allowance.ts',
    'lib/services/ciAllowanceService.ts',
    'lib/services/ciActionsGateService.ts',
    'lib/billing/aiEntitlement.ts',
    'lib/billing/entitlements.ts',
  ];

  it.each(MUST_NOT_SEE_THE_FLAG)('%s never mentions `internalBilling`', (path) => {
    expect(readFileSync(path, 'utf8')).not.toMatch(/\binternalBilling\b/);
  });

  it('…and each of them still keys on `isMeta`, so the guard is about WIDENING', () => {
    // Without this half, deleting the bypass entirely would make the guard
    // above green — a pass produced by removing the behaviour it protects.
    for (const path of MUST_NOT_SEE_THE_FLAG) {
      expect(readFileSync(path, 'utf8'), `${path} must still name isMeta`).toMatch(/\bisMeta\b/);
    }
  });
});

describe('GUARD — the envelope field is TOTAL (AC 6)', () => {
  it('every job submitter puts `internalBilling` on the tenant it builds', () => {
    // ⚠️ THE TYPE CANNOT DO THIS. `Tenant.internalBilling` is OPTIONAL on
    // purpose — the wire may omit it, and typing it required would assert
    // something stronger than the envelope does. The cost of that decision is
    // that a NEW AI service can submit a job with the field simply missing, and
    // compile. This guard is what that decision buys back.
    const callers = filesContaining('submitJob(', 'lib').filter(
      (path) => !/export\s+(?:async\s+)?function\s+submitJob/.test(readFileSync(path, 'utf8')),
    );
    // Non-vacuous: there ARE submitters, and the list is the real one.
    expect(callers.length).toBeGreaterThan(5);
    for (const path of callers) {
      expect(readFileSync(path, 'utf8'), `${path} builds a tenant without internalBilling`).toMatch(
        /\binternalBilling\b/,
      );
    }
  });

  it('every DTO and mapper that declares `isMeta` declares `internalBilling` beside it', () => {
    // The customer half of the same rule. A DTO carrying one flag and not the
    // other is how a screen ends up unable to tell the two apart.
    const surfaces = [
      ...filesContaining('isMeta', 'lib/dto'),
      ...filesContaining('isMeta', 'lib/mappers'),
    ];
    expect(surfaces.length).toBeGreaterThan(2);
    for (const path of surfaces) {
      expect(readFileSync(path, 'utf8'), `${path} declares isMeta alone`).toMatch(
        /\binternalBilling\b/,
      );
    }
  });
});

describe('GUARD — two flags, two chips, two meanings', () => {
  it('the operator surfaces label them separately, and neither label names the other', () => {
    // `docs/decisions/internal-billing-classification.md` §1 refuses the
    // conflation; this is that refusal expressed where an operator reads it. A
    // single "Internal" chip covering both would be indistinguishable on screen
    // from the two, and wrong about every org that is one and not the other.
    const chip = enMessages.platformAdmin.orgs.chip as Record<string, string>;
    expect(chip['isMeta']).toBeTruthy();
    expect(chip['internalBilling']).toBeTruthy();
    expect(chip['isMeta']).not.toBe(chip['internalBilling']);

    for (const path of [
      'app/(admin)/admin/tenants/page.tsx',
      'app/(admin)/admin/tenants/[orgId]/page.tsx',
    ]) {
      const src = read(path);
      expect(src, `${path} must render both chips`).toMatch(/orgs\.chip\.isMeta/);
      expect(src).toMatch(/orgs\.chip\.internalBilling/);
    }
  });

  it('the CONTROL sets `internalBilling` and can never set `isMeta`', () => {
    // The two flags are separate only for as long as nothing can set both. The
    // classification control is the only writer this story adds, and `isMeta`
    // is settable from nowhere at all.
    const bar = read('app/(admin)/admin/tenants/[orgId]/_components/ClassificationBar.tsx');
    expect(bar).toMatch(/\binternalBilling\b/);
    expect(bar).not.toMatch(/\bisMeta\b/);
    expect(read('app/(admin)/admin/tenants/[orgId]/actions.ts')).not.toMatch(/\bisMeta\b/);
  });
});

describe('the action`s result codes are each exercised (AC 3)', () => {
  it('drives FAILED with a REAL unexplained error — the one arm the sibling suite cannot reach', async () => {
    // ⚠️ THE FIFTH CODE, AND THE ONLY ONE `organizationClassificationAction.test.ts`
    // leaves undriven. The other four are refusals the service NAMES, so a test
    // can produce them by asking for the refusal. `FAILED` is the arm for an
    // error nothing named, and the obvious way to manufacture one — breaking the
    // database — leaves it broken for every neighbouring test in the worker.
    //
    // A NUL byte in the organization id is a real one that costs nothing: it is
    // a value a stale link or a mangled redirect can genuinely carry, Postgres
    // rejects it at the parameter rather than the query, and no domain error
    // claims it. So the operator sees "it failed", the cause is logged, and the
    // dialog does NOT tell them to retry something that cannot succeed.
    const { setInternalBillingAction } =
      await import('@/app/(admin)/admin/tenants/[orgId]/actions');
    const result = await setInternalBillingAction('org\u0000broken', true, 'A mangled link');

    expect(result).toEqual({ ok: false, code: 'FAILED' });
    // A refusal writes nothing, whichever refusal it is.
    expect(await adminDb.platformAuditLog.findMany()).toEqual([]);
  });

  it('every code in the union appears in one of the two suites', () => {
    // AC 3's five codes are driven against the REAL service, on real Postgres,
    // by `organizationClassificationAction.test.ts`. What that suite cannot do
    // is notice a SIXTH code added later and left untested — a code that
    // silently collapsed into `FAILED` would look identical from every angle
    // except the operator's screen. So the union is read from the source and
    // each member is required to appear in the suite.
    const actions = read('app/(admin)/admin/tenants/[orgId]/actions.ts');
    const union = actions.match(/code:\s*([^;]+);/)?.[1] ?? '';
    const codes = [...union.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(codes).toEqual([
      'REASON_REQUIRED',
      'NOT_FOUND',
      'ALREADY_IN_STATE',
      'NOT_PERMITTED',
      'FAILED',
    ]);

    const driven =
      readFileSync('tests/platform/organizationClassificationAction.test.ts', 'utf8') +
      readFileSync('tests/internalBillingStoryGate.test.tsx', 'utf8');
    for (const code of codes) {
      expect(driven, `${code} is declared but never driven`).toContain(`code: '${code}'`);
    }
  });
});
