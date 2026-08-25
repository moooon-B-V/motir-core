import type { JobEventName } from './types';

/**
 * THE FAST LANE'S INTERACTIVE-LATENCY BUDGET (MOTIR-3247, under MOTIR-3245).
 *
 * ⚠️ THIS IS A CONTRACT, NOT A MECHANISM, AND THAT IS WHY IT EXISTS. MOTIR-3245
 * was filed because a `work-item/transitioned` consumer landed **17 min 18 s**
 * after its event, and for a day nobody could tell a stale tracker from a broken
 * one — an hour of MOTIR-3229's investigation went on deciding whether status
 * derivation had failed. It had not. It was queued. Nothing said how fast it was
 * supposed to be, so there was no number to be wrong against.
 *
 * The card's original remedies — lane separation, event `priority`, a supervisor
 * rewrite — all descended from a mechanism that MOTIR-3246 then measured and
 * ruled out (`docs/decisions/job-lane-occupancy.md` §1, §4). **This survived that
 * because it never depended on the mechanism being right.** Whatever turns out to
 * cost the latency, the budget is what makes it visible.
 *
 * ## What the fast lane IS
 *
 * The consumers of the events below are what a person is waiting on when they
 * change a work item's status: the rollup that closes a parent, the notification
 * that tells a watcher, the bell, the automation rules. A delay here is not a
 * slow background job — it is the tracker appearing to be wrong.
 *
 * ## The number, and why it is a target rather than a description
 *
 * **{@link FAST_LANE_LATENCY_BUDGET.p95Ms} is a budget the deployment does NOT
 * currently meet, and it is written down at the value we want rather than the
 * value we have.** Measured against the production Inngest API on 2026-08-23
 * (`scripts/experiments/inngest-fastlane-lag.mjs`, 72 h, n=556):
 *
 *   median ≈ 0.8–1.3 s   ·   p95 ≈ 19.8–29.4 s   ·   max 93.3 s
 *
 * So the median is already an order of magnitude inside the budget and the tail
 * is four to six times outside it. That gap is the point: a budget set to what
 * is already true reports success forever and teaches nobody anything.
 *
 * Five seconds is chosen as the largest delay that still reads as "it happened"
 * to somebody who just clicked something and is looking at the screen. It is not
 * derived from the measurement — deriving a budget from the current p95 would
 * make it a description of today rather than a commitment about tomorrow.
 *
 * ## Where the gap comes from — named, not guessed
 *
 * `docs/decisions/job-lane-occupancy.md` §6: the tail tracks **arrival
 * burstiness**, not idleness and not code-graph refreshes (both of those were
 * measured and are artifacts). Slow events follow 3–4× SHORTER quiet periods than
 * fast ones, and their consumers also take 12.9–20.2 s to FINISH against 1.7 s
 * for a fast event's — so a burst inflates execution, not just queue wait. The
 * leading hypothesis is saturation of the single unpartitioned account-level
 * capacity (§3), which nothing in this repository configures or bounds. **That is
 * a hypothesis. It is not proven, and this comment does not pretend otherwise** —
 * the reading that would settle it is the account's configured concurrency limit,
 * which is dashboard-only (MOTIR-3406).
 */
export const FAST_LANE_LATENCY_BUDGET = {
  /**
   * The trigger events whose consumers this budget covers.
   *
   * ⚠️ FROZEN ON PURPOSE. `tests/jobs/fast-lane-latency-budget.test.ts` asserts
   * that the set of registered functions triggered by these events is exactly
   * {@link FAST_LANE_CONSUMER_IDS}, so a fifth consumer cannot be added to the
   * lane without someone deciding whether it belongs inside the budget. That
   * failure is the guard's whole purpose — adding a consumer is precisely when
   * the latency contract is easiest to widen by accident.
   */
  events: ['work-item/transitioned'] satisfies JobEventName[] as JobEventName[],

  /**
   * The 95th-percentile event→run latency the fast lane is expected to hold.
   *
   * NOT currently met — see the header. The measured baseline is recorded below
   * so a later reader can tell movement from noise.
   */
  p95Ms: 5_000,

  /**
   * The measured baseline this budget was written against, so the number above
   * is falsifiable rather than aspirational-forever. Re-measure with
   * `scripts/experiments/inngest-fastlane-lag.mjs`.
   */
  baseline: {
    measuredOn: '2026-08-23',
    windowHours: 72,
    samples: 556,
    medianMs: 1_300,
    p95Ms: 29_400,
    maxMs: 93_300,
  },
} as const;

/**
 * The functions that consume {@link FAST_LANE_LATENCY_BUDGET.events} today.
 *
 * Held as ids rather than derived from the registry at runtime, because the
 * whole value of the guard is that the two are compared: derive both sides from
 * the same source and the assertion can never fail.
 */
export const FAST_LANE_CONSUMER_IDS = [
  'automation-engine/transitioned',
  'notification-fan-in/transitioned',
  'status-derivation/transitioned',
  'watcher-notify/transitioned',
] as const;
