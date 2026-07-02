// Post-build directive preservation.
//
// esbuild (via tsup) strips the `'use client'` / `'use server'` directive
// prologue from bundled output, and tsup has no reliable built-in to keep it.
// Without the directive a Next consumer would treat the interactive primitives
// + the theme provider as Server Components and crash on their hooks. This step
// re-adds the directive to each emitted `dist` file whose SOURCE declared one —
// keeping the client/server module boundary the ADR (§5) fixes. It is driven by
// the source files (not a hand-list), so it can never drift from what ships.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = 'src';
const DIST = 'dist';
const DIRECTIVE_RE = /^\s*(['"])use (client|server)\1\s*;?\s*$/;

/** Recursively list every file under `dir`. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** The directive on a file's first non-empty line, or null. */
function leadingDirective(code) {
  for (const line of code.split('\n')) {
    if (line.trim() === '') continue;
    const m = line.match(DIRECTIVE_RE);
    return m ? `'use ${m[2]}';` : null;
  }
  return null;
}

let count = 0;
for (const srcFile of walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f))) {
  const directive = leadingDirective(readFileSync(srcFile, 'utf8'));
  if (!directive) continue;

  const outFile = join(DIST, relative(SRC, srcFile).replace(/\.tsx?$/, '.js'));
  let out;
  try {
    out = readFileSync(outFile, 'utf8');
  } catch {
    continue; // no emitted counterpart (e.g. a type-only module tree-shaken away)
  }
  if (leadingDirective(out)) continue; // already present

  writeFileSync(outFile, `${directive}\n${out}`);
  count += 1;
}

console.warn(`[preserve-use-client] re-added directive to ${count} file(s)`);
