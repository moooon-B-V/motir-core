// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STYLE_ID, STYLE_IDS } from '@/lib/theme/styles';

// MOTIR-4232 — the COLLAPSED nav rail must be wide enough for the control it
// holds, under every registered `data-style`.
//
// ── The defect this measures ────────────────────────────────────────────────
// `components/ui/AppLayout.tsx` stated the collapsed rail column as a raw
// `md:grid-cols-[56px_1fr]`. The rail holds exactly one `--height-control`
// square (`components/ui/Sidebar.tsx`'s collapsed row is
// `h-(--height-control) w-(--height-control)`), and `--height-control` is a
// SHAPE token the style axis moves: two of the eleven registered styles set it
// to 40px against a content box of 56 − 16 (`px-2`) − 1 (`border-r`) = 39px, so
// the row was one pixel wider than the rail it sat in. Measured under
// `soft-playful`, collapsed: `scrollWidth` 40 into a `clientWidth` of 39.
//
// It did not clip, it drew a SECOND scrollbar — `Sidebar`'s scroller stated
// only `overflow-y-auto`, and CSS Overflow 3 computes the unstated axis to
// `auto` whenever the other one is non-visible. `AppLayout`'s `<main>` states
// both axes for exactly this reason and says so in a comment; the rail's
// scroller never did.
//
// ── Why the assertion is over the COMPILED stylesheet ───────────────────────
// Same reason as `reducedMotionSpinner.test.ts`: the utilities under test do
// not exist until Tailwind generates them, and this repo's `test` job installs
// no browser (`.github/workflows/ci.yml`), so Chromium is not available in this
// lane. happy-dom is worse than useless here — it drops `var()` and shorthand
// resolution, which is the entire question. So this suite runs the REAL Tailwind
// compiler over the REAL entry the app ships and reads the token values and the
// generated declarations off the artifact.
//
// The geometry is then ARITHMETIC over those values rather than a render, and
// deliberately so: the browser resolves `calc(var(--height-control) +
// var(--width-rail-chrome))` from the same two numbers this test reads, so a
// per-style sum here answers the same question a per-style render would, for
// every style at once and on every pull request.
//
// ── CHROMIUM CROSS-CHECK (2026-09-03, `@playwright/test` chromium, the CSS
// compiled exactly as `compileGlobals` below compiles it, the real class
// strings both components paint, at 1280×1074 and 1280×800) ─────────────────
//   style               rail    row     content box   hScroll  overflow-x
//   warm-editorial      56px    36px    39px          false    hidden
//   soft-playful        60px    40px    43px          false    hidden
//   swiss-minimal-flat  54px    34px    37px          false    hidden
//   neo-brutalism       56px    36px    39px          false    hidden
//   glassmorphism       58px    38px    41px          false    hidden
//   cybercore-y2k       54px    34px    37px          false    hidden
//   aurora              58px    38px    41px          false    hidden
//   3d-immersive        60px    40px    43px          false    hidden
//   neumorphism         58px    38px    41px          false    hidden
//   hand-drawn-indie    58px    38px    41px          false    hidden
//   retrofuturism       58px    38px    41px          false    hidden
// `scrollbar-width` resolved to `thin` in all eleven and `scrollbar-color` to
// the palette's own `--el-border-strong` over a transparent track. On the
// pre-fix source the two 40px styles read `scrollWidth` 40 into `clientWidth`
// 39 with `overflow-x: auto` — the defect.

const ROOT = process.cwd();

/** The rail's own chrome: `px-2` gutters (8px a side) + the `border-r`. */
const RAIL_GUTTERS_AND_BORDER = 8 + 8 + 1;

/** The collapsed nav row, verbatim from `components/ui/Sidebar.tsx`. */
const ROW_CLASSES = ['h-(--height-control)', 'w-(--height-control)'];

/**
 * ⚠️ THE CANDIDATES ARE READ OUT OF THE COMPONENTS, NOT WRITTEN DOWN HERE.
 *
 * Tailwind generates a utility because this suite ASKED for it, not because
 * anything renders it — so a candidate list written by hand compiles the same
 * stylesheet whether or not `AppLayout` still paints that class, and the suite
 * then measures a rule no component uses. Caught while checking this test's own
 * failing branch: with the fix reverted it still went red, but for the missing
 * TOKEN, and it reported the default style as broken when the default style was
 * fine. An oracle that fails for the wrong reason is most of the way to one
 * nobody trusts.
 *
 * So the class comes off the source file. If the component stops painting it,
 * the extraction fails and says so; if the component changes it, this suite
 * measures the NEW one — which is the contract worth pinning.
 */
async function railColumnClass(): Promise<string> {
  const source = await readFile(join(ROOT, 'components/ui/AppLayout.tsx'), 'utf8');
  // The COLLAPSED arm is the first of the ternary's two, in both shapes.
  const match = /["'](md:grid-cols-\[[^"']*?)["']/.exec(source);
  if (!match) throw new Error('AppLayout paints no `md:grid-cols-[…]` rail column');
  return match[1]!;
}

async function scrollerClasses(): Promise<string[]> {
  const source = await readFile(join(ROOT, 'components/ui/Sidebar.tsx'), 'utf8');
  // Both quote styles: the scroller was a bare `className="…"` attribute before
  // this card gave it a `cn(...)` call, and the extraction has to survive that.
  const match = /["'](flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto[^"']*)["']/.exec(source);
  if (!match) throw new Error('Sidebar paints no rail scroller');
  const scrollbar = /["'](\[scrollbar-width[^"']*)["']/.exec(source);
  return [...match[1]!.split(/\s+/), ...(scrollbar ? scrollbar[1]!.split(/\s+/) : [])];
}

/** Resolve an `@import` the way the app's bundler does. */
async function loadStylesheet(id: string, base: string) {
  const path = id.startsWith('.')
    ? resolve(base, id)
    : id === 'tailwindcss'
      ? join(ROOT, 'node_modules/tailwindcss/index.css')
      : join(ROOT, 'node_modules', id);
  return { path, base: dirname(path), content: await readFile(path, 'utf8') };
}

async function compileGlobals(): Promise<string> {
  const entry = await readFile(join(ROOT, 'app/globals.css'), 'utf8');
  const compiler = await compile(entry, {
    base: join(ROOT, 'app'),
    loadStylesheet,
    loadModule: async () => {
      throw new Error('this entry loads no JS module');
    },
  });
  return compiler.build([await railColumnClass(), ...(await scrollerClasses()), ...ROW_CLASSES]);
}

/**
 * Read a pixel custom property as it stands for one `data-style`.
 *
 * The base value comes from the `@theme` block (emitted on `:root`); a style
 * that overrides the property wins. This mirrors what the cascade does for
 * these tokens, all of which are declared at the document root — the shell is
 * never rendered inside a nested `[data-style]` scope.
 *
 * Returns `null` for a token that does not exist, rather than throwing, so the
 * width resolver below can report the GEOMETRY on a tree where the derivation
 * is absent. That is what makes this suite's failing branch legible: on the
 * pre-fix source it says `39px < 40px`, not `--width-rail-chrome not found`.
 */
function tokenForStyle(css: string, token: string, styleId: string): number | null {
  const base = new RegExp(`${token}:\\s*(-?[\\d.]+)px`).exec(css);
  const block = new RegExp(`\\[data-style=['"]${styleId}['"]\\]\\s*\\{([\\s\\S]*?)\\n\\}`).exec(
    css,
  );
  const override = block ? new RegExp(`${token}:\\s*(-?[\\d.]+)px`).exec(block[1]!) : null;
  const value = override?.[1] ?? base?.[1];
  return value === undefined ? null : Number(value);
}

/**
 * The collapsed rail's COLUMN WIDTH under one style, resolved from whatever the
 * stylesheet actually compiled — a `calc()` over the tokens, or a bare literal.
 *
 * Handling both shapes is the point: a resolver that only understood the calc
 * would fail on the defect with a parse error instead of a measurement, and a
 * guard whose failing branch reports the wrong thing is most of the way to a
 * guard nobody trusts.
 */
function railWidthForStyle(css: string, styleId: string): number {
  const rule = /grid-template-columns:\s*([^;]*?)\s+1fr;/.exec(css);
  if (!rule) throw new Error('no collapsed-rail grid-template-columns was generated');
  const column = rule[1]!;

  const literal = /^(-?[\d.]+)px$/.exec(column);
  if (literal) return Number(literal[1]);

  const control = tokenForStyle(css, '--height-control', styleId);
  const chrome = tokenForStyle(css, '--width-rail-chrome', styleId);
  if (control === null || chrome === null) {
    throw new Error(`the rail column is \`${column}\` but its tokens do not resolve`);
  }
  return control + chrome;
}

describe('the collapsed rail tracks --height-control (MOTIR-4232)', () => {
  it('states its column as a SUM over the token, never as a literal width', async () => {
    const css = await compileGlobals();

    const rule = /grid-template-columns:\s*calc\(([^;]*?)\)\s*1fr;/.exec(css);
    expect(rule, 'the collapsed rail column did not compile to a calc()').not.toBeNull();
    // Both operands present: the rail is the control PLUS the rail's own chrome.
    expect(rule![1]).toContain('var(--height-control)');
    expect(rule![1]).toContain('var(--width-rail-chrome)');

    // The literal this card removed must not come back. `56px` as a rail column
    // is the defect; it is only correct for the one style that happens to sit
    // at a 36px control.
    expect(css).not.toContain('grid-template-columns: 56px 1fr');
  });

  it('leaves the DEFAULT style geometrically unchanged — 56px, as shipped', async () => {
    const css = await compileGlobals();

    expect(tokenForStyle(css, '--height-control', DEFAULT_STYLE_ID)).toBe(36);
    // The rail the app has always drawn. Deriving the width is not a licence to
    // re-shape the style nobody reported: 36 + 20 is the same 56px.
    expect(railWidthForStyle(css, DEFAULT_STYLE_ID)).toBe(56);
  });

  // The registry, NOT a hard-coded list: a style added later with a taller
  // control fails this test rather than shipping the defect. That is the whole
  // reason the width is derived — a guard over today's eleven values would be
  // the same mistake as the constant it replaces.
  it.each(STYLE_IDS)('fits its control under [data-style=%s]', async (styleId) => {
    const css = await compileGlobals();
    const control = tokenForStyle(css, '--height-control', styleId);
    expect(control, `no --height-control for [data-style='${styleId}']`).not.toBeNull();

    // What the browser lays out: the column, minus the nav's own gutters and
    // border, is the content box the row has to fit inside.
    const contentBox = railWidthForStyle(css, styleId) - RAIL_GUTTERS_AND_BORDER;

    expect(
      contentBox,
      `[data-style='${styleId}']: a ${control}px row into a ${contentBox}px rail content box`,
    ).toBeGreaterThanOrEqual(control!);
  });

  it('never lets a style override the chrome out from under the derivation', async () => {
    const css = await compileGlobals();
    const chromeValues = new Set(
      STYLE_IDS.map((id) => tokenForStyle(css, '--width-rail-chrome', id)),
    );
    // One value across every style. A per-style override would put the rail's
    // fit back under eleven separate decisions, which is what the raw `56px`
    // already was.
    expect(chromeValues.size).toBe(1);
  });
});

describe("the rail's scroller states BOTH axes (MOTIR-4232)", () => {
  it('clips the cross axis instead of inheriting `auto` from CSS Overflow 3', async () => {
    const css = await compileGlobals();
    expect(css).toMatch(/\.overflow-x-hidden\s*\{\s*overflow-x:\s*hidden;\s*\}/);
  });

  it('draws the product\u2019s scrollbar, not the platform\u2019s', async () => {
    const css = await compileGlobals();
    // `thin` — a classic scrollbar is ~15px of a rail that is 56px wide.
    expect(css).toMatch(/scrollbar-width:\s*thin;/);
    // The colour is the palette's, so it follows a `data-palette` swap. No raw
    // hue: the colour rule (`motir-core/CLAUDE.md`) applies to a scrollbar too.
    const color = /scrollbar-color:\s*([^;]+);/.exec(css);
    expect(color, 'no scrollbar-color declaration was generated').not.toBeNull();
    expect(color![1]).toContain('var(--el-');
    expect(color![1]).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
