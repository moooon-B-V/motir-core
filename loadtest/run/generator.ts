// THE GENERATOR MACHINE (Story MOTIR-8538 · MOTIR-8678).
//
// k6 runs on a machine of `LOADTEST_GENERATOR_APP` in `iad`, never on the operator
// machine: staging is private (flycast only) and the generator is the one place
// with a route to it. Provisioning leaves the machine STOPPED between runs; the run
// command starts it here and stops it again in a `finally`, whatever happens.
//
//   start → wait for `started` → check `/opt/loadtest/k6 version` against
//   versions.env → upload the k6 tree, the resolved profile and a run script
//   (`fly ssh sftp put`), the manifest into tmpfs with mode 0600 → start the run
//   script DETACHED (`setsid nohup`), so a dropped SSH session cannot kill a long
//   run → poll its exit file every 10 s, streaming new k6.log lines → fetch
//   summary.json, generator-cpu.csv and k6.log → delete the manifest.
//
// k6 runs with `K6_AUTO_EXTENSION_RESOLUTION=false` and no threshold option. k6
// exits 99 when a threshold fails; with none given it has none to fail, and 99 is
// still read as completed, so an option added later cannot turn a completed run
// into a failed one.
//
// ⚠️ HYPOTHESIS, to check on the first real run: a machine of an app with no
// `[http_service]` stays up after `start` and stays stopped after `stop` (Fly's
// documentation is silent on a services-less app).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  listMachines,
  PlatformReadError,
  shScript,
  sshArgs,
  startMachine,
  stopMachine,
  type FlyRunner,
  type Machine,
} from './fly';

export const GENERATOR_REGION = 'iad';
export const REMOTE_K6 = '/opt/loadtest/k6';
export const REMOTE_RUN_DIR = '/data/run';
/** tmpfs: the manifest never touches the generator's disk. */
export const REMOTE_SECRET_DIR = '/dev/shm/loadtest';
export const REMOTE_MANIFEST = `${REMOTE_SECRET_DIR}/manifest.json`;
export const REMOTE_PROFILE = `${REMOTE_RUN_DIR}/profile.resolved.json`;
export const REMOTE_SCRIPT = `${REMOTE_RUN_DIR}/run.sh`;
/** k6's raw points, on the generator's VOLUME (tmpfs is RAM); a `.gz` name gzips them. */
export const REMOTE_POINTS = `${REMOTE_RUN_DIR}/k6-points.json.gz`;
/** Where the generator's volume must be mounted. */
export const VOLUME_MOUNT = '/data';
/** k6 exit codes read as "the run completed": none, and a failed threshold. */
export const K6_COMPLETED_CODES = [0, 99] as const;
/** The files fetched back into the run directory. */
export const FETCHED_FILES = [
  'summary.json',
  'generator-cpu.csv',
  'k6.log',
  'k6-points.json.gz',
] as const;

export interface GeneratorRef {
  fly: FlyRunner;
  app: string;
  id: string;
}

/** The generator app's machine: the first by id. */
export function pickGenerator(machines: readonly Machine[]): Machine | null {
  return [...machines].sort((a, b) => a.id.localeCompare(b.id))[0] ?? null;
}

/** Start the machine and wait until `fly machine list` reads it `started`. */
export async function startAndWait(
  g: GeneratorRef,
  opts: {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    timeoutMs: number;
    pollMs?: number;
  },
): Promise<Machine> {
  await startMachine(g.fly, g.app, g.id);
  const deadline = opts.now() + opts.timeoutMs;
  for (;;) {
    const m = (await listMachines(g.fly, g.app)).find((x) => x.id === g.id);
    if (m?.state === 'started') return m;
    if (opts.now() >= deadline) {
      throw new PlatformReadError(
        `generator ${g.id} did not reach started within ${Math.round(opts.timeoutMs / 1000)} s (state ${m?.state ?? 'missing'})`,
      );
    }
    await opts.sleep(opts.pollMs ?? 5000);
  }
}

export async function stopGenerator(g: GeneratorRef): Promise<void> {
  await stopMachine(g.fly, g.app, g.id);
}

/** Parse `k6 version`: `k6 v1.2.1 (…)` then an `Extensions:` list. */
export function parseK6Version(stdout: string): { version: string | null; extensions: string[] } {
  const version = /k6 (v\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? null;
  const extensions = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\S+ v\d+\.\d+\.\d+/.test(l) && !l.startsWith('k6 '))
    .map((l) => l.split(',')[0]!.trim());
  return { version, extensions };
}

/** `loadtest/k6/versions.env` as a map. */
export function parseVersionsEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

/** Why the binary is not the pinned build, or null when it is. */
export function k6VersionMismatch(
  found: { version: string | null; extensions: string[] },
  pinned: Record<string, string>,
): string | null {
  const want = pinned['K6_VERSION'];
  const sse = `${pinned['XK6_SSE_MODULE']} ${pinned['XK6_SSE_VERSION']}`;
  if (found.version !== want)
    return `k6 is ${found.version ?? 'unreadable'}, versions.env pins ${want}`;
  if (!found.extensions.includes(sse)) {
    return `the k6 binary lacks ${sse} (has: ${found.extensions.join('; ') || 'no extensions'})`;
  }
  return null;
}

export async function readK6Version(g: GeneratorRef) {
  const r = await g.fly(sshArgs(g.app, g.id, `${REMOTE_K6} version`));
  if (r.code !== 0) throw new PlatformReadError(`${REMOTE_K6} version exited ${r.code}`);
  return parseK6Version(r.stdout);
}

export async function readPinnedVersions(cwd: string): Promise<Record<string, string>> {
  return parseVersionsEnv(await readFile(join(cwd, 'loadtest/k6/versions.env'), 'utf8'));
}

/** The k6 command line the run script runs. No threshold option, ever. */
export function k6CommandLine(extraOut: readonly string[] = [`json=${REMOTE_POINTS}`]): string {
  return [
    `K6_AUTO_EXTENSION_RESOLUTION=false ${REMOTE_K6} run`,
    `-e LOADTEST_PROFILE=${REMOTE_PROFILE}`,
    `-e LOADTEST_MANIFEST=${REMOTE_MANIFEST}`,
    `--summary-export ${REMOTE_RUN_DIR}/summary.json`,
    ...extraOut.map((o) => `--out ${o}`),
    `${REMOTE_RUN_DIR}/k6/main.js`,
  ].join(' ');
}

/** The run script uploaded to the generator: a CPU sampler beside k6, an exit file at the end. */
export function runScript(extraOut: readonly string[] = [`json=${REMOTE_POINTS}`]): string {
  return [
    '#!/bin/sh',
    '# Written by loadtest/run/generator.ts (MOTIR-8678). Runs detached under setsid nohup.',
    `cd ${REMOTE_RUN_DIR} || exit 1`,
    'rm -f k6.exit k6.log summary.json generator-cpu.csv started.at ended.at k6-points.json.gz',
    'date -u +%Y-%m-%dT%H:%M:%SZ > started.at',
    'echo "epochSeconds,nproc,procStatCpu" > generator-cpu.csv',
    '( while [ ! -f k6.exit ]; do echo "$(date -u +%s),$(nproc),$(head -n 1 /proc/stat)" >> generator-cpu.csv; sleep 5; done ) &',
    `${k6CommandLine(extraOut)} > k6.log 2>&1`,
    'code=$?',
    'date -u +%Y-%m-%dT%H:%M:%SZ > ended.at',
    'echo "$code" > k6.exit',
    '',
  ].join('\n');
}

/**
 * Prepare the remote directories (the secret one 0700, on tmpfs). The run directory
 * is on the generator's volume, so an earlier run's files are still there, and
 * `fly ssh sftp put` refuses to overwrite a remote file: every run starts from an
 * EMPTY run directory (MOTIR-9268), which also keeps an earlier run's point file
 * from being fetched as this run's.
 */
export async function prepareRemote(g: GeneratorRef): Promise<void> {
  const r = await g.fly(
    sshArgs(
      g.app,
      g.id,
      shScript(
        `rm -rf ${REMOTE_RUN_DIR} && mkdir -p ${REMOTE_RUN_DIR} ${REMOTE_SECRET_DIR} && chmod 700 ${REMOTE_SECRET_DIR}`,
      ),
    ),
  );
  if (r.code !== 0)
    throw new PlatformReadError(`preparing ${REMOTE_RUN_DIR} on the generator exited ${r.code}`);
}

/** `fly ssh sftp put` one local path (`-R` for a directory, `-m` for a mode). */
export async function upload(
  g: GeneratorRef,
  local: string,
  remote: string,
  opts: { recursive?: boolean; mode?: string } = {},
): Promise<void> {
  const args = ['ssh', 'sftp', 'put', '--machine', g.id, '-a', g.app];
  if (opts.recursive) args.push('-R');
  if (opts.mode) args.push('-m', opts.mode);
  args.push(local, remote);
  const r = await g.fly(args);
  if (r.code !== 0) throw new PlatformReadError(`uploading ${local} exited ${r.code}`);
}

export async function download(g: GeneratorRef, remote: string, local: string): Promise<boolean> {
  const r = await g.fly(['ssh', 'sftp', 'get', '--machine', g.id, '-a', g.app, remote, local]);
  return r.code === 0;
}

/** Start the run script detached; the SSH session returns at once. */
export async function startDetached(g: GeneratorRef): Promise<void> {
  const r = await g.fly(
    sshArgs(g.app, g.id, shScript(`setsid nohup sh ${REMOTE_SCRIPT} > /dev/null 2>&1 &`)),
  );
  if (r.code !== 0) throw new PlatformReadError(`starting k6 on the generator exited ${r.code}`);
}

export interface PollState {
  /** k6's exit code once the exit file exists. */
  exitCode: number | null;
  newLines: string[];
  linesSeen: number;
}

/** One poll: k6.log lines after `linesSeen`, and the exit file if it exists. */
export async function pollOnce(g: GeneratorRef, linesSeen: number): Promise<PollState> {
  const r = await g.fly(
    sshArgs(
      g.app,
      g.id,
      shScript(
        `tail -n +${linesSeen + 1} ${REMOTE_RUN_DIR}/k6.log 2>/dev/null; echo "@@exit $(cat ${REMOTE_RUN_DIR}/k6.exit 2>/dev/null)"`,
      ),
    ),
  );
  if (r.code !== 0) return { exitCode: null, newLines: [], linesSeen };
  const lines = r.stdout.replace(/\r/g, '').replace(/\n+$/, '').split('\n');
  const marker = lines.pop() ?? '';
  const code = /^@@exit (\d+)$/.exec(marker.trim());
  return {
    exitCode: code ? Number(code[1]) : null,
    newLines: lines,
    linesSeen: linesSeen + lines.length,
  };
}

/** A remote file's first line (`started.at`, `ended.at`), or null. */
export async function readRemoteLine(g: GeneratorRef, path: string): Promise<string | null> {
  const r = await g.fly(sshArgs(g.app, g.id, `cat ${path}`));
  if (r.code !== 0) return null;
  return r.stdout.trim().split('\n')[0] || null;
}

/** Delete the uploaded manifest. Returns whether the generator confirmed it is gone. */
export async function deleteManifest(g: GeneratorRef): Promise<boolean> {
  const r = await g.fly(
    sshArgs(g.app, g.id, shScript(`rm -f ${REMOTE_MANIFEST} && test ! -e ${REMOTE_MANIFEST}`)),
  );
  return r.code === 0;
}

/** Whether a volume is mounted at `/data` on the generator (the point file lives there). */
export async function hasVolume(g: GeneratorRef): Promise<boolean> {
  const r = await g.fly(
    sshArgs(g.app, g.id, shScript(`grep -qs " ${VOLUME_MOUNT} " /proc/mounts`)),
  );
  return r.code === 0;
}

/** Delete the point file on the generator once it is fetched (or the run failed). */
export async function deletePoints(g: GeneratorRef): Promise<boolean> {
  const r = await g.fly(
    sshArgs(g.app, g.id, shScript(`rm -f ${REMOTE_POINTS} && test ! -e ${REMOTE_POINTS}`)),
  );
  return r.code === 0;
}
