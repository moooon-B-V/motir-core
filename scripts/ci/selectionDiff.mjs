// The change set the Vitest SELECTION reads on a pull request (MOTIR-5923 ·
// docs/decisions/ci-affected-tests.md §4 item 1).
//
// Kept out of `measure-affected-tests.mjs` because that script builds the whole
// Vitest graph at import time; this is the one line of it a test can execute
// against a fixture history.
//
// ── Why `HEAD^1 HEAD`, and not the payload's `base.sha` ──────────────────────
// A pull request's legs check out `refs/pull/<n>/merge` — a merge commit whose
// FIRST parent is the tip of `main` at the moment GitHub built it. The event
// payload's `pull_request.base.sha` is the tip at the moment of the EVENT, and
// `main` can move in between. A two-dot diff from that stale sha to the merge
// commit therefore reports everything `main` gained in the gap as this pull
// request's change — and when the gap touched a force-full path the selection
// refused and the leg ran its full shard with no coverage gate.
//
// The merge commit against its own first parent is the change this pull request
// makes to the tree the legs actually test, and it is a SUBSET of what the
// `changes` job classifies (`base...head`, three-dot): a path the pull request
// did not change resolves to `main`'s version in the merge, so it cannot appear.
// That is the property that matters — a path `changes` did not see can no longer
// refuse the subset. A three-dot diff would name the same set but needs history
// back to the merge base on every leg; this needs a depth of two.

import { execFileSync } from 'node:child_process';

/** The first parent of the pull request's merge commit, as the legs pass it. */
export const SELECT_BASE_REF = 'HEAD^1';

/**
 * The files `head` changes relative to `base` (two-dot), one repository path each.
 * `measure-affected-tests.mjs --select <base> [--head <ref>]` reads exactly this.
 */
export function changedFiles(base, head = 'HEAD', cwd = process.cwd()) {
  return execFileSync('git', ['diff', '--name-only', base, head], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
