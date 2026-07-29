import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { configDir, normalizeServerUrl } from './config/userConfig.js';

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
// It holds NO secret (ids + keys of the caller's own project), but it lives
// beside the credential store so a single config home relocation
// (`MOTIR_CONFIG_HOME`) moves the whole CLI state — which is what lets the test
// suite exercise the real file without touching a real home.

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
  return join(configDir(), EXCLUDES_FILENAME);
}

/** The store key for a (server, project) pair. */
export function scopeKey(serverUrl: string, projectKey: string): string {
  return `${normalizeServerUrl(serverUrl)}|${projectKey.toUpperCase()}`;
}

function readStore(): ExcludeStore {
  const path = excludesPath();
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

function writeStore(store: ExcludeStore): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(excludesPath(), JSON.stringify(store, null, 2) + '\n');
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
  writeStore(store);
  return true;
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
  writeStore(store);
  return count;
}
