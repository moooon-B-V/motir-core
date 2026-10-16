// THE ONE RUN COMMAND (Story MOTIR-8538 · MOTIR-8678).
//
//   pnpm loadtest:run --profile <smoke|default|path> --instances <N> --app <staging app>
//                     [--baseline <run dir>] [--candidate-size] [--sha <expected>] [--tag <seed tag>]
//
// Puts staging into the required state, proves it from the platform, seeds, starts
// the generator machine, runs k6 on it, stops it again, and leaves a run directory
// holding everything the report needs — including exactly what answered.
//
// ⚠️ ITS EXIT STATUS IS WHETHER THE RUN COMPLETED, NEVER WHETHER IT PASSED. The
// verdict is `pnpm loadtest:report <run dir>`'s own exit code (0 PASS · 1 FAIL ·
// 3 UNMEASURED · 6 INVALID), which is what a script must read.
//
// ── WHERE EACH STEP RUNS ─────────────────────────────────────────────────────
// Staging is private (flycast only, no public IP). The operator machine has `fly`,
// `neonctl` and database access and NO route to the app, so everything that talks
// to the app over HTTP (the pin loop, the readiness checks, k6) runs ON THE
// GENERATOR through `fly ssh console`. The seed (database only) and every Fly and
// Neon read run here. A remote command with shell syntax is sent as
// `sh -c '<script>'`: `fly ssh console -C` does not run its string through a shell.
//
// ── THE STEPS (a refusal at any step changes nothing after it) ───────────────
//    1 validate — flags, env, the profile and its resolver refusals; `motir-core`
//      and any app not ending in `-staging` are refused BEFORE any platform call
//    2 read the platform — staging's and production's `app` machines
//    3 scale only if needed — never when the count already equals N
//    4 start the generator (`iad`) and check its k6 build
//    5 read N back — exactly N started, one image, every machine pinned and ready
//    6 the side-effect preflight
//    7 the database that answers, its date, and the rate-limit environment
//    8 seed and reset
//    9 k6 on the generator, detached; fetch the summary; delete the manifest
//   10 read the platform again — the instance count held
//   11 stop the generator (a `finally`), write the run directory, invoke the report
//      (`pnpm loadtest:report`, MOTIR-8679), which waits for Prometheus to settle and
//      prints the verdict line — after exit 4 or 5 too, so it can say INVALID and why
// Step 1 writes no run.json (there is no run yet). Every later path writes it,
// with `exitCode` and `reason`, BEFORE exiting non-zero.
//
// Exit codes (extending scripts/staging's table and the preflight's):
//   0  the run completed (not: passed)
//   2  configuration refused — nothing scaled or sent (bad profile, missing env or
//      flag, `motir-core` or a non-`-staging` app, a missing or mismatched
//      --baseline), or refused after run.json exists (preflight LIVE, seed short)
//   4  the platform is not in the required state
//   5  k6 could not be started, did not finish, or its summary could not be fetched

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve as resolvePath } from 'node:path';
import { assertAllowedBaseUrl, StagingConfigError } from '../../scripts/staging/lib/pinnedClient';
import { endpointHost } from '../lib/endpointHost';
import { formatLine, runPreflight } from '../preflight/sideEffects';
import { missingSeedEnv } from '../seed/guard';
import { readManifest, type SeedManifest } from '../seed/manifest';
import { AGENT_ROLES } from '../seed/shape';
import { InvalidProfileError, loadProfile, type LoadProfile } from '../profiles/schema';
import {
  describeResolved,
  loadHash,
  ProfileRefusedError,
  resolveProfile,
  type ResolvedProfile,
} from '../profiles/resolve';
import {
  flyOf,
  groupState,
  listMachines,
  PlatformReadError,
  readEnv,
  readEnvHost,
  scaleGroup,
  spawnExec,
  type Exec,
  type FlyRunner,
  type Machine,
} from './fly';
import {
  deleteManifest,
  deletePoints,
  hasVolume,
  REMOTE_POINTS,
  VOLUME_MOUNT,
  download,
  FETCHED_FILES,
  GENERATOR_REGION,
  k6VersionMismatch,
  pickGenerator,
  pollOnce,
  prepareRemote,
  readK6Version,
  readPinnedVersions,
  readRemoteLine,
  REMOTE_MANIFEST,
  REMOTE_PROFILE,
  REMOTE_RUN_DIR,
  REMOTE_SCRIPT,
  K6_COMPLETED_CODES,
  runScript,
  startAndWait,
  startDetached,
  stopGenerator,
  upload,
  type GeneratorRef,
} from './generator';
import { startRecorders, type CaptureDeps } from '../capture';
import { copiedFrom, readBranch, readBranchHost } from './neon';
import { generatorProbe, pinLoop, type Probe } from './pinned';
import {
  newRunRecord,
  readRunRecord,
  UNMEASURED,
  windowFrom,
  writeRunRecord,
  type RunRecord,
} from './runRecord';

export const EXIT = { completed: 0, refused: 2, platform: 4, k6: 5 } as const;

/** The production web app: refused before any platform call; read only (`fly machine list`). */
export const PRODUCTION_APP = 'motir-core';
export const STAGING_SUFFIX = '-staging';

/**
 * The production defaults of the rate-limit environment (per minute). Copied, not
 * imported, so this CLI does not load the app's rate-limit store;
 * tests/loadtest/runCommand.test.ts pins them to lib/rateLimit/budgets.ts and
 * lib/api/v1/rateLimit.ts.
 */
export const PRODUCTION_RATE_DEFAULTS = {
  MOTIR_API_V1_RATE_LIMIT: 60,
  MOTIR_MCP_RATE_LIMIT: 600,
  MOTIR_AGENT_WORKSPACE_RATE_LIMIT: 12_000,
} as const;
/** The staging /api/v1 limit must be at least this × the per-run-token rate. */
export const API_V1_HEADROOM = 1.5;

/** Every flag and env var the command reads, and its exit table — read by the runbook's guard test. */
export const OPTIONS = {
  flags: {
    profile: {
      flag: '--profile',
      required: true,
      description: 'smoke, default, or a path to a profile file',
    },
    instances: {
      flag: '--instances',
      required: true,
      description: 'N, the staging app instances to run at',
    },
    app: {
      flag: '--app',
      required: false,
      description:
        'the staging Fly app (default LOADTEST_STAGING_APP); must end in -staging, never motir-core',
    },
    baseline: {
      flag: '--baseline',
      required: false,
      description:
        'required for N > 1: a run directory at 1 instance with the same profile load hash',
    },
    candidateSize: {
      flag: '--candidate-size',
      required: false,
      description: "allow a staging app size that differs from production's (recorded in run.json)",
    },
    sha: {
      flag: '--sha',
      required: false,
      description: 'the deployed SHA the app machines must run',
    },
    tag: { flag: '--tag', required: false, description: 'the seed run tag (default lt)' },
  },
  env: [
    'LOADTEST_STAGING_APP',
    'LOADTEST_GENERATOR_APP',
    'LOADTEST_NEON_PROJECT',
    'LOADTEST_NEON_BRANCH',
    'LOADTEST_DATABASE_URL',
    'LOADTEST_ALLOWED_DB_HOST',
    'FLY_API_TOKEN',
    'STAGING_BASE_URL',
    'STAGING_ALLOWED_HOST',
    // Optional (MOTIR-8683): without the key the Neon endpoint readings are unmeasured.
    'LOADTEST_NEON_API_KEY',
    'LOADTEST_NEON_API_URL',
  ],
  /**
   * Required beside the flags (LOADTEST_STAGING_APP is also the fallback for --app).
   * The last two are the preflight's own: checked here so a run refuses before it
   * scales staging or starts the generator, not at the preflight step.
   */
  requiredEnv: [
    'LOADTEST_GENERATOR_APP',
    'LOADTEST_NEON_PROJECT',
    'LOADTEST_NEON_BRANCH',
    'LOADTEST_DATABASE_URL',
    'LOADTEST_ALLOWED_DB_HOST',
    'FLY_API_TOKEN',
    'STAGING_BASE_URL',
    'STAGING_ALLOWED_HOST',
    'LOADTEST_STAGING_APP',
    'LOADTEST_PRODUCTION_SENTRY_PROJECT_ID',
  ],
  exits: {
    0: 'the run completed (not: passed — the report decides that)',
    2: 'configuration refused; nothing scaled or sent, or refused after run.json exists (preflight LIVE, seed short)',
    4: 'the platform is not in the required state',
    5: 'k6 could not be started, did not finish, or its summary could not be fetched',
  },
} as const;

type Env = Readonly<Record<string, string | undefined>>;

export interface RunDeps {
  exec: Exec;
  env: Env;
  cwd: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  /** The side-effect preflight against `app`. */
  preflight?: (
    app: string,
    fly: FlyRunner,
    env: Env,
  ) => Promise<{ exitCode: number; text: string }>;
  /** `pnpm loadtest:seed` / `loadtest:seed:reset` with `args`, under `env`. */
  seed?: (command: 'seed' | 'reset', args: string[], env: Env) => Promise<number>;
  readManifest?: (path: string) => Promise<SeedManifest>;
  /** The probe the pin loop sends through the generator. */
  probe?: (g: GeneratorRef) => Probe;
  /** Invoke the report on a run directory; its exit code, or null when there is no report command. */
  report?: (runDir: string) => Promise<number | null>;
  /** Stand-ins for the run-window recorders' I/O (MOTIR-8683). */
  capture?: CaptureDeps;
  timeouts?: Partial<{
    generatorStartMs: number;
    readBackMs: number;
    pollMs: number;
    readBackPollMs: number;
  }>;
}

export interface RunOutcome {
  exitCode: number;
  runDir: string | null;
  reportExitCode: number | null;
}

class Stop extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'Stop';
  }
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i !== -1) return argv[i + 1];
  return argv.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

/** The UTC stamp a run directory starts with: `20261015T190144Z`. */
export function utcStamp(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

const defaultPreflight: NonNullable<RunDeps['preflight']> = async (app, fly, env) => {
  const out = await runPreflight(['--app', app], env, fly);
  return { exitCode: out.exitCode, text: [...out.lines.map(formatLine), out.message].join('\n') };
};

/** The rate-limit value a machine runs with: its env, or `default` when unset. */
function rateValue(raw: string | null): number | 'default' | 'unreadable' {
  if (raw === null) return 'default';
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : 'unreadable';
}

/** The trace rate a machine runs with — unset or invalid ⇒ 0 (`serverTracesSampleRate`). */
export function traceRateOf(raw: string | null): number {
  if (raw === null) return 0;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0;
}

/** Which role the manifest is short of, for the resolved VUs; null when it covers them. */
export function manifestShortfall(
  manifest: SeedManifest,
  resolved: ResolvedProfile,
): string | null {
  for (const role of AGENT_ROLES) {
    const have = manifest.agents.filter((a) => a.role === role).length;
    if (have < resolved.vus[role])
      return `${role} agents: ${have} seeded, ${resolved.vus[role]} VUs`;
  }
  const burst = manifest.agents.filter((a) => a.role === 'write' && a.burst).length;
  if (burst < resolved.vus.burst) return `burst agents: ${burst} seeded, ${resolved.vus.burst} VUs`;
  if (manifest.users.length < resolved.vus.readers) {
    return `readers: ${manifest.users.length} users seeded, ${resolved.vus.readers} VUs`;
  }
  if (manifest.workspaces.length < resolved.profile.tenancy.agentWorkspaces) {
    return `workspaces: ${manifest.workspaces.length} seeded, ${resolved.profile.tenancy.agentWorkspaces} agent workspaces`;
  }
  return null;
}

const sameGuest = (a: Machine, b: Machine) =>
  a.cpuKind === b.cpuKind && a.cpus === b.cpus && a.memoryMb === b.memoryMb;

const machineRecord = (m: Machine) => ({
  id: m.id,
  region: m.region,
  cpuKind: m.cpuKind,
  cpus: m.cpus ?? UNMEASURED,
  memoryMb: m.memoryMb ?? UNMEASURED,
  imageRef: m.imageRef,
});

/** The whole command over explicit inputs. */
export async function runLoadTest(argv: readonly string[], deps: RunDeps): Promise<RunOutcome> {
  const { env, log } = deps;
  const fly = flyOf(deps.exec);
  const t = {
    generatorStartMs: 120_000,
    readBackMs: 180_000,
    pollMs: 10_000,
    readBackPollMs: 5_000,
    ...deps.timeouts,
  };
  const refuse = (reason: string): RunOutcome => {
    log(`refused: ${reason}`);
    return { exitCode: EXIT.refused, runDir: null, reportExitCode: null };
  };

  // ── 1. Validate (no platform call, no run.json) ───────────────────────────
  const app = (argValue(argv, OPTIONS.flags.app.flag) ?? env['LOADTEST_STAGING_APP'])?.trim();
  if (!app) return refuse('--app (or LOADTEST_STAGING_APP) is required');
  if (app === PRODUCTION_APP)
    return refuse(
      `--app ${PRODUCTION_APP} is production; this command runs fly scale and never targets it`,
    );
  if (!app.endsWith(STAGING_SUFFIX))
    return refuse(`--app ${app} does not end in ${STAGING_SUFFIX}`);
  const named = env['LOADTEST_STAGING_APP']?.trim();
  if (named && named !== app) return refuse(`--app ${app} is not LOADTEST_STAGING_APP (${named})`);

  const missing = OPTIONS.requiredEnv.filter((name) => !env[name]?.trim());
  const profileArg = argValue(argv, OPTIONS.flags.profile.flag);
  const instancesArg = argValue(argv, OPTIONS.flags.instances.flag);
  const missingFlags = [!profileArg && '--profile', !instancesArg && '--instances'].filter(Boolean);
  if (missing.length > 0 || missingFlags.length > 0) {
    return refuse(`missing ${[...missingFlags, ...missing].join(', ')}`);
  }
  const n = Number(instancesArg);
  if (!Number.isInteger(n) || n < 1)
    return refuse(`--instances must be an integer ≥ 1, got ${instancesArg}`);
  try {
    assertAllowedBaseUrl(env['STAGING_BASE_URL'], env['STAGING_ALLOWED_HOST']);
  } catch (err) {
    if (err instanceof StagingConfigError) return refuse(err.message);
    throw err;
  }
  const baseUrl = env['STAGING_BASE_URL']!.replace(/\/+$/, '');
  const seedEnv: Env = {
    ...env,
    DATABASE_URL: env['LOADTEST_DATABASE_URL'],
    DATABASE_URL_UNPOOLED: env['LOADTEST_DATABASE_URL_UNPOOLED'] ?? env['LOADTEST_DATABASE_URL'],
    MOTIR_BASE_URL: baseUrl,
  };
  const seedMissing = missingSeedEnv(seedEnv);
  if (seedMissing.length > 0)
    return refuse(`the seed would refuse: missing ${seedMissing.join(', ')}`);

  let profile: LoadProfile;
  let profileFile: string;
  let resolved: ResolvedProfile;
  try {
    ({ profile, path: profileFile } = await loadProfile(profileArg!, n, deps.cwd));
    resolved = resolveProfile(profile, n);
  } catch (err) {
    if (err instanceof InvalidProfileError || err instanceof ProfileRefusedError)
      return refuse(err.message);
    throw err;
  }
  const baselineArg = argValue(argv, OPTIONS.flags.baseline.flag);
  let baseline: string | null = null;
  if (n > 1) {
    if (!baselineArg)
      return refuse(`${OPTIONS.flags.baseline.flag} <run dir> is required for --instances ${n}`);
    baseline = resolvePath(deps.cwd, baselineArg);
    let base: RunRecord;
    try {
      base = await readRunRecord(baseline);
    } catch {
      return refuse(`${OPTIONS.flags.baseline.flag}: no run.json in ${baselineArg}`);
    }
    if (base.instances !== 1)
      return refuse(
        `${OPTIONS.flags.baseline.flag}: ${baselineArg} ran at ${base.instances} instances, not 1`,
      );
    if (base.profile.sha256 !== loadHash(profile)) {
      return refuse(
        `${OPTIONS.flags.baseline.flag}: ${baselineArg} ran a different load (profile hash differs)`,
      );
    }
  }
  for (const line of describeResolved(resolved)) log(line);

  // ── 2–11. From here on, run.json is written before any exit ───────────────
  const started = deps.now();
  const runId = `${utcStamp(started)}-${profile.name}-n${n}`;
  const runDir = resolvePath(deps.cwd, 'loadtest/.out/runs', runId);
  const candidateSize = argv.includes(OPTIONS.flags.candidateSize.flag);
  const generatorApp = env['LOADTEST_GENERATOR_APP']!;
  const record = newRunRecord({
    runId,
    profile: {
      name: profile.name,
      path: relative(deps.cwd, profileFile),
      sha256: loadHash(profile),
    },
    instances: n,
    app,
    candidateSize,
    neonProject: env['LOADTEST_NEON_PROJECT']!,
    generatorApp,
    requiredConcurrency: resolved.requiredConcurrency,
    offered: {
      rpsUpperBound: resolved.offered.rpsUpperBound,
      perWorkspaceRps: resolved.offered.perWorkspaceRps,
      perTokenRps: resolved.offered.perTokenRps,
      readerStreamsPerInstance: resolved.offered.readerStreamsPerInstance,
    },
    baseline,
  });
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'profile.resolved.json'), `${JSON.stringify(resolved, null, 2)}\n`);
  await writeRunRecord(runDir, record);

  let generator: GeneratorRef | null = null;
  let generatorStartAttempted = false;
  let exitCode: number = EXIT.completed;
  let reason: string | null = null;
  try {
    // ── 2. Read the platform before touching it ────────────────────────────
    const staging = await listMachines(fly, app);
    const production = groupState(await listMachines(fly, PRODUCTION_APP)).machines[0];
    if (production) {
      record.production = {
        cpuKind: production.cpuKind,
        cpus: production.cpus ?? UNMEASURED,
        memoryMb: production.memoryMb ?? UNMEASURED,
      };
    }
    const group = groupState(staging);
    if (group.notStarted.length > 0) {
      throw new Stop(
        EXIT.platform,
        `app machines not started: ${group.notStarted.map((m) => `${m.id} (${m.state})`).join(', ')} — left alone; fly scale count counts stopped machines too`,
      );
    }
    if (!production)
      throw new Stop(
        EXIT.platform,
        `${PRODUCTION_APP} has no app machine to match the size against`,
      );
    const offSize = group.machines.filter((m) => !sameGuest(m, production));
    if (offSize.length > 0 && !candidateSize) {
      throw new Stop(
        EXIT.platform,
        `staging app size differs from production's (${production.cpuKind} ${production.cpus} cpu ${production.memoryMb} MB) on ${offSize.map((m) => m.id).join(', ')}; pass ${OPTIONS.flags.candidateSize.flag} for a sizing run`,
      );
    }
    for (const m of group.machines) {
      if (m.services.length === 0)
        throw new Stop(EXIT.platform, `app machine ${m.id} has no service`);
      for (const s of m.services) {
        if (s.autostop !== 'off') {
          throw new Stop(
            EXIT.platform,
            `app machine ${m.id} has autostop "${s.autostop}"; it must be off`,
          );
        }
        const c = s.concurrency;
        record.concurrency = {
          type: c.type,
          softLimit: c.softLimit ?? UNMEASURED,
          hardLimit: c.hardLimit ?? UNMEASURED,
        };
        if (c.type !== 'requests') {
          throw new Stop(
            EXIT.platform,
            `app machine ${m.id} concurrency type is "${c.type}"; it must be requests`,
          );
        }
        if (c.softLimit === null || c.hardLimit === null) {
          throw new Stop(
            EXIT.platform,
            `app machine ${m.id} leaves ${c.softLimit === null ? 'soft_limit' : 'hard_limit'} unset (20 / unlimited by default, not a chosen limit)`,
          );
        }
        const need = resolved.requiredConcurrency;
        if (c.hardLimit < need.hard || c.softLimit < need.soft) {
          throw new Stop(
            EXIT.platform,
            `app machine ${m.id} concurrency ${c.softLimit}/${c.hardLimit} is below the required ${need.soft}/${need.hard}`,
          );
        }
      }
    }

    // ── 3. Scale only if needed ─────────────────────────────────────────────
    if (group.started.length !== n) {
      log(`scaling ${app} app group ${group.started.length} → ${n}`);
      record.scale = await scaleGroup(fly, app, n);
    } else {
      record.scale = 'not-needed';
    }
    await writeRunRecord(runDir, record);

    // ── 4. Start the generator ──────────────────────────────────────────────
    const g = pickGenerator(await listMachines(fly, generatorApp));
    if (!g) throw new Stop(EXIT.platform, `${generatorApp} has no machine`);
    record.generator.machineId = g.id;
    record.generator.region = g.region;
    record.generator.cpus = g.cpus ?? UNMEASURED;
    if (g.region !== GENERATOR_REGION) {
      throw new Stop(EXIT.platform, `generator ${g.id} is in ${g.region}, not ${GENERATOR_REGION}`);
    }
    generator = { fly, app: generatorApp, id: g.id };
    generatorStartAttempted = true;
    try {
      await startAndWait(generator, {
        now: () => deps.now().getTime(),
        sleep: deps.sleep,
        timeoutMs: t.generatorStartMs,
      });
    } catch (err) {
      throw new Stop(EXIT.platform, (err as Error).message);
    }
    record.generator.startedAt = deps.now().toISOString();
    const k6 = await readK6Version(generator);
    record.k6.version = k6.version ?? UNMEASURED;
    record.k6.extensions = k6.extensions;
    const mismatch = k6VersionMismatch(k6, await readPinnedVersions(deps.cwd));
    if (mismatch) {
      throw new Stop(
        EXIT.platform,
        `${mismatch} — re-run the provisioning step that bakes loadtest/k6/build.sh's binary into the generator image`,
      );
    }
    if (!(await hasVolume(generator))) {
      throw new Stop(
        EXIT.platform,
        `generator ${generator.id} has no volume mounted at ${VOLUME_MOUNT}; k6's point file is written there (provisioning creates it)`,
      );
    }
    await writeRunRecord(runDir, record);

    // ── 5. Read N back, and abort on a mismatch ─────────────────────────────
    const deadline = deps.now().getTime() + t.readBackMs;
    let app5 = groupState(await listMachines(fly, app));
    while (app5.started.length !== n || app5.notStarted.length > 0) {
      if (deps.now().getTime() >= deadline) {
        throw new Stop(
          EXIT.platform,
          `read back ${app5.started.length} started app machines (${app5.notStarted.length} not started), expected ${n}`,
        );
      }
      await deps.sleep(t.readBackPollMs);
      app5 = groupState(await listMachines(fly, app));
    }
    record.app.machines = app5.started.map(machineRecord);
    const images = new Set(app5.started.map((m) => m.imageRef));
    if (images.size !== 1)
      throw new Stop(
        EXIT.platform,
        `app machines run ${images.size} images: ${[...images].join(', ')}`,
      );
    const tag = app5.started[0]!.imageTag;
    if (tag && /^[0-9a-f]{40}$/.test(tag)) {
      record.sha = tag;
      record.shaReadFrom = 'image_ref tag';
    }
    const expectedSha = argValue(argv, OPTIONS.flags.sha.flag);
    if (expectedSha && record.sha !== expectedSha) {
      throw new Stop(EXIT.platform, `deployed sha is ${record.sha}, expected ${expectedSha}`);
    }
    const probe = (deps.probe ?? ((ref) => generatorProbe(ref.fly, ref.app, ref.id)))(generator);
    const pins = await pinLoop(
      probe,
      baseUrl,
      app5.started.map((m) => m.id),
    );
    record.pin = {
      enforced: pins.enforced,
      via: 'generator',
      unknownIdAnswer: pins.unknownIdAnswer,
    };
    if (!pins.ok) throw new Stop(EXIT.platform, pins.reason ?? 'the pin loop failed');
    await writeRunRecord(runDir, record);

    // ── 6. Preflight ────────────────────────────────────────────────────────
    const pre = await (deps.preflight ?? defaultPreflight)(app, fly, env);
    record.preflightExitCode = pre.exitCode;
    await writeFile(join(runDir, 'preflight.txt'), `${pre.text}\n`);
    if (pre.exitCode !== 0)
      throw new Stop(
        pre.exitCode,
        `the side-effect preflight exited ${pre.exitCode} (preflight.txt)`,
      );

    // ── 7. The database that answers, and its date ──────────────────────────
    const project = env['LOADTEST_NEON_PROJECT']!;
    const branchName = env['LOADTEST_NEON_BRANCH']!;
    let refresh: unknown = null;
    try {
      refresh = JSON.parse(await readFile(join(deps.cwd, 'loadtest/.out/refresh.json'), 'utf8'));
    } catch {
      refresh = null;
    }
    const branch = copiedFrom(refresh, await readBranch(deps.exec, project, branchName));
    record.neon.branchId = branch.branchId;
    record.neon.copiedAt = branch.copiedAt;
    record.neon.copiedAtField = branch.copiedAtField;
    const branchHost = await readBranchHost(deps.exec, project, branchName);
    record.neon.endpointHost = branchHost;
    const witness = app5.started[0]!.id;
    const servingHost = await readEnvHost(fly, app, witness, 'DATABASE_URL');
    const allowedHost = endpointHost(env['LOADTEST_ALLOWED_DB_HOST']);
    if (servingHost !== branchHost) {
      throw new Stop(
        EXIT.platform,
        `staging reads ${servingHost ?? 'no readable host'}, not the branch's endpoint ${branchHost}`,
      );
    }
    if (allowedHost !== branchHost) {
      throw new Stop(
        EXIT.platform,
        `LOADTEST_ALLOWED_DB_HOST (${allowedHost}) is not the branch's endpoint ${branchHost}`,
      );
    }
    const rates: Record<keyof typeof PRODUCTION_RATE_DEFAULTS, number | 'default' | 'unreadable'> =
      {
        MOTIR_API_V1_RATE_LIMIT: rateValue(
          await readEnv(fly, app, witness, 'MOTIR_API_V1_RATE_LIMIT'),
        ),
        MOTIR_MCP_RATE_LIMIT: rateValue(await readEnv(fly, app, witness, 'MOTIR_MCP_RATE_LIMIT')),
        MOTIR_AGENT_WORKSPACE_RATE_LIMIT: rateValue(
          await readEnv(fly, app, witness, 'MOTIR_AGENT_WORKSPACE_RATE_LIMIT'),
        ),
      };
    const asRecorded = (v: number | 'default' | 'unreadable') =>
      v === 'unreadable' ? UNMEASURED : v;
    record.rateLimits = {
      apiV1: asRecorded(rates.MOTIR_API_V1_RATE_LIMIT),
      mcp: asRecorded(rates.MOTIR_MCP_RATE_LIMIT),
      agentWorkspace: asRecorded(rates.MOTIR_AGENT_WORKSPACE_RATE_LIMIT),
    };
    record.traceRate = traceRateOf(await readEnv(fly, app, witness, 'SENTRY_TRACES_SAMPLE_RATE'));
    const effective = (name: keyof typeof PRODUCTION_RATE_DEFAULTS) => {
      const v = rates[name];
      if (v === 'unreadable')
        throw new Stop(EXIT.platform, `${name} on ${witness} is not a positive integer`);
      return v === 'default' ? PRODUCTION_RATE_DEFAULTS[name] : v;
    };
    for (const name of ['MOTIR_MCP_RATE_LIMIT', 'MOTIR_AGENT_WORKSPACE_RATE_LIMIT'] as const) {
      if (effective(name) < PRODUCTION_RATE_DEFAULTS[name]) {
        throw new Stop(
          EXIT.platform,
          `${name} is ${effective(name)}, below the production default ${PRODUCTION_RATE_DEFAULTS[name]}: a harness limit would be measured as capacity`,
        );
      }
    }
    const perTokenPerMinute = resolved.offered.perTokenRps.apiV1 * 60;
    if (effective('MOTIR_API_V1_RATE_LIMIT') < API_V1_HEADROOM * perTokenPerMinute) {
      throw new Stop(
        EXIT.platform,
        `MOTIR_API_V1_RATE_LIMIT is ${effective('MOTIR_API_V1_RATE_LIMIT')}/min, below ${API_V1_HEADROOM} × the run token's ${Math.ceil(perTokenPerMinute)}/min`,
      );
    }
    await writeRunRecord(runDir, record);

    // ── 8. Seed and reset ───────────────────────────────────────────────────
    const shapePath = join(runDir, 'seed-shape.json');
    await writeFile(shapePath, `${JSON.stringify(resolved.seed, null, 2)}\n`);
    const manifestPath = join(deps.cwd, 'loadtest/.out/manifest.json');
    const seedTag = argValue(argv, OPTIONS.flags.tag.flag) ?? 'lt';
    const seed = deps.seed ?? defaultSeed(deps);
    const seeded = await seed(
      'seed',
      ['--shape', shapePath, '--tag', seedTag, '--out', manifestPath],
      seedEnv,
    );
    if (seeded !== 0) throw new Stop(EXIT.refused, `pnpm loadtest:seed exited ${seeded}`);
    const reset = await seed('reset', ['--manifest', manifestPath], seedEnv);
    if (reset !== 0) throw new Stop(EXIT.refused, `pnpm loadtest:seed:reset exited ${reset}`);
    const manifest = await (deps.readManifest ?? readManifest)(manifestPath);
    if (endpointHost(manifest.databaseHost) !== branchHost) {
      throw new Stop(
        EXIT.refused,
        `the manifest was seeded into ${manifest.databaseHost}, not ${branchHost}`,
      );
    }
    if (manifest.baseUrl.replace(/\/+$/, '') !== baseUrl) {
      throw new Stop(EXIT.refused, `the manifest's base URL is not STAGING_BASE_URL`);
    }
    const short = manifestShortfall(manifest, resolved);
    if (short) throw new Stop(EXIT.refused, `the seed is short of ${short}`);

    // ── 8½. Start the run-window recorders (MOTIR-8683) ─────────────────────
    const recorders = await startRecorders({
      app,
      outDir: runDir,
      exec: deps.exec,
      env,
      project,
      branch: branchName,
      branchId: branch.branchId,
      now: deps.now,
      log,
      deps: deps.capture,
    });

    // ── 9. k6 on the generator ──────────────────────────────────────────────
    const scriptPath = join(runDir, 'run.sh');
    await writeFile(scriptPath, runScript());
    try {
      try {
        await prepareRemote(generator);
        await upload(generator, join(deps.cwd, 'loadtest/k6'), `${REMOTE_RUN_DIR}/k6`, {
          recursive: true,
        });
        await upload(generator, join(runDir, 'profile.resolved.json'), REMOTE_PROFILE);
        await upload(generator, scriptPath, REMOTE_SCRIPT);
        await upload(generator, manifestPath, REMOTE_MANIFEST, { mode: '0600' });
        await startDetached(generator);
      } catch (err) {
        throw new Stop(EXIT.k6, `k6 could not be started: ${(err as Error).message}`);
      }
      log(`k6 started on ${generator.id}; polling every ${Math.round(t.pollMs / 1000)} s`);
      const until = deps.now().getTime() + (resolved.timing.maxSeconds + 600) * 1000;
      let seen = 0;
      let k6Exit: number | null = null;
      while (k6Exit === null) {
        await deps.sleep(t.pollMs);
        const p = await pollOnce(generator, seen);
        for (const line of p.newLines) log(`k6 | ${line}`);
        seen = p.linesSeen;
        k6Exit = p.exitCode;
        if (k6Exit === null && deps.now().getTime() >= until) {
          throw new Stop(EXIT.k6, `k6 did not finish within ${resolved.timing.maxSeconds + 600} s`);
        }
      }
      record.k6.exitCode = k6Exit;
      const startedAt = await readRemoteLine(generator, `${REMOTE_RUN_DIR}/started.at`);
      const endedAt = await readRemoteLine(generator, `${REMOTE_RUN_DIR}/ended.at`);
      if (startedAt) record.window = windowFrom(startedAt, endedAt ?? UNMEASURED, resolved.timing);
      const fetched: string[] = [];
      for (const file of FETCHED_FILES) {
        if (await download(generator, `${REMOTE_RUN_DIR}/${file}`, join(runDir, file)))
          fetched.push(file);
      }
      if (!(K6_COMPLETED_CODES as readonly number[]).includes(k6Exit)) {
        throw new Stop(EXIT.k6, `k6 exited ${k6Exit} (k6.log)`);
      }
      if (!fetched.includes('summary.json'))
        throw new Stop(EXIT.k6, 'summary.json could not be fetched');
    } finally {
      record.manifestDeleted = await deleteManifest(generator).catch(() => false);
      if (record.manifestDeleted !== true)
        log(`⚠️ the manifest may still be on ${generator.id} at ${REMOTE_MANIFEST}`);
      if (!(await deletePoints(generator).catch(() => false))) {
        log(`⚠️ the point file may still be on ${generator.id} at ${REMOTE_POINTS}`);
      }
      const captured = await recorders.stop();
      record.capture = captured;
    }

    // ── 10. Read the platform again at the end ──────────────────────────────
    const end = groupState(await listMachines(fly, app));
    const before = new Set(app5.started.map((m) => m.id));
    const after = new Set(end.started.map((m) => m.id));
    const changed = [...before]
      .filter((id) => !after.has(id))
      .concat([...after].filter((id) => !before.has(id)));
    record.instancesChanged = changed.sort();
    record.instancesHeld = changed.length === 0;
    if (changed.length > 0) {
      throw new Stop(
        EXIT.platform,
        `the app machine set changed during the run: ${record.instancesChanged.join(', ')}`,
      );
    }
  } catch (err) {
    if (err instanceof Stop) {
      exitCode = err.exitCode;
      reason = err.message;
    } else if (err instanceof PlatformReadError) {
      exitCode = EXIT.platform;
      reason = err.message;
    } else {
      exitCode = EXIT.platform;
      reason = `unexpected: ${(err as Error).message}`;
    }
  } finally {
    // ── 11. Stop the generator, whatever happened ────────────────────────────
    if (generator && generatorStartAttempted) {
      try {
        await stopGenerator(generator);
        record.generator.stoppedAt = deps.now().toISOString();
      } catch (err) {
        log(
          `⚠️ could not stop generator ${generator.id}: ${(err as Error).message} — stop it by hand`,
        );
      }
    }
  }

  record.exitCode = exitCode;
  record.reason = reason;
  await writeRunRecord(runDir, record);
  if (reason) log(`exit ${exitCode}: ${reason}`);
  log(`run directory: ${relative(deps.cwd, runDir)}`);
  const reportExitCode = await (deps.report ?? defaultReport(deps))(runDir);
  return { exitCode, runDir, reportExitCode };
}

function defaultSeed(deps: RunDeps): NonNullable<RunDeps['seed']> {
  return async (command, args, env) => {
    const script = command === 'seed' ? 'loadtest:seed' : 'loadtest:seed:reset';
    const r = await deps.exec('pnpm', ['-s', script, ...args], { env });
    for (const line of r.stdout.split('\n').filter(Boolean)) deps.log(`seed | ${line}`);
    // A failed seed says why on stderr (its entry prints the error's message there);
    // without these lines the run recorded only "exited 1" (MOTIR-8682).
    if (r.code !== 0)
      for (const line of r.stderr.split('\n').filter(Boolean)) deps.log(`seed ! ${line}`);
    return r.code;
  };
}

function defaultReport(deps: RunDeps): NonNullable<RunDeps['report']> {
  return async (runDir) => {
    const pkg = JSON.parse(await readFile(join(deps.cwd, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    if (!pkg.scripts?.['loadtest:report']) {
      deps.log(
        'report: `pnpm loadtest:report` is not in this checkout yet; run.json is ready for it',
      );
      return null;
    }
    const r = await deps.exec('pnpm', ['-s', 'loadtest:report', runDir]);
    for (const line of r.stdout.split('\n').filter(Boolean)) deps.log(line);
    return r.code;
  };
}

/* v8 ignore start -- the process entry over `runLoadTest`, which tests/loadtest/runCommand.test.ts drives. */
if (/run[\\/]run\.ts$/.test(process.argv[1] ?? '')) {
  runLoadTest(process.argv.slice(2), {
    exec: spawnExec,
    env: process.env,
    cwd: process.cwd(),
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => process.stdout.write(`${line}\n`),
  })
    .then((out) => process.exit(out.exitCode))
    .catch((err: unknown) => {
      process.stderr.write(`${(err as Error).stack ?? String(err)}\n`);
      process.exit(EXIT.platform);
    });
}
/* v8 ignore stop */
