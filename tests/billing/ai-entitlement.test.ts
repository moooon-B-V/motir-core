import { describe, expect, it } from 'vitest';
import { hasAiEntitlement, isAiPaywallApplicable } from '@/lib/billing/aiEntitlement';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';

// The two entitlement predicates (Story MOTIR-2542 · Subtask MOTIR-2545).
//
// The case this exists for is the third one below: `applicable: false` with
// `hasPaidAiPlan: false` is the SENTINEL `getAiAccess` returns for a self-hosted
// build and for a `meta` organization — an org exempt from the paywall — and the
// org-settings page used to read the second field off it and conclude "no plan".
// A test that only covered "paid" and "not paid" would have passed throughout.

/** The inert sentinel — `notApplicableAiAccess()`'s exact field set. */
const NOT_APPLICABLE: AiAccessDTO = {
  applicable: false,
  organizationId: null,
  organizationName: null,
  canManageBilling: false,
  hasPaidAiPlan: false,
  balance: 0,
  tierName: null,
  tierAllotment: null,
  renewsAt: null,
};

const cloudOrg = (hasPaidAiPlan: boolean): AiAccessDTO => ({
  applicable: true,
  organizationId: 'org_1',
  organizationName: 'Acme',
  canManageBilling: true,
  hasPaidAiPlan,
  balance: hasPaidAiPlan ? 1000 : 0,
  tierName: hasPaidAiPlan ? 'Pro' : null,
  tierAllotment: hasPaidAiPlan ? 1000 : null,
  renewsAt: hasPaidAiPlan ? '2026-09-01T00:00:00.000Z' : null,
});

describe('isAiPaywallApplicable', () => {
  it('is false with no access context at all', () => {
    expect(isAiPaywallApplicable(null)).toBe(false);
    expect(isAiPaywallApplicable(undefined)).toBe(false);
  });

  it('is false for the not-applicable sentinel (self-host, and a meta org)', () => {
    expect(isAiPaywallApplicable(NOT_APPLICABLE)).toBe(false);
  });

  it('is true for a cloud org, whether or not it holds a plan', () => {
    expect(isAiPaywallApplicable(cloudOrg(false))).toBe(true);
    expect(isAiPaywallApplicable(cloudOrg(true))).toBe(true);
  });
});

describe('hasAiEntitlement', () => {
  it('is true when the paywall does not apply — INCLUDING the sentinel that also says hasPaidAiPlan: false', () => {
    // The whole defect in one assertion: `hasPaidAiPlan` is false here and the
    // answer is still yes, because the question does not apply.
    expect(NOT_APPLICABLE.hasPaidAiPlan).toBe(false);
    expect(hasAiEntitlement(NOT_APPLICABLE)).toBe(true);
  });

  it('is true with no resolvable access context', () => {
    expect(hasAiEntitlement(null)).toBe(true);
    expect(hasAiEntitlement(undefined)).toBe(true);
  });

  it('is true for a cloud org holding a paid plan', () => {
    expect(hasAiEntitlement(cloudOrg(true))).toBe(true);
  });

  it('is FALSE only for a cloud org on no paid plan — the one case that should see the upsell', () => {
    expect(hasAiEntitlement(cloudOrg(false))).toBe(false);
  });
});
