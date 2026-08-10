import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { truncateAuthTables } from '../helpers/db';
import { createTestUser } from '../fixtures/userFixtures';

// The story-level seam for MOTIR-2542 §2 — the ONE thing neither half of
// MOTIR-2545's own tests can see.
//
// Those tests prove two things separately: that `hasAiEntitlement` returns true
// for a hand-built not-applicable sentinel, and that the acceptance-video card
// renders correctly when handed `hasPlan: true`. Both are true and neither could
// have caught the defect, because the sentinel in production is not hand-built —
// it is produced by `billingService.getAiAccess` reading `Organization.isMeta`
// off a real row. A stand-in is made from the same understanding that made the
// code, so it agrees with it by construction.
//
// So this drives the REAL service against a REAL organization row and follows
// the value all the way to the flag the settings page hands the card.
//
// ⚠️ The motir-ai client IS stubbed here, and that is a finding rather than a
// convenience: `getAiAccess` runs `getOrgUsage` + `getOrgSubscription` inside a
// `Promise.all` BEFORE it checks `isMeta`, so a meta organization — whose answer
// is decided entirely by a local column — still makes two cross-service calls,
// and a motir-ai outage would propagate a `MotirAiError` to a page that does not
// need motir-ai to answer. Logged separately; this suite stubs the boundary the
// method actually crosses rather than asserting a short-circuit that does not
// exist.

const aiCalls = vi.hoisted(() => ({ usage: 0, subscription: 0 }));

vi.mock('@/lib/ai/motirAiClient', () => ({
  getOrgUsage: vi.fn(async () => {
    aiCalls.usage += 1;
    return { balance: 0, tier: null };
  }),
  getOrgSubscription: vi.fn(async () => {
    aiCalls.subscription += 1;
    return { status: null, currentPeriodEnd: null };
  }),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
}));

const { billingService } = await import('@/lib/services/billingService');
const { hasAiEntitlement, isAiPaywallApplicable } = await import('@/lib/billing/aiEntitlement');
const { workspacesService } = await import('@/lib/services/workspacesService');

/** An organization with an owner, and its id. */
async function orgWithOwner(name = 'Acme') {
  const owner = await createTestUser();
  const { workspace } = await workspacesService.createWorkspace({ name, ownerUserId: owner.id });
  const ws = await db.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
  return { owner, organizationId: ws.organizationId };
}

beforeEach(async () => {
  vi.clearAllMocks();
  aiCalls.usage = 0;
  aiCalls.subscription = 0;
  // The paywall only exists on a cloud build; off-cloud `getAiAccess`
  // short-circuits before any read and the seam under test never runs.
  vi.stubEnv('MOTIR_CLOUD', 'true');
  await truncateAuthTables();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('the meta organization, end to end from the database row', () => {
  it('is ENTITLED — the real service reads isMeta and the predicate says yes', async () => {
    const { owner, organizationId } = await orgWithOwner('moooon');
    await db.organization.update({ where: { id: organizationId }, data: { isMeta: true } });

    const access = await billingService.getAiAccess({
      actorUserId: owner.id,
      organizationId,
    });

    // The sentinel, produced for real rather than hand-written.
    expect(access.applicable).toBe(false);
    expect(access.hasPaidAiPlan).toBe(false);

    // And the two questions the surfaces ask of it.
    expect(isAiPaywallApplicable(access)).toBe(false);
    expect(hasAiEntitlement(access)).toBe(true);
  });

  it('the settings page derivation hands the card hasPlan: TRUE for a meta org', async () => {
    const { owner, organizationId } = await orgWithOwner('moooon');
    await db.organization.update({ where: { id: organizationId }, data: { isMeta: true } });

    // Exactly the expression `app/(authed)/settings/organization/page.tsx`
    // evaluates. If someone re-introduces the direct `hasPaidAiPlan` read, this
    // is the assertion that goes red — reading that field here would yield
    // `false` and hand the meta org an Upgrade button.
    const hasAcceptancePlan = hasAiEntitlement(
      await billingService.getAiAccess({ actorUserId: owner.id, organizationId }),
    );

    expect(hasAcceptancePlan).toBe(true);
  });

  it('a NON-meta org on no paid plan is still gated — the fix narrowed the denial, it did not remove it', async () => {
    const { owner, organizationId } = await orgWithOwner('Acme');

    const access = await billingService.getAiAccess({ actorUserId: owner.id, organizationId });

    expect(access.applicable).toBe(true);
    expect(access.hasPaidAiPlan).toBe(false);
    expect(hasAiEntitlement(access)).toBe(false);
  });

  it('the meta exemption comes from the ROW, not from the org id — flipping the column flips the answer', async () => {
    const { owner, organizationId } = await orgWithOwner('Acme');

    expect(
      hasAiEntitlement(await billingService.getAiAccess({ actorUserId: owner.id, organizationId })),
    ).toBe(false);

    await db.organization.update({ where: { id: organizationId }, data: { isMeta: true } });

    expect(
      hasAiEntitlement(await billingService.getAiAccess({ actorUserId: owner.id, organizationId })),
    ).toBe(true);
  });

  it('documents the boundary crossing a meta org does not need (see the logged bug)', async () => {
    const { owner, organizationId } = await orgWithOwner('moooon');
    await db.organization.update({ where: { id: organizationId }, data: { isMeta: true } });

    await billingService.getAiAccess({ actorUserId: owner.id, organizationId });

    // This asserts CURRENT behaviour, deliberately: both motir-ai reads happen
    // even though the answer is decided locally. When the logged bug is fixed,
    // this expectation flips to 0 and the fix has a test waiting for it — which
    // is more useful than leaving the behaviour unasserted and unnoticed.
    expect(aiCalls.usage).toBe(1);
    expect(aiCalls.subscription).toBe(1);
  });
});
