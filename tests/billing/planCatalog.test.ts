import { describe, expect, it } from 'vitest';
import {
  BILLING_CATALOG,
  CHECKOUT_PRICE_LOOKUP_KEYS,
  INCLUDED_TRACKER_SEATS_PER_AI_PLAN,
  isAllowedCheckoutQuantity,
  maxMonthlyPlanCredits,
} from '@/lib/billing/catalog';

// MOTIR-8390 (story MOTIR-8379): the catalog carries pools 5,000 / 15,000 / 30,000,
// Max ×2 as a plan of its own, one included tracker seat per AI plan, the $5 top-up
// and no Enterprise entry. Figures are literals, never re-read from the catalog.

const plan = (key: string) => {
  const entry = BILLING_CATALOG.aiPlans.find((p) => p.key === key);
  if (!entry) throw new Error(`no ${key} entry`);
  return entry;
};

describe('the AI plan ladder', () => {
  it('lists Free, Standard, Pro, Max and Max ×2, and no Enterprise', () => {
    expect(BILLING_CATALOG.aiPlans.map((p) => p.key)).toEqual([
      'free',
      'standard',
      'pro',
      'max',
      'max_x2',
    ]);
  });

  it.each([
    ['standard', 5000, 25, 200, 'standard_pool_monthly', 'standard_pool_annual'],
    ['pro', 15000, 75, 600, 'pro_pool_monthly', 'pro_pool_annual'],
    ['max', 30000, 150, 1200, 'max_pool_monthly', 'max_pool_annual'],
    ['max_x2', 60000, 300, 2400, 'max_x2_pool_monthly', 'max_x2_pool_annual'],
  ])('%s grants %i a month at $%i / $%i a year', (key, credits, monthly, annual, mKey, aKey) => {
    const entry = plan(key);
    expect(entry.allotment).toEqual({ credits, cadence: 'monthly' });
    expect(entry.prices).toEqual({
      monthly: { amountUsd: monthly, priceLookupKey: mKey },
      annual: { amountUsd: annual, priceLookupKey: aKey },
    });
    expect(CHECKOUT_PRICE_LOOKUP_KEYS.has(mKey)).toBe(true);
    expect(CHECKOUT_PRICE_LOOKUP_KEYS.has(aKey)).toBe(true);
  });

  it('Max ×2 is named "Max ×2" and is exactly twice Max in credits and both prices', () => {
    const max = plan('max');
    const maxX2 = plan('max_x2');
    expect(maxX2.name).toBe('Max ×2');
    expect(maxX2.allotment?.credits).toBe(2 * (max.allotment?.credits ?? 0));
    expect(maxX2.prices?.annual.amountUsd).toBe(2 * (max.prices?.annual.amountUsd ?? 0));
    expect(maxX2.prices?.monthly.amountUsd).toBe(2 * (max.prices?.monthly.amountUsd ?? 0));
  });

  it('Free stays a one-time 300 with no price', () => {
    expect(plan('free').allotment).toEqual({ credits: 300, cadence: 'one_time' });
    expect(plan('free').prices).toBeNull();
  });

  it('every paid plan includes one tracker seat and Free none', () => {
    expect(
      Object.fromEntries(BILLING_CATALOG.aiPlans.map((p) => [p.key, p.includedTrackerSeats])),
    ).toEqual({ free: 0, standard: 1, pro: 1, max: 1, max_x2: 1 });
    expect(INCLUDED_TRACKER_SEATS_PER_AI_PLAN).toBe(1);
  });

  it('the largest monthly pool is 60,000', () => {
    expect(maxMonthlyPlanCredits()).toBe(60000);
  });

  it('carries no multiplier or per-seat field on an AI plan', () => {
    for (const entry of BILLING_CATALOG.aiPlans) {
      expect(Object.keys(entry).sort()).toEqual([
        'allotment',
        'includedTrackerSeats',
        'key',
        'name',
        'prices',
        'recommended',
      ]);
    }
  });
});

describe('the top-up and the seat fee', () => {
  it('sells 1,000 credits for $5 in 1× / 5× / 10× bundles under credit_topup', () => {
    expect(BILLING_CATALOG.creditTopup).toEqual({
      unitCredits: 1000,
      unitAmountUsd: 5,
      priceLookupKey: 'credit_topup',
      bundleUnits: [1, 5, 10],
    });
  });

  it('leaves the per-user seat fee exactly as it was', () => {
    expect(BILLING_CATALOG.seatPlan).toEqual({
      name: 'Motir',
      prices: {
        monthly: { amountUsd: 5, priceLookupKey: 'tracker_monthly' },
        annual: { amountUsd: 40, priceLookupKey: 'tracker_annual' },
      },
    });
    expect(CHECKOUT_PRICE_LOOKUP_KEYS.has('tracker_monthly')).toBe(true);
    expect(CHECKOUT_PRICE_LOOKUP_KEYS.has('tracker_annual')).toBe(true);
  });
});

describe('isAllowedCheckoutQuantity', () => {
  it('admits quantity 1 for every listed key, both Max ×2 keys included', () => {
    for (const key of CHECKOUT_PRICE_LOOKUP_KEYS) {
      expect(isAllowedCheckoutQuantity(key, 1)).toBe(true);
    }
  });

  it.each([
    'max_pool_annual',
    'max_x2_pool_annual',
    'max_x2_pool_monthly',
    'max_pool_monthly',
    'standard_pool_annual',
  ])('refuses %s at 2, 0 and a fraction', (key) => {
    expect(isAllowedCheckoutQuantity(key, 2)).toBe(false);
    expect(isAllowedCheckoutQuantity(key, 0)).toBe(false);
    expect(isAllowedCheckoutQuantity(key, 1.5)).toBe(false);
  });

  it('admits the top-up at its bundle sizes only', () => {
    expect([1, 2, 5, 10].map((q) => isAllowedCheckoutQuantity('credit_topup', q))).toEqual([
      true,
      false,
      true,
      true,
    ]);
  });

  it('treats the tracker seat keys as before: 1 only', () => {
    for (const key of ['tracker_monthly', 'tracker_annual']) {
      expect([1, 2, 5].map((q) => isAllowedCheckoutQuantity(key, q))).toEqual([true, false, false]);
    }
  });
});
