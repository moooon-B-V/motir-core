import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { OUTCOMES } from '@/loadtest/k6/lib/outcome.js';
import { parseLoadProfile } from '@/loadtest/profiles/schema';
import { statementDelta } from '@/loadtest/report/bottleneck';
import { ok } from '@/loadtest/report/inputs';
import { createPromClient, ProductionQueryRefusedError } from '@/loadtest/report/prometheus';
import {
  comparableOf,
  EXIT,
  OPTIONS,
  runId8,
  runReportCli,
  type ReportDeps,
} from '@/loadtest/report/report';
import { readBaseline, readRoutingShares, scaleOutLine } from '@/loadtest/report/scaleOut';
import { OUTCOME_BUCKETS, THRESHOLD_INPUTS } from '@/loadtest/report/thresholds';
import { P2028_BLIND_SPOT } from '@/loadtest/report/p2028';
import {
  APP,
  ENDED,
  ROOT,
  STEADY_END,
  STEADY_START,
  T0,
  TOKEN,
  healthyPoints,
  healthyProm,
  healthySecond,
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

// The report generator (Story MOTIR-8538 · MOTIR-8679) over fixture run directories
// and a stub Prometheus (./reportFixture.ts). Every limit it judges against comes
// from the smoke profile's profile.resolved.json.

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'loadtest-report-'));
});

const PROM_URL = 'http://prom.stub/prometheus/moooon';

async function report(
  o: FixtureOptions & {
    handlers?: Handler[];
    down?: boolean;
    env?: Record<string, string>;
    now?: number;
    args?: string[];
    dir?: string;
  } = {},
) {
  const dir = o.dir ?? writeRunDir(join(tmp, `run-${Math.random().toString(36).slice(2)}`), o);
  const stub = promStub(o.handlers ?? healthyProm(o.n ?? 1), { down: o.down });
  const logs: string[] = [];
  const sleeps: number[] = [];
  const deps: ReportDeps = {
    env: { LOADTEST_FLY_PROM_TOKEN: TOKEN, LOADTEST_PROM_URL: PROM_URL, ...o.env },
    exec: async () => ({ code: 1, stdout: '', stderr: 'no flyctl here' }),
    cwd: tmp,
    now: () => new Date(o.now ?? ENDED + 3_600_000),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (l) => logs.push(l),
    fetchImpl: stub.fetchImpl,
  };
  const code = await runReportCli([dir, ...(o.args ?? [])], deps);
  const md = existsSync(join(dir, 'report.md')) ? readFileSync(join(dir, 'report.md'), 'utf8') : '';
  const json = md ? JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8')) : null;
  const line = (key: string) => json?.lines.find((l: { key: string }) => l.key === key);
  return { code, md, json, line, logs, sleeps, calls: stub.calls, dir };
}

describe('a run that meets every limit', () => {
  it('is PASS, with one line per threshold, the header, the comparable block and a bottleneck block', async () => {
    const r = await report();
    expect(r.json.verdict).toBe('PASS');
    expect(r.code).toBe(EXIT.PASS);
    const keys = r.json.lines.map((l: { key: string }) => l.key);
    expect(keys).toEqual([
      'perInstance.targetRps',
      'perInstance.readP95Ms',
      'perInstance.readP99Ms',
      'perInstance.mutateP95Ms',
      'perInstance.mutateP99Ms',
      'perInstance.errorRate',
      'perInstance.p2028',
      'perInstance.streamLost',
      'perInstance.rateLimitedMax',
      'scaleOut.efficiency',
    ]);
    for (const l of r.json.lines) {
      expect(l.value).not.toBe('');
      expect(l.limit).not.toBe('');
      expect(r.md).toContain(`| ${l.name} | ${l.status} |`);
    }
    for (const h of [
      'sha',
      'neon',
      'app',
      'instancesHeld',
      'pinEnforced',
      'profile',
      'traceRate',
      'concurrency',
      'rateLimits',
      'offered',
      'generator',
      'k6',
      'window',
      'prometheus',
      'pgStatStatements',
    ])
      expect(r.md).toContain(`**${h}**`);
    expect(r.md).toContain('### Comparable');
    expect(r.md).toContain("are not production's (250)");
    expect(r.md).toContain('skew is not measured');
    expect(r.json.header.prometheus).toMatchObject({ endpoint: PROM_URL, app: APP });
    expect(r.json.header.generator.cpuMean).toBeCloseTo(0.3, 2);
    expect(r.md).toContain('## First bottleneck');
    expect(r.json.bottleneck.first).toEqual({ kind: 'none' });
    expect(r.logs[0]).toBe('verdict: PASS');
  });

  it('judges the steady window only: the slow, failing ramp and ramp-down change nothing', async () => {
    const r = await report();
    expect(r.line('perInstance.readP95Ms').value).toBe('200 ms');
    expect(r.line('perInstance.mutateP99Ms').value).toBe('302 ms');
    expect(r.line('perInstance.errorRate').value).toBe('0 % (0 of 5100)');
    expect(r.line('perInstance.targetRps').value).toBe('16 rps served');
    expect(r.json.crossChecks.join('\n')).toMatch(
      /\d+ judged samples fell outside the steady window/,
    );
  });

  it('never reads k6’s built-in http_req_duration (60 s samples in the fixture)', async () => {
    const r = await report();
    expect(r.line('perInstance.readP99Ms').status).toBe('PASS');
    expect(r.md).not.toContain('60000');
  });
});

describe('unmeasured', () => {
  it('a missing k6-points.json.gz turns every line it backs unmeasured; the verdict is UNMEASURED, exit 3', async () => {
    const r = await report({ points: null });
    expect(r.json.verdict).toBe('UNMEASURED');
    expect(r.code).toBe(3);
    for (const k of [
      'perInstance.targetRps',
      'perInstance.readP95Ms',
      'perInstance.errorRate',
      'perInstance.streamLost',
      'perInstance.rateLimitedMax',
    ])
      expect(r.line(k)).toMatchObject({
        status: 'unmeasured',
        reason: 'k6-points.json.gz is missing',
      });
  });

  it('an unreachable Prometheus turns P2028 unmeasured and the run cannot PASS', async () => {
    const r = await report({ down: true });
    expect(r.line('perInstance.p2028').status).toBe('unmeasured');
    expect(r.json.verdict).toBe('UNMEASURED');
    expect(r.code).toBe(3);
  });

  it('THRESHOLD_INPUTS names the inputs for every threshold key the profile carries', () => {
    const profile = parseLoadProfile(
      JSON.parse(readFileSync(join(ROOT, 'loadtest/profiles/default.json'), 'utf8')),
    );
    const keys = Object.entries(profile.thresholds).flatMap(([section, v]) =>
      Object.keys(v as object).map((k) => `${section}.${k}`),
    );
    expect(Object.keys(THRESHOLD_INPUTS).sort()).toEqual(keys.sort());
    for (const k of keys) expect(THRESHOLD_INPUTS[k]!.length).toBeGreaterThan(0);
  });

  it('OUTCOME_BUCKETS assigns every outcome exactly one bucket', () => {
    expect(Object.keys(OUTCOME_BUCKETS).sort()).toEqual([...OUTCOMES].sort());
    expect(new Set(Object.values(OUTCOME_BUCKETS)).size).toBe(OUTCOMES.length);
  });
});

describe('P2028', () => {
  const p2028 = (
    f: (t: number) => { instance: string; outcome: string; value: number }[],
  ): Handler => [
    /outcome=~"p2028_\.\*"/,
    (t) => f(t).map(({ instance, outcome, value }) => ({ labels: { instance, outcome }, value })),
  ];
  const mid = (T0 + 200_000) / 1000;

  it('Prometheus unreachable is unmeasured even when the logs are empty and complete', async () => {
    const r = await report({ down: true, logs: [], gaps: [] });
    expect(r.json.p2028.logs.state).toBe('complete');
    expect(r.line('perInstance.p2028')).toMatchObject({ status: 'unmeasured' });
    expect(r.line('perInstance.p2028').reason).toMatch(/log silence is not evidence of zero/);
  });

  it('a series that first appears at 1 inside the window counts 1 and FAILs', async () => {
    const r = await report({
      handlers: withHandlers(
        healthyProm(1),
        p2028((t) => (t > mid ? [{ instance: 'm1', outcome: 'p2028_wait', value: 1 }] : [])),
      ),
    });
    expect(r.line('perInstance.p2028')).toMatchObject({ status: 'FAIL', value: '1' });
    expect(r.json.verdict).toBe('FAIL');
    expect(r.code).toBe(1);
  });

  it('a platform count of 2 prints `P2028: 2 — FAIL` split by half and instance', async () => {
    const r = await report({
      n: 2,
      run: { baseline: null },
      handlers: withHandlers(
        healthyProm(2),
        p2028((t) =>
          t > mid
            ? [
                { instance: 'm1', outcome: 'p2028_wait', value: 1 },
                { instance: 'm2', outcome: 'p2028_timeout', value: 1 },
              ]
            : [],
        ),
      ),
    });
    expect(r.md).toContain('P2028: 2 — FAIL');
    expect(r.md).toContain('- m1: p2028_wait 1, p2028_timeout 0');
    expect(r.md).toContain('- m2: p2028_wait 0, p2028_timeout 1');
  });

  it('counts a P2028 during the ramp: the whole run is the window', async () => {
    const r = await report({
      handlers: withHandlers(
        healthyProm(1),
        p2028((t) =>
          t > (T0 + 20_000) / 1000 ? [{ instance: 'm1', outcome: 'p2028_wait', value: 1 }] : [],
        ),
      ),
    });
    expect(r.line('perInstance.p2028')).toMatchObject({ status: 'FAIL', value: '1' });
  });

  it('an instance whose committed positive control did not rise is unmeasured, never 0', async () => {
    const r = await report({
      n: 2,
      handlers: withHandlers(healthyProm(2), [
        /outcome="committed"/,
        (t) => [
          { labels: { instance: 'm1' }, value: (t - T0 / 1000) * 10 },
          { labels: { instance: 'm2' }, value: 7 },
        ],
      ]),
    });
    expect(r.line('perInstance.p2028').status).toBe('unmeasured');
    expect(r.line('perInstance.p2028').reason).toMatch(
      /m2: the committed positive control did not rise/,
    );
  });

  it('two P2028 log lines against a platform 0 print a disagreement, and the line FAILs', async () => {
    const r = await report({
      logs: [
        {
          timestamp: iso(STEADY_START + 5000),
          instance: 'm1',
          message: 'Transaction API error: Unable to start a transaction in the given time.',
        },
        {
          timestamp: iso(STEADY_START + 6000),
          instance: 'm1',
          message: 'Transaction API error: Transaction already closed',
        },
      ],
    });
    expect(r.json.p2028.total).toBe(0);
    expect(r.json.p2028.logs).toMatchObject({
      total: 2,
      disagrees: true,
      byInstance: { m1: { p2028_wait: 1, p2028_timeout: 1 } },
    });
    expect(r.md).toContain('DISAGREES with the platform count');
    expect(r.line('perInstance.p2028').status).toBe('FAIL');
  });

  it('a log gap marks only the cross-check incomplete', async () => {
    const r = await report({
      gaps: [{ from: iso(STEADY_START), to: iso(STEADY_START + 4000), exitCode: 1 }],
    });
    expect(r.json.p2028.logs.state).toBe('incomplete');
    expect(r.line('perInstance.p2028').status).toBe('PASS');
  });

  it('prints the blind spot in the line', async () => {
    const r = await report();
    expect(r.line('perInstance.p2028').annotation).toBe(P2028_BLIND_SPOT);
    expect(r.md).toContain('a mid-body expiry is labelled rolled_back');
  });
});

describe('rate-limit refusals', () => {
  function withRefusals(): K6Point[] {
    const out = healthyPoints();
    for (let s = 0; s < 300; s += 1) {
      const t = STEADY_START + s * 1000 + 700;
      out.push(...request('mcp', 'write', 'limited', 0, t, 'update_work_item'));
      out.push({
        metric: 'retry_after_seconds',
        t,
        value: s % 10 === 0 ? 30 : 2,
        tags: { role: 'agent', group: 'write', tool: 'update_work_item' },
      });
    }
    return out;
  }

  it('the refusal line counts limited over all requests of the contributing scenario only', async () => {
    const r = await report({ points: withRefusals() });
    // MCP per second: 6 reads + 3 writes + 1 empty claim + 1 limited = 11 → 3300; refused 300.
    expect(r.line('perInstance.rateLimitedMax')).toMatchObject({
      status: 'FAIL',
      value: '9.09 % (300 refused of 3300; retry_after p95 30 s)',
    });
  });

  it('error rate, latency and served throughput all exclude them; an empty claim is not an error', async () => {
    const r = await report({ points: withRefusals() });
    expect(r.line('perInstance.errorRate').value).toBe('0 % (0 of 5100)');
    expect(r.line('perInstance.targetRps').value).toBe('16 rps served');
    expect(r.line('perInstance.mutateP95Ms').value).toBe('302 ms');
  });
});

describe('proxy_shed', () => {
  it('prints the platform, log-code and client counts side by side, judged by nothing', async () => {
    const points = healthyPoints();
    points.push({
      metric: 'http_503',
      t: STEADY_START + 10_000,
      value: 1,
      tags: { role: 'reader', route: 'boards' },
    });
    points.push({
      metric: 'http_503',
      t: STEADY_START + 11_000,
      value: 1,
      tags: { role: 'reader', route: 'boards' },
    });
    const r = await report({
      n: 1,
      points,
      logs: [
        {
          timestamp: iso(STEADY_START),
          instance: 'm1',
          message: '[PL02] request concurrency limit reached',
        },
        { timestamp: iso(STEADY_START), instance: 'm1', message: 'something else' },
      ],
      handlers: withHandlers(healthyProm(1), [
        /fly_app_http_responses_count/,
        (t) => [
          { labels: { instance: 'm1', status: '200' }, value: (t - T0 / 1000) * 16 },
          { labels: { instance: 'm1', status: '503' }, value: t > (T0 + 100_000) / 1000 ? 5 : 0 },
        ],
      ]),
    });
    expect(r.md).toContain('platform 503s by instance: m1 5');
    expect(r.md).toContain('proxy log codes: PL01 0, PL02 1, PR01 0');
    expect(r.md).toContain('client http_503: 2');
    expect(r.json.verdict).toBe('PASS');
  });

  it('with no fly_app_http_responses_count series the platform part is unmeasured, the others still print', async () => {
    const r = await report({
      handlers: withHandlers(healthyProm(1), [/fly_app_http_responses_count/, () => []]),
    });
    expect(r.md).toContain(
      'platform 503s by instance: unmeasured — no fly_app_http_responses_count series',
    );
    expect(r.md).toContain('proxy log codes: PL01 0, PL02 0, PR01 0');
    expect(r.md).toContain('client http_503: 0');
  });
});

describe('the verdict', () => {
  const slowReads = () => {
    const out: K6Point[] = [];
    for (let s = 0; s < 300; s += 1) {
      const t = STEADY_START + s * 1000 + 500;
      out.push(
        ...healthySecond(t).map((p) =>
          p.metric === 'mcp_call_duration' && p.tags['group'] === 'read'
            ? { ...p, value: 4000 }
            : p,
        ),
      );
    }
    return out;
  };

  it('a saturated generator is INVALID, exit 6, and a FAIL line says it was measured so', async () => {
    const r = await report({ cpuUtil: () => 0.85, points: slowReads() });
    expect(r.json.verdict).toBe('INVALID');
    expect(r.code).toBe(6);
    expect(r.line('perInstance.readP95Ms').annotation).toMatch(
      /measured with a saturated generator/,
    );
  });

  it('one 30 s peak over cpuPeakMax is enough', async () => {
    const r = await report({
      cpuUtil: (t) => (t > STEADY_START + 100_000 && t <= STEADY_START + 140_000 ? 0.95 : 0.3),
    });
    expect(r.json.generator.status).toBe('saturated');
    expect(r.json.verdict).toBe('INVALID');
  });

  it('instancesHeld false, or a run.json exit 4 with a reason, is INVALID and prints why', async () => {
    const a = await report({ run: { instancesHeld: false } });
    expect(a.json.verdict).toBe('INVALID');
    expect(a.code).toBe(6);
    const b = await report({
      run: { exitCode: 4, reason: 'the app machine set changed during the run: m3' },
    });
    expect(b.json.verdict).toBe('INVALID');
    expect(b.md).toContain('the run exited 4: the app machine set changed during the run: m3');
  });

  it('a FAIL line beside an unmeasured line is FAIL', async () => {
    const r = await report({ points: slowReads(), down: true });
    expect(r.line('perInstance.p2028').status).toBe('unmeasured');
    expect(r.json.verdict).toBe('FAIL');
    expect(r.code).toBe(1);
  });
});

describe('n/a lines at each N', () => {
  it('at N = 1 the scale-out line is n/a; at N = 2 the throughput line is n/a; neither makes it UNMEASURED', async () => {
    const one = await report();
    expect(one.line('scaleOut.efficiency').status).toBe('n/a');
    expect(one.json.verdict).toBe('PASS');

    const two = await report({ n: 2, run: { baseline: one.dir, profile: runRecord(1).profile } });
    expect(two.line('perInstance.targetRps').status).toBe('n/a');
    expect(two.line('perInstance.targetRps').value).toMatch(/8 rps per instance/);
    expect(two.line('scaleOut.efficiency').status).toBe('FAIL');
    expect(two.json.verdict).toBe('FAIL');
  });
});

describe('scale-out', () => {
  const baseline = ok({ dir: 'b', servedRps: 300, verdict: 'PASS' });
  const balanced = ok({
    source: 'fly_app_http_responses_count' as const,
    shares: { m1: 0.5, m2: 0.5 },
    balanced: true,
  });

  it('480 rps PASSes and 479 FAILs against a 300 rps baseline at efficiency 0.8', () => {
    expect(
      scaleOutLine({ n: 2, servedRps: 480, efficiency: 0.8, baseline, routing: balanced }).status,
    ).toBe('PASS');
    expect(
      scaleOutLine({ n: 2, servedRps: 479, efficiency: 0.8, baseline, routing: balanced }).status,
    ).toBe('FAIL');
  });

  it('a baseline with another load hash, machine size or an INVALID verdict is unmeasured; a FAIL baseline is usable', async () => {
    const one = await report();
    const current = { loadHash: 'h'.repeat(64), size: 'shared-1x-1024MB' };
    expect((await readBaseline(one.dir, current)).state).toBe('ok');
    expect(await readBaseline(one.dir, { ...current, loadHash: 'x' })).toMatchObject({
      state: 'unmeasured',
      reason: expect.stringMatching(/load hash differs/),
    });
    expect(
      await readBaseline(one.dir, { ...current, size: 'performance-2x-4096MB' }),
    ).toMatchObject({ state: 'unmeasured' });
    const invalid = await report({ run: { instancesHeld: false } });
    expect(await readBaseline(invalid.dir, current)).toMatchObject({
      reason: 'the baseline report is INVALID',
    });
    const failed = await report({
      down: false,
      cpuUtil: () => 0.3,
      points: healthyPoints()
        .filter((p) => p.metric !== 'stream_open_at_end')
        .concat([
          {
            metric: 'stream_lost',
            t: STEADY_START + 2000,
            value: 1,
            tags: { role: 'reader', route: 'workbench_stream' },
          },
        ]),
    });
    expect(failed.json.verdict).toBe('FAIL');
    expect((await readBaseline(failed.dir, current)).state).toBe('ok');
  });

  it('a 90 / 10 request split is unmeasured: routing, not scaling', async () => {
    const stub = promStub(
      withHandlers(healthyProm(2), [
        /fly_app_http_responses_count/,
        (t) => [
          { labels: { instance: 'm1' }, value: (t - T0 / 1000) * 90 },
          { labels: { instance: 'm2' }, value: (t - T0 / 1000) * 10 },
        ],
      ]),
    );
    const prom = createPromClient({
      app: APP,
      env: { LOADTEST_FLY_PROM_TOKEN: TOKEN },
      exec: async () => ({ code: 1, stdout: '', stderr: '' }),
      fetchImpl: stub.fetchImpl,
    });
    const routing = await readRoutingShares(prom, { start: STEADY_START, end: STEADY_END }, 2);
    const line = scaleOutLine({ n: 2, servedRps: 1000, efficiency: 0.8, baseline, routing });
    expect(line.status).toBe('unmeasured');
    expect(line.reason).toMatch(/^routing, not scaling/);
    expect(line.value).toBe('shares m1 90 %, m2 10 %');
  });
});

describe('the comparable block', () => {
  it('is equal for two runs that differ only in measured values and times, and differs on N or load hash', () => {
    const a = runRecord(1);
    const b = runRecord(1, {
      window: {
        startedAt: iso(T0 + 9e6),
        rampEndedAt: iso(T0 + 9e6),
        steadyEndedAt: iso(T0 + 9e6),
        endedAt: iso(T0 + 9e6),
      },
      generator: { ...a.generator, startedAt: iso(1), stoppedAt: iso(2) },
      capture: { logLines: 999, logGaps: 3, logInstances: [], dbSamples: 1 },
      runId: 'another-run',
    });
    expect(comparableOf(b)).toEqual(comparableOf(a));
    expect(comparableOf(runRecord(2))).not.toEqual(comparableOf(a));
    expect(
      comparableOf(runRecord(1, { profile: { ...a.profile, sha256: 'z'.repeat(64) } })),
    ).not.toEqual(comparableOf(a));
  });
});

describe('the pg_stat_statements delta', () => {
  it('different stats_reset makes it unmeasured; a statement only in pgss-after is entered, not diffed', () => {
    const before = pgssSnapshot('2026-10-15T09:00:00.000Z', [
      { query: 'SELECT 1', calls: 1, totalMs: 1 },
    ]);
    const after = pgssSnapshot('2026-10-15T09:30:00.000Z', [
      { query: 'SELECT 1', calls: 2, totalMs: 5 },
    ]);
    expect(statementDelta(ok(before) as never, ok(after) as never)).toMatchObject({
      state: 'unmeasured',
      reason: expect.stringMatching(/stats_reset differs/),
    });
  });

  it('diffs statements present in both, by normalised text', async () => {
    const r = await report();
    const s = r.json.tables.statements;
    expect(s.top).toEqual([{ query: 'SELECT 1', callsDelta: 100, totalMsDelta: 9000 }]);
    expect(s.entered).toEqual(['UPDATE x']);
    expect(s.left).toEqual(['SELECT 2']);
  });
});

describe('the Prometheus client', () => {
  const exec = async () => ({ code: 0, stdout: 'flyctl-token-from-auth-1234567890\n', stderr: '' });

  it('refuses app="motir-core" before any request', async () => {
    const stub = promStub([]);
    const prom = createPromClient({
      app: APP,
      env: { LOADTEST_FLY_PROM_TOKEN: TOKEN },
      exec,
      fetchImpl: stub.fetchImpl,
    });
    await expect(prom.instant('up{app="motir-core"}', new Date())).rejects.toBeInstanceOf(
      ProductionQueryRefusedError,
    );
    await expect(prom.range('up{app=~"motir-.*"}', new Date(), new Date())).rejects.toBeInstanceOf(
      ProductionQueryRefusedError,
    );
    expect(stub.calls).toHaveLength(0);
  });

  it('honours LOADTEST_PROM_URL, sends Bearer by default and FlyV1 when told, and reads fly auth token otherwise', async () => {
    const stub = promStub(healthyProm(1));
    await createPromClient({
      app: APP,
      env: { LOADTEST_FLY_PROM_TOKEN: TOKEN, LOADTEST_PROM_URL: PROM_URL },
      exec,
      fetchImpl: stub.fetchImpl,
    }).instant('up{app="x"}', new Date());
    await createPromClient({
      app: APP,
      env: { LOADTEST_FLY_PROM_TOKEN: TOKEN, LOADTEST_FLY_PROM_TOKEN_SCHEME: 'FlyV1' },
      exec,
      fetchImpl: stub.fetchImpl,
    }).instant('up{app="x"}', new Date());
    await createPromClient({ app: APP, env: {}, exec, fetchImpl: stub.fetchImpl }).instant(
      'up{app="x"}',
      new Date(),
    );
    expect(stub.calls[0]!.url.href.startsWith(`${PROM_URL}/api/v1/query?`)).toBe(true);
    expect(stub.calls[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(stub.calls[1]!.url.origin).toBe('https://api.fly.io');
    expect(stub.calls[1]!.authorization).toBe(`FlyV1 ${TOKEN}`);
    expect(stub.calls[2]!.authorization).toBe('Bearer flyctl-token-from-auth-1234567890');
  });

  it('no token appears in any output', async () => {
    const r = await report();
    expect(r.calls.length).toBeGreaterThan(0);
    for (const text of [r.md, JSON.stringify(r.json), r.logs.join('\n')])
      expect(text).not.toContain(TOKEN);
  });
});

describe('the run command’s last step', () => {
  it('waits until window.endedAt + 60 s by default, and the override shortens it; an old run does not wait', async () => {
    expect((await report({ now: ENDED + 10_000 })).sleeps).toEqual([50_000]);
    expect(
      (await report({ now: ENDED + 10_000, env: { LOADTEST_PROM_SETTLE_SECONDS: '20' } })).sleeps,
    ).toEqual([10_000]);
    expect(
      (await report({ now: ENDED + 10_000, env: { LOADTEST_PROM_SETTLE_SECONDS: '5' } })).sleeps,
    ).toEqual([]);
  });

  it('exits 2 when the run directory has no run.json', async () => {
    const r = await report({ omit: ['run.json'] });
    expect(r.code).toBe(EXIT.missing);
  });

  it('exports its flags, env vars and exit table for the runbook guard', () => {
    expect(Object.keys(OPTIONS.env).sort()).toEqual([
      'LOADTEST_FLY_PROM_TOKEN',
      'LOADTEST_FLY_PROM_TOKEN_SCHEME',
      'LOADTEST_PROM_SETTLE_SECONDS',
      'LOADTEST_PROM_URL',
    ]);
    expect(Object.keys(OPTIONS.exits).map(Number).sort()).toEqual([0, 1, 2, 3, 6]);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['loadtest:report']).toMatch(/loadtest\/report\/report\.ts$/);
  });
});

describe('--publish', () => {
  it('copies exactly report.md and report.json, and two runs on one day land apart', async () => {
    const a = await report({ args: ['--publish'] });
    await report({ args: ['--publish'], run: { runId: 'r9zzzzzzzz-run' } });
    const dirs = readdirSync(join(tmp, 'loadtest/reports')).sort();
    expect(dirs).toEqual(['2026-10-15-smoke-n1-r1aaaaaa', '2026-10-15-smoke-n1-r9zzzzzz']);
    expect(readdirSync(join(tmp, 'loadtest/reports', dirs[0]!)).sort()).toEqual([
      'report.json',
      'report.md',
    ]);
    expect(a.logs.some((l) => l.startsWith('published: '))).toBe(true);
  });

  it('two real run ids from one day publish to two folders', () => {
    expect(runId8('20261015T091500Z-smoke-n1')).toBe('T091500Z');
    expect(runId8('20261015T143000Z-smoke-n1')).toBe('T143000Z');
    expect(runId8('r1aaaaaaaa-run')).toBe('r1aaaaaa');
  });

  it('refuses a report holding a connection string, and copies nothing', async () => {
    rmSync(join(tmp, 'loadtest'), { recursive: true, force: true });
    const r = await report({
      args: ['--publish'],
      run: {
        exitCode: 4,
        reason: 'seed failed for postgres://motir_app:npg_x@ep-1.neon.tech/neondb',
      },
    });
    expect(r.logs.join('\n')).toMatch(/NOT published — refused to publish: report\.md contains/);
    expect(existsSync(join(tmp, 'loadtest/reports'))).toBe(false);
  });
});
