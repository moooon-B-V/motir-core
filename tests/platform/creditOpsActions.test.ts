import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The CREDITS & PLAN Server Actions through the REAL staff gate (MOTIR-753, the
 * 10.3.8 governance sweep over MOTIR-747's `creditActions.ts`).
 *
 * `platformCreditOpsService.test.ts` owns the service's rules with the gate
 * stubbed; what it cannot show is that the ACTION — a POST the admin layout never
 * renders — refuses a caller who is not staff. So here the only stub on the
 * identity path is `getSession()` (the standing exception: vitest has no
 * cookies), and `requirePlatformStaff` reads the real `platformRole` column. A
 * customer who OWNS the org being granted to is the case that matters: the most
 * tenant standing there is, and still no platform reach.
 *
 * motir-ai is stubbed at the client boundary (`fetch`), as in the service suite;
 * every refusal is checked against "was motir-ai asked?" and the audit row count.
 */

let currentSession: { user: { id: string; email: string; name: string } } | null = null;

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: vi.fn(async () => currentSession),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

let balance = 0;
let tierKey = 'free';
const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
  const u = new URL(url);
  if (init.method === 'GET') {
    // The balance read the service takes before a write (its `balanceBefore`).
    return Response.json({
      known: true,
      coreOrganizationId: u.searchParams.get('coreOrganizationId'),
      balanceCredits: balance,
      tier: {
        key: tierKey,
        name: tierKey.toUpperCase(),
        cadence: 'monthly',
        allotmentCredits: 8000,
      },
      lastTierAssignment: null,
      entries: [],
      nextCursor: null,
    });
  }
  const body = JSON.parse(String(init.body)) as Record<string, unknown>;
  if (u.pathname === '/v1/admin/credits') {
    balance += Number(body['credits']);
    return Response.json({
      coreOrganizationId: body['coreOrganizationId'],
      transaction: {
        id: `ctx_${String(body['requestId'])}`,
        at: '2026-10-03T09:12:44.120Z',
        kind: body['kind'],
        credits: body['credits'],
        balanceAfter: balance,
        reason: body['reason'],
        actor: body['actor'],
        externalRef: `${String(body['kind'])}:staff:${String(body['requestId'])}`,
      },
      balanceCredits: balance,
      idempotent: false,
    });
  }
  const from = tierKey;
  tierKey = String(body['tierKey']);
  return Response.json({
    coreOrganizationId: body['coreOrganizationId'],
    assignment: {
      id: `pta_${String(body['requestId'])}`,
      at: '2026-10-03T09:15:02.004Z',
      fromTierKey: from,
      toTierKey: tierKey,
      reason: body['reason'],
      actor: body['actor'],
    },
    tier: { key: tierKey, name: tierKey.toUpperCase(), cadence: 'monthly', allotmentCredits: 8000 },
    changed: from !== tierKey,
    idempotent: false,
  });
});

let seq = 0;

async function signInAs(platformRole: 'support' | 'operator' | 'superadmin' | null) {
  const user = await createTestUser({ email: `credit-action-${++seq}@example.com` });
  if (platformRole) {
    await adminDb.user.update({ where: { id: user.id }, data: { platformRole } });
  }
  currentSession = { user: { id: user.id, email: user.email, name: user.name } };
  return user;
}

/**
 * A fresh module graph per case: `requirePlatformStaff` is wrapped in React
 * `cache()`, which has no request scope in vitest — re-importing gives each case
 * its own "request" (the `platformStaffGate.test.ts` pattern).
 */
async function freshActions() {
  return import('@/app/(admin)/admin/tenants/[orgId]/creditActions');
}

const auditRows = () => adminDb.platformAuditLog.findMany({ orderBy: { seq: 'asc' } });

let orgId: string;
let ownerId: string;

beforeEach(async () => {
  vi.resetModules();
  process.env['MOTIR_AI_URL'] = 'https://ai.example.test';
  process.env['MOTIR_AI_SERVICE_TOKEN'] = 'svc-token';
  vi.stubGlobal('fetch', fetchStub);
  fetchStub.mockClear();
  balance = 1250;
  tierKey = 'free';
  currentSession = null;
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  const owner = await createTestUser({ email: `credit-action-owner-${++seq}@example.com` });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Northwind',
    ownerUserId: owner.id,
  });
  orgId = workspace.organizationId;
  ownerId = owner.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a caller who is not platform staff is denied — nothing asked, nothing written', () => {
  it('the org’s own OWNER cannot grant, adjust or set the plan', async () => {
    const owner = await adminDb.user.findUniqueOrThrow({ where: { id: ownerId } });
    currentSession = { user: { id: owner.id, email: owner.email, name: owner.name } };
    const actions = await freshActions();

    expect(
      await actions.grantCreditsAction(orgId, {
        credits: 500,
        reason: 'free money',
        requestId: 'r1',
      }),
    ).toEqual({ ok: false, code: 'NOT_PERMITTED' });
    expect(
      await actions.adjustCreditsAction(orgId, { credits: 50, reason: 'x', requestId: 'r2' }),
    ).toEqual({ ok: false, code: 'NOT_PERMITTED' });
    expect(
      await actions.setPlanAction(orgId, { tierKey: 'pro', reason: 'x', requestId: 'r3' }),
    ).toEqual({ ok: false, code: 'NOT_PERMITTED' });
    expect(await actions.loadCreditLedgerPageAction(orgId, null)).toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });

    expect(fetchStub).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });

  it('a signed-out request is denied', async () => {
    const { grantCreditsAction } = await freshActions();
    expect(await grantCreditsAction(orgId, { credits: 500, reason: 'x', requestId: 'r1' })).toEqual(
      { ok: false, code: 'NOT_PERMITTED' },
    );
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });

  it('staff below superadmin are denied the writes', async () => {
    await signInAs('operator');
    const { grantCreditsAction } = await freshActions();
    expect(await grantCreditsAction(orgId, { credits: 500, reason: 'x', requestId: 'r1' })).toEqual(
      { ok: false, code: 'NOT_PERMITTED' },
    );
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('a superadmin, through the real gate', () => {
  it('grant raises the balance by exactly the amount; the grant row carries balanceAfter + reason; audited', async () => {
    const staff = await signInAs('superadmin');
    const { grantCreditsAction } = await freshActions();

    const out = await grantCreditsAction(orgId, {
      credits: 500,
      reason: 'Goodwill for the outage',
      requestId: 'adm_req_1',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.balanceCredits).toBe(1250 + 500);
    expect(out.result.entry).toMatchObject({
      kind: 'grant',
      credits: 500,
      balanceAfter: 1750,
      reason: 'Goodwill for the outage',
    });

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'org.credit_grant',
      actorUserId: staff.id,
      organizationId: orgId,
      reason: 'Goodwill for the outage',
      metadata: expect.objectContaining({ balanceBefore: 1250, balanceAfter: 1750 }),
    });
  });

  it('adjust moves the balance by the signed amount; audited', async () => {
    const staff = await signInAs('superadmin');
    const { adjustCreditsAction } = await freshActions();

    const out = await adjustCreditsAction(orgId, {
      credits: -250,
      reason: 'Double-charged run',
      requestId: 'adm_adj_1',
    });
    expect(out).toMatchObject({ ok: true, result: { balanceCredits: 1000 } });
    const rows = await auditRows();
    expect(rows.map((r) => [r.action, r.actorUserId])).toEqual([['org.credit_adjust', staff.id]]);
  });

  it('set plan changes the tier; audited', async () => {
    const staff = await signInAs('superadmin');
    const { setPlanAction } = await freshActions();

    const out = await setPlanAction(orgId, {
      tierKey: 'pro',
      reason: 'Sales upgrade INV-204',
      requestId: 'adm_tier_1',
    });
    expect(out).toMatchObject({
      ok: true,
      result: { changed: true, tier: { key: 'pro' } },
    });
    expect(tierKey).toBe('pro');
    const rows = await auditRows();
    expect(rows.map((r) => [r.action, r.actorUserId])).toEqual([['org.plan_set', staff.id]]);
  });
});
