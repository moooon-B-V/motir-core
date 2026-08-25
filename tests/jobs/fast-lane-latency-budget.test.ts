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
// The real number is measured out-of-band by
// `scripts/experiments/inngest-fastlane-lag.mjs` against the production REST API,
// and its baseline is recorded on the constant itself.
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
  it('states a budget, with the measured baseline it was written against', () => {
    expect(FAST_LANE_LATENCY_BUDGET.p95Ms).toBeGreaterThan(0);
    // The baseline is what makes the budget falsifiable rather than
    // aspirational-forever: without it, nobody can tell movement from noise.
    expect(FAST_LANE_LATENCY_BUDGET.baseline.samples).toBeGreaterThan(0);
    expect(FAST_LANE_LATENCY_BUDGET.baseline.p95Ms).toBeGreaterThan(0);
  });

  it('is HONEST that the budget is not currently met', () => {
    // ⚠️ This asserts the gap, deliberately. The budget was written at the value
    // we want (5s) against a measured p95 of ~29s, and recording that inversion
    // in a test is what stops the number being quietly relaxed to whatever the
    // system happens to do. If a later change genuinely closes the gap, this
    // test is the one that says so — flip it, and say what closed it.
    expect(FAST_LANE_LATENCY_BUDGET.baseline.p95Ms).toBeGreaterThan(FAST_LANE_LATENCY_BUDGET.p95Ms);
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
