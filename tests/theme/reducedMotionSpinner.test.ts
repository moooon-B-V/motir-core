// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';

// MOTIR-3844 — `@motir/design-system`'s Spinner must stop rotating under
// `prefers-reduced-motion: reduce`, for motir-core AND for a bare consumer.
//
// ── The defect this measures ────────────────────────────────────────────────
// `Spinner` paints `animate-spin`; Tailwind v4 defines `--animate-spin: spin 1s
// linear infinite` with no media query anywhere near it; and neither the
// package's `theme.css` nor either consumer's `globals.css` carried an
// override. `<Button loading>` substitutes a Spinner for the left icon, and six
// more call sites in motir-core paint `animate-spin` on a lucide icon directly —
// so the rotation reached every one of them, under every palette / style / type
// combination, whatever the reader had asked their OS for. The five
// reduced-motion blocks that existed guarded the `aurora` canvas drift and the
// `3d-immersive` tilt — decorative motion belonging to the style that
// introduced it. The spinner is the one animation that belongs to no style.
//
// ── Why the assertion is over the COMPILED stylesheet ───────────────────────
// The question is not "does the source file contain a rule" — it is "does that
// rule WIN". `.animate-spin` is emitted by Tailwind inside `@layer utilities`;
// the guard is unlayered, and an unlayered declaration outranks a layered one
// whatever their specificity. Reading the source file could not see either
// half: the utility does not exist until Tailwind generates it, and the layer
// it lands in is a property of the compilation, not of `theme.css`. So this
// suite runs the REAL Tailwind compiler over the REAL entry each consumer uses
// and reads the two competing declarations, with their layer and media context,
// off the artifact that ships.
//
// ── Why not a DOM computed style ────────────────────────────────────────────
// The honest instrument would be `getComputedStyle(el).animationName` in a
// browser, and it was used — see the cross-check below — but it cannot be the
// committed assertion. happy-dom (this repo's DOM for `tests/**`, and what
// design-dark-parity.test.ts uses) is unusable for THIS question in two
// independent ways: it drops `@layer` rules from the CSSOM entirely, so the
// utility being overridden is invisible to it; and it does not match
// `(prefers-reduced-motion: reduce)` at all, so the guard never applies. A
// suite built on it would go green while measuring nothing — the failure mode
// that makes an oracle worse than no oracle. The `test` job installs no browser
// (`.github/workflows/ci.yml`), so Chromium is not available in this lane.
//
// ── CHROMIUM CROSS-CHECK (2026-08-28, run against both entries below) ───────
//   motir-core (app/globals.css)  no-preference  animationName "spin"  1s
//   motir-core (app/globals.css)  reduce         animationName "none"  0s
//   bare consumer                 no-preference  animationName "spin"  1s
//   bare consumer                 reduce         animationName "none"  0s
// In every reading the ring stayed 20x20 with a 2px border, `display:
// inline-block`, `visibility: visible` and `role="status"` — the rotation
// stops, the glyph does not go anywhere. On `origin/main` (the guard removed)
// the `reduce` rows read "spin" / 1s, which is the defect.
// To re-run after a Tailwind upgrade: build each entry exactly as `compileEntry`
// below does, then for `reducedMotion` of 'no-preference' and 'reduce' open a
// `@playwright/test` chromium context, `page.setContent` a `<style>` of the
// compiled CSS plus a span carrying SPINNER_CLASSES, and read
// `getComputedStyle(el).animationName`.

const ROOT = process.cwd();
const PKG_THEME_CSS = join(ROOT, 'node_modules/@motir/design-system/theme.css');

/** The class list `Spinner` actually paints (packages/design-system/src/components/ui/Spinner.tsx). */
const SPINNER_CLASSES = [
  'inline-block',
  'animate-spin',
  'rounded-full',
  'border-current',
  'border-t-transparent',
  'h-5',
  'w-5',
  'border-2',
];

const REDUCE_CONDITION = '(prefers-reduced-motion: reduce)';

/** Resolve an `@import` the way each consumer's bundler does. */
async function loadStylesheet(id: string, base: string) {
  const path = id.startsWith('.')
    ? resolve(base, id)
    : id === 'tailwindcss'
      ? join(ROOT, 'node_modules/tailwindcss/index.css')
      : join(ROOT, 'node_modules', id);
  return { path, base: dirname(path), content: await readFile(path, 'utf8') };
}

async function compileEntry(entry: string, base: string): Promise<string> {
  const compiler = await compile(entry, {
    base,
    loadStylesheet,
    loadModule: async () => {
      throw new Error('this entry loads no JS module');
    },
  });
  return compiler.build(SPINNER_CLASSES);
}

/** One `animation` / `animation-name` declaration on a bare `.animate-spin` rule. */
interface SpinDeclaration {
  /** The declaration as written, e.g. `animation: none`. */
  declaration: string;
  /** Every declaration in the rule — so "the guard changes nothing else" is checkable. */
  ruleDeclarations: string[];
  /** The `@layer` names enclosing it, outermost first. `[]` means UNLAYERED. */
  layers: string[];
  /** The `@media` conditions enclosing it, outermost first. */
  media: string[];
}

/**
 * Walk a compiled stylesheet and return every `animation` declaration that
 * applies to a bare `.animate-spin` selector, tagged with its at-rule context.
 *
 * Deliberately narrow: it models brace nesting, `@layer <name> { … }` and
 * `@media <condition> { … }`, and matches a selector list containing the exact
 * token `.animate-spin`. It resolves no `var()`, computes no cascade and knows
 * nothing about specificity — the assertions below do that reasoning explicitly
 * from the (layer, media) tags, which is the only part of the cascade this
 * question turns on. A rule reaching the spinner by any other selector (a
 * descendant combinator, a compound) is not matched, and the count assertions
 * below are what would surface one.
 */
function spinDeclarations(css: string): SpinDeclaration[] {
  const found: SpinDeclaration[] = [];
  const layers: string[] = [];
  const media: string[] = [];
  /** For each open brace, what closing it pops: 'layer' | 'media' | null. */
  const opened: (null | 'layer' | 'media')[] = [];
  let head = '';

  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      const prelude = head.trim();
      head = '';
      const layer = /^@layer\s+([\w-]+)$/.exec(prelude);
      const mediaRule = /^@media\s+(.+)$/.exec(prelude);
      if (layer) {
        layers.push(layer[1]!);
        opened.push('layer');
        continue;
      }
      if (mediaRule) {
        media.push(mediaRule[1]!.trim());
        opened.push('media');
        continue;
      }
      if (prelude.startsWith('@')) {
        // Some other at-rule (@keyframes, @supports, @property, @theme …).
        opened.push(null);
        continue;
      }
      // A style rule: consume its declaration block whole (no nesting in
      // compiled Tailwind output).
      const end = css.indexOf('}', i);
      const body = css.slice(i + 1, end === -1 ? css.length : end);
      const ruleDeclarations = body
        .split(';')
        .map((d) => d.trim())
        .filter(Boolean);
      const matchesSpinner = prelude
        .split(',')
        .some((selector) => selector.trim() === '.animate-spin');
      if (matchesSpinner) {
        for (const declaration of ruleDeclarations) {
          if (/^animation(-name)?\s*:/.test(declaration)) {
            found.push({
              declaration,
              ruleDeclarations,
              layers: [...layers],
              media: [...media],
            });
          }
        }
      }
      i = end === -1 ? css.length : end;
      continue;
    }
    if (ch === '}') {
      const what = opened.pop();
      if (what === 'layer') layers.pop();
      if (what === 'media') media.pop();
      head = '';
      continue;
    }
    head += ch;
  }
  return found;
}

const ENTRIES: Record<string, () => Promise<string>> = {
  // The consumer that imports the package through the workspace link.
  'motir-core (app/globals.css)': async () =>
    compileEntry(await readFile(join(ROOT, 'app/globals.css'), 'utf8'), join(ROOT, 'app')),
  // A consumer that installs ONLY the package and follows the README's Usage
  // block. This is the arm AC 3 is about: a guard that lived in motir-core's
  // own globals.css would leave this one defective.
  'a bare consumer of @motir/design-system': async () =>
    compileEntry(`@import 'tailwindcss';\n@import '@motir/design-system/theme.css';\n`, ROOT),
};

describe.each(Object.entries(ENTRIES))('%s', (_label, buildEntry) => {
  it(
    'spins at rest and is stopped — not hidden — under prefers-reduced-motion: reduce',
    { timeout: 60_000 },
    async () => {
      const css = await buildEntry();
      const declarations = spinDeclarations(css);

      const atRest = declarations.filter((d) => !d.media.includes(REDUCE_CONDITION));
      const underReduce = declarations.filter((d) => d.media.includes(REDUCE_CONDITION));

      // ── At rest: Tailwind's own utility, and it really animates. A "fix"
      // that stopped the spinner for everybody would fail here.
      expect(atRest).toHaveLength(1);
      expect(atRest[0]!.declaration).toBe('animation: var(--animate-spin)');
      expect(atRest[0]!.layers).toEqual(['utilities']);
      expect(css).toMatch(/--animate-spin:\s*spin\s/);

      // ── Under reduce: the guard, and it must be UNLAYERED. That is the whole
      // mechanism — an unlayered declaration outranks a layered one whatever
      // their specificity, so this is what makes it beat `@layer utilities`
      // regardless of source order or `@import` position.
      expect(underReduce).toHaveLength(1);
      expect(underReduce[0]!.declaration).toBe('animation: none');
      expect(underReduce[0]!.layers).toEqual([]);
      expect(underReduce[0]!.media).toEqual([REDUCE_CONDITION]);

      // ── It stops the rotation and removes nothing: `animation` is the only
      // property the guard touches, so the ring keeps its size, its border and
      // its colour (the still glyph stays VISIBLE — a spinner is the only
      // signal that a control is working).
      expect(underReduce[0]!.ruleDeclarations).toEqual(['animation: none']);
    },
  );
});

describe('the guard ships in the PACKAGE, not in the consumer (MOTIR-3844 AC 3)', () => {
  const packageThemeCss = readFileSync(PKG_THEME_CSS, 'utf8');

  it('is in the theme.css a consumer installs', () => {
    // Read through node_modules, which is what `@import
    // '@motir/design-system/theme.css'` resolves to — the file the tarball
    // ships, not the in-repo path a motir-core-only fix could have used.
    expect(packageThemeCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.animate-spin \{\s*animation: none;/,
    );
  });

  it('is NOT duplicated into motir-core, which would let the two drift', () => {
    const globals = readFileSync(join(ROOT, 'app/globals.css'), 'utf8');
    expect(globals).not.toMatch(/\.animate-spin\s*\{[^}]*animation/);
  });

  it('Spinner still paints the visible ring and stays role="status"', () => {
    const source = readFileSync(
      join(ROOT, 'packages/design-system/src/components/ui/Spinner.tsx'),
      'utf8',
    );
    expect(source).toContain('inline-block animate-spin rounded-full border-current');
    expect(source).toContain('role="status"');
  });
});
