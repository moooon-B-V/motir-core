import { describe, expect, it } from 'vitest';
import type { BillingStatusDTO } from '@/lib/dto/billing';
import { buildOrgBill } from '@/lib/platform/orgBill';

/** This month's bill on the operator's Billing tab (Story MOTIR-727 · MOTIR-7289). */

function status(
  over: Partial<Omit<BillingStatusDTO, 'access'>> = {},
): Omit<BillingStatusDTO, 'access'> {
  return {
    organizationId: 'org_1',
    isMeta: false,
    internalBilling: false,
    motir: {
      scaledTrackerSubscription: {
        status: 'active',
        priceId: 'tracker_monthly',
        currentPeriodEnd: 1_791_000_000,
      },
      aiIncludedSeat: false,
    },
    motirAi: {
      tier: { key: 'pro', name: 'Pro', monthlyCreditAllotment: 8000 },
      balance: 1200,
      subscription: {
        status: 'active',
        currentPeriodEnd: '2026-10-15T00:00:00.000Z',
        priceId: 'pro_pool_monthly',
        planTier: { key: 'pro', name: 'Pro', monthlyCreditAllotment: 8000 },
      },
    },
    ci: { chargedCredits: 68 } as never,
    search: { monthSpend: 41, totalSpend: 300 } as never,
    agents: { spend: { machineMonthSpend: 120, storageMonthSpend: 30 }, hasPaidAiPlan: true },
    catalog: undefined as never,
    ...over,
  };
}

describe('buildOrgBill', () => {
  it('bills seats × the catalog price and the AI plan fee in whole cents, and totals only those', () => {
    const bill = buildOrgBill(status(), 48);
    expect(bill.money).toEqual([
      {
        key: 'seats',
        basis: { seats: 48, unitCents: 500, cadence: 'monthly' },
        amountCents: 24_000,
      },
      { key: 'aiPlan', basis: { credits: 8000, cadence: 'monthly' }, amountCents: 7_500 },
    ]);
    expect(bill.totalCents).toBe(31_500);
    expect(Number.isInteger(bill.totalCents)).toBe(true);
  });

  it('lists CI, search and agents as CREDITS drawn from the pool — never in the money total', () => {
    const bill = buildOrgBill(status(), 2);
    expect(bill.credits).toEqual([
      { key: 'ci', credits: 68 },
      { key: 'search', credits: 41 },
      { key: 'agents', credits: 150 },
    ]);
    expect(bill.totalCents).toBe(2 * 500 + 7_500);
  });

  it('an unreadable credit figure is null, never a zero', () => {
    const bill = buildOrgBill(
      status({ search: null, agents: { spend: null, hasPaidAiPlan: true } }),
      1,
    );
    expect(bill.credits.find((l) => l.key === 'search')!.credits).toBeNull();
    expect(bill.credits.find((l) => l.key === 'agents')!.credits).toBeNull();
  });

  it('annual seats and an annual AI plan use their yearly prices; the seat a paid AI plan includes is not billed twice', () => {
    const bill = buildOrgBill(
      status({
        motir: {
          scaledTrackerSubscription: {
            status: 'active',
            priceId: 'tracker_annual',
            currentPeriodEnd: 1_791_000_000,
          },
          aiIncludedSeat: true,
        },
        motirAi: {
          tier: { key: 'pro', name: 'Pro', monthlyCreditAllotment: 8000 },
          balance: 0,
          subscription: {
            status: 'active',
            currentPeriodEnd: null,
            priceId: 'pro_pool_annual',
            planTier: null,
          },
        },
      }),
      10,
    );
    expect(bill.money).toEqual([
      {
        key: 'seats',
        basis: { seats: 9, unitCents: 4_000, cadence: 'annual' },
        amountCents: 36_000,
      },
      { key: 'aiPlan', basis: { credits: 8000, cadence: 'annual' }, amountCents: 60_000 },
    ]);
  });

  it('a free org has no money line; the charge date is the earliest renewal', () => {
    const free = buildOrgBill(
      status({
        motir: { scaledTrackerSubscription: null, aiIncludedSeat: false },
        motirAi: {
          tier: { key: 'free', name: 'Free', monthlyCreditAllotment: 300 },
          balance: 300,
          subscription: { status: null, currentPeriodEnd: null, priceId: null, planTier: null },
        },
      }),
      3,
    );
    expect(free).toMatchObject({ money: [], totalCents: 0, chargeDate: null });
    expect(buildOrgBill(status(), 1).chargeDate).toBe(new Date(1_791_000_000 * 1000).toISOString());
  });
});
