import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/importGraph';
import { stripSourceComments } from '../helpers/stripSourceComments';

// MOTIR-4242 — the application must not send anybody to `/p/<key>` on its own
// host, and must not hand anybody that host's URL to paste somewhere else.
//
// `app/(public)/p/` was deleted by MOTIR-3951: `motir.co` serves the public
// project page now (`docs/decisions/public-surface-hosts.md`), and this
// application answers 404 at that path. Three sites in the Members room still
// built their address from the application origin, and each broke differently:
//
//   1. a dead `href` a reader clicks (View public page);
//   2. a dead `href` an admin clicks to EDIT — whose room is in THIS
//      application, at `/settings/project/public`, so its retarget is a
//      different one;
//   3. a COPIED string a customer pastes into a tweet.
//
// The third is why this file exists as well as an `href` assertion. MOTIR-4171
// planned the sweep as "no `href` under `app/(authed)/` points at `/p/`", and
// that sweep is structurally blind to a value that never becomes an attribute —
// the clipboard write, the mono path beside the status badge, an `og:url`. So
// the second half below asserts on the SOURCE of the room rather than on a
// rendered tree: the origin must not be spelled or derived there at all.
//
// The behavioural half — what the link points at and what Copy actually writes
// — is `tests/components/project-members-settings.test.tsx`. This file is the
// guard that the pattern does not come BACK, here or in the next room somebody
// writes.

const AUTHED = join(REPO_ROOT, 'app', '(authed)');
const MEMBERS_ROOM = join(
  AUTHED,
  'settings',
  'project',
  'members',
  '_components',
  'ProjectMembersSettings.tsx',
);

/**
 * The file's CODE, with its prose removed.
 *
 * The room's own comments RECORD the retired addresses, deliberately and at
 * length — a deleted mechanism leaves no error message behind. A sweep that
 * matched them would make that record un-writable, so it would be deleted, and
 * the next reader would re-derive the defect from scratch.
 */
function code(file: string): string {
  return stripSourceComments(readFileSync(file, 'utf8'));
}

/** Every `.ts`/`.tsx` source file under `dir`. */
function sourceFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFilesUnder(path, out);
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

describe('the authed application never addresses a public project page on its own host', () => {
  it('no source under app/(authed)/ builds a `/p/<…>` path', () => {
    // Matched in a STRING or TEMPLATE position, which is the only place a path
    // is built — `'/p/`, `"/p/`, `` `/p/ ``, and the `}/p/` a template
    // interpolation leaves behind.
    const offenders = sourceFilesUnder(AUTHED)
      .filter((file) => /(["'`]|\}\s*)\/p\//.test(code(file)))
      .map((file) => relative(REPO_ROOT, file))
      .sort();

    // A named list rather than a count: a reader who trips this needs to know
    // WHICH file, and the remedy is always the same one — resolve the address
    // with `publicProjectUrl()` on the server and thread it in as a prop.
    expect(offenders).toEqual([]);
  });

  it('the Members room derives no origin of its own — the URL arrives resolved', () => {
    const source = code(MEMBERS_ROOM);

    // `window.location.origin` is the APPLICATION's origin. Reading it here is
    // the exact defect: it produced `https://app.motir.co/p/<key>` for the
    // clipboard, which is a 404 the person pasting it does not find out about.
    expect(source).not.toContain('window.location');
    // Nor may it spell a host, or read the variable. `lib/publicProjects/urls.ts`
    // is the single reader of `MOTIR_PUBLIC_SITE_URL` — `tests/hosting/appUrlSeam.test.ts`
    // pins that as a tree grep — and a second answer to that question is how
    // these three sites came to disagree with each other in the first place.
    expect(source).not.toMatch(/motir\.co/);
    expect(source).not.toContain('MOTIR_PUBLIC_SITE_URL');
  });
});
