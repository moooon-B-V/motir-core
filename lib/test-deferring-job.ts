import { isE2EProdHarness } from '@/lib/e2eProdHarness';
import { defineJob } from '@/lib/jobs/defineJob';
import { advanceSupervision } from '@/lib/jobs/supervision/driver';
import { withSystemContext } from '@/lib/workspaces/context';

// The E2E SELF-RESCHEDULING PROBE (Story MOTIR-3778 · Subtask MOTIR-3832) — a
// SUPERVISION that occupies the worker exactly as a real one does, for a
// browser spec that has to fill the pool.
//
// ⚠️ WHY A SECOND PROBE, AND NOT `lib/test-slow-job.ts`. That one is the right
// shape for MOTIR-3767's spec and the wrong shape for this one, and the
// difference is the whole point of this story. It HOLDS its worker slot in an
// in-process `while` loop for its entire life — which is what a supervisor did
// before MOTIR-3778 and is precisely the behaviour this spec has to show is
// gone. Filling the pool with ten of those would demonstrate the OLD engine
// perfectly and prove nothing about the new one.
//
// ⚠️ AND IT DRIVES THE REAL DRIVER, deliberately, rather than imitating it.
// `advanceSupervision` is the machine both container supervisors run on, so a
// probe built on it writes a real `job_supervision` row, performs exactly one
// poll per pass, and hands its own `job_queue` row back between them. A probe
// that hand-rolled a `deferRun` would be asserting its own harness.
//
// ⚠️ DORMANT BY DEFAULT AND REFUSED OUTSIDE THE HARNESS, on the same contract as
// `lib/test-slow-job.ts` and `lib/test-code-graph-mock.ts`: BOTH
// `E2E_TEST_DEFERRING_JOB=1` and `E2E_PROD_HARNESS=1`, the second of which
// `playwright.config.ts` sets and no real deployment does. `scripts/worker.ts`
// imports this DYNAMICALLY inside `installE2ESeams()`, so a production worker
// never loads the module — and the STATIC registry the vitest guards enumerate
// is unchanged, which is why `engine-units` and `engine-subscriber-reachability`
// still see exactly the job set production ships.

/** The job id the spec enqueues. Deliberately NOT a member of the shipped event vocabulary. */
export const E2E_DEFERRING_JOB_ID = 'system.e2e-deferring-probe';

/** The `job_event.name` the spec writes to let every probe finish. */
export const E2E_DEFERRING_JOB_RELEASE_EVENT = 'system.e2e-deferring-probe.release';

/**
 * The gap between one probe pass and the next.
 *
 * Short, because the spec's whole assertion is that the pool is FREE between
 * passes — a long gap would make that true trivially. A quarter of a second
 * keeps ten probes visibly cycling while leaving the worker overwhelmingly idle,
 * which is the state the cascade has to land in.
 */
export const E2E_DEFERRING_JOB_INTERVAL_MS = 250;

/**
 * The runaway guard — the most passes one probe may make if its release never
 * arrives (a spec that failed mid-assertion, or one that forgot).
 *
 * NOT the expected count: the ordinary path is released after a handful. It is
 * the bound on what a broken spec costs the lane's single worker.
 */
export const E2E_DEFERRING_JOB_MAX_PASSES = 200;

/** The supervision's `kind`, so a stray row is attributable in a failed run. */
export const E2E_DEFERRING_JOB_KIND = 'e2e-probe';

export function deferringJobEnabled(): boolean {
  return process.env['E2E_TEST_DEFERRING_JOB'] === '1' && isE2EProdHarness();
}

/** Has the spec written the release row yet? */
async function released(): Promise<boolean> {
  const n = await withSystemContext((tx) =>
    tx.jobEvent.count({ where: { name: E2E_DEFERRING_JOB_RELEASE_EVENT } }),
  );
  return n > 0;
}

/**
 * Register the probe. Called by `scripts/worker.ts` inside `installE2ESeams()`.
 *
 * Refused outside the harness by RETURNING rather than throwing, which matches
 * the sibling seams: a process that is not the test lane simply has no job.
 */
export function registerDeferringTestJob(): void {
  if (!deferringJobEnabled()) return;
  defineJob(
    // The id is not a member of `JobEventName` — the vocabulary is the shipped
    // job set, and this one deliberately is not in it. Same cast every vitest
    // suite uses to register a throwaway job.
    { id: E2E_DEFERRING_JOB_ID as never, retryPolicy: 'none' },
    async (ctx) => {
      // The BOOT, memoized, exactly as a real supervisor's is — it is what
      // anchors the deadline to the SESSION rather than to the pass, so a probe
      // resumed after a restart is still bounded from where it started.
      const session = (await ctx.step.run('probe-boot', () => ({
        bootedAt: new Date().toISOString(),
      }))) as { bootedAt: string };

      const result = await advanceSupervision<'released', { passes: number }>(
        ctx.runId,
        {
          kind: E2E_DEFERRING_JOB_KIND,
          // One probe run is one supervision — no fan-out, so the subject is
          // the run itself. It is still a subject rather than an implicit
          // singleton, because the row's identity is `(run_id, subject)`.
          subject: 'probe',
          // Untenanted: a `system.*` probe spans no workspace, exactly as the
          // supervisors it stands in for.
          workspaceId: null,
          bootedAt: new Date(session.bootedAt),
        },
        {
          maxPolls: E2E_DEFERRING_JOB_MAX_PASSES,
          timeoutMs: E2E_DEFERRING_JOB_INTERVAL_MS * E2E_DEFERRING_JOB_MAX_PASSES,
          waitMs: () => E2E_DEFERRING_JOB_INTERVAL_MS,
          // ONE read per pass — here a single indexed count, standing in for a
          // container supervisor's single `describe`.
          poll: async () =>
            (await released())
              ? ({ done: true, verdict: 'released' } as const)
              : ({ done: false, startedAt: null, consecutiveReadFailures: 0 } as const),
          // Nothing to tear down: there is no container. The probe's terminal
          // transition exists so the machine is the real one end to end.
          settle: async (_reason, state) => ({ passes: state.pollNumber }),
        },
      );

      // Reaching the guard is a FINDING, not a pass — it means the spec never
      // released the probes. The reason is returned rather than thrown so the
      // run still settles cleanly and the ledger row says which happened.
      return { reason: result.reason, passes: result.outcome.passes };
    },
  );
}
