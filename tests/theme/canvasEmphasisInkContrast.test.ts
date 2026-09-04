import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PALETTE_IDS } from '@/lib/theme/palettes';
import { loadTokenLayer, resolveToken, type ThemeContext } from './paletteCascade';
import { contrast, flattenColorMix } from './colorMetrics';

// MOTIR-4474 — the planning canvas's SELECTION SIGNAL, measured.
//
// ── The defect ──────────────────────────────────────────────────────────────
// Selecting a card on the roadmap lights the dependency edges it belongs to and
// rings the card itself. All three marks — the emphasised edge stroke, its
// arrowhead, and the node ring — painted `--el-accent`, which `theme.css` names
// outright as the FILL role: the colour that sits BEHIND `--el-accent-text`, on
// buttons, badges and toggles. Its contrast is guaranteed against the white ink
// on top of it, and against nothing else.
//
// A stroke on the board and a ring around a card are marks ON a surface. Painted
// with the fill they measured, against `--el-canvas`:
//
//   candy / light 1.26   citrine / light 1.24   amber / light 1.52
//   sienna / light 2.77                          (WCAG 1.4.11 asks 3:1)
//
// and in 17 of the 20 palette x theme pairs the "emphasised" edge was QUIETER
// than the plain one it was emphasising. On candy light the sharpest number: the
// emphasised stroke measured 1.01:1 against a plain edge dimmed to 12% opacity —
// selecting a card painted its own edges the exact shade of the ones it was
// pushing back. The fix is the ink token the design system already ships for
// this, `--el-accent-on-surface`, at every one of the three call sites.
//
// ── Why the shipped tests could not see it ──────────────────────────────────
// Two independent holes, and this file closes the second:
//
//  1. `tests/components/PlanningCanvas.test.tsx` asserted the token NAME
//     (`stroke-(--el-accent)`). A name assertion cannot see a value, so it
//     passed at 1.26:1 and pinned the defect in place. It now names the ink.
//  2. `tests/theme/inkContrastLint.test.ts`'s accent arm measures
//     `--el-accent-on-surface` across all 20 pairs, and its own failure message
//     draws the boundary: "that is the property that separates it from
//     `--el-accent`, the FILL." So the ink painted here was outside every arm.
//
// ── Why this guard carries its OWN surface, rather than widening that arm ────
// The accent arm walks `SAFE_SURFACE_TOKENS ∪ TINTED_SURFACE_TOKENS ∪
// ACCENT_TINT`, and `--el-canvas` is in none of them — deliberately, and it must
// stay that way. Those two sets are DERIVED from `theme.css` and asserted TOTAL
// over the token table (`inkContrastScan.ts`): `SAFE_SURFACE_TOKENS` is every
// `--el-*` that resolves to `var(--color-background)`, `TINTED_SURFACE_TOKENS`
// every one that resolves to one of the three measured tints. `--el-canvas` is
// `var(--color-canvas)`, a FOURTH value — a recessed board that is neither the
// page white nor one of the tints MOTIR-2455 measured. Adding it to either list
// would falsify the derivation those totality assertions rest on, so the surface
// is named here instead, beside the marks that paint on it. The hole is recorded
// rather than left silent: nothing in the accent arm measures the planning board,
// and this file is what does.
//
// ── Why the bar is 3:1 against the board, and NOT "louder than the plain edge"
// The tempting assertion is the symptom: the emphasis should out-shout the edge
// it emphasises. It is the wrong bar. The plain edge is
// `--el-canvas-edge-committed` = `--color-charcoal`, near-black ink in every
// palette (9.55-15.32:1 on the board), so requiring the emphasis to beat it would
// force a hue no palette chose — and would put this guard in the business of
// ranking two signals rather than measuring one. The emphasis does not rely on
// colour alone either: a lit stroke widens 2 -> 3px and every unlit edge drops to
// 12% opacity, so WCAG 1.4.1 is satisfied whatever the hue does. What was
// actually violated is the 1.4.11 non-text floor of 3:1 against the surface the
// mark is painted on. That is what is asserted.
//
// ── Why the marks are READ OUT OF THE SOURCE ────────────────────────────────
// A matrix that measures a token this file names would be green on the day the
// call site went back to the fill: it would be measuring the right ink and the
// wrong code. So the three marks are extracted from the two components, and what
// is measured is whatever they actually paint. A regression to `--el-accent`
// makes this file red at 1.24:1 rather than leaving it green about a token
// nobody uses.

const REPO_ROOT = join(__dirname, '..', '..');
const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');

const CANVAS = 'components/planning/PlanningCanvas.tsx';
const ROADMAP = 'components/planning/ProjectRoadmapCanvas.tsx';

const CANVAS_SOURCE = read(CANVAS);
const ROADMAP_SOURCE = read(ROADMAP);

/** WCAG 1.4.11 — the floor for a graphic that carries meaning. */
const NON_TEXT = 3;

/**
 * One painted mark of the selection signal: the ink token the component uses,
 * and the surface that ink lands on.
 */
interface Mark {
  readonly what: string;
  readonly where: string;
  readonly ink: string;
  readonly surface: string;
}

/**
 * Pull one token out of a source file, failing LOUDLY rather than returning
 * nothing. An extractor that silently found no match would empty the matrix and
 * make every assertion below vacuously true — the exact failure mode the
 * `PALETTE_IDS.length * 2` floor guards on the other axis.
 */
function extract(source: string, file: string, what: string, pattern: RegExp): string {
  const match = pattern.exec(source);
  if (!match?.[1]) {
    throw new Error(
      `${file}: could not read the ${what} token. This guard measures what the component ` +
        'actually paints, so a shape it cannot read is a failure, never a skip — re-point the ' +
        'pattern at the call site rather than deleting the case.',
    );
  }
  return match[1];
}

/**
 * The three marks, in the order a reader meets them: the edge, its arrowhead,
 * and the ring around the selected card.
 *
 * The two edge marks are painted on the board itself — `PlanningCanvas` paints
 * its viewport `bg-(--el-canvas)`, asserted below — and the ring's surface is
 * read out of the same class string as its ink, because `ring-offset-*` is
 * literally what the ring is drawn against.
 */
const RING = /'ring-2 ring-\((--el-[a-z-]+)\) ring-offset-2 ring-offset-\((--el-[a-z-]+)\)'/.exec(
  ROADMAP_SOURCE,
);

const MARKS: readonly Mark[] = [
  {
    what: 'the emphasised edge stroke',
    where: CANVAS,
    ink: extract(
      CANVAS_SOURCE,
      CANVAS,
      'emphasised edge stroke',
      /:\s*emph\s*\n\s*\?\s*'stroke-\((--el-[a-z-]+)\)'/,
    ),
    surface: '--el-canvas',
  },
  {
    what: 'the emphasised arrowhead',
    where: CANVAS,
    ink: extract(
      CANVAS_SOURCE,
      CANVAS,
      'emphasis arrowhead fill',
      /kind === 'emphasis'[\s\S]{0,600}?'fill-\((--el-[a-z-]+)\)'/,
    ),
    surface: '--el-canvas',
  },
  {
    what: 'the selected / lit / matched node ring',
    where: ROADMAP,
    ink: extract(ROADMAP_SOURCE, ROADMAP, 'selection ring', /ring-2 ring-\((--el-[a-z-]+)\)/),
    surface: RING?.[2] ?? '--el-surface-soft',
  },
];

const { rules } = loadTokenLayer();

const THEMES = ['light', 'dark'] as const;
const CONTEXTS: ThemeContext[] = PALETTE_IDS.flatMap((palette) =>
  THEMES.map((theme) => ({ palette, theme })),
);

const resolve = (ctx: ThemeContext, token: string) =>
  flattenColorMix(resolveToken(rules, ctx, token).value);

describe("the canvas selection signal's ink is 3:1 on the surface it is painted on", () => {
  it('reads all three marks out of the two components, and the board they sit on', () => {
    // The extraction is the thing that makes this guard about the CODE rather
    // than about a token name written here, so its shape is asserted first: three
    // marks, every one an `--el-*` ink, and the board still painted with the
    // surface the two edge marks are measured against.
    expect(MARKS).toHaveLength(3);
    for (const mark of MARKS) {
      expect(mark.ink, `${mark.where}: ${mark.what}`).toMatch(/^--el-[a-z-]+$/);
      expect(mark.surface, `${mark.where}: ${mark.what}`).toMatch(/^--el-[a-z-]+$/);
    }
    expect(
      CANVAS_SOURCE,
      'The two edge marks are measured against `--el-canvas` because that is what the canvas ' +
        'viewport paints. If the board moves to another token, move the surface with it.',
    ).toContain('bg-(--el-canvas)');
    // The ring's surface comes from its own `ring-offset`, not from a name typed
    // here — so a ring re-offset onto another surface is measured against the new
    // one on the next run.
    expect(RING?.[2]).toBe(MARKS[2]!.surface);
  });

  it('measures the whole matrix it claims to — every palette, both themes', () => {
    // Driven by the registry rather than by an enumeration: an eleventh palette
    // is measured the day it lands. `>=` on the count is what keeps that true,
    // and the exact product is what stops the matrix going vacuously empty —
    // every assertion below is a loop, and an empty loop passes.
    expect(CONTEXTS).toHaveLength(PALETTE_IDS.length * 2);
    expect(PALETTE_IDS.length).toBeGreaterThanOrEqual(10);
    // candy is the palette the defect was reported on, and citrine and amber are
    // the two that measured worst; sienna is the fourth that failed outright.
    for (const palette of ['candy', 'citrine', 'amber', 'sienna']) {
      expect(PALETTE_IDS).toContain(palette);
    }
  });

  it('resolves every ink and surface to a real colour — never an unresolved var()', () => {
    // As on the ink lint's measured arms: an unresolved `var()` folds to an empty
    // string and `contrast()` would THROW rather than fail, and a guard that
    // throws measures nothing.
    const broken: string[] = [];
    for (const ctx of CONTEXTS) {
      for (const mark of MARKS) {
        for (const token of [mark.ink, mark.surface]) {
          const value = resolve(ctx, token);
          if (!/^#[0-9a-f]{6}$/i.test(value)) {
            broken.push(`${ctx.palette}/${ctx.theme}: ${token} -> "${value}"`);
          }
        }
      }
    }
    expect(broken.join('\n')).toBe('');
  });

  it('clears 3:1 in every palette x theme pair', () => {
    const failures: string[] = [];
    for (const ctx of CONTEXTS) {
      for (const mark of MARKS) {
        const ink = resolve(ctx, mark.ink);
        const surface = resolve(ctx, mark.surface);
        const ratio = contrast(ink, surface);
        if (ratio < NON_TEXT) {
          failures.push(
            `${ctx.palette}/${ctx.theme}: ${mark.what} — ${mark.ink} ${ink} on ` +
              `${mark.surface} ${surface} = ${ratio.toFixed(2)}`,
          );
        }
      }
    }
    expect(
      failures.join('\n'),
      'A stroke on the board and a ring around a card are marks ON a surface, so they owe ' +
        'WCAG 1.4.11’s 3:1 against it. `--el-accent` is the FILL — its contrast is ' +
        'guaranteed against `--el-accent-text` sitting on top of it and against nothing else — ' +
        'and painting the selection with it measured 1.24-2.77:1 on the board in four light ' +
        'palettes (MOTIR-4474). The fix is `--el-accent-on-surface`, the ink the design system ' +
        'already ships for a mark on a surface: never a `color-mix` at the call site, never a ' +
        'canvas-only token, and never a `theme.css` value moved to rescue one palette.',
    ).toBe('');
  });
});
