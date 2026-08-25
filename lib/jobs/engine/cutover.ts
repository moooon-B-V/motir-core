import { readFileSync } from 'node:fs';
import { isE2EProdHarness } from '@/lib/e2eProdHarness';

// The PER-JOB CUTOVER SWITCH (Story MOTIR-3414 · Subtask MOTIR-3423).
//
// The mechanism that turns a 24-job migration into 24 reversible one-line
// changes. Each job id routes to EITHER the Postgres engine or Inngest, and the
// two run side by side for the length of the migration.
//
// ===========================================================================
// It is CONFIGURATION, not a branch at each call site
// ===========================================================================
// The switch is read in exactly two places — `sendEvent` (which decides where to
// enqueue) and `defineJob`'s Inngest handler (which declines to run a job that
// has moved). Not one of the 58 `step.run` call sites, and not one of the 24 job
// definitions, contains a conditional. A job moves lane by having its id added
// to an environment variable, and moves back by having it removed.
//
// ===========================================================================
// The default is INNGEST, and that is a safety property
// ===========================================================================
// A job absent from the configuration runs where it runs today. So a job nobody
// has thought about cannot be silently migrated — the only way onto the new
// engine is for someone to name the job. The 23 jobs this story does not move
// are protected by that default rather than by anyone remembering them, and
// there is a test asserting the negative direction for exactly that reason.
//
// ===========================================================================
// ⚠️ THIS FILE IS SCAFFOLDING WITH A KNOWN END
// ===========================================================================
// The retirement story deletes it, once no second lane exists to route between.
// Saying so here is deliberate: a migration switch with no stated end is how a
// temporary mechanism becomes a permanent one, and the next reader deserves to
// know this was designed to be removed rather than to be lived with.

/**
 * The env var naming the jobs that have MOVED to the Postgres engine — a
 * comma-separated list of `defineJob` ids.
 *
 * An env var rather than a database row, deliberately: the routing must be
 * readable by `sendEvent` on a request path with no transaction and no await
 * budget, and it must be identical on every machine at any instant. A row would
 * need a cache, and a stale cache here means a job running on BOTH engines —
 * the one outcome the switch exists to prevent.
 */
export const JOB_ENGINE_JOBS_ENV = 'MOTIR_POSTGRES_JOB_IDS';

/** Parse the env value into a set. Exported for the tests; `routedToEngine` is the runtime door. */
export function parseRoutedJobIds(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * A TEST-ONLY override channel: an env var naming a FILE whose contents are the
 * same comma-separated id list.
 *
 * ⚠️ IT EXISTS BECAUSE AN ENV VAR IS FIXED AT SERVER BOOT, and the E2E lane has
 * to move a job between lanes MID-SPEC — one spec proves the pilot job on the new
 * engine while `jobs-flow.spec.ts`, against the same server, proves `email.send`
 * still runs on Inngest. A boot-time value cannot express both.
 *
 * This is the same channel, with the same rationale, that `lib/email.ts`'s fault
 * injector already uses (`EMAIL_FAULT_PATH`) and that `email-capture.ts` uses for
 * the outbox: the Playwright runner and the server are separate processes, so a
 * file on disk is the only thing both can see.
 *
 * **Off unless explicitly set**, so production and ordinary dev never pay the
 * read, and refused outright in real production — exactly as the email fault
 * injector is refused. The env var remains the only production channel.
 */
export const JOB_ENGINE_JOBS_FILE_ENV = 'MOTIR_POSTGRES_JOB_IDS_FILE';

/** The file override's contents, or null when the seam is off / the file absent. */
function routedJobIdsFromFile(): string | null {
  const path = process.env[JOB_ENGINE_JOBS_FILE_ENV];
  if (path === undefined || path === '') return null;
  if (process.env['NODE_ENV'] === 'production' && !isE2EProdHarness()) {
    throw new Error(
      `${JOB_ENGINE_JOBS_FILE_ENV} is set in production. It is a test-only override for the ` +
        `per-job cutover switch and must never be enabled in production. Unset it and use ` +
        `${JOB_ENGINE_JOBS_ENV} instead.`,
    );
  }
  try {
    // Read fresh on every call, for the same reason the email fault is: a spec
    // arms and disarms it mid-run, and a cached value would route a job to the
    // lane it was on when the process booted.
    return readFileSync(path, 'utf8');
  } catch (err) {
    // No file → the seam is armed but empty, which means "route nothing".
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

/**
 * Does this job id run on the Postgres engine?
 *
 * Read live from `process.env` on every call rather than captured at module load.
 * That costs a string split per call and buys the thing that matters: the value
 * cannot be stale, and a test (or an operator restarting a machine) sees the
 * change immediately. A cache would be an optimisation over a `split` on a
 * string that is at most a few hundred bytes.
 */
export function routedToEngine(jobId: string): boolean {
  return routedJobIds().has(jobId);
}

/**
 * Every job id currently routed to the Postgres engine.
 *
 * The FILE override wins when the seam is armed, so a spec can move a job
 * between lanes without restarting the server; otherwise the env var, which is
 * the only production channel.
 */
export function routedJobIds(): ReadonlySet<string> {
  const fromFile = routedJobIdsFromFile();
  if (fromFile !== null) return parseRoutedJobIds(fromFile);
  return parseRoutedJobIds(process.env[JOB_ENGINE_JOBS_ENV]);
}
