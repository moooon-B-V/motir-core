import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT, stripComments } from '../helpers/importGraph';
import {
  compileGlobals,
  resolveDeclarations,
  splitVariant,
  utilityRule,
  type UtilityCompiler,
} from '../helpers/tailwindCascade';

// MOTIR-5459 — no class list pairs a `line-clamp-*` with a display utility the
// compiled sheet lets OVERRIDE it.
//
// ── The defect ──────────────────────────────────────────────────────────────
// `line-clamp-N` works by making its element a `-webkit-box` and setting
// `-webkit-line-clamp: N`. Any other utility on the same element that sets
// `display` and is emitted AFTER it wins that property, and the clamp is then
// inert: the box keeps `overflow: hidden` but its height is no longer bounded,
// so a long title shows a third line instead of an ellipsis after line 2.
// `block` is such a utility. Eight canvas-card elements carried
// `line-clamp-* block` — plan proposal titles, roadmap titles, the ghost anchor's
// lines, the plan preview — on fixed-height nodes designed around a two-line
// title. Nothing errored and every "the title renders" test stayed green.
//
// ── What is DERIVED rather than listed ──────────────────────────────────────
// Which utilities override the clamp is not a list in this file. For every class
// list holding a clamp, each other utility beside it (same variant) is compiled
// through the real `app/globals.css`, and it is an offence exactly when its rule
// sets `display` and sits after the clamp's rule. So `inline-block`, `flex`,
// `grid`, `hidden` — or a display utility nobody has written yet — are caught
// the day they are emitted after the clamp, and one emitted BEFORE it (where the
// clamp wins) is not flagged at all.
//
// ── Which tokens can share an element ───────────────────────────────────────
// A template literal's STATIC text always applies; each string literal inside a
// `${…}` applies in some branch. So a clamp and an overrider pair when both are
// static, when one is static and the other is in any branch, or when both are in
// the same literal — `block ${hasSlot ? 'truncate' : 'line-clamp-2'}` is an
// offence on its no-slot branch. Two literals inside expressions are NOT paired:
// `${a ? 'block' : 'line-clamp-2'}` can never apply both.
//
// Not covered, and deliberately: a clamp and an overrider passed as SEPARATE
// arguments to `cn(…)`. `cn` runs `tailwind-merge`, which already treats
// `line-clamp` as conflicting with `display` and keeps only the later one, so
// that pair does not reach the element together.

const SCAN_ROOTS = ['app', 'components', 'packages/design-system/src'] as const;

/** A clamp utility with a real line count — `line-clamp-none` clamps nothing. */
const CLAMP = /^line-clamp-(?:\d+|\[[^\]]+\]|\([^)]+\))$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(relative(REPO_ROOT, full).split(sep).join('/'));
  }
  return out;
}

const SOURCE_FILES = SCAN_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root)));

/** One string or template literal: the tokens that always apply, and each branch's. */
interface ClassList {
  line: number;
  fixed: string[];
  conditional: string[][];
}

const tokensOf = (text: string) => text.split(/\s+/).filter(Boolean);

/** The closing quote of a `'…'` / `"…"` literal, or -1 (they cannot span lines). */
function quotedEnd(code: string, start: number): number {
  const quote = code[start];
  for (let i = start + 1; i < code.length; i++) {
    const ch = code[i];
    if (ch === '\\') i++;
    else if (ch === quote) return i;
    else if (ch === '\n') return -1;
  }
  return -1;
}

function readTemplate(
  code: string,
  start: number,
): { end: number; fixed: string[]; conditional: string[][] } {
  const fixed: string[] = [];
  const conditional: string[][] = [];
  let text = '';
  let i = start + 1;
  while (i < code.length && code[i] !== '`') {
    if (code[i] === '\\') {
      text += code.slice(i, i + 2);
      i += 2;
    } else if (code[i] === '$' && code[i + 1] === '{') {
      fixed.push(...tokensOf(text));
      text = '';
      i = readExpression(code, i + 2, conditional);
    } else {
      text += code[i++];
    }
  }
  fixed.push(...tokensOf(text));
  return { end: i, fixed, conditional };
}

/** Collect the literals inside one `${…}`; returns the index after its `}`. */
function readExpression(code: string, start: number, conditional: string[][]): number {
  let depth = 0;
  let i = start;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      const end = quotedEnd(code, i);
      if (end < 0) {
        i++;
        continue;
      }
      conditional.push(tokensOf(code.slice(i + 1, end)));
      i = end + 1;
      continue;
    }
    if (ch === '`') {
      const inner = readTemplate(code, i);
      conditional.push(inner.fixed, ...inner.conditional);
      i = inner.end + 1;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      if (depth === 0) return i + 1;
      depth--;
    }
    i++;
  }
  return i;
}

function classListsIn(code: string): ClassList[] {
  const lists: ClassList[] = [];
  const lineAt = (pos: number) => code.slice(0, pos).split('\n').length;
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'") {
      const end = quotedEnd(code, i);
      if (end < 0) {
        i++;
        continue;
      }
      lists.push({ line: lineAt(i), fixed: tokensOf(code.slice(i + 1, end)), conditional: [] });
      i = end + 1;
    } else if (ch === '`') {
      const template = readTemplate(code, i);
      lists.push({ line: lineAt(i), fixed: template.fixed, conditional: template.conditional });
      i = template.end + 1;
    } else {
      i++;
    }
  }
  return lists;
}

/** Every (clamp, other) pair that can land on one element, same variant chain. */
function clampPairsIn(list: ClassList): Array<{ clamp: string; other: string }> {
  const pairs = new Map<string, { clamp: string; other: string }>();
  const consider = (clamps: string[], others: string[]) => {
    for (const clamp of clamps) {
      const c = splitVariant(clamp);
      if (!CLAMP.test(c.utility)) continue;
      for (const other of others) {
        if (other === clamp) continue;
        const o = splitVariant(other);
        if (o.variant !== c.variant || CLAMP.test(o.utility)) continue;
        pairs.set(`${clamp}|${other}`, { clamp, other });
      }
    }
  };
  consider(list.fixed, list.fixed);
  for (const branch of list.conditional) {
    consider(list.fixed, branch);
    consider(branch, list.fixed);
    consider(branch, branch);
  }
  return [...pairs.values()];
}

/** True when `other`'s rule sets `display` and is emitted after `clamp`'s. */
function overridesClamp(css: string, clamp: string, other: string): boolean {
  const clampRule = utilityRule(css, splitVariant(clamp).utility);
  const otherRule = utilityRule(css, splitVariant(other).utility);
  if (!clampRule || !otherRule) return false;
  return otherRule.declarations.has('display') && otherRule.offset > clampRule.offset;
}

interface Offence {
  file: string;
  line: number;
  clamp: string;
  other: string;
}

const LISTS = SOURCE_FILES.map((file) => ({
  file,
  lists: classListsIn(stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'))),
}));

let compiler: UtilityCompiler;
beforeAll(async () => {
  compiler = await compileGlobals();
});

describe('line-clamp beside an overriding display utility (MOTIR-5459)', () => {
  it('reads the tree, and finds EVERY clamp token in it — the parse is not lossy', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(500);
    const parsed = LISTS.flatMap(({ lists }) =>
      lists.flatMap((l) => [...l.fixed, ...l.conditional.flat()]),
    ).filter((t) => CLAMP.test(splitVariant(t).utility)).length;
    // An independent count over the same comment-stripped text. If the literal
    // scanner ever loses its place in a file (an apostrophe in JSX text, a regex
    // literal), a clamp goes unread and this number is where it shows.
    const raw = SOURCE_FILES.reduce((n, file) => {
      const code = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
      return (
        n +
        (
          code.match(/(?<![\w-])(?:[\w-]+:)*!?line-clamp-(?:\d+|\[[^\]]+\]|\([^)]+\))(?![\w-])/g) ??
          []
        ).length
      );
    }, 0);
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBe(raw);
  });

  it('the compiled cascade: `block` is emitted after `line-clamp-2` and takes `display` from it', () => {
    // The counterfactual the guard's verdicts rest on. If Tailwind ever emitted
    // `block` first, this goes red and says so, instead of the guard below going
    // quietly green over a pair that became harmless.
    const css = compiler.build(['line-clamp-2', 'block']);
    expect(utilityRule(css, 'line-clamp-2')?.declarations.get('display')).toBe('-webkit-box');
    expect(overridesClamp(css, 'line-clamp-2', 'block')).toBe(true);
    expect(resolveDeclarations(css, ['line-clamp-2', 'block']).get('display')).toBe('block');
    expect(resolveDeclarations(css, ['line-clamp-2']).get('display')).toBe('-webkit-box');
    expect(resolveDeclarations(css, ['line-clamp-2']).get('-webkit-line-clamp')).toBe('2');
    // A non-display neighbour does not count.
    expect(overridesClamp(css, 'line-clamp-2', 'text-sm')).toBe(false);
  });

  it('pairs exactly the tokens that can share an element', () => {
    const pairs = (src: string) =>
      classListsIn(src).flatMap((l) => clampPairsIn(l).map((p) => `${p.clamp}+${p.other}`));
    expect(pairs('<span className="mt-1 line-clamp-2 block" />')).toContain('line-clamp-2+block');
    // Static text beside a branch — the no-slot branch still carries both.
    expect(pairs("const c = `mt-0.5 block ${hasSlot ? 'truncate' : 'line-clamp-2'}`;")).toContain(
      'line-clamp-2+block',
    );
    // Two branches of one ternary can never apply together.
    expect(pairs("const c = `${a ? 'block' : 'line-clamp-2'}`;")).toEqual([]);
    // A variant pairs only with the same variant chain.
    expect(pairs('"line-clamp-2 md:block"')).not.toContain('line-clamp-2+md:block');
    expect(pairs('"md:line-clamp-2 md:block"')).toContain('md:line-clamp-2+md:block');
    // `line-clamp-none` clamps nothing.
    expect(pairs('"line-clamp-none block"')).toEqual([]);
  });

  it('NO class list under app/, components/ or the design system lets a display utility override its clamp', () => {
    const candidates = new Set<string>();
    const found: Array<Offence> = [];
    for (const { file, lists } of LISTS) {
      for (const list of lists) {
        for (const pair of clampPairsIn(list)) {
          candidates.add(splitVariant(pair.clamp).utility);
          candidates.add(splitVariant(pair.other).utility);
          found.push({ file, line: list.line, ...pair });
        }
      }
    }
    const css = compiler.build([...candidates]);
    const offences = found
      .filter((p) => overridesClamp(css, p.clamp, p.other))
      .map((p) => `${p.file}:${p.line} — \`${p.clamp}\` is overridden by \`${p.other}\``);
    expect(
      offences,
      'Each class list below sets `display` AFTER its `line-clamp-*`, so the clamp is inert and ' +
        'long text spills past its line budget. Drop the display utility: `line-clamp-*` already ' +
        'makes the element a block-level `-webkit-box`.',
    ).toEqual([]);
  });
});
