import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// MOTIR-2381 — the ROOT layout's database reach is an explicit, justified list.
//
// `app/layout.tsx` is in EVERY route's module graph, so anything it imports is
// traced into every server function Next builds — a 404, the token specimen and
// the public docs tree included. And `lib/db.ts` constructs its `PrismaClient`
// at MODULE SCOPE (and throws when `DATABASE_URL` is unset), so "carried" here
// means "instantiated", not merely "bundled".
//
// Measured on this build (see `scripts/measure-prisma-traces.mjs`): 340 of 348
// traced functions carry `@prisma/client`. Dropping the two imports below took
// that to 330 — the landing page, the four `(auth)` screens, `_not-found` and
// the four `/tokens` specimen routes. They are NOT dropped, and the docstring
// in `app/layout.tsx` records why; this test exists so that the next import
// with a database behind it has to pass through the same question rather than
// arriving unnoticed.
//
// The graph walk follows LOCAL specifiers only (`@/…` and relative) — a
// node_modules path is out of the app's control and none of our data access
// goes that way. `import type` statements are erased by the compiler and never
// reach a bundle, so they are excluded before the walk.

const REPO_ROOT = resolve(__dirname, '..');
const ROOT_LAYOUT = 'app/layout.tsx';
const DB_MODULE = 'lib/db.ts';

/**
 * The imports of the ROOT layout that are allowed to reach `lib/db.ts`.
 *
 * Adding an entry here is a deliberate act with a measurable cost: it puts a
 * database client into every route in the product. Justify it in
 * `app/layout.tsx`'s docstring, and re-run the measurement script.
 */
const APPROVED_DB_REACHING_IMPORTS = [
  // The session the shell renders against. `<html>`'s appearance attributes and
  // the pre-paint FOUC script are root-scoped, so this read cannot move down.
  '@/lib/auth',
  // The signed-in user's applied appearance (7.3.61's cross-device, no-flash
  // guarantee). Same root scoping — see the layout docstring.
  '@/lib/services/appearancePreferenceService',
] as const;

const RESOLUTION_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

/** Strip `import type … from '…'` — erased at compile time, never bundled. */
function stripTypeOnlyImports(source: string): string {
  return source.replace(/(^|\n)\s*import\s+type\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?/g, '$1');
}

/** Every runtime module specifier a file imports or re-exports from. */
function specifiersOf(source: string): string[] {
  const code = stripTypeOnlyImports(source);
  const found = new Set<string>();
  for (const match of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) found.add(match[1]!);
  for (const match of code.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) found.add(match[1]!);
  return [...found];
}

/** Repo-relative path for a LOCAL specifier, or null when it is a package. */
function resolveLocal(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith('@/')) base = join(REPO_ROOT, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(REPO_ROOT, dirname(fromFile), specifier);
  else return null;

  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return relative(REPO_ROOT, candidate).split('\\').join('/');
    }
  }
  return null;
}

/**
 * Walk the local import graph from `entry` and return the first path that
 * reaches `lib/db.ts`, or null when nothing does. Breadth-first, so the
 * reported chain is the SHORTEST one — the actionable one.
 */
function pathToDb(entry: string): string[] | null {
  const seen = new Set<string>([entry]);
  const queue: string[][] = [[entry]];

  while (queue.length > 0) {
    const chain = queue.shift()!;
    const file = chain[chain.length - 1]!;
    if (file === DB_MODULE) return chain;

    for (const specifier of specifiersOf(readFileSync(join(REPO_ROOT, file), 'utf8'))) {
      const next = resolveLocal(specifier, file);
      if (next === null || seen.has(next)) continue;
      seen.add(next);
      queue.push([...chain, next]);
    }
  }
  return null;
}

describe('the root layout’s database reach (MOTIR-2381)', () => {
  it('reaches lib/db.ts through exactly the approved imports', () => {
    const source = readFileSync(join(REPO_ROOT, ROOT_LAYOUT), 'utf8');
    const offenders: Array<{ specifier: string; chain: string[] }> = [];

    for (const specifier of specifiersOf(source)) {
      const local = resolveLocal(specifier, ROOT_LAYOUT);
      if (local === null) continue;
      const chain = pathToDb(local);
      if (chain !== null) offenders.push({ specifier, chain: [ROOT_LAYOUT, ...chain] });
    }

    const reaching = offenders.map((o) => o.specifier).sort();
    expect(
      reaching,
      offenders.length > 0
        ? `Root-layout imports reaching ${DB_MODULE}:\n` +
            offenders.map((o) => `  ${o.specifier}\n    ${o.chain.join('\n    → ')}`).join('\n') +
            `\nEvery route in the product carries what this list reaches. If the new one ` +
            `belongs here, add it to APPROVED_DB_REACHING_IMPORTS and record why in ` +
            `${ROOT_LAYOUT}'s docstring.`
        : undefined,
    ).toEqual([...APPROVED_DB_REACHING_IMPORTS].sort());
  });

  it('lib/db.ts still constructs the client at module scope — the reason "carried" means "instantiated"', () => {
    // If this ever becomes lazy, the blast-radius half of MOTIR-2381's finding
    // changes and the trade-off recorded in app/layout.tsx should be re-read.
    const source = readFileSync(join(REPO_ROOT, DB_MODULE), 'utf8');
    expect(source).toMatch(/^export const db =/m);
  });
});
