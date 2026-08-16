import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../helpers/adminDb';
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
// ⚠️ The motir-ai client is stubbed here because the NON-meta path genuinely
// crosses that boundary. The meta path no longer does: MOTIR-2594 moved the org
// row read ahead of the `Promise.all` so `isMeta` short-circuits before either
// remote call is issued. This suite is where that is held — the call counters
// below assert ZERO for a meta org, and `aiCalls.rejects` proves the answer
// survives a motir-ai outage rather than merely avoiding it on the happy path.

const aiCalls = vi.hoisted(() => ({ usage: 0, subscription: 0, rejects: false }));

vi.mock('@/lib/ai/motirAiClient', () => ({
  getOrgUsage: vi.fn(async () => {
    aiCalls.usage += 1;
    if (aiCalls.rejects) throw new Error('motir-ai is down');
    return { balance: 0, tier: null };
  }),
  getOrgSubscription: vi.fn(async () => {
    aiCalls.subscription += 1;
    if (aiCalls.rejects) throw new Error('motir-ai is down');
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
  const ws = await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
  return { owner, organizationId: ws.organizationId };
}

beforeEach(async () => {
  vi.clearAllMocks();
  aiCalls.usage = 0;
  aiCalls.subscription = 0;
  aiCalls.rejects = false;
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
  await adminDb.$disconnect();
});

describe('the meta organization, end to end from the database row', () => {
  it('is ENTITLED — the real service reads isMeta and the predicate says yes', async () => {
    const { owner, organizationId } = await orgWithOwner('moooon');
    await adminDb.organization.update({ where: { id: organizationId }, data: { isMeta: true } });

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
    await adminDb.organization.update({ where: { id: organizationId }, data: { isMeta: true } });

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

    await adminDb.organization.update({ where: { id: organizationId }, data: { isMeta: true } });

    expect(
      hasAiEntitlement(await billingService.getAiAccess({ actorUserId: owner.id, organizationId })),
    ).toBe(true);
  });

  it('documents the boundary crossing a meta org does not need (see the logged bug)', async () => {
    const { owner, organizationId } = await orgWithOwner('moooon');
    await adminDb.organization.update({ where: { id: organizationId }, data: { isMeta: true } });

    await billingService.getAiAccess({ actorUserId: owner.id, organizationId });

    // MOTIR-2594 flipped these from 1 to 0. The assertion was written while the
    // defect was live, deliberately recording the behaviour so the fix would have
    // a test waiting for it; this is that flip. A meta org's answer is decided by
    // a local column, so it must cross the boundary ZERO times — if either count
    // returns to 1, the org read has drifted back into the `Promise.all`.
    expect(aiCalls.usage).toBe(0);
    expect(aiCalls.subscription).toBe(0);
  });

  it('survives a motir-ai OUTAGE — the exempt sentinel is returned, not a thrown error', async () => {
    const { owner, organizationId } = await orgWithOwner('moooon');
    await adminDb.organization.update({ where: { id: organizationId }, data: { isMeta: true } });
    // Every motir-ai read now REJECTS. This is the availability half of the bug:
    // before the fix, `getAiAccess` awaited both reads inside a `Promise.all`
    // before looking at `isMeta`, so this case threw and `/settings/organization`
    // failed for the meta org — during an outage of the very service the page had
    // just established it does not need.
    aiCalls.rejects = true;

    const access = await billingService.getAiAccess({ actorUserId: owner.id, organizationId });

    expect(access.applicable).toBe(false);
    expect(hasAiEntitlement(access)).toBe(true);
    expect(aiCalls.usage).toBe(0);
    expect(aiCalls.subscription).toBe(0);
  });

  it('a NON-meta org still crosses the boundary — the short-circuit narrowed the path, it did not remove it', async () => {
    const { owner, organizationId } = await orgWithOwner('Acme');

    await billingService.getAiAccess({ actorUserId: owner.id, organizationId });

    // The other side of the flip above: the two reads are still made, still in
    // parallel, for every org the exemption does not cover.
    expect(aiCalls.usage).toBe(1);
    expect(aiCalls.subscription).toBe(1);
  });
});
