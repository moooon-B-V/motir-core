import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadHash } from '@/loadtest/profiles/resolve';
import type { LoadProfile } from '@/loadtest/profiles/schema';
import type { SeedManifest } from '@/loadtest/seed/manifest';
import { type CommandResult, type Exec } from '@/loadtest/run/fly';
import { templateSetNames } from '@/loadtest/staging/sideEffectSwitches';
import { type RunDeps } from '@/loadtest/run/run';
import type { RunRecord } from '@/loadtest/run/runRecord';

// THE FAKE PLATFORM the run command is tested against (Story MOTIR-8538 · MOTIR-8678,
// shared with the story gate, MOTIR-8681): `fly` and
// `neonctl` are answered from an in-memory model of the staging app, production,
// the generator and the Neon branch, so every refusal can be produced on purpose
// and every call the command makes is recorded.
//
// ⚠️ The machine and branch JSON is built from the documented shapes (Fly Machines
// API machine config; the Neon API branch object). No flyctl or neonctl was
// reachable where this was written; the first real run compares one response of
// each against these fixtures.

export const ROOT = resolve(__dirname, '../..');
export const APP = 'motir-core-staging';
export const GEN_APP = 'motir-loadgen';
export const BASE_URL = 'http://motir-core-staging.flycast';
export const DIRECT = 'ep-quiet-sky-123456.us-east-2.aws.neon.tech';
export const POOLED = 'ep-quiet-sky-123456-pooler.us-east-2.aws.neon.tech';
export const SECRET = 'npg_s3cretPassw0rd';
export const SHA = 'a'.repeat(40);
export const K6_OUT =
  'k6 v1.2.1 (go1.24.7, linux/amd64)\nExtensions:\n  github.com/phymbert/xk6-sse v0.1.12, k6/x/sse [js]\n';

export interface FakeService {
  internal_port: number;
  autostop?: unknown;
  autostart?: boolean;
  min_machines_running?: number;
  concurrency?: { type?: string; soft_limit?: number; hard_limit?: number };
}

export interface FakeMachine {
  id: string;
  state: string;
  region: string;
  group: string;
  guest: { cpu_kind: string; cpus: number; memory_mb: number };
  tag: string;
  services: FakeService[];
}

export const SERVICE: FakeService = {
  internal_port: 3000,
  autostop: 'off',
  autostart: false,
  concurrency: { type: 'requests', soft_limit: 100, hard_limit: 120 },
};
export const GUEST = { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 };

export const appMachine = (id: string, over: Partial<FakeMachine> = {}): FakeMachine => ({
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
export function toJson(m: FakeMachine) {
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

export interface World {
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
  /**
   * What a bare `printenv` (the side-effect preflight's read) answers on a staging
   * machine, by id; `'fail'` makes that ssh fail. Unlisted machines answer
   * {@link sinkEnv}.
   */
  machineEnv: Record<string, Record<string, string> | 'fail'>;
}

/** A staging machine environment holding every sink state the switch table asks for. */
export function sinkEnv(): Record<string, string> {
  return {
    EMAIL_PROVIDER: 'console',
    SENTRY_DSN: 'https://k@o9.ingest.sentry.io/7777',
    SENTRY_ENVIRONMENT: 'staging',
    DATABASE_URL: `postgresql://motir_app:${SECRET}@${POOLED}/motir?sslmode=require`,
    DATABASE_URL_UNPOOLED: `postgresql://neondb_owner:${SECRET}@${DIRECT}/motir?sslmode=require`,
    BETTER_AUTH_SECRET: 'auth-secret-value',
    GOOGLE_CLIENT_ID: 'placeholder',
    GOOGLE_CLIENT_SECRET: 'placeholder',
    MOTIR_BASE_URL: BASE_URL,
    MOTIR_API_V1_RATE_LIMIT: '6000',
    SENTRY_TRACES_SAMPLE_RATE: '0.1',
    NODE_ENV: 'production',
  };
}

export function newWorld(n = 1): World {
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
    machineEnv: {},
  };
}

/** The fake's mutable state: one object, so every importer sees the same world. */
export const fake = {
  world: undefined as unknown as World,
  cwd: '',
  logs: [] as string[],
  reports: [] as string[],
  clock: 0,
  preflightExit: 0,
  manifestN: 1,
  seedCalls: [] as string[][],
  /** What `fly ssh sftp get` writes, by the remote path's suffix (else a placeholder). */
  downloads: {} as Record<string, string | Buffer>,
};

export const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
export const fail = (code = 1): CommandResult => ({ code, stdout: '', stderr: 'refused' });

export const fakeExec: Exec = async (bin, args) => {
  const a = [...args];
  fake.world.calls.push({ bin, args: a });
  if (bin === 'neonctl') {
    if (a[0] === 'branches') return ok(JSON.stringify({ branch: fake.world.branch }));
    if (a[0] === 'connection-string') return ok(`${fake.world.branchUrl}\n`);
    return fail();
  }
  if (bin !== 'fly') return fail(127);
  const app = a[a.indexOf('-a') + 1];
  if (a[0] === 'machine' && a[1] === 'list') {
    if (app === APP) {
      fake.world.stagingLists += 1;
      if (fake.world.stagingAfter && fake.world.stagingLists > fake.world.stagingAfter.calls) {
        fake.world.staging = fake.world.stagingAfter.machines;
      }
      return ok(JSON.stringify(fake.world.staging.map(toJson)));
    }
    if (app === 'motir-core') return ok(JSON.stringify(fake.world.production.map(toJson)));
    if (app === GEN_APP) return ok(JSON.stringify(fake.world.generator.map(toJson)));
    return fail();
  }
  if (a[0] === 'scale') {
    if (a[2]!.startsWith('app=') && fake.world.scaleRefusesEquals) return fail();
    const target = a[2]!.startsWith('app=') ? Number(a[2]!.slice(4)) : Number(a[2]);
    // Only the app group scales; a worker machine stays as it is.
    const others = fake.world.staging.filter((m) => m.group !== 'app');
    let group = fake.world.staging.filter((m) => m.group === 'app');
    while (group.length < target) group.push(appMachine(`app${group.length + 1}`));
    group = group.slice(0, target);
    fake.world.staging = [...group, ...others];
    return ok();
  }
  if (a[0] === 'machine' && (a[1] === 'start' || a[1] === 'stop')) {
    const m = fake.world.generator.find((g) => g.id === a[2]);
    if (!m) return fail();
    if (a[1] === 'stop' || !fake.world.generatorNeverStarts)
      m.state = a[1] === 'start' ? 'started' : 'stopped';
    return ok();
  }
  if (a[0] === 'ssh' && a[1] === 'sftp') {
    if (a[2] === 'put') return fake.world.failPut ? fail() : ok();
    if (a[2] === 'get') {
      const remote = a.at(-2)!;
      const local = a.at(-1)!;
      const canned = Object.entries(fake.downloads).find(([suffix]) => remote.endsWith(suffix));
      writeFileSync(
        local,
        canned ? canned[1] : remote.endsWith('summary.json') ? '{"metrics":{}}' : 'x\n',
      );
      return ok();
    }
  }
  if (a[0] === 'secrets' && a[1] === 'list' && app === APP)
    return ok(JSON.stringify(templateSetNames().map((Name) => ({ Name, Digest: 'd' }))));
  if (a[0] === 'ssh' && a[1] === 'console') {
    const cmd = a[a.indexOf('-C') + 1]!;
    if (app === APP && cmd === 'printenv') {
      const env = fake.world.machineEnv[a[a.indexOf('--machine') + 1]!] ?? sinkEnv();
      if (env === 'fail') return { code: 1, stdout: '', stderr: 'ssh: connection refused' };
      return ok(
        Object.entries(env)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n'),
      );
    }
    if (app === APP) {
      const name = /^printenv ([A-Z_0-9]+)$/.exec(cmd)?.[1];
      if (!name) return fail(2);
      const v = fake.world.stagingEnv[name];
      return v === undefined ? { code: 1, stdout: '', stderr: '' } : ok(`${v}\n`);
    }
    if (cmd.endsWith(' version')) return ok(fake.world.k6Version);
    if (cmd.includes('curl')) {
      const pinned = /fly-force-instance-id: ([^"]+)"/.exec(cmd)![1]!;
      const ans = fake.world.pin(pinned);
      return ok(`${ans.body}\n${ans.status}`);
    }
    if (cmd.includes('@@exit'))
      return ok(`running (01m00.0s), 40/40 VUs\n@@exit ${fake.world.k6Exit}\n`);
    if (cmd.startsWith('cat ') && cmd.endsWith('started.at')) return ok('2026-10-15T20:00:00Z\n');
    if (cmd.startsWith('cat ') && cmd.endsWith('ended.at')) return ok('2026-10-15T20:04:20Z\n');
    if (cmd.includes('/proc/mounts')) return fake.world.noVolume ? fail() : ok();
    if (cmd.startsWith('sh -c ')) return ok();
    return fail();
  }
  return fail();
};

/** A manifest that covers the smoke profile's VUs at N. */
export function manifestFor(n: number): SeedManifest {
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

export const ENV = {
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

/** Stand-ins for the run-window recorders' I/O, so no real `fly fake.logs` or Postgres is touched. */
export const CAPTURE_STUBS: NonNullable<RunDeps['capture']> = {
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

export function deps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    exec: fakeExec,
    env: ENV,
    cwd: fake.cwd,
    now: () => new Date(fake.clock),
    sleep: async (ms) => {
      fake.clock += ms;
    },
    log: (line) => fake.logs.push(line),
    preflight: async () => ({
      exitCode: fake.preflightExit,
      text: fake.preflightExit ? 'LIVE row' : 'PASS all',
    }),
    seed: async (command, args) => {
      fake.seedCalls.push([command, ...args]);
      return 0;
    },
    readManifest: async () => manifestFor(fake.manifestN),
    report: async (dir) => {
      fake.reports.push(dir);
      return 6;
    },
    capture: CAPTURE_STUBS,
    ...over,
  };
}

export const SMOKE_ARGS = ['--profile', 'smoke', '--instances', '1', '--app', APP];
export const flyCalls = (pred: (a: string[]) => boolean) =>
  fake.world.calls.filter((c) => c.bin === 'fly' && pred(c.args));
export const scaleCalls = () => flyCalls((a) => a[0] === 'scale');
export const generatorStarts = () => flyCalls((a) => a[0] === 'machine' && a[1] === 'start');
export const generatorStops = () => flyCalls((a) => a[0] === 'machine' && a[1] === 'stop');
export const k6Starts = () => flyCalls((a) => a.some((x) => x.includes('setsid nohup')));
export const manifestDeletes = () =>
  flyCalls((a) => a.some((x) => x.includes('rm -f /dev/shm/loadtest/manifest.json')));
export const record = (dir: string) =>
  JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as RunRecord;

/** A fresh fake platform and a fresh operator checkout, for each test. */
export function resetFake(): void {
  fake.world = newWorld(1);
  fake.cwd = mkdtempSync(join(tmpdir(), 'loadtest-run-'));
  mkdirSync(join(fake.cwd, 'loadtest/k6'), { recursive: true });
  mkdirSync(join(fake.cwd, 'loadtest/profiles'), { recursive: true });
  for (const f of [
    'loadtest/k6/versions.env',
    'loadtest/profiles/smoke.json',
    'loadtest/profiles/default.json',
  ]) {
    writeFileSync(join(fake.cwd, f), readFileSync(join(ROOT, f)));
  }
  writeFileSync(join(fake.cwd, 'package.json'), '{"scripts":{}}');
  fake.logs = [];
  fake.reports = [];
  fake.clock = Date.parse('2026-10-15T19:00:00Z');
  fake.preflightExit = 0;
  fake.manifestN = 1;
  fake.seedCalls = [];
  fake.downloads = {};
}

/** A baseline run directory at 1 instance for the smoke profile. */
export function baselineDir(): string {
  const dir = join(fake.cwd, 'base');
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
