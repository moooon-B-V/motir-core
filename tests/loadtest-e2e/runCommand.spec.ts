import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { FORCE_INSTANCE_HEADER, NO_SUCH_MACHINE } from '../../scripts/staging/lib/pinnedClient';
import { runId8 } from '../../loadtest/report/report';
import { loadHash } from '../../loadtest/profiles/resolve';
import { loadProfile } from '../../loadtest/profiles/schema';
import { RECYCLE_STEP } from '../../loadtest/report/k6Points';
import { READER_ROUTES } from '../../loadtest/k6/lib/readerOutcome.js';
import { STEPS } from '../../loadtest/k6/runs/sequence.js';
import { appEnv } from '../two-instance/globalSetup';
import { APPS, LANE_LIMITS, MACHINES, NEON, SETTLE_SECONDS } from './lane';

// THE ONE RUN COMMAND, END TO END (Story MOTIR-8538 · MOTIR-8682).
//
// `pnpm loadtest:run` is spawned as a SEPARATE PROCESS — the way an engineer runs
// it — at the tiny profile, against the lane's two `next start` instances on the
// real Postgres. Only what cannot exist in CI is stubbed, and every stub sits at a
// process boundary (no `vi.mock` could reach the run command or k6): fake `fly` and
// `neonctl` executables first on PATH, the fake Fly proxy as the base URL, and one
// stub server for Prometheus and the Neon API. The cases assert COMPLETENESS and
// the chain's contracts, never performance: on a shared runner the numbers mean
// nothing.
//
// ⚠️ CAVEAT, so nobody over-reads a green run: the instances run with
// `E2E_PROD_HARNESS=1`, which turns the session cookie's `Secure` ATTRIBUTE off
// over plain http. The cookie's NAME does not come from that flag (Better-Auth
// derives its prefix from the base URL's scheme), so the lane and real staging
// share a name and differ in the attribute — which this lane does not exercise.

const ctx = inject('loadtestE2e');
const PROFILE = 'tests/loadtest-e2e/tiny.profile.json';

interface Call {
  bin: 'fly' | 'neonctl';
  args: string[];
  at: string;
}
interface Run {
  code: number;
  stdout: string;
  stderr: string;
  runDir: string;
  calls: Call[];
  seconds: number;
}

const readLines = <T>(file: string): T[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
const callsSoFar = () => readLines<Call>(join(ctx.stateDir, 'calls.ndjson'));
const flag = (args: string[], name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const appOf = (c: Call) => flag(c.args, '-a') ?? flag(c.args, '--app');
const json = <T = Record<string, unknown>>(file: string): T =>
  JSON.parse(readFileSync(file, 'utf8')) as T;

function spawnIn(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn('pnpm', ['-s', ...args], {
      cwd: ctx.checkout,
      env: ctx.commandEnv as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

async function runCommand(args: string[]): Promise<Run> {
  const before = callsSoFar().length;
  const started = Date.now();
  const r = await spawnIn(['loadtest:run', ...args]);
  const dir = /run directory: (\S+)/.exec(r.stdout)?.[1];
  if (!dir) {
    throw new Error(
      `no run directory in the output (exit ${r.code}):\n${r.stdout.slice(-4000)}\n${r.stderr.slice(-2000)}`,
    );
  }
  return {
    ...r,
    runDir: resolve(ctx.checkout, dir),
    calls: callsSoFar().slice(before),
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

const why = (run: Run) =>
  `exit ${run.code}\n${run.stdout.slice(-3000)}\n${run.stderr.slice(-1500)}`;

/** Every tag value the k6 point file carries, streamed (never loaded whole). */
async function pointTags(file: string) {
  const groups = new Set<string>();
  const steps = new Set<string>();
  const routes = new Set<string>();
  const counters: Record<string, number> = {};
  const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()) });
  for await (const line of lines) {
    if (!line.includes('"Point"')) continue;
    const p = JSON.parse(line) as {
      metric: string;
      data: { value: number; tags?: Record<string, string> };
    };
    const tags = p.data.tags ?? {};
    if (p.metric === 'mcp_calls' && tags['group']) groups.add(tags['group']);
    if (p.metric === 'run_steps' && tags['step']) steps.add(tags['step']);
    if (p.metric === 'reader_requests' && tags['route']) routes.add(tags['route']);
    if (p.metric.startsWith('stream_'))
      counters[p.metric] = (counters[p.metric] ?? 0) + p.data.value;
  }
  return { groups, steps, routes, counters };
}

/** The literal secrets a run put in play: the lane's own, and every token and cookie the seed minted. */
function seededSecrets(): string[] {
  const manifest = json<{
    agents: { token: string }[];
    users: { cookieHeader: string }[];
  }>(join(ctx.checkout, 'loadtest/.out/manifest.json'));
  const cookies = manifest.users.flatMap((u) =>
    u.cookieHeader
      .split(';')
      .map((c) => c.trim().split('=').slice(1).join('='))
      .filter((v) => v.length >= 16),
  );
  return [
    ...manifest.agents.map((a) => a.token),
    ...manifest.users.map((u) => u.cookieHeader),
    ...cookies,
  ];
}

function laneSecrets(): string[] {
  const s = ctx.secrets;
  return [s.authSecret, s.flyApiToken, s.promToken, s.neonApiKey, s.databaseUrl];
}

const K6_LINES = [
  'perInstance.targetRps',
  'perInstance.readP95Ms',
  'perInstance.readP99Ms',
  'perInstance.mutateP95Ms',
  'perInstance.mutateP99Ms',
  'perInstance.errorRate',
  'perInstance.streamLost',
  'perInstance.rateLimitedMax',
] as const;

interface Line {
  key: string;
  name: string;
  status: string;
  value: string;
  limit: string;
  reason: string | null;
}
interface ReportJson {
  verdict: string;
  servedRps: number | null;
  header: Record<string, unknown> & {
    sha: string;
    instances: number;
    neon: { branchId: string; copiedAt: string; copiedAtField: string };
    app: { name: string; size: string; machines: { id: string; cpus: number }[] };
    profile: { name: string; loadHash: string };
    traceRate: number;
    concurrency: { type: string; softLimit: number; hardLimit: number };
    rateLimits: Record<string, number | string>;
    generator: {
      machineId: string;
      region: string;
      cpus: number;
      cpuMean: unknown;
      cpuMax: unknown;
    };
    window: Record<string, string>;
    prometheus: { endpoint: string; app: string; queriedAt: string; settleSeconds?: number };
  };
  comparable: Record<string, unknown>;
  lines: Line[];
  p2028: {
    status: string;
    total: number | null;
    instances: { instance: string; measured: boolean; committedRise: number | null }[];
    logs: { total: number };
  };
  proxyShed: {
    platform: { state: string; value?: Record<string, number | null> };
    client503: { state: string };
  };
  bottleneck: { candidates: { name: string; state: string; reason: string | null }[] };
  tables: {
    mix: {
      state: string;
      value?: {
        rows: { class: string; servedRps: number | string }[];
        total: { servedRps: number };
      };
    };
    routes: { state: string; value?: { route: string }[] };
    statements: { state: string; reason?: string };
  };
}

/** Every line reads a value or `unmeasured` with its reason, and PASS never sits over an unmeasured value. */
function assertHonestLines(report: ReportJson) {
  for (const l of report.lines) {
    if (l.status === 'unmeasured')
      expect(l.reason, `${l.key} unmeasured without a reason`).toBeTruthy();
    if (l.status === 'PASS') expect(l.value, l.key).not.toMatch(/unmeasured/);
  }
}

describe('the one run command, end to end (MOTIR-8682)', () => {
  let run1: Run;
  let secrets1: string[] = [];

  beforeAll(async () => {
    run1 = await runCommand(['--profile', PROFILE, '--instances', '1', '--app', APPS.staging]);
    console.warn(`loadtest-e2e: the N=1 run took ${run1.seconds} s (exit ${run1.code})`);
    if (existsSync(join(ctx.checkout, 'loadtest/.out/manifest.json'))) secrets1 = seededSecrets();
  });

  it('runs both instances with the RAISED limits, not the two-instance lane’s', () => {
    // Read back from the running processes themselves, so a later change to
    // tests/two-instance/globalSetup.ts appEnv() cannot reach this lane silently.
    for (const i of ctx.instances) {
      const env = new Map(
        readFileSync(`/proc/${i.pid}/environ`, 'utf8')
          .split('\0')
          .filter(Boolean)
          .map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)] as const),
      );
      for (const [name, value] of Object.entries(LANE_LIMITS))
        expect(env.get(name), name).toBe(String(value));
      expect(env.get('E2E_PROD_HARNESS')).toBe('1');
      expect(env.get('NODE_ENV')).toBe('production');
      expect(env.has('MOTIR_RATE_LIMIT_STORE')).toBe(false);
      expect(env.has('E2E_DISABLE_RATE_LIMIT')).toBe(false);
      expect(env.get('MOTIR_BASE_URL')).toBe(ctx.proxyOrigin);
      const twoInstance = appEnv();
      expect(Number(env.get('MOTIR_MCP_RATE_LIMIT'))).toBeGreaterThan(
        Number(twoInstance['MOTIR_MCP_RATE_LIMIT']),
      );
      expect(Number(env.get('MOTIR_API_V1_RATE_LIMIT'))).toBeGreaterThan(
        Number(twoInstance['MOTIR_API_V1_RATE_LIMIT']),
      );
    }
    expect(ctx.commandEnv['K6_AUTO_EXTENSION_RESOLUTION']).toBe('false');
  });

  it('case 1 — N=1 completes: no scale, the generator started and stopped once, every file written', () => {
    expect(run1.code, why(run1)).toBe(0);
    const fly = run1.calls.filter((c) => c.bin === 'fly');
    expect(fly.filter((c) => c.args[0] === 'scale')).toEqual([]);

    const gen = (c: Call) => appOf(c) === APPS.generator;
    const starts = fly.filter((c) => gen(c) && c.args[0] === 'machine' && c.args[1] === 'start');
    const stops = fly.filter((c) => gen(c) && c.args[0] === 'machine' && c.args[1] === 'stop');
    expect(starts.map((c) => c.args)).toEqual([
      ['machine', 'start', MACHINES.generator, '-a', APPS.generator],
    ]);
    expect(stops.map((c) => c.args)).toEqual([
      ['machine', 'stop', MACHINES.generator, '-a', APPS.generator],
    ]);
    const ssh = fly.filter((c) => gen(c) && c.args[0] === 'ssh');
    expect(ssh.length).toBeGreaterThan(0);
    expect(fly.indexOf(starts[0]!)).toBeLessThan(fly.indexOf(ssh[0]!));
    expect(fly.indexOf(stops[0]!)).toBeGreaterThan(fly.indexOf(ssh.at(-1)!));

    // Every readiness and pin request went through `ssh console` on the generator.
    const curls = fly.filter((c) => c.args.some((a) => a.includes('curl ')));
    expect(curls.length).toBe(2); // the enforcement probe + one machine
    for (const c of curls) {
      expect(c.args.slice(0, 6)).toEqual([
        'ssh',
        'console',
        '-a',
        APPS.generator,
        '--machine',
        MACHINES.generator,
      ]);
    }
    const pins = readLines<{ pin: string; routed: boolean; at: string }>(
      join(ctx.stateDir, 'pins.ndjson'),
    ).filter((p) => p.at >= run1.calls[0]!.at);
    expect(pins.filter((p) => p.pin === NO_SUCH_MACHINE).map((p) => p.routed)).toEqual([false]);
    expect(pins.filter((p) => p.pin === MACHINES.app[0]).map((p) => p.routed)).toEqual([true]);
    expect(FORCE_INSTANCE_HEADER).toBe('fly-force-instance-id');

    const files = readdirSync(run1.runDir);
    for (const f of [
      'run.json',
      'profile.resolved.json',
      'summary.json',
      'generator-cpu.csv',
      'k6.log',
      'preflight.txt',
      'k6-points.json.gz',
      'app-logs.ndjson',
      'app-logs.gaps.json',
      'db-samples.csv',
      'neon-endpoint-start.json',
      'neon-endpoint-end.json',
      'pgss-before.json',
      'pgss-after.json',
      'report.md',
      'report.json',
    ])
      expect(files, f).toContain(f);
    expect(statSync(join(run1.runDir, 'k6-points.json.gz')).size).toBeGreaterThan(0);

    // run.json: every contract field present — a value or `unmeasured`, never absent.
    const run = json(join(run1.runDir, 'run.json'));
    for (const key of [
      'runId',
      'profile',
      'instances',
      'instancesHeld',
      'instancesChanged',
      'window',
      'app',
      'production',
      'candidateSize',
      'scale',
      'sha',
      'shaReadFrom',
      'neon',
      'concurrency',
      'requiredConcurrency',
      'rateLimits',
      'offered',
      'pin',
      'traceRate',
      'preflightExitCode',
      'generator',
      'k6',
      'capture',
      'manifestDeleted',
      'baseline',
      'exitCode',
      'reason',
    ]) {
      expect(run, key).toHaveProperty(key);
      expect(run[key], key).not.toBeUndefined();
    }
    const walk = (v: unknown, at: string): void => {
      if (v === undefined) throw new Error(`run.json ${at} is undefined`);
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`);
    };
    walk(run, 'run');
    expect(run['scale']).toBe('not-needed');
    expect(run['instancesHeld']).toBe(true);
    expect(run['manifestDeleted']).toBe(true);
    expect(run['exitCode']).toBe(0);
    expect(json(join(run1.runDir, 'neon-endpoint-start.json'))['state']).toBe('ok');
  });

  it('case 2 — the N=1 report is complete, and every k6-backed line is measured', async () => {
    const report = json<ReportJson>(join(run1.runDir, 'report.json'));
    const md = readFileSync(join(run1.runDir, 'report.md'), 'utf8');
    const h = report.header;
    const { profile } = await loadProfile(PROFILE, 1, ctx.checkout);

    expect(h.sha).toBe(ctx.sha);
    expect(h.neon.branchId).toBe(NEON.branchId);
    expect(h.neon.copiedAt).toBe(NEON.parentTimestamp);
    expect(h.neon.copiedAtField).toBe('parent_timestamp');
    expect(h.app.machines.map((m) => m.id)).toEqual([MACHINES.app[0]]);
    expect(h.app.size).toBe('performance-2x-4096MB');
    expect(h.instances).toBe(1);
    expect(h.profile).toMatchObject({ name: 'tiny', loadHash: loadHash(profile) });
    expect(h.traceRate).toBe(0.1);
    expect(h.concurrency).toEqual({ type: 'requests', softLimit: 1000, hardLimit: 1200 });
    expect(h.rateLimits).toEqual({
      apiV1: LANE_LIMITS.MOTIR_API_V1_RATE_LIMIT,
      mcp: LANE_LIMITS.MOTIR_MCP_RATE_LIMIT,
      agentWorkspace: LANE_LIMITS.MOTIR_AGENT_WORKSPACE_RATE_LIMIT,
    });
    expect(h.generator).toMatchObject({ machineId: MACHINES.generator, region: 'iad', cpus: 4 });
    expect(typeof h.generator.cpuMean).toBe('number');
    for (const k of [
      'sha',
      'neon',
      'app',
      'profile',
      'traceRate',
      'concurrency',
      'rateLimits',
      'generator',
    ])
      expect(md).toContain(`- **${k}**:`);

    // The comparable subset holds identifiers and configuration, no measured value.
    const comparable = JSON.stringify(report.comparable);
    expect(report.comparable['sha']).toBe(ctx.sha);
    expect(report.comparable['loadHash']).toBe(loadHash(profile));
    for (const measured of [
      ...Object.values(h.window),
      h.prometheus.queriedAt,
      String(h.generator.cpuMean),
      String(report.servedRps),
    ])
      expect(comparable).not.toContain(measured);
    expect(md).toContain('### Comparable');

    // One line per threshold; the scale-out line n/a at N = 1.
    const keys = report.lines.map((l) => l.key);
    for (const key of Object.keys(profile.thresholds.perInstance))
      expect(keys).toContain(`perInstance.${key}`);
    const scale = report.lines.find((l) => l.key === 'scaleOut.efficiency')!;
    expect(scale.status).toBe('n/a');
    for (const key of K6_LINES) {
      const l = report.lines.find((x) => x.key === key)!;
      expect(l.status, `${key}: ${l.value} ${l.reason ?? ''}`).not.toBe('unmeasured');
      expect(l.value).not.toMatch(/unmeasured/);
    }
    assertHonestLines(report);

    // The refusal line, and the Fly-proxy 503 reading from the platform series.
    expect(md).toMatch(/## Rate-limit refusals\n\n(PASS|FAIL): [\d.]+ % \(\d+ refused of \d+/);
    expect(report.proxyShed.platform.state).toBe('ok');
    expect(report.proxyShed.platform.value).toEqual({ [MACHINES.app[0]]: 0 });
    expect(md).toContain(`- platform 503s by instance: ${MACHINES.app[0]} 0`);

    // P2028: measured from the stub counter and its positive control.
    expect(report.p2028.status).toBe('PASS');
    expect(report.p2028.total).toBe(0);
    expect(report.p2028.instances).toHaveLength(1);
    expect(report.p2028.instances[0]).toMatchObject({ instance: MACHINES.app[0], measured: true });
    expect(report.p2028.instances[0]!.committedRise).toBeGreaterThan(0);
    expect(report.p2028.logs.total).toBe(0);
    expect(md).toMatch(/^P2028: 0 — PASS/m);

    // The bottleneck block lists every candidate; the supporting tables exist.
    expect(report.bottleneck.candidates.map((c) => c.name)).toEqual([
      'proxy',
      'cpu',
      'memory',
      'pool',
      'database',
    ]);
    for (const c of report.bottleneck.candidates) {
      expect(c.state, `${c.name}: ${c.reason ?? ''}`).not.toBe('unmeasured');
    }
    expect(md).toContain('## First bottleneck');
    for (const label of [
      'Fly proxy limit',
      'app CPU',
      'app memory',
      'connection pool',
      'database (Neon load)',
    ])
      expect(md).toContain(`- ${label}`);
    // MOTIR-9152 — the served agent mix, one row per class, summing to the served rps.
    expect(report.tables.mix.state).toBe('ok');
    expect(md).toContain(
      '## Agent mix (steady window)\n\n| class | offered VUs | served rps | share | ok | empty | error | limited | p95 ms | p99 ms |',
    );
    const mixRows = report.tables.mix.value!.rows;
    expect(mixRows.map((r) => r.class).slice(0, 6)).toEqual([
      'read',
      'write',
      'claim',
      'burst',
      'run',
      'readers',
    ]);
    expect(report.tables.mix.value!.total.servedRps).toBeCloseTo(report.servedRps!, 6);
    expect(report.tables.routes.state).toBe('ok');
    expect(md).toContain('## Per route (steady window)\n\n| route | rps | p95 ms | p99 ms |');
    expect(md).toContain('## Top statements by total-time delta');
    if (report.tables.statements.state !== 'ok') {
      // pg_stat_statements is not loaded on the CI Postgres: unmeasured, WITH its reason.
      expect(report.tables.statements.reason).toBeTruthy();
      expect(md).toContain(`unmeasured — ${report.tables.statements.reason}`);
    }

    // Requests carry all four agent groups, the run-lifecycle steps and the seven reader routes.
    const tags = await pointTags(join(run1.runDir, 'k6-points.json.gz'));
    expect([...tags.groups].sort()).toEqual(['burst', 'claim', 'read', 'write']);
    expect([...tags.steps].sort()).toEqual([...STEPS].sort());
    expect(STEPS).toContain(RECYCLE_STEP);
    expect([...tags.routes].sort()).toEqual([...READER_ROUTES].sort());
    expect(tags.counters['stream_opened']).toBeGreaterThan(0);
    expect(tags.counters['stream_lost'] ?? 0).toBe(0);

    expect(report.verdict).not.toBe('INVALID');
  });

  describe('N=2 against the named 1-instance report', () => {
    let run2: Run;
    let secrets2: string[] = [];

    beforeAll(async () => {
      run2 = await runCommand([
        '--profile',
        PROFILE,
        '--instances',
        '2',
        '--app',
        APPS.staging,
        '--baseline',
        relative(ctx.checkout, run1.runDir),
      ]);
      console.warn(`loadtest-e2e: the N=2 run took ${run2.seconds} s (exit ${run2.code})`);
      if (existsSync(join(ctx.checkout, 'loadtest/.out/manifest.json'))) secrets2 = seededSecrets();
    });

    it('case 3 — scales once to two machines, holds them, and reads a measured scale-out line', () => {
      expect(run2.code, why(run2)).toBe(0);
      const scales = run2.calls.filter((c) => c.bin === 'fly' && c.args[0] === 'scale');
      expect(scales.map((c) => c.args)).toEqual([
        ['scale', 'count', 'app=2', '-a', APPS.staging, '--yes'],
      ]);

      const run = json<{
        instances: number;
        app: { machines: { id: string }[] };
        instancesHeld: boolean;
        baseline: string;
        scale: string;
      }>(join(run2.runDir, 'run.json'));
      expect(run.instances).toBe(2);
      expect(run.app.machines.map((m) => m.id).sort()).toEqual([...MACHINES.app]);
      expect(run.instancesHeld).toBe(true);
      expect(run.baseline).toBe(run1.runDir);
      expect(run.scale).toBe('groupEquals');

      // The read-back saw both machines ready: one pinned readiness answer each.
      const pins = readLines<{ pin: string; routed: boolean; at: string }>(
        join(ctx.stateDir, 'pins.ndjson'),
      ).filter((p) => p.at >= run2.calls[0]!.at);
      expect(
        pins
          .filter((p) => p.routed)
          .map((p) => p.pin)
          .sort(),
      ).toEqual([...MACHINES.app]);

      const base = json<ReportJson>(join(run1.runDir, 'report.json'));
      const report = json<ReportJson>(join(run2.runDir, 'report.json'));
      const scale = report.lines.find((l) => l.key === 'scaleOut.efficiency')!;
      expect(['PASS', 'FAIL'], `${scale.value} — ${scale.reason ?? ''}`).toContain(scale.status);
      const round2 = (x: number) => Math.round(x * 100) / 100;
      expect(scale.limit).toContain(`(0.1 × 2 × ${round2(base.servedRps!)})`);
      expect(scale.value).toContain(`${round2(report.servedRps!)} rps (shares `);
      for (const id of MACHINES.app) expect(scale.value).toMatch(new RegExp(`${id} \\d+ %`));
      const throughput = report.lines.find((l) => l.key === 'perInstance.targetRps')!;
      expect(throughput.status).toBe('n/a');
      expect(throughput.value).toMatch(/rps per instance \(information\)/);
      assertHonestLines(report);
      expect(report.verdict).not.toBe('INVALID');

      // The settle-wait override reached the report, which reads back the value it ran with.
      expect(report.header.prometheus.settleSeconds).toBe(SETTLE_SECONDS);
      expect(base.header.prometheus.settleSeconds).toBe(SETTLE_SECONDS);
    });

    it('case 4 — production is never written, and nothing reads past the staging app and branch', () => {
      const calls = [...run1.calls, ...run2.calls];
      const onProduction = calls.filter((c) => c.bin === 'fly' && appOf(c) === APPS.production);
      expect(onProduction.length).toBeGreaterThan(0);
      for (const c of onProduction)
        expect(c.args).toEqual(['machine', 'list', '--json', '-a', APPS.production]);
      // No other verb anywhere names production, even without -a.
      for (const c of calls.filter((x) => !onProduction.includes(x)))
        expect(c.args.join(' '), c.args.join(' ')).not.toMatch(/(^|[\s=])motir-core($|\s)/);

      const secretReads = calls.filter((c) => c.bin === 'fly' && c.args[0] === 'secrets');
      expect(secretReads.length).toBe(2);
      for (const c of secretReads)
        expect(c.args).toEqual(['secrets', 'list', '--json', '-a', APPS.staging]);

      const requests = readLines<{
        api: string;
        query?: string;
        path: string;
        authorized: boolean;
      }>(join(ctx.stateDir, 'requests.ndjson'));
      const prom = requests.filter((r) => r.api === 'prometheus');
      expect(prom.length).toBeGreaterThan(0);
      for (const r of prom) {
        expect(r.query).not.toContain(`app="${APPS.production}"`);
        expect(r.query).toContain(`app="${APPS.staging}"`);
        expect(r.authorized).toBe(true);
      }

      const neonCalls = calls.filter((c) => c.bin === 'neonctl');
      expect(neonCalls.length).toBeGreaterThan(0);
      for (const c of neonCalls) {
        const branch = c.args[0] === 'branches' ? c.args[2] : c.args[1];
        expect(branch, c.args.join(' ')).toBe(NEON.branchName);
        expect(c.args).not.toContain('--branch');
      }
      const neonApi = requests.filter((r) => r.api === 'neon');
      expect(neonApi.length).toBeGreaterThan(0);
      for (const r of neonApi) {
        expect(r.path).toBe(
          `/neon/api/v2/projects/${NEON.projectId}/branches/${NEON.branchId}/endpoints`,
        );
        expect(r.authorized).toBe(true);
      }
    });

    it('case 5 — credentials stay off disk and out of output; --publish copies the two report files only', async () => {
      expect(readdirSync(join(ctx.generatorRoot, 'dev/shm/loadtest'))).toEqual([]);
      const anyManifest = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory()
            ? anyManifest(join(dir, e.name))
            : e.name === 'manifest.json'
              ? [join(dir, e.name)]
              : [],
        );
      expect(anyManifest(ctx.generatorRoot)).toEqual([]);

      const secrets = [...secrets1, ...secrets2, ...laneSecrets()];
      expect(secrets1.length).toBeGreaterThan(10);
      expect(secrets2.length).toBeGreaterThan(10);
      const outputs: [string, string][] = [];
      for (const run of [run1, run2]) {
        outputs.push(
          [`stdout of ${run.runDir}`, run.stdout],
          [`stderr of ${run.runDir}`, run.stderr],
        );
        for (const f of ['run.json', 'report.md', 'report.json'])
          outputs.push([join(run.runDir, f), readFileSync(join(run.runDir, f), 'utf8')]);
      }
      for (const [where, text] of outputs) {
        const leaked = secrets.filter((s) => text.includes(s)).length;
        expect(leaked, `${where} holds ${leaked} seeded secret value(s)`).toBe(0);
      }

      const published = await spawnIn([
        'loadtest:report',
        relative(ctx.checkout, run1.runDir),
        '--publish',
      ]);
      expect(published.stdout).toMatch(/published: /);
      const runId = json<{ runId: string; window: { startedAt: string } }>(
        join(run1.runDir, 'run.json'),
      );
      const reports = join(ctx.checkout, 'loadtest/reports');
      const dest = `${runId.window.startedAt.slice(0, 10)}-tiny-n1-${runId8(runId.runId)}`;
      expect(readdirSync(reports)).toEqual([dest]);
      expect(readdirSync(join(reports, dest)).sort()).toEqual(['report.json', 'report.md']);
      for (const f of ['report.md', 'report.json']) {
        const text = readFileSync(join(reports, dest, f), 'utf8');
        expect(secrets.filter((s) => text.includes(s))).toEqual([]);
      }
    });
  });
});
