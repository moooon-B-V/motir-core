// THE FLY READS AND WRITES THE RUN COMMAND MAKES (Story MOTIR-8538 · MOTIR-8678).
//
// Everything goes through an injected runner, so the run command is testable
// without Fly. Only the fields below are parsed; the rest of the JSON is ignored.
//
// ── THE MACHINE JSON (`fly machine list --json`) ─────────────────────────────
// Field names and defaults are the Fly Machines API's machine config
// (docs.fly.io/machines/api/machines-resource, read 2026-10-15):
//   config.metadata.fly_process_group     the process group (`app`, `worker`)
//   config.guest { cpu_kind, cpus, memory_mb }
//   config.services[]:
//     autostop     "off" | false (the default) · "stop" | true · "suspend"
//     autostart    boolean, default false
//     min_machines_running   applies only when autostart is true — NOT checked
//     concurrency  { type: "connections" (default) | "requests",
//                    soft_limit (default 20 when unset), hard_limit (unlimited when unset) }
//   image_ref { registry, repository, tag, digest }
//   region, state
// ⚠️ The unit fixtures are built from these documented shapes. No flyctl was
// reachable where this was written, so the first real run must compare one
// `fly machine list --json` response against them (MOTIR-8678's recorded
// discrepancy).

import { spawn } from 'node:child_process';
import { endpointHost } from '../lib/endpointHost';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `<bin> <args>` with no shell. Injected so the logic is testable. */
export type Exec = (
  bin: string,
  args: readonly string[],
  opts?: { env?: Readonly<Record<string, string | undefined>> },
) => Promise<CommandResult>;

/** `fly <args>` over an `Exec`. */
export type FlyRunner = (args: readonly string[]) => Promise<CommandResult>;

export const flyOf =
  (exec: Exec): FlyRunner =>
  (args) =>
    exec('fly', args);

/* v8 ignore start -- the production process runner; tests inject a stub. */
export const spawnExec: Exec = (bin, args, opts) =>
  new Promise((resolveResult) => {
    const child = spawn(bin, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => resolveResult({ code: 127, stdout, stderr: err.message }));
    child.on('close', (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
  });
/* v8 ignore stop */

export class PlatformReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlatformReadError';
  }
}

export interface ServiceConcurrency {
  type: string;
  softLimit: number | null;
  hardLimit: number | null;
}

export interface MachineService {
  internalPort: number | null;
  /** Normalised: `off` | `stop` | `suspend`. */
  autostop: string;
  autostart: boolean;
  minMachinesRunning: number | null;
  concurrency: ServiceConcurrency;
}

export interface Machine {
  id: string;
  state: string;
  group: string;
  region: string;
  cpuKind: string;
  cpus: number | null;
  memoryMb: number | null;
  /** `registry/repository:tag` (or the digest when there is no tag). */
  imageRef: string;
  imageTag: string | null;
  services: MachineService[];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, fallback = 'unknown') => (typeof v === 'string' && v ? v : fallback);

/** `autostop` as one word: `false`/missing → off, `true` → stop, a string as itself. */
export function normaliseAutostop(v: unknown): string {
  if (v === undefined || v === null || v === false) return 'off';
  if (v === true) return 'stop';
  return String(v);
}

function parseService(raw: unknown): MachineService {
  const s = obj(raw);
  const c = obj(s['concurrency']);
  return {
    internalPort: num(s['internal_port']),
    autostop: normaliseAutostop(s['autostop']),
    autostart: s['autostart'] === true,
    minMachinesRunning: num(s['min_machines_running']),
    concurrency: {
      type: str(c['type'], 'connections'),
      softLimit: num(c['soft_limit']),
      hardLimit: num(c['hard_limit']),
    },
  };
}

/** Parse `fly machine list --json`. Throws `PlatformReadError` on anything but a machine array. */
export function parseMachines(stdout: string): Machine[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new PlatformReadError('fly machine list did not return JSON');
  }
  if (!Array.isArray(parsed))
    throw new PlatformReadError('fly machine list did not return an array');
  return parsed.map((raw) => {
    const m = obj(raw);
    const config = obj(m['config']);
    const guest = obj(config['guest']);
    const ref = obj(m['image_ref']);
    const tag = typeof ref['tag'] === 'string' && ref['tag'] ? String(ref['tag']) : null;
    const repo = [ref['registry'], ref['repository']]
      .filter((p) => typeof p === 'string' && p)
      .join('/');
    const imageRef = repo && tag ? `${repo}:${tag}` : str(ref['digest'], str(config['image']));
    const services = Array.isArray(config['services']) ? config['services'].map(parseService) : [];
    return {
      id: str(m['id']),
      state: str(m['state']),
      group: str(obj(config['metadata'])['fly_process_group'], 'app'),
      region: str(m['region']),
      cpuKind: str(guest['cpu_kind']),
      cpus: num(guest['cpus']),
      memoryMb: num(guest['memory_mb']),
      imageRef,
      imageTag: tag,
      services,
    };
  });
}

/** `fly machine list --json -a <app>`, parsed. */
export async function listMachines(fly: FlyRunner, app: string): Promise<Machine[]> {
  const r = await fly(['machine', 'list', '--json', '-a', app]);
  if (r.code !== 0) throw new PlatformReadError(`fly machine list -a ${app} exited ${r.code}`);
  return parseMachines(r.stdout);
}

export interface GroupState {
  machines: Machine[];
  started: Machine[];
  notStarted: Machine[];
}

/** One process group's machines, split by whether they are `started`. */
export function groupState(machines: readonly Machine[], group = 'app'): GroupState {
  const inGroup = machines.filter((m) => m.group === group);
  return {
    machines: inGroup,
    started: inGroup.filter((m) => m.state === 'started'),
    notStarted: inGroup.filter((m) => m.state !== 'started'),
  };
}

/** The two spellings of a per-group scale, in the order they are tried. */
export const SCALE_SPELLINGS = {
  groupEquals: (n: number, app: string) => ['scale', 'count', `app=${n}`, '-a', app, '--yes'],
  groupFlag: (n: number, app: string) => [
    'scale',
    'count',
    String(n),
    '--process-group',
    'app',
    '-a',
    app,
    '--yes',
  ],
} as const;

/**
 * `fly scale count app=<n>` — or, when the installed flyctl refuses that form,
 * `fly scale count <n> --process-group app`. Returns the spelling that worked.
 * ⚠️ The caller never calls this when the group is already at n: `fly.toml`'s
 * `[processes]` note records that a no-op scale can destroy the standby.
 */
export async function scaleGroup(
  fly: FlyRunner,
  app: string,
  n: number,
): Promise<keyof typeof SCALE_SPELLINGS> {
  const first = await fly(SCALE_SPELLINGS.groupEquals(n, app));
  if (first.code === 0) return 'groupEquals';
  const second = await fly(SCALE_SPELLINGS.groupFlag(n, app));
  if (second.code === 0) return 'groupFlag';
  throw new PlatformReadError(
    `fly scale count refused both spellings for ${app} (exits ${first.code}, ${second.code})`,
  );
}

export async function startMachine(fly: FlyRunner, app: string, id: string): Promise<void> {
  const r = await fly(['machine', 'start', id, '-a', app]);
  if (r.code !== 0)
    throw new PlatformReadError(`fly machine start ${id} -a ${app} exited ${r.code}`);
}

export async function stopMachine(fly: FlyRunner, app: string, id: string): Promise<void> {
  const r = await fly(['machine', 'stop', id, '-a', app]);
  if (r.code !== 0)
    throw new PlatformReadError(`fly machine stop ${id} -a ${app} exited ${r.code}`);
}

/** `fly ssh console -C <command>` on one machine. */
export function sshArgs(app: string, machineId: string, command: string): string[] {
  return ['ssh', 'console', '-a', app, '--machine', machineId, '-C', command];
}

/**
 * Wrap a script that uses shell syntax for `fly ssh console -C`, which does NOT run
 * its string through a shell. The script is single-quoted, so it may not contain a
 * single quote itself (refused, never escaped).
 */
export function shScript(script: string): string {
  if (script.includes("'")) throw new Error('a remote script may not contain a single quote');
  return `sh -c '${script}'`;
}

/**
 * One environment variable as a machine runs with it (`printenv NAME`, no shell).
 * `null` when unset (`printenv` exits 1); throws when the read itself failed.
 */
export async function readEnv(
  fly: FlyRunner,
  app: string,
  machineId: string,
  name: string,
): Promise<string | null> {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name))
    throw new Error(`not an environment variable name: ${name}`);
  const r = await fly(sshArgs(app, machineId, `printenv ${name}`));
  if (r.code === 0) return r.stdout.replace(/\r/g, '').replace(/\n+$/, '');
  if (r.code === 1 && r.stdout.trim() === '') return null;
  throw new PlatformReadError(`reading ${name} on ${machineId} exited ${r.code}`);
}

/** The endpoint host of a URL a machine holds — the URL itself is never returned. */
export async function readEnvHost(
  fly: FlyRunner,
  app: string,
  machineId: string,
  name: string,
): Promise<string | null> {
  return endpointHost(await readEnv(fly, app, machineId, name));
}
