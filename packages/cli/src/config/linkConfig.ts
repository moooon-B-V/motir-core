import { dirname, isAbsolute, join, resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { NotLinkedError } from '../errors.js';

// The PROJECT link — `.motir.json` at the workspace root. Binds a FOLDER (the
// directory that holds, or WILL hold, the project's repo checkouts) to a
// server + workspace + project. Repo checkouts resolve by CONVENTION
// (`<root>/<repoName>`); the optional `repos` map carries OVERRIDES only (a
// checkout living elsewhere or under a different name). Contains NO secret, so
// it is safe to commit. The token lives in the user config (userConfig.ts).

export const LINK_FILENAME = '.motir.json';

export interface LinkConfig {
  serverUrl: string;
  workspace: string;
  project: string;
  /** OPTIONAL override map: repo name → path (relative to the link root, or
   * absolute). Default resolution is the convention `<root>/<repoName>`. */
  repos?: Record<string, string>;
}

export interface FoundLink {
  /** The directory containing `.motir.json` — the workspace root. */
  dir: string;
  /** Absolute path to the `.motir.json` file. */
  path: string;
  config: LinkConfig;
}

function isLinkConfig(value: unknown): value is LinkConfig {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['serverUrl'] === 'string' &&
    typeof v['workspace'] === 'string' &&
    typeof v['project'] === 'string'
  );
}

/**
 * Walk UPWARD from `startDir` looking for a `.motir.json`, so every command
 * works from inside any checkout under the workspace root. Returns null if none
 * is found before the filesystem root.
 */
export function findLink(startDir: string = process.cwd()): FoundLink | null {
  let dir = resolve(startDir);
  for (;;) {
    const path = join(dir, LINK_FILENAME);
    if (existsSync(path)) {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isLinkConfig(parsed)) {
        throw new NotLinkedError();
      }
      return { dir, path, config: parsed };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Like {@link findLink} but throws {@link NotLinkedError} when absent. */
export function requireLink(startDir: string = process.cwd()): FoundLink {
  const found = findLink(startDir);
  if (!found) throw new NotLinkedError();
  return found;
}

/** Write `.motir.json` into `dir`. */
export function writeLink(dir: string, config: LinkConfig): string {
  const path = join(dir, LINK_FILENAME);
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  return path;
}

export type RepoResolutionSource = 'override' | 'convention';

export interface ResolvedRepo {
  repoName: string;
  /** Absolute path to where the repo checkout resolves. */
  path: string;
  source: RepoResolutionSource;
  exists: boolean;
}

/**
 * Resolve where a repo checkout lives for a link rooted at `rootDir`:
 * an override from the `repos` map if present (relative to the root, or an
 * absolute path), else the convention `<rootDir>/<repoName>`.
 */
export function resolveRepo(rootDir: string, config: LinkConfig, repoName: string): ResolvedRepo {
  const override = config.repos?.[repoName];
  let path: string;
  let source: RepoResolutionSource;
  if (override !== undefined) {
    path = isAbsolute(override) ? override : resolve(rootDir, override);
    source = 'override';
  } else {
    path = resolve(rootDir, repoName);
    source = 'convention';
  }
  return { repoName, path, source, exists: existsSync(path) };
}

/** All repo names with an explicit override entry (sorted). */
export function overrideRepoNames(config: LinkConfig): string[] {
  return Object.keys(config.repos ?? {}).sort();
}

/** Return a new config with `repoName → path` added/updated in the override map. */
export function withRepoOverride(config: LinkConfig, repoName: string, path: string): LinkConfig {
  return { ...config, repos: { ...(config.repos ?? {}), [repoName]: path } };
}

/** Return a new config with `repoName` removed from the override map (the
 * `repos` key drops entirely once empty). Throws if the name isn't present. */
export function withoutRepoOverride(config: LinkConfig, repoName: string): LinkConfig {
  if (config.repos?.[repoName] === undefined) {
    throw new Error(`No override for repo "${repoName}".`);
  }
  const next = { ...(config.repos ?? {}) };
  delete next[repoName];
  const result: LinkConfig = { ...config };
  if (Object.keys(next).length > 0) result.repos = next;
  else delete result.repos;
  return result;
}
