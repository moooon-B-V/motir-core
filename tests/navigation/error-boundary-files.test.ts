import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripComments } from '@/tests/helpers/importGraph';

// MOTIR-6855 (Bug MOTIR-6776) — the guard on the three error BOUNDARIES.
//
// The defect was a missing FILE, not a wrong line: with no `error.tsx` above a
// failing segment, a server render failure reaches Next's `onUncaughtError` and
// the tab is left empty. Deleting any of these restores that silently — no
// import breaks and no route changes status — so, like
// `not-found-boundary.test.ts` one concern over, the invariant is asserted on
// the files themselves. Each depth needs its own file because a segment's
// boundary never catches its own layout.

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

const BOUNDARIES = [
  { path: 'app/(authed)/error.tsx', catches: 'a page under (authed)' },
  { path: 'app/error.tsx', catches: 'app/(authed)/layout.tsx' },
  { path: 'app/global-error.tsx', catches: 'app/layout.tsx' },
] as const;

describe('the three error boundaries exist and do their two jobs', () => {
  for (const { path, catches } of BOUNDARIES) {
    it(`${path} exists as a client component (it catches ${catches})`, () => {
      expect(existsSync(join(ROOT, path)), `${path} is missing`).toBe(true);
      expect(read(path).trimStart().startsWith("'use client'")).toBe(true);
    });

    it(`${path} retries with unstable_retry, never a bare reset`, () => {
      // Comments may (and do) explain why `reset` is NOT used; only code counts.
      const source = stripComments(read(path));
      expect(source).toMatch(/unstable_retry/);
      expect(source).not.toMatch(/\breset\s*\(/);
    });
  }

  it('states 1 and 2 report what they caught; state 3 reports through GlobalErrorContent', () => {
    expect(read('app/(authed)/error.tsx')).toMatch(/useReportCaughtError\(error, 'authed-page'\)/);
    expect(read('app/error.tsx')).toMatch(/useReportCaughtError\(error, 'app'\)/);
    expect(read('app/global-error.tsx')).toMatch(/<GlobalErrorContent/);
    expect(read('components/errors/GlobalErrorContent.tsx')).toMatch(
      /useReportCaughtError\(error, 'global'\)/,
    );
  });

  it('global-error brings what the root layout it replaces supplied: html, styles, fonts, appearance', () => {
    const source = stripComments(read('app/global-error.tsx'));
    expect(source).toMatch(/<html/);
    expect(source).toMatch(/<body>/);
    expect(source).toMatch(/import '\.\/globals\.css'/);
    expect(source).toMatch(/fontVariables/);
    expect(source).toMatch(/themeInitScript/);
    // One authority for ink and ground: never a colour keyed on the OS scheme.
    expect(source).not.toMatch(/prefers-color-scheme/);
  });

  it('the root layout and global-error share ONE font declaration', () => {
    expect(read('app/layout.tsx')).toMatch(/import \{ fontVariables \} from '\.\/fonts'/);
    expect(read('app/layout.tsx')).not.toMatch(/next\/font\/google/);
  });
});
