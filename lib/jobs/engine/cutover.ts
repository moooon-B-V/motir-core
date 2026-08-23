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
 * Does this job id run on the Postgres engine?
 *
 * Read live from `process.env` on every call rather than captured at module load.
 * That costs a string split per call and buys the thing that matters: the value
 * cannot be stale, and a test (or an operator restarting a machine) sees the
 * change immediately. A cache would be an optimisation over a `split` on a
 * string that is at most a few hundred bytes.
 */
export function routedToEngine(jobId: string): boolean {
  return parseRoutedJobIds(process.env[JOB_ENGINE_JOBS_ENV]).has(jobId);
}

/** Every job id currently routed to the Postgres engine. The operator surface and the tests read this. */
export function routedJobIds(): ReadonlySet<string> {
  return parseRoutedJobIds(process.env[JOB_ENGINE_JOBS_ENV]);
}
