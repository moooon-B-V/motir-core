import { describe, expect, it } from 'vitest';
import { maxDuration } from '@/app/api/inngest/route';
import {
  FLEET_TIME_BUDGETS,
  pollWaitMs,
  ciRunnerBootService,
} from '@/lib/services/ciRunnerBootService';

// THE FLEET'S TIME BUDGETS vs THE PLATFORM CEILING (MOTIR-2007).
//
// `docs/jobs.md` rule 2 asks that the deadlines a job spends along its slowest
// step stay under the serve route's `maxDuration`. The fleet was the one case
// that inequality did not hold for: supervision was allowed 3,600s inside an
// invocation capped at 300s, and nothing anywhere compared the two numbers.
//
// ⚠️ THIS FILE IS THAT COMPARISON, AND IT READS BOTH SIDES FROM THEIR REAL
// SOURCES — `maxDuration` is IMPORTED from the route rather than restated, so a
// change to either side has to come past this test. A hardcoded `300` here would
// assert the constants against a copy of themselves, which is the failure mode
// this is supposed to prevent.

describe('the fleet time budgets are stated once and hold against maxDuration', () => {
  it('the route still declares an explicit ceiling — the number everything else is measured against', () => {
    // Left implicit it would silently inherit Vercel's low default, which is the
    // MOTIR-1974 defect. It is a reviewable number or it is nothing.
    expect(typeof maxDuration).toBe('number');
    expect(maxDuration).toBeGreaterThan(0);
  });

  it('NO STEP of the boot path is allowed to approach the invocation ceiling', () => {
    // The constraint the card exists to make un-regressable. Every phase the job
    // steps — boot, one poll, teardown — is shaped to a fixed, small amount of
    // work; this is the budget that shape is held to.
    expect(FLEET_TIME_BUDGETS.stepWorkBudgetMs).toBeLessThanOrEqual(maxDuration * 1000);
  });

  it('the RUN may outlive the invocation ceiling — deliberately, and only because it is stepped', () => {
    // ⚠️ THE ASSERTION THAT LOOKS BACKWARDS. A supervised CI job runs up to
    // twelve times longer than one invocation may live. That is legal ONLY
    // because no single step spans it: the run is a chain of invocations.
    //
    // It is asserted rather than merely allowed, because the tempting non-fix
    // was to shorten this under `maxDuration` — which caps every tenant's CI job
    // at five minutes. That is the product regressing to fit the bug, and this
    // line is what makes someone argue with the comment before doing it.
    expect(FLEET_TIME_BUDGETS.jobTimeoutMs).toBeGreaterThan(maxDuration * 1000);
  });

  it('the deadlines are ordered: poll ≤ maxPoll < bootDeadline < jobTimeout < reapAfter', () => {
    const b = FLEET_TIME_BUDGETS;
    // A boot deadline must be observable at poll granularity, or it is overshot
    // by a whole interval...
    expect(b.pollIntervalMs).toBeLessThanOrEqual(b.maxPollIntervalMs);
    expect(b.maxPollIntervalMs).toBeLessThan(b.bootDeadlineMs);
    // ...and must be able to fire before the job timeout does, or a container
    // that never started would be reported as one that ran over.
    expect(b.bootDeadlineMs).toBeLessThan(b.jobTimeoutMs);
    // THE REAPER STAYS THE BACKSTOP. It may only ever meet containers
    // supervision has already given up on — never ones it is about to settle.
    expect(b.reapAfterMs).toBeGreaterThan(b.jobTimeoutMs);
  });

  it('a full-length job costs a bounded, sane number of poll steps', () => {
    // Each poll is a `step.sleep` + a `step.run`, i.e. two durable checkpoints.
    // At a flat 3s interval a 3,600s job would be 1,200 polls — 2,400 steps for
    // ONE CI job. The backoff is what keeps that in the low hundreds, so this
    // asserts the backoff is actually doing its job.
    let elapsed = 0;
    let polls = 0;
    while (
      elapsed < FLEET_TIME_BUDGETS.jobTimeoutMs &&
      polls < FLEET_TIME_BUDGETS.maxPollIterations
    ) {
      polls += 1;
      elapsed += pollWaitMs(polls);
    }
    expect(polls).toBeLessThan(200);
    // ...and the static ceiling is comfortably clear of what a real job needs,
    // so it can only ever bind on a clock that has gone wrong.
    expect(FLEET_TIME_BUDGETS.maxPollIterations).toBeGreaterThan(polls * 2);
  });

  it('the service exposes the three bounded phases the job steps, and no long-running entrypoint of its own', () => {
    // A structural statement about the SURFACE: the job's supervision is
    // composed from these three, each of which returns after a fixed amount of
    // work. `runIntent` survives as the in-process composition for tests and
    // scripts (see its doc comment) and is asserted out of the handler in
    // `tests/jobs/ci-runner-fleet.test.ts`.
    expect(typeof ciRunnerBootService.bootIntent).toBe('function');
    expect(typeof ciRunnerBootService.pollOnce).toBe('function');
    expect(typeof ciRunnerBootService.settleSupervision).toBe('function');
    // The MOTIR-2002 memo entrypoint is GONE — the shape fix subsumed it.
    expect('superviseOnce' in ciRunnerBootService).toBe(false);
  });
});
