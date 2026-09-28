import { defineJob } from '../defineJob';
import type { HostedRunSuperviseData } from '../types';

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
export const hostedRunSupervise = defineJob(
  {
    id: 'hosted-run/supervise',
    retryPolicy: 'none',
    idempotency: 'event.data.idempotencyKey',
  },
  async (ctx, services) => {
    const data = ctx.event.data as HostedRunSuperviseData;
    return services.hostedRun.supervise(ctx.runId, data, {
      steps: {
        run: <T>(id: string, fn: () => T | Promise<T>): Promise<T> =>
          // ONE cast, at the boundary — `ciRunnerBoot`'s shape and reason: every
          // value crossing this seam is JSON-serializable by contract.
          ctx.step.run(id, fn as () => Promise<T>) as unknown as Promise<T>,
      },
    });
  },
);
