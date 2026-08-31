import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// ⚠️ EVERY `--el-*` A COMPONENT REFERENCES MUST RESOLVE TO A DEFINITION
// (MOTIR-4025, and the defect that motivated it is MOTIR-4020's).
//
// ── The defect this guards ──────────────────────────────────────────────────
// `ProjectRoadmapCanvas.tsx:1087` shipped `bg-(--el-accent-soft)` on the
// Show-changes control's PRESSED state. `--el-accent-soft` is declared NOWHERE —
// not in `theme.css`, not in `globals.css`, not under any `[data-style]` or
// `[data-palette]` block. Tailwind emits `background-color:
// var(--el-accent-soft)`, an unresolved custom property is invalid at
// computed-value time, and the declaration is simply dropped. Measured on the
// running app: `backgroundColor: rgba(0, 0, 0, 0)` with `aria-pressed="true"` —
// the pressed control had no background at all, over a canvas, for as long as it
// shipped.
//
// **Nothing could have caught it.** The type checker does not read class strings;
// Tailwind resolves an arbitrary property without asking whether it exists; no
// style lint runs over these files; and the ink-contrast guard rules on `--el-*`
// PAIRS it recognises, not on names it has never seen. The one signal was a
// screenshot nobody took.
//
// ── Where it came from, which is why the guard is worth its cost ────────────
// The name was a LOCAL variable in a design mock — `plan-canvas-arrival.mock.html`
// declares `--accent-soft: #f4f2fd`, a hex that appears nowhere in the design
// system — which the design note then transcribed into the `--el-*` namespace,
// where it reads exactly like a token. A mock that declares its own token names
// can put a non-existent one into production, and this is the check that stops
// the next one.
//
// ── Scope ───────────────────────────────────────────────────────────────────
// Widened from `components/planning` to the whole app source (MOTIR-4032): the
// story that found the defect shipped the guard scoped to the surface it found
// it on, and the widening was sized rather than discovered — a repo-wide run
// over these three roots returns exactly ONE other undefined name (`--el-page`,
// two sites), which that bug fixed. The three roots are every directory a
// shipped `--el-*` reference can live in; `node_modules`, `.next` and the
// compiled `dist/` are out of scope by construction (they are not listed).

const ROOT = process.cwd();
const SCOPE = ['components', 'app', 'packages/design-system/src'];
const THEME = join(ROOT, 'packages/design-system/theme.css');

/** Every `--el-*` name DECLARED anywhere in the shipped token layer. */
function declaredTokens(): Set<string> {
  const css = readFileSync(THEME, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const declared = new Set<string>();
  for (const m of css.matchAll(/(--el-[a-z0-9-]+)\s*:/gi)) declared.add(m[1]!);
  return declared;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

interface Reference {
  file: string;
  token: string;
  line: number;
}

/**
 * Every `--el-*` a file REFERENCES.
 *
 * Both spellings are read, because both ship: Tailwind's arbitrary-property
 * shorthand `bg-(--el-x)` and a raw `var(--el-x)` in a style object or a template
 * literal. A comment is stripped first — this file's own subject is a token that
 * no longer exists, and a guard that failed on the sentence explaining it would
 * be unusable.
 */
function referencesIn(file: string): Reference[] {
  const source = readFileSync(file, 'utf8');
  const found: Reference[] = [];
  const lines = source.split('\n');
  lines.forEach((raw, index) => {
    const line = raw.replace(/\/\/.*$/, '');
    if (/^\s*\*/.test(raw) || /^\s*\/\*/.test(raw)) return; // a block-comment body
    for (const m of line.matchAll(/[-(]\((--el-[a-z0-9-]+)\)|var\((--el-[a-z0-9-]+)/gi)) {
      const token = (m[1] ?? m[2])!;
      found.push({ file: relative(ROOT, file).split(sep).join('/'), token, line: index + 1 });
    }
  });
  return found;
}

const declared = declaredTokens();
const references = SCOPE.flatMap((dir) => walk(join(ROOT, dir))).flatMap(referencesIn);

describe('every --el-* referenced in the app source resolves', () => {
  it('finds references to rule on', () => {
    // Without this the assertion below passes vacuously the day the walk stops
    // finding files, or the day the two spellings change.
    expect(references.length).toBeGreaterThan(50);
    expect(declared.size).toBeGreaterThan(50);
  });

  it('declares every one of them in the design system’s theme', () => {
    const missing = references
      .filter((r) => !declared.has(r.token))
      .map((r) => `${r.file}:${r.line} — ${r.token} is referenced and DECLARED NOWHERE`);
    expect(
      [...new Set(missing)],
      'A class that references an undefined custom property is silently a class with ' +
        'no effect: Tailwind emits the declaration, the browser drops it as invalid at ' +
        'computed-value time, and nothing anywhere goes red. Either declare the token in ' +
        '`packages/design-system/theme.css`, or use one that exists — never leave the ' +
        'reference. This is exactly how the Show-changes control shipped with no ' +
        'background (MOTIR-4020).',
    ).toEqual([]);
  });

  it('has no reference to `--el-accent-soft`, the name that produced this guard', () => {
    // Named rather than left to the general rule, because a revert of MOTIR-4020
    // would reintroduce precisely this string and the general assertion's message
    // would not say so.
    expect(references.filter((r) => r.token === '--el-accent-soft')).toEqual([]);
    expect(declared.has('--el-accent-soft')).toBe(false);
  });
});
