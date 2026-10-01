import { defineJob } from '../defineJob';
import { deferRun } from '../engine/defer';
import type { HostedRunSuperviseData } from '../types';
import { transactionTimeoutHalf } from '@/lib/monitoring/transactionStall';

// A HOSTED RUN'S SUPERVISION (Story MOTIR-683 · MOTIR-690) — one pass per run of
// the queue, advancing the booted container's supervision by one poll and
// deferring, until the container settles; then the run is ended through the end
// path's seam (`hostedRunService.endHostedRun`) in its own memoized step.
//
// Emitted by the start path AFTER it booted the container, carrying the booted
// SESSION and nothing secret (`HostedRunSuperviseData` says why the boot happens
// in the request and not here).
//
// ⚠️ NO WALL-CLOCK DEADLINE BUT THE BACKSTOP (the run-dies decision, MOTIR-6525).
// The container was booted with the 12-hour backstop as its hard kill, and the
// supervision reads it from the session. What ends a live run early is the STALL
// read, run before every poll: no run event inside the stall window.
//
// ⚠️ `retryPolicy: 'none'`, as `system.ci-runner-boot`'s, and for its reason: the
// boot is memoized (here it replays the start path's session), a worker restart
// refunds the attempt, and a genuine handler failure is one the abandoned-
// supervision sweep settles — a blind retry would only re-enter a supervision
// already recorded. `idempotency` keeps a double emit to ONE supervision per run.
//
// ⚠️ EXCEPT A PASS THAT COULD NOT START A TRANSACTION AT ALL (Bug MOTIR-7071).
// That is P2028's `maxWait` half: no connection came free in time, so the
// statement that asked for one never ran. With a budget of ONE it used to
// dead-letter the whole supervision, and the only thing left to end the run was
// the abandoned-supervision sweep — 15 minutes of grace plus its 5-minute tick —
// while the container kept running and its card kept reading as running. Seen in
// the acceptance lane: the job worker's pool was saturated for twenty minutes,
// one supervise pass met it, and the stall that should have ended a silent run
// 25 s later was never read again. Such a pass is DEFERRED instead — the same
// re-entry a lease reclaim or a worker restart already performs, over the same
// step memo, so nothing the pass had finished runs twice and nothing unfinished
// is lost. The `timeout` half (a transaction that expired mid-body) and every
// other failure keep the single attempt.
export const HOSTED_RUN_SUPERVISE_TRANSACTION_RETRY_MS = 5_000;

export const hostedRunSupervise = defineJob(
  {
    id: 'hosted-run/supervise',
    retryPolicy: 'none',
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) => {
    const data = ctx.event.data as HostedRunSuperviseData;
    try {
      return await services.hostedRun.supervise(ctx.runId, data, {
        steps: {
          run: <T>(id: string, fn: () => T | Promise<T>): Promise<T> =>
            // ONE cast, at the boundary — `ciRunnerBoot`'s shape and reason: every
            // value crossing this seam is JSON-serializable by contract.
            ctx.step.run(id, fn as () => Promise<T>) as unknown as Promise<T>,
        },
      });
    } catch (err) {
      if (transactionTimeoutHalf(err) !== 'maxWait') throw err;
      deferRun(
        new Date(Date.now() + HOSTED_RUN_SUPERVISE_TRANSACTION_RETRY_MS),
        `hosted-run supervision ${data.dispatchRunId}: no database connection came free in time`,
      );
    }
  },
);
