/**
 * The `HEAD`-BASELINE READ of `scripts/render-design-mock.mjs` (MOTIR-4895).
 *
 * WHY IT IS SPLIT OUT. The same reason `renderDesignMockBoards.mjs` and
 * `renderDesignMockSearch.mjs` are: the runner launches chromium, writes PNGs,
 * prints to stdout and `process.exit`s at top level, so a module that imports it
 * cannot be called by a test. This file opens no browser, writes nothing and
 * exits nothing — it shells out to `git` and returns a Buffer or `null`.
 *
 * ── THE DEFECT THIS SPLIT EXISTS FOR ────────────────────────────────────────
 * The runner read its drift baseline with a bare
 * `execFileSync('git', ['show', `HEAD:${path}`])`, whose non-zero exit THROWS.
 * It called that whenever the `.png` existed ON DISK — and for a new asset the
 * first render is the thing that puts it there. So the loop every `type: design`
 * card actually runs (render → look → fix → render) was fatal at step three:
 *
 *   $ node scripts/render-design-mock.mjs design/…/approval-control.mock.html --width 1200
 *   NEW  1200  2400x4992  design/…/approval-control.mock.html      # ok
 *   # edit the mock, then:
 *   $ node scripts/render-design-mock.mjs design/…/approval-control.mock.html --width 1200
 *   fatal: path 'design/…/approval-control.png' exists on disk, but not in 'HEAD'
 *   Error: Command failed: git show HEAD:design/…/approval-control.png
 *
 * The only workaround was to `rm` the artefact you had just produced, which is
 * not a remedy anybody guesses — and the message names `git`, not the script, so
 * a runner meeting it reads it as a repository problem of their own making.
 *
 * ── WHY `null` RATHER THAN A THROW ──────────────────────────────────────────
 * The asymmetry is the whole argument: a missing baseline is not an error
 * condition, it is the `NEW` case `exportMockBoards` already knows how to
 * handle. `git show HEAD:<path>` failing means exactly *there is no committed
 * baseline* — which is the answer, not an obstacle to reporting one.
 */

import { execFileSync } from 'node:child_process';

/**
 * The committed export of a large asset. `code-context.png` is 2400x17392, and
 * the tree's ceiling is not bounded by anything but the tallest mock, so this
 * stays generous. (Carried over from the call site this replaces.)
 */
const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * A path's content AT `HEAD` — or `null` when `HEAD` does not carry it.
 *
 * `null` covers every way the read can come back without content: the path is
 * new, the path was deleted at `HEAD`, or there is no commit to read from at all
 * (a repository with no `HEAD`). All three mean the same thing to every caller —
 * *no committed baseline* — so all three answer the same way.
 *
 * ⚠️ `stderr` is PIPED rather than inherited, so git's own `fatal: path … exists
 * on disk, but not in 'HEAD'` no longer prints. That line is what made the
 * defect read as a broken repository: it is git narrating a question this script
 * asked speculatively, and the script's own `NEW` verdict says the same thing in
 * the vocabulary the reader is already following.
 *
 * @param {string} path Repo-relative, as `git show` wants it.
 * @param {{ cwd?: string }} [options] `cwd` is the repository to read — the
 *   runner leaves it unset and inherits the process's, which is the repo root.
 * @returns {Buffer | null}
 */
export function readAtHead(path, { cwd } = {}) {
  try {
    return execFileSync('git', ['show', `HEAD:${path}`], {
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd === undefined ? {} : { cwd }),
    });
  } catch {
    return null;
  }
}
