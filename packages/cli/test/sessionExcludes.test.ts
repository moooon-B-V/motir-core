import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addExclude,
  clearExcludes,
  excludesPath,
  readExcludes,
  removeExclude,
  removeExcludeByKey,
  scopeKey,
} from '../src/sessionExcludes.js';

// The session exclude list, against the real filesystem with MOTIR_CONFIG_HOME
// pointed at a temp dir (the same seam the credential-store tests use). It must
// SURVIVE a process boundary — that is its entire reason to exist, since each
// `motir next` is its own short-lived process.

const SERVER = 'https://app.motir.co';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'motir-exc-'));
  process.env['MOTIR_CONFIG_HOME'] = home;
});

afterEach(() => {
  delete process.env['MOTIR_CONFIG_HOME'];
  rmSync(home, { recursive: true, force: true });
});

describe('sessionExcludes', () => {
  it('reads empty when nothing has been recorded', () => {
    expect(readExcludes(SERVER, 'PROD')).toEqual([]);
  });

  it('persists an exclusion across "processes" (a fresh read of the file)', () => {
    addExclude(SERVER, 'PROD', { id: 'row1', key: 'PROD-7' });
    expect(readExcludes(SERVER, 'PROD')).toEqual([{ id: 'row1', key: 'PROD-7' }]);
  });

  it('is idempotent by id', () => {
    addExclude(SERVER, 'PROD', { id: 'row1', key: 'PROD-7' });
    addExclude(SERVER, 'PROD', { id: 'row1', key: 'PROD-7' });
    expect(readExcludes(SERVER, 'PROD')).toHaveLength(1);
  });

  it('scopes by server AND project — one project never hides another’s work', () => {
    addExclude(SERVER, 'PROD', { id: 'row1', key: 'PROD-7' });
    expect(readExcludes(SERVER, 'OTHER')).toEqual([]);
    expect(readExcludes('https://other.example', 'PROD')).toEqual([]);
  });

  it('normalizes the server URL and the project key when scoping', () => {
    expect(scopeKey('https://app.motir.co/', 'prod')).toBe(scopeKey(SERVER, 'PROD'));
    addExclude('https://app.motir.co/', 'prod', { id: 'row1', key: 'PROD-7' });
    expect(readExcludes(SERVER, 'PROD')).toHaveLength(1);
  });

  it('removes by id and by key, so a fixed item stops being skipped', () => {
    addExclude(SERVER, 'PROD', { id: 'row1', key: 'PROD-7' });
    addExclude(SERVER, 'PROD', { id: 'row2', key: 'PROD-8' });
    expect(removeExclude(SERVER, 'PROD', 'row1')).toBe(true);
    expect(removeExclude(SERVER, 'PROD', 'row1')).toBe(false);
    expect(removeExcludeByKey(SERVER, 'PROD', 'prod-8')).toBe(true);
    expect(readExcludes(SERVER, 'PROD')).toEqual([]);
  });

  it('clears the whole list and reports how many went', () => {
    addExclude(SERVER, 'PROD', { id: 'row1', key: 'PROD-7' });
    addExclude(SERVER, 'PROD', { id: 'row2', key: 'PROD-8' });
    expect(clearExcludes(SERVER, 'PROD')).toBe(2);
    expect(clearExcludes(SERVER, 'PROD')).toBe(0);
    expect(readExcludes(SERVER, 'PROD')).toEqual([]);
  });

  it('treats a CORRUPT store as empty rather than wedging every dispatch', () => {
    mkdirSync(join(home, 'motir'), { recursive: true });
    writeFileSync(excludesPath(), '{ not json');
    expect(readExcludes(SERVER, 'PROD')).toEqual([]);
    // and it recovers on the next write
    addExclude(SERVER, 'PROD', { id: 'row1', key: 'PROD-7' });
    expect(readExcludes(SERVER, 'PROD')).toHaveLength(1);
  });
});

// ── coverage gaps closed by 7.9.5 (MOTIR-883) ───────────────────────────────

describe('a corrupt store never wedges dispatch', () => {
  it('reads as empty and is rewritten cleanly by the next add', () => {
    mkdirSync(join(home, 'motir'), { recursive: true });
    writeFileSync(excludesPath(), 'not json at all');

    // Worst case of treating it as empty is re-picking one item — strictly
    // better than every `motir next` failing.
    expect(readExcludes(SERVER, 'PROD')).toEqual([]);

    addExclude(SERVER, 'PROD', { id: 'row-1', key: 'PROD-1' });
    expect(readExcludes(SERVER, 'PROD')).toEqual([{ id: 'row-1', key: 'PROD-1' }]);
  });

  it('reads a JSON scalar (not an object) as empty too', () => {
    mkdirSync(join(home, 'motir'), { recursive: true });
    writeFileSync(excludesPath(), '"a string"');
    expect(readExcludes(SERVER, 'PROD')).toEqual([]);
  });
});

// ── an UNWRITABLE store degrades, it does not throw (MOTIR-1836) ─────────────
//
// The store used to live inside the credential dir, which the sandbox mounts
// READ-ONLY on purpose. Every write on the FAILURE path (`addExclude` after a
// failed agent, `clearExcludes` for `--reset`) therefore threw, and the throw
// escaped `runAutoLoop` — skipping `closeOutRepos()`, so a run that had already
// integrated work pushed nothing and opened no pull request.
//
// The store is made unwritable by pointing the state home at a REGULAR FILE, so
// `mkdirSync` fails with ENOTDIR. That is deliberate: `chmod 500` is a no-op for
// uid 0, and CI runners are not reliably unprivileged, so a permission-bit
// fixture would silently stop asserting anything as root. The one chmod-based
// case below (the true EACCES shape from the bug report) is skipped as root for
// exactly that reason.

describe('an unwritable exclude store degrades instead of aborting the run', () => {
  let stateHome: string;

  beforeEach(() => {
    // A FILE, not a directory — so `<stateHome>/motir` can never be created.
    stateHome = join(home, 'not-a-directory');
    writeFileSync(stateHome, 'this is a file, so mkdir under it fails\n');
    process.env['MOTIR_STATE_HOME'] = stateHome;
  });

  afterEach(() => {
    delete process.env['MOTIR_STATE_HOME'];
  });

  it('addExclude does NOT throw — the caller keeps running', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => addExclude(SERVER, 'PROD', { id: 'row1', key: 'PROD-7' })).not.toThrow();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not throw when the store PATH itself is unwritable, wherever it resolves', () => {
    // Belt and braces: this one makes the write fail at the path the CONFIG
    // home resolves to, so it bites regardless of which of the two homes is in
    // play — a store path that is a DIRECTORY fails with EISDIR for every uid.
    delete process.env['MOTIR_STATE_HOME'];
    mkdirSync(join(home, 'motir', 'session-excludes.json'), { recursive: true });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(() => addExclude(SERVER, 'PROD', { id: 'row1', key: 'PROD-7' })).not.toThrow();
      expect(() => clearExcludes(SERVER, 'PROD')).not.toThrow();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('warns ONCE per store, not once per failed item', () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      addExclude(SERVER, 'PROD', { id: 'row1', key: 'PROD-7' });
      addExclude(SERVER, 'PROD', { id: 'row2', key: 'PROD-8' });
      addExclude(SERVER, 'OTHER', { id: 'row3', key: 'OTHER-1' });
    } finally {
      spy.mockRestore();
    }
    const warnings = written.filter((line) => line.includes('could not write the session exclude'));
    expect(warnings).toHaveLength(1);
    // It names the path and the escape hatch, so the warning is actionable.
    expect(warnings[0]).toContain(excludesPath());
    expect(warnings[0]).toContain('MOTIR_STATE_HOME');
  });

  it('reads as empty rather than throwing, so dispatch still selects', () => {
    addExclude(SERVER, 'PROD', { id: 'row1', key: 'PROD-7' });
    expect(readExcludes(SERVER, 'PROD')).toEqual([]);
  });

  it('reports honestly that nothing was removed or cleared', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Seed a store the LEGACY (config-dir) reader can see, so there is really
    // something to remove — the write of the pruned store is what fails.
    mkdirSync(join(home, 'motir'), { recursive: true });
    writeFileSync(
      join(home, 'motir', 'session-excludes.json'),
      JSON.stringify({ [scopeKey(SERVER, 'PROD')]: [{ id: 'row1', key: 'PROD-7' }] }),
    );
    expect(readExcludes(SERVER, 'PROD')).toEqual([{ id: 'row1', key: 'PROD-7' }]);

    // `--reset` cannot clear a store it cannot write, and must not claim it did:
    // the next run would still be excluding the item the user just un-excluded.
    expect(clearExcludes(SERVER, 'PROD')).toBe(0);
    expect(removeExclude(SERVER, 'PROD', 'row1')).toBe(false);
    vi.restoreAllMocks();
  });

  it.skipIf(process.getuid?.() === 0)(
    'survives the real EACCES shape from the bug report — a read-only state dir',
    () => {
      delete process.env['MOTIR_STATE_HOME'];
      const readonlyHome = join(home, 'readonly');
      mkdirSync(join(readonlyHome, 'motir'), { recursive: true });
      chmodSync(join(readonlyHome, 'motir'), 0o500);
      process.env['MOTIR_STATE_HOME'] = readonlyHome;
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        expect(() => addExclude(SERVER, 'PROD', { id: 'row1', key: 'PROD-7' })).not.toThrow();
      } finally {
        vi.restoreAllMocks();
        chmodSync(join(readonlyHome, 'motir'), 0o700);
      }
    },
  );
});

// ── the store lives in the STATE home, not beside the credential ────────────

describe('the store is resolved from the state home', () => {
  afterEach(() => {
    delete process.env['MOTIR_STATE_HOME'];
    delete process.env['XDG_STATE_HOME'];
  });

  it('MOTIR_STATE_HOME wins, so a read-only config mount is no longer fatal', () => {
    const state = mkdtempSync(join(tmpdir(), 'motir-state-'));
    process.env['MOTIR_STATE_HOME'] = state;
    expect(excludesPath()).toBe(join(state, 'motir', 'session-excludes.json'));

    addExclude(SERVER, 'PROD', { id: 'row1', key: 'PROD-7' });
    expect(readExcludes(SERVER, 'PROD')).toEqual([{ id: 'row1', key: 'PROD-7' }]);
    // and NOTHING was written beside the credential
    expect(existsSync(join(home, 'motir', 'session-excludes.json'))).toBe(false);
    rmSync(state, { recursive: true, force: true });
  });

  it('falls back to MOTIR_CONFIG_HOME, so one relocation still moves all state', () => {
    // No MOTIR_STATE_HOME set — the outer beforeEach only sets MOTIR_CONFIG_HOME,
    // which is the property the whole suite (and every prior release) relies on.
    expect(excludesPath()).toBe(join(home, 'motir', 'session-excludes.json'));
  });

  it('prefers MOTIR_CONFIG_HOME over XDG_STATE_HOME, keeping test homes isolated', () => {
    process.env['XDG_STATE_HOME'] = '/nonexistent/xdg-state';
    expect(excludesPath()).toBe(join(home, 'motir', 'session-excludes.json'));
  });

  it('reads a PRE-MOVE list from the config dir so upgrades lose nothing', () => {
    const state = mkdtempSync(join(tmpdir(), 'motir-state-'));
    process.env['MOTIR_STATE_HOME'] = state;
    // The list an existing user already has, at the old path.
    mkdirSync(join(home, 'motir'), { recursive: true });
    writeFileSync(
      join(home, 'motir', 'session-excludes.json'),
      JSON.stringify({ [scopeKey(SERVER, 'PROD')]: [{ id: 'old', key: 'PROD-1' }] }),
    );

    expect(readExcludes(SERVER, 'PROD')).toEqual([{ id: 'old', key: 'PROD-1' }]);
    // The next write migrates it to the new home, legacy entries carried over.
    addExclude(SERVER, 'PROD', { id: 'new', key: 'PROD-2' });
    expect(existsSync(join(state, 'motir', 'session-excludes.json'))).toBe(true);
    expect(readExcludes(SERVER, 'PROD')).toEqual([
      { id: 'old', key: 'PROD-1' },
      { id: 'new', key: 'PROD-2' },
    ]);
    rmSync(state, { recursive: true, force: true });
  });
});
