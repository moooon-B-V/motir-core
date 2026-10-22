// k6's RAW POINTS, AGGREGATED (Story MOTIR-8538 · MOTIR-8679).
//
// `k6-points.json.gz` is k6's `--out json`: one JSON object per line, `type: Point`
// lines carrying `{ metric, data: { time, value, tags } }`. It is streamed (gunzip,
// line split), never loaded whole.
//
// ONE SOURCE PER SCENARIO, separated by the `role` tag (never k6's `scenario` tag):
//   agent  counts from `mcp_calls`        latency from `mcp_call_duration`
//   run    counts from `run_steps`        latency from `run_step_duration`
//   reader counts from `reader_requests`  latency from `reader_duration`
// Counts of `error` / `limited` / `empty` come from the Counters, because the Trends
// hold `ok` samples only. k6's built-in `http_req_duration` is NEVER read: its tags
// are fixed before the response arrives, so it cannot carry `outcome`.
//
// Judged numbers cover the STEADY window only (`rampEndedAt` → `steadyEndedAt`).
// The held-stream counters and the client 503 count cover the whole run: a stream
// lost while the run ramps down is still lost.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

export type Source = 'mcp' | 'run' | 'reader';

/** Metric → the source it counts for, and the tag naming its row. */
const COUNTERS: Record<string, { source: Source; role: string; label: string }> = {
  mcp_calls: { source: 'mcp', role: 'agent', label: 'group' },
  run_steps: { source: 'run', role: 'run', label: 'step' },
  reader_requests: { source: 'reader', role: 'reader', label: 'route' },
};
const TRENDS: Record<string, { source: Source; role: string; label: string }> = {
  mcp_call_duration: { source: 'mcp', role: 'agent', label: 'group' },
  run_step_duration: { source: 'run', role: 'run', label: 'step' },
  reader_duration: { source: 'reader', role: 'reader', label: 'route' },
};
const STREAM_COUNTERS = [
  'stream_opened',
  'stream_open_at_end',
  'stream_reconnected',
  'stream_lost',
] as const;

export const STREAM_ROUTE = 'workbench_stream';
export const RECYCLE_STEP = 'recycle';

export interface CountRow {
  source: Source;
  /** The MCP `group`, run `step` or reader `route`. */
  label: string;
  /** The MCP `tool`; equal to `label` for run and reader rows. */
  detail: string;
  outcome: string;
  n: number;
}

/** One agent-mix class's steady-window counts by outcome and `ok` latency samples (ms). */
export interface MixCell {
  outcomes: Record<string, number>;
  samples: number[];
}

/** k6's `scenario` tag on a reader point → the reader sub-class it names. */
export const READER_SUBCLASSES: Readonly<Record<string, string>> = {
  reader_tab: 'tab',
  reader_browse: 'browse',
};

/**
 * The agent-mix classes one judged point counts toward (mix.ts): an MCP point its
 * `group`, a run point `run`, a reader point `readers` and — when k6's `scenario`
 * tag names one — `readers.tab` / `readers.browse` as well. The held stream and the
 * run recycle step are in none, as they are not in served throughput.
 */
export function mixClassesOf(
  source: Source,
  label: string,
  tags: Readonly<Record<string, string>>,
): string[] {
  if (source === 'mcp') return [label];
  if (source === 'run') return label === RECYCLE_STEP ? [] : ['run'];
  if (label === STREAM_ROUTE) return [];
  const sub = READER_SUBCLASSES[tags['scenario'] ?? ''];
  return sub ? ['readers', `readers.${sub}`] : ['readers'];
}

export interface PointsAggregate {
  steadySeconds: number;
  /** Steady-window counts, one row per (source, label, detail, outcome). */
  counts: CountRow[];
  /** Steady-window `ok` latency samples (ms), keyed `source:label:detail`. */
  latency: Map<string, number[]>;
  /** Steady-window counts and `ok` latency per agent-mix class (`mixClassesOf`). */
  mix: Map<string, MixCell>;
  /** Steady-window `retry_after_seconds` samples. */
  retryAfter: number[];
  /** Whole run. */
  streams: Record<(typeof STREAM_COUNTERS)[number], number>;
  http503: number;
  /** Whole run, for the `summary.json` cross-check. */
  limitedWholeRun: { mcp: number; run: number };
  /** Judged samples that fell outside the steady window (ramp and ramp-down). */
  outsideSteady: number;
}

/** Epoch ms from k6's RFC 3339 time (nanosecond fraction allowed). */
export function pointTime(time: string): number {
  return Date.parse(time.replace(/(\.\d{3})\d+/, '$1'));
}

/** The exact percentile of a sample set (nearest rank on the sorted samples). */
export function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1]!;
}

export const latencyKey = (source: Source, label: string, detail: string) =>
  `${source}:${label}:${detail}`;

export async function aggregatePoints(
  path: string,
  steady: { start: number; end: number },
  run: { start: number; end: number },
): Promise<PointsAggregate> {
  const counts = new Map<string, CountRow>();
  const latency = new Map<string, number[]>();
  const mix = new Map<string, MixCell>();
  const retryAfter: number[] = [];
  const streams = {
    stream_opened: 0,
    stream_open_at_end: 0,
    stream_reconnected: 0,
    stream_lost: 0,
  };
  let http503 = 0;
  const limitedWholeRun = { mcp: 0, run: 0 };
  let outsideSteady = 0;

  const lines = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.includes('"Point"')) continue;
    let p: {
      type?: string;
      metric?: string;
      data?: { time?: string; value?: number; tags?: Record<string, string> };
    };
    try {
      p = JSON.parse(line);
    } catch {
      continue;
    }
    if (p.type !== 'Point' || !p.metric || !p.data?.time) continue;
    const t = pointTime(p.data.time);
    const value = Number(p.data.value ?? 0);
    const tags = p.data.tags ?? {};
    const inRun = t >= run.start && t <= run.end;
    const inSteady = t >= steady.start && t <= steady.end;

    if ((STREAM_COUNTERS as readonly string[]).includes(p.metric)) {
      if (inRun) streams[p.metric as (typeof STREAM_COUNTERS)[number]] += value;
      continue;
    }
    if (p.metric === 'http_503') {
      if (inRun) http503 += value;
      continue;
    }
    const counter = COUNTERS[p.metric];
    const trend = TRENDS[p.metric];
    const spec = counter ?? trend;
    if (!spec && p.metric !== 'retry_after_seconds') continue;
    if (spec && tags['role'] !== spec.role) continue;

    if (counter && inRun && tags['outcome'] === 'limited' && counter.source !== 'reader') {
      limitedWholeRun[counter.source] += value;
    }
    if (!inSteady) {
      if (spec) outsideSteady += 1;
      continue;
    }
    if (p.metric === 'retry_after_seconds') {
      if (tags['role'] === 'agent') retryAfter.push(value);
      continue;
    }
    const label = tags[spec!.label] ?? 'unknown';
    const detail = spec!.source === 'mcp' ? (tags['tool'] ?? 'unknown') : label;
    const outcome = tags['outcome'] ?? 'unknown';
    for (const c of mixClassesOf(spec!.source, label, tags)) {
      const cell = mix.get(c) ?? { outcomes: {}, samples: [] };
      if (counter) cell.outcomes[outcome] = (cell.outcomes[outcome] ?? 0) + value;
      else cell.samples.push(value);
      mix.set(c, cell);
    }
    if (counter) {
      const k = `${counter.source}\u0000${label}\u0000${detail}\u0000${outcome}`;
      const row = counts.get(k) ?? { source: counter.source, label, detail, outcome, n: 0 };
      row.n += value;
      counts.set(k, row);
    } else {
      const k = latencyKey(trend!.source, label, detail);
      const arr = latency.get(k) ?? [];
      arr.push(value);
      latency.set(k, arr);
    }
  }
  return {
    steadySeconds: (steady.end - steady.start) / 1000,
    counts: [...counts.values()],
    latency,
    mix,
    retryAfter,
    streams,
    http503,
    limitedWholeRun,
    outsideSteady,
  };
}

/** Every `ok` latency sample whose key matches. */
export function samplesWhere(
  agg: PointsAggregate,
  match: (source: Source, label: string, detail: string) => boolean,
): number[] {
  const out: number[] = [];
  for (const [k, v] of agg.latency) {
    const [source, label, detail] = k.split(':') as [Source, string, string];
    if (match(source, label, detail)) for (const x of v) out.push(x);
  }
  return out;
}

/** The sum of the count rows that match. */
export function countWhere(agg: PointsAggregate, match: (row: CountRow) => boolean): number {
  return agg.counts.filter(match).reduce((a, r) => a + r.n, 0);
}
