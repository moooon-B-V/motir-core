import { describe, expect, it } from 'vitest';
import { jobFunctions } from '@/lib/jobs/registry';
import { FAST_LANE_CONSUMER_IDS, FAST_LANE_LATENCY_BUDGET } from '@/lib/jobs/latencyBudget';

// THE FAST LANE'S LATENCY BUDGET, guarded at the seam (MOTIR-3247).
//
// ⚠️ WHAT CI CANNOT REACH, SAID FIRST SO NOTHING BELOW IS OVER-READ.
//
// **This suite does NOT measure latency, and no test here can.** The budget is a
// p95 over event→run intervals produced by Inngest Cloud's scheduler under real
// production load. A CI runner has no scheduler, no load, and no production —
// a "latency test" here would be a timer around a function call, which would pass
// forever and fail for reasons that have nothing to do with the contract. The
// card is explicit that a test which cannot fail for the reason it names is worse
// than no test, so this suite does not pretend to be one.
//
// The real number is measured out-of-band, and the constant records one reading
// per substrate the lane has run on: `scripts/experiments/inngest-fastlane-lag.mjs`
// against the production Inngest REST API (`inngestBaseline`, historical), and
// `scripts/experiments/engine-fastlane-lag.mjs` against the engine's own ledger
// from inside the deployment (`engineBaseline`, the substrate in production).
//
// WHAT IS ASSERTABLE HERE — the structural preconditions the budget rests on.
// Each of these CAN fail, and each fails for exactly the reason it names:
//
//   1. The lane's MEMBERSHIP is what the budget thinks it is. A fifth consumer
//      on `work-item/transitioned` is the single most likely way the contract
//      gets widened by accident, and it is invisible in review because the new
//      job looks like every other job.
//   2. No consumer sits behind a per-function `concurrency` limit — a limit a
//      slow neighbour on the same lane could exhaust.
//   3. No consumer is DEBOUNCED. A debounce deliberately withholds a run for a
//      configured period, which is a latency contract violation by construction,
//      not a tuning question.
//
// `docs/decisions/job-lane-occupancy.md` §3 records that NOTHING in this repo
// sets `concurrency` on any job today. (2) is therefore green the moment it is
// written — which is the right time to pin it, because the reason it is green is
// a decision (§4 rules a cap out) rather than an accident, and a future cap added
// "just for this one job" is exactly what it exists to catch.

/** Inngest's shipped function object exposes the config it was constructed with. */
type InngestFnConfig = {
  id?: string;
  concurrency?: unknown;
  debounce?: unknown;
  triggers?: { event?: string; cron?: string }[];
};
const configOf = (fn: unknown): InngestFnConfig => (fn as { opts: InngestFnConfig }).opts ?? {};

/**
 * Every registered function triggered by one of the budget's events, read off
 * the SHIPPED function objects.
 *
 * Reading `fn.opts` pins the config Inngest was actually constructed with,
 * rather than re-deriving what the definition module is believed to pass — and
 * it is the only approach that works here: the `vi.resetModules()` + dynamic
 * import pattern used elsewhere in this directory silently captures nothing when
 * pointed at a real definition module, because the re-imported module builds
 * against a fresh client the spy never sees.
 */
function consumersOfBudgetEvents(): InngestFnConfig[] {
  const events = new Set<string>(FAST_LANE_LATENCY_BUDGET.events);
  return jobFunctions
    .map(configOf)
    .filter((c) => (c.triggers ?? []).some((t) => t.event !== undefined && events.has(t.event)));
}

describe('the fast lane carries a stated latency budget', () => {
  it('states a budget, with a measured reading for EACH substrate the lane has run on', () => {
    expect(FAST_LANE_LATENCY_BUDGET.p95Ms).toBeGreaterThan(0);
    // A reading is what makes the budget falsifiable rather than
    // aspirational-forever: without one, nobody can tell movement from noise.
    // Both are asserted because the COMPARISON is the deliverable — a constant
    // holding only the current p95 cannot support "it went from 29.4s to 2.2s".
    for (const reading of [
      FAST_LANE_LATENCY_BUDGET.inngestBaseline,
      FAST_LANE_LATENCY_BUDGET.engineBaseline,
    ]) {
      expect(reading.samples).toBeGreaterThan(0);
      expect(reading.p95Ms).toBeGreaterThan(0);
    }
  });

  it('is HONEST about the budget on the substrate in production — the ENGINE now MEETS it', () => {
    // ⚠️ FLIPPED BY MOTIR-3464, against a reading, which is the only thing
    // entitled to flip it. This assertion used to say the budget was NOT met;
    // it said so about Inngest, and it said so deliberately, so that the only
    // way to make the suite report "met" was to make it true.
    //
    // It is now true. MOTIR-3594 measured the Postgres job engine over 18 h
    // (n=363, window 2026-08-26T16:30:17Z → 2026-08-27T10:30Z) at a p95 of
    // 2,172 ms against the 5,000 ms budget — and a MAX of 4,160 ms, so even the
    // worst sample in the window is inside it.
    //
    // ⚠️ WHICH READING THIS ASSERTS ON IS THE LOAD-BEARING PART. It must be the
    // substrate actually running the lane (MOTIR-3463 cut it over on
    // 2026-08-26; the lane became whole at 15:36:59Z). Point this at a baseline
    // for a lane nothing runs on and the guard cannot fail for the reason it
    // names — which is the failure mode the original test was written against,
    // one level up. If the lane moves substrate again, this line moves with it.
    expect(
      FAST_LANE_LATENCY_BUDGET.engineBaseline.p95Ms,
      'The fast lane MISSES its interactive-latency budget on the substrate in ' +
        'production. Do NOT relax FAST_LANE_LATENCY_BUDGET.p95Ms to make this pass — ' +
        'the budget is a commitment, not a description. Record the new reading in ' +
        'engineBaseline, restore the gap assertion, and file a card for the distance. ' +
        'See docs/decisions/job-lane-occupancy.md §6.',
    ).toBeLessThanOrEqual(FAST_LANE_LATENCY_BUDGET.p95Ms);
  });

  it('still records the Inngest gap the budget was written against', () => {
    // The "from" half of the comparison, pinned so it cannot be quietly edited
    // to flatter the "to" half. Inngest missed the budget by 5.9×, and that is
    // now a historical fact about a substrate we have left — not a live
    // condition, and not something to re-measure (MOTIR-3418 retires the lane).
    expect(FAST_LANE_LATENCY_BUDGET.inngestBaseline.p95Ms).toBeGreaterThan(
      FAST_LANE_LATENCY_BUDGET.p95Ms,
    );
  });

  it('covers EXACTLY the functions that consume its events — a new consumer fails here', () => {
    const found = consumersOfBudgetEvents()
      .map((c) => c.id)
      .filter((id): id is string => typeof id === 'string')
      .sort();

    // The failure message has to say what to DO, because the person who trips
    // this is adding an unrelated feature and has no idea a latency budget exists.
    expect(
      found,
      'A function triggered by the fast-lane events is not in FAST_LANE_CONSUMER_IDS ' +
        '(or one listed there no longer exists). Adding a consumer to this lane means ' +
        'deciding whether it belongs inside the interactive-latency budget in ' +
        'lib/jobs/latencyBudget.ts — then update that list. See ' +
        'docs/decisions/job-lane-occupancy.md §6.',
    ).toEqual([...FAST_LANE_CONSUMER_IDS].sort());
  });

  it('puts no fast-lane consumer behind a per-function concurrency limit', () => {
    const capped = consumersOfBudgetEvents()
      .filter((c) => c.concurrency !== undefined)
      .map((c) => c.id);

    expect(
      capped,
      'A fast-lane consumer carries a `concurrency` limit. A per-function cap is a ' +
        'lane a slow neighbour can exhaust, which is the failure MOTIR-3245 was filed ' +
        'about — and docs/decisions/job-lane-occupancy.md §4 rules a cap out as a ' +
        'remedy here on measured evidence. If a cap is genuinely wanted, change the ' +
        'record first.',
    ).toEqual([]);
  });

  it('debounces no fast-lane consumer', () => {
    const debounced = consumersOfBudgetEvents()
      .filter((c) => c.debounce !== undefined)
      .map((c) => c.id);

    expect(
      debounced,
      'A fast-lane consumer carries a `debounce`, which withholds its run for the ' +
        'configured period by construction. That is incompatible with an ' +
        'interactive-latency budget — a debounce belongs on a slow-lane job like ' +
        'system.code-graph-refresh, never on a consumer somebody is waiting for.',
    ).toEqual([]);
  });
});
