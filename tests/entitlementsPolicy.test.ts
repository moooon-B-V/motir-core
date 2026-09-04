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

describe('the custom-domain cap (Story MOTIR-3878 · `public-tenant-addresses.md` §9)', () => {
  it('gates the CUSTOMER DOMAIN and nothing else — the subdomain has no cap', () => {
    // The split every mirror in the category draws, and the one this story
    // ships: a working default address for everyone, an owned address for
    // customers who pay. There is deliberately no `workspace_subdomains` kind.
    expect(PM_ENTITLEMENTS.free.maxCustomDomains).toBe(0);
    expect(PM_ENTITLEMENTS.scaled.maxCustomDomains).toBe(5);
    expect(PM_ENTITLEMENTS.enterprise.maxCustomDomains).toBeNull();
    expect(PM_ENTITLEMENTS.meta.maxCustomDomains).toBeNull();
  });

  it('is TOTAL over PmTier — every row carries a value', () => {
    // `PM_ENTITLEMENTS` is `Record<PmTier, PmEntitlements>`, so a missing row is
    // a compile error rather than a runtime `undefined`. This asserts the
    // property at runtime too, because a `Record` cannot catch a row that
    // carries the key with `undefined` behind a loosened type.
    for (const [tier, caps] of Object.entries(PM_ENTITLEMENTS)) {
      expect(caps, `${tier} must carry maxCustomDomains`).toHaveProperty('maxCustomDomains');
      const value = caps.maxCustomDomains;
      expect(
        value === null || typeof value === 'number',
        `${tier}.maxCustomDomains must be a number or null, got ${String(value)}`,
      ).toBe(true);
    }
  });

  it('makes `free: 0` refuse the FIRST domain, not the sixth', () => {
    // The value is 0 rather than absent on purpose: it makes the refusal the
    // upgrade prompt's trigger instead of an empty state the pane has to
    // special-case. `0` and `null` are opposite meanings here and a reader
    // skimming the table could take either for "no cap".
    expect(PM_ENTITLEMENTS.free.maxCustomDomains).toBe(0);
    expect(PM_ENTITLEMENTS.free.maxCustomDomains).not.toBeNull();
  });
});
