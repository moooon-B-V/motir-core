import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
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
