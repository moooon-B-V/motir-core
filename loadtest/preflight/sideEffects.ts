// THE SIDE-EFFECT PREFLIGHT (Story MOTIR-8538 · MOTIR-8672).
//
//   pnpm loadtest:preflight --app motir-core-staging
//
// Reads the DEPLOYED staging app — the value each running machine actually holds,
// never a config file — and refuses to let a load-test run start while any switch
// in `loadtest/staging/sideEffectSwitches.ts` is live. A secret name in a template
// is a claim; a machine's environment is a reading.
//
// What it does, in order:
//   1. Refuses outright (exit 2, before any platform call) when LOADTEST_STAGING_APP
//      is unset, when --app is `motir-core`, or when --app is not LOADTEST_STAGING_APP.
//      An allow-list by equality, because `motir-core` is not the only
//      production-adjacent app in the org.
//   2. Lists the machines (`fly machine list --json -a <app>`). Every STARTED machine
//      of every process group is read: the worker sends the email and runs the jobs.
//   3. Reads each machine's environment from inside it
//      (`fly ssh console -a <app> --machine <id> -C printenv`), parses it in memory,
//      and never prints a value.
//   4. Reads the app's secret NAMES (`fly secrets list --json -a <app>`) and requires
//      them to equal the template's "set" names exactly.
//   5. Evaluates every row on every machine and prints one line per row × machine
//      (`PASS` / `LIVE` / `UNREAD`) naming the machine, its image and the read time.
//
// Exit codes (this command's own; they do NOT mirror scripts/staging's table):
//   0  every row passes on every machine
//   2  a row is LIVE, a required name is MISSING, or the configuration was refused
//   4  a row could not be read on some machine (no started machine, ssh failed,
//      the secret list unreadable)
//
// ⚠️ UNREAD refuses exactly like LIVE. A tolerant branch that turned "could not read"
// into "off" would report green for ever while measuring nothing.

import { endpointHost, endpointHostList } from '../lib/endpointHost';
import {
  REQUIRED_SET,
  SWITCH_TABLE,
  templateSetNames,
  type RowId,
  type SwitchKey,
} from '../staging/sideEffectSwitches';

export const EXIT = { ok: 0, live: 2, unread: 4 } as const;

/** The CLI's options, exported so the runbook's guard test reads flags without parsing text. */
export const OPTIONS = {
  app: {
    flag: '--app',
    required: true,
    description:
      'the staging Fly app to read; must equal LOADTEST_STAGING_APP and never be motir-core',
  },
} as const;

/** The production web app. A preflight against it is refused before any call. */
export const PRODUCTION_APP = 'motir-core';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `fly <args>`. Injected so the logic is testable without Fly. */
export type FlyRunner = (args: readonly string[]) => Promise<CommandResult>;

export type Verdict = 'PASS' | 'LIVE' | 'MISSING' | 'UNREAD';

export interface PreflightLine {
  verdict: Verdict;
  /** A row id, `required-set`, or `secret-names`. */
  row: RowId | 'required-set' | 'secret-names';
  machineId: string | null;
  image: string | null;
  readAt: string;
  /** Key names and the reason — never a value. */
  detail: string;
}

export interface PreflightOutcome {
  exitCode: number;
  lines: PreflightLine[];
  message: string;
}

export interface FlyMachine {
  id: string;
  state: string;
  group: string;
  image: string;
}

/** Parse `fly machine list --json`. Throws on anything that is not a machine array. */
export function parseMachineList(stdout: string): FlyMachine[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('fly machine list did not return an array');
  return parsed.map((m: Record<string, unknown>) => {
    const config = (m['config'] ?? {}) as Record<string, unknown>;
    const metadata = (config['metadata'] ?? {}) as Record<string, unknown>;
    const ref = (m['image_ref'] ?? {}) as Record<string, unknown>;
    const image =
      typeof ref['digest'] === 'string' && ref['digest']
        ? String(ref['digest'])
        : typeof config['image'] === 'string'
          ? String(config['image'])
          : 'unknown';
    return {
      id: String(m['id']),
      state: String(m['state'] ?? 'unknown'),
      group: String(metadata['fly_process_group'] ?? 'app'),
      image,
    };
  });
}

/**
 * Parse `printenv` output into a map. A line `NAME=value` starts a variable; any
 * other line continues the previous one (a multi-line private key).
 */
export function parsePrintenv(stdout: string): Map<string, string> {
  const env = new Map<string, string>();
  let last: string | null = null;
  for (const line of stdout.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) {
      last = m[1]!;
      env.set(last, m[2]!);
    } else if (last !== null) {
      env.set(last, `${env.get(last)}\n${line}`);
    }
  }
  return env;
}

/** Parse `fly secrets list --json` into the set of names. */
export function parseSecretNames(stdout: string): string[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error('fly secrets list did not return an array');
  return parsed.map((s: Record<string, unknown>) => String(s['Name'] ?? s['name']));
}

/** The project id of a Sentry DSN (`https://<key>@o1.ingest.sentry.io/<project>`), or null. */
export function sentryProjectId(dsn: string): string | null {
  try {
    const id = new URL(dsn).pathname.split('/').filter(Boolean).pop();
    return id && /^\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export interface PreflightConfig {
  allowedDbHost: string;
  productionDbHosts: string[];
  productionSentryProjectId: string;
}

/** One key's verdict on one machine, with a reason that names no value. */
export function evaluateKey(
  k: SwitchKey,
  env: ReadonlyMap<string, string>,
  config: PreflightConfig,
): { ok: boolean; reason: string } {
  const value = env.get(k.key);
  switch (k.state.kind) {
    case 'absent':
      return value === undefined
        ? { ok: true, reason: '' }
        : { ok: false, reason: `${k.key} is set (must be absent)` };
    case 'equals':
      if (value === undefined)
        return { ok: false, reason: `${k.key} is not set (must be "${k.state.value}")` };
      return value === k.state.value
        ? { ok: true, reason: '' }
        : { ok: false, reason: `${k.key} is not "${k.state.value}"` };
    case 'host-is-staging': {
      if (value === undefined) return { ok: false, reason: `${k.key} is not set` };
      const host = endpointHost(value);
      if (!host) return { ok: false, reason: `${k.key} has no readable host` };
      if (config.productionDbHosts.includes(host)) {
        return { ok: false, reason: `${k.key} points at a PRODUCTION host (${host})` };
      }
      if (host !== config.allowedDbHost) {
        return {
          ok: false,
          reason: `${k.key} host ${host} is not the staging host ${config.allowedDbHost}`,
        };
      }
      return { ok: true, reason: '' };
    }
    case 'differs-from-production': {
      if (value === undefined) return { ok: false, reason: `${k.key} is not set` };
      const id = sentryProjectId(value);
      if (!id) return { ok: false, reason: `${k.key} has no readable project id` };
      return id === config.productionSentryProjectId
        ? { ok: false, reason: `${k.key} is production's Sentry project (${id})` }
        : { ok: true, reason: '' };
    }
  }
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i !== -1) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq?.slice(flag.length + 1);
}

/**
 * The configuration refusal, checked before any platform call. Returns the reason,
 * or null when the configuration is acceptable.
 */
export function refuseConfiguration(
  app: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const staging = env['LOADTEST_STAGING_APP']?.trim();
  if (!staging)
    return 'LOADTEST_STAGING_APP is not set; the preflight reads only the app it names.';
  if (!app) return '--app is required.';
  if (app === PRODUCTION_APP)
    return `--app ${PRODUCTION_APP} is production; the preflight never reads it.`;
  if (app !== staging) return `--app ${app} is not LOADTEST_STAGING_APP (${staging}).`;
  if (staging === PRODUCTION_APP)
    return `LOADTEST_STAGING_APP names production (${PRODUCTION_APP}).`;
  if (!env['LOADTEST_ALLOWED_DB_HOST']?.trim()) {
    return 'LOADTEST_ALLOWED_DB_HOST is not set: the database rows cannot be judged.';
  }
  if (endpointHostList(env['LOADTEST_PRODUCTION_DB_HOSTS']).length === 0) {
    return 'LOADTEST_PRODUCTION_DB_HOSTS is not set: the database rows cannot refuse production.';
  }
  if (!env['LOADTEST_PRODUCTION_SENTRY_PROJECT_ID']?.trim()) {
    return 'LOADTEST_PRODUCTION_SENTRY_PROJECT_ID is not set: the Sentry row cannot be judged.';
  }
  return null;
}

export async function runPreflight(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  fly: FlyRunner,
  now: () => Date = () => new Date(),
): Promise<PreflightOutcome> {
  const app = argValue(argv, OPTIONS.app.flag);
  const lines: PreflightLine[] = [];
  const stamp = () => now().toISOString();

  const refusal = refuseConfiguration(app, env);
  if (refusal) {
    return { exitCode: EXIT.live, lines, message: `refused: ${refusal}` };
  }
  const config: PreflightConfig = {
    allowedDbHost: endpointHost(env['LOADTEST_ALLOWED_DB_HOST'])!,
    productionDbHosts: endpointHostList(env['LOADTEST_PRODUCTION_DB_HOSTS']),
    productionSentryProjectId: env['LOADTEST_PRODUCTION_SENTRY_PROJECT_ID']!.trim(),
  };

  // 2. The machines.
  let machines: FlyMachine[];
  try {
    const listed = await fly(['machine', 'list', '--json', '-a', app!]);
    if (listed.code !== 0) throw new Error(`fly machine list exited ${listed.code}`);
    machines = parseMachineList(listed.stdout).filter((m) => m.state === 'started');
  } catch (err) {
    lines.push({
      verdict: 'UNREAD',
      row: 'secret-names',
      machineId: null,
      image: null,
      readAt: stamp(),
      detail: `could not list machines: ${(err as Error).message}`,
    });
    return finish(lines);
  }
  if (machines.length === 0) {
    lines.push({
      verdict: 'UNREAD',
      row: 'secret-names',
      machineId: null,
      image: null,
      readAt: stamp(),
      detail: `${app} has no started machine to read`,
    });
    return finish(lines);
  }

  // 4. The secret names, once per app.
  try {
    const listed = await fly(['secrets', 'list', '--json', '-a', app!]);
    if (listed.code !== 0) throw new Error(`fly secrets list exited ${listed.code}`);
    const names = new Set(parseSecretNames(listed.stdout));
    const expected = new Set(templateSetNames());
    const extra = [...names].filter((n) => !expected.has(n)).sort();
    const missing = [...expected].filter((n) => !names.has(n)).sort();
    const readAt = stamp();
    for (const n of extra) {
      lines.push({
        verdict: 'LIVE',
        row: 'secret-names',
        machineId: null,
        image: null,
        readAt,
        detail: `${n} is a secret the template does not set`,
      });
    }
    for (const n of missing) {
      lines.push({
        verdict: 'MISSING',
        row: 'secret-names',
        machineId: null,
        image: null,
        readAt,
        detail: `${n} is a template name the app does not hold`,
      });
    }
    if (extra.length === 0 && missing.length === 0) {
      lines.push({
        verdict: 'PASS',
        row: 'secret-names',
        machineId: null,
        image: null,
        readAt,
        detail: `${names.size} names, exactly the template's`,
      });
    }
  } catch (err) {
    lines.push({
      verdict: 'UNREAD',
      row: 'secret-names',
      machineId: null,
      image: null,
      readAt: stamp(),
      detail: `could not read the secret names: ${(err as Error).message}`,
    });
  }

  // 3 + 5. Each machine's environment, every row.
  for (const machine of machines) {
    let menv: Map<string, string> | null = null;
    let failure = '';
    try {
      const read = await fly([
        'ssh',
        'console',
        '-a',
        app!,
        '--machine',
        machine.id,
        '-C',
        'printenv',
      ]);
      if (read.code !== 0) failure = `fly ssh exited ${read.code}`;
      else menv = parsePrintenv(read.stdout);
    } catch (err) {
      failure = (err as Error).message;
    }
    const readAt = stamp();
    const base = { machineId: machine.id, image: machine.image, readAt };
    const passed = new Map<RowId, boolean>();

    for (const row of SWITCH_TABLE) {
      if (row.coveredBy) continue;
      if (!menv) {
        lines.push({
          ...base,
          verdict: 'UNREAD',
          row: row.id,
          detail: `environment not read (${failure})`,
        });
        passed.set(row.id, false);
        continue;
      }
      const failures = row.keys
        .map((k) => evaluateKey(k, menv!, config))
        .filter((r) => !r.ok)
        .map((r) => r.reason);
      passed.set(row.id, failures.length === 0);
      lines.push({
        ...base,
        verdict: failures.length === 0 ? 'PASS' : 'LIVE',
        row: row.id,
        detail:
          failures.length === 0
            ? `${row.keys.length} keys at their sink state`
            : failures.join('; '),
      });
    }
    for (const row of SWITCH_TABLE) {
      if (!row.coveredBy) continue;
      const ok = passed.get(row.coveredBy) === true;
      lines.push({
        ...base,
        verdict: !menv ? 'UNREAD' : ok ? 'PASS' : 'LIVE',
        row: row.id,
        detail: `covered by ${row.coveredBy}`,
      });
    }
    if (menv) {
      const missing = REQUIRED_SET.map((r) => r.key).filter((k) => !menv!.has(k));
      lines.push({
        ...base,
        verdict: missing.length === 0 ? 'PASS' : 'MISSING',
        row: 'required-set',
        detail:
          missing.length === 0
            ? `${REQUIRED_SET.length} required names present`
            : `${missing.join(', ')} not set`,
      });
    } else {
      lines.push({
        ...base,
        verdict: 'UNREAD',
        row: 'required-set',
        detail: `environment not read (${failure})`,
      });
    }
  }
  return finish(lines);
}

function finish(lines: PreflightLine[]): PreflightOutcome {
  const live = lines.filter((l) => l.verdict === 'LIVE' || l.verdict === 'MISSING');
  const unread = lines.filter((l) => l.verdict === 'UNREAD');
  if (live.length > 0) {
    return {
      exitCode: EXIT.live,
      lines,
      message: `${live.length} live or missing: ${summarize(live)}`,
    };
  }
  if (unread.length > 0) {
    return {
      exitCode: EXIT.unread,
      lines,
      message: `${unread.length} unread: ${summarize(unread)}`,
    };
  }
  return { exitCode: EXIT.ok, lines, message: `${lines.length} checks passed` };
}

function summarize(lines: PreflightLine[]): string {
  return lines.map((l) => (l.machineId ? `${l.row}@${l.machineId}` : l.row)).join(', ');
}

/** One printed line. Names keys, machines, images and times — never a value. */
export function formatLine(l: PreflightLine): string {
  const where = l.machineId ? ` machine=${l.machineId} image=${l.image}` : '';
  return `${l.verdict.padEnd(7)} ${l.row.padEnd(18)}${where} read=${l.readAt} — ${l.detail}`;
}

/* v8 ignore start -- the process entry: spawning `fly`, printing and the exit code
   over `runPreflight`, which tests/loadtest/sideEffectPreflight.test.ts drives. */
export const spawnFly: FlyRunner = async (args) => {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const child = spawn('fly', [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => resolve({ code: 127, stdout, stderr: err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
};

if (/preflight[\\/]sideEffects\.ts$/.test(process.argv[1] ?? '')) {
  runPreflight(process.argv.slice(2), process.env, spawnFly)
    .then((outcome) => {
      for (const line of outcome.lines) process.stdout.write(`${formatLine(line)}\n`);
      process.stdout.write(
        `\n${outcome.exitCode === 0 ? 'OK' : `EXIT ${outcome.exitCode}`}: ${outcome.message}\n`,
      );
      process.exit(outcome.exitCode);
    })
    .catch((err: unknown) => {
      console.error(err);
      process.exit(EXIT.unread);
    });
}
/* v8 ignore stop */
