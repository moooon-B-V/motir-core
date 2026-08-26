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
// HOW TO RUN IT
// ===========================================================================
// The ledger is the production database, so this runs from INSIDE the
// deployment, which is what keeps the credential in the machine:
//
//   fly ssh console -a motir-core -C \
//     'node scripts/experiments/engine-fastlane-lag.mjs --hours 72'
//
// Locally, against a seeded database:
//   DATABASE_URL=postgres://… node scripts/experiments/engine-fastlane-lag.mjs --hours 72
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
 * The six fields `FAST_LANE_LATENCY_BUDGET.baseline` records, from a list of
 * lags in milliseconds. Shaped so the result drops into that constant without
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
    process.exit(1);
  }
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is required (read it from inside the deployment).');
    process.exit(1);
  }

  const since = new Date(Date.now() - hours * 3600_000);
  const client = new pg.Client({ connectionString });
  await client.connect();
  let rows;
  try {
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

  console.log(`window:    ${since.toISOString()} → now  (${hours}h)`);
  console.log(`consumers: ${FAST_LANE_CONSUMER_IDS.join(', ')}`);
  console.log(`ledger rows matched: ${rows.length}`);
  console.log('');
  if (summary.samples === 0) {
    // Legible as "no data" rather than as a latency of zero — the distinction
    // this script is required to preserve.
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
