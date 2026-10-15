import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// THE SCANNER BEHIND THE IN-PROCESS-STATE GUARDS (Story MOTIR-8547 · MOTIR-8619).
//
// Pure functions over a string, plus one file walk, so `guards.test.ts` can run
// the IDENTICAL code over the real tree and over the planted control fixtures —
// a control that re-implemented the predicate would prove the control works,
// not the predicate.
//
// "Module scope" is read as COLUMN ZERO. Every source file is prettier-formatted,
// so a top-level statement starts at column 0 and anything inside a function,
// class or object literal is indented. That is a textual approximation, stated
// as one: it is enough to catch the defect these guards exist for — a
// `const cache = new Map()` or a `let counter` added at the top of a module —
// and it cannot be fooled by a `new Map()` inside a function body, which is
// per-call state, not per-process state.

/** The three classes `docs/in-process-state-inventory.md` §2 defines. */
export const INVENTORY_CLASSES = ['shared', 'safe per instance', 'moved'] as const;
export type InventoryClass = (typeof INVENTORY_CLASSES)[number];

export interface InventoryRow {
  /** The `file:line` cell, verbatim. */
  site: string;
  /** The class cell, verbatim and trimmed. */
  cls: string;
  /** The staleness-bound cell, verbatim and trimmed. */
  bound: string;
  /** The target-store cell (the last column), verbatim and trimmed. */
  target: string;
}

/**
 * Parse the §2 site table: the one whose header row starts `| file:line`. Every
 * row until the first non-table line is returned, in order. Throws when the
 * table is missing, so a renamed header fails the guard instead of passing it
 * with zero rows.
 */
export function parseInventoryTable(markdown: string): InventoryRow[] {
  const lines = markdown.split('\n');
  const header = lines.findIndex((l) => /^\|\s*file:line\s*\|/.test(l));
  if (header < 0) throw new Error('inventory: no table whose header starts "| file:line |"');
  const rows: InventoryRow[] = [];
  // header + the `| --- |` separator, then the body.
  for (let i = header + 2; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.startsWith('|')) break;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length !== 6) {
      throw new Error(`inventory: row ${i + 1} has ${cells.length} cells, not 6: ${line}`);
    }
    rows.push({ site: cells[0]!, cls: cells[2]!, bound: cells[3]!, target: cells[5]! });
  }
  return rows;
}

/** Every backticked repo path ending `.ts` / `.tsx` / `.js` in a cell. */
export function pathsIn(cell: string): string[] {
  return [...cell.matchAll(/`((?:lib|app)\/[^`\s:]+\.(?:tsx?|m?js))(?::\d+)?`/g)].map((m) => m[1]!);
}

/** One finding: the line (1-based) and the text that matched. */
export interface ScanHit {
  line: number;
  text: string;
  why: string;
}

/**
 * The line as code: a line that is all comment (`//`, a `/*` opener or a `*`
 * continuation) becomes ''. A trailing comment is kept — every pattern below is
 * either anchored at column 0 or specific enough that a trailing comment naming
 * it would itself be worth a look.
 */
function codeOf(line: string): string {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return '';
  return line;
}

const MODULE_SCOPE_COLLECTION =
  /^(?:export\s+)?(?:const|let|var)\s+[\w$]+[^=]*=\s*new\s+(Map|Set|WeakMap)\s*[<(]/;
const MODULE_SCOPE_MUTABLE = /^(?:export\s+)?(?:let|var)\s+[\w$]+/;
const TTL_MARKER = /\/\/\s*read-through cache, TTL (\d+)s\b/;

/**
 * Module-scope state in a source file: a column-zero `new Map(` / `new Set(` /
 * `new WeakMap(` declaration, or a column-zero `let` / `var`.
 *
 * A line carrying `// read-through cache, TTL <n>s` is excused only when
 * `maxTtlSeconds` is a number and `n` is at or below it — the inventory's
 * recorded bound. With no bound (`null`, a **shared** row) nothing is excused.
 */
export function findModuleScopeState(source: string, maxTtlSeconds: number | null): ScanHit[] {
  const hits: ScanHit[] = [];
  source.split('\n').forEach((raw, index) => {
    const code = codeOf(raw);
    if (!code) return;
    const collection = MODULE_SCOPE_COLLECTION.exec(code);
    const mutable = MODULE_SCOPE_MUTABLE.test(code);
    if (!collection && !mutable) return;
    const marker = TTL_MARKER.exec(raw);
    if (marker && maxTtlSeconds !== null && Number(marker[1]) <= maxTtlSeconds) return;
    hits.push({
      line: index + 1,
      text: raw.trim(),
      why: collection ? `module-scope new ${collection[1]}(` : 'module-scope mutable let/var',
    });
  });
  return hits;
}

/** A Better-Auth `storage: 'memory'` (any quote) on a code line. */
export function findMemoryStorage(source: string): ScanHit[] {
  const hits: ScanHit[] = [];
  source.split('\n').forEach((raw, index) => {
    if (/\bstorage\s*:\s*['"`]memory['"`]/.test(codeOf(raw))) {
      hits.push({ line: index + 1, text: raw.trim(), why: "storage: 'memory'" });
    }
  });
  return hits;
}

/** A call to `createInProcessRateLimitStore(` on a code line (the declaration included). */
export function findInProcessStoreConstruction(source: string): ScanHit[] {
  const hits: ScanHit[] = [];
  source.split('\n').forEach((raw, index) => {
    if (/\bcreateInProcessRateLimitStore\s*\(/.test(codeOf(raw))) {
      hits.push({ line: index + 1, text: raw.trim(), why: 'createInProcessRateLimitStore(' });
    }
  });
  return hits;
}

const SOURCE_FILE = /\.(?:tsx?|m?js)$/;

/**
 * Every source file under `dirs` (repo-relative, forward slashes), sorted. No
 * ref is involved: the test runs in a checkout, and the working tree IS what a
 * build ships.
 */
export function walkSources(root: string, dirs: readonly string[]): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (SOURCE_FILE.test(entry) && !/\.d\.ts$/.test(entry)) {
        out.push(relative(root, full).split(sep).join('/'));
      }
    }
  };
  for (const dir of dirs) visit(join(root, dir));
  return out;
}

/** Read a repo-relative file. */
export function readRepoFile(root: string, file: string): string {
  return readFileSync(join(root, file), 'utf8');
}
