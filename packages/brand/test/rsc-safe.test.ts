import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-1456 — the guard that keeps `tsup.config.ts`'s simplification honest.
//
// This package skips the two post-build fixups @motir/design-system needs
// (`preserve-use-client.mjs`, `build-index-barrel.mjs`) for ONE reason: nothing
// here is a client component, so there is no directive to preserve and the
// bundled `dist/index.js` entry cannot pull a client-only API into a React
// Server Component. That is a property of the sources, not of the config — and
// MOTIR-1538 is the record of what it costs when it stops holding: a server
// import of a server-safe export crashed `next build` with "importing
// createContext into a React Server Component", weeks after the change that
// caused it.
//
// So the premise gets a test. Adding a `'use client'` file to this package
// fails HERE, next to the comment explaining what to do about it, rather than
// in a consumer's build later.

const SRC = join(import.meta.dirname, '../src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
}

describe('the package is RSC-safe by construction', () => {
  const files = sources(SRC);

  it('scans a real, non-empty source set', () => {
    expect(files.length).toBeGreaterThan(2);
  });

  it('declares no `use client` directive anywhere', () => {
    const offenders = files.filter((file) => {
      const head = readFileSync(file, 'utf8').slice(0, 400);
      return /^\s*(['"])use client\1/m.test(head);
    });
    expect(
      offenders,
      'A client component here means tsup.config.ts must restore BOTH post-build steps ' +
        '(preserve-use-client + build-index-barrel) — see MOTIR-1538.',
    ).toEqual([]);
  });

  it('imports no React hook or context API, which is what would force one', () => {
    // The directive is the SYMPTOM; this is the cause. A file reaching for
    // useState / useEffect / createContext is a client module whether or not
    // anybody remembered to say so.
    const CLIENT_ONLY =
      /\b(useState|useEffect|useLayoutEffect|useReducer|useContext|createContext)\b/;
    const offenders = files.filter((file) => CLIENT_ONLY.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
