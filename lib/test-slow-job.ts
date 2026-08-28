import { isE2EProdHarness } from '@/lib/e2eProdHarness';
import { defineJob } from '@/lib/jobs/defineJob';
import { withSystemContext } from '@/lib/workspaces/context';

// The E2E LONG-RUNNING JOB seam (Story MOTIR-3758 · Subtask MOTIR-3767).
//
// ⚠️ WHY A SEAM AT ALL, rather than reusing a real job. The story's claim is that
// a status cascade lands WHILE something long is in flight, so a spec needs a run
// that occupies the worker for a controllable time. Every genuinely long job this
// repository has is a container SUPERVISOR — and the card that asks for this spec
// rules those out by name: *"no fleet, container provider or admission path is
// involved or stubbed"*. A supervisor dragged into a browser spec would be
// asserting its own harness rather than the claim loop.
//
// ⚠️ AND IT ENDS ON A SIGNAL, NOT ON A CLOCK — which is the whole reason this is
// a job rather than a `setTimeout`. The assertion the spec exists for is an
// ORDERING: the children are Done *while this is still running*. A fixed sleep
// makes that a race against the cascade's own latency, which is ~0.5 s on this
// box and can be many seconds on a loaded CI runner — so a spec written against
// a fixed duration is green locally and flaky exactly where it is least
// debuggable. Instead the run waits for a RELEASE ROW the spec writes when it has
// finished asserting, and the clamp below is only a runaway guard.
//
// ⚠️ DORMANT BY DEFAULT AND REFUSED OUTSIDE THE HARNESS, on the same contract as
// `lib/test-code-graph-mock.ts`: BOTH `E2E_TEST_SLOW_JOB=1` and
// `E2E_PROD_HARNESS=1`, the second of which `playwright.config.ts` sets and no
// real deployment does. `scripts/worker.ts` imports this DYNAMICALLY inside
// `installE2ESeams()`, so a production worker never loads the module.
//
// ⚠️ AND IT IS REGISTERED IN THE WORKER ONLY. The app server has no part in
// executing a run — its whole job is the row — so registering there would widen
// the surface for nothing. It also keeps the STATIC registry unchanged: the
// vitest guards that enumerate `engineJobs()` (`engine-units`,
// `engine-subscriber-reachability`) never call this function, so they see exactly
// the job set production ships.

/** The job id the spec enqueues. Deliberately NOT a member of the shipped event vocabulary. */
export const E2E_SLOW_JOB_ID = 'system.e2e-slow-probe';

/** The `job_event.name` the spec writes to let a run finish. */
export const E2E_SLOW_JOB_RELEASE_EVENT = 'system.e2e-slow-probe.release';

/**
 * The runaway guard — the longest a probe run may hold the worker if its release
 * never arrives (a spec that failed mid-assertion, or one that forgot).
 *
 * It is NOT the expected duration: the ordinary path is released in a second or
 * two. It is the bound on what a broken spec can cost the lane's single worker,
 * which is why it is generous enough to outlive a slow cascade and short enough
 * that a shard cannot stall behind it.
 */
export const E2E_SLOW_JOB_MAX_MS = 30_000;

/** How often the run looks for its release row. */
const POLL_MS = 100;

export function slowJobEnabled(): boolean {
  return process.env['E2E_TEST_SLOW_JOB'] === '1' && isE2EProdHarness();
}

/** Has the spec written the release row yet? */
async function released(): Promise<boolean> {
  const n = await withSystemContext((tx) =>
    tx.jobEvent.count({ where: { name: E2E_SLOW_JOB_RELEASE_EVENT } }),
  );
  return n > 0;
}

/**
 * Register the probe. Called by `scripts/worker.ts` inside `installE2ESeams()`.
 *
 * Refused outside the harness by RETURNING rather than throwing, which matches
 * the sibling seams: a process that is not the test lane simply has no job.
 */
export function registerSlowTestJob(): void {
  if (!slowJobEnabled()) return;
  defineJob(
    // The id is not a member of `JobEventName` — the vocabulary is the shipped
    // job set, and this one deliberately is not in it. The cast is the same one
    // every vitest suite uses to register a throwaway job.
    { id: E2E_SLOW_JOB_ID as never, retryPolicy: 'none' },
    async () => {
      const deadline = Date.now() + E2E_SLOW_JOB_MAX_MS;
      let polls = 0;
      while (Date.now() < deadline) {
        polls += 1;
        if (await released()) return { releasedEarly: true, polls };
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      // Reaching the guard is a FINDING, not a pass — it means the spec never
      // released the run. The value is returned rather than thrown so the run
      // still settles cleanly and the ledger row says which happened.
      return { releasedEarly: false, polls };
    },
  );
}
