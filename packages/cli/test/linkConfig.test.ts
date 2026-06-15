import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findLink,
  overrideRepoNames,
  resolveRepo,
  withRepoOverride,
  withoutRepoOverride,
  writeLink,
  type LinkConfig,
} from '../src/config/linkConfig.js';
import { NotLinkedError } from '../src/errors.js';

// The project link: upward resolution, convention-vs-override repo paths, and
// the pure override editors. No server, no token.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'motir-link-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const baseConfig: LinkConfig = {
  serverUrl: 'https://app.motir.co',
  workspace: 'moooon',
  project: 'PROD',
};

describe('linkConfig — resolution', () => {
  it('returns null when no link exists up to the filesystem root', () => {
    expect(findLink(root)).toBeNull();
  });

  it('finds the link by walking UPWARD from a nested checkout', () => {
    writeLink(root, baseConfig);
    const nested = join(root, 'motir-core', 'lib', 'services');
    mkdirSync(nested, { recursive: true });
    const found = findLink(nested);
    expect(found?.dir).toBe(root);
    expect(found?.config.project).toBe('PROD');
  });

  it('throws NotLinkedError on a malformed .motir.json', () => {
    // A file present but missing required keys is a broken link, not "no link".
    writeLink(root, { serverUrl: 'x' } as unknown as LinkConfig);
    expect(() => findLink(root)).toThrow(NotLinkedError);
  });
});

describe('linkConfig — repo resolution', () => {
  it('resolves an unlisted repo by the convention <root>/<repoName>', () => {
    const r = resolveRepo(root, baseConfig, 'motir-core');
    expect(r.source).toBe('convention');
    expect(r.path).toBe(join(root, 'motir-core'));
    expect(r.exists).toBe(false);
  });

  it('resolves a listed repo via its override (relative + absolute)', () => {
    const rel = withRepoOverride(baseConfig, 'motir-core', '.');
    expect(resolveRepo(root, rel, 'motir-core')).toMatchObject({
      source: 'override',
      path: root,
      exists: true,
    });
    const abs = withRepoOverride(baseConfig, 'ai', '/elsewhere/ai');
    expect(resolveRepo(root, abs, 'ai').path).toBe('/elsewhere/ai');
  });
});

describe('linkConfig — override editors', () => {
  it('adds, lists, and removes overrides immutably', () => {
    const one = withRepoOverride(baseConfig, 'a', './a');
    const two = withRepoOverride(one, 'b', './b');
    expect(overrideRepoNames(two)).toEqual(['a', 'b']);
    // original untouched
    expect(baseConfig.repos).toBeUndefined();

    const back = withoutRepoOverride(two, 'a');
    expect(overrideRepoNames(back)).toEqual(['b']);

    const empty = withoutRepoOverride(back, 'b');
    expect(empty.repos).toBeUndefined();
    expect(() => withoutRepoOverride(empty, 'b')).toThrow();
  });
});
