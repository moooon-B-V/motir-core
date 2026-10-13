import { describe, expect, it } from 'vitest';
import {
  BILLING_CATALOG,
  CHECKOUT_PRICE_LOOKUP_KEYS,
  INCLUDED_TRACKER_SEATS_PER_AI_PLAN,
  isAllowedCheckoutQuantity,
  isKnownCheckoutPrice,
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

// MOTIR-8392 — the story's catalog gate: the rest of the figures and the guard's
// full truth table, pinned as literals so any drift fails here.
describe('the catalog gate (MOTIR-8392)', () => {
  const PAID = ['standard', 'pro', 'max', 'max_x2'] as const;
  const AI_KEYS = PAID.flatMap((k) => [`${k}_pool_monthly`, `${k}_pool_annual`]);

  it('has exactly three top-level members and no plan-count field', () => {
    expect(Object.keys(BILLING_CATALOG).sort()).toEqual(['aiPlans', 'creditTopup', 'seatPlan']);
  });

  it('prices every paid plan on both cadences, under _pool_monthly / _pool_annual keys', () => {
    for (const key of PAID) {
      const prices = plan(key).prices!;
      expect(Object.keys(prices).sort()).toEqual(['annual', 'monthly']);
      expect(prices.monthly.priceLookupKey).toBe(`${key}_pool_monthly`);
      expect(prices.annual.priceLookupKey).toBe(`${key}_pool_annual`);
    }
  });

  it('carries no Enterprise trace on any entry: no key, label or contact-sales field', () => {
    const text = JSON.stringify(BILLING_CATALOG).toLowerCase();
    expect(text).not.toContain('enterprise');
    expect(text).not.toContain('contact');
  });

  it('exposes no cost or margin figure anywhere', () => {
    const keys: string[] = [];
    const walk = (v: unknown) => {
      if (v && typeof v === 'object') {
        for (const [k, child] of Object.entries(v)) {
          keys.push(k);
          walk(child);
        }
      }
    };
    walk(BILLING_CATALOG);
    for (const banned of ['cost', 'margin', 'unitCost', 'multiples', 'quantity', 'perSeat']) {
      expect(keys).not.toContain(banned);
    }
  });

  it('states the included seat once: a non-negative integer, equal on every paid plan', () => {
    for (const entry of BILLING_CATALOG.aiPlans) {
      expect(Number.isInteger(entry.includedTrackerSeats)).toBe(true);
      expect(entry.includedTrackerSeats).toBeGreaterThanOrEqual(0);
    }
    for (const key of PAID) {
      expect(plan(key).includedTrackerSeats).toBe(INCLUDED_TRACKER_SEATS_PER_AI_PLAN);
    }
  });

  it('keeps the seat plan apart from the AI plans', () => {
    const seat = BILLING_CATALOG.seatPlan as unknown as Record<string, unknown>;
    expect(seat['allotment']).toBeUndefined();
    expect(seat['includedTrackerSeats']).toBeUndefined();
    const aiKeys = BILLING_CATALOG.aiPlans.flatMap((p) =>
      p.prices ? [p.prices.monthly.priceLookupKey, p.prices.annual.priceLookupKey] : [],
    );
    expect(aiKeys.filter((k) => k.startsWith('tracker_'))).toEqual([]);
  });

  it('maxMonthlyPlanCredits is the largest monthly pool across the entries', () => {
    const pools = BILLING_CATALOG.aiPlans
      .filter((p) => p.allotment?.cadence === 'monthly')
      .map((p) => p.allotment!.credits);
    expect(maxMonthlyPlanCredits()).toBe(Math.max(...pools));
  });

  it('prices a top-up credit at $0.005, bundles at $5 / $25 / $50', () => {
    const t = BILLING_CATALOG.creditTopup;
    expect(t.unitAmountUsd / t.unitCredits).toBeCloseTo(0.005, 6);
    expect(t.bundleUnits.map((u) => u * t.unitAmountUsd)).toEqual([5, 25, 50]);
  });

  it('pins the credit price: Max and Max ×2 match per cadence, top-up is 1.5× annual', () => {
    const perAnnual = (key: string) =>
      plan(key).prices!.annual.amountUsd / (12 * plan(key).allotment!.credits);
    const perMonthly = (key: string) =>
      plan(key).prices!.monthly.amountUsd / plan(key).allotment!.credits;
    const topup =
      BILLING_CATALOG.creditTopup.unitAmountUsd / BILLING_CATALOG.creditTopup.unitCredits;
    expect(perAnnual('max')).toBeCloseTo(0.00333, 5);
    expect(perAnnual('max_x2')).toBeCloseTo(0.00333, 5);
    expect(perMonthly('max')).toBeCloseTo(0.005, 6);
    expect(perMonthly('max_x2')).toBeCloseTo(0.005, 6);
    expect(topup).toBeCloseTo(perMonthly('max'), 6);
    expect(topup / perAnnual('max')).toBeCloseTo(1.5, 5);
  });

  it.each(AI_KEYS)('never admits %s above or below 1', (key) => {
    expect(isAllowedCheckoutQuantity(key, 1)).toBe(true);
    for (const q of [2, 3, 0, -1, 1.5, Number.NaN]) {
      expect(isAllowedCheckoutQuantity(key, q)).toBe(false);
    }
  });

  it('refuses an unlisted key above 1, and the top-up off its bundles', () => {
    expect(isAllowedCheckoutQuantity('not_a_price', 2)).toBe(false);
    expect(isAllowedCheckoutQuantity('credit_topup', 2)).toBe(false);
    expect(isAllowedCheckoutQuantity('credit_topup', 20)).toBe(false);
  });

  it('reads the bundle rule from the data, while the plan rule stays 1', () => {
    const original = BILLING_CATALOG.creditTopup;
    BILLING_CATALOG.creditTopup = { ...original, bundleUnits: [1, 3] };
    try {
      expect(isAllowedCheckoutQuantity('credit_topup', 3)).toBe(true);
      expect(isAllowedCheckoutQuantity('credit_topup', 5)).toBe(false);
      expect(isAllowedCheckoutQuantity('max_x2_pool_annual', 3)).toBe(false);
    } finally {
      BILLING_CATALOG.creditTopup = original;
    }
  });

  it('knows every listed key and no other', () => {
    expect(isKnownCheckoutPrice('max_x2_pool_monthly')).toBe(true);
    expect(isKnownCheckoutPrice('enterprise_pool_annual')).toBe(false);
  });

  it('takes no organisation input: the guard is (key, quantity) only', () => {
    expect(isAllowedCheckoutQuantity.length).toBe(2);
  });
});
