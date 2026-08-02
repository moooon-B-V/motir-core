import { describe, expect, it } from 'vitest';
import { maxDuration } from '@/app/api/inngest/route';
import {
  FLEET_TIME_BUDGETS,
  pollWaitMs,
  ciRunnerBootService,
} from '@/lib/services/ciRunnerBootService';
import { RUNNER_JIT_REQUEST_TIMEOUT_MS } from '@/lib/github/runnerJitConfig';
import { ORCHESTRATOR_REQUEST_TIMEOUT_MS } from '@/lib/orchestrator/errors';

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

  it("RULE 3's inequality: the boot step's two deadlines SUM to less than one step's budget", () => {
    // ⚠️ THE ASSERTION MOTIR-2011 EXISTS FOR, and the one rule-2's shape
    // argument cannot make. `stepWorkBudgetMs` bounds what a step DOES — one
    // mint, one provision — which is a statement about the code. This bounds how
    // long those two calls may take, which is a statement about the CLOCK, and
    // an unbounded `fetch` satisfies the first while violating the second: a step
    // that makes one call still runs forever if the call does.
    const b = FLEET_TIME_BUDGETS;
    expect(b.mintDeadlineMs + b.containerCallDeadlineMs).toBeLessThanOrEqual(b.stepWorkBudgetMs);
    // ...and therefore, transitively, under the invocation ceiling. Stated
    // separately because that is the sentence `docs/jobs.md` rule 3 actually
    // writes down, and the chain is only as good as its weakest link being
    // asserted.
    expect(b.mintDeadlineMs + b.containerCallDeadlineMs).toBeLessThan(maxDuration * 1000);
  });

  it('the deadlines are the CLIENTS OWN numbers, not a copy of them', () => {
    // The same discipline as importing `maxDuration`: a budget that restates a
    // client's timeout asserts the constants against themselves and goes stale
    // the first time a client is tuned.
    expect(FLEET_TIME_BUDGETS.mintDeadlineMs).toBe(RUNNER_JIT_REQUEST_TIMEOUT_MS);
    expect(FLEET_TIME_BUDGETS.containerCallDeadlineMs).toBe(ORCHESTRATOR_REQUEST_TIMEOUT_MS);
    // Both must be real bounds — a zero or a NaN would satisfy every inequality
    // above while meaning "no deadline at all".
    expect(FLEET_TIME_BUDGETS.mintDeadlineMs).toBeGreaterThan(0);
    expect(FLEET_TIME_BUDGETS.containerCallDeadlineMs).toBeGreaterThan(0);
  });

  it('a POLL and a SETTLE step also fit — the two other steps that touch the provider', () => {
    // A poll is one provider read; a settle is a read plus a destroy plus a
    // de-registration. Enumerated per step rather than globally, because rule 3
    // is about the SLOWEST step, and the slowest one here is not the boot.
    const b = FLEET_TIME_BUDGETS;
    expect(b.containerCallDeadlineMs).toBeLessThanOrEqual(b.stepWorkBudgetMs);
    expect(b.containerCallDeadlineMs * 2 + b.mintDeadlineMs).toBeLessThanOrEqual(
      b.stepWorkBudgetMs,
    );
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
