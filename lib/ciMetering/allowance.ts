// The CI-minutes ENTITLEMENT policy (Story MOTIR-1775 · MOTIR-1901) — the pure
// numbers half of `docs/decisions/ci-minutes-allowance.md`: how big an org's
// included pool is (§1), what a minute costs once the pool is gone (§2), and
// which of the three states an org is in (§6.5).
//
// PURE CONFIG + RESOLVERS — no DB, no Stripe, no cloud check, no clock. This
// mirrors `lib/billing/entitlements.ts` (the shipped tier→caps policy module)
// deliberately, and §8.4 is why it is a SEPARATE module rather than a row in
// `PM_ENTITLEMENTS`: that map is tier → caps, whereas this pool is SEAT-derived
// and tier-INDEPENDENT (§1.4). Counting members, reading balances and deciding
// what to debit all belong to `ciAllowanceService`; this file only answers
// arithmetic questions.

/**
 * §1 — included Linux-equivalent minutes per seat, per calendar month.
 *
 * At full drain this costs Motir 300 × $0.006 = $1.80 per seat per month and buys
 * ~7–8 dispatches (§Context puts a merged dispatch at ~39 Linux minutes). The ADR
 * measures that against TOTAL org revenue rather than the $5 seat line alone —
 * consuming the pool requires dispatches, which require a plan, which burns
 * credits, so an org that drains this necessarily holds a paid AI plan (§1.1).
 *
 * It does NOT vary by tier or billing cadence (§1.4). The named revisit trigger
 * is measured consumption showing a tier's median org routinely past its pool
 * while a cheaper tier's sits under half — a datum MOTIR-1896's meter produces.
 */
export const INCLUDED_MINUTES_PER_SEAT = 300;

/**
 * §1.2 — the per-org FLOOR, in Linux-equivalent minutes per calendar month.
 *
 * A pure `seats × 300` pool starves exactly the user this hosting model exists
 * for: the solo founder whose whole project lives in Motir's org and who has no
 * second machine to run CI on. The floor binds for orgs of 1–3 members
 * (3 × 300 = 900 < 1,000); a 4-person org (1,200) clears it. At full drain it
 * costs $6.00/org/month — 24% of the $25 Standard AI plan such an org holds.
 */
export const ORG_POOL_FLOOR_MINUTES = 1000;

/**
 * §2.1 — the overage rate: 1 credit per Linux-equivalent minute.
 *
 * §2.2 states the margin rather than burying it: a credit retails at ~$0.01 (the
 * 1,000-for-$10 top-up) against a $0.006 Linux minute — a 40% gross margin, and
 * exactly GitLab's published extra-compute price. A SINGLE blended number is
 * correct here only because the METER already normalized every runner to
 * Linux-equivalents by COST ratio (§3, §2.3): a blended rate over raw wall clock
 * would be a lie, since one macOS minute costs 10.33× a Linux one.
 */
export const CREDITS_PER_LINEAR_EQUIVALENT_MINUTE = 1;

/** The three states of §6.5, plus the bypass row. */
export type CiEntitlementStateName =
  /** Period consumption is under the pool — dispatch allowed, nothing charged. */
  | 'within_allowance'
  /** Past the pool with a positive balance — dispatch allowed, overage charged. */
  | 'drawing_on_credits'
  /** Past the pool at balance ≤ 0 — the next dispatch is REFUSED. */
  | 'ci_credits_exhausted'
  /** `isMeta`, or `MOTIR_CLOUD=false` — no pool accounting at all (§4.4/§8.5). */
  | 'bypassed';

/** How an org's pool was arrived at — what §7.3.2 renders in words. */
export interface CiPoolResolution {
  /** Org membership count the pool was derived from (§4.2). */
  memberCount: number;
  /** The resulting pool, in Linux-equivalent minutes for the calendar month. */
  poolMinutes: number;
  /** True when the §1.2 floor bound (i.e. `members × 300 < 1000`). */
  floorApplied: boolean;
}

/**
 * §1 — an org's included pool: `max(members × 300, 1000)` Linux-equivalent
 * minutes per calendar month.
 *
 * The count is the ORG MEMBERSHIP COUNT, never the Stripe scaled-tracker quantity
 * (§4.2): the shipped seat sync is an absolute recompute of membership pushed TO
 * Stripe, so membership is upstream and the Stripe quantity is a lagging mirror
 * of it — deriving the pool from the mirror would lag a lagging copy of a number
 * motir-core holds directly. An org with NO scaled-tracker subscription still
 * gets a pool from the same formula (§4.3); the free-AI-tier org is bounded by
 * the credit gate, not by the pool.
 *
 * A negative or non-finite count is floored at zero, so the result is never worse
 * than the §1.2 floor — the safe direction for a caller that somehow reads a
 * broken count.
 */
export function resolvePool(memberCount: number): CiPoolResolution {
  const members = Number.isFinite(memberCount) && memberCount > 0 ? Math.floor(memberCount) : 0;
  const seatDerived = members * INCLUDED_MINUTES_PER_SEAT;
  return {
    memberCount: members,
    poolMinutes: Math.max(seatDerived, ORG_POOL_FLOOR_MINUTES),
    floorApplied: seatDerived < ORG_POOL_FLOOR_MINUTES,
  };
}

/**
 * The INCREMENTAL charge for one metering event — §4.6's binding constraint on
 * this card: *"charge on the metering event, not by re-summing the period"*.
 *
 * ⚠️ THIS IS THE HEART OF THE NO-BACK-BILLING RULE, so read the shape before
 * changing it. The naive formulation — `chargeable = max(0, consumption − pool)`
 * re-evaluated each time — silently BACK-BILLS: a member removed mid-period
 * shrinks the pool, so minutes that were free when they ran retroactively fall
 * outside it and get charged. §4.6 forbids exactly that ("a shrink cannot produce
 * a surprise bill for compute that was free when it ran").
 *
 * The fix is a WATERMARK. `accountedMinutes` is how much of the period's
 * consumption has already been run past the pool; only the minutes BEYOND it are
 * new, and the pool is spent against the watermark rather than re-applied to the
 * whole period. A pool that shrinks therefore only affects minutes not yet
 * accounted — never history. It is also order-independent (two runs charge the
 * same total whichever lands first) and idempotent: a replay sees
 * `consumption == accountedMinutes`, so `newMinutes` is 0 and nothing is charged.
 *
 * Credits are whole (motir-ai's ledger takes integers), so the FRACTIONAL
 * remainder is carried rather than rounded away: `chargedCredits` trails
 * `floor(chargedMinutes)`, and the next event bills the carry. Rounding down each
 * event independently would leak up to a credit per run in the user's favour;
 * rounding up would over-bill for minutes nobody consumed.
 */
export interface CiChargeInput {
  /** The org's authoritative period consumption, in Linux-equivalent minutes. */
  consumptionMinutes: number;
  /** Consumption already run past the pool by earlier events (the watermark). */
  accountedMinutes: number;
  /** Minutes charged so far this period (fractional; the credit carry lives here). */
  chargedMinutes: number;
  /** Whole credits already booked this period. */
  chargedCredits: number;
  /** The pool as it stands NOW (§4.6 — evaluated at read time from membership). */
  poolMinutes: number;
}

export interface CiChargeComputation {
  /** New minutes this event accounts for (0 on a replay). */
  newMinutes: number;
  /** Of those, the minutes that fall beyond the pool. */
  chargeableMinutes: number;
  /** Whole credits to debit for this event (0 when only a fraction accrued). */
  creditsToDebit: number;
  /** The watermark to persist — always the authoritative consumption. */
  nextAccountedMinutes: number;
  /** `chargedMinutes` after this event (carries the sub-credit remainder). */
  nextChargedMinutes: number;
  /** `chargedCredits` after this event. */
  nextChargedCredits: number;
}

export function computeIncrementalCharge(input: CiChargeInput): CiChargeComputation {
  const { consumptionMinutes, accountedMinutes, chargedMinutes, chargedCredits, poolMinutes } =
    input;

  // A replay (or a run metered for another org's workspace) leaves consumption at
  // or below the watermark: nothing new, nothing charged. Never negative — the
  // watermark only ever advances.
  const newMinutes = Math.max(0, consumptionMinutes - accountedMinutes);

  // How much of the pool is still unspent at the watermark. Spending it against
  // the WATERMARK rather than against the whole period is what makes a mid-period
  // pool shrink affect only future minutes (§4.6).
  const freeRemaining = Math.max(0, poolMinutes - accountedMinutes);
  const chargeableMinutes = Math.max(0, newMinutes - freeRemaining);

  const nextChargedMinutes = chargedMinutes + chargeableMinutes;
  // The carry: bill only whole credits, and only those not already billed.
  const creditsToDebit = Math.max(
    0,
    Math.floor(nextChargedMinutes * CREDITS_PER_LINEAR_EQUIVALENT_MINUTE) - chargedCredits,
  );

  return {
    newMinutes,
    chargeableMinutes,
    creditsToDebit,
    // Never move the watermark BACKWARDS: a stale/racing read that returns less
    // than the watermark must not re-open already-accounted minutes for charging.
    nextAccountedMinutes: Math.max(accountedMinutes, consumptionMinutes),
    nextChargedMinutes,
    nextChargedCredits: chargedCredits + creditsToDebit,
  };
}

/**
 * §6.5 — the state machine, complete. TWO thresholds that must never be
 * conflated: crossing the POOL is a normal event that keeps work running and
 * merely starts drawing credits; hitting `balance ≤ 0` is the one that REFUSES.
 * Conflating them either bills people still inside their allowance or lets the
 * loop run on an empty balance.
 *
 * `balance` may be null when motir-ai could not be reached. That is deliberately
 * NOT treated as exhaustion: refusing dispatch on a transport blip would fail
 * closed on Motir's own outage, and §6.4 already accepts a bounded overshoot as
 * the honest cost of compute that cannot be un-run.
 */
export function resolveState(input: {
  consumptionMinutes: number;
  poolMinutes: number;
  balance: number | null;
}): CiEntitlementStateName {
  if (input.consumptionMinutes < input.poolMinutes) return 'within_allowance';
  if (input.balance !== null && input.balance <= 0) return 'ci_credits_exhausted';
  return 'drawing_on_credits';
}
