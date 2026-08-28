import { stopJobWorker } from './_helpers/job-worker-process';

/**
 * Playwright globalTeardown (Story MOTIR-3414 · Subtask MOTIR-3427).
 *
 * Stops the Postgres job engine's worker.
 *
 * ⚠️ IT MATTERS BEYOND THIS RUN. The worker is a child process of the runner, so
 * a shard that exits without stopping it can leave a claim loop attached to the
 * test database — one that a NEXT run's `resetDatabase()` then truncates under,
 * producing failures in a suite that never started a worker. (It also used to
 * clear the cutover-routing override file, which went with the switch in
 * MOTIR-3418.)
 *
 * The stop is a graceful SIGTERM, so the lane exercises the worker's drain path
 * on every run rather than only in the unit test that asserts it.
 */
export default async function globalTeardown(): Promise<void> {
  await stopJobWorker();
}
