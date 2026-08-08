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
// so they are stripped before the walk — and so are COMMENTS, which are not
// imports either however exactly they quote one (MOTIR-2461).
//
// ⚠️ THE TWO FAILURE DIRECTIONS ARE NOT SYMMETRIC, and every edit here has to
// keep them that way. OVER-reporting blocks a clean file on a red build someone
// has to read. UNDER-reporting ships a database client to an anonymous reader
// with both guards green. So `stripComments` below is deliberately timid: it
// gives up on any construct it cannot close on the SAME LINE and treats the
// opening character as ordinary code, because a scanner that guesses wrong then
// loses one line rather than the whole rest of the file. Its behaviour is
// pinned by `tests/helpers/importGraph.test.ts`, including a sweep over every
// real source file in `app/`, `lib/` and `components/` asserting that no
// specifier quoted on a code line ever disappears.

export const REPO_ROOT = resolve(__dirname, '..', '..');

/** The Prisma singleton — the module whose reachability these guards measure. */
export const DB_MODULE = 'lib/db.ts';

const RESOLUTION_SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

/** Keywords after which a `/` opens a REGEX rather than dividing. */
const REGEX_MAY_FOLLOW = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/** Whether a `/` preceded by `prev` starts a regex literal. */
function regexCanFollow(prev: string): boolean {
  if (prev === '') return true;
  if (/^[A-Za-z_$]/.test(prev)) return REGEX_MAY_FOLLOW.has(prev);
  // A digit, or something a value can end with, means division. `}` is
  // genuinely ambiguous (a block ends with one, so does an object literal) and
  // is read as division: the timid choice, since a mis-read regex is scanned as
  // ordinary code and the same-line rules below contain the damage.
  return !/[0-9)\]}'"`]/.test(prev);
}

/**
 * Index just past the string opened at `start`, or -1 when it does not close
 * before the newline. A quote that never closes on its line is not a string —
 * it is an apostrophe in prose or a character class — and reading it as one is
 * how a scanner loses every import in the rest of a file.
 */
function endOfQuoted(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (char === '\\') i++;
    else if (char === '\n') return -1;
    else if (char === quote) return i + 1;
  }
  return -1;
}

/** Index just past the regex (flags included) opened at `start`, or -1. */
function endOfRegex(source: string, start: number): number {
  let inCharacterClass = false;
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (char === '\\') i++;
    else if (char === '\n') return -1;
    else if (inCharacterClass) inCharacterClass = char !== ']';
    else if (char === '[') inCharacterClass = true;
    else if (char === '/') {
      let end = i + 1;
      while (end < source.length && /[a-z]/.test(source[end]!)) end++;
      return end;
    }
  }
  return -1;
}

/** Index just past the template literal opened at `start`, or -1. */
function endOfTemplate(source: string, start: number): number {
  let depth = 0;
  for (let i = start + 1; i < source.length; i++) {
    const char = source[i];
    if (char === '\\') i++;
    else if (depth > 0) {
      // Inside `${ … }`. Nested quotes are skipped so a `}` in a string cannot
      // close the substitution early.
      if (char === '{') depth++;
      else if (char === '}') depth--;
      else if (char === "'" || char === '"') {
        const end = endOfQuoted(source, i);
        if (end !== -1) i = end - 1;
      }
    } else if (char === '$' && source[i + 1] === '{') {
      depth++;
      i++;
    } else if (char === '`') return i + 1;
  }
  return -1;
}

/**
 * The source with every `//` and `/* … *\/` comment blanked to spaces.
 *
 * The result has the SAME LENGTH and the same newlines as the input, so every
 * offset, line and column still points where it did — a stripper that deleted
 * instead could join two lines into a specifier neither of them contained.
 *
 * A `//` inside a string, template or regex literal is not a comment, so those
 * are recognised and skipped. Each is required to close on its own line (a
 * template may span lines, as the language allows); anything that does not is
 * treated as an ordinary character rather than as an opener that runs away.
 */
export function stripComments(source: string): string {
  const out = source.split('');
  let previousToken = '';
  let i = 0;

  while (i < source.length) {
    const char = source[i]!;

    if (char === '/' && source[i + 1] === '/') {
      const lineEnd = source.indexOf('\n', i);
      const stop = lineEnd === -1 ? source.length : lineEnd;
      for (; i < stop; i++) out[i] = ' ';
      continue;
    }

    if (char === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const stop = close === -1 ? source.length : close + 2;
      for (; i < stop; i++) if (out[i] !== '\n') out[i] = ' ';
      continue;
    }

    if (char === "'" || char === '"') {
      const end = endOfQuoted(source, i);
      previousToken = char;
      i = end === -1 ? i + 1 : end;
      continue;
    }

    if (char === '`') {
      const end = endOfTemplate(source, i);
      previousToken = char;
      i = end === -1 ? i + 1 : end;
      continue;
    }

    if (char === '/' && regexCanFollow(previousToken)) {
      const end = endOfRegex(source, i);
      if (end !== -1) {
        previousToken = '/';
        i = end;
        continue;
      }
    }

    if (/[A-Za-z_$]/.test(char)) {
      let end = i;
      while (end < source.length && /[A-Za-z0-9_$]/.test(source[end]!)) end++;
      previousToken = source.slice(i, end);
      i = end;
      continue;
    }

    if (!/\s/.test(char)) previousToken = char;
    i++;
  }

  return out.join('');
}

/** Strip `import type … from '…'` — erased at compile time, never bundled. */
export function stripTypeOnlyImports(source: string): string {
  return source.replace(/(^|\n)\s*import\s+type\s+[\s\S]*?\s+from\s+['"][^'"]+['"];?/g, '$1');
}

/** Every runtime module specifier a file imports or re-exports from. */
export function specifiersOf(source: string): string[] {
  const code = stripTypeOnlyImports(stripComments(source));
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
