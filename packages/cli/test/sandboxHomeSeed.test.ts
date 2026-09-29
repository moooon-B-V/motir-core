import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The persistent-home seed (MOTIR-6887, `docs/decisions/agent-instances.md` §1).
// A user agent instance mounts a volume over the image's HOME, so the image
// keeps a copy of its build-time home and the entrypoint adds back whatever the
// mounted home lacks. These tests RUN the seed script against temporary
// directories — the three cases the card names — and then guard where the
// Dockerfile and the entrypoint put it. The container-level proof is
// `smoke/home-seed-smoke.sh`, legs 4 and 5 of the smoke driver.

const SANDBOX_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'sandbox');
const SEED_SCRIPT = join(SANDBOX_DIR, 'seed-home.sh');
const read = (name: string): string => readFileSync(join(SANDBOX_DIR, name), 'utf8');

let root: string;
let seed: string;
let home: string;

/** A seed shaped like the image's: the agent config home, the `.bashrc` hook, an empty config dir. */
function buildSeed(): void {
  mkdirSync(join(seed, '.motir-sandbox', 'agent-config', '.claude'), { recursive: true });
  writeFileSync(join(seed, '.motir-sandbox', 'agent-config', '.claude', 'settings.json'), '{}\n');
  writeFileSync(
    join(seed, '.bashrc'),
    '[ -r /etc/profile.d/motir-sandbox-agent-config.sh ] && . /etc/profile.d/motir-sandbox-agent-config.sh\n',
  );
  mkdirSync(join(seed, '.config', 'motir'), { recursive: true });
  mkdirSync(join(seed, 'with space'), { recursive: true });
  writeFileSync(join(seed, 'with space', 'file'), 'x');
}

function runSeed(args: string[] = [seed, home]): string {
  return execFileSync('bash', [SEED_SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' });
}

/** Every path under a directory, relative, sorted — the shape to compare two trees by. */
function tree(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      return entry.isDirectory() ? [rel, ...tree(join(dir, entry.name), rel)] : [rel];
    })
    .sort();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'home-seed-'));
  seed = join(root, 'seed');
  home = join(root, 'home');
  mkdirSync(seed);
  mkdirSync(home);
  buildSeed();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('seed-home.sh', () => {
  it('fills an EMPTY home with the whole seed — the agent config home and the .bashrc hook', () => {
    runSeed();
    expect(tree(home)).toEqual(tree(seed));
    expect(readFileSync(join(home, '.bashrc'), 'utf8')).toContain('motir-sandbox-agent-config.sh');
    expect(
      readFileSync(
        join(home, '.motir-sandbox', 'agent-config', '.claude', 'settings.json'),
        'utf8',
      ),
    ).toBe('{}\n');
  });

  it('keeps a modified .bashrc and a user file BYTE-FOR-BYTE, and adds only what is missing', () => {
    writeFileSync(join(home, '.bashrc'), '# mine\nalias ll="ls -la"\n');
    writeFileSync(join(home, 'notes.txt'), 'the user wrote this');
    runSeed();
    expect(readFileSync(join(home, '.bashrc'), 'utf8')).toBe('# mine\nalias ll="ls -la"\n');
    expect(readFileSync(join(home, 'notes.txt'), 'utf8')).toBe('the user wrote this');
    // An OLDER home gains the newer image's files it lacks.
    expect(
      readFileSync(
        join(home, '.motir-sandbox', 'agent-config', '.claude', 'settings.json'),
        'utf8',
      ),
    ).toBe('{}\n');
  });

  it('is a no-op on a home that already holds every seed file — the ordinary run with no volume', () => {
    runSeed();
    const before = tree(home).map((rel) => [rel, statSync(join(home, rel)).mtimeMs]);
    runSeed();
    expect(tree(home).map((rel) => [rel, statSync(join(home, rel)).mtimeMs])).toEqual(before);
  });

  it('never touches an existing DIRECTORY, so a read-only mount inside the home cannot fail the boot', () => {
    // `$HOME/.config/motir` is mounted `:ro` by the documented recipe. A
    // recursive `cp -a --no-clobber` would re-apply attributes to it and die
    // with EROFS; the entry-wise walk leaves an existing directory alone.
    mkdirSync(join(home, '.config', 'motir'), { recursive: true });
    chmodSync(join(home, '.config', 'motir'), 0o555);
    try {
      expect(() => runSeed()).not.toThrow();
      expect(statSync(join(home, '.config', 'motir')).mode & 0o777).toBe(0o555);
      expect(readFileSync(join(home, '.bashrc'), 'utf8')).toContain(
        'motir-sandbox-agent-config.sh',
      );
    } finally {
      chmodSync(join(home, '.config', 'motir'), 0o755);
    }
  });

  it('keeps a symlink the user left in place of a seed file, even a dangling one', () => {
    symlinkSync(join(root, 'nowhere'), join(home, '.bashrc'));
    runSeed();
    expect(() => readFileSync(join(home, '.bashrc'))).toThrow();
  });

  it('exits 0 when an entry cannot be written, and names it', () => {
    // A home whose one subdirectory is unwritable: the seed reports what it
    // could not add and still exits 0, because a boot that dies here leaves the
    // user with no shell to repair it from.
    mkdirSync(join(home, 'with space'));
    chmodSync(join(home, 'with space'), 0o555);
    try {
      // `2>&1 >/dev/null` hands back stderr alone; execFileSync throws on a
      // non-zero exit, so returning at all proves the exit code.
      const stderr = execFileSync(
        'bash',
        ['-c', 'bash "$0" "$1" "$2" 2>&1 >/dev/null', SEED_SCRIPT, seed, home],
        { encoding: 'utf8' },
      );
      if (process.getuid?.() !== 0) expect(stderr).toContain('could not seed');
      expect(readFileSync(join(home, '.bashrc'), 'utf8')).toContain(
        'motir-sandbox-agent-config.sh',
      );
    } finally {
      chmodSync(join(home, 'with space'), 0o755);
    }
  });

  it('does nothing when the image carries no seed', () => {
    expect(() => runSeed([join(root, 'absent'), home])).not.toThrow();
    expect(tree(home)).toEqual([]);
  });
});

describe('the seed in the image', () => {
  const dockerfile = read('Dockerfile');
  const entrypoint = read('entrypoint.sh');

  it('copies the home to /opt/motir-home-seed AFTER the last write to it and BEFORE `USER node`', () => {
    const copy = dockerfile.indexOf('cp -a /home/node /opt/motir-home-seed');
    expect(copy).toBeGreaterThan(-1);
    // The `.bashrc` hook and the whole-home chown are the last layers that
    // write into /home/node; a seed taken before them would miss their files.
    expect(copy).toBeGreaterThan(dockerfile.indexOf('>> /home/node/.bashrc'));
    expect(copy).toBeGreaterThan(dockerfile.indexOf('chown -R node:node /workspace /home/node'));
    expect(copy).toBeLessThan(dockerfile.indexOf('\nUSER node'));
    expect(dockerfile).toContain('chown -R node:node /opt/motir-home-seed');
    expect(dockerfile).toContain('chmod -R go-w /opt/motir-home-seed');
    expect(dockerfile).toContain(
      'COPY --chmod=0755 packages/cli/sandbox/seed-home.sh /usr/local/bin/motir-sandbox-seed-home',
    );
  });

  it('seeds in the entrypoint BEFORE anything reads $HOME, and never lets it fail the boot', () => {
    const seedCall = entrypoint.indexOf('motir-sandbox-seed-home || true');
    expect(seedCall).toBeGreaterThan(-1);
    expect(seedCall).toBeLessThan(entrypoint.indexOf('motir-sandbox-agent-config || true'));
    expect(seedCall).toBeLessThan(entrypoint.indexOf('. "$SANDBOX_AGENT_HOME/env.sh"'));
    expect(seedCall).toBeLessThan(entrypoint.indexOf('CONFIG_DIR='));
  });
});
