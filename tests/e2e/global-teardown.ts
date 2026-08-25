import { clearJobRouting } from './_helpers/job-routing';
import { stopJobWorker } from './_helpers/job-worker-process';

/**
 * Playwright globalTeardown (Story MOTIR-3414 · Subtask MOTIR-3427).
 *
 * Stops the Postgres job engine's worker and clears the cutover-routing
 * override, in that order.
 *
 * ⚠️ BOTH MATTER BEYOND THIS RUN. The worker is a child process of the runner,
 * so a shard that exits without stopping it can leave a claim loop attached to
 * the test database — one that a NEXT run's `resetDatabase()` then truncates
 * under, producing failures in a suite that never started a worker. And the
 * routing file lives at a fixed path in /tmp, so leaving it armed routes a job
 * onto the new engine for whatever runs next.
 *
 * The stop is a graceful SIGTERM, so the lane exercises the worker's drain path
 * on every run rather than only in the unit test that asserts it.
 */
export default async function globalTeardown(): Promise<void> {
  await stopJobWorker();
  await clearJobRouting();
}
