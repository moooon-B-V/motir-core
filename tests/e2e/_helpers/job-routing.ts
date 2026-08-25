import { rm, writeFile } from 'node:fs/promises';

// Per-spec control of the PER-JOB CUTOVER SWITCH for E2E
// (Story MOTIR-3414 · Subtask MOTIR-3427).
//
// `lib/jobs/engine/cutover.ts` routes each job id to the Postgres engine or to
// Inngest. In production that comes from `MOTIR_POSTGRES_JOB_IDS`, an env var —
// which is fixed at server boot and therefore cannot express what this lane
// needs: `jobs-flow.spec.ts` proves `email.send` still runs on INNGEST against
// the same server that this story's spec drives on the POSTGRES engine.
//
// So the switch reads a FILE when `MOTIR_POSTGRES_JOB_IDS_FILE` is set, and
// these helpers are the test side of that channel. It is the same mechanism, for
// the same reason, that `email-fault.ts` already uses: the Playwright runner and
// the servers are separate processes, so a file on disk is the only thing all of
// them can see. The file override is refused in real production.
//
// ⚠️ CLEAR IT IN `afterEach`, unconditionally. A spec that leaves a job routed
// leaves the NEXT spec's server routing it too — and the failure that produces is
// a job silently not running on the lane the other spec is asserting about, which
// is about as hard to read as a test failure gets.

const JOB_ROUTING_PATH =
  process.env['MOTIR_POSTGRES_JOB_IDS_FILE'] ?? '/tmp/motir-test-job-routing';

/** Route these job ids to the Postgres engine, for this spec only. */
export async function routeJobsToEngine(...jobIds: string[]): Promise<void> {
  await writeFile(JOB_ROUTING_PATH, jobIds.join(','), 'utf8');
}

/**
 * Put every job back on Inngest by removing the file.
 *
 * Idempotent — clearing an already-clear routing is a no-op, so it is safe to
 * call unconditionally in `afterEach`.
 */
export async function clearJobRouting(): Promise<void> {
  await rm(JOB_ROUTING_PATH, { force: true });
}
