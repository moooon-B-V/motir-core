import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { boundedToolLabel, currentRequestLabel } from './requestLabel';
import { onTransactionMeasured, type TransactionMeasurement } from './transactionSpan';

// EVERY REQUEST'S TRANSACTION WAIT AND HOLD, SAMPLED OR NOT (MOTIR-8553).
//
// A Sentry trace is head-sampled, so at a production rate it cannot give a p99.
// This listener hears EVERY `TransactionMeasurement` (MOTIR-8550) and records it
// into in-process Prometheus histograms labelled with the request's route and MCP
// tool (`./requestLabel`). `./metricsServer` serves them on a private port that
// Fly's managed Prometheus scrapes (`[metrics]` in `fly.toml`), and
// `docs/monitoring/request-db-timing.md` holds the `histogram_quantile` queries.
//
// Why histograms: a summary's quantiles cannot be aggregated across instances,
// and a histogram's buckets can, so one query answers "this machine" and "the
// fleet". Fly adds `app`, `instance` and `region` at scrape time, so no label of
// ours names the machine. A histogram is a few increments per transaction and
// holds no per-request state, and nothing here needs a DSN or the database.
//
// ⚠️ THE REGISTRY AND ITS SERIES LIVE ON `globalThis` (MOTIR-7007): every
// Turbopack runtime's copy of this file must record into ONE set of series, or
// the scrape would show whichever runtime's copy the metrics server imported.
// It is a registry of our own, not prom-client's default, so nothing else in the
// process can add a series to the scrape.

const TX_SECONDS_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
const POOL_BUCKETS = [0, 1, 2, 4, 8, 16, 32, 64];

const TX_LABELS = ['route', 'tool', 'context', 'outcome', 'attempt'] as const;
const POOL_LABELS = ['route', 'tool'] as const;

export const REQUEST_DB_TIMING_METRICS = {
  wait: 'db_tx_wait_seconds',
  hold: 'db_tx_hold_seconds',
  poolWaiting: 'db_pool_waiting_at_acquire',
  poolIdle: 'db_pool_idle_at_acquire',
  poolMax: 'db_pool_max',
  poolCount: 'db_pool_count',
  poolUnmeasured: 'db_pool_unmeasured_total',
} as const;

interface RequestDbTimingState {
  registry: Registry;
  wait: Histogram<(typeof TX_LABELS)[number]>;
  hold: Histogram<(typeof TX_LABELS)[number]>;
  poolWaiting: Histogram<(typeof POOL_LABELS)[number]>;
  poolIdle: Histogram<(typeof POOL_LABELS)[number]>;
  poolMax: Gauge;
  poolCount: Gauge;
  poolUnmeasured: Counter<(typeof POOL_LABELS)[number]>;
  unsubscribe: (() => void) | null;
  failureReported: boolean;
}

const STATE_KEY = Symbol.for('motir.requestDbTiming.state');

type Holder = { [STATE_KEY]?: RequestDbTimingState };

function build(): RequestDbTimingState {
  const registry = new Registry();
  const registers = [registry];
  const m = REQUEST_DB_TIMING_METRICS;
  return {
    registry,
    wait: new Histogram({
      name: m.wait,
      help: 'Interactive transaction WAIT: the helper asked → the body started (pool acquire, BEGIN, set_config binds).',
      labelNames: TX_LABELS,
      buckets: TX_SECONDS_BUCKETS,
      registers,
    }),
    hold: new Histogram({
      name: m.hold,
      help: 'Interactive transaction HOLD: the body started → COMMIT or ROLLBACK. Absent when the body never ran.',
      labelNames: TX_LABELS,
      buckets: TX_SECONDS_BUCKETS,
      registers,
    }),
    poolWaiting: new Histogram({
      name: m.poolWaiting,
      help: 'Requests already queued for a pg connection when this transaction asked, summed over every pool.',
      labelNames: POOL_LABELS,
      buckets: POOL_BUCKETS,
      registers,
    }),
    poolIdle: new Histogram({
      name: m.poolIdle,
      help: 'Idle pg connections when this transaction asked, summed over every pool.',
      labelNames: POOL_LABELS,
      buckets: POOL_BUCKETS,
      registers,
    }),
    poolMax: new Gauge({
      name: m.poolMax,
      help: 'The summed pool max at the latest measured transaction.',
      registers,
    }),
    poolCount: new Gauge({
      name: m.poolCount,
      help: 'How many pg pools were registered at the latest measured transaction.',
      registers,
    }),
    poolUnmeasured: new Counter({
      name: m.poolUnmeasured,
      help: 'Transactions whose pool occupancy could not be read (no pool registered).',
      labelNames: POOL_LABELS,
      registers,
    }),
    unsubscribe: null,
    failureReported: false,
  };
}

function state(): RequestDbTimingState {
  const holder = globalThis as Holder;
  holder[STATE_KEY] ??= build();
  return holder[STATE_KEY];
}

/** The registry `./metricsServer` serves. */
export function requestDbTimingRegistry(): Registry {
  return state().registry;
}

/** Record one measurement under the current request's label. Exported for tests. */
export function recordTransactionMeasurement(measurement: TransactionMeasurement): void {
  const s = state();
  const label = currentRequestLabel();
  const route = label?.route ?? 'unlabelled';
  const tool = boundedToolLabel(label?.tool);
  const txLabels = {
    route,
    tool,
    context: measurement.context,
    outcome: measurement.outcome,
    attempt: String(measurement.attempt),
  };
  s.wait.observe(txLabels, measurement.waitMs / 1000);
  if (measurement.holdMs !== null) s.hold.observe(txLabels, measurement.holdMs / 1000);
  if (measurement.pool === 'unmeasured') {
    s.poolUnmeasured.inc({ route, tool });
    return;
  }
  s.poolWaiting.observe({ route, tool }, measurement.pool.waiting);
  s.poolIdle.observe({ route, tool }, measurement.pool.idle);
  s.poolMax.set(measurement.pool.max);
  s.poolCount.set(measurement.pool.count);
}

function listener(measurement: TransactionMeasurement): void {
  try {
    recordTransactionMeasurement(measurement);
  } catch (err) {
    // A recording must never fail the transaction it recorded. Said once, so a
    // broken registry does not write a line per transaction.
    const s = state();
    if (s.failureReported) return;
    s.failureReported = true;
    console.error('[requestDbTiming] recording a transaction measurement failed:', err);
  }
}

/** Start recording every transaction. Once per process; a second call is a no-op. */
export function registerRequestDbTimingListener(): void {
  const s = state();
  if (s.unsubscribe) return;
  s.unsubscribe = onTransactionMeasured(listener);
}

/** Tests only: stop listening and drop every series. */
export function resetRequestDbTimingForTests(): void {
  const holder = globalThis as Holder;
  holder[STATE_KEY]?.unsubscribe?.();
  delete holder[STATE_KEY];
}
