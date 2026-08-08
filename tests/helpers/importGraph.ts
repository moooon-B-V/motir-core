import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// A tiny static import-graph walker for the "which routes carry a database
// client" guards (MOTIR-2381's root layout, MOTIR-2452's public docs tree).
//
// WHY A STATIC WALK. Next traces every server function's file closure into
// `.next/server/**/*.nft.json` and `copyTracedFiles` ships exactly that union,
// so a module reaches a route's bundle by being IMPORTED — not by being called.
// `scripts/measure-prisma-traces.mjs` reads the real manifest and is the
// authority, but it needs a full `next build`; this walk answers the same
// question from source in milliseconds, which is what makes it usable as a
// per-PR regression guard.
//
// The walk follows LOCAL specifiers only (`@/…` and relative). A node_modules
// path is out of the app's control and none of our data access goes that way.
// `import type` statements are erased by the compiler and never reach a bundle,
// so they are stripped before the walk.

export const REPO_ROOT = resolve(__dirname, '..', '..');

/** The Prisma singleton — the module whose reachability these guards measure. */
export const DB_MODULE = 'lib/db.ts';

const RESOLUTION_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

/** Strip `import type … from '…'` — erased at compile time, never bundled. */
export function stripTypeOnlyImports(source: string): string {
  return source.replace(/(^|\n)\s*import\s+type\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?/g, '$1');
}

/** Every runtime module specifier a file imports or re-exports from. */
export function specifiersOf(source: string): string[] {
  const code = stripTypeOnlyImports(source);
  const found = new Set<string>();
  for (const match of code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) found.add(match[1]!);
  for (const match of code.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) found.add(match[1]!);
  return [...found];
}

/** Repo-relative path for a LOCAL specifier, or null when it is a package. */
export function resolveLocal(specifier: string, fromFile: string): string | null {
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
 * reaches `target`, or null when nothing does. Breadth-first, so the reported
 * chain is the SHORTEST one — the actionable one.
 */
export function pathToModule(entry: string, target: string = DB_MODULE): string[] | null {
  const seen = new Set<string>([entry]);
  const queue: string[][] = [[entry]];

  while (queue.length > 0) {
    const chain = queue.shift()!;
    const file = chain[chain.length - 1]!;
    if (file === target) return chain;

    for (const specifier of specifiersOf(readFileSync(join(REPO_ROOT, file), 'utf8'))) {
      const next = resolveLocal(specifier, file);
      if (next === null || seen.has(next)) continue;
      seen.add(next);
      queue.push([...chain, next]);
    }
  }
  return null;
}

/**
 * The chains by which `file`'s own imports reach `target`, one entry per
 * offending specifier. Empty when the file's closure is clean.
 */
export function chainsToModule(
  file: string,
  target: string = DB_MODULE,
): Array<{ specifier: string; chain: string[] }> {
  const source = readFileSync(join(REPO_ROOT, file), 'utf8');
  const offenders: Array<{ specifier: string; chain: string[] }> = [];

  for (const specifier of specifiersOf(source)) {
    const local = resolveLocal(specifier, file);
    if (local === null) continue;
    const chain = pathToModule(local, target);
    if (chain !== null) offenders.push({ specifier, chain: [file, ...chain] });
  }
  return offenders;
}

/** Render offender chains as an assertion message a reader can act on. */
export function describeChains(offenders: Array<{ specifier: string; chain: string[] }>): string {
  return offenders.map((o) => `  ${o.specifier}\n    ${o.chain.join('\n    → ')}`).join('\n');
}
