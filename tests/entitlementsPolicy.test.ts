import { describe, expect, it } from 'vitest';
import {
  PM_ENTITLEMENTS,
  entitlementsFor,
  pmTierForOrg,
  pmTierFromScaledTracker,
} from '@/lib/billing/entitlements';
import type { ScaledTrackerSubscription } from '@/lib/billing/scaledTrackerState';

// Pure-policy tests for the §4 tier resolver (no DB) — the meta-org exemption + the
// tier→caps table. The DB-backed enforcement lives in entitlementsService.test.ts.

const ACTIVE: ScaledTrackerSubscription = {
  status: 'active',
  priceId: 'tracker_annual',
  currentPeriodEnd: 1893456000,
};

describe('pmTierForOrg', () => {
  it('resolves the META org to the `meta` tier regardless of subscription', () => {
    expect(
      pmTierForOrg({ isMeta: true, scaledTrackerSubscription: null, aiIncludedSeat: false }),
    ).toBe('meta');
    expect(
      pmTierForOrg({ isMeta: true, scaledTrackerSubscription: ACTIVE, aiIncludedSeat: false }),
    ).toBe('meta');
    // META wins even over an AI-included seat.
    expect(
      pmTierForOrg({ isMeta: true, scaledTrackerSubscription: null, aiIncludedSeat: true }),
    ).toBe('meta');
  });

  it('defers to the scaled-tracker state for a non-meta org', () => {
    expect(
      pmTierForOrg({ isMeta: false, scaledTrackerSubscription: null, aiIncludedSeat: false }),
    ).toBe('free');
    expect(
      pmTierForOrg({ isMeta: false, scaledTrackerSubscription: ACTIVE, aiIncludedSeat: false }),
    ).toBe('scaled');
    // Mirrors pmTierFromScaledTracker exactly when not meta and no AI seat.
    expect(
      pmTierForOrg({ isMeta: false, scaledTrackerSubscription: ACTIVE, aiIncludedSeat: false }),
    ).toBe(pmTierFromScaledTracker(ACTIVE));
  });

  it('a PAID AI plan (aiIncludedSeat) lifts caps to `scaled`, even with no scaled-tracker sub (8.1.24)', () => {
    expect(
      pmTierForOrg({ isMeta: false, scaledTrackerSubscription: null, aiIncludedSeat: true }),
    ).toBe('scaled');
    // Clearing it (downgrade to free) re-applies the bounded tier.
    expect(
      pmTierForOrg({ isMeta: false, scaledTrackerSubscription: null, aiIncludedSeat: false }),
    ).toBe('free');
  });
});

describe('PM_ENTITLEMENTS.meta', () => {
  it('lifts every scale cap (its own row, distinct from enterprise)', () => {
    const meta = entitlementsFor('meta');
    expect(meta.maxWorkItems).toBeNull();
    expect(meta.maxProjects).toBeNull();
    expect(meta.maxWorkspaces).toBeNull();
    expect(meta.maxTotalStorageBytes).toBeNull();
    expect(PM_ENTITLEMENTS.meta).toBe(meta);
  });
});
