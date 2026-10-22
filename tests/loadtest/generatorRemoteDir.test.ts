import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult, Exec, FlyRunner } from '@/loadtest/run/fly';
import {
  prepareRemote,
  REMOTE_MANIFEST,
  REMOTE_POINTS,
  REMOTE_PROFILE,
  REMOTE_RUN_DIR,
  REMOTE_SCRIPT,
  REMOTE_SECRET_DIR,
  upload,
  type GeneratorRef,
} from '@/loadtest/run/generator';
import { EXIT, runLoadTest, type RunDeps } from '@/loadtest/run/run';
import { deps, fake, fakeExec, GEN_APP, k6Starts, resetFake, SMOKE_ARGS } from './fakePlatform';

// THE GENERATOR'S RUN DIRECTORY OUTLIVES A RUN (MOTIR-9268). `/data/run` sits on the
// generator's persistent volume (MOTIR-9116), and `fly ssh sftp put` refuses to write
// over an existing remote file (flyctl `internal/command/ssh/sftp.go`: "flyctl sftp
// doesn't overwrite existing files for safety", `O_WRONLY|O_CREATE|O_EXCL`). So every
// run after the first must start from an EMPTY run directory, or its uploads exit 1.
//
// The generator here is a real directory tree: a remote path is mapped under a temp
// root, `sh -c` scripts run in a real shell against it, and `sftp put` copies with
// `COPYFILE_EXCL` — the same refusal flyctl makes.

const REMOTE_ROOTS = [REMOTE_RUN_DIR, REMOTE_SECRET_DIR];

let root = '';
const local = (remote: string) => join(root, remote);
const remap = (script: string) => REMOTE_ROOTS.reduce((s, r) => s.split(r).join(local(r)), script);
/** The scripts that shape the run directory: prepareRemote's and the deletes. */
const shapesRemote = (s: string) =>
  REMOTE_ROOTS.some((r) => s.includes(r)) &&
  (s.includes('mkdir -p') || s.startsWith("sh -c 'rm -f"));

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });
const refused = (stderr: string): CommandResult => ({ code: 1, stdout: '', stderr });

/** `fly ssh sftp put`: never overwrites; `-R` walks a directory, `-m` sets a mode. */
function sftpPut(args: readonly string[]): CommandResult {
  const [src, dst] = args.slice(-2) as [string, string];
  const mode = args.includes('-m') ? args[args.indexOf('-m') + 1]! : null;
  const put = (from: string, to: string): CommandResult | null => {
    if (statSync(from).isDirectory()) {
      mkdirSync(local(to), { recursive: true });
      for (const name of readdirSync(from)) {
        const r = put(join(from, name), `${to}/${name}`);
        if (r) return r;
      }
      return null;
    }
    if (existsSync(local(to))) {
      return refused(
        `remote file ${to} already exists. flyctl sftp doesn't overwrite existing files for safety`,
      );
    }
    copyFileSync(from, local(to), constants.COPYFILE_EXCL);
    if (mode) chmodSync(local(to), Number.parseInt(mode, 8));
    return null;
  };
  if (!existsSync(src)) return refused(`${src}: no such file`);
  if (statSync(src).isDirectory() && !args.includes('-R')) return refused(`${src} is a directory`);
  return put(src, dst) ?? ok();
}

/** `fly ssh console -C "sh -c '…'"` run for real against the mapped tree. */
function shell(command: string): CommandResult {
  const script = /^sh -c '(.*)'$/s.exec(command)?.[1];
  if (script === undefined) return refused(`not a shell script: ${command}`);
  const r = spawnSync('sh', ['-c', remap(script)], { encoding: 'utf8' });
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
}

/** The generator's answer to a call on its remote run or secret directory, else null. */
function generatorAnswer(args: readonly string[]): CommandResult | null {
  if (args[0] === 'ssh' && args[1] === 'sftp' && args[2] === 'put') return sftpPut(args);
  if (args[0] === 'ssh' && args[1] === 'console') {
    const cmd = args[args.indexOf('-C') + 1]!;
    if (shapesRemote(cmd)) return shell(cmd);
  }
  return null;
}

/** Files under a remote directory, relative to it. */
function remoteFiles(remote: string): string[] {
  const base = local(remote);
  if (!existsSync(base)) return [];
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : [relative(base, p)];
    });
  return walk(base).sort();
}

/** What an earlier run left on the volume: its k6 tree, profile, script and points. */
function leaveEarlierRun(): void {
  const files = {
    [`${REMOTE_RUN_DIR}/k6/main.js`]: '// run A\n',
    [REMOTE_PROFILE]: '{"run":"A"}',
    [REMOTE_SCRIPT]: '#!/bin/sh\n# run A\n',
    [REMOTE_POINTS]: 'run A points',
    [`${REMOTE_RUN_DIR}/summary.json`]: '{"run":"A"}',
  };
  for (const [remote, body] of Object.entries(files)) {
    mkdirSync(dirname(local(remote)), { recursive: true });
    writeFileSync(local(remote), body);
  }
}

/** The operator side of a run: the k6 tree, the resolved profile, the script, the manifest. */
function operatorFiles() {
  const dir = mkdtempSync(join(tmpdir(), 'loadtest-operator-'));
  mkdirSync(join(dir, 'k6/lib'), { recursive: true });
  writeFileSync(join(dir, 'k6/main.js'), '// run B\n');
  writeFileSync(join(dir, 'k6/lib/agents.js'), '// run B\n');
  writeFileSync(join(dir, 'profile.resolved.json'), '{"run":"B"}');
  writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\n# run B\n');
  writeFileSync(join(dir, 'manifest.json'), '{"secret":"B"}');
  return dir;
}

/** The upload sequence `runLoadTest` makes after `prepareRemote` (run.ts, step 9). */
async function uploadRun(g: GeneratorRef, dir: string): Promise<void> {
  await prepareRemote(g);
  await upload(g, join(dir, 'k6'), `${REMOTE_RUN_DIR}/k6`, { recursive: true });
  await upload(g, join(dir, 'profile.resolved.json'), REMOTE_PROFILE);
  await upload(g, join(dir, 'run.sh'), REMOTE_SCRIPT);
  await upload(g, join(dir, 'manifest.json'), REMOTE_MANIFEST, { mode: '0600' });
}

const generatorFly: FlyRunner = async (args) =>
  generatorAnswer(args) ?? refused(`unexpected fly ${args.join(' ')}`);
const generator = (): GeneratorRef => ({ fly: generatorFly, app: GEN_APP, id: 'gen1' });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'loadtest-generator-'));
});

describe('the stubbed generator refuses an overwrite, as flyctl does', () => {
  it('a second put of the same remote file exits 1', async () => {
    const dir = operatorFiles();
    mkdirSync(local(REMOTE_RUN_DIR), { recursive: true });
    await upload(generator(), join(dir, 'run.sh'), REMOTE_SCRIPT);
    await expect(upload(generator(), join(dir, 'run.sh'), REMOTE_SCRIPT)).rejects.toThrow(
      /uploading .*run\.sh exited 1/,
    );
  });
});

describe('prepareRemote starts every run from an empty run directory (MOTIR-9268)', () => {
  it('a run after an earlier one uploads its own k6 tree, profile, script and manifest', async () => {
    leaveEarlierRun();
    await uploadRun(generator(), operatorFiles());
    expect(remoteFiles(REMOTE_RUN_DIR)).toEqual([
      'k6/lib/agents.js',
      'k6/main.js',
      'profile.resolved.json',
      'run.sh',
    ]);
  });

  it('leaves no file of an earlier run, so its k6-points.json.gz cannot be fetched as this run’s', async () => {
    leaveEarlierRun();
    await prepareRemote(generator());
    expect(remoteFiles(REMOTE_RUN_DIR)).toEqual([]);
    expect(existsSync(local(REMOTE_POINTS))).toBe(false);
    expect(statSync(local(REMOTE_RUN_DIR)).isDirectory()).toBe(true);
  });

  it('two runs back to back both upload', async () => {
    await uploadRun(generator(), operatorFiles());
    // The secret dir is tmpfs: the machine stop between runs empties it.
    for (const f of remoteFiles(REMOTE_SECRET_DIR)) {
      spawnSync('rm', ['-f', join(local(REMOTE_SECRET_DIR), f)]);
    }
    await expect(uploadRun(generator(), operatorFiles())).resolves.toBeUndefined();
  });

  it('the manifest still lands in /dev/shm/loadtest with mode 0600, in a 0700 directory', async () => {
    leaveEarlierRun();
    await uploadRun(generator(), operatorFiles());
    expect(statSync(local(REMOTE_MANIFEST)).mode & 0o777).toBe(0o600);
    expect(statSync(local(REMOTE_SECRET_DIR)).mode & 0o777).toBe(0o700);
  });
});

describe('the run command over a generator holding an earlier run (MOTIR-9268)', () => {
  beforeEach(() => {
    resetFake();
  });

  it('uploads, starts k6 and completes instead of exiting 5 at the profile upload', async () => {
    leaveEarlierRun();
    const exec: Exec = async (bin, args, opts) => {
      const a = bin === 'fly' ? generatorAnswer(args) : null;
      if (!a) return fakeExec(bin, args, opts);
      fake.world.calls.push({ bin, args: [...args] });
      return a;
    };
    // The stubbed seed writes no manifest; the real one does, and it is uploaded.
    const seed: RunDeps['seed'] = async (_command, args) => {
      if (args.includes('--out')) writeFileSync(args[args.indexOf('--out') + 1]!, '{}');
      return 0;
    };
    const out = await runLoadTest(SMOKE_ARGS, deps({ exec, seed }));
    expect(out.exitCode).toBe(EXIT.completed);
    expect(k6Starts()).toHaveLength(1);
    // This run's files only: run A's k6/main.js, summary.json and point file are gone.
    expect(remoteFiles(REMOTE_RUN_DIR)).toEqual([
      'k6/versions.env',
      'profile.resolved.json',
      'run.sh',
    ]);
    expect(readFileSync(local(REMOTE_PROFILE), 'utf8')).toBe(
      readFileSync(join(out.runDir!, 'profile.resolved.json'), 'utf8'),
    );
  });
});
