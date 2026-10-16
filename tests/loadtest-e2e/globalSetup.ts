import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { TestProject } from 'vitest/node';
import { startInstances, type Instance } from '../two-instance/harness';
import { startProxy } from './fakePlatform/proxy';
import { startStub } from './fakePlatform/prometheus';
import {
  APPS,
  K6_BINARY,
  LANE_LIMITS,
  MACHINES,
  NEON,
  PRODUCTION_DB_HOST,
  PRODUCTION_SENTRY_PROJECT_ID,
  SETTLE_SECONDS,
  type LaneContext,
} from './lane';

// THE LOADTEST END-TO-END LANE'S SETUP (Story MOTIR-8538 · MOTIR-8682).
//
// Once per lane run:
//   1. refuses to start without a production build, a database and the pinned k6
//      binary — each refusal naming the command that produces the missing thing;
//   2. starts the stub Prometheus + Neon API and the fake Fly proxy (whose origin is
//      the run's base URL, so it must exist before the app does);
//   3. starts TWO `next start` instances through tests/two-instance/harness.ts — one
//      per fake `app` machine; at N = 1 the proxy routes to the first only;
//   4. writes the fake platform's state (machines, the fixture environment, the
//      secret names, the Neon branch) and a temporary WORKING COPY of the checkout
//      (symlinks, with its own `loadtest/.out` and `loadtest/reports`), so a run
//      writes its run directory, manifest and published report there and never
//      into the checkout;
//   5. tees each instance's stdout to an ndjson file in `fly logs --json`'s shape,
//      which the fake `fly logs` replays.
//
// ⚠️ THE INSTANCE ENV IS BUILT FROM `process.env`, NOT FROM
// tests/two-instance/globalSetup.ts `appEnv()`. That function is for the
// two-instance lane: it sets MOTIR_MCP_RATE_LIMIT=6 and MOTIR_API_V1_RATE_LIMIT=5,
// so a handful of calls exhausts them, which would turn this lane's hundreds of
// agent calls into a wall of refusals. Its PIECES are copied (NODE_ENV,
// E2E_PROD_HARNESS, the `file` email sink, deleting the variables that would make
// the limiter per-process or off) and the limits are RAISED (`LANE_LIMITS`). A
// case reads the running processes' own environment back and asserts it.

declare module 'vitest' {
  export interface ProvidedContext {
    loadtestE2e: LaneContext;
  }
}

const ROOT = resolve(__dirname, '../..');

/** Why the lane cannot start, each naming the command that fixes it; empty when it can. */
export function missingPrerequisites(root: string, env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = [];
  if (!existsSync(join(root, '.next/BUILD_ID'))) {
    missing.push(
      "no production build (.next/BUILD_ID): run `pnpm build` (CI downloads the `build` job's `next-build` artifact)",
    );
  }
  if (!env['DATABASE_URL']?.trim()) {
    missing.push(
      'DATABASE_URL is not set: point it at a migrated Postgres (`pnpm prisma migrate deploy`)',
    );
  }
  if (!existsSync(join(root, K6_BINARY))) {
    missing.push(
      `no pinned k6 binary (${K6_BINARY}): run \`loadtest/k6/build.sh\` (Docker, or Go plus xk6)`,
    );
  }
  return missing;
}

/** The env both instances start with: `process.env`, the harness flags, and limits the tiny profile cannot reach. */
export function laneInstanceEnv(opts: {
  baseUrl: string;
  authSecret: string;
  outbox: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    // The production build's test seams — `Secure` off over plain http, the `file`
    // email sink. It changes the cookie's ATTRIBUTE, never its name.
    E2E_PROD_HARNESS: '1',
    EMAIL_PROVIDER: 'file',
    EMAIL_OUTBOX_PATH: opts.outbox,
    GOOGLE_CLIENT_ID: process.env['GOOGLE_CLIENT_ID'] ?? 'loadtest-e2e-placeholder',
    GOOGLE_CLIENT_SECRET: process.env['GOOGLE_CLIENT_SECRET'] ?? 'loadtest-e2e-placeholder',
    // ONE secret, shared with the seed, so the cookies it mints verify here.
    BETTER_AUTH_SECRET: opts.authSecret,
    // The proxy's http:// origin — what decides the session cookie's NAME.
    MOTIR_BASE_URL: opts.baseUrl,
    ...Object.fromEntries(Object.entries(LANE_LIMITS).map(([k, v]) => [k, String(v)])),
  };
  delete env['E2E_DISABLE_RATE_LIMIT'];
  delete env['MOTIR_RATE_LIMIT_STORE'];
  delete env['PORT'];
  return env;
}

function gitSha(root: string): string {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  } catch {
    /* no git: a fixed SHA below */
  }
  return 'e'.repeat(40);
}

/** A working copy of the checkout made of symlinks, with its own `loadtest/.out` and `loadtest/reports`. */
function workingCopy(root: string, into: string): string {
  mkdirSync(join(into, 'loadtest', '.out'), { recursive: true });
  mkdirSync(join(into, 'loadtest', 'reports'), { recursive: true });
  for (const entry of readdirSync(root)) {
    if (entry === 'loadtest') continue;
    symlinkSync(join(root, entry), join(into, entry));
  }
  for (const entry of readdirSync(join(root, 'loadtest'))) {
    if (entry === '.out' || entry === 'reports') continue;
    symlinkSync(join(root, 'loadtest', entry), join(into, 'loadtest', entry));
  }
  return into;
}

/** The `fly secrets list` names: exactly the generated staging.secrets.example SET block. */
function templateSecretNames(root: string): string[] {
  const text = readFileSync(join(root, 'loadtest/staging/staging.secrets.example'), 'utf8');
  return text
    .split('\n')
    .map((l) => /^([A-Z_][A-Z0-9_]*)=/.exec(l)?.[1])
    .filter((n): n is string => Boolean(n));
}

/** Tee one instance's output to `fly logs --json` lines (timestamp, message, level, instance, region, meta). */
function teeLogs(instance: Instance, machineId: string, file: string): void {
  const out = createWriteStream(file, { flags: 'a' });
  for (const stream of [instance.child.stdout, instance.child.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream }).on('line', (message) => {
      if (!message.trim()) return;
      out.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          message,
          level: stream === instance.child.stderr ? 'error' : 'info',
          instance: machineId,
          region: 'iad',
          meta: {
            instance: machineId,
            region: 'iad',
            event: { provider: 'app' },
            http: null,
            error: null,
          },
        })}\n`,
      );
    });
  }
}

const service = {
  protocol: 'tcp',
  internal_port: 3000,
  autostop: 'off',
  autostart: false,
  min_machines_running: 0,
  ports: [{ port: 80, handlers: ['http'] }],
  concurrency: { type: 'requests', soft_limit: 1000, hard_limit: 1200 },
};
const appGuest = { cpu_kind: 'performance', cpus: 2, memory_mb: 4096 };

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const missing = missingPrerequisites(ROOT, process.env);
  if (missing.length > 0) {
    throw new Error(
      `The loadtest end-to-end lane cannot start:\n${missing.map((m) => `  · ${m}`).join('\n')}`,
    );
  }
  const databaseUrl = process.env['DATABASE_URL']!.trim();
  const tmp = mkdtempSync(join(tmpdir(), 'loadtest-e2e-'));
  const stateDir = join(tmp, 'platform');
  const generatorRoot = join(tmp, 'generator');
  const logsDir = join(tmp, 'logs');
  for (const d of [
    stateDir,
    logsDir,
    join(generatorRoot, 'opt/loadtest'),
    join(generatorRoot, 'data'),
    join(generatorRoot, 'dev/shm'),
    join(generatorRoot, 'proc'),
    join(generatorRoot, 'root'),
    join(generatorRoot, 'tmp'),
  ])
    mkdirSync(d, { recursive: true });
  // The baked binary, and the volume the generator step's check looks for.
  execFileSync('cp', [join(ROOT, K6_BINARY), join(generatorRoot, 'opt/loadtest/k6')]);
  writeFileSync(
    join(generatorRoot, 'proc/mounts'),
    `overlay / overlay rw,relatime 0 0\n/dev/vdc ${generatorRoot}/data ext4 rw,relatime 0 0\ntmpfs ${generatorRoot}/dev/shm tmpfs rw,nosuid,nodev 0 0\n`,
  );
  const copy = workingCopy(ROOT, join(tmp, 'checkout'));

  const secrets = {
    authSecret: `loadtest-e2e-auth-${randomBytes(16).toString('hex')}`,
    flyApiToken: `fm2_e2eFakeFlyToken${randomBytes(8).toString('hex')}`,
    promToken: `e2e-prom-token-${randomBytes(8).toString('hex')}`,
    neonApiKey: `napi_e2e${randomBytes(16).toString('hex')}`,
  };
  const sha = gitSha(ROOT);
  const statePath = join(stateDir, 'state.json');

  const proxy = await startProxy({ statePath, pinsLog: join(stateDir, 'pins.ndjson') });
  const stub = await startStub({
    statePath,
    requestsLog: join(stateDir, 'requests.ndjson'),
    promToken: secrets.promToken,
    neonKey: secrets.neonApiKey,
    neon: {
      projectId: NEON.projectId,
      branchId: NEON.branchId,
      endpointId: NEON.endpointId,
      roleName: NEON.roleName,
    },
    counts: proxy.counts,
  });

  const now = new Date().toISOString();
  const machine = (
    id: string,
    over: Partial<Record<string, unknown>> & {
      group: string | null;
      repository: string;
      tag: string;
    },
  ) => ({
    id,
    name: `${over.group ?? 'gen'}-${id.slice(-4)}`,
    state: 'started',
    region: 'iad',
    privateIp: `fdaa:0:e2e::${id.slice(-2)}`,
    digest: id.padEnd(64, '0'),
    guest: appGuest,
    services: [service],
    createdAt: '2026-10-14T03:00:00Z',
    updatedAt: now,
    ...over,
  });
  const machineEnv = {
    EMAIL_PROVIDER: 'console',
    SENTRY_DSN: 'https://e2epublickey@o1.ingest.sentry.io/4500000000000002',
    SENTRY_ENVIRONMENT: 'staging',
    SENTRY_TRACES_SAMPLE_RATE: '0.1',
    DATABASE_URL: databaseUrl,
    DATABASE_URL_UNPOOLED: databaseUrl,
    BETTER_AUTH_SECRET: secrets.authSecret,
    GOOGLE_CLIENT_ID: 'loadtest-e2e-placeholder',
    GOOGLE_CLIENT_SECRET: 'loadtest-e2e-placeholder',
    MOTIR_BASE_URL: proxy.origin,
    ...Object.fromEntries(Object.entries(LANE_LIMITS).map(([k, v]) => [k, String(v)])),
    NODE_ENV: 'production',
    PRIMARY_REGION: 'iad',
    FLY_REGION: 'iad',
    PORT: '3000',
    HOME: '/root',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  };
  const logFiles = {
    [MACHINES.app[0]]: join(logsDir, `${MACHINES.app[0]}.ndjson`),
    [MACHINES.app[1]]: join(logsDir, `${MACHINES.app[1]}.ndjson`),
  };
  for (const f of Object.values(logFiles)) writeFileSync(f, '');
  const state = {
    stagingApp: APPS.staging,
    productionApp: APPS.production,
    generatorApp: APPS.generator,
    generatorRoot,
    origins: {} as Record<string, string>,
    logFiles,
    machineEnv,
    secretNames: templateSecretNames(ROOT),
    apps: {
      [APPS.staging]: {
        machines: [
          machine(MACHINES.app[0], { group: 'app', repository: APPS.staging, tag: sha }),
          // Not yet a machine: `fly scale count app=2` creates it, started.
          machine(MACHINES.app[1], {
            group: 'app',
            repository: APPS.staging,
            tag: sha,
            exists: false,
          }),
          machine(MACHINES.worker, {
            group: 'worker',
            repository: APPS.staging,
            tag: sha,
            services: [],
            guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 1024 },
          }),
        ],
      },
      // Production: a READ-ONLY fixture (its size is the one staging must match).
      [APPS.production]: {
        machines: MACHINES.production.map((id) =>
          machine(id, { group: 'app', repository: APPS.production, tag: 'f'.repeat(40) }),
        ),
      },
      [APPS.generator]: {
        machines: [
          machine(MACHINES.generator, {
            group: null,
            repository: APPS.generator,
            tag: 'k6-v1.2.1-xk6-sse-v0.1.12',
            state: 'stopped',
            services: [],
            guest: { cpu_kind: 'performance', cpus: 4, memory_mb: 8192 },
          }),
        ],
      },
    },
    neon: {
      projectId: NEON.projectId,
      roleName: NEON.roleName,
      connectionString: databaseUrl,
      branch: {
        id: NEON.branchId,
        project_id: NEON.projectId,
        parent_id: 'br-e2e-production-000001',
        parent_lsn: '0/1F2E3D40',
        parent_timestamp: NEON.parentTimestamp,
        name: NEON.branchName,
        current_state: 'ready',
        state_changed_at: '2026-10-14T03:00:05Z',
        default: false,
        protected: false,
        primary: false,
        cpu_used_sec: 0,
        compute_time_seconds: 0,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-14T03:00:05Z',
        endpoints: [
          {
            id: NEON.endpointId,
            type: 'read_write',
            current_state: 'active',
            autoscaling_limit_min_cu: 0.25,
            autoscaling_limit_max_cu: 2,
          },
        ],
      },
    },
  };
  const writeState = () => writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  writeState();
  writeFileSync(join(stateDir, 'calls.ndjson'), '');
  writeFileSync(join(stateDir, 'requests.ndjson'), '');
  writeFileSync(join(stateDir, 'pins.ndjson'), '');

  const instanceEnv = laneInstanceEnv({
    baseUrl: proxy.origin,
    authSecret: secrets.authSecret,
    outbox: join(tmp, 'emails.jsonl'),
  });
  let pair: Awaited<ReturnType<typeof startInstances>>;
  try {
    pair = await startInstances({
      command: [
        process.execPath,
        'node_modules/next/dist/bin/next',
        'start',
        '-p',
        '{port}',
        '-H',
        '127.0.0.1',
      ],
      env: instanceEnv,
      readyPath: '/api/health/ready',
      readyTimeoutMs: 180_000,
      announcePattern: /Local:\s+http:\/\/[^\s:]+:(\d+)/,
    });
  } catch (err) {
    await proxy.close();
    await stub.close();
    throw err;
  }
  state.origins = { [MACHINES.app[0]]: pair.A.origin, [MACHINES.app[1]]: pair.B.origin };
  writeState();
  teeLogs(pair.A, MACHINES.app[0], logFiles[MACHINES.app[0]]!);
  teeLogs(pair.B, MACHINES.app[1], logFiles[MACHINES.app[1]]!);

  const fakeBin = join(__dirname, 'fakePlatform');
  const commandEnv: Record<string, string> = {
    ...(Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === 'string'),
    ) as Record<string, string>),
    PATH: `${fakeBin}:${process.env['PATH'] ?? ''}`,
    FAKE_PLATFORM_STATE: stateDir,
    NODE_ENV: 'production',
    BETTER_AUTH_SECRET: secrets.authSecret,
    GOOGLE_CLIENT_ID: instanceEnv['GOOGLE_CLIENT_ID']!,
    GOOGLE_CLIENT_SECRET: instanceEnv['GOOGLE_CLIENT_SECRET']!,
    LOADTEST_STAGING_APP: APPS.staging,
    LOADTEST_GENERATOR_APP: APPS.generator,
    LOADTEST_NEON_PROJECT: NEON.projectId,
    LOADTEST_NEON_BRANCH: NEON.branchName,
    LOADTEST_DATABASE_URL: databaseUrl,
    LOADTEST_ALLOWED_DB_HOST: new URL(databaseUrl).hostname,
    LOADTEST_PRODUCTION_DB_HOSTS: PRODUCTION_DB_HOST,
    LOADTEST_PRODUCTION_SENTRY_PROJECT_ID: PRODUCTION_SENTRY_PROJECT_ID,
    FLY_API_TOKEN: secrets.flyApiToken,
    STAGING_BASE_URL: proxy.origin,
    STAGING_ALLOWED_HOST: new URL(proxy.origin).hostname,
    LOADTEST_NEON_API_KEY: secrets.neonApiKey,
    LOADTEST_NEON_API_URL: stub.neonUrl,
    LOADTEST_PROM_URL: stub.promUrl,
    LOADTEST_FLY_PROM_TOKEN: secrets.promToken,
    LOADTEST_PROM_SETTLE_SECONDS: String(SETTLE_SECONDS),
    // k6's automatic extension resolution would contact Grafana's builder service;
    // the lane's binary already carries xk6-sse.
    K6_AUTO_EXTENSION_RESOLUTION: 'false',
  };
  for (const name of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED', 'MOTIR_BASE_URL', 'PORT']) {
    delete commandEnv[name];
  }

  project.provide('loadtestE2e', {
    tmp,
    checkout: copy,
    stateDir,
    generatorRoot,
    fakeBin,
    sha,
    proxyOrigin: proxy.origin,
    stubOrigin: stub.origin,
    commandEnv,
    secrets: { ...secrets, databaseUrl },
    instances: [
      { machineId: MACHINES.app[0], pid: pair.A.pid, origin: pair.A.origin },
      { machineId: MACHINES.app[1], pid: pair.B.pid, origin: pair.B.origin },
    ],
  });

  return async () => {
    await pair.stop();
    await proxy.close();
    await stub.close();
    // The working copy's manifest holds the run's (local, throwaway) tokens and
    // cookies; keep the tree only when asked, to read a failure.
    if (process.env['LOADTEST_E2E_KEEP'] === '1') console.warn(`loadtest-e2e: kept ${tmp}`);
    else rmSync(tmp, { recursive: true, force: true });
  };
}
