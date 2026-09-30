import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

// Regression guard for MOTIR-1538: the published `.` entry (`dist/index.js`) must
// stay a THIN re-export barrel — never the raw tsup bundle that INLINES every
// re-exported module (including the theme provider's top-level
// `import { createContext } from 'react'`) with no `'use client'` directive.
//
// That bundle crashes a Next RSC consumer the instant a Server Component imports
// a *server-safe* export (e.g. `buildThemeInitScript`) through the barrel:
// "You're importing a module that depends on `createContext` into a React Server
// Component" — the barrel eagerly pulls a client-only API server-side. The build
// (tsup `onSuccess` → `build-index-barrel.mjs`) rewrites the barrel to re-export
// the sibling per-file chunks instead; this test asserts that rewrite held, so a
// future build/config change can't silently reintroduce the RSC crash (ADR §5).

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST_INDEX = fileURLToPath(new URL('../dist/index.js', import.meta.url));

let barrel: string;

beforeAll(() => {
  // The test reads the BUILT artifact. It normally already exists (the workspace
  // `postinstall` builds the package, and CI builds it before this suite); build
  // it on demand so a standalone local run isn't a confusing failure.
  if (!existsSync(DIST_INDEX)) {
    execSync('pnpm run build', { cwd: PKG_ROOT, stdio: 'inherit' });
  }
  barrel = readFileSync(DIST_INDEX, 'utf8');
}, 120_000);

describe('dist/index.js is an RSC-safe thin barrel', () => {
  it('has no top-level `react` import (no client API pulled by the barrel)', () => {
    // The whole bug: the bundled barrel carried `import { createContext } from
    // 'react'`. A thin re-export barrel imports nothing from react — the react
    // dependency lives only in the per-file client chunks it points at.
    expect(barrel).not.toMatch(/from\s*['"]react['"]/);
    expect(barrel).not.toMatch(/require\(\s*['"]react['"]\s*\)/);
  });

  it('carries no leading `use client` / `use server` directive (a mixed barrel)', () => {
    // A directive on the barrel would mark EVERY re-exported module as that mode
    // — which is exactly what breaks the server/client split. The barrel must be
    // directive-less; the directives live on the individual chunks.
    const firstCode = barrel.split('\n').find((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith('//');
    });
    expect(firstCode).toBeDefined();
    expect(firstCode).not.toMatch(/^\s*['"]use (client|server)['"]/);
  });

  it('contains only re-export lines (no inlined module code)', () => {
    // Every executable line must be a re-export of a sibling chunk. Any other
    // statement (an `import`, a declaration, a function body) means tsup inlined
    // a module back into the barrel — the regression.
    const codeLines = barrel
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('//'));

    expect(codeLines.length).toBeGreaterThan(0);
    for (const line of codeLines) {
      expect(line, `unexpected non-re-export line in dist/index.js: ${line}`).toMatch(
        /^export\b.*\bfrom\s*['"]\.[^'"]*['"]\s*;?$/,
      );
    }
  });

  it('re-exports both a server-safe chunk and a client chunk (a real, non-empty barrel)', () => {
    // Sanity: prove it is the actual design-system barrel, not an empty/partial
    // file that would pass the checks above vacuously. `init-script` is a
    // server-safe export; `theme-context` is the client theme provider.
    expect(barrel).toMatch(/from\s*['"]\.\/theme\/init-script(\.js)?['"]/);
    expect(barrel).toMatch(/from\s*['"]\.\/contexts\/theme-context(\.js)?['"]/);
  });
});

// MOTIR-6966 — the `./mock` subpath (MOTIR-6961) is NODE-ONLY: it reads files,
// imports `react-dom/server` and compiles Tailwind. None of that may reach the
// main entry, which a Next client component imports. A thin barrel can still
// leak through a chunk it re-exports, so this walks EVERY module `dist/index.js`
// reaches through relative imports, not just the barrel's own lines.
describe('dist/index.js reaches no node-only module (the ./mock subpath stays off it)', () => {
  const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
  const SPECIFIER = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g;

  function reachable(): { files: string[]; bare: Map<string, string> } {
    const seen = new Set<string>();
    const bare = new Map<string, string>();
    const queue = [path.join(DIST, 'index.js')];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      // Comments are stripped first: a comment quoting `@import 'tailwindcss'` is not an import.
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const m of code.matchAll(SPECIFIER)) {
        const spec = (m[1] ?? m[2])!;
        if (spec.startsWith('.')) {
          const target = path.resolve(path.dirname(file), spec);
          queue.push(target.endsWith('.js') ? target : `${target}.js`);
        } else if (!bare.has(spec)) {
          bare.set(spec, path.relative(DIST, file));
        }
      }
    }
    return { files: [...seen].map((f) => path.relative(DIST, f)), bare };
  }

  it('walks a real graph, not just the barrel', () => {
    expect(reachable().files.length).toBeGreaterThan(10);
  });

  it('imports no react-dom/server, no node: built-in and no tailwindcss compiler', () => {
    const offenders = [...reachable().bare].filter(
      ([spec]) =>
        spec === 'react-dom/server' ||
        spec.startsWith('node:') ||
        spec === 'tailwindcss' ||
        ['fs', 'path', 'url', 'module', 'fs/promises'].includes(spec),
    );
    expect(offenders, JSON.stringify(offenders)).toEqual([]);
  });

  it('never reaches a mock/ chunk', () => {
    expect(reachable().files.filter((f) => f.startsWith(`mock${path.sep}`))).toEqual([]);
  });

  it('the guard is live: the ./mock entry itself DOES reach those imports', () => {
    const mock = readFileSync(path.join(DIST, 'mock', 'renderMock.js'), 'utf8');
    expect(mock).toMatch(/from\s*['"]react-dom\/server['"]/);
    expect(mock).toMatch(/from\s*['"](node:)?fs\/promises['"]/);
    expect(mock).toMatch(/from\s*['"]tailwindcss['"]/);
  });
});
