import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TopStatementsResult } from '@/scripts/pgTopStatements';
import type { MachineRecord, RunRecord } from '@/loadtest/run/runRecord';
import {
  cpuCandidate,
  databaseCandidate,
  memoryCandidate,
  poolCandidate,
  proxyCandidate,
  rankCandidates,
  readWaitHold,
  statementDelta,
  type BottleneckContext,
  type Candidate,
} from '@/loadtest/report/bottleneck';
import {
  NoRunRecordError,
  loadRunInputs,
  ok,
  parseDbSamples,
  parseGeneratorCpu,
  unmeasured,
} from '@/loadtest/report/inputs';
import { aggregatePoints } from '@/loadtest/report/k6Points';
import {
  judgeP2028,
  readLogP2028,
  readPlatformP2028,
  type InstanceP2028,
} from '@/loadtest/report/p2028';
import {
  PROM_URL_DEFAULT,
  counterDelta,
  createPromClient,
  labelKey,
  namesProduction,
  type PromClient,
} from '@/loadtest/report/prometheus';
import { countProxyCodes, readPlatform503 } from '@/loadtest/report/proxyShed';
import { renderMarkdown } from '@/loadtest/report/render';
import { EXIT, buildReport, runReportCli, type ReportDeps } from '@/loadtest/report/report';
import {
  APP,
  ENDED,
  PROM_URL,
  STEADY_END,
  STEADY_START,
  T0,
  TOKEN,
  healthyProm,
  iso,
  pgssSnapshot,
  promStub,
  request,
  runRecord,
  withHandlers,
  writeRunDir,
  type FixtureOptions,
  type Handler,
  type K6Point,
} from './reportFixture';

// The report's less-travelled branches (Story MOTIR-8538 · MOTIR-8679): every input
// that is missing, refused, backwards or malformed, read through the real modules
// against a stub Prometheus fetch, and the CLI's own refusals.

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'loadtest-report-cov-'));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const S = STEADY_START / 1000;
const noFly = async () => ({ code: 1, stdout: '', stderr: 'no flyctl here' });

type Answer = unknown[] | number;
/** A real PromClient whose fetch answers `answer(query, time)`: a result list, or an HTTP status. */
function promOf(answer: (query: string, time: number) => Answer): PromClient {
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    const a = answer(url.searchParams.get('query') ?? '', Number(url.searchParams.get('time')));
    if (typeof a === 'number') return new Response('nope', { status: a });
    const resultType = url.pathname.endsWith('/query_range') ? 'matrix' : 'vector';
    return Response.json({ status: 'success', data: { resultType, result: a } });
  }) as typeof fetch;
  return createPromClient({
    app: APP,
    env: { LOADTEST_FLY_PROM_TOKEN: TOKEN },
    exec: noFly,
    fetchImpl,
  });
}

/** A range series; `labels` undefined leaves the `metric` key out. */
const series = (labels: Record<string, string> | undefined, values: [number, number][]) => ({
  metric: labels,
  values: values.map(([t, v]) => [t, String(v)]),
});
const vec = (labels: Record<string, string> | undefined, v: number) => ({
  metric: labels,
  value: [S, String(v)],
});

// ── inputs ───────────────────────────────────────────────────────────────────

describe('the run directory, read', () => {
  it('parseGeneratorCpu skips short, malformed and non-numeric lines, and reads a 4-field stat', () => {
    const csv = [
      'epochSeconds,nproc,procStatCpu',
      '100,4,cpu  10 0 0 30',
      '',
      '101,4',
      '102,4,cpu  1 2',
      '103,4,cpu  a b c d',
    ].join('\n');
    expect(parseGeneratorCpu(csv)).toEqual([{ epochSeconds: 100, nproc: 4, busy: 10, total: 40 }]);
  });

  it('parseDbSamples reads nothing from an empty file and 0 for a column the header lacks', () => {
    expect(parseDbSamples('')).toEqual([]);
    expect(parseDbSamples('at,active\n2026-10-15T10:00:00Z,7')).toEqual([
      {
        at: '2026-10-15T10:00:00Z',
        backends: 0,
        active: 7,
        idle_in_transaction: 0,
        lock_waiting: 0,
        max_connections: 0,
      },
    ]);
  });

  it('a recorder’s state file, an empty csv and an unparseable json are unmeasured with their reasons', async () => {
    const dir = writeRunDir(join(tmp, 'run'));
    writeFileSync(
      join(dir, 'summary.state.json'),
      JSON.stringify({ state: 'failed', reason: 'k6 crashed' }),
    );
    writeFileSync(join(dir, 'k6-points.state.json'), '{ not json');
    writeFileSync(join(dir, 'app-logs.state.json'), '{}');
    writeFileSync(join(dir, 'db-samples.state.json'), JSON.stringify({ state: 'partial' }));
    writeFileSync(join(dir, 'generator-cpu.csv'), 'epochSeconds,nproc,procStatCpu\n');
    writeFileSync(join(dir, 'pgss-before.json'), '{ truncated');
    const inputs = await loadRunInputs(dir);
    expect(inputs.summary).toEqual(unmeasured('summary.state.json says failed: k6 crashed'));
    expect(inputs.points).toEqual(unmeasured('k6-points.state.json is present'));
    expect(inputs.appLogs).toEqual(unmeasured('app-logs.state.json says failed'));
    expect(inputs.dbSamples).toEqual(unmeasured('db-samples.state.json says partial'));
    expect(inputs.generatorCpu).toEqual(unmeasured('generator-cpu.csv holds no samples'));
    expect(inputs.pgssBefore.state).toBe('unmeasured');
    expect((inputs.pgssBefore as { reason: string }).reason).toMatch(
      /^pgss-before\.json does not parse: /,
    );
    expect(inputs.pgssAfter.state).toBe('ok');
  });

  it('without run.json there is no run to report on', async () => {
    await expect(loadRunInputs(tmp)).rejects.toBeInstanceOf(NoRunRecordError);
  });
});

// ── k6 points ────────────────────────────────────────────────────────────────

describe('aggregatePoints', () => {
  it('skips what is not a judged point, and names a missing tag `unknown`', async () => {
    const at = (t: number) => iso(t).replace('Z', '123456Z');
    const pt = (metric: string, t: number, value: number | undefined, tags?: object) =>
      JSON.stringify({ type: 'Point', metric, data: { time: at(t), value, tags } });
    const inSteady = STEADY_START + 10_000;
    const inRamp = T0 + 10_000;
    const lines = [
      'garbage "Point" {',
      JSON.stringify({ type: 'Metric', metric: 'mcp_calls', data: { name: 'Point' } }),
      JSON.stringify({ type: 'Point', metric: 'mcp_calls', data: {} }),
      pt('stream_lost', inSteady, 2, { role: 'reader' }),
      pt('stream_lost', T0 - 60_000, 5, { role: 'reader' }),
      pt('http_503', inSteady, 1),
      pt('http_503', ENDED + 60_000, 4),
      pt('mcp_calls', inSteady, 1, { role: 'run', group: 'read', outcome: 'ok' }),
      pt('retry_after_seconds', inRamp, 9, { role: 'agent' }),
      pt('retry_after_seconds', inSteady, 7, { role: 'reader' }),
      pt('retry_after_seconds', inSteady, 3, { role: 'agent' }),
      pt('mcp_calls', inSteady, 1, { role: 'agent' }),
      pt('run_steps', inSteady, undefined, { role: 'run', step: 'read', outcome: 'ok' }),
      pt('mcp_call_duration', inSteady, 120, { role: 'agent', group: 'read' }),
      pt('reader_requests', inSteady, 1, { role: 'reader', route: 'boards', outcome: 'limited' }),
    ];
    const path = join(tmp, 'points.json.gz');
    writeFileSync(path, gzipSync(`${lines.join('\n')}\n`));
    const agg = await aggregatePoints(
      path,
      { start: STEADY_START, end: STEADY_END },
      { start: T0, end: ENDED },
    );
    expect(agg.streams.stream_lost).toBe(2);
    expect(agg.http503).toBe(1);
    expect(agg.retryAfter).toEqual([3]);
    expect(agg.outsideSteady).toBe(0);
    expect(agg.limitedWholeRun).toEqual({ mcp: 0, run: 0 });
    expect(agg.counts).toEqual(
      expect.arrayContaining([
        { source: 'mcp', label: 'unknown', detail: 'unknown', outcome: 'unknown', n: 1 },
        { source: 'run', label: 'read', detail: 'read', outcome: 'ok', n: 0 },
        { source: 'reader', label: 'boards', detail: 'boards', outcome: 'limited', n: 1 },
      ]),
    );
    expect(agg.counts).toHaveLength(3);
    expect([...agg.latency.entries()]).toEqual([['mcp:read:unknown', [120]]]);
  });
});

// ── Prometheus ───────────────────────────────────────────────────────────────

describe('the Prometheus client', () => {
  it('namesProduction reads a regex selector, and refuses one that does not compile', () => {
    expect(namesProduction('up{app=~"motir-.*"}')).toBe(true);
    expect(namesProduction('up{app=~"staging-.*"}')).toBe(false);
    expect(namesProduction('up{app=~"("}')).toBe(true);
  });

  it('defaults to the global fetch and the Fly endpoint', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (input: string | URL) => {
      seen.push(String(input));
      return Response.json({ status: 'success', data: { resultType: 'vector', result: [] } });
    });
    const prom = createPromClient({
      app: APP,
      env: { LOADTEST_FLY_PROM_TOKEN: TOKEN },
      exec: noFly,
    });
    expect(prom.endpoint).toBe(PROM_URL_DEFAULT);
    expect(await prom.instant('up', new Date(T0))).toEqual(ok([]));
    expect(seen[0]).toMatch(/^https:\/\/api\.fly\.io\/prometheus\/moooon\/api\/v1\/query\?/);
  });

  it('a failed, empty or unrunnable `fly auth token` is unmeasured, and is asked once', async () => {
    const empty = vi.fn(async () => ({ code: 0, stdout: '\n', stderr: '' }));
    const prom = createPromClient({
      app: APP,
      env: {},
      exec: empty,
      fetchImpl: promStub([]).fetchImpl,
    });
    const first = await prom.instant('up', new Date(T0));
    expect(first).toEqual(
      unmeasured(
        'no Prometheus token: LOADTEST_FLY_PROM_TOKEN is unset and `fly auth token` failed',
      ),
    );
    expect(await prom.instant('up', new Date(T0))).toEqual(first);
    expect(empty).toHaveBeenCalledTimes(1);

    const thrown = createPromClient({
      app: APP,
      env: {},
      exec: async () => {
        throw new Error('ENOENT fly');
      },
      fetchImpl: promStub([]).fetchImpl,
    });
    expect(await thrown.range('up', new Date(T0), new Date(ENDED))).toEqual(
      unmeasured('no Prometheus token: `fly auth token` could not run'),
    );
  });

  it('a non-200, a non-success body and a thrown fetch are unmeasured, with the token redacted', async () => {
    const reply = (body: unknown, status = 200) =>
      createPromClient({
        app: APP,
        env: { LOADTEST_FLY_PROM_TOKEN: TOKEN },
        exec: noFly,
        fetchImpl: (async () => {
          if (body instanceof Error) throw body;
          return new Response(JSON.stringify(body), { status });
        }) as typeof fetch,
      }).instant('up', new Date(T0));

    expect(await reply({}, 503)).toEqual(unmeasured('Prometheus answered 503'));
    expect(await reply({})).toEqual(unmeasured('Prometheus answered nothing: '));
    const bad = await reply({ status: 'error', error: `bad query from ${TOKEN}` });
    expect(bad.state).toBe('unmeasured');
    expect(JSON.stringify(bad)).not.toContain(TOKEN);
    expect((bad as { reason: string }).reason).toMatch(
      /^Prometheus answered error: bad query from /,
    );
    const down = await reply(new Error(`socket closed for ${TOKEN}`));
    expect((down as { reason: string }).reason).toMatch(/^Prometheus unreachable: socket closed/);
    expect(JSON.stringify(down)).not.toContain(TOKEN);
  });

  it('a result row with no metric and no value is an empty-labelled, empty series', async () => {
    const prom = promOf(() => [{}]);
    expect(await prom.instant('up', new Date(T0))).toEqual(ok([{ labels: {}, values: [] }]));
    expect(labelKey({}, ['instance', 'status'])).toBe('instance=,status=');
  });

  it('counterDelta: a failed end read, a reset, a series gone or new, and an empty series', async () => {
    const start = new Date(T0);
    const end = new Date(ENDED);
    const failsAtEnd = promOf((_q, t) => (t === start.getTime() / 1000 ? [] : 500));
    expect(await counterDelta(failsAtEnd, 'x', start, end, ['instance'])).toEqual(
      unmeasured('Prometheus answered 500'),
    );

    const prom = promOf((_q, t) =>
      t === start.getTime() / 1000
        ? [
            vec({ instance: 'reset' }, 9),
            vec({ instance: 'gone' }, 4),
            { metric: { instance: 'empty' } },
          ]
        : [
            vec({ instance: 'reset' }, 2),
            vec({ instance: 'new' }, 3),
            { metric: { instance: 'empty' } },
          ],
    );
    const d = await counterDelta(prom, 'x', start, end, ['instance']);
    expect(d).toEqual(
      ok(
        new Map([
          ['instance=reset', null],
          ['instance=gone', null],
          ['instance=empty', 0],
          ['instance=new', 3],
        ]),
      ),
    );
  });
});

// ── proxy_shed ───────────────────────────────────────────────────────────────

describe('proxy_shed', () => {
  it('a 503 counter that went backwards is null for its instance', async () => {
    const start = (T0 - 30_000) / 1000;
    const prom = promOf((_q, t) =>
      t === start
        ? [vec({ instance: 'm1', status: '200' }, 10), vec({ instance: 'm1', status: '503' }, 5)]
        : [vec({ instance: 'm1', status: '200' }, 90), vec({ instance: 'm1', status: '503' }, 2)],
    );
    expect(await readPlatform503(prom, { start: T0, end: ENDED })).toEqual(ok({ m1: null }));
  });

  it('the null survives a later non-503 series for the same instance', async () => {
    const start = (T0 - 30_000) / 1000;
    const prom = promOf((_q, t) =>
      t === start
        ? [vec({ instance: 'm1', status: '503' }, 5), vec({ instance: 'm1', status: '200' }, 10)]
        : [vec({ instance: 'm1', status: '503' }, 2), vec({ instance: 'm1', status: '200' }, 90)],
    );
    expect(await readPlatform503(prom, { start: T0, end: ENDED })).toEqual(ok({ m1: null }));
  });

  it('searches a raw line as it is, and a JSON line with no message as empty', async () => {
    const path = join(tmp, 'app-logs.ndjson');
    writeFileSync(
      path,
      [
        JSON.stringify({ message: 'proxy PL01 shed' }),
        'raw PR01 line',
        JSON.stringify({ other: 'PL02' }),
      ].join('\n'),
    );
    expect(await countProxyCodes(ok(path))).toEqual(ok({ PL01: 1, PL02: 0, PR01: 1 }));
  });
});

// ── P2028 ────────────────────────────────────────────────────────────────────

describe('P2028', () => {
  const whole = { start: T0, end: ENDED };
  const startS = (T0 - 30_000) / 1000;

  it('an unreadable positive control makes the platform count unmeasured', async () => {
    const prom = promOf((q) => (q.includes('committed') ? 500 : []));
    expect(await readPlatformP2028({ prom, machineIds: ['m1'], window: whole })).toEqual({
      unmeasured: 'Prometheus answered 500',
    });
  });

  it('names each instance whose counter went backwards or whose control did not rise', async () => {
    const prom = promOf((q, t) => {
      const atStart = t === startS;
      if (q.includes('committed'))
        return [
          vec({ instance: 'm1' }, atStart ? 10 : 20),
          vec({ instance: 'm2' }, atStart ? 20 : 10),
        ];
      return [
        vec({ instance: 'm1', outcome: 'p2028_wait' }, atStart ? 3 : 1),
        vec({ instance: 'm3', outcome: 'p2028_timeout' }, atStart ? 0 : 1),
        vec({ outcome: 'p2028_wait' }, atStart ? 0 : 7),
      ];
    });
    const r = await readPlatformP2028({ prom, machineIds: null, window: whole });
    expect(r).toEqual({
      instances: [
        {
          instance: 'm1',
          p2028_wait: null,
          p2028_timeout: 0,
          committedRise: 10,
          measured: false,
          reason: 'its p2028 counter went backwards (a restart)',
        },
        {
          instance: 'm2',
          p2028_wait: 0,
          p2028_timeout: 0,
          committedRise: null,
          measured: false,
          reason: 'its committed counter went backwards (a restart)',
        },
        {
          instance: 'm3',
          p2028_wait: 0,
          p2028_timeout: 1,
          committedRise: 0,
          measured: false,
          reason: 'the committed positive control did not rise (unscraped or restarted)',
        },
      ],
    });
  });

  it('counts log lines in the window by half, with no timestamp counted and no instance unknown', async () => {
    const path = join(tmp, 'app-logs.ndjson');
    writeFileSync(
      path,
      [
        'not json',
        JSON.stringify({ message: 'Transaction API error: expired' }),
        JSON.stringify({
          timestamp: iso(T0 - 3_600_000),
          instance: 'm1',
          message: 'Unable to start a transaction in the given time',
        }),
        JSON.stringify({ instance: 'm1' }),
        JSON.stringify({
          timestamp: iso(T0 + 1000),
          instance: 'm1',
          message: 'Unable to start a transaction in the given time',
        }),
      ].join('\n'),
    );
    expect(
      await readLogP2028({ appLogs: ok(path), gaps: unmeasured('gaps gone'), window: whole }),
    ).toEqual({
      state: 'incomplete',
      reason: 'the gap record is unreadable: gaps gone',
      total: 2,
      byInstance: {
        unknown: { p2028_wait: 0, p2028_timeout: 1 },
        m1: { p2028_wait: 1, p2028_timeout: 0 },
      },
    });
    expect(
      await readLogP2028({ appLogs: unmeasured('no logs'), gaps: ok([]), window: whole }),
    ).toEqual({ state: 'unmeasured', reason: 'no logs', total: 0, byInstance: {} });
  });

  it('judges: logs over the limit FAIL an unreadable platform; no instance or an unmeasured one is unmeasured', () => {
    const logs = { state: 'complete' as const, reason: null, total: 1, byInstance: {} };
    const quiet = { ...logs, total: 0 };
    const viaLogs = judgeP2028({ unmeasured: 'down' }, logs, 0);
    expect(viaLogs.status).toBe('FAIL');
    expect(viaLogs.total).toBeNull();

    const none = judgeP2028({ instances: [] }, quiet, 0);
    expect(none).toMatchObject({
      status: 'unmeasured',
      total: 0,
      reason: 'no staging instance reported db_tx_wait_seconds_count',
    });

    const backwards: InstanceP2028 = {
      instance: 'm1',
      p2028_wait: null,
      p2028_timeout: null,
      committedRise: 5,
      measured: false,
      reason: 'its p2028 counter went backwards (a restart)',
    };
    const r = judgeP2028({ instances: [backwards] }, quiet, 0);
    expect(r).toMatchObject({
      status: 'unmeasured',
      total: 0,
      reason: 'm1: its p2028 counter went backwards (a restart)',
    });
    expect(r.logs.disagrees).toBe(false);
  });
});

// ── the bottleneck candidates ────────────────────────────────────────────────

const CONFIG = {
  holdSeconds: 30,
  proxyHardLimitFraction: 1,
  cpuBusyFraction: 0.9,
  cpuThrottleMax: 0.05,
  memoryAvailableMin: 0.1,
  poolWaitingMean: 1,
  poolWaitP95Seconds: 0.25,
  dbActiveFraction: 0.9,
  dbLockWaiting: 5,
};

function bctx(prom: PromClient, over: Partial<BottleneckContext> = {}): BottleneckContext {
  return {
    prom,
    steady: { start: STEADY_START, end: STEADY_START + 600_000 },
    machines: runRecord(1).app.machines as MachineRecord[],
    hardLimit: 1200,
    config: CONFIG,
    dbSamples: unmeasured('not read'),
    endpointStart: unmeasured('not read'),
    endpointEnd: unmeasured('not read'),
    readerStreamsPerInstance: 6,
    proxyShedSummary: 'platform 503 0',
    ...over,
  };
}

describe('the bottleneck candidates, unmeasured and partial', () => {
  it('proxy: no hard limit, a failed read, or no series', async () => {
    expect(
      await proxyCandidate(
        bctx(
          promOf(() => []),
          { hardLimit: null },
        ),
      ),
    ).toMatchObject({
      state: 'unmeasured',
      reason: 'run.json has no concurrency hardLimit',
      beside: ['proxy_shed: platform 503 0'],
    });
    expect((await proxyCandidate(bctx(promOf(() => 502)))).reason).toBe('Prometheus answered 502');
    expect((await proxyCandidate(bctx(promOf(() => [])))).reason).toBe(
      'fly_app_concurrency is absent for this app',
    );
  });

  it('cpu: a failed read is unmeasured', async () => {
    expect(await cpuCandidate(bctx(promOf(() => 500)))).toMatchObject({
      state: 'unmeasured',
      reason: 'Prometheus answered 500',
      beside: [],
    });
  });

  it('cpu: an instance whose cpus run.json does not carry is unmeasured, and a failed throttle read is printed', async () => {
    const prom = promOf((q) =>
      q.includes('throttle')
        ? 500
        : [
            series(undefined, [
              [S, 0],
              [S + 15, 1500],
            ]),
            series({ instance: 'm1', mode: 'user' }, [
              [S, 0],
              [S + 15, 1500],
            ]),
          ],
    );
    const machines = [
      { ...(runRecord(1).app.machines as MachineRecord[])[0]!, cpus: 'unmeasured' },
    ];
    expect(await cpuCandidate(bctx(prom, { machines: machines as MachineRecord[] }))).toEqual({
      name: 'cpu',
      state: 'unmeasured',
      onset: null,
      peak: 'unmeasured',
      reason: 'the cpus of unknown, m1 are not in run.json',
      beside: ['steal peak 0 CPU-s/s', 'throttle unmeasured (Prometheus answered 500)'],
    });
    const noMachines = await cpuCandidate(bctx(prom, { machines: null }));
    expect(noMachines.reason).toBe('the cpus of unknown, m1 are not in run.json');
  });

  it('cpu: one sample per series is too few for a rate, and an absent throttle series is named', async () => {
    const prom = promOf((q) =>
      q.includes('throttle') ? [] : [series({ instance: 'm1', mode: 'user' }, [[S, 100]])],
    );
    expect(await cpuCandidate(bctx(prom))).toMatchObject({
      state: 'unmeasured',
      reason: 'too few fly_instance_cpu samples for a rate',
      beside: ['steal peak 0 CPU-s/s', 'throttle unmeasured (fly_instance_cpu_throttle is absent)'],
    });
  });

  it('cpu: a throttle series with no instance does not throttle m1', async () => {
    const prom = promOf((q) =>
      q.includes('throttle')
        ? [
            series(undefined, [
              [S, 0],
              [S + 15, 1500],
            ]),
          ]
        : [
            series({ instance: 'm1', mode: 'user' }, [
              [S, 0],
              [S + 15, 450],
              [S + 30, 900],
              [S + 45, 1350],
            ]),
          ],
    );
    expect(await cpuCandidate(bctx(prom))).toMatchObject({
      state: 'not reached',
      peak: "0.3 of the machine's CPUs busy",
      beside: ['steal peak 0 CPU-s/s', 'throttle peak 0 CPU-s/s (limit 0.05)'],
    });
  });

  it('memory: either read failing is unmeasured; a sample with no total is skipped', async () => {
    const failing = (which: string) =>
      promOf((q) => (q.includes(which) ? 503 : [series({ instance: 'm1' }, [[S, 1]])]));
    expect((await memoryCandidate(bctx(failing('mem_available')))).reason).toBe(
      'Prometheus answered 503',
    );
    expect((await memoryCandidate(bctx(failing('mem_total')))).reason).toBe(
      'Prometheus answered 503',
    );
    expect((await memoryCandidate(bctx(promOf(() => [])))).reason).toBe(
      'fly_instance_memory_mem_available / _mem_total are absent',
    );
    const prom = promOf((q) =>
      q.includes('mem_total')
        ? [series(undefined, [[S, 1000]])]
        : [
            series(undefined, [
              [S, 50],
              [S + 15, 50],
            ]),
          ],
    );
    expect(await memoryCandidate(bctx(prom))).toMatchObject({
      state: 'not reached',
      peak: 'available down to 5 % of total',
    });
  });

  it('pool: either read failing, or both series absent, is unmeasured; a NaN sample is skipped', async () => {
    const failing = (which: string) => promOf((q) => (q.includes(which) ? 500 : []));
    expect((await poolCandidate(bctx(failing('db_pool_waiting')))).reason).toBe(
      'Prometheus answered 500',
    );
    expect((await poolCandidate(bctx(failing('histogram_quantile')))).reason).toBe(
      'Prometheus answered 500',
    );
    expect((await poolCandidate(bctx(promOf(() => [])))).reason).toBe(
      'the wait/hold sink series are absent for this app',
    );
    const prom = promOf((q) =>
      q.includes('db_pool_waiting')
        ? [
            {
              metric: {},
              values: [
                [S, 'NaN'],
                [S + 15, '0.5'],
              ],
            },
          ]
        : [],
    );
    expect(await poolCandidate(bctx(prom))).toMatchObject({
      state: 'not reached',
      peak: 'mean waiting 0.5, wait p95 0 s',
    });
  });

  it('database: unreadable samples, or none inside the window, are unmeasured', () => {
    const prom = promOf(() => []);
    expect(databaseCandidate(bctx(prom, { dbSamples: unmeasured('no csv') }))).toMatchObject({
      state: 'unmeasured',
      reason: 'no csv',
    });
    const sample = (at: string, max: number) => ({
      at,
      backends: 1,
      active: 1,
      idle_in_transaction: 0,
      lock_waiting: 0,
      max_connections: max,
    });
    expect(
      databaseCandidate(
        bctx(prom, { dbSamples: ok([sample('not a date', 10), sample(iso(T0), 10)]) }),
      ).reason,
    ).toBe('no database sample inside the steady window');
    expect(
      databaseCandidate(bctx(prom, { dbSamples: ok([sample(iso(STEADY_START + 1000), 0)]) })),
    ).toMatchObject({
      state: 'not reached',
      peak: 'active 0 % of max_connections, 0 waiting on Lock',
    });
  });

  it('rankCandidates breaks a tie in the listed order', () => {
    const sat = (name: Candidate['name']): Candidate => ({
      name,
      state: 'saturated',
      onset: STEADY_START,
      peak: 'x',
      reason: null,
      beside: [],
    });
    const fallback = { worstRouteByP95: 'a', worstWaitRoute: 'b', topStatement: 'c' };
    expect(rankCandidates([sat('database'), sat('memory'), sat('proxy')], false, fallback)).toEqual(
      { kind: 'candidate', name: 'proxy', onset: iso(STEADY_START) },
    );
  });
});

describe('the statement delta and wait/hold', () => {
  const snap = (statsReset: string, rows: { query: string; calls: number; totalMs: number }[]) =>
    pgssSnapshot(statsReset, rows) as unknown as TopStatementsResult;
  const RESET = '2026-10-15T09:00:00.000Z';

  it('is unmeasured on an unreadable or non-ok snapshot, or a restarted compute', () => {
    const good = ok(snap(RESET, []));
    expect(statementDelta(unmeasured('gone'), good)).toEqual({
      state: 'unmeasured',
      reason: 'pgss-before: gone',
    });
    expect(statementDelta(good, unmeasured('gone'))).toEqual({
      state: 'unmeasured',
      reason: 'pgss-after: gone',
    });
    const refused = ok({ state: 'refused' } as unknown as TopStatementsResult);
    expect(statementDelta(refused, good)).toEqual({
      state: 'unmeasured',
      reason: 'pgss-before is refused',
    });
    expect(statementDelta(good, refused)).toEqual({
      state: 'unmeasured',
      reason: 'pgss-after is refused',
    });
    const restarted = snap(RESET, []);
    (restarted as { answeredBy: { computeStartedAt: string } }).answeredBy.computeStartedAt =
      '2026-10-15T11:00:00.000Z';
    expect(statementDelta(good, ok(restarted))).toEqual({
      state: 'unmeasured',
      reason: 'the compute restarted between the snapshots',
    });
  });

  it('ranks the statements in both snapshots by total-time delta', () => {
    const before = snap(RESET, [
      { query: 'SELECT a', calls: 1, totalMs: 10 },
      { query: 'SELECT b', calls: 1, totalMs: 10 },
    ]);
    const after = snap(RESET, [
      { query: 'SELECT a', calls: 3, totalMs: 20 },
      { query: 'SELECT b', calls: 5, totalMs: 510 },
    ]);
    const d = statementDelta(ok(before), ok(after));
    expect(d).toMatchObject({
      state: 'ok',
      top: [
        { query: 'SELECT b', callsDelta: 4, totalMsDelta: 500 },
        { query: 'SELECT a', callsDelta: 2, totalMsDelta: 10 },
      ],
    });
  });

  it('readWaitHold: a failed read is returned; an unlabelled or NaN row is unknown / null', async () => {
    expect(
      await readWaitHold(
        promOf(() => 500),
        { start: STEADY_START, end: STEADY_END },
      ),
    ).toEqual(unmeasured('Prometheus answered 500'));
    const r = await readWaitHold(
      promOf(() => [vec(undefined, Number.NaN)]),
      { start: STEADY_START, end: STEADY_END },
    );
    expect(r).toEqual(
      ok([
        {
          by: 'route',
          name: 'unknown',
          waitP95: null,
          waitP99: null,
          holdP95: null,
          holdP99: null,
        },
        { by: 'tool', name: 'unknown', waitP95: null, waitP99: null, holdP95: null, holdP99: null },
      ]),
    );
  });
});

// ── the report CLI ───────────────────────────────────────────────────────────

function deps(
  o: {
    handlers?: Handler[];
    down?: boolean;
    env?: Record<string, string>;
    cwd?: string;
    now?: number;
  } = {},
) {
  const stub = promStub(o.handlers ?? healthyProm(1), { down: o.down });
  const logs: string[] = [];
  const sleeps: number[] = [];
  const d: ReportDeps = {
    env: { LOADTEST_FLY_PROM_TOKEN: TOKEN, LOADTEST_PROM_URL: PROM_URL, ...o.env },
    exec: noFly,
    cwd: o.cwd ?? tmp,
    now: () => new Date(o.now ?? ENDED + 3_600_000),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (l) => logs.push(l),
    fetchImpl: stub.fetchImpl,
  };
  return { d, logs, sleeps };
}

const runDir = (o: FixtureOptions = {}) =>
  writeRunDir(join(tmp, `run-${Math.random().toString(36).slice(2)}`), o);
const readJson = (dir: string) => JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
const UNMEASURED_WINDOW = {
  startedAt: 'unmeasured',
  rampEndedAt: 'unmeasured',
  steadyEndedAt: 'unmeasured',
  endedAt: 'unmeasured',
} as unknown as RunRecord['window'];

describe('the report CLI', () => {
  it('prints its usage and exits 2 without a run directory', async () => {
    const { d, logs } = deps();
    expect(await runReportCli(['--publish'], d)).toBe(EXIT.missing);
    expect(logs).toEqual(['usage: pnpm loadtest:report <run dir> [--publish]']);
  });

  it('refuses a run against production, and writes nothing', async () => {
    const app = { ...runRecord(1).app, name: 'motir-core' };
    const dir = runDir({ run: { app } });
    await expect(runReportCli([dir], deps().d)).rejects.toThrow(/never reads production/);
    expect(readdirSync(dir)).not.toContain('report.json');
  });

  it('rethrows a publish failure that is not a refusal', async () => {
    const dir = runDir();
    const notADir = join(tmp, 'a-file');
    writeFileSync(notADir, 'x');
    await expect(runReportCli([dir, '--publish'], deps({ cwd: notADir }).d)).rejects.toThrow(
      /ENOTDIR|EEXIST/,
    );
  });

  it('a missing profile.resolved.json makes one unmeasured thresholds line naming why', async () => {
    const dir = runDir({ omit: ['profile.resolved.json'] });
    writeFileSync(join(dir, 'summary.json'), '{}');
    expect(await runReportCli([dir], deps().d)).toBe(EXIT.UNMEASURED);
    const json = readJson(dir);
    expect(json.lines).toEqual([
      {
        key: 'thresholds',
        name: 'thresholds',
        status: 'unmeasured',
        value: 'unmeasured',
        limit: 'profile.resolved.json',
        reason: 'profile.resolved.json is missing',
      },
    ]);
    expect(json.generator.reason).toBe('profile.resolved.json is unreadable');
    expect(json.p2028.limit).toBe(0);
    expect(json.bottleneck.candidates).toEqual([]);
    expect(json.crossChecks[0]).toMatch(/^mcp_rate_limited .* unmeasured vs mcp_calls/);
    expect(json.crossChecks[1]).toMatch(/^run_limited \(summary\.json\) unmeasured vs/);
  });

  it('a profile.resolved.json with no thresholds section is unmeasured without a reason', async () => {
    const dir = runDir();
    writeFileSync(join(dir, 'profile.resolved.json'), '{}');
    await runReportCli([dir], deps().d);
    expect(readJson(dir).lines[0]).toMatchObject({ key: 'thresholds', reason: null });
  });

  it('an unmeasured run window reads nothing time-bound, and publishes under today’s date', async () => {
    const dir = runDir({ n: 2, run: { window: UNMEASURED_WINDOW } });
    const { d, sleeps, logs } = deps({ handlers: healthyProm(2) });
    expect(await runReportCli([dir, '--publish'], d)).toBe(EXIT.UNMEASURED);
    expect(sleeps).toEqual([]);
    const json = readJson(dir);
    const why = 'the run window is unmeasured';
    expect(json.tables.routes).toEqual(unmeasured(why));
    expect(json.proxyShed.platform).toEqual(unmeasured(why));
    expect(json.p2028.reason).toBe(
      `the platform count is unreadable (${why}); log silence is not evidence of zero`,
    );
    expect(json.tables.waitHold).toEqual(unmeasured('the steady window is unmeasured'));
    expect(json.generator.reason).toBe('the steady window is unmeasured');
    expect(json.bottleneck.candidates).toEqual([]);
    expect(json.lines.find((l: { key: string }) => l.key === 'scaleOut.efficiency')).toMatchObject({
      status: 'unmeasured',
    });
    const today = new Date().toISOString().slice(0, 10);
    expect(logs.at(-1)).toMatch(new RegExp(`published: .*${today}-smoke-n2-r2bbbbbb$`));
  });

  it('a non-numeric settle time falls back to 60 s', async () => {
    const dir = runDir();
    const { d, sleeps, logs } = deps({ env: { LOADTEST_PROM_SETTLE_SECONDS: 'soon' }, now: ENDED });
    await runReportCli([dir], d);
    expect(sleeps).toEqual([60_000]);
    expect(logs[0]).toBe("report: waiting 60 s for Prometheus to ingest the run's last scrape");
  });

  it('a k6-points file that is not gzip is unmeasured with the read error', async () => {
    const dir = runDir();
    writeFileSync(join(dir, 'k6-points.json.gz'), 'not gzip at all');
    await runReportCli([dir], deps().d);
    const json = readJson(dir);
    expect(json.tables.routes.state).toBe('unmeasured');
    expect(json.tables.routes.reason).toMatch(/k6-points\.json\.gz could not be read: /);
  });

  it('an exit code without a reason, and an unconfirmed machine set, are both INVALID reasons', async () => {
    const dir = runDir({
      run: { exitCode: 4, reason: null, instancesHeld: 'unmeasured' as unknown as boolean },
    });
    expect(await runReportCli([dir], deps().d)).toBe(EXIT.INVALID);
    expect(readJson(dir).verdictReasons).toEqual([
      'the machine set was never confirmed held',
      'the run exited 4',
    ]);
  });

  it('with every proxy_shed part and the hard limit unmeasured, the proxy candidate says so', async () => {
    const dir = runDir({
      points: null,
      omit: ['app-logs.ndjson'],
      run: { concurrency: 'unmeasured' as unknown as RunRecord['concurrency'] },
    });
    await runReportCli([dir], deps({ down: true }).d);
    const proxy = readJson(dir).bottleneck.candidates[0];
    expect(proxy).toMatchObject({
      name: 'proxy',
      state: 'unmeasured',
      reason: 'run.json has no concurrency hardLimit',
      beside: [
        'proxy_shed: platform 503 unmeasured, log codes unmeasured, client http_503 unmeasured',
      ],
    });
  });

  it('a reset 503 counter sums as 0 beside the proxy candidate', async () => {
    const dir = runDir();
    const reset: Handler = [
      /fly_app_http_responses_count/,
      (t) => [{ labels: { instance: 'm1', status: '503' }, value: t < S ? 5 : 1 }],
    ];
    await runReportCli([dir], deps({ handlers: withHandlers(healthyProm(1), reset) }).d);
    const json = readJson(dir);
    expect(json.proxyShed.platform).toEqual(ok({ m1: null }));
    expect(json.bottleneck.candidates[0].beside[0]).toMatch(/^proxy_shed: platform 503 0, /);
  });

  it('generator CPU: under two samples in the window is unmeasured; a flat counter reads 0', async () => {
    const before = runDir();
    writeFileSync(
      join(before, 'generator-cpu.csv'),
      `epochSeconds,nproc,procStatCpu\n${(T0 - 20_000) / 1000},4,cpu 1 0 0 1\n${(T0 - 10_000) / 1000},4,cpu 2 0 0 2\n`,
    );
    await runReportCli([before], deps().d);
    expect(readJson(before).generator).toEqual({
      status: 'unmeasured',
      mean: null,
      peak: null,
      reason: 'fewer than two CPU samples in the steady window',
    });

    const flat = runDir();
    const rows = Array.from(
      { length: 20 },
      (_, i) => `${(STEADY_START + i * 5000) / 1000},4,cpu 100 0 0 100`,
    );
    writeFileSync(
      join(flat, 'generator-cpu.csv'),
      `epochSeconds,nproc,procStatCpu\n${rows.join('\n')}\n`,
    );
    await runReportCli([flat], deps().d);
    expect(readJson(flat).generator).toMatchObject({ status: 'ok', mean: 0, peak: 0 });
  });

  it('an unattributed FAIL names routes with no latency sample and a wait row with no p95', async () => {
    const points: K6Point[] = [];
    for (let s = 0; s < 300; s += 1)
      points.push(
        ...request('mcp', 'write', 'error', 0, STEADY_START + s * 1000 + 500, 'update_work_item'),
      );
    const dir = runDir({ points });
    const waits: Handler = [
      /sum by \(le, route\)/,
      () => [
        { labels: { route: 'a' }, value: Number.NaN },
        { labels: { route: 'b' }, value: 0.2 },
      ],
    ];
    expect(
      await runReportCli([dir], deps({ handlers: withHandlers(healthyProm(1), waits) }).d),
    ).toBe(EXIT.FAIL);
    expect(readJson(dir).bottleneck.first).toMatchObject({
      kind: 'unattributed',
      worstRouteByP95: 'mcp update_work_item (p95 0 ms)',
      worstWaitRoute: 'b (wait p95 0.2 s)',
    });
  });
});

// ── report.md ────────────────────────────────────────────────────────────────

describe('report.md', () => {
  it('prints a candidate bottleneck, absent numbers as unmeasured, and an empty 503 reading as none', async () => {
    const dir = runDir();
    const r = await buildReport(dir, deps().d);
    r.lines = r.lines.filter((l) => l.key !== 'perInstance.rateLimitedMax');
    r.generator = { status: 'ok', mean: null, peak: Number.NaN, reason: null };
    r.proxyShed.platform = ok({});
    r.bottleneck.first = { kind: 'candidate', name: 'cpu', onset: iso(STEADY_START + 120_000) };
    r.bottleneck.candidates = r.bottleneck.candidates.map((c) =>
      c.name === 'cpu' ? { ...c, state: 'saturated', onset: STEADY_START + 120_000 } : c,
    );
    r.tables.routes = ok([{ route: 'mcp x', rps: 1, p95: null, p99: null }]);
    const md = renderMarkdown(r);
    expect(md).toContain(
      'Generator CPU over the steady window: mean unmeasured, peak unmeasured — ok.',
    );
    expect(md).toContain('## Rate-limit refusals\n\nunmeasured: unmeasured (limit ?)');
    expect(md).toContain('- platform 503s by instance: none');
    expect(md).toContain(`**app CPU**, saturated from ${iso(STEADY_START + 120_000)}`);
    expect(md).toContain(`- app CPU: from ${iso(STEADY_START + 120_000)}; peak`);
    expect(md).toContain('| mcp x | 1 | unmeasured | unmeasured |');
  });
});
