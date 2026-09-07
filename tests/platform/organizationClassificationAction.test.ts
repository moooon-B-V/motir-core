import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PlatformPrincipal } from '@/lib/platform/auth';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

/**
 * The classification Server ACTION (MOTIR-4568) — its five result codes.
 *
 * ⚠️ WHY THE CODES ARE THE SUBJECT. A throw out of a Server Action reaches the
 * browser as a generic digest with the message stripped in production, so an
 * operator who typed no reason, one who lost a race with a colleague, and a
 * database outage would all see the same opaque failure. The discriminated
 * result is what lets the dialog say WHICH — and a code that silently collapsed
 * into `FAILED` would look exactly like the shipped behaviour from every angle
 * except the operator's screen. So each arm is driven to a real refusal against
 * real Postgres rather than asserted from a stub.
 *
 * The action is TRANSPORT: every rule it reports lives in the service, which has
 * its own suite (`organizationClassification.test.ts`). What is asserted here is
 * the translation, and that a refusal writes nothing.
 */

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

vi.mock('@/lib/platform/auth', async () => {
  const actual = await vi.importActual<typeof import('@/lib/platform/auth')>('@/lib/platform/auth');
  return {
    ...actual,
    // The one `vi.mock` `CLAUDE.md` allows, at the platform tier's `getSession`
    // equivalent — the test environment has no cookies. The DEGREE is honoured
    // rather than waved through, so the `NOT_PERMITTED` case below exercises the
    // action's own `requirePlatformStaff('superadmin')` and not the mock.
    requirePlatformStaff: vi.fn(
      async (minimum: 'support' | 'operator' | 'superadmin' = 'support') => {
        const { NotPlatformStaffError } = await import('@/lib/platform/errors');
        if (!currentPrincipal) throw new NotPlatformStaffError();
        if (!actual.platformRoleAtLeast(currentPrincipal.role, minimum)) {
          throw new NotPlatformStaffError();
        }
        return currentPrincipal;
      },
    ),
  };
});

const { setInternalBillingAction } = await import('@/app/(admin)/admin/tenants/[orgId]/actions');

let currentPrincipal: PlatformPrincipal | null = null;
let seq = 0;

async function seedOperator(role: 'support' | 'operator' | 'superadmin' = 'superadmin') {
  const user = await createTestUser({ email: `ops+action-${role}-${seq++}@moooon.net` });
  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: role } });
  return { userId: user.id, email: user.email, role } satisfies PlatformPrincipal;
}

async function seedOrg(internalBilling = false) {
  return adminDb.organization.create({
    data: { name: 'Northwind Labs', slug: `northwind-act-${seq++}`, internalBilling },
  });
}

const auditRows = () => adminDb.platformAuditLog.findMany({ orderBy: { createdAt: 'asc' } });

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "platform_audit_log" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
  currentPrincipal = await seedOperator();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('setInternalBillingAction', () => {
  it('classifies an org and reports ok', async () => {
    const org = await seedOrg();

    const result = await setInternalBillingAction(org.id, true, 'Dogfood org (MOTIR-4337)');

    expect(result).toEqual({ ok: true });
    expect(
      (await adminDb.organization.findUnique({ where: { id: org.id } }))?.internalBilling,
    ).toBe(true);
    expect((await auditRows()).map((r) => r.action)).toEqual(['org.internal_billing_set']);
  });

  it('unclassifies an org and reports ok', async () => {
    const org = await seedOrg(true);

    const result = await setInternalBillingAction(org.id, false, 'Moved to a paying plan');

    expect(result).toEqual({ ok: true });
    expect(
      (await adminDb.organization.findUnique({ where: { id: org.id } }))?.internalBilling,
    ).toBe(false);
    expect((await auditRows()).map((r) => r.action)).toEqual(['org.internal_billing_unset']);
  });

  it('REASON_REQUIRED for a blank reason — and writes nothing', async () => {
    const org = await seedOrg();

    expect(await setInternalBillingAction(org.id, true, '   ')).toEqual({
      ok: false,
      code: 'REASON_REQUIRED',
    });
    expect(await auditRows()).toEqual([]);
    expect(
      (await adminDb.organization.findUnique({ where: { id: org.id } }))?.internalBilling,
    ).toBe(false);
  });

  it('NOT_FOUND for an org that does not exist', async () => {
    expect(await setInternalBillingAction('cmnot-a-real-id', true, 'A stale link')).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(await auditRows()).toEqual([]);
  });

  it('ALREADY_IN_STATE when a colleague got there first', async () => {
    const org = await seedOrg(true);

    expect(
      await setInternalBillingAction(org.id, true, 'A second operator, a minute later'),
    ).toEqual({ ok: false, code: 'ALREADY_IN_STATE' });
    expect(await auditRows()).toEqual([]);
  });

  it('NOT_PERMITTED for a principal below `superadmin` — not a crash, and not FAILED', async () => {
    const org = await seedOrg();

    // ⚠️ THE DEGREE IS THE POINT. `support` and `operator` both read this page
    // legitimately; the classification is a BILLING write, which ADR §7 puts at
    // `superadmin`. A generic `FAILED` here would tell an operator to retry
    // something that can never succeed for them.
    for (const role of ['support', 'operator'] as const) {
      currentPrincipal = await seedOperator(role);
      expect(await setInternalBillingAction(org.id, true, 'Reaching past my degree')).toEqual({
        ok: false,
        code: 'NOT_PERMITTED',
      });
    }

    currentPrincipal = null;
    expect(await setInternalBillingAction(org.id, true, 'Nobody at all')).toEqual({
      ok: false,
      code: 'NOT_PERMITTED',
    });
    expect(await auditRows()).toEqual([]);
  });

  it('is TRANSPORT ONLY — it opens no transaction and writes no audit row itself', async () => {
    // The grep criterion, as an assertion: every one of these lives in the
    // service, and a copy here would be a second place for the rule to drift.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(
      new URL('../../app/(admin)/admin/tenants/[orgId]/actions.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/prisma|withPlatformRead|PLATFORM_AUDIT/);
    // …and it DOES resolve the principal itself, because a Server Action is a
    // POST to a route the layout never renders (ADR §2's two-layer rule).
    expect(source).toContain("requirePlatformStaff('superadmin')");
  });
});
