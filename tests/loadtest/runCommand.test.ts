import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_WORKSPACE_RATE_LIMIT,
  DEFAULT_MCP_RATE_LIMIT,
} from '@/lib/rateLimit/budgets';
import { DEFAULT_RATE_LIMIT } from '@/lib/api/v1/rateLimit';
import { loadHash } from '@/loadtest/profiles/resolve';
import type { LoadProfile } from '@/loadtest/profiles/schema';
import type { SeedManifest } from '@/loadtest/seed/manifest';
import { parseMachines, type CommandResult, type Exec } from '@/loadtest/run/fly';
import { copiedFrom } from '@/loadtest/run/neon';
import {
  EXIT,
  OPTIONS,
  PRODUCTION_RATE_DEFAULTS,
  runLoadTest,
  type RunDeps,
} from '@/loadtest/run/run';
import type { RunRecord } from '@/loadtest/run/runRecord';

// The run command (Story MOTIR-8538 · MOTIR-8678) against a FAKE platform: `fly` and
// `neonctl` are answered from an in-memory model of the staging app, production,
// the generator and the Neon branch, so every refusal can be produced on purpose
// and every call the command makes is recorded.
//
// ⚠️ The machine and branch JSON is built from the documented shapes (Fly Machines
// API machine config; the Neon API branch object). No flyctl or neonctl was
// reachable where this was written; the first real run compares one response of
// each against these fixtures.

const ROOT = resolve(__dirname, '../..');
const APP = 'motir-core-staging';
const GEN_APP = 'motir-loadgen';
const BASE_URL = 'http://motir-core-staging.flycast';
const DIRECT = 'ep-quiet-sky-123456.us-east-2.aws.neon.tech';
const POOLED = 'ep-quiet-sky-123456-pooler.us-east-2.aws.neon.tech';
const SECRET = 'npg_s3cretPassw0rd';
const SHA = 'a'.repeat(40);
const K6_OUT =
  'k6 v1.2.1 (go1.24.7, linux/amd64)\nExtensions:\n  github.com/phymbert/xk6-sse v0.1.12, k6/x/sse [js]\n';

interface FakeService {
  internal_port: number;
  autostop?: unknown;
  autostart?: boolean;
  min_machines_running?: number;
  concurrency?: { type?: string; soft_limit?: number; hard_limit?: number };
}

interface FakeMachine {
  id: string;
  state: string;
  region: string;
  group: string;
  guest: { cpu_kind: string; cpus: number; memory_mb: number };
  tag: string;
  services: FakeService[];
}

const SERVICE: FakeService = {
  internal_port: 3000,
  autostop: 'off',
  autostart: false,
  concurrency: { type: 'requests', soft_limit: 100, hard_limit: 120 },
};
const GUEST = { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 };

const appMachine = (id: string, over: Partial<FakeMachine> = {}): FakeMachine => ({
  id,
  state: 'started',
  region: 'iad',
  group: 'app',
  guest: { ...GUEST },
  tag: SHA,
  services: [structuredClone(SERVICE)],
  ...over,
});

/** A `fly machine list --json` element in the documented shape. */
function toJson(m: FakeMachine) {
  return {
    id: m.id,
    name: `name-${m.id}`,
    state: m.state,
    region: m.region,
    image_ref: {
      registry: 'registry.fly.io',
      repository: 'motir-core',
      tag: m.tag,
      digest: 'sha256:0',
    },
    config: {
      guest: m.guest,
      metadata: { fly_process_group: m.group },
      services: m.services,
      image: `registry.fly.io/motir-core:${m.tag}`,
    },
  };
}

interface World {
  staging: FakeMachine[];
  production: FakeMachine[];
  generator: FakeMachine[];
  /** Applied to the staging machines on each `machine list` call after the n-th. */
  stagingAfter: { calls: number; machines: FakeMachine[] } | null;
  stagingEnv: Record<string, string>;
  branch: Record<string, unknown>;
  branchUrl: string;
  /** What the proxy answers for a request pinned to a machine id. */
  pin: (id: string) => { status: number; body: string };
  k6Version: string;
  k6Exit: number;
  failPut: boolean;
  generatorNeverStarts: boolean;
  scaleRefusesEquals: boolean;
  noVolume: boolean;
  calls: { bin: string; args: string[] }[];
  stagingLists: number;
}

let world: World;
let cwd: string;
let logs: string[];
let reports: string[];
let clock: number;

function newWorld(n = 1): World {
  return {
    staging: Array.from({ length: n }, (_, i) => appMachine(`app${i + 1}`)),
    production: [appMachine('prod1'), appMachine('prod2')],
    generator: [
      {
        ...appMachine('gen1'),
        state: 'stopped',
        group: 'app',
        services: [],
        guest: { cpu_kind: 'performance', cpus: 8, memory_mb: 16384 },
      },
    ],
    stagingAfter: null,
    stagingEnv: {
      DATABASE_URL: `postgresql://motir_app:${SECRET}@${POOLED}/motir?sslmode=require`,
    },
    branch: {
      id: 'br-loadtest-1',
      name: 'loadtest',
      parent_timestamp: '2026-10-14T03:00:00Z',
      created_at: '2026-10-01T00:00:00Z',
    },
    branchUrl: `postgresql://motir_app:${SECRET}@${DIRECT}/motir?sslmode=require`,
    pin: (id) =>
      id.startsWith('app')
        ? { status: 200, body: '{"state":"ready"}' }
        : { status: 503, body: 'no such instance' },
    k6Version: K6_OUT,
    k6Exit: 0,
    failPut: false,
    generatorNeverStarts: false,
    scaleRefusesEquals: false,
    noVolume: false,
    calls: [],
    stagingLists: 0,
  };
}

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
const fail = (code = 1): CommandResult => ({ code, stdout: '', stderr: 'refused' });

const fakeExec: Exec = async (bin, args) => {
  const a = [...args];
  world.calls.push({ bin, args: a });
  if (bin === 'neonctl') {
    if (a[0] === 'branches') return ok(JSON.stringify({ branch: world.branch }));
    if (a[0] === 'connection-string') return ok(`${world.branchUrl}\n`);
    return fail();
  }
  if (bin !== 'fly') return fail(127);
  const app = a[a.indexOf('-a') + 1];
  if (a[0] === 'machine' && a[1] === 'list') {
    if (app === APP) {
      world.stagingLists += 1;
      if (world.stagingAfter && world.stagingLists > world.stagingAfter.calls) {
        world.staging = world.stagingAfter.machines;
      }
      return ok(JSON.stringify(world.staging.map(toJson)));
    }
    if (app === 'motir-core') return ok(JSON.stringify(world.production.map(toJson)));
    if (app === GEN_APP) return ok(JSON.stringify(world.generator.map(toJson)));
    return fail();
  }
  if (a[0] === 'scale') {
    if (a[2]!.startsWith('app=') && world.scaleRefusesEquals) return fail();
    const target = a[2]!.startsWith('app=') ? Number(a[2]!.slice(4)) : Number(a[2]);
    while (world.staging.length < target)
      world.staging.push(appMachine(`app${world.staging.length + 1}`));
    world.staging = world.staging.slice(0, target);
    return ok();
  }
  if (a[0] === 'machine' && (a[1] === 'start' || a[1] === 'stop')) {
    const m = world.generator.find((g) => g.id === a[2]);
    if (!m) return fail();
    if (a[1] === 'stop' || !world.generatorNeverStarts)
      m.state = a[1] === 'start' ? 'started' : 'stopped';
    return ok();
  }
  if (a[0] === 'ssh' && a[1] === 'sftp') {
    if (a[2] === 'put') return world.failPut ? fail() : ok();
    if (a[2] === 'get') {
      const remote = a.at(-2)!;
      const local = a.at(-1)!;
      writeFileSync(local, remote.endsWith('summary.json') ? '{"metrics":{}}' : 'x\n');
      return ok();
    }
  }
  if (a[0] === 'ssh' && a[1] === 'console') {
    const cmd = a[a.indexOf('-C') + 1]!;
    if (app === APP) {
      const name = /^printenv ([A-Z_0-9]+)$/.exec(cmd)?.[1];
      if (!name) return fail(2);
      const v = world.stagingEnv[name];
      return v === undefined ? { code: 1, stdout: '', stderr: '' } : ok(`${v}\n`);
    }
    if (cmd.endsWith(' version')) return ok(world.k6Version);
    if (cmd.includes('curl')) {
      const pinned = /fly-force-instance-id: ([^"]+)"/.exec(cmd)![1]!;
      const ans = world.pin(pinned);
      return ok(`${ans.body}\n${ans.status}`);
    }
    if (cmd.includes('@@exit'))
      return ok(`running (01m00.0s), 40/40 VUs\n@@exit ${world.k6Exit}\n`);
    if (cmd.startsWith('cat ') && cmd.endsWith('started.at')) return ok('2026-10-15T20:00:00Z\n');
    if (cmd.startsWith('cat ') && cmd.endsWith('ended.at')) return ok('2026-10-15T20:04:20Z\n');
    if (cmd.includes('/proc/mounts')) return world.noVolume ? fail() : ok();
    if (cmd.startsWith('sh -c ')) return ok();
    return fail();
  }
  return fail();
};

/** A manifest that covers the smoke profile's VUs at N. */
function manifestFor(n: number): SeedManifest {
  const agents = [];
  for (const role of ['read', 'write', 'claim', 'run'] as const) {
    for (let i = 0; i < 16 * n; i++) {
      agents.push({
        tokenId: `${role}-${i}`,
        token: 'mtr_secret_token',
        role,
        userId: 'u',
        workspaceId: 'w',
        projectId: 'p',
        projectKey: 'LTA',
        scratchPlanIds: [],
        ...(role === 'write' && i < 2 * n
          ? {
              burst: {
                cards: [],
                parents: [
                  { id: 'a', key: 'A' },
                  { id: 'b', key: 'B' },
                ],
              },
            }
          : {}),
      });
    }
  }
  return {
    version: 1,
    runTag: 'lt',
    seededAt: '2026-10-15T19:59:00Z',
    baseUrl: BASE_URL,
    databaseHost: DIRECT,
    sessionLifetimeSeconds: 1,
    sessionsExpireAt: '2026-10-22T00:00:00Z',
    shape: {} as SeedManifest['shape'],
    users: Array.from({ length: 8 * n }, (_, i) => ({ id: `u${i}` })) as SeedManifest['users'],
    agents: agents as SeedManifest['agents'],
    workspaces: Array.from({ length: 2 * n }, (_, i) => ({
      id: `w${i}`,
    })) as SeedManifest['workspaces'],
    projects: [],
  };
}

const ENV = {
  LOADTEST_STAGING_APP: APP,
  LOADTEST_GENERATOR_APP: GEN_APP,
  LOADTEST_NEON_PROJECT: 'proj-1',
  LOADTEST_NEON_BRANCH: 'loadtest',
  LOADTEST_DATABASE_URL: `postgresql://motir_app:${SECRET}@${POOLED}/motir`,
  LOADTEST_ALLOWED_DB_HOST: DIRECT,
  LOADTEST_PRODUCTION_DB_HOSTS: 'ep-prod-9.us-east-2.aws.neon.tech',
  FLY_API_TOKEN: 'fo1_flysecret',
  STAGING_BASE_URL: BASE_URL,
  STAGING_ALLOWED_HOST: 'motir-core-staging.flycast',
  BETTER_AUTH_SECRET: 'auth-secret-value',
  GOOGLE_CLIENT_ID: 'gid',
  GOOGLE_CLIENT_SECRET: 'gsecret-value',
  NODE_ENV: 'production',
};

/** Stand-ins for the run-window recorders' I/O, so no real `fly logs` or Postgres is touched. */
const CAPTURE_STUBS: NonNullable<RunDeps['capture']> = {
  logRunner: (_args, onLine) => {
    let kill: () => void = () => undefined;
    const exited = new Promise<number>((r) => {
      kill = () => r(0);
    });
    onLine(
      JSON.stringify({ timestamp: 't1', instance: 'app1', message: 'GET /api/health/ready 200' }),
    );
    return { exited, kill };
  },
  readTopStatements: async () => ({ state: 'extension_not_installed' }),
  dbClient: () => ({
    connect: async () => undefined,
    query: async () => ({ rows: [{ backends: 3 }] }),
    end: async () => undefined,
  }),
  sampleIntervalMs: 60_000,
};

let preflightExit = 0;
let manifestN = 1;
let seedCalls: string[][] = [];

function deps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    exec: fakeExec,
    env: ENV,
    cwd,
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
    log: (line) => logs.push(line),
    preflight: async () => ({
      exitCode: preflightExit,
      text: preflightExit ? 'LIVE row' : 'PASS all',
    }),
    seed: async (command, args) => {
      seedCalls.push([command, ...args]);
      return 0;
    },
    readManifest: async () => manifestFor(manifestN),
    report: async (dir) => {
      reports.push(dir);
      return 6;
    },
    capture: CAPTURE_STUBS,
    ...over,
  };
}

const SMOKE_ARGS = ['--profile', 'smoke', '--instances', '1', '--app', APP];
const flyCalls = (pred: (a: string[]) => boolean) =>
  world.calls.filter((c) => c.bin === 'fly' && pred(c.args));
const scaleCalls = () => flyCalls((a) => a[0] === 'scale');
const generatorStarts = () => flyCalls((a) => a[0] === 'machine' && a[1] === 'start');
const generatorStops = () => flyCalls((a) => a[0] === 'machine' && a[1] === 'stop');
const k6Starts = () => flyCalls((a) => a.some((x) => x.includes('setsid nohup')));
const manifestDeletes = () =>
  flyCalls((a) => a.some((x) => x.includes('rm -f /dev/shm/loadtest/manifest.json')));
const record = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as RunRecord;

beforeEach(() => {
  world = newWorld(1);
  cwd = mkdtempSync(join(tmpdir(), 'loadtest-run-'));
  mkdirSync(join(cwd, 'loadtest/k6'), { recursive: true });
  mkdirSync(join(cwd, 'loadtest/profiles'), { recursive: true });
  for (const f of [
    'loadtest/k6/versions.env',
    'loadtest/profiles/smoke.json',
    'loadtest/profiles/default.json',
  ]) {
    writeFileSync(join(cwd, f), readFileSync(join(ROOT, f)));
  }
  writeFileSync(join(cwd, 'package.json'), '{"scripts":{}}');
  logs = [];
  reports = [];
  clock = Date.parse('2026-10-15T19:00:00Z');
  preflightExit = 0;
  manifestN = 1;
  seedCalls = [];
});

/** A baseline run directory at 1 instance for the smoke profile. */
function baselineDir(): string {
  const dir = join(cwd, 'base');
  mkdirSync(dir, { recursive: true });
  const smoke = JSON.parse(
    readFileSync(join(ROOT, 'loadtest/profiles/smoke.json'), 'utf8'),
  ) as LoadProfile;
  writeFileSync(
    join(dir, 'run.json'),
    JSON.stringify({ instances: 1, profile: { sha256: loadHash(smoke) } }),
  );
  return dir;
}

describe('step 1 — refusals before any platform call', () => {
  it('--app motir-core exits 2 with zero runner calls and no run.json', async () => {
    const out = await runLoadTest(
      ['--profile', 'smoke', '--instances', '1', '--app', 'motir-core'],
      deps(),
    );
    expect(out.exitCode).toBe(EXIT.refused);
    expect(world.calls).toEqual([]);
    expect(out.runDir).toBeNull();
    expect(existsSync(join(cwd, 'loadtest/.out/runs'))).toBe(false);
  });

  it('an app not ending in -staging exits 2 with zero runner calls', async () => {
    const out = await runLoadTest(
      ['--profile', 'smoke', '--instances', '1', '--app', 'motir-core-prod'],
      deps({ env: { ...ENV, LOADTEST_STAGING_APP: undefined } }),
    );
    expect(out.exitCode).toBe(EXIT.refused);
    expect(world.calls).toEqual([]);
    expect(logs.join('\n')).toMatch(/does not end in -staging/);
    expect(existsSync(join(cwd, 'loadtest/.out/runs'))).toBe(false);
  });

  it('names every missing variable at once', async () => {
    const env = {
      ...ENV,
      LOADTEST_GENERATOR_APP: undefined,
      FLY_API_TOKEN: '',
      STAGING_BASE_URL: undefined,
    };
    const out = await runLoadTest(SMOKE_ARGS, deps({ env }));
    expect(out.exitCode).toBe(EXIT.refused);
    expect(logs.join('\n')).toMatch(
      /missing LOADTEST_GENERATOR_APP, FLY_API_TOKEN, STAGING_BASE_URL/,
    );
    expect(world.calls).toEqual([]);
  });

  it('refuses a STAGING_BASE_URL whose host is not STAGING_ALLOWED_HOST', async () => {
    const out = await runLoadTest(
      SMOKE_ARGS,
      deps({ env: { ...ENV, STAGING_ALLOWED_HOST: 'other.flycast' } }),
    );
    expect(out.exitCode).toBe(EXIT.refused);
    expect(world.calls).toEqual([]);
  });

  it('N > 1 without --baseline exits 2 naming the flag', async () => {
    const out = await runLoadTest(['--profile', 'smoke', '--instances', '2', '--app', APP], deps());
    expect(out.exitCode).toBe(EXIT.refused);
    expect(logs.join('\n')).toMatch(/--baseline <run dir> is required/);
    expect(world.calls).toEqual([]);
  });

  it('a baseline with a different load hash exits 2', async () => {
    const dir = baselineDir();
    writeFileSync(
      join(dir, 'run.json'),
      JSON.stringify({ instances: 1, profile: { sha256: 'x' } }),
    );
    const out = await runLoadTest(
      [...SMOKE_ARGS.slice(0, 3), '2', '--app', APP, '--baseline', dir],
      deps(),
    );
    expect(out.exitCode).toBe(EXIT.refused);
    expect(logs.join('\n')).toMatch(/different load/);
  });

  it('an invalid profile exits 2 naming the field', async () => {
    const path = join(cwd, 'bad.json');
    writeFileSync(
      path,
      JSON.stringify({
        ...JSON.parse(readFileSync(join(ROOT, 'loadtest/profiles/smoke.json'), 'utf8')),
        extra: 1,
      }),
    );
    const out = await runLoadTest(['--profile', path, '--instances', '1', '--app', APP], deps());
    expect(out.exitCode).toBe(EXIT.refused);
    expect(logs.join('\n')).toMatch(/extra/);
    expect(world.calls).toEqual([]);
  });
});

describe('a completed run', () => {
  it('writes a run directory whose run.json has every field, and invokes the report', async () => {
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.completed);
    const r = record(out.runDir!);
    expect(r).toMatchObject({
      profile: { name: 'smoke', path: 'loadtest/profiles/smoke.json' },
      instances: 1,
      instancesHeld: true,
      app: {
        name: APP,
        machines: [{ id: 'app1', region: 'iad', cpuKind: 'performance', cpus: 2, memoryMb: 4096 }],
      },
      production: { cpuKind: 'performance', cpus: 2, memoryMb: 4096 },
      candidateSize: false,
      scale: 'not-needed',
      sha: SHA,
      shaReadFrom: 'image_ref tag',
      neon: {
        project: 'proj-1',
        branchId: 'br-loadtest-1',
        copiedAt: '2026-10-14T03:00:00Z',
        copiedAtField: 'parent_timestamp',
        endpointHost: DIRECT,
      },
      concurrency: { type: 'requests', softLimit: 100, hardLimit: 120 },
      requiredConcurrency: { hard: 82, soft: 66 },
      rateLimits: { apiV1: 'default', mcp: 'default', agentWorkspace: 'default' },
      pin: { enforced: true, via: 'generator', unknownIdAnswer: 'status 503' },
      traceRate: 0,
      preflightExitCode: 0,
      generator: { app: GEN_APP, machineId: 'gen1', region: 'iad', cpus: 8 },
      k6: { version: 'v1.2.1', extensions: ['github.com/phymbert/xk6-sse v0.1.12'], exitCode: 0 },
      manifestDeleted: true,
      baseline: null,
      exitCode: 0,
      reason: null,
      window: {
        startedAt: '2026-10-15T20:00:00.000Z',
        rampEndedAt: '2026-10-15T20:01:00.000Z',
        steadyEndedAt: '2026-10-15T20:04:00.000Z',
        endedAt: '2026-10-15T20:04:20Z',
      },
    });
    expect(r.profile.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.offered.perTokenRps.mcp).toBeGreaterThan(0);
    expect(r.offered.perWorkspaceRps).toBeGreaterThan(0);
    expect(typeof r.generator.startedAt).toBe('string');
    expect(typeof r.generator.stoppedAt).toBe('string');
    for (const f of [
      'run.json',
      'profile.resolved.json',
      'summary.json',
      'generator-cpu.csv',
      'k6.log',
      'preflight.txt',
    ]) {
      expect(existsSync(join(out.runDir!, f)), f).toBe(true);
    }
    expect(reports).toEqual([out.runDir]);
    expect(out.reportExitCode).toBe(6);
  });

  it('makes no scale call when the group is already at N', async () => {
    await runLoadTest(SMOKE_ARGS, deps());
    expect(scaleCalls()).toEqual([]);
  });

  it('starts the generator once and stops it once, and deletes the manifest', async () => {
    await runLoadTest(SMOKE_ARGS, deps());
    expect(generatorStarts().map((c) => c.args)).toEqual([
      ['machine', 'start', 'gen1', '-a', GEN_APP],
    ]);
    expect(generatorStops().map((c) => c.args)).toEqual([
      ['machine', 'stop', 'gen1', '-a', GEN_APP],
    ]);
    expect(manifestDeletes()).toHaveLength(1);
  });

  it('runs k6 detached with K6_AUTO_EXTENSION_RESOLUTION=false and no threshold option', async () => {
    const out = await runLoadTest(SMOKE_ARGS, deps());
    const script = readFileSync(join(out.runDir!, 'run.sh'), 'utf8');
    expect(script).toMatch(/K6_AUTO_EXTENSION_RESOLUTION=false \/opt\/loadtest\/k6 run/);
    expect(script).toMatch(/--summary-export \/data\/run\/summary.json/);
    expect(script).not.toMatch(/threshold/i);
    expect(k6Starts()[0]!.args.at(-1)).toBe(
      "sh -c 'setsid nohup sh /data/run/run.sh > /dev/null 2>&1 &'",
    );
    const resolved = JSON.parse(readFileSync(join(out.runDir!, 'profile.resolved.json'), 'utf8'));
    expect(JSON.stringify(resolved.k6)).not.toMatch(/"thresholds"/);
  });

  it('uploads the manifest into tmpfs with mode 0600', async () => {
    await runLoadTest(SMOKE_ARGS, deps());
    const put = flyCalls((a) => a[2] === 'put' && a.at(-1) === '/dev/shm/loadtest/manifest.json');
    expect(put).toHaveLength(1);
    expect(put[0]!.args).toEqual(expect.arrayContaining(['-m', '0600']));
  });

  it('seeds the scaled shape, then resets, against the branch', async () => {
    await runLoadTest(SMOKE_ARGS, deps());
    expect(seedCalls.map((c) => c[0])).toEqual(['seed', 'reset']);
    expect(seedCalls[0]).toEqual(expect.arrayContaining(['--shape', '--tag', 'lt']));
  });

  it('a k6 exit of 99 is recorded as completed', async () => {
    world.k6Exit = 99;
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.completed);
    expect(record(out.runDir!).k6.exitCode).toBe(99);
  });

  it('prints no secret value or full URL', async () => {
    await runLoadTest(SMOKE_ARGS, deps());
    const out = logs.join('\n');
    for (const secret of [
      SECRET,
      'fo1_flysecret',
      'auth-secret-value',
      'gsecret-value',
      'mtr_secret_token',
      'postgresql://',
    ]) {
      expect(out).not.toContain(secret);
    }
    const runs = join(cwd, 'loadtest/.out/runs');
    const dir = join(runs, (await import('node:fs')).readdirSync(runs)[0]!);
    for (const f of ['run.json', 'profile.resolved.json']) {
      const text = readFileSync(join(dir, f), 'utf8');
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('postgresql://');
    }
  });
});

describe('scaling', () => {
  it('at N−1 makes exactly one fly scale count app=<N> call', async () => {
    manifestN = 2;
    const out = await runLoadTest(
      ['--profile', 'smoke', '--instances', '2', '--app', APP, '--baseline', baselineDir()],
      deps(),
    );
    expect(out.exitCode).toBe(EXIT.completed);
    expect(scaleCalls().map((c) => c.args)).toEqual([
      ['scale', 'count', 'app=2', '-a', APP, '--yes'],
    ]);
    expect(record(out.runDir!).scale).toBe('groupEquals');
  });

  it('falls back to the --process-group spelling and records it', async () => {
    world.scaleRefusesEquals = true;
    manifestN = 2;
    const out = await runLoadTest(
      ['--profile', 'smoke', '--instances', '2', '--app', APP, '--baseline', baselineDir()],
      deps(),
    );
    expect(out.exitCode).toBe(EXIT.completed);
    expect(scaleCalls()).toHaveLength(2);
    expect(record(out.runDir!).scale).toBe('groupFlag');
  });

  it('a stopped app machine exits 4 and makes no scale call', async () => {
    world.staging.push(appMachine('app2', { state: 'stopped' }));
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.platform);
    expect(scaleCalls()).toEqual([]);
    expect(record(out.runDir!).reason).toMatch(/app2 \(stopped\)/);
  });
});

describe('step 2 — the platform is read before it is touched', () => {
  it('a staging size that differs from production exits 4', async () => {
    world.staging[0]!.guest.memory_mb = 2048;
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.platform);
    expect(record(out.runDir!).reason).toMatch(/size differs/);
    expect(generatorStarts()).toEqual([]);
  });

  it('--candidate-size lets a different size through and is recorded', async () => {
    world.staging[0]!.guest.memory_mb = 2048;
    const out = await runLoadTest([...SMOKE_ARGS, '--candidate-size'], deps());
    expect(out.exitCode).toBe(EXIT.completed);
    expect(record(out.runDir!).candidateSize).toBe(true);
  });

  it('an autostop other than off exits 4', async () => {
    world.staging[0]!.services[0]!.autostop = 'suspend';
    expect((await runLoadTest(SMOKE_ARGS, deps())).exitCode).toBe(EXIT.platform);
    world = newWorld(1);
    world.staging[0]!.services[0]!.autostop = true;
    expect((await runLoadTest(SMOKE_ARGS, deps())).exitCode).toBe(EXIT.platform);
  });

  it('autostop false is off', async () => {
    world.staging[0]!.services[0]!.autostop = false;
    expect((await runLoadTest(SMOKE_ARGS, deps())).exitCode).toBe(EXIT.completed);
  });

  it('a concurrency type other than requests exits 4', async () => {
    world.staging[0]!.services[0]!.concurrency!.type = 'connections';
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.platform);
    expect(record(out.runDir!).reason).toMatch(/must be requests/);
  });

  it('an unset soft_limit or hard_limit exits 4', async () => {
    delete world.staging[0]!.services[0]!.concurrency!.soft_limit;
    expect((await runLoadTest(SMOKE_ARGS, deps())).exitCode).toBe(EXIT.platform);
    world = newWorld(1);
    delete world.staging[0]!.services[0]!.concurrency!.hard_limit;
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.platform);
    expect(record(out.runDir!).reason).toMatch(/hard_limit unset/);
  });

  it('deployed limits below the requirement exit 4', async () => {
    world.staging[0]!.services[0]!.concurrency = {
      type: 'requests',
      soft_limit: 20,
      hard_limit: 25,
    };
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.platform);
    expect(record(out.runDir!).reason).toMatch(/below the required 66\/82/);
  });

  it('min_machines_running changes nothing (autostart false still passes)', async () => {
    world.staging[0]!.services[0]!.min_machines_running = 3;
    world.staging[0]!.services[0]!.autostart = false;
    expect((await runLoadTest(SMOKE_ARGS, deps())).exitCode).toBe(EXIT.completed);
  });
});

describe('step 4 — the generator', () => {
  it('a generator outside iad exits 4 and is never started', async () => {
    world.generator[0]!.region = 'ord';
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.platform);
    expect(generatorStarts()).toEqual([]);
  });

  it('a generator that does not reach started exits 4 — and is still stopped', async () => {
    world.generatorNeverStarts = true;
    const out = await runLoadTest(SMOKE_ARGS, deps({ timeouts: { generatorStartMs: 20_000 } }));
    expect(out.exitCode).toBe(EXIT.platform);
    expect(record(out.runDir!).reason).toMatch(/did not reach started/);
    expect(generatorStops()).toHaveLength(1);
    expect(k6Starts()).toEqual([]);
  });

  it('a k6 version differing from versions.env exits 4 naming provisioning', async () => {
    world.k6Version = K6_OUT.replace('v1.2.1', 'v1.3.0');
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.platform);
    expect(record(out.runDir!).reason).toMatch(/v1\.3\.0.*provisioning/);
    expect(generatorStops()).toHaveLength(1);
  });

  it('a k6 binary without the SSE extension exits 4', async () => {
    world.k6Version = 'k6 v1.2.1 (go1.24.7, linux/amd64)\n';
    expect((await runLoadTest(SMOKE_ARGS, deps())).exitCode).toBe(EXIT.platform);
  });
});

describe('step 5 — read N back', () => {
  it('after scaling, a read-back of N−1 started machines exits 4, no k6, generator stopped', async () => {
    world.stagingAfter = { calls: 1, machines: [appMachine('app1')] };
    // The scale "succeeds" but the platform never shows the second machine.
    const exec: Exec = async (bin, args) =>
      args[0] === 'scale'
        ? (world.calls.push({ bin, args: [...args] }), ok())
        : fakeExec(bin, args);
    const out = await runLoadTest(
      ['--profile', 'smoke', '--instances', '2', '--app', APP, '--baseline', baselineDir()],
      deps({ exec, timeouts: { readBackMs: 30_000 } }),
    );
    expect(out.exitCode).toBe(EXIT.platform);
    expect(record(out.runDir!).reason).toMatch(/read back 1 started app machines.*expected 2/);
    expect(k6Starts()).toEqual([]);
    expect(generatorStops()).toHaveLength(1);
  });

  it('a read-back of N+1 started machines exits 4', async () => {
    world.stagingAfter = { calls: 1, machines: [appMachine('app1'), appMachine('app2')] };
    const out = await runLoadTest(SMOKE_ARGS, deps({ timeouts: { readBackMs: 10_000 } }));
    expect(out.exitCode).toBe(EXIT.platform);
    expect(k6Starts()).toEqual([]);
  });

  it('one machine not answering ready exits 4 with no k6 run', async () => {
    world.pin = (id) =>
      id === 'app1'
        ? { status: 503, body: '{"state":"draining"}' }
        : { status: 503, body: 'no such instance' };
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.platform);
    expect(record(out.runDir!).reason).toMatch(/not ready: app1/);
    expect(k6Starts()).toEqual([]);
  });

  it('a proxy that answers the bogus pin with the app’s payload exits 4', async () => {
    world.pin = () => ({ status: 200, body: '{"state":"ready"}' });
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.platform);
    expect(record(out.runDir!).pin).toMatchObject({
      enforced: false,
      via: 'generator',
      unknownIdAnswer: 'status 200',
    });
  });

  it('a readiness answer that is a redirect exits 4', async () => {
    world.pin = (id) => (id === 'app1' ? { status: 307, body: '' } : { status: 503, body: '' });
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.platform);
    expect(record(out.runDir!).reason).toMatch(/redirect 307/);
  });

  it('every probe leaves from the generator, as an sh -c script', async () => {
    await runLoadTest(SMOKE_ARGS, deps());
    const probes = flyCalls((a) => a.some((x) => x.includes('curl')));
    expect(probes).toHaveLength(2);
    for (const p of probes) {
      expect(p.args.slice(0, 6)).toEqual(['ssh', 'console', '-a', GEN_APP, '--machine', 'gen1']);
      expect(p.args.at(-1)).toMatch(/^sh -c 'curl /);
    }
  });

  it('two images exit 4; --sha mismatch exits 4; a non-SHA tag is unmeasured', async () => {
    const two = newWorld(2);
    two.staging[1]!.tag = 'b'.repeat(40);
    world = two;
    manifestN = 2;
    let out = await runLoadTest(
      ['--profile', 'smoke', '--instances', '2', '--app', APP, '--baseline', baselineDir()],
      deps(),
    );
    expect(record(out.runDir!).reason).toMatch(/2 images/);

    world = newWorld(1);
    out = await runLoadTest([...SMOKE_ARGS, '--sha', 'c'.repeat(40)], deps());
    expect(out.exitCode).toBe(EXIT.platform);

    world = newWorld(1);
    world.staging[0]!.tag = 'deployment-01J';
    out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.completed);
    expect(record(out.runDir!).sha).toBe('unmeasured');
  });
});

describe('step 6 — the preflight', () => {
  for (const code of [2, 4]) {
    it(`a preflight exit of ${code} is propagated and nothing after it runs`, async () => {
      preflightExit = code;
      const out = await runLoadTest(SMOKE_ARGS, deps());
      expect(out.exitCode).toBe(code);
      expect(world.calls.filter((c) => c.bin === 'neonctl')).toEqual([]);
      expect(seedCalls).toEqual([]);
      expect(k6Starts()).toEqual([]);
      expect(generatorStops()).toHaveLength(1);
      expect(readFileSync(join(out.runDir!, 'preflight.txt'), 'utf8')).toMatch(/LIVE/);
    });
  }
});

describe('step 7 — the database that answers', () => {
  it('a pooled in-machine host matching the direct endpoint host passes', async () => {
    expect((await runLoadTest(SMOKE_ARGS, deps())).exitCode).toBe(EXIT.completed);
  });

  it('an in-machine host that differs after normalisation exits 4', async () => {
    world.stagingEnv['DATABASE_URL'] =
      `postgresql://motir_app:${SECRET}@ep-other-9-pooler.us-east-2.aws.neon.tech/motir`;
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.platform);
    expect(record(out.runDir!).reason).toMatch(/ep-other-9\.us-east-2/);
    expect(logs.join('\n')).not.toContain(SECRET);
    expect(seedCalls).toEqual([]);
  });

  it('MOTIR_MCP_RATE_LIMIT below 600 exits 4', async () => {
    world.stagingEnv['MOTIR_MCP_RATE_LIMIT'] = '500';
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.platform);
    expect(record(out.runDir!).rateLimits.mcp).toBe(500);
  });

  it('MOTIR_AGENT_WORKSPACE_RATE_LIMIT below its default exits 4', async () => {
    world.stagingEnv['MOTIR_AGENT_WORKSPACE_RATE_LIMIT'] = '6000';
    expect((await runLoadTest(SMOKE_ARGS, deps())).exitCode).toBe(EXIT.platform);
  });

  it('MOTIR_API_V1_RATE_LIMIT below 1.5 × the per-token rate exits 4', async () => {
    // Smoke's run token offers about 27 requests a minute; 1.5 × that is above 40.
    world.stagingEnv['MOTIR_API_V1_RATE_LIMIT'] = '30';
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.platform);
    expect(record(out.runDir!).reason).toMatch(/MOTIR_API_V1_RATE_LIMIT is 30\/min/);
  });

  it('records the rate limits and the trace rate as read', async () => {
    world.stagingEnv['MOTIR_API_V1_RATE_LIMIT'] = '6000';
    world.stagingEnv['SENTRY_TRACES_SAMPLE_RATE'] = '0.05';
    const r = record((await runLoadTest(SMOKE_ARGS, deps())).runDir!);
    expect(r.rateLimits).toEqual({ apiV1: 6000, mcp: 'default', agentWorkspace: 'default' });
    expect(r.traceRate).toBe(0.05);
  });

  it('names the copied-from field: refresh.json first', async () => {
    mkdirSync(join(cwd, 'loadtest/.out'), { recursive: true });
    writeFileSync(
      join(cwd, 'loadtest/.out/refresh.json'),
      JSON.stringify({ refreshedAt: '2026-10-15T18:00:00Z' }),
    );
    const r = record((await runLoadTest(SMOKE_ARGS, deps())).runDir!);
    expect(r.neon).toMatchObject({
      copiedAt: '2026-10-15T18:00:00Z',
      copiedAtField: 'refresh.json',
    });
  });

  it('copiedFrom: refresh.json, then the reset field, then parent_timestamp, then created_at', () => {
    const branch = {
      id: 'br',
      last_reset_at: '2026-10-13T00:00:00Z',
      parent_timestamp: '2026-10-12T00:00:00Z',
      created_at: '2026-10-01T00:00:00Z',
    };
    expect(copiedFrom({ refreshedAt: '2026-10-14T00:00:00Z' }, branch).copiedAtField).toBe(
      'refresh.json',
    );
    expect(copiedFrom(null, { branch })).toMatchObject({
      copiedAtField: 'last_reset_at',
      copiedAt: '2026-10-13T00:00:00Z',
    });
    const { last_reset_at: _r, ...noReset } = branch;
    expect(copiedFrom(null, noReset).copiedAtField).toBe('parent_timestamp');
    const { parent_timestamp: _p, ...noParent } = noReset;
    expect(copiedFrom(null, noParent).copiedAtField).toBe('created_at');
    expect(() => copiedFrom(null, { id: 'br' })).toThrow(/none of the copied-from times/);
  });
});

describe('step 8 — the seed', () => {
  it('a manifest short of a role exits 2 naming the role', async () => {
    const short = manifestFor(1);
    short.agents = short.agents.filter((a) => a.role !== 'claim');
    const out = await runLoadTest(SMOKE_ARGS, deps({ readManifest: async () => short }));
    expect(out.exitCode).toBe(EXIT.refused);
    expect(record(out.runDir!).reason).toMatch(/short of claim agents: 0 seeded, 5 VUs/);
    expect(k6Starts()).toEqual([]);
  });

  it('a manifest seeded into another database exits 2', async () => {
    const other = { ...manifestFor(1), databaseHost: 'ep-other.us-east-2.aws.neon.tech' };
    expect(
      (await runLoadTest(SMOKE_ARGS, deps({ readManifest: async () => other }))).exitCode,
    ).toBe(EXIT.refused);
  });

  it('a failed seed exits 2', async () => {
    expect((await runLoadTest(SMOKE_ARGS, deps({ seed: async () => 2 }))).exitCode).toBe(
      EXIT.refused,
    );
  });
});

describe('step 9 — k6', () => {
  it('an upload failure exits 5, deletes the manifest and stops the generator', async () => {
    world.failPut = true;
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.k6);
    expect(record(out.runDir!).reason).toMatch(/k6 could not be started/);
    expect(generatorStops()).toHaveLength(1);
  });

  it('a k6 failure exits 5 and the manifest is still deleted', async () => {
    world.k6Exit = 107;
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.k6);
    expect(manifestDeletes()).toHaveLength(1);
    expect(record(out.runDir!).manifestDeleted).toBe(true);
    expect(generatorStops()).toHaveLength(1);
  });
});

describe('step 10 — the instance count held', () => {
  it('a changed app machine set exits 4 with instancesHeld false; run.json exists and the report runs on it', async () => {
    let lists = 0;
    const exec: Exec = async (bin, args) => {
      const r = await fakeExec(bin, args);
      if (args[0] === 'machine' && args[1] === 'list' && args.includes(APP)) {
        lists += 1;
        if (lists >= 3) return ok(JSON.stringify([toJson(appMachine('app9'))]));
      }
      return r;
    };
    const out = await runLoadTest(SMOKE_ARGS, deps({ exec }));
    expect(out.exitCode).toBe(EXIT.platform);
    const r = record(out.runDir!);
    expect(r).toMatchObject({
      instancesHeld: false,
      instancesChanged: ['app1', 'app9'],
      exitCode: 4,
    });
    expect(r.reason).toMatch(/changed during the run/);
    expect(reports).toEqual([out.runDir]);
    expect(out.reportExitCode).toBe(6);
  });
});

describe('the contract with its neighbours', () => {
  it('the production rate defaults are the app’s own', () => {
    expect(PRODUCTION_RATE_DEFAULTS).toEqual({
      MOTIR_API_V1_RATE_LIMIT: DEFAULT_RATE_LIMIT,
      MOTIR_MCP_RATE_LIMIT: DEFAULT_MCP_RATE_LIMIT,
      MOTIR_AGENT_WORKSPACE_RATE_LIMIT: DEFAULT_AGENT_WORKSPACE_RATE_LIMIT,
    });
  });

  it('OPTIONS names every flag, env var and exit code', () => {
    expect(Object.values(OPTIONS.flags).map((f) => f.flag)).toEqual([
      '--profile',
      '--instances',
      '--app',
      '--baseline',
      '--candidate-size',
      '--sha',
      '--tag',
    ]);
    expect(OPTIONS.requiredEnv).toContain('FLY_API_TOKEN');
    expect(Object.keys(OPTIONS.exits)).toEqual(['0', '2', '4', '5']);
  });

  it('parseMachines reads the documented machine fields and defaults', () => {
    const [m] = parseMachines(
      JSON.stringify([
        {
          id: 'x',
          state: 'started',
          region: 'iad',
          image_ref: { registry: 'registry.fly.io', repository: 'motir-core', tag: SHA },
          config: {
            guest: GUEST,
            metadata: { fly_process_group: 'app' },
            services: [{ internal_port: 3000 }],
          },
        },
      ]),
    );
    expect(m).toMatchObject({
      imageRef: `registry.fly.io/motir-core:${SHA}`,
      services: [
        {
          autostop: 'off',
          autostart: false,
          concurrency: { type: 'connections', softLimit: null, hardLimit: null },
        },
      ],
    });
  });

  it('the run command is a package script', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['loadtest:run']).toBe(
      'tsx --tsconfig tsconfig.node.json loadtest/run/run.ts',
    );
  });
});

describe('the run-window capture (MOTIR-8683)', () => {
  const CAPTURED = [
    'app-logs.ndjson',
    'app-logs.gaps.json',
    'db-samples.csv',
    'neon-endpoint-start.json',
    'neon-endpoint-end.json',
    'pgss-before.json',
    'pgss-after.json',
    'k6-points.json.gz',
  ];

  it('a completed run directory holds every recording', async () => {
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.completed);
    for (const f of CAPTURED) expect(existsSync(join(out.runDir!, f)), f).toBe(true);
    expect(record(out.runDir!).capture).toMatchObject({ logLines: 1, logInstances: ['app1'] });
  });

  it('runs k6 with --out json= to a .gz on the volume, fetches it and deletes it', async () => {
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(readFileSync(join(out.runDir!, 'run.sh'), 'utf8')).toMatch(
      /--out json=\/data\/run\/k6-points\.json\.gz/,
    );
    expect(
      flyCalls((a) => a[2] === 'get' && a.at(-2) === '/data/run/k6-points.json.gz'),
    ).toHaveLength(1);
    expect(
      flyCalls((a) => a.some((x) => x.includes('rm -f /data/run/k6-points.json.gz'))),
    ).toHaveLength(1);
  });

  it('on a k6 failure the point file is still fetched and deleted', async () => {
    world.k6Exit = 107;
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.k6);
    expect(
      flyCalls((a) => a[2] === 'get' && a.at(-2) === '/data/run/k6-points.json.gz'),
    ).toHaveLength(1);
    expect(
      flyCalls((a) => a.some((x) => x.includes('rm -f /data/run/k6-points.json.gz'))),
    ).toHaveLength(1);
    expect(existsSync(join(out.runDir!, 'pgss-after.json'))).toBe(true);
  });

  it('a generator with no /data volume exits 4', async () => {
    world.noVolume = true;
    const out = await runLoadTest(SMOKE_ARGS, deps());
    expect(out.exitCode).toBe(EXIT.platform);
    expect(record(out.runDir!).reason).toMatch(/no volume mounted at \/data/);
    expect(generatorStops()).toHaveLength(1);
  });

  it('a failing recorder leaves its state file and the run still completes', async () => {
    const out = await runLoadTest(
      SMOKE_ARGS,
      deps({
        capture: {
          ...CAPTURE_STUBS,
          readTopStatements: async () => {
            throw new Error('permission denied for pg_stat_statements');
          },
          dbClient: () => ({
            connect: async () => {
              throw new Error('connection refused');
            },
            query: async () => ({ rows: [] }),
            end: async () => undefined,
          }),
        },
      }),
    );
    expect(out.exitCode).toBe(EXIT.completed);
    for (const f of ['pgss-before.state.json', 'pgss-after.state.json', 'db-samples.state.json']) {
      expect(existsSync(join(out.runDir!, f)), f).toBe(true);
    }
    expect(record(out.runDir!).exitCode).toBe(0);
  });

  it('without LOADTEST_NEON_API_KEY both endpoint files say unmeasured', async () => {
    const out = await runLoadTest(SMOKE_ARGS, deps());
    for (const f of ['neon-endpoint-start.json', 'neon-endpoint-end.json']) {
      expect(JSON.parse(readFileSync(join(out.runDir!, f), 'utf8')).state).toBe('unmeasured');
    }
  });

  it('with a key, the endpoint read goes to LOADTEST_NEON_API_URL', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ endpoints: [{ id: 'ep', current_state: 'active' }] }));
    }) as unknown as typeof fetch;
    const out = await runLoadTest(
      SMOKE_ARGS,
      deps({
        env: {
          ...ENV,
          LOADTEST_NEON_API_KEY: 'neon-key-value',
          LOADTEST_NEON_API_URL: 'http://neon-stub.local/v2',
        },
        capture: { ...CAPTURE_STUBS, fetchImpl },
      }),
    );
    expect(urls).toEqual([
      'http://neon-stub.local/v2/projects/proj-1/branches/br-loadtest-1/endpoints',
      'http://neon-stub.local/v2/projects/proj-1/branches/br-loadtest-1/endpoints',
    ]);
    expect(
      JSON.parse(readFileSync(join(out.runDir!, 'neon-endpoint-end.json'), 'utf8')).state,
    ).toBe('ok');
    expect(logs.join('\n')).not.toContain('neon-key-value');
  });

  it('the direct URL resolved for the capture never reaches any output', async () => {
    const out = await runLoadTest(SMOKE_ARGS, deps());
    const runDir = out.runDir!;
    for (const f of readdirSync(runDir)) {
      if (f.endsWith('.gz')) continue;
      expect(readFileSync(join(runDir, f), 'utf8'), f).not.toContain(SECRET);
    }
    expect(logs.join('\n')).not.toContain(SECRET);
  });
});
