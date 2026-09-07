import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/tests/helpers/importGraph';

// MOTIR-4708 — the guard on the two not-found BOUNDARIES.
//
// The defect this file exists to keep fixed is not a missing page; it is a
// missing FILE. With no `not-found.tsx` above them, every route that calls
// `notFound()` falls through to Next's built-in not-found component, which ships
// its own `<style>` element inside the body:
//
//     body{color:#000;background:#fff;margin:0}
//     @media (prefers-color-scheme:dark){body{color:#fff;background:#000}}
//
// It is emitted after `app/globals.css` at equal specificity, so its `color`
// wins — and it takes its polarity from the OS while the ground the reader sees
// is painted by the shell from `data-theme` on `<html>`. Pin the theme against
// the OS and the two disagree: light theme + dark OS measured white-on-white at
// 1.00 : 1, a 404 that is served correctly and looks like an empty page.
//
// Deleting either boundary file restores that markup silently — no import
// breaks, no route 404s, no type error, and the status stays right. So the
// invariant is asserted on the files themselves, the way
// `loading-boundary-guard.test.ts` asserts the inverse rule one segment over.
// The CONTRAST half is measured in a browser, where a cascade can actually
// resolve: `tests/e2e/not-found-theme.spec.ts`.
const ROOT = process.cwd();
const APP = join(ROOT, 'app');

const rel = (p: string) => relative(ROOT, p).split(sep).join('/');

/** Every directory under `app/` holding a `page.tsx` / `page.ts`. */
function pageDirs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) pageDirs(p, out);
    else if (entry === 'page.tsx' || entry === 'page.ts') out.push(dir);
  }
  return out;
}

/** The nearest ancestor (inclusive) carrying a `not-found.tsx`, or null. */
function nearestBoundary(pageDir: string): string | null {
  let cur = pageDir;
  for (;;) {
    try {
      statSync(join(cur, 'not-found.tsx'));
      return cur;
    } catch {
      /* keep walking up */
    }
    if (cur === APP) return null;
    const next = join(cur, '..');
    if (next === cur) return null;
    cur = next;
  }
}

const BOUNDARIES = [join(APP, 'not-found.tsx'), join(APP, '(authed)', 'not-found.tsx')];

describe('the not-found boundaries', () => {
  it('both exist — the root one and the authed one', () => {
    for (const file of BOUNDARIES) {
      expect(() => statSync(file), `${rel(file)} must exist`).not.toThrow();
    }
  });

  // ⚠️ THE POINT OF THE WHOLE CARD. A boundary that re-introduced an OS-keyed
  // rule would paint exactly the defect it replaced, and it would do it only on
  // the two theme × OS combinations nobody develops in.
  //
  // Scanned with the COMMENTS STRIPPED, because both files quote the framework's
  // own `prefers-color-scheme` rule to explain what they are replacing — and a
  // guard that forbade naming the defect would be a guard against documenting it.
  it('take no colour from the OS colour scheme', () => {
    for (const file of BOUNDARIES) {
      const code = stripComments(readFileSync(file, 'utf8'));
      expect(code, `${rel(file)} must not key on the OS`).not.toMatch(
        /prefers-color-scheme|colorScheme|\bdark:/,
      );
    }
  });

  // The boundary is only reached through `notFound()`, so a page that calls it
  // with nothing above it is a page that still gets the built-in component.
  it('cover every page that calls notFound()', () => {
    const uncovered = pageDirs(APP)
      .filter((dir) => {
        for (const name of ['page.tsx', 'page.ts']) {
          try {
            if (readFileSync(join(dir, name), 'utf8').includes('notFound(')) return true;
          } catch {
            /* the other extension */
          }
        }
        return false;
      })
      .filter((dir) => nearestBoundary(dir) === null)
      .map(rel);

    expect(uncovered, 'every notFound() page needs a not-found.tsx above it').toEqual([]);
  });
});
