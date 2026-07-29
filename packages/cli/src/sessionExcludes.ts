import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { configDir, normalizeServerUrl, stateDir } from './config/userConfig.js';
import { info } from './output.js';

// The SESSION EXCLUDE LIST (Subtask 7.9.3 · MOTIR-881) — the ids `motir next`
// passes to `next_ready`'s `excludeIds` so a dispatch that FAILED is not handed
// straight back on the next call.
//
// Why it must be persisted rather than a process-local array: a `motir next`
// process dispatches exactly ONE item and exits, so an in-memory list would die
// with it and the very next `motir next` would re-pick the item that just
// failed. (`motir auto`'s in-process WHILE loop, 7.9.4, layers its own
// per-iteration ids on top of whatever it reads here.)
//
// It is a CONVENIENCE, not a correctness mechanism: a failed item is left
// `in_progress`, which already keeps it out of the ready set. The exclude list
// covers the case where someone moves it back to `todo` without fixing it, and
// makes the "skip what just broke" behaviour explicit rather than incidental.
//
// It holds NO secret (ids + keys of the caller's own project), which is why it
// lives in the STATE home (`stateDir()`) and not beside the credential. It used
// to sit in the config dir, and that was a bug (MOTIR-1836): the sandbox mounts
// the config dir READ-ONLY by design — the container consumes a PAT and never
// mints one — so the CLI's only writable state directory was, in the sandbox,
// not writable, and the failure-path write took down the whole run. `stateDir()`
// still falls back to `MOTIR_CONFIG_HOME` when that is set, so one relocation
// moves the whole CLI state and the test suite keeps its isolation.

export const EXCLUDES_FILENAME = 'session-excludes.json';

export interface ExcludeEntry {
  /** The work item ROW id — what `next_ready`'s `excludeIds` takes. */
  id: string;
  /** The `PROD-<n>` identifier, carried purely so the list is readable. */
  key: string;
}

/** server URL + project key → the excluded entries. */
type ExcludeStore = Record<string, ExcludeEntry[]>;

export function excludesPath(): string {
  return join(stateDir(), EXCLUDES_FILENAME);
}

/**
 * Where the list lived before MOTIR-1836 moved it out of the credential dir.
 * READ-ONLY fallback: a user who already has a list keeps it (the store is
 * rewritten at the new path by the next write), and nobody's persisted
 * exclusions silently vanish on upgrade. Never written to.
 */
export function legacyExcludesPath(): string {
  return join(configDir(), EXCLUDES_FILENAME);
}

/** The store key for a (server, project) pair. */
export function scopeKey(serverUrl: string, projectKey: string): string {
  return `${normalizeServerUrl(serverUrl)}|${projectKey.toUpperCase()}`;
}

function readStore(): ExcludeStore {
  const primary = excludesPath();
  const path = existsSync(primary) ? primary : legacyExcludesPath();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as ExcludeStore;
  } catch {
    // A corrupt file must never wedge dispatch — the worst case of treating it
    // as empty is re-picking one item, which is exactly the pre-exclude
    // behaviour. The next write rewrites it cleanly.
    return {};
  }
}

/** Store paths already warned about, so an unwritable store says so ONCE per
 *  process rather than once per failed item. Keyed by path so a relocation
 *  (and each test's temp home) re-arms the warning. */
const warnedPaths = new Set<string>();

/**
 * Persist the store — and NEVER throw if it cannot be persisted.
 *
 * The exclude list is a CONVENIENCE, not a correctness mechanism (see the
 * header): a failed item is already held out of the ready set by its
 * `in_progress` status. So an unwritable store must degrade to a warning, not
 * abort the caller. It used to throw, and because the only caller on the
 * failure path is `runAutoLoop`, the exception escaped the loop and skipped
 * `closeOutRepos()` — so an unattended run that had already integrated five
 * items pushed nothing and opened no pull request (MOTIR-1836). Losing the
 * memo about one failed item is a trivial cost; losing the run's output is not.
 *
 * Returns whether the store actually landed on disk.
 */
function writeStore(store: ExcludeStore): boolean {
  const path = excludesPath();
  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(store, null, 2) + '\n');
    // A later write succeeding means the store is healthy again — re-arm, so a
    // long-lived process reports a NEW breakage rather than staying silent.
    warnedPaths.delete(path);
    return true;
  } catch (err) {
    if (!warnedPaths.has(path)) {
      warnedPaths.add(path);
      const reason = err instanceof Error ? err.message : String(err);
      info(
        `Note: could not write the session exclude list (${path}): ${reason}\n` +
          '      Continuing — the list only avoids re-picking an item that just failed,\n' +
          '      and a failed item is already held out of the ready set by its status.\n' +
          '      Set MOTIR_STATE_HOME to a writable directory to persist it.',
      );
    }
    return false;
  }
}

/** Every entry excluded for this (server, project). */
export function readExcludes(serverUrl: string, projectKey: string): ExcludeEntry[] {
  return readStore()[scopeKey(serverUrl, projectKey)] ?? [];
}

/** Add an entry (idempotent by id) — called when an agent run FAILS. */
export function addExclude(serverUrl: string, projectKey: string, entry: ExcludeEntry): void {
  const store = readStore();
  const key = scopeKey(serverUrl, projectKey);
  const current = store[key] ?? [];
  if (current.some((e) => e.id === entry.id)) return;
  store[key] = [...current, entry];
  writeStore(store);
}

/**
 * Drop one entry — called when an item SUCCEEDS (or is closed out with `motir
 * done`), so a previously-failed item that has since been fixed stops being
 * skipped. Returns true when something was removed.
 */
export function removeExclude(serverUrl: string, projectKey: string, id: string): boolean {
  const store = readStore();
  const key = scopeKey(serverUrl, projectKey);
  const current = store[key] ?? [];
  const next = current.filter((e) => e.id !== id);
  if (next.length === current.length) return false;
  if (next.length > 0) store[key] = next;
  else delete store[key];
  // Reports what actually PERSISTED: an unwritable store removed nothing, and
  // saying otherwise would make `--reset`'s summary lie about the next run.
  return writeStore(store);
}

/** Drop one entry BY KEY (`PROD-7`) — the `motir done` path, which knows the
 *  identifier but not the row id. Returns true when something was removed. */
export function removeExcludeByKey(serverUrl: string, projectKey: string, key: string): boolean {
  const entry = readExcludes(serverUrl, projectKey).find(
    (e) => e.key.toUpperCase() === key.toUpperCase(),
  );
  return entry ? removeExclude(serverUrl, projectKey, entry.id) : false;
}

/** Clear the whole list for a (server, project) — `motir next --reset`. */
export function clearExcludes(serverUrl: string, projectKey: string): number {
  const store = readStore();
  const key = scopeKey(serverUrl, projectKey);
  const count = store[key]?.length ?? 0;
  if (count === 0) return 0;
  delete store[key];
  return writeStore(store) ? count : 0;
}
