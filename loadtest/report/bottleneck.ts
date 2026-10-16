// THE FIRST BOTTLENECK — ONE, RANKED, WITH ITS READING (Story MOTIR-8538 · MOTIR-8679).
//
// Five candidates, each a saturation predicate read as a time series over the
// steady window. A candidate SATURATES when its predicate holds for
// `bottleneck.holdSeconds` (default 30 s) — measured as the span between the first
// and last sample of an unbroken run of saturated samples. The first bottleneck is
// the candidate whose saturation BEGAN EARLIEST; ties break in the order below.
//
//   proxy     `fly_app_concurrency` (per instance) ≥ hardLimit × fraction
//   cpu       busy CPUs from `fly_instance_cpu` (a counter in CENTISECONDS, modes
//             user/system/idle/iowait/steal): Δ(non-idle, non-iowait) / Δt / 100,
//             ≥ cpuBusyFraction × the machine's cpus — or the
//             `fly_instance_cpu_throttle` rate above cpuThrottleMax. The rates are
//             computed here from the raw counters, so a fixture can be read by eye.
//   memory    `fly_instance_memory_mem_available` ÷ `…_mem_total` < memoryAvailableMin
//   pool      mean `db_pool_waiting_at_acquire` ≥ poolWaitingMean, or
//             `db_tx_wait_seconds` p95 ≥ poolWaitP95Seconds
//   database  `db-samples.csv`: active ≥ dbActiveFraction × max_connections, or
//             lock_waiting ≥ dbLockWaiting
//
// A series that does not exist makes ITS candidate `unmeasured`; the ranking goes on.
// The Fly series names are the documented built-ins (docs.fly.io/monitoring/metrics).
// ⚠️ Not documented, so read from real data before the predicates are tuned: the
// `mode` label set of `fly_instance_cpu` on a shared-CPU machine, and what
// `fly_instance_cpu_balance` reads while a machine is throttled.

import type { TopStatementsResult, StatementRow } from '../../scripts/pgTopStatements';
import type { EndpointReading } from '../capture/neon';
import type { MachineRecord } from '../run/runRecord';
import type { DbSample, Reading } from './inputs';
import { sel, widen, type PromClient, type Series } from './prometheus';

export const CANDIDATES = ['proxy', 'cpu', 'memory', 'pool', 'database'] as const;
export type CandidateName = (typeof CANDIDATES)[number];

export const CANDIDATE_LABELS: Record<CandidateName, string> = {
  proxy: 'Fly proxy limit',
  cpu: 'app CPU',
  memory: 'app memory',
  pool: 'connection pool (wait/hold sink)',
  database: 'database (Neon load)',
};

export interface BottleneckConfig {
  holdSeconds: number;
  proxyHardLimitFraction: number;
  cpuBusyFraction: number;
  cpuThrottleMax: number;
  memoryAvailableMin: number;
  poolWaitingMean: number;
  poolWaitP95Seconds: number;
  dbActiveFraction: number;
  dbLockWaiting: number;
}

/** One instant of a candidate: whether its predicate held, and what it read. */
export interface Tick {
  t: number;
  saturated: boolean;
}

export interface Candidate {
  name: CandidateName;
  state: 'saturated' | 'not reached' | 'unmeasured';
  /** Epoch ms the qualifying saturation began. */
  onset: number | null;
  /** The peak reading, as printed. */
  peak: string;
  reason: string | null;
  /** Readings printed beside it (steal, throttle, proxy_shed, stream load…). */
  beside: string[];
}

/** The onset of the first unbroken saturated run lasting ≥ holdSeconds, else null. */
export function onsetOf(ticks: readonly Tick[], holdSeconds: number): number | null {
  const byT = new Map<number, boolean>();
  for (const k of ticks) byT.set(k.t, (byT.get(k.t) ?? false) || k.saturated);
  const sorted = [...byT.entries()].sort((a, b) => a[0] - b[0]);
  let runStart: number | null = null;
  for (const [t, sat] of sorted) {
    if (!sat) {
      runStart = null;
      continue;
    }
    runStart ??= t;
    if (t - runStart >= holdSeconds * 1000) return runStart;
  }
  return null;
}

function finish(
  name: CandidateName,
  ticks: Tick[],
  hold: number,
  peak: string,
  beside: string[] = [],
): Candidate {
  const onset = onsetOf(ticks, hold);
  return {
    name,
    state: onset === null ? 'not reached' : 'saturated',
    onset,
    peak,
    reason: null,
    beside,
  };
}

const missing = (name: CandidateName, reason: string, beside: string[] = []): Candidate => ({
  name,
  state: 'unmeasured',
  onset: null,
  peak: 'unmeasured',
  reason,
  beside,
});

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Per-step rates of a counter series (Δvalue / Δseconds), dropping resets. */
export function rates(values: readonly [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 1; i < values.length; i += 1) {
    const [t0, v0] = values[i - 1]!;
    const [t1, v1] = values[i]!;
    if (t1 > t0 && v1 >= v0) out.push([t1, (v1 - v0) / (t1 - t0)]);
  }
  return out;
}

export interface BottleneckContext {
  prom: PromClient;
  steady: { start: number; end: number };
  machines: MachineRecord[] | null;
  hardLimit: number | null;
  config: BottleneckConfig;
  dbSamples: Reading<DbSample[]>;
  endpointStart: Reading<EndpointReading>;
  endpointEnd: Reading<EndpointReading>;
  readerStreamsPerInstance: number;
  proxyShedSummary: string;
}

export async function proxyCandidate(ctx: BottleneckContext): Promise<Candidate> {
  const beside = [`proxy_shed: ${ctx.proxyShedSummary}`];
  if (ctx.hardLimit === null)
    return missing('proxy', 'run.json has no concurrency hardLimit', beside);
  const { start, end } = widen(ctx.steady.start, ctx.steady.end);
  const r = await ctx.prom.range(
    `max by (instance) (fly_app_concurrency${sel(ctx.prom.app)})`,
    start,
    end,
  );
  if (r.state !== 'ok') return missing('proxy', r.reason, beside);
  if (r.value.length === 0)
    return missing('proxy', 'fly_app_concurrency is absent for this app', beside);
  const limit = ctx.hardLimit * ctx.config.proxyHardLimitFraction;
  const ticks: Tick[] = [];
  let peak = 0;
  for (const s of r.value)
    for (const [t, v] of s.values) {
      peak = Math.max(peak, v);
      ticks.push({ t: t * 1000, saturated: v >= limit });
    }
  return finish(
    'proxy',
    ticks,
    ctx.config.holdSeconds,
    `${peak} concurrent (hard limit ${ctx.hardLimit})`,
    beside,
  );
}

export async function cpuCandidate(ctx: BottleneckContext): Promise<Candidate> {
  const { start, end } = widen(ctx.steady.start, ctx.steady.end);
  const app = ctx.prom.app;
  const cpu = await ctx.prom.range(
    `sum by (instance, mode) (fly_instance_cpu${sel(app)})`,
    start,
    end,
  );
  if (cpu.state !== 'ok') return missing('cpu', cpu.reason);
  if (cpu.value.length === 0) return missing('cpu', 'fly_instance_cpu is absent for this app');
  const throttle = await ctx.prom.range(
    `sum by (instance) (fly_instance_cpu_throttle${sel(app)})`,
    start,
    end,
  );

  const cpusOf = new Map(
    (ctx.machines ?? []).map((m) => [m.id, typeof m.cpus === 'number' ? m.cpus : null]),
  );
  // busy[instance][t] = Σ rate over modes other than idle / iowait, in CPUs.
  const busy = new Map<string, Map<number, number>>();
  const steal = new Map<string, Map<number, number>>();
  for (const s of cpu.value) {
    const inst = s.labels['instance'] ?? 'unknown';
    const mode = s.labels['mode'] ?? '';
    if (/^(idle|iowait)$/.test(mode)) continue;
    // `steal` is busy time (mode!~"idle|iowait") and is printed on its own beside it.
    for (const into of mode === 'steal' ? [busy, steal] : [busy]) {
      const m = into.get(inst) ?? new Map<number, number>();
      for (const [t, rate] of rates(s.values)) m.set(t, (m.get(t) ?? 0) + rate / 100);
      into.set(inst, m);
    }
  }
  const throttleOf = new Map<string, Map<number, number>>();
  if (throttle.state === 'ok')
    for (const s of throttle.value)
      throttleOf.set(
        s.labels['instance'] ?? 'unknown',
        new Map(rates(s.values).map(([t, v]) => [t, v / 100])),
      );

  const ticks: Tick[] = [];
  let peakBusy = 0;
  let peakSteal = 0;
  let peakThrottle = 0;
  const unknownCpus: string[] = [];
  for (const [inst, series] of busy) {
    const cpus = cpusOf.get(inst) ?? null;
    if (cpus === null) {
      unknownCpus.push(inst);
      continue;
    }
    for (const [t, b] of series) {
      const th = throttleOf.get(inst)?.get(t) ?? 0;
      peakBusy = Math.max(peakBusy, b / cpus);
      peakThrottle = Math.max(peakThrottle, th);
      ticks.push({
        t: t * 1000,
        saturated: b >= ctx.config.cpuBusyFraction * cpus || th > ctx.config.cpuThrottleMax,
      });
    }
  }
  for (const m of steal.values()) for (const v of m.values()) peakSteal = Math.max(peakSteal, v);
  const beside = [
    `steal peak ${r2(peakSteal)} CPU-s/s`,
    throttle.state === 'ok' && throttle.value.length > 0
      ? `throttle peak ${r2(peakThrottle)} CPU-s/s (limit ${ctx.config.cpuThrottleMax})`
      : `throttle unmeasured (${throttle.state === 'ok' ? 'fly_instance_cpu_throttle is absent' : throttle.reason})`,
  ];
  if (ticks.length === 0) {
    return missing(
      'cpu',
      unknownCpus.length > 0
        ? `the cpus of ${unknownCpus.join(', ')} are not in run.json`
        : 'too few fly_instance_cpu samples for a rate',
      beside,
    );
  }
  return finish(
    'cpu',
    ticks,
    ctx.config.holdSeconds,
    `${r2(peakBusy)} of the machine's CPUs busy`,
    beside,
  );
}

export async function memoryCandidate(ctx: BottleneckContext): Promise<Candidate> {
  const { start, end } = widen(ctx.steady.start, ctx.steady.end);
  const app = ctx.prom.app;
  const [avail, total] = [
    await ctx.prom.range(
      `sum by (instance) (fly_instance_memory_mem_available${sel(app)})`,
      start,
      end,
    ),
    await ctx.prom.range(
      `sum by (instance) (fly_instance_memory_mem_total${sel(app)})`,
      start,
      end,
    ),
  ];
  if (avail.state !== 'ok') return missing('memory', avail.reason);
  if (total.state !== 'ok') return missing('memory', total.reason);
  if (avail.value.length === 0 || total.value.length === 0)
    return missing('memory', 'fly_instance_memory_mem_available / _mem_total are absent');
  const totals = new Map<string, Map<number, number>>();
  for (const s of total.value) totals.set(s.labels['instance'] ?? '', new Map(s.values));
  const ticks: Tick[] = [];
  let lowest = 1;
  for (const s of avail.value)
    for (const [t, a] of s.values) {
      const tot = totals.get(s.labels['instance'] ?? '')?.get(t);
      if (!tot) continue;
      lowest = Math.min(lowest, a / tot);
      ticks.push({ t: t * 1000, saturated: a / tot < ctx.config.memoryAvailableMin });
    }
  return finish(
    'memory',
    ticks,
    ctx.config.holdSeconds,
    `available down to ${r2(lowest * 100)} % of total`,
  );
}

export async function poolCandidate(ctx: BottleneckContext): Promise<Candidate> {
  const { start, end } = widen(ctx.steady.start, ctx.steady.end);
  const app = ctx.prom.app;
  const waiting = await ctx.prom.range(
    `sum(rate(db_pool_waiting_at_acquire_sum${sel(app)}[1m])) / sum(rate(db_pool_waiting_at_acquire_count${sel(app)}[1m]))`,
    start,
    end,
  );
  const p95 = await ctx.prom.range(
    `histogram_quantile(0.95, sum by (le) (rate(db_tx_wait_seconds_bucket${sel(app)}[1m])))`,
    start,
    end,
  );
  if (waiting.state !== 'ok') return missing('pool', waiting.reason);
  if (p95.state !== 'ok') return missing('pool', p95.reason);
  if (waiting.value.length === 0 && p95.value.length === 0)
    return missing('pool', 'the wait/hold sink series are absent for this app');
  const ticks: Tick[] = [];
  let peakWaiting = 0;
  let peakP95 = 0;
  const each = (rows: Series[], limit: number, peak: (v: number) => void) => {
    for (const s of rows)
      for (const [t, v] of s.values) {
        if (!Number.isFinite(v)) continue;
        peak(v);
        ticks.push({ t: t * 1000, saturated: v >= limit });
      }
  };
  each(waiting.value, ctx.config.poolWaitingMean, (v) => (peakWaiting = Math.max(peakWaiting, v)));
  each(p95.value, ctx.config.poolWaitP95Seconds, (v) => (peakP95 = Math.max(peakP95, v)));
  return finish(
    'pool',
    ticks,
    ctx.config.holdSeconds,
    `mean waiting ${r2(peakWaiting)}, wait p95 ${r2(peakP95)} s`,
    ['the app pg.Pool (default max 10 per runtime) is the likelier first limit than the database'],
  );
}

function endpointRange(e: Reading<EndpointReading>): string {
  if (e.state !== 'ok') return `unmeasured (${e.reason})`;
  if (e.value.state !== 'ok') return `unmeasured (${e.value.reason})`;
  return e.value.endpoints
    .map(
      (x) =>
        `${String(x.id)} ${String(x.current_state)} ${String(x.autoscaling_limit_min_cu)}–${String(x.autoscaling_limit_max_cu)} CU`,
    )
    .join('; ');
}

export function databaseCandidate(ctx: BottleneckContext): Candidate {
  const beside = [
    'reads the DIRECT endpoint only, so it cannot see pooler saturation',
    `readerStreamsPerInstance ${ctx.readerStreamsPerInstance} (each held stream is one watermark read per second of background load)`,
    `endpoint at start: ${endpointRange(ctx.endpointStart)}; at end: ${endpointRange(ctx.endpointEnd)}`,
    'compute at its autoscaling maximum: unmeasured (the endpoint record carries the range, not the current size)',
  ];
  if (ctx.dbSamples.state !== 'ok') return missing('database', ctx.dbSamples.reason, beside);
  const ticks: Tick[] = [];
  let peakActive = 0;
  let peakLock = 0;
  for (const s of ctx.dbSamples.value) {
    const t = Date.parse(s.at);
    if (Number.isNaN(t) || t < ctx.steady.start || t > ctx.steady.end) continue;
    const frac = s.max_connections > 0 ? s.active / s.max_connections : 0;
    peakActive = Math.max(peakActive, frac);
    peakLock = Math.max(peakLock, s.lock_waiting);
    ticks.push({
      t,
      saturated: frac >= ctx.config.dbActiveFraction || s.lock_waiting >= ctx.config.dbLockWaiting,
    });
  }
  if (ticks.length === 0)
    return missing('database', 'no database sample inside the steady window', beside);
  return finish(
    'database',
    ticks,
    ctx.config.holdSeconds,
    `active ${r2(peakActive * 100)} % of max_connections, ${peakLock} waiting on Lock`,
    beside,
  );
}

export async function readCandidates(ctx: BottleneckContext): Promise<Candidate[]> {
  return [
    await proxyCandidate(ctx),
    await cpuCandidate(ctx),
    await memoryCandidate(ctx),
    await poolCandidate(ctx),
    databaseCandidate(ctx),
  ];
}

export type FirstBottleneck =
  | { kind: 'candidate'; name: CandidateName; onset: string }
  | {
      kind: 'unattributed';
      worstRouteByP95: string;
      worstWaitRoute: string;
      topStatement: string;
    }
  | { kind: 'none' };

/** Earliest onset wins; ties in CANDIDATES order. */
export function rankCandidates(
  candidates: readonly Candidate[],
  anyFail: boolean,
  fallback: { worstRouteByP95: string; worstWaitRoute: string; topStatement: string },
): FirstBottleneck {
  const saturated = candidates
    .filter((c) => c.state === 'saturated' && c.onset !== null)
    .sort((a, b) => a.onset! - b.onset! || CANDIDATES.indexOf(a.name) - CANDIDATES.indexOf(b.name));
  const first = saturated[0];
  if (first)
    return { kind: 'candidate', name: first.name, onset: new Date(first.onset!).toISOString() };
  if (anyFail) return { kind: 'unattributed', ...fallback };
  return { kind: 'none' };
}

// ── The pg_stat_statements delta ─────────────────────────────────────────────

export interface StatementDeltaRow {
  query: string;
  callsDelta: number;
  totalMsDelta: number;
}

export type StatementDelta =
  | { state: 'ok'; top: StatementDeltaRow[]; entered: string[]; left: string[] }
  | { state: 'unmeasured'; reason: string };

const normalise = (q: string) => q.replace(/\s+/g, ' ').trim();

/**
 * The top 10 statements by total-time DELTA between the two snapshots. Top-N lists
 * with no `queryid`: only statements present in BOTH (by normalised text) are
 * diffed; the rest are listed as `entered` / `left`, never treated as zero.
 */
export function statementDelta(
  before: Reading<TopStatementsResult>,
  after: Reading<TopStatementsResult>,
  top = 10,
): StatementDelta {
  if (before.state !== 'ok')
    return { state: 'unmeasured', reason: `pgss-before: ${before.reason}` };
  if (after.state !== 'ok') return { state: 'unmeasured', reason: `pgss-after: ${after.reason}` };
  const [b, a] = [before.value, after.value];
  if (b.state !== 'ok') return { state: 'unmeasured', reason: `pgss-before is ${b.state}` };
  if (a.state !== 'ok') return { state: 'unmeasured', reason: `pgss-after is ${a.state}` };
  if (b.coverage.statsReset !== a.coverage.statsReset)
    return {
      state: 'unmeasured',
      reason: `stats_reset differs between the snapshots (${b.coverage.statsReset} → ${a.coverage.statsReset})`,
    };
  if (b.answeredBy.computeStartedAt !== a.answeredBy.computeStartedAt)
    return { state: 'unmeasured', reason: 'the compute restarted between the snapshots' };
  const index = (rows: StatementRow[]) => new Map(rows.map((r) => [normalise(r.query), r]));
  const [ib, ia] = [index(b.byTotalTime), index(a.byTotalTime)];
  const rows: StatementDeltaRow[] = [];
  for (const [q, ra] of ia) {
    const rb = ib.get(q);
    if (rb)
      rows.push({
        query: q,
        callsDelta: ra.calls - rb.calls,
        totalMsDelta: ra.totalMs - rb.totalMs,
      });
  }
  rows.sort((x, y) => y.totalMsDelta - x.totalMsDelta);
  return {
    state: 'ok',
    top: rows.slice(0, top),
    entered: [...ia.keys()].filter((q) => !ib.has(q)),
    left: [...ib.keys()].filter((q) => !ia.has(q)),
  };
}

// ── Wait / hold per route and per tool ───────────────────────────────────────

export interface WaitHoldRow {
  by: 'route' | 'tool';
  name: string;
  waitP95: number | null;
  waitP99: number | null;
  holdP95: number | null;
  holdP99: number | null;
}

/** `histogram_quantile` exactly as docs/monitoring/request-db-timing.md writes it, over the steady window. */
export async function readWaitHold(
  prom: PromClient,
  steady: { start: number; end: number },
): Promise<Reading<WaitHoldRow[]>> {
  const { start, end } = widen(steady.start, steady.end);
  const span = `${Math.max(60, Math.round((end.getTime() - start.getTime()) / 1000))}s`;
  const rows = new Map<string, WaitHoldRow>();
  for (const by of ['route', 'tool'] as const) {
    const extra = by === 'tool' ? 'route="mcp"' : '';
    for (const metric of ['wait', 'hold'] as const)
      for (const q of [0.95, 0.99] as const) {
        const r = await prom.instant(
          `histogram_quantile(${q}, sum by (le, ${by}) (increase(db_tx_${metric}_seconds_bucket${sel(prom.app, extra)}[${span}])))`,
          end,
        );
        if (r.state !== 'ok') return r;
        for (const s of r.value) {
          const name = s.labels[by] ?? 'unknown';
          const k = `${by}:${name}`;
          const row = rows.get(k) ?? {
            by,
            name,
            waitP95: null,
            waitP99: null,
            holdP95: null,
            holdP99: null,
          };
          const v = s.values.at(-1)?.[1];
          const field = `${metric}P${q === 0.95 ? 95 : 99}` as 'waitP95';
          row[field] = v !== undefined && Number.isFinite(v) ? v : null;
          rows.set(k, row);
        }
      }
  }
  return { state: 'ok', value: [...rows.values()] };
}
