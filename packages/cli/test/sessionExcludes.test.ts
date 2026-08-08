import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addExclude,
  clearExcludes,
  excludesPath,
  readExcludes,
  removeExclude,
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
    addExclude(SERVER, 'PROD', { key: 'PROD-7' });
    expect(readExcludes(SERVER, 'PROD')).toEqual([{ key: 'PROD-7' }]);
  });

  it('is idempotent by key, case-insensitively', () => {
    addExclude(SERVER, 'PROD', { key: 'PROD-7' });
    addExclude(SERVER, 'PROD', { key: 'PROD-7' });
    addExclude(SERVER, 'PROD', { key: 'prod-7' });
    expect(readExcludes(SERVER, 'PROD')).toHaveLength(1);
  });

  it('scopes by server AND project — one project never hides another’s work', () => {
    addExclude(SERVER, 'PROD', { key: 'PROD-7' });
    expect(readExcludes(SERVER, 'OTHER')).toEqual([]);
    expect(readExcludes('https://other.example', 'PROD')).toEqual([]);
  });

  it('normalizes the server URL and the project key when scoping', () => {
    expect(scopeKey('https://app.motir.co/', 'prod')).toBe(scopeKey(SERVER, 'PROD'));
    addExclude('https://app.motir.co/', 'prod', { key: 'PROD-7' });
    expect(readExcludes(SERVER, 'PROD')).toHaveLength(1);
  });

  it('removes by key — case-insensitively — so a fixed item stops being skipped', () => {
    addExclude(SERVER, 'PROD', { key: 'PROD-7' });
    addExclude(SERVER, 'PROD', { key: 'PROD-8' });
    expect(removeExclude(SERVER, 'PROD', 'PROD-7')).toBe(true);
    expect(removeExclude(SERVER, 'PROD', 'PROD-7')).toBe(false);
    // `motir done PROD-8` is the lower-case path that used to need its own
    // function; one key-based remove now serves both callers.
    expect(removeExclude(SERVER, 'PROD', 'prod-8')).toBe(true);
    expect(readExcludes(SERVER, 'PROD')).toEqual([]);
  });

  it('clears the whole list and reports how many went', () => {
    addExclude(SERVER, 'PROD', { key: 'PROD-7' });
    addExclude(SERVER, 'PROD', { key: 'PROD-8' });
    expect(clearExcludes(SERVER, 'PROD')).toBe(2);
    expect(clearExcludes(SERVER, 'PROD')).toBe(0);
    expect(readExcludes(SERVER, 'PROD')).toEqual([]);
  });

  // ── The MOTIR-2338 migration ──────────────────────────────────────────────
  //
  // Real user state on disk: a list written by a CLI that stored `{ id, key }`.
  // It must keep working, because the alternative is an upgrade that silently
  // re-dispatches every item a previous run failed on.
  it('reads a file written by the PREVIOUS CLI, and drops the row id on the next write', () => {
    mkdirSync(join(home, 'motir'), { recursive: true });
    writeFileSync(
      excludesPath(),
      JSON.stringify({
        [scopeKey(SERVER, 'PROD')]: [
          { id: 'cuid-row-1', key: 'PROD-7' },
          { id: 'cuid-row-2', key: 'PROD-8' },
        ],
      }),
    );

    // Read: the keys survive, the ids are gone from the value callers see.
    expect(readExcludes(SERVER, 'PROD')).toEqual([{ key: 'PROD-7' }, { key: 'PROD-8' }]);

    // Write: the id is not carried forward onto disk either.
    addExclude(SERVER, 'PROD', { key: 'PROD-9' });
    const onDisk = JSON.parse(readFileSync(excludesPath(), 'utf8')) as Record<
      string,
      Record<string, unknown>[]
    >;
    expect(onDisk[scopeKey(SERVER, 'PROD')]).toEqual([
      { key: 'PROD-7' },
      { key: 'PROD-8' },
      { key: 'PROD-9' },
    ]);
  });

  it('still holds out an item recorded by the PREVIOUS CLI', () => {
    mkdirSync(join(home, 'motir'), { recursive: true });
    writeFileSync(
      excludesPath(),
      JSON.stringify({ [scopeKey(SERVER, 'PROD')]: [{ id: 'cuid-row-1', key: 'PROD-7' }] }),
    );
    // The whole point of the migration: the upgrade does not re-offer PROD-7.
    expect(readExcludes(SERVER, 'PROD').map((e) => e.key)).toContain('PROD-7');
    expect(removeExclude(SERVER, 'PROD', 'PROD-7')).toBe(true);
    expect(readExcludes(SERVER, 'PROD')).toEqual([]);
  });

  it('discards an entry with no key rather than keeping an unclearable exclusion', () => {
    mkdirSync(join(home, 'motir'), { recursive: true });
    writeFileSync(
      excludesPath(),
      JSON.stringify({ [scopeKey(SERVER, 'PROD')]: [{ id: 'cuid-row-1' }, { key: 'PROD-7' }] }),
    );
    // An entry naming nothing the CLI can match could never be removed by any
    // command, so it would skip an item forever.
    expect(readExcludes(SERVER, 'PROD')).toEqual([{ key: 'PROD-7' }]);
  });

  it('treats a CORRUPT store as empty rather than wedging every dispatch', () => {
    mkdirSync(join(home, 'motir'), { recursive: true });
    writeFileSync(excludesPath(), '{ not json');
    expect(readExcludes(SERVER, 'PROD')).toEqual([]);
    // and it recovers on the next write
    addExclude(SERVER, 'PROD', { key: 'PROD-7' });
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

    addExclude(SERVER, 'PROD', { key: 'PROD-1' });
    expect(readExcludes(SERVER, 'PROD')).toEqual([{ key: 'PROD-1' }]);
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
      expect(() => addExclude(SERVER, 'PROD', { key: 'PROD-7' })).not.toThrow();
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
      expect(() => addExclude(SERVER, 'PROD', { key: 'PROD-7' })).not.toThrow();
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
      addExclude(SERVER, 'PROD', { key: 'PROD-7' });
      addExclude(SERVER, 'PROD', { key: 'PROD-8' });
      addExclude(SERVER, 'OTHER', { key: 'OTHER-1' });
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
    addExclude(SERVER, 'PROD', { key: 'PROD-7' });
    expect(readExcludes(SERVER, 'PROD')).toEqual([]);
  });

  it('reports honestly that nothing was removed or cleared', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // Seed a store the LEGACY (config-dir) reader can see, so there is really
    // something to remove — the write of the pruned store is what fails.
    mkdirSync(join(home, 'motir'), { recursive: true });
    writeFileSync(
      join(home, 'motir', 'session-excludes.json'),
      JSON.stringify({ [scopeKey(SERVER, 'PROD')]: [{ key: 'PROD-7' }] }),
    );
    expect(readExcludes(SERVER, 'PROD')).toEqual([{ key: 'PROD-7' }]);

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
        expect(() => addExclude(SERVER, 'PROD', { key: 'PROD-7' })).not.toThrow();
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

    addExclude(SERVER, 'PROD', { key: 'PROD-7' });
    expect(readExcludes(SERVER, 'PROD')).toEqual([{ key: 'PROD-7' }]);
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
      JSON.stringify({ [scopeKey(SERVER, 'PROD')]: [{ key: 'PROD-1' }] }),
    );

    expect(readExcludes(SERVER, 'PROD')).toEqual([{ key: 'PROD-1' }]);
    // The next write migrates it to the new home, legacy entries carried over.
    addExclude(SERVER, 'PROD', { key: 'PROD-2' });
    expect(existsSync(join(state, 'motir', 'session-excludes.json'))).toBe(true);
    expect(readExcludes(SERVER, 'PROD')).toEqual([{ key: 'PROD-1' }, { key: 'PROD-2' }]);
    rmSync(state, { recursive: true, force: true });
  });
});

// ── The structural guard MOTIR-2338 exists for ──────────────────────────────
//
// The exclusion list moved to KEYS so that nothing in the dispatch path needs a
// work item's internal row id — `/api/v1` never publishes one (ADR §7), and
// that read is precisely what blocked the CLI's `getWorkItem` port (MOTIR-2212).
//
// Asserted over the SOURCE rather than through behaviour, because the defect
// this prevents is a re-introduction: a future edit that reaches for `item.id`
// again would pass every functional test in this suite while quietly re-coupling
// the CLI to an identifier the public API will not give it.
describe('no dispatch-path read of a work item’s internal row id', () => {
  const SRC = join(import.meta.dirname, '..', 'src');

  it('dispatch.ts feeds the exclude store KEYS, never a row id', () => {
    const source = readFileSync(join(SRC, 'commands', 'dispatch.ts'), 'utf8');
    // Every exclude write names a key. `{ id` or `, id)` in one of these calls
    // is the re-coupling this guard exists to catch.
    for (const call of source.matchAll(/(?:add|remove)Exclude\([^)]*\)/g)) {
      expect(call[0], call[0]).not.toMatch(/\bid\b/);
    }
    // The `motir run <key>` path reads a `get_work_item` DETAIL. It must route
    // on the identifier alone — that read of `item.id` is what blocked the
    // detail's port to /api/v1 (MOTIR-2212), and ADR §7 keeps the cuid off the
    // wire for good.
    const runByKey = source.slice(source.indexOf('item.identifier'));
    expect(runByKey).not.toMatch(/\bitem\.id\b/);
  });

  // ⚠️ This guard INVERTED (MOTIR-2398). It used to pin the ONE deliberate
  // row-id read that survived: `next_ready` narrowed by id, so the pick had to
  // read the id off the row the server handed back and ask again. The pick is a
  // client-side skip over the ranked ready collection now, keyed by KEY like
  // the persisted list, so that read is gone and the guard asserts its absence
  // — the stronger property, and the one 11.5.6 needs to be able to rely on.
  it('the dispatch path reads NO row id at all — the last one went with `next_ready`', () => {
    const source = readFileSync(join(SRC, 'commands', 'dispatch.ts'), 'utf8');
    expect(source).not.toMatch(/\bitem\.id\b/);
    expect(source).not.toMatch(/excludeIds/);
    expect(source).not.toMatch(/seenIds/);
  });

  it('the exclude store exposes no id-shaped surface', () => {
    const source = readFileSync(join(SRC, 'sessionExcludes.ts'), 'utf8');
    // The interface, the idempotence check and the removal all key on `key`.
    expect(source).not.toMatch(/^\s*id: string;/m);
    expect(source).not.toMatch(/removeExcludeByKey/);
  });
});
