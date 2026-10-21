// A FIXTURE RUN DIRECTORY AND A STUB PROMETHEUS for the report's tests (Story
// MOTIR-8538 · MOTIR-8679). Not a test file: report.test.ts and bottleneck.test.ts
// build on it.
//
// The timeline: the run starts at T0, ramps for 60 s, holds a 300 s steady window,
// and ramps down for 30 s. The healthy shape serves 16 req/s in the steady window
// at well under every latency limit, and puts slow samples, errors and refusals in
// the RAMP and in k6's built-in `http_req_duration` — so a PASS on it proves both
// are never judged.
//
// The stub Prometheus answers every query from functions of time: an instant query
// calls the matching handler at `time`, a range query at every 15 s step. The
// Fly series shapes follow docs.fly.io/monitoring/metrics (read 2026-10-15); no
// managed Prometheus was reachable where this was written.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseLoadProfile } from '@/loadtest/profiles/schema';
import { resolveProfile } from '@/loadtest/profiles/resolve';
import { runReportCli } from '@/loadtest/report/report';
import type { RunRecord } from '@/loadtest/run/runRecord';

export const ROOT = resolve(__dirname, '../..');
export const APP = 'motir-core-staging';
export const T0 = Date.parse('2026-10-15T10:00:00.000Z');
export const RAMP = 60;
export const STEADY = 300;
export const DOWN = 30;
export const STEADY_START = T0 + RAMP * 1000;
export const STEADY_END = STEADY_START + STEADY * 1000;
export const ENDED = STEADY_END + DOWN * 1000;
export const iso = (ms: number) => new Date(ms).toISOString();
export const TOKEN = 'fm2_stubPromToken_abcdefghijklmnop';

export interface K6Point {
  metric: string;
  t: number;
  value: number;
  tags: Record<string, string>;
}

/** The points one classified request leaves: its Counter, and its Trend when `ok`. */
export function request(
  source: 'mcp' | 'run' | 'reader',
  label: string,
  outcome: string,
  ms: number,
  t: number,
  detail = label,
): K6Point[] {
  if (source === 'mcp') {
    const base = { role: 'agent', group: label, tool: detail };
    return [
      { metric: 'mcp_calls', t, value: 1, tags: { ...base, outcome } },
      ...(outcome === 'ok' ? [{ metric: 'mcp_call_duration', t, value: ms, tags: base }] : []),
    ];
  }
  if (source === 'run') {
    const base = { role: 'run', step: label };
    return [
      { metric: 'run_steps', t, value: 1, tags: { ...base, outcome } },
      ...(outcome === 'ok' ? [{ metric: 'run_step_duration', t, value: ms, tags: base }] : []),
      ...(outcome === 'limited' ? [{ metric: 'run_limited', t, value: 1, tags: base }] : []),
    ];
  }
  const base = { role: 'reader', route: label };
  return [
    { metric: 'reader_requests', t, value: 1, tags: { ...base, outcome, status: '200' } },
    ...(outcome === 'ok' && label !== 'workbench_stream'
      ? [{ metric: 'reader_duration', t, value: ms, tags: base }]
      : []),
  ];
}

/** One steady second: 16 served requests (6 MCP reads, 3 writes, 1 empty claim, 2 run steps, 4 reader). */
export function healthySecond(t: number): K6Point[] {
  const out: K6Point[] = [];
  for (let i = 0; i < 6; i += 1)
    out.push(...request('mcp', 'read', 'ok', 100 + i, t, 'get_work_item'));
  for (let i = 0; i < 3; i += 1)
    out.push(...request('mcp', 'write', 'ok', 300 + i, t, 'update_work_item'));
  out.push(...request('mcp', 'claim', 'empty', 50, t, 'claim_work_item'));
  out.push(...request('run', 'read', 'ok', 80, t));
  out.push(...request('run', 'heartbeat', 'ok', 150, t));
  out.push(...request('run', 'recycle', 'ok', 150, t));
  for (let i = 0; i < 4; i += 1) out.push(...request('reader', 'boards', 'ok', 200, t));
  return out;
}

/** The healthy run: steady seconds, a slow and failing ramp, and built-in samples that must be ignored. */
export function healthyPoints(): K6Point[] {
  const out: K6Point[] = [];
  for (let s = 0; s < STEADY; s += 1) out.push(...healthySecond(STEADY_START + s * 1000 + 500));
  for (let s = 0; s < RAMP; s += 5) {
    const t = T0 + s * 1000 + 100;
    out.push(...request('mcp', 'read', 'ok', 9000, t, 'get_work_item'));
    out.push(...request('mcp', 'write', 'error', 0, t, 'update_work_item'));
    out.push(...request('mcp', 'write', 'limited', 0, t, 'update_work_item'));
  }
  for (let s = 0; s < DOWN; s += 5)
    out.push(
      ...request('mcp', 'write', 'ok', 9000, STEADY_END + s * 1000 + 100, 'update_work_item'),
    );
  for (let s = 0; s < STEADY; s += 10)
    out.push({
      metric: 'http_req_duration',
      t: STEADY_START + s * 1000,
      value: 60_000,
      tags: { role: 'agent', name: 'mcp' },
    });
  out.push({
    metric: 'stream_opened',
    t: STEADY_START + 1000,
    value: 4,
    tags: { role: 'reader', route: 'workbench_stream' },
  });
  out.push({
    metric: 'stream_open_at_end',
    t: ENDED - 1000,
    value: 4,
    tags: { role: 'reader', route: 'workbench_stream' },
  });
  return out;
}

export function pointsFile(points: K6Point[]): Buffer {
  const lines = [
    JSON.stringify({
      type: 'Metric',
      metric: 'mcp_calls',
      data: { name: 'mcp_calls', type: 'counter' },
    }),
    ...points.map((p) =>
      JSON.stringify({
        metric: p.metric,
        type: 'Point',
        data: { time: iso(p.t).replace('Z', '123456Z'), value: p.value, tags: p.tags },
      }),
    ),
  ];
  return gzipSync(`${lines.join('\n')}\n`);
}

export function runRecord(n: number, overrides: Partial<RunRecord> = {}): RunRecord {
  const machines = Array.from({ length: n }, (_, i) => ({
    id: `m${i + 1}`,
    region: 'iad',
    cpuKind: 'shared',
    cpus: 1,
    memoryMb: 1024,
    imageRef: `registry.fly.io/${APP}:deployment-${'a'.repeat(40)}`,
  }));
  return {
    runId: n === 1 ? 'r1aaaaaaaa-run' : 'r2bbbbbbbb-run',
    profile: { name: 'smoke', path: 'loadtest/profiles/smoke.json', sha256: 'h'.repeat(64) },
    instances: n,
    instancesHeld: true,
    instancesChanged: [],
    window: {
      startedAt: iso(T0),
      rampEndedAt: iso(STEADY_START),
      steadyEndedAt: iso(STEADY_END),
      endedAt: iso(ENDED),
    },
    app: { name: APP, machines },
    production: { cpuKind: 'shared', cpus: 1, memoryMb: 1024 },
    candidateSize: false,
    scale: 'not-needed',
    sha: 'a'.repeat(40),
    shaReadFrom: 'image_ref tag',
    neon: {
      project: 'p-1',
      branchId: 'br-1',
      copiedAt: '2026-10-14T00:00:00.000Z',
      copiedAtField: 'last_reset_at',
      endpointHost: 'ep-1.neon.tech',
    },
    concurrency: { type: 'requests', softLimit: 960, hardLimit: 1200 },
    requiredConcurrency: { hard: 82 * n, soft: 66 * n },
    rateLimits: { apiV1: 'default', mcp: 'default', agentWorkspace: 'default' },
    offered: {
      rpsUpperBound: 35,
      perWorkspaceRps: 10,
      perTokenRps: { mcp: 1, apiV1: 0.5 },
      readerStreamsPerInstance: 6,
    },
    pin: { enforced: true, via: 'generator', unknownIdAnswer: 'status 503' },
    traceRate: 0.1,
    preflightExitCode: 0,
    generator: {
      app: 'motir-loadgen',
      machineId: 'gen1',
      region: 'iad',
      cpus: 4,
      startedAt: iso(T0 - 60_000),
      stoppedAt: iso(ENDED + 60_000),
    },
    k6: { version: 'v1.2.1', extensions: ['github.com/phymbert/xk6-sse v0.1.12'], exitCode: 0 },
    capture: { logLines: 2, logGaps: 0, logInstances: machines.map((m) => m.id), dbSamples: 40 },
    manifestDeleted: true,
    baseline: null,
    exitCode: 0,
    reason: null,
    ...overrides,
  };
}

/** `/proc/stat` samples every 5 s at a fixed utilisation, from `from` to `to` (ms). */
export function cpuCsv(util: (t: number) => number, from = T0 - 10_000, to = ENDED): string {
  const rows = ['epochSeconds,nproc,procStatCpu'];
  let busy = 0;
  let total = 0;
  for (let t = from; t <= to; t += 5000) {
    const u = util(t);
    busy += Math.round(2000 * u);
    total += 2000;
    rows.push(`${t / 1000},4,cpu  ${busy} 0 0 ${total - busy} 0 0 0 0 0 0`);
  }
  return `${rows.join('\n')}\n`;
}

const pgss = (statsReset: string, rows: { query: string; calls: number; totalMs: number }[]) => ({
  state: 'ok',
  readAt: iso(T0),
  limit: 200,
  extensionSchema: 'public',
  answeredBy: {
    host: 'ep-1.neon.tech',
    database: 'neondb',
    serverVersion: '17',
    computeStartedAt: '2026-10-15T09:00:00.000Z',
    latestMigration: null,
  },
  coverage: { statsReset, dealloc: 0, infoAvailable: true, insufficientPrivilegeRows: 0 },
  byTotalTime: rows.map((r) => ({ ...r, meanMs: r.totalMs / r.calls, maxMs: 1, rows: 1 })),
  byMeanTime: [],
  byCalls: [],
});

export interface FixtureOptions {
  n?: number;
  run?: Partial<RunRecord>;
  points?: K6Point[] | null;
  cpuUtil?: (t: number) => number;
  logs?: Record<string, unknown>[];
  gaps?: { from: string; to: string; exitCode: number }[];
  dbSamples?: { at: number; active: number; max: number; lock: number }[];
  pgssBefore?: unknown;
  pgssAfter?: unknown;
  omit?: string[];
}

export function writeRunDir(dir: string, o: FixtureOptions = {}): string {
  const n = o.n ?? 1;
  mkdirSync(dir, { recursive: true });
  const profile = parseLoadProfile(
    JSON.parse(readFileSync(join(ROOT, 'loadtest/profiles/smoke.json'), 'utf8')),
    n,
  );
  const files: Record<string, string | Buffer> = {
    'run.json': `${JSON.stringify(runRecord(n, o.run), null, 2)}\n`,
    'profile.resolved.json': `${JSON.stringify(resolveProfile(profile, n), null, 2)}\n`,
    'summary.json': JSON.stringify({
      metrics: { mcp_rate_limited: { passes: 12, fails: 1000 }, run_limited: { count: 0 } },
    }),
    'generator-cpu.csv': cpuCsv(o.cpuUtil ?? (() => 0.3)),
    'app-logs.ndjson': (
      o.logs ?? [
        { timestamp: iso(STEADY_START), instance: 'm1', message: 'GET /api/health/ready 200' },
      ]
    )
      .map((l) => JSON.stringify(l))
      .join('\n'),
    'app-logs.gaps.json': JSON.stringify(o.gaps ?? []),
    'db-samples.csv': [
      'at,backends,active,idle_in_transaction,lock_waiting,max_connections,xact_commit,xact_rollback,deadlocks,blks_read,blks_hit',
      ...(
        o.dbSamples ??
        Array.from({ length: 40 }, (_, i) => ({
          at: T0 + i * 10_000,
          active: 3,
          max: 100,
          lock: 0,
        }))
      ).map((s) => `${iso(s.at)},10,${s.active},0,${s.lock},${s.max},1,0,0,0,1`),
    ].join('\n'),
    'neon-endpoint-start.json': JSON.stringify({
      state: 'ok',
      readAt: iso(T0),
      endpoints: [
        {
          id: 'ep-1',
          type: 'read_write',
          current_state: 'active',
          autoscaling_limit_min_cu: 0.25,
          autoscaling_limit_max_cu: 2,
        },
      ],
    }),
    'neon-endpoint-end.json': JSON.stringify({
      state: 'ok',
      readAt: iso(ENDED),
      endpoints: [
        {
          id: 'ep-1',
          type: 'read_write',
          current_state: 'active',
          autoscaling_limit_min_cu: 0.25,
          autoscaling_limit_max_cu: 2,
        },
      ],
    }),
    'pgss-before.json': JSON.stringify(
      o.pgssBefore ??
        pgss('2026-10-15T09:00:00.000Z', [
          { query: 'SELECT  1', calls: 10, totalMs: 100 },
          { query: 'SELECT 2', calls: 5, totalMs: 50 },
        ]),
    ),
    'pgss-after.json': JSON.stringify(
      o.pgssAfter ??
        pgss('2026-10-15T09:00:00.000Z', [
          { query: 'SELECT 1', calls: 110, totalMs: 9100 },
          { query: 'UPDATE x', calls: 3, totalMs: 30 },
        ]),
    ),
  };
  if (o.points !== null) files['k6-points.json.gz'] = pointsFile(o.points ?? healthyPoints());
  for (const [name, body] of Object.entries(files))
    if (!o.omit?.includes(name)) writeFileSync(join(dir, name), body);
  return dir;
}

export { pgss as pgssSnapshot };

// ── The stub Prometheus ──────────────────────────────────────────────────────

export interface Sample {
  labels: Record<string, string>;
  value: number;
}
/** `t` is epoch seconds. */
export type Handler = [RegExp, (t: number) => Sample[]];

const since = (t: number) => Math.max(0, t - T0 / 1000);

/**
 * A healthy staging app at N instances, as a list of handlers (first match wins).
 * `ids` names the instances when they are not `m1`…`mN` (the run command's fake
 * platform calls its machines `app1`…).
 */
export function healthyProm(
  n: number,
  ids: string[] = Array.from({ length: n }, (_, i) => `m${i + 1}`),
): Handler[] {
  const each =
    (f: (t: number) => number, extra: Record<string, string> = {}) =>
    (t: number) =>
      ids.map((instance) => ({ labels: { instance, ...extra }, value: f(t) }));
  return [
    [/outcome=~"p2028_\.\*"/, () => []],
    [/outcome="committed"/, each((t) => since(t) * 10)],
    [/fly_app_http_responses_count/, each((t) => (since(t) * 16) / n, { status: '200' })],
    [/fly_app_concurrency/, each(() => 20)],
    [/fly_instance_cpu_throttle/, each(() => 0)],
    [
      /fly_instance_cpu\{/,
      (t) =>
        ids.flatMap((instance) => [
          { labels: { instance, mode: 'user' }, value: since(t) * 30 },
          { labels: { instance, mode: 'idle' }, value: since(t) * 70 },
        ]),
    ],
    [/mem_available/, each(() => 500)],
    [/mem_total/, each(() => 1000)],
    [/db_pool_waiting_at_acquire_sum/, () => [{ labels: {}, value: 0.1 }]],
    [/histogram_quantile\(0\.95, sum by \(le\) \(rate/, () => [{ labels: {}, value: 0.01 }]],
    [
      /sum by \(le, route\)/,
      () => [
        { labels: { route: 'mcp' }, value: 0.02 },
        { labels: { route: 'workbench_stream' }, value: 0.01 },
      ],
    ],
    [/sum by \(le, tool\)/, () => [{ labels: { tool: 'claim_work_item' }, value: 0.03 }]],
    [/db_tx_wait_seconds_count/, each((t) => since(t) * 10)],
  ];
}

export interface PromCall {
  url: URL;
  authorization: string | null;
}

/** A `fetch` that answers from handlers; `down` makes every call fail. */
export function promStub(handlers: Handler[], opts: { down?: boolean } = {}) {
  const calls: PromCall[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({ url, authorization: headers.get('authorization') });
    if (opts.down) throw new Error('connect ECONNREFUSED');
    const q = url.searchParams.get('query') ?? '';
    const h = handlers.find(([re]) => re.test(q));
    const at = (t: number) => (h ? h[1](t) : []);
    if (url.pathname.endsWith('/query_range')) {
      const [start, end, step] = ['start', 'end', 'step'].map((k) =>
        Number(url.searchParams.get(k)),
      );
      const series = new Map<
        string,
        { metric: Record<string, string>; values: [number, string][] }
      >();
      for (let t = start!; t <= end!; t += step!) {
        for (const s of at(t)) {
          const k = JSON.stringify(s.labels);
          const row = series.get(k) ?? { metric: s.labels, values: [] };
          row.values.push([t, String(s.value)]);
          series.set(k, row);
        }
      }
      return Response.json({
        status: 'success',
        data: { resultType: 'matrix', result: [...series.values()] },
      });
    }
    const t = Number(url.searchParams.get('time'));
    return Response.json({
      status: 'success',
      data: {
        resultType: 'vector',
        result: at(t).map((s) => ({ metric: s.labels, value: [t, String(s.value)] })),
      },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Prepend handlers so they win over the healthy ones. */
export const withHandlers = (base: Handler[], ...extra: Handler[]): Handler[] => [
  ...extra,
  ...base,
];

export const PROM_URL = 'http://prom.stub/prometheus/moooon';

/**
 * The real `pnpm loadtest:report` over a run directory, against the stub Prometheus.
 * Returns the exit code, the parsed report.json (null when none was written) and a
 * line lookup by profile key.
 */
export async function reportOn(
  dir: string,
  o: { handlers?: Handler[]; now?: number; env?: Record<string, string>; cwd?: string } = {},
) {
  const stub = promStub(o.handlers ?? healthyProm(1));
  const logs: string[] = [];
  const code = await runReportCli([dir], {
    env: { LOADTEST_FLY_PROM_TOKEN: TOKEN, LOADTEST_PROM_URL: PROM_URL, ...o.env },
    exec: async () => ({ code: 1, stdout: '', stderr: 'no flyctl here' }),
    cwd: o.cwd ?? dir,
    now: () => new Date(o.now ?? ENDED + 3_600_000),
    sleep: async () => undefined,
    log: (l) => logs.push(l),
    fetchImpl: stub.fetchImpl,
  });
  const file = join(dir, 'report.json');
  const json = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const line = (key: string) =>
    json?.lines.find((l: { key: string }) => l.key === key) as
      | { key: string; status: string; value: string; reason: string | null }
      | undefined;
  return { code, json, line, logs };
}
