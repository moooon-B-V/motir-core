// THE THRESHOLD LINES (Story MOTIR-8538 · MOTIR-8679).
//
// One line per threshold, `PASS` / `FAIL` / `unmeasured`, or `n/a` where it does not
// apply at this N — with the measured value beside the limit. Every limit comes from
// `profile.resolved.json`; none is written here. Every judged k6 number covers the
// STEADY window and comes from ONE source per scenario (k6Points.ts).
//
// `n/a` is NOT `unmeasured`: it never affects the verdict. `unmeasured` is a value
// with its reason, and a run with one cannot PASS.

import type { LoadProfile } from '../profiles/schema';
import {
  countWhere,
  percentile,
  samplesWhere,
  RECYCLE_STEP,
  STREAM_ROUTE,
  type CountRow,
  type PointsAggregate,
  type Source,
} from './k6Points';
import type { Reading } from './inputs';
import type { P2028Reading } from './p2028';

export type LineStatus = 'PASS' | 'FAIL' | 'unmeasured' | 'n/a';

export interface Line {
  /** The profile key the line judges, e.g. `perInstance.readP95Ms`. */
  key: string;
  name: string;
  status: LineStatus;
  value: string;
  limit: string;
  reason: string | null;
  /** Set when the line was measured with a saturated generator. */
  annotation?: string;
}

/** Each k6 outcome's bucket. Throughput counts `served` + `empty`; `refused` is its own line. */
export const OUTCOME_BUCKETS = {
  ok: 'served',
  empty: 'empty',
  limited: 'refused',
  error: 'error',
} as const;
export type Bucket = (typeof OUTCOME_BUCKETS)[keyof typeof OUTCOME_BUCKETS];
export const THROUGHPUT_BUCKETS: readonly Bucket[] = ['served', 'empty'];

const P = 'k6-points.json.gz';
const PROM = (series: string) => `prometheus:${series}`;
/** `run.json`'s `window` timestamps: without them no steady or whole-run window exists. */
const WINDOW = 'run.json#window';
const K6 = [P, WINDOW] as const;

/**
 * Every threshold key the profile carries → the run-directory inputs that back it.
 *
 * The story test gate (`tests/loadtest/storyGate.verdict.test.ts`) removes each
 * `perInstance` / `scaleOut` input in turn and expects that line `unmeasured`, so
 * every id there names one thing a test can take away:
 *   - a file name — the file is deleted from the run directory;
 *   - `run.json#window` — run.json's window timestamps are written as `unmeasured`;
 *   - `baseline:report.json` — the baseline run's report.json is deleted;
 *   - `prometheus:<series>` — that series answers no samples;
 *   - `prometheus:requests-by-instance` — neither per-instance request series
 *     (`fly_app_http_responses_count`, nor its `db_tx_wait_seconds_count` fallback)
 *     answers.
 * Cross-checks that never judge a line (summary.json, the app-log P2028 channel,
 * which can FAIL the line but never PASS it) are not backing inputs.
 * The `bottleneck` and `generator` keys configure the bottleneck ranking and the
 * generator-saturation check rather than a threshold line; their ids say which
 * series or files those read.
 */
export const THRESHOLD_INPUTS: Record<string, readonly string[]> = {
  'perInstance.targetRps': K6,
  'perInstance.readP95Ms': K6,
  'perInstance.readP99Ms': K6,
  'perInstance.mutateP95Ms': K6,
  'perInstance.mutateP99Ms': K6,
  'perInstance.errorRate': K6,
  'perInstance.p2028': [PROM('db_tx_wait_seconds_count'), WINDOW],
  'perInstance.streamLost': K6,
  'perInstance.rateLimitedMax': K6,
  'scaleOut.efficiency': [...K6, 'baseline:report.json', PROM('requests-by-instance')],
  'bottleneck.holdSeconds': [
    PROM('fly_app_concurrency'),
    PROM('fly_instance_cpu'),
    PROM('fly_instance_memory_mem_available'),
    PROM('db_pool_waiting_at_acquire'),
    'db-samples.csv',
  ],
  'bottleneck.proxyHardLimitFraction': [PROM('fly_app_concurrency'), 'run.json'],
  'bottleneck.cpuBusyFraction': [PROM('fly_instance_cpu'), 'run.json'],
  'bottleneck.cpuThrottleMax': [PROM('fly_instance_cpu_throttle')],
  'bottleneck.memoryAvailableMin': [
    PROM('fly_instance_memory_mem_available'),
    PROM('fly_instance_memory_mem_total'),
  ],
  'bottleneck.poolWaitingMean': [PROM('db_pool_waiting_at_acquire')],
  'bottleneck.poolWaitP95Seconds': [PROM('db_tx_wait_seconds_bucket')],
  'bottleneck.dbActiveFraction': ['db-samples.csv'],
  'bottleneck.dbLockWaiting': ['db-samples.csv'],
  'generator.cpuMeanMax': ['generator-cpu.csv', 'run.json'],
  'generator.cpuPeakMax': ['generator-cpu.csv', 'run.json'],
  'generator.peakSeconds': ['generator-cpu.csv', 'run.json'],
};

const bucketOf = (outcome: string): Bucket | null =>
  (OUTCOME_BUCKETS as Record<string, Bucket>)[outcome] ?? null;

const isStream = (r: Pick<CountRow, 'source' | 'label'>) =>
  r.source === 'reader' && r.label === STREAM_ROUTE;

/** Reads: MCP `group: read`, reader routes but the stream, and the run `read` step. */
export const isRead = (source: Source, label: string) =>
  (source === 'mcp' && label === 'read') ||
  (source === 'reader' && label !== STREAM_ROUTE) ||
  (source === 'run' && label === 'read');

/** Writes, claims and runs: MCP write/claim/burst and run steps but `read` and `recycle`. */
export const isMutate = (source: Source, label: string) =>
  (source === 'mcp' && ['write', 'claim', 'burst'].includes(label)) ||
  (source === 'run' && label !== 'read' && label !== RECYCLE_STEP);

/** Served requests per second over the steady window: served + empty, no stream, no recycle. */
export function servedRpsOf(agg: PointsAggregate): number {
  const n = countWhere(
    agg,
    (r) =>
      THROUGHPUT_BUCKETS.includes(bucketOf(r.outcome) as Bucket) &&
      !isStream(r) &&
      !(r.source === 'run' && r.label === RECYCLE_STEP),
  );
  return agg.steadySeconds > 0 ? n / agg.steadySeconds : 0;
}

export interface Measures {
  servedRps: number | null;
  perInstanceRps: number | null;
  refusals: { limited: number; denominator: number; retryAfterP95: number | null } | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => `${r2(n * 100)} %`;

export function evaluateLines(opts: {
  n: number;
  thresholds: LoadProfile['thresholds'];
  points: Reading<PointsAggregate>;
  p2028: P2028Reading;
  scaleOut: Line;
}): { lines: Line[]; measures: Measures } {
  const per = opts.thresholds.perInstance;
  const lines: Line[] = [];
  const measures: Measures = { servedRps: null, perInstanceRps: null, refusals: null };
  const agg = opts.points.state === 'ok' ? opts.points.value : null;
  const noPoints = opts.points.state === 'ok' ? null : opts.points.reason;
  const um = (key: string, name: string, limit: string, reason: string): Line => ({
    key,
    name,
    status: 'unmeasured',
    value: 'unmeasured',
    limit,
    reason,
  });

  // Throughput — judged at N = 1 only.
  const tLimit = `≥ ${per.targetRps} rps`;
  if (agg) {
    measures.servedRps = servedRpsOf(agg);
    measures.perInstanceRps = measures.servedRps / opts.n;
  }
  if (opts.n > 1) {
    lines.push({
      key: 'perInstance.targetRps',
      name: 'throughput',
      status: 'n/a',
      value:
        measures.perInstanceRps === null
          ? 'N > 1'
          : `N > 1 — ${r2(measures.perInstanceRps)} rps per instance (information)`,
      limit: tLimit,
      reason: null,
    });
  } else if (!agg) lines.push(um('perInstance.targetRps', 'throughput', tLimit, noPoints!));
  else
    lines.push({
      key: 'perInstance.targetRps',
      name: 'throughput',
      status: measures.servedRps! >= per.targetRps ? 'PASS' : 'FAIL',
      value: `${r2(measures.servedRps!)} rps served`,
      limit: tLimit,
      reason: null,
      annotation:
        'closed model: a miss can come from a slow server or from latency lengthening each VU cycle — read it beside the latency lines',
    });

  // Latency.
  const latency = (key: string, name: string, q: number, limitMs: number, match: typeof isRead) => {
    const limit = `≤ ${limitMs} ms`;
    if (!agg) return lines.push(um(key, name, limit, noPoints!));
    const v = percentile(samplesWhere(agg, match), q);
    if (v === null) return lines.push(um(key, name, limit, 'no ok samples in the steady window'));
    lines.push({
      key,
      name,
      status: v <= limitMs ? 'PASS' : 'FAIL',
      value: `${r2(v)} ms`,
      limit,
      reason: null,
    });
  };
  latency('perInstance.readP95Ms', 'reads p95', 0.95, per.readP95Ms, isRead);
  latency('perInstance.readP99Ms', 'reads p99', 0.99, per.readP99Ms, isRead);
  latency(
    'perInstance.mutateP95Ms',
    'writes, claims and runs p95',
    0.95,
    per.mutateP95Ms,
    isMutate,
  );
  latency(
    'perInstance.mutateP99Ms',
    'writes, claims and runs p99',
    0.99,
    per.mutateP99Ms,
    isMutate,
  );

  // Error rate: error ÷ (all − limited − stream). `empty` and a refused claim are not errors.
  const eLimit = `< ${pct(per.errorRate)}`;
  if (!agg) lines.push(um('perInstance.errorRate', 'error rate', eLimit, noPoints!));
  else {
    const errors = countWhere(agg, (r) => bucketOf(r.outcome) === 'error' && !isStream(r));
    const denom = countWhere(agg, (r) => bucketOf(r.outcome) !== 'refused' && !isStream(r));
    if (denom === 0)
      lines.push(
        um('perInstance.errorRate', 'error rate', eLimit, 'no requests in the steady window'),
      );
    else {
      const rate = errors / denom;
      lines.push({
        key: 'perInstance.errorRate',
        name: 'error rate',
        status: rate < per.errorRate || (per.errorRate === 0 && errors === 0) ? 'PASS' : 'FAIL',
        value: `${pct(rate)} (${errors} of ${denom})`,
        limit: eLimit,
        reason: null,
      });
    }
  }

  // P2028.
  const p = opts.p2028;
  lines.push({
    key: 'perInstance.p2028',
    name: 'P2028',
    status: p.status,
    // An unmeasured line never prints a count: a 0 summed over the instances that
    // WERE measured reads as a clean reading (the story gate, MOTIR-8681).
    value: p.total === null || p.status === 'unmeasured' ? 'unmeasured' : String(p.total),
    limit: `≤ ${p.limit}`,
    reason: p.reason,
    annotation: p.blindSpot,
  });

  // Held streams (whole run).
  const sLimit = `≤ ${per.streamLost}`;
  if (!agg) lines.push(um('perInstance.streamLost', 'held streams lost', sLimit, noPoints!));
  else {
    const s = agg.streams;
    lines.push({
      key: 'perInstance.streamLost',
      name: 'held streams lost',
      status: s.stream_lost <= per.streamLost ? 'PASS' : 'FAIL',
      value: `${s.stream_lost} (opened ${s.stream_opened}, open at end ${s.stream_open_at_end}, reconnected ${s.stream_reconnected})`,
      limit: sLimit,
      reason: null,
    });
  }

  // Rate-limit refusals — their own line, never folded into errors or success.
  const rLimit = `≤ ${pct(per.rateLimitedMax)}`;
  if (!agg) lines.push(um('perInstance.rateLimitedMax', 'rate-limit refusals', rLimit, noPoints!));
  else {
    const limitedBySource = new Map<Source, number>();
    for (const r of agg.counts)
      if (bucketOf(r.outcome) === 'refused')
        limitedBySource.set(r.source, (limitedBySource.get(r.source) ?? 0) + r.n);
    const limited = [...limitedBySource.values()].reduce((a, b) => a + b, 0);
    const contributing = limited > 0 ? new Set(limitedBySource.keys()) : null;
    const denominator = countWhere(agg, (r) => (contributing ? contributing.has(r.source) : true));
    const retryAfterP95 = percentile(agg.retryAfter, 0.95);
    measures.refusals = { limited, denominator, retryAfterP95 };
    const share = denominator > 0 ? limited / denominator : 0;
    lines.push({
      key: 'perInstance.rateLimitedMax',
      name: 'rate-limit refusals',
      status: share <= per.rateLimitedMax ? 'PASS' : 'FAIL',
      value: `${pct(share)} (${limited} refused of ${denominator}; retry_after p95 ${retryAfterP95 === null ? 'none' : `${r2(retryAfterP95)} s`})`,
      limit: rLimit,
      reason: null,
    });
  }

  lines.push(opts.scaleOut);
  return { lines, measures };
}

/** Per-route p95 / p99 and rps over the steady window, the first supporting table. */
export function routeTable(agg: PointsAggregate) {
  const rows = new Map<string, { route: string; served: number; samples: number[] }>();
  const name = (source: Source, label: string, detail: string) =>
    source === 'mcp' ? `mcp ${detail}` : `${source} ${label}`;
  for (const r of agg.counts) {
    const k = name(r.source, r.label, r.detail);
    const row = rows.get(k) ?? { route: k, served: 0, samples: [] };
    if (THROUGHPUT_BUCKETS.includes(bucketOf(r.outcome) as Bucket)) row.served += r.n;
    rows.set(k, row);
  }
  for (const [k, v] of agg.latency) {
    const [source, label, detail] = k.split(':') as [Source, string, string];
    const key = name(source, label, detail);
    const row = rows.get(key) ?? { route: key, served: 0, samples: [] };
    for (const x of v) row.samples.push(x);
    rows.set(key, row);
  }
  return [...rows.values()]
    .map((r) => ({
      route: r.route,
      rps: agg.steadySeconds > 0 ? r.served / agg.steadySeconds : 0,
      p95: percentile(r.samples, 0.95),
      p99: percentile(r.samples, 0.99),
    }))
    .sort((a, b) => (b.p95 ?? -1) - (a.p95 ?? -1));
}
