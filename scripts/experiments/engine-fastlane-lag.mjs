// THE FAST LANE'S EVENT→RUN LATENCY, ON THE POSTGRES ENGINE
// (Story MOTIR-3415 · Subtask MOTIR-3457, for the budget MOTIR-3247 wrote.)
//
// ===========================================================================
// WHAT IT MEASURES — the exact pair of columns
// ===========================================================================
// **`job_run.started_at` − `job_event.received_at`, joined on
// `job_event.id = job_run.event_id`.**
//
// That join is READ OFF THE CODE, not inferred from the column names, because
// the two `event_id` columns in this schema do not mean the same thing on both
// lanes. `lib/jobs/engine/ledger.ts`'s `ledgerIdentity()` returns
// `eventId: run.eventId ?? run.id` — the QUEUE row's `event_id` when the run came
// from an event, falling back to the queue row's own id for a cron or harness run
// that has no event. `job_queue.event_id` is the `job_event` row the dispatcher
// wrote. So for an event-triggered engine run the ledger's `event_id` IS a
// `job_event.id`, and for a scheduled run it deliberately is not — which is why
// the query joins rather than scanning, and why a cron run simply does not match.
//
// `received_at` is the dispatcher's own stamp at enqueue (`@default(now())` on
// `JobEvent`), and `started_at` is when the worker actually began the run
// (`@default(now())` on `JobRun`, written by `recordStart`). The difference is
// queue wait plus dispatch — exactly the interval a "the tracker is stale"
// complaint is about, and the same interval
// `scripts/experiments/inngest-fastlane-lag.mjs` measures on the other lane.
//
// ONE SAMPLE PER EVENT, taken from the EARLIEST consumer to start, matching the
// predecessor exactly: a stale tracker is about the first thing to react, and
// taking the max would measure the slowest consumer's own work instead of the
// queue. A negative lag is discarded as clock skew rather than clamped to zero.
//
// ===========================================================================
// PERCENTILE METHOD — identical to the predecessor, deliberately
// ===========================================================================
// Nearest-rank, no interpolation: `sorted[ceil(q * n) - 1]`, clamped into range.
// It is copied from `inngest-fastlane-lag.mjs` rather than reimplemented,
// because the comparison this whole epic will be judged on is 29.4 s against
// whatever this returns — and two p95s computed differently over different
// windows are not a before and an after, they are two unrelated numbers that
// happen to share a name. `tests/jobs/engine-fastlane-lag.test.ts` asserts the
// two implementations agree on the same inputs.
//
// ===========================================================================
// HOW TO RUN IT — the two things that make the documented command fail
// ===========================================================================
// The ledger is the production database, so this runs from INSIDE the
// deployment, which is what keeps the credential in the machine. Two facts
// about that machine have to be respected, and the first version of this block
// respected neither (MOTIR-3593).
//
// ⚠️ (1) `scripts/` IS NOT IN THE DEPLOYED IMAGE. The runtime is Next's
// standalone output: the runner stage copies `.next/standalone`, `.next/static`,
// `public` and `migrate/`, and nothing else — `ls /app/scripts` is
// `No such file or directory`. So the file has to be uploaded, and ⚠️ IT MUST
// KEEP THIS BASENAME, because the direct-invocation guard at the foot of the
// file tests `process.argv[1].endsWith('engine-fastlane-lag.mjs')`; saved under
// any other name it exits 0 having printed nothing at all. `pg` resolves out of
// `/app/node_modules` (the standalone bundle carries it), so nothing needs
// installing. Verbatim, from a checkout of this repository:
//
//   APP=motir-core
//   B64=$(base64 -w0 scripts/experiments/engine-fastlane-lag.mjs)
//   fly ssh console -a "$APP" -C "/bin/sh -c 'echo $B64 | base64 -d > /app/engine-fastlane-lag.mjs \
//     && cd /app && node engine-fastlane-lag.mjs --hours 72'"
//
// ⚠️ UPLOAD AND RUN IN ONE `fly ssh console`, as above. The app has more than one
// machine and `fly ssh` picks one per invocation, so two calls can land on two
// different machines and the second finds no file. Pin with `--machine <id>` if
// you need them separate.
//
// ⚠️ (2) `DATABASE_URL` IS THE POOLED URL AND CANNOT SEE THE LEDGER. Inside the
// machine it connects as `motir_app`, which has `rolbypassrls = false`, while
// `job_run` and `job_event` are both ENABLE **and** FORCE ROW LEVEL SECURITY
// with policies keyed on `app.system_admin` / `app.workspace_id` — neither of
// which a plain `pg` client sets. Every policy therefore matches nothing and the
// measuring query returns the empty set: a successful query, no error, no
// warning. Same machine, same window, one variable apart:
//
//   DATABASE_URL           motir_app       rolbypassrls=false     0 rows
//   DATABASE_URL_UNPOOLED  neondb_owner    rolbypassrls=true    226 rows
//
// So this script now reads **`DATABASE_URL_UNPOOLED` first** and falls back to
// `DATABASE_URL`, and — because a preference is not a guarantee — it ASSERTS
// what the connection can see before measuring anything, and REFUSES by name
// when the answer is "nothing" (`EXIT_BLIND_READ`, below). `samples: 0` is
// reachable only from a genuinely empty window.
//
// Locally, against a seeded database:
//   DATABASE_URL=postgres://… node scripts/experiments/engine-fastlane-lag.mjs --hours 72
//
// To see the refusal on purpose — the negative that proves the guard. Emptying
// the unpooled variable forces the pooled fallback (`resolveConnection` treats an
// empty string as absent, which is exactly what this is for), and it exits 3:
//   fly ssh console -a motir-core -C "/bin/sh -c 'cd /app \
//     && DATABASE_URL_UNPOOLED= node engine-fastlane-lag.mjs --hours 6; echo EXIT=$?'"
//
// ⚠️ READ-ONLY, AND THAT IS ASSERTED RATHER THAN PROMISED. It issues one SELECT
// and writes nothing — no INSERT, UPDATE, DELETE or TRUNCATE anywhere in the
// file — which is what lets a card that forbids production behaviour changes run
// it against production. `tests/jobs/engine-fastlane-lag.test.ts` reads this file
// and fails if a write ever appears in it.
//
// ⚠️ IT DOES NOT EDIT `lib/jobs/latencyBudget.ts`. Taking the reading and
// recording it is a separate card, deliberately: a figure read before any job has
// moved would measure the OLD lane through the new instrument and mean nothing.
/* eslint-disable no-console -- this is a measurement script; stdout is its result. */

import pg from 'pg';

/**
 * The consumers of `FAST_LANE_LATENCY_BUDGET.events`.
 *
 * ⚠️ DUPLICATED FROM `lib/jobs/latencyBudget.ts` BECAUSE THIS IS `.mjs` AND THAT
 * IS `.ts` — a plain node script cannot import the constant. The duplication is
 * made safe the only way it can be: `tests/jobs/engine-fastlane-lag.test.ts`
 * asserts this array equals `FAST_LANE_CONSUMER_IDS` exactly, so a fifth consumer
 * cannot be added to the lane without this list failing the build. Without that
 * test this would be the second list the rest of the codebase refuses.
 */
export const FAST_LANE_CONSUMER_IDS = [
  'automation-engine/transitioned',
  'notification-fan-in/transitioned',
  // MOTIR-3579 — the plan-drift consumer joined the lane; see the reasoning
  // beside its entry in `lib/jobs/latencyBudget.ts`, which this list mirrors.
  'plan-drift/transitioned',
  'status-derivation/transitioned',
  'watcher-notify/transitioned',
];

/**
 * Nearest-rank quantile — byte-for-byte the predecessor's, see the header.
 * Returns NaN on an empty set, which the caller reports as `samples: 0` rather
 * than printing.
 */
export const quantile = (sorted, q) => {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
};

/**
 * The six fields `FAST_LANE_LATENCY_BUDGET.engineBaseline` records, from a list
 * of lags in milliseconds. Shaped so the result drops into that constant without
 * reinterpretation.
 *
 * ⚠️ AN EMPTY WINDOW REPORTS `samples: 0` AND NULL FIGURES, never zeros. A
 * latency of zero and "no data" are opposite findings, and a reader who cannot
 * tell them apart will record the wrong one.
 */
export function summarise(lagsMs, { measuredOn, windowHours }) {
  const sorted = [...lagsMs].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return { measuredOn, windowHours, samples: 0, medianMs: null, p95Ms: null, maxMs: null };
  }
  return {
    measuredOn,
    windowHours,
    samples: sorted.length,
    medianMs: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1],
  };
}

/** Group `{ eventId, receivedAt, startedAt }` rows into one lag per event. */
export function lagsPerEvent(rows) {
  const earliestStart = new Map();
  const receivedAt = new Map();
  for (const row of rows) {
    receivedAt.set(row.eventId, row.receivedAt);
    const prior = earliestStart.get(row.eventId);
    if (prior === undefined || row.startedAt < prior) earliestStart.set(row.eventId, row.startedAt);
  }
  const lags = [];
  for (const [eventId, started] of earliestStart) {
    const lag = started - receivedAt.get(eventId);
    // Clock skew between two server-assigned stamps is not a queue wait.
    if (lag >= 0) lags.push(lag);
  }
  return lags;
}

/**
 * Exit codes. `2` means USAGE; `3` means the instrument could not SEE — mirroring
 * `scripts/detectStrayDesignResults.mjs`, which is the first place this project
 * paid for a vacuous exit-0 read (MOTIR-3227). A measurement that reports
 * nothing because it is blind must not be spelled the same way as a measurement
 * that reports nothing because the window was quiet.
 */
export const EXIT_USAGE = 2;
export const EXIT_BLIND_READ = 3;

/**
 * WHICH URL, AND WHY THE ORDER.
 *
 * `DATABASE_URL` is the POOLED Neon url; inside the motir-core machine it
 * connects as `motir_app` (`rolbypassrls = false`). `DATABASE_URL_UNPOOLED` is
 * the owner role, which is what can read a FORCE-RLS table. Preferring the
 * unpooled url is the one-line half of the fix.
 *
 * ⚠️ EMPTY IS TREATED AS ABSENT, deliberately: `DATABASE_URL_UNPOOLED= node …`
 * is how the pooled fallback (and therefore the refusal below) is forced on a
 * machine where both variables are set, and `??` would hand `new pg.Client` an
 * empty string instead.
 */
export const resolveConnection = (env) => {
  for (const name of ['DATABASE_URL_UNPOOLED', 'DATABASE_URL']) {
    const value = env[name];
    if (typeof value === 'string' && value.length > 0) return { name, connectionString: value };
  }
  return null;
};

/**
 * WHO WE ARE CONNECTED AS, AND WHETHER THAT ROLE CAN SEE THE LEDGER.
 *
 * `job_run` and `job_event` are ENABLE **and** FORCE ROW LEVEL SECURITY, with
 * policies whose only branches are `current_setting('app.system_admin') = 'true'`
 * and `workspace_id = current_setting('app.workspace_id')`. A plain `pg` client
 * sets neither GUC, so a role without `rolbypassrls` matches no row anywhere —
 * not an error, a successful query over the empty set. This is the query that
 * turns that into something the script can say out loud.
 */
export const CONNECTION_SQL = `
  SELECT current_user AS role,
         COALESCE((SELECT r.rolbypassrls
                     FROM pg_roles r
                    WHERE r.rolname = current_user), false)          AS bypasses_rls,
         COALESCE(current_setting('app.system_admin', true), '') = 'true' AS system_admin,
         COALESCE(current_setting('app.workspace_id', true), '')     AS workspace_id,
         COALESCE((SELECT c.relforcerowsecurity
                     FROM pg_class c
                    WHERE c.oid = to_regclass('job_run')), false)    AS job_run_forced,
         COALESCE((SELECT c.relforcerowsecurity
                     FROM pg_class c
                    WHERE c.oid = to_regclass('job_event')), false)  AS job_event_forced
`;

/**
 * Can this connection see the WHOLE ledger?
 *
 * Three ways yes: it bypasses RLS; it carries the system-admin context the
 * policies' first branch admits; or the tables are not force-RLS at all (a local
 * database built without the RLS migrations, where the guard would otherwise
 * refuse every legitimate run).
 *
 * ⚠️ A WORKSPACE GUC IS **NOT** ONE OF THEM. It admits exactly one tenant's rows,
 * and a p95 over one workspace is a different statistic wearing this one's name —
 * which is the failure mode the whole epic is judged on. It is reported in the
 * refusal rather than accepted.
 */
export const canSeeLedger = (c) =>
  Boolean(c.bypasses_rls) ||
  Boolean(c.system_admin) ||
  !(Boolean(c.job_run_forced) || Boolean(c.job_event_forced));

export const describeConnection = (c) =>
  `Connected as ${c.role} via ${c.urlEnv} ` +
  `(bypasses RLS: ${c.bypasses_rls ? 'yes' : 'no'}; ` +
  `app.system_admin: ${c.system_admin ? 'true' : 'unset'}; ` +
  `app.workspace_id: ${c.workspace_id ? c.workspace_id : 'unset'}; ` +
  `FORCE ROW LEVEL SECURITY: job_run ${c.job_run_forced ? 'yes' : 'no'}, ` +
  `job_event ${c.job_event_forced ? 'yes' : 'no'}).`;

/**
 * The refusal. It is the whole point of the card: the words that stop the next
 * reader taking an empty result for a measurement.
 */
export const formatBlindRead = (c) =>
  [
    'BLIND READ — this connection cannot see the ledger. Refusing to report.',
    '',
    describeConnection(c),
    '',
    'Every policy on job_run / job_event matches nothing for this role, so the',
    'measuring query would return the empty set — a successful query over no rows,',
    'which is indistinguishable from a quiet window. It is NOT a latency of zero and',
    'it is NOT "no fast-lane engine runs": it is an instrument that cannot see.',
    '',
    ...(c.workspace_id
      ? [
          'A workspace context IS set, so this connection could see ONE tenant. That is a',
          'different statistic from the lane-wide one this script reports, so it is refused',
          'rather than quietly narrowed.',
        ]
      : ['No tenant or system context is set at all.']),
    '',
    'Re-run with a credential that can read the whole ledger:',
    '  · DATABASE_URL_UNPOOLED (the owner role, rolbypassrls = true) — already present',
    '    in the motir-core machine environment, and what this script prefers by default; or',
    '  · the same url carrying the system-admin context the policies admit:',
    '      ...&options=-c%20app.system_admin%3Dtrue',
  ].join('\n');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

/** The SELECT. One statement, no writes. */
const QUERY = `
  SELECT e.id            AS event_id,
         e.received_at   AS received_at,
         r.started_at    AS started_at
    FROM job_run   r
    JOIN job_event e ON e.id = r.event_id
   WHERE r.function_id = ANY($1::text[])
     AND e.received_at >= $2
   ORDER BY e.received_at
`;

async function main() {
  const hours = Number(argOf('hours', 72));
  if (!Number.isFinite(hours) || hours <= 0) {
    console.error('--hours must be a positive number.');
    process.exit(EXIT_USAGE);
  }
  const resolved = resolveConnection(process.env);
  if (!resolved) {
    console.error(
      'DATABASE_URL_UNPOOLED or DATABASE_URL is required (read it from inside the deployment).',
    );
    process.exit(EXIT_USAGE);
  }

  const since = new Date(Date.now() - hours * 3600_000);
  const client = new pg.Client({ connectionString: resolved.connectionString });
  await client.connect();
  let connection;
  let rows;
  try {
    // ⚠️ THE VISIBILITY ASSERTION COMES FIRST, AND THE MEASURING QUERY IS NEVER
    // ISSUED WHEN IT FAILS. The guard is on ABSENCE: the old shape's only failure
    // mode was an empty result, and a blind connection produces exactly that.
    connection = { ...(await client.query(CONNECTION_SQL)).rows[0], urlEnv: resolved.name };
    if (!canSeeLedger(connection)) {
      console.error(formatBlindRead(connection));
      process.exitCode = EXIT_BLIND_READ;
      return;
    }
    const res = await client.query(QUERY, [FAST_LANE_CONSUMER_IDS, since]);
    rows = res.rows.map((r) => ({
      eventId: r.event_id,
      receivedAt: new Date(r.received_at).getTime(),
      startedAt: new Date(r.started_at).getTime(),
    }));
  } finally {
    await client.end();
  }

  const summary = summarise(lagsPerEvent(rows), {
    measuredOn: new Date().toISOString().slice(0, 10),
    windowHours: hours,
  });

  console.log(describeConnection(connection));
  console.log(`window:    ${since.toISOString()} → now  (${hours}h)`);
  console.log(`consumers: ${FAST_LANE_CONSUMER_IDS.join(', ')}`);
  console.log(`ledger rows matched: ${rows.length}`);
  console.log('');
  if (summary.samples === 0) {
    // Legible as "no data" rather than as a latency of zero — the distinction this
    // script is required to preserve. Reachable ONLY past the visibility assertion
    // above, which is what makes this sentence a statement about the WORLD rather
    // than about the connection: with a blind read it was a statement about the
    // connection wearing the grammar of a measurement (MOTIR-3593).
    console.log('samples: 0 — no fast-lane engine runs in this window. Nothing to report.');
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(JSON.stringify(summary, null, 2));
  console.log('');
  console.log(
    `median ${(summary.medianMs / 1000).toFixed(1)}s · ` +
      `p95 ${(summary.p95Ms / 1000).toFixed(1)}s · ` +
      `max ${(summary.maxMs / 1000).toFixed(1)}s`,
  );
}

// Only run when invoked directly, so the test can import the pure functions.
if (process.argv[1] && process.argv[1].endsWith('engine-fastlane-lag.mjs')) {
  await main();
}
