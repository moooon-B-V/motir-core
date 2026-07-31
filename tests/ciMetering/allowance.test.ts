import { describe, expect, it } from 'vitest';
import {
  CREDITS_PER_LINEAR_EQUIVALENT_MINUTE,
  INCLUDED_MINUTES_PER_SEAT,
  ORG_POOL_FLOOR_MINUTES,
  computeIncrementalCharge,
  resolvePool,
  resolveState,
} from '@/lib/ciMetering/allowance';

// The ENTITLEMENT policy in isolation (Story MOTIR-1775 · MOTIR-1901) — pure
// arithmetic, no DB. `docs/decisions/ci-minutes-allowance.md` §1, §2, §4.6, §6.5.
//
// These are the numbers that turn into money, so the constants are asserted
// against the ADR's own figures rather than against themselves: a silent edit to
// 300 or to the 1:1 rate has to break a test that names where the number came
// from.

describe('the constants match the ADR (§1, §1.2, §2.1)', () => {
  it('pins 300 min/seat, a 1,000-minute floor, and 1 credit per Linux-equivalent minute', () => {
    expect(INCLUDED_MINUTES_PER_SEAT).toBe(300);
    expect(ORG_POOL_FLOOR_MINUTES).toBe(1000);
    expect(CREDITS_PER_LINEAR_EQUIVALENT_MINUTE).toBe(1);
  });
});

describe('resolvePool — max(members × 300, 1000) (§1, §1.2)', () => {
  it.each([
    { members: 1, poolMinutes: 1000, floorApplied: true },
    { members: 3, poolMinutes: 1000, floorApplied: true }, // 900 < 1000 — floor binds
    { members: 4, poolMinutes: 1200, floorApplied: false }, // §1.2's stated crossover
    { members: 6, poolMinutes: 1800, floorApplied: false },
    { members: 8, poolMinutes: 2400, floorApplied: false },
  ])('$members members → $poolMinutes minutes', ({ members, poolMinutes, floorApplied }) => {
    expect(resolvePool(members)).toEqual({ memberCount: members, poolMinutes, floorApplied });
  });

  it('an org with no members still gets the floor — §4.3 gives EVERY org a pool', () => {
    // The no-scaled-tracker-subscription case resolves through the same formula;
    // a subscription-gated pool would refuse dispatches to a paying AI customer.
    expect(resolvePool(0)).toEqual({ memberCount: 0, poolMinutes: 1000, floorApplied: true });
  });

  it('floors a broken count at zero rather than producing a negative pool', () => {
    expect(resolvePool(-5).poolMinutes).toBe(1000);
    expect(resolvePool(Number.NaN).poolMinutes).toBe(1000);
  });
});

describe('computeIncrementalCharge — the watermark (§4.6)', () => {
  const base = { accountedMinutes: 0, chargedMinutes: 0, chargedCredits: 0, poolMinutes: 1000 };

  it('charges nothing while consumption is inside the pool', () => {
    const r = computeIncrementalCharge({ ...base, consumptionMinutes: 400 });
    expect(r).toMatchObject({ newMinutes: 400, chargeableMinutes: 0, creditsToDebit: 0 });
    expect(r.nextAccountedMinutes).toBe(400);
  });

  it('charges exactly the excess on the event that crosses the pool', () => {
    // 900 already accounted (all free), a 250-minute run lands: 100 free, 150 over.
    const r = computeIncrementalCharge({
      ...base,
      accountedMinutes: 900,
      consumptionMinutes: 1150,
    });
    expect(r.newMinutes).toBe(250);
    expect(r.chargeableMinutes).toBe(150);
    expect(r.creditsToDebit).toBe(150);
    expect(r.nextAccountedMinutes).toBe(1150);
  });

  it('charges the whole run once the pool is already spent', () => {
    const r = computeIncrementalCharge({
      ...base,
      accountedMinutes: 1200,
      chargedMinutes: 200,
      chargedCredits: 200,
      consumptionMinutes: 1239,
    });
    expect(r.chargeableMinutes).toBe(39);
    expect(r.creditsToDebit).toBe(39);
  });

  it('is IDEMPOTENT — a replay at the same consumption charges nothing', () => {
    const first = computeIncrementalCharge({ ...base, consumptionMinutes: 1150 });
    const replay = computeIncrementalCharge({
      ...base,
      accountedMinutes: first.nextAccountedMinutes,
      chargedMinutes: first.nextChargedMinutes,
      chargedCredits: first.nextChargedCredits,
      consumptionMinutes: 1150,
    });
    expect(replay.newMinutes).toBe(0);
    expect(replay.creditsToDebit).toBe(0);
  });

  it('is ORDER-INDEPENDENT — two runs bill the same total whichever lands first', () => {
    // Both orderings must reach 1,150 consumed / 150 charged against a 1,000 pool.
    const run = (steps: number[]) => {
      let s = { accounted: 0, minutes: 0, credits: 0 };
      let consumption = 0;
      for (const step of steps) {
        consumption += step;
        const r = computeIncrementalCharge({
          consumptionMinutes: consumption,
          accountedMinutes: s.accounted,
          chargedMinutes: s.minutes,
          chargedCredits: s.credits,
          poolMinutes: 1000,
        });
        s = {
          accounted: r.nextAccountedMinutes,
          minutes: r.nextChargedMinutes,
          credits: r.nextChargedCredits,
        };
      }
      return s;
    };
    expect(run([900, 250])).toEqual(run([250, 900]));
    expect(run([900, 250]).credits).toBe(150);
  });

  it('NEVER BACK-BILLS when the pool shrinks mid-period (§4.6, the load-bearing case)', () => {
    // 1,200 minutes consumed under a 4-member (1,200) pool: all free.
    const before = computeIncrementalCharge({
      ...base,
      poolMinutes: 1200,
      consumptionMinutes: 1200,
    });
    expect(before.creditsToDebit).toBe(0);

    // A member leaves → the pool drops to 1,000. A naive
    // `max(0, consumption - pool)` would now bill 200 minutes that were FREE when
    // they ran. The watermark means the shrink only affects the NEXT 50 minutes.
    const after = computeIncrementalCharge({
      accountedMinutes: before.nextAccountedMinutes,
      chargedMinutes: before.nextChargedMinutes,
      chargedCredits: before.nextChargedCredits,
      poolMinutes: 1000,
      consumptionMinutes: 1250,
    });
    expect(after.chargeableMinutes).toBe(50);
    expect(after.creditsToDebit).toBe(50);
  });

  it('a pool that GROWS mid-period makes the next minutes free again', () => {
    const after = computeIncrementalCharge({
      accountedMinutes: 1000,
      chargedMinutes: 0,
      chargedCredits: 0,
      poolMinutes: 1500,
      consumptionMinutes: 1300,
    });
    expect(after.chargeableMinutes).toBe(0);
  });

  it('CARRIES the sub-credit remainder instead of rounding it away (§2)', () => {
    // 1,000.4 consumed against a 1,000 pool: 0.4 chargeable, no whole credit yet.
    const first = computeIncrementalCharge({ ...base, consumptionMinutes: 1000.4 });
    expect(first.chargeableMinutes).toBeCloseTo(0.4, 5);
    expect(first.creditsToDebit).toBe(0);
    expect(first.nextChargedCredits).toBe(0);

    // A further 0.4 makes 0.8 — still under a credit.
    const second = computeIncrementalCharge({
      ...base,
      accountedMinutes: first.nextAccountedMinutes,
      chargedMinutes: first.nextChargedMinutes,
      chargedCredits: first.nextChargedCredits,
      consumptionMinutes: 1000.8,
    });
    expect(second.creditsToDebit).toBe(0);

    // 1.2 total → the carry finally bills ONE credit, not two and not zero.
    const third = computeIncrementalCharge({
      ...base,
      accountedMinutes: second.nextAccountedMinutes,
      chargedMinutes: second.nextChargedMinutes,
      chargedCredits: second.nextChargedCredits,
      consumptionMinutes: 1001.2,
    });
    expect(third.creditsToDebit).toBe(1);
    expect(third.nextChargedCredits).toBe(1);
  });

  it('never moves the watermark backwards on a stale consumption read', () => {
    const r = computeIncrementalCharge({
      ...base,
      accountedMinutes: 1500,
      chargedMinutes: 500,
      chargedCredits: 500,
      consumptionMinutes: 1200, // a racer already accounted past this
    });
    expect(r.newMinutes).toBe(0);
    expect(r.creditsToDebit).toBe(0);
    expect(r.nextAccountedMinutes).toBe(1500);
  });
});

describe('resolveState — two thresholds, never conflated (§6.5)', () => {
  it('is within_allowance below the pool, whatever the balance', () => {
    expect(resolveState({ consumptionMinutes: 400, poolMinutes: 1000, balance: 0 })).toBe(
      'within_allowance',
    );
    expect(resolveState({ consumptionMinutes: 999, poolMinutes: 1000, balance: -50 })).toBe(
      'within_allowance',
    );
  });

  it('draws on credits past the pool while the balance is positive', () => {
    expect(resolveState({ consumptionMinutes: 1200, poolMinutes: 1000, balance: 500 })).toBe(
      'drawing_on_credits',
    );
  });

  it('is exhausted past the pool at balance <= 0', () => {
    expect(resolveState({ consumptionMinutes: 1000, poolMinutes: 1000, balance: 0 })).toBe(
      'ci_credits_exhausted',
    );
    expect(resolveState({ consumptionMinutes: 1200, poolMinutes: 1000, balance: -39 })).toBe(
      'ci_credits_exhausted',
    );
  });

  it('an UNKNOWN balance is never exhaustion — the gate must not fail closed on an outage', () => {
    expect(resolveState({ consumptionMinutes: 1200, poolMinutes: 1000, balance: null })).toBe(
      'drawing_on_credits',
    );
  });
});
