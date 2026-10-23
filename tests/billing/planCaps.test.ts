import { describe, expect, it } from 'vitest';
import { BILLING_CATALOG } from '@/lib/billing/catalog';
import {
  HOST_PLAN_KEY,
  LARGER_POOL_CAPS,
  capsForPlanKey,
  type PlanCaps,
} from '@/lib/billing/planCaps';

// THE PLAN-CAPS TABLE (Story MOTIR-9363 · MOTIR-9372): the owner's figures per
// plan key, and the totality that keeps the table in step with the catalog.

function figures(c: PlanCaps | null): [number, number, number, number] | null {
  return c ? [c.agentRunsInParallel, c.agentsPerUser, c.agentsRunningPerOrg, c.ciBurstCap] : null;
}

describe('capsForPlanKey — the table', () => {
  it.each([
    ['free', [0, 0, 0, 0]],
    ['standard', [1, 1, 5, 5]],
    ['pro', [3, 5, 30, 10]],
    ['max', [5, 10, 50, 25]],
    ['max_x2', [5, 10, 50, 25]],
    [HOST_PLAN_KEY, [5, 10, 50, 50]],
  ] as const)('%s → %j', (key, expected) => {
    expect(figures(capsForPlanKey(key))).toEqual(expected);
  });

  it('every larger pool in the catalog takes the interim larger-pool row (5/10/50/50)', () => {
    const pools = BILLING_CATALOG.aiPlans.filter((p) => /^pool_\d+k$/.test(p.key));
    expect(pools.length).toBeGreaterThan(0);
    for (const plan of pools) {
      expect(figures(capsForPlanKey(plan.key)), plan.key).toEqual([5, 10, 50, 50]);
      expect(capsForPlanKey(plan.key)).toBe(LARGER_POOL_CAPS);
    }
  });

  it('a pool key the catalog does not list yet still has the pool shape, so it is capped', () => {
    expect(figures(capsForPlanKey('pool_999k'))).toEqual([5, 10, 50, 50]);
  });
});

describe('capsForPlanKey — totality, and never a default', () => {
  it('every AI plan in the catalog, plus host, has a row', () => {
    const keys = [...BILLING_CATALOG.aiPlans.map((p) => p.key as string), HOST_PLAN_KEY];
    const missing = keys.filter((key) => capsForPlanKey(key) === null);
    expect(missing, `plan keys with no caps row: ${missing.join(', ')}`).toEqual([]);
  });

  it.each(['legacy_tier', '', 'max_x3', 'pool_k', 'enterprise', 'MAX', 'pool_80k_extra'])(
    '%j has no row',
    (key) => {
      expect(capsForPlanKey(key)).toBeNull();
    },
  );

  it("max_x2 never resolves to max's row by prefix, nor max to max_x2's", () => {
    expect(capsForPlanKey('max_x2')!.ciBurstCap).toBe(25);
    expect(capsForPlanKey('max_x2')).not.toBe(capsForPlanKey('max'));
  });

  it('inherited object keys are not plans', () => {
    expect(capsForPlanKey('toString')).toBeNull();
    expect(capsForPlanKey('__proto__')).toBeNull();
  });
});
