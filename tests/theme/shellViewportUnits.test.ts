import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// MOTIR-3208 — the SHELL VIEWPORT-UNIT guard.
//
// ── The defect this exists to prevent ───────────────────────────────────────
// `components/ui/AppLayout.tsx` sizes the signed-in shell at exactly `100dvh`
// and clips it (`overflow-hidden`), so `<main>` is the only scroller on any
// signed-in surface. A document scrollbar therefore means something OUTSIDE the
// shell is taller than `100dvh` — nothing inside it can produce one.
//
// `app/globals.css` sized the document floor at `min-height: 100vh`. `vh` is the
// LARGE viewport (browser UI retracted); `dvh` is the DYNAMIC one. On any
// browser where the two differ, the floor exceeded the shell's height by exactly
// that difference, the document gained that many scrollable pixels, and they
// were EMPTY — the reported "empty space at the bottom + two scrollbars".
//
// ── Why a SOURCE guard and not only an end-to-end one ───────────────────────
// Chromium resolves `100vh === 100dvh`, headless and headed alike. So every
// automated pass over the shell was blind to this by construction, and every
// developer on a Chrome-shaped browser saw a correct page. The companion
// `tests/e2e/shell-viewport-floor.spec.ts` closes that by REWRITING the served
// stylesheet to emulate a divergent browser — but a unit is a property of the
// source, and the cheapest place to assert a property of the source is here.
//
// The durable lesson from the card: **a viewport unit is shell geometry wherever
// it is written.** When the shell's unit changed, the sweep owed every
// viewport-sized length in the document — `globals.css` and the design-system
// stylesheet included — not just the component that owns the layout. One file
// was fixed; the file expressing the same measurement in a different vocabulary
// was not.
//
// ── What is enforced, and what is deliberately NOT ──────────────────────────
// 1. THE DOCUMENT FLOOR. Every CSS rule in `app/globals.css` or the design
//    system's `theme.css` whose selector targets `html` or `body` must express
//    viewport-relative height in `dvh`. Pseudo-element rules (`body::after`) are
//    EXCLUDED: `[data-style='retrofuturism'] body::after` is a `position: fixed`
//    decorative grid at `42vh`, which is out of flow and cannot lengthen the
//    document. This guard is about the FLOOR, not about every `vh` in the file.
// 2. THE `screen` HEIGHT FAMILY, at zero. No `h-screen` / `min-h-screen` /
//    `max-h-screen` anywhere under `app/`, `components/` or the design system's
//    `src/` — Tailwind compiles `screen` to `100vh`, so it is the same
//    declaration in a second vocabulary and every use of it is a full-viewport
//    sizing intent. Use `h-dvh` / `min-h-dvh`.
//
//    ⚠️ The ARBITRARY `vh` family — `max-h-[90vh]`, `h-[min(82vh,680px)]` — is
//    COUNTED and NOT ruled on, and the last test asserts that population is
//    non-empty so the boundary cannot quietly outlive its subject. Those are
//    caps on modal panels, popovers and scroll regions, nearly all of them
//    inside a `position: fixed` container that cannot lengthen the document at
//    all; and a `max-height` can only ever SHORTEN a box. They are a different
//    class from a document floor, they are not on the shell path, and sweeping
//    them would be a much larger change than this card with real visual risk.
// 3. THE FLOOR IS EXPRESSED ONCE. `app/layout.tsx` may not restate it with an
//    `h-full` `<html>` + `min-h-full` `<body>` pair alongside the CSS rule — two
//    expressions of one measurement is how the two came to disagree.
// 4. `<main>`'s HORIZONTAL overflow is stated, not inherited. `overflow-y: auto`
//    computes `overflow-x` from `visible` to `auto`, so the shell's only scroller
//    silently acquires a horizontal bar nobody chose.
//
// The WIDTH axis (`w-screen`, `100vw`, `max-w-[100vw]`) is untouched: a browser's
// retractable UI moves the viewport's HEIGHT, and `vw`'s own quirk (it includes
// the classic scrollbar) is a different problem with a different fix.

const ROOT = resolve(__dirname, '..', '..');

/** A `vh` / `lvh` / `svh` length — anything but the dynamic unit. */
const NON_DYNAMIC_VH = /\d+(?:\.\d+)?(?:l|s)?vh\b/;

/** `h-screen` / `min-h-screen` / `max-h-screen` — Tailwind's `100vh`. */
const SCREEN_HEIGHT_UTILITY = /\b(?:min-|max-)?h-screen\b/;

/**
 * An arbitrary height utility carrying a non-dynamic `vh`: `max-h-[90vh]`.
 * COUNTED, not ruled on — see the header's point 2 for why.
 */
const ARBITRARY_VH_HEIGHT = /\b(?:min-|max-)?h-\[[^\]]*\d+(?:\.\d+)?(?:l|s)?vh\b[^\]]*\]/;

const CSS_FILES = ['app/globals.css', 'packages/design-system/theme.css'] as const;

const SCAN_ROOTS = ['app', 'components', 'packages/design-system/src'] as const;

/** Every `.ts` / `.tsx` file under `dir`, repo-relative with forward slashes. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(relative(ROOT, full).split(sep).join('/'));
  }
  return out;
}

const SOURCE_FILES = SCAN_ROOTS.flatMap((r) => walk(join(ROOT, r)));

interface CssRule {
  file: string;
  selector: string;
  body: string;
}

/**
 * The INNERMOST rules of a stylesheet, as `{ selector, body }`.
 *
 * `[^{}]+\{[^{}]*\}` cannot match a block that contains another block, so an
 * at-rule wrapper (`@media (…) { body { … } }`) is skipped and the `body { … }`
 * inside it is returned — which is exactly the set this guard asks about. No CSS
 * parser is in the dependency tree and adding one to read two files would be the
 * wrong trade.
 */
function innermostRules(file: string): CssRule[] {
  const css = readFileSync(join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    rules.push({ file, selector: m[1]!.trim(), body: m[2]! });
  }
  return rules;
}

/** Does one comma-separated selector part target `html`/`body` ITSELF? */
function targetsDocumentElement(part: string): boolean {
  if (/::(?:before|after|backdrop|selection|first-line|first-letter)/.test(part)) return false;
  return /(?:^|[\s,>+~])(?:html|body)(?![\w-])/.test(part);
}

const DOCUMENT_RULES = CSS_FILES.flatMap(innermostRules).filter((r) =>
  r.selector.split(',').some(targetsDocumentElement),
);

describe('the shell viewport-unit guard (MOTIR-3208)', () => {
  it('finds files and document rules at all — the scan is not vacuous', () => {
    // Without this, every assertion below passes on an empty set, which is how a
    // totality test dies quietly.
    expect(SOURCE_FILES.length).toBeGreaterThan(200);
    expect(DOCUMENT_RULES.length).toBeGreaterThanOrEqual(2);
    // And the selector predicate really reaches BOTH stylesheets, so a rename of
    // one of them cannot silently halve the guard.
    expect(new Set(DOCUMENT_RULES.map((r) => r.file)).size).toBe(CSS_FILES.length);
  });

  it('sizes the DOCUMENT FLOOR in `dvh`, never `vh` / `lvh` / `svh`', () => {
    const offenders = DOCUMENT_RULES.filter((r) => NON_DYNAMIC_VH.test(r.body)).map(
      (r) => `${r.file} — ${r.selector} { ${r.body.trim().replace(/\s+/g, ' ')} }`,
    );
    expect(
      offenders,
      'The signed-in shell is exactly `100dvh` and clips itself, so a document ' +
        'floor in `vh` (the LARGE viewport) exceeds it on any browser with ' +
        'retractable UI and hands the document that many EMPTY scrollable ' +
        'pixels. Express the floor in `dvh`.',
    ).toEqual([]);
  });

  it('states the floor exactly ONCE — `app/layout.tsx` does not restate it', () => {
    const layout = readFileSync(join(ROOT, 'app/layout.tsx'), 'utf8');
    // `<html className="… h-full">` + `<body className="min-h-full">` is the same
    // measurement in a second vocabulary. Two expressions of one number is how
    // the units came apart in the first place.
    expect(/className=\{?[`"'][^`"']*\bh-full\b/.test(layout), 'app/layout.tsx <html> h-full').toBe(
      false,
    );
    expect(
      /className=\{?[`"'][^`"']*\bmin-h-full\b/.test(layout),
      'app/layout.tsx <body> min-h-full',
    ).toBe(false);
  });

  it('uses no `h-screen` family utility anywhere on the app path', () => {
    const offenders: string[] = [];
    for (const file of SOURCE_FILES) {
      const src = readFileSync(join(ROOT, file), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (SCREEN_HEIGHT_UTILITY.test(line)) offenders.push(`${file}:${i + 1} — ${line.trim()}`);
      });
    }
    expect(
      offenders,
      'Tailwind compiles `h-screen` to `height: 100vh`. Use the `dvh` forms ' +
        '(`min-h-dvh` / `h-dvh` / `h-[calc(100dvh_-_…)]`) so a page sized ' +
        'against the viewport tracks the DYNAMIC one the shell is sized in.',
    ).toEqual([]);
  });

  it('proves the `dvh` forms are actually in use — the fix is present, not just absent', () => {
    // The assertion above is satisfied by a tree that sizes nothing against the
    // viewport at all. This is the other half: the shell really is `dvh`.
    const shell = readFileSync(join(ROOT, 'components/ui/AppLayout.tsx'), 'utf8');
    expect(shell).toMatch(/\bh-dvh\b/);
    const withDvh = SOURCE_FILES.filter((f) =>
      /\b(?:min-|max-)?h-(?:dvh|\[[^\]]*dvh)/.test(readFileSync(join(ROOT, f), 'utf8')),
    );
    expect(withDvh.length).toBeGreaterThanOrEqual(5);
  });

  it('COUNTS the arbitrary-`vh` population it deliberately does not rule on', () => {
    // The one boundary this guard draws, asserted rather than assumed. These are
    // `max-h-[90vh]`-style caps on modals, popovers and scroll regions — a cap
    // can only shorten a box, and nearly all of them sit inside a
    // `position: fixed` container that is out of flow entirely. If this set ever
    // empties, the exemption has outlived its subject and the paragraph in the
    // header should go with it.
    const counted = SOURCE_FILES.filter((f) =>
      ARBITRARY_VH_HEIGHT.test(readFileSync(join(ROOT, f), 'utf8')),
    );
    expect(counted.length, 'the unruled arbitrary-`vh` population is non-empty').toBeGreaterThan(0);
  });

  it("states `<main>`'s HORIZONTAL overflow rather than inheriting it", () => {
    // Strip comments first: `AppLayout`'s own JSDoc mentions `<main>` in prose,
    // and a guard that reads a doc comment as code proves nothing.
    const shell = readFileSync(join(ROOT, 'components/ui/AppLayout.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const main = /<main\b[\s\S]*?>/.exec(shell)?.[0] ?? '';
    expect(main, '<main> element found in AppLayout').not.toBe('');
    // CSS Overflow 3: with `overflow-y` non-visible and `overflow-x` visible,
    // `overflow-x` COMPUTES to `auto`. The shell's only scroller must not acquire
    // a horizontal bar by side effect — the axis is chosen, on the element.
    expect(main, '<main> carries an explicit overflow-x-* class').toMatch(/\boverflow-x-\w+/);
  });
});
