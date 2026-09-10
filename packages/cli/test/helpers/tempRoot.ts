import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A temp directory whose path is the one the PROCESS will report (MOTIR-4980).
//
// `mkdtempSync(join(tmpdir(), …))` returns the path it was ASKED for, symlinks
// and all. On macOS `os.tmpdir()` is `/var/folders/…` and `/var` is a symlink
// to `/private/var`, so a fixture that keeps that string and then does
// `process.chdir(root)` is holding a name the process itself no longer uses:
// `process.cwd()` answers `/private/var/folders/…`, because Node resolves the
// working directory. Every command under test derives its checkout paths from
// `process.cwd()`, so an assertion built with `join(root, 'motir-core')`
// compares two strings that name ONE directory and fails — deterministically,
// on macOS only, and green on the Linux runner where `/tmp` is not a symlink.
//
// So the fixture resolves the directory ONCE, at creation, and every path built
// from it is already in the form the process reports. That is the whole rule:
// resolve at the source rather than normalising at each `expect`, so a test
// written later inherits it without knowing this paragraph exists.
//
// It is deliberately NOT a normaliser applied to the assertion. Normalising
// both sides of a comparison would also hide the case where the code under test
// really did hand back a different directory, which is a thing these suites test.

/**
 * Create a temp directory under `os.tmpdir()` and return its REAL path — the
 * one `process.cwd()` reports after a `chdir` into it.
 *
 * @param prefix the `mkdtemp` prefix, e.g. `'motir-autocmd-'`.
 */
export function makeTempRoot(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}
