// @vitest-environment node
import { readFileSync } from 'node:fs';
import { readFile as read } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';
import { STYLE_IDS } from '@/lib/theme/styles';

// MOTIR-4253 — the SHELL-CHROME guard for 3D / Immersive.
//
// ── The defect ──────────────────────────────────────────────────────────────
// `docs/styles/3d-immersive.md` §4's plane ladder named ten surfaces and stopped
// before the FRAME. The `[data-style='3d-immersive']` block carried NO
// `[data-surface='header']` rule and NO `[data-surface='sidebar']` rule at all,
// while both hooks are emitted (`app/(authed)/_components/TopNav.tsx`,
// `components/ui/Sidebar.tsx`) and five of the eleven styles already use them.
// So roughly a quarter of every signed-in screen rendered byte-identically to
// the default style, and §4 contradicted itself: its `Quiet control / row` row
// says a sidebar nav link is flat *because the surface it sits in floats*, of a
// surface no rule made float.
//
// It is the FOURTH instance of one shape — a promise bound to an ENUMERATION,
// with silence where the enumeration ends. MOTIR-3522 was that for controls
// (199 of 280 flat), MOTIR-4230 and MOTIR-4234 for the shell canvas, this for
// the chrome. §4b is the closure rule written to end it; the guard that ENFORCES
// §4b over the whole surface population is its own card, carved out of this one
// at the estimation gate, and is not this file.
//
// ── Why a SOURCE guard, and what goes to the browser instead ────────────────
// Exactly the argument `styleShellCanvas.test.ts` and
// `immersiveShellAtmosphere.test.ts` make, and it binds harder here: the
// properties under test are `box-shadow: var(--shadow-card)` and
// `background-color: transparent` inside `@scope` blocks, and the DOM
// implementations available to a unit lane resolve NEITHER — a `var()` colour
// reads back as `rgba(0, 0, 0, 0)` and `@scope` is not implemented at all. A
// computed-style assertion here would be green on the broken source AND on the
// fixed one, which is worse than no test. This lane asserts the WIRING and the
// GEOMETRY; the rendered half — the two hosts differing from the default style,
// light and dark, and the atmosphere reading through the bar — lives in
// `tests/e2e/shell-immersive-atmosphere.spec.ts`, where a real browser resolves
// the cascade and the assertion can actually fail.
//
// ── THE ORACLE IS THE DESIGN ASSET, never a table retyped into this file ────
// `design/shell/design-notes.md` § *3D / Immersive takes the shell chrome*
// carries the CSS block VERBATIM — the asset's own frames are drawn BY that
// block, so a frame cannot flatter a rule the implementation could not write.
// This suite parses that fence and compares it declaration for declaration with
// what `theme.css` ships. A hard-coded expectation here would need re-typing
// every time the treatment is tuned, and the first person to skip that turns
// this into a test of a stale table. (Same discipline as
// `shell-immersive-atmosphere.spec.ts`'s "truth is `body`'s own computed value".)

const ROOT = resolve(__dirname, '..', '..');
const THEME_CSS_PATH = 'packages/design-system/theme.css';
const DESIGN_NOTES_PATH = 'design/shell/design-notes.md';
const SPEC_PATH = 'docs/styles/3d-immersive.md';

const STYLE = '3d-immersive';
const RAIL = "[data-surface='sidebar']";
const BAR = "[data-surface='header']";
const CHROME_SELECTORS = [RAIL, BAR];

/** Comments stripped — a guard that reads prose as code proves nothing. */
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const THEME_CSS = strip(readFileSync(join(ROOT, THEME_CSS_PATH), 'utf8'));

interface ScopedRule {
  /** The style id in the `@scope` prelude. */
  style: string;
  /** The rule's own selector, trimmed. */
  selector: string;
  /** The `@media` condition this rule sits under, or `''` at the top level. */
  media: string;
  /** `property: value` pairs, normalised — order-independent, whitespace-flat. */
  decls: Map<string, string>;
}

/**
 * Every rule inside a `@scope ([data-style='…']) to ([data-style])` block, with
 * the style it is scoped to and the `@media` condition (if any) enclosing it.
 *
 * Located by STRUCTURE rather than by comment text — the same parser shape
 * `styleShellCanvas.test.ts` uses, widened from one hard-coded media query to
 * "whichever `@media` is still open", because this treatment's two accessibility
 * arms are the thing under test rather than a case to skip.
 */
function scopedRules(css: string): ScopedRule[] {
  const open = /@scope\s*\(\[data-style='([a-z0-9-]+)'\]\)\s*to\s*\(\[data-style\]\)\s*\{/g;
  const out: ScopedRule[] = [];
  let m: RegExpExecArray | null;

  while ((m = open.exec(css)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < css.length && depth > 0; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
    }
    const inner = css.slice(m.index + m[0].length, i - 1);
    open.lastIndex = i;

    // Which `@media` is still open at this point? Walk every one that opens
    // before this `@scope` and keep the last whose braces have not balanced.
    const before = css.slice(0, m.index);
    let media = '';
    for (const q of before.matchAll(/@media\s*\(([^)]*)\)\s*\{/g)) {
      const tail = before.slice(q.index!);
      if (tail.split('{').length - tail.split('}').length > 0) media = q[1]!.trim();
    }

    // Split the block into its own rules — one level of nesting, which is all
    // this stylesheet uses inside `@scope`.
    let rest = inner;
    while (rest.includes('{')) {
      const brace = rest.indexOf('{');
      let d = 1;
      let j = brace + 1;
      for (; j < rest.length && d > 0; j += 1) {
        if (rest[j] === '{') d += 1;
        else if (rest[j] === '}') d -= 1;
      }
      const body = rest.slice(brace + 1, j - 1);
      const decls = new Map<string, string>();
      for (const line of body.split(';')) {
        const at = line.indexOf(':');
        if (at === -1) continue;
        const prop = line.slice(0, at).trim();
        if (!prop) continue;
        decls.set(
          prop,
          line
            .slice(at + 1)
            .trim()
            .replace(/\s+/g, ' '),
        );
      }
      out.push({ style: m[1]!, selector: rest.slice(0, brace).trim(), media, decls });
      rest = rest.slice(j);
    }
  }
  return out;
}

/** The CSS block the design asset carries verbatim — this suite's oracle. */
function designBlock(): string {
  const notes = readFileSync(join(ROOT, DESIGN_NOTES_PATH), 'utf8');
  const at = notes.indexOf('## 3D / Immersive takes the shell chrome');
  if (at === -1) throw new Error(`no shell-chrome section in ${DESIGN_NOTES_PATH}`);
  const fence = /```css\n([\s\S]*?)```/.exec(notes.slice(at));
  if (!fence) throw new Error(`the shell-chrome section carries no css fence`);
  return strip(fence[1]!);
}

const SHIPPED = scopedRules(THEME_CSS);
const DESIGNED = scopedRules(designBlock());

/** One style's rules for one chrome host, keyed by the media condition. */
const chrome = (rules: ScopedRule[], selector: string, style = STYLE) =>
  rules.filter((r) => r.style === style && r.selector === selector);

const at = (rules: ScopedRule[], selector: string, media: string, style = STYLE) =>
  chrome(rules, selector, style).find((r) => r.media === media);

/** The styles the stylesheet is observed to give ANY chrome treatment. */
const CHROME_STYLES = [
  ...new Set(SHIPPED.filter((r) => CHROME_SELECTORS.includes(r.selector)).map((r) => r.style)),
].sort();

// ── The compiled half, for the GEOMETRY ─────────────────────────────────────
// `--spacing-rail-inset` and the two grid sums are resolved from the REAL
// Tailwind build over the REAL entry the app ships, exactly as
// `railTracksControlHeight.test.ts` resolves the collapsed rail — the utilities
// under test do not exist until Tailwind generates them, and this lane installs
// no browser.

async function loadStylesheet(id: string, base: string) {
  const path = id.startsWith('.')
    ? resolve(base, id)
    : id === 'tailwindcss'
      ? join(ROOT, 'node_modules/tailwindcss/index.css')
      : join(ROOT, 'node_modules', id);
  return { path, base: dirname(path), content: await read(path, 'utf8') };
}

/** Both grid columns, read out of `AppLayout` rather than written down here. */
async function railColumnClasses(): Promise<string[]> {
  const source = await read(join(ROOT, 'components/ui/AppLayout.tsx'), 'utf8');
  const found = [...source.matchAll(/["'](md:grid-cols-\[[^"']*?)["']/g)].map((m) => m[1]!);
  if (found.length < 2) throw new Error('AppLayout paints fewer than two rail columns');
  return found;
}

async function compileGlobals(): Promise<string> {
  const entry = await read(join(ROOT, 'app/globals.css'), 'utf8');
  const compiler = await compile(entry, {
    base: join(ROOT, 'app'),
    loadStylesheet,
    loadModule: async () => {
      throw new Error('this entry loads no JS module');
    },
  });
  return compiler.build(await railColumnClasses());
}

/** A pixel custom property as it stands for one `data-style` (base ⊕ override). */
function tokenForStyle(css: string, token: string, styleId: string): number | null {
  const base = new RegExp(`${token}:\\s*(-?[\\d.]+)px`).exec(css);
  const block = new RegExp(`\\[data-style=['"]${styleId}['"]\\]\\s*\\{([\\s\\S]*?)\\n\\}`).exec(
    css,
  );
  const override = block ? new RegExp(`${token}:\\s*(-?[\\d.]+)px`).exec(block[1]!) : null;
  const value = override?.[1] ?? base?.[1];
  return value === undefined ? null : Number(value);
}

describe('the scan is not vacuous', () => {
  it('finds the design block, the shipped rules and the registry', () => {
    expect(DESIGNED.length, 'rules parsed out of the design asset').toBeGreaterThan(0);
    expect(SHIPPED.length, 'scoped rules parsed out of theme.css').toBeGreaterThan(20);
    expect(STYLE_IDS.length, 'the style registry').toBeGreaterThan(1);
    // The parser must actually distinguish the media arms, or every assertion
    // about the fallbacks below compares the top-level rule with itself.
    expect(
      [...new Set(DESIGNED.map((r) => r.media))].sort(),
      'the design block carries a top-level arm and both accessibility arms',
    ).toEqual(['', 'forced-colors: active', 'prefers-contrast: more']);
  });
});

describe('3D / Immersive treats the shell chrome (MOTIR-4253)', () => {
  it('gives BOTH chrome hosts a rule — the absence that WAS the defect', () => {
    for (const selector of CHROME_SELECTORS) {
      expect(
        at(SHIPPED, selector, ''),
        `no [data-style='${STYLE}'] rule for ${selector} — this is the defect itself`,
      ).toBeDefined();
    }
  });

  // AC 2 — spec and CSS agree DECLARATION FOR DECLARATION, against the asset
  // that drew them rather than against a table retyped here.
  it.each(DESIGNED.map((r) => [r.media || 'top level', r.selector, r] as const))(
    'matches the design asset at [%s] %s, declaration for declaration',
    (_label, selector, designed) => {
      const shipped = at(SHIPPED, selector, designed.media);
      expect(shipped, `theme.css has no ${selector} rule at \`${designed.media}\``).toBeDefined();
      expect(
        Object.fromEntries([...shipped!.decls].sort()),
        'the shipped declarations must equal the drawn ones',
      ).toEqual(Object.fromEntries([...designed.decls].sort()));
    },
  );

  // AC 2, the other home: §4's ladder row is prose, so what is checkable is that
  // it names the SAME instruments the CSS uses. A spec naming a different shadow
  // rung than the stylesheet ships is the drift this catches.
  it('names the same instruments as the ladder row in docs/styles/3d-immersive.md §4', () => {
    const spec = readFileSync(join(ROOT, SPEC_PATH), 'utf8');
    const row = spec.split('\n').find((l) => l.includes('Shell chrome — the top bar and the rail'));
    expect(row, `no shell-chrome row in ${SPEC_PATH} §4`).toBeDefined();
    for (const token of [
      '--spacing-rail-inset',
      '--radius-card',
      '--shadow-card',
      '--shadow-subtle',
    ])
      expect(row!, `§4's ladder row must name ${token}`).toContain(token);
    // And the constraint the row and the CSS both rest on.
    expect(row!.toLowerCase()).toContain('never');
    expect(row!).toContain('position');
  });

  // AC 8 — `position` is not added to the sticky header. The host is already a
  // containing block; overriding it breaks the sticky, AND the existing
  // `sticky … z-30` is the stacking context that makes the lid's shadow paint.
  // The constraint and the mechanism are the same line of TopNav.
  it('never gives the sticky header a `position`', () => {
    for (const rule of chrome(SHIPPED, BAR)) {
      expect(
        rule.decls.has('position'),
        `the ${rule.media || 'top level'} bar rule declares \`position\``,
      ).toBe(false);
    }
  });

  // AC 13 (wiring) — the bar's fill goes transparent so the atmosphere runs
  // under it. Covering it with an opaque fill is precisely MOTIR-4230's defect
  // one surface over; re-introducing it here would be its fourth instance.
  it('takes the fill OFF the bar rather than painting a new one', () => {
    const bar = at(SHIPPED, BAR, '')!;
    expect(bar.decls.get('background-color')).toBe('transparent');
    expect(bar.decls.has('background-image'), 'the lid paints no canvas of its own').toBe(false);
  });

  // AC 6 — no motion for a reduced-motion user. Nothing to still, because
  // nothing moves: the treatment is static depth in every arm.
  it('introduces no motion — nothing to gate behind a motion query', () => {
    for (const rule of SHIPPED.filter(
      (r) => r.style === STYLE && CHROME_SELECTORS.includes(r.selector),
    )) {
      for (const prop of ['animation', 'animation-name', 'transition', 'transition-property'])
        expect(rule.decls.has(prop), `${rule.selector} declares \`${prop}\``).toBe(false);
      expect(rule.media, 'no chrome rule hides behind a motion preference').not.toContain(
        'prefers-reduced-motion',
      );
    }
  });

  // AC 9 — the style and palette axes stay disjoint. Every colour is an existing
  // `--el-*`; the block declares no colour token and invents no hue.
  it('keeps every colour palette-derived and declares no colour token', () => {
    for (const rule of SHIPPED.filter(
      (r) => r.style === STYLE && CHROME_SELECTORS.includes(r.selector),
    )) {
      for (const [prop, value] of rule.decls) {
        expect(
          prop.startsWith('--color-') || prop.startsWith('--el-'),
          `${prop} is a colour token`,
        ).toBe(false);
        expect(value, `${rule.selector} { ${prop} } invents a hue`).not.toMatch(
          /#[0-9a-f]{3,8}\b/i,
        );
        expect(value, `${rule.selector} { ${prop} } names a raw colour function`).not.toMatch(
          /\b(?:rgb|hsl|oklch)a?\(/i,
        );
      }
    }
  });
});

// AC 7 — where structure rests on a shadow, `prefers-contrast: more` and
// `forced-colors: active` restore a solid line, and NEITHER FALLBACK MOVES A
// PIXEL. That is the half a computed-style assertion could not settle in this
// lane and a property-set assertion can: the fallbacks may only touch properties
// that cost no layout, so the geometry is identical with and without the query
// BY CONSTRUCTION rather than by measurement.
describe('the accessibility fallbacks restore the line without moving a pixel', () => {
  /** Anything that would re-lay-out the box if a media query switched it on. */
  const LAYOUT_PROPS = [
    'margin',
    'padding',
    'width',
    'height',
    'border-width',
    'border',
    'border-right',
    'border-bottom',
    'position',
    'inset',
    'top',
    'left',
    'right',
    'bottom',
    'transform',
    'display',
  ];

  it.each(['prefers-contrast: more', 'forced-colors: active'])(
    'restores the rail hairline as an OUTLINE under (%s)',
    (media) => {
      const rail = at(SHIPPED, RAIL, media);
      expect(rail, `no rail fallback under (${media})`).toBeDefined();
      expect(rail!.decls.get('outline')).toBe('1px solid var(--el-border-strong)');
      // Drawn OUTSIDE the box and pulled back onto the border edge: it follows
      // the radius and costs no layout. A `border` would have widened the box.
      expect(rail!.decls.get('outline-offset'), 'the outline sits on the border edge').toBe('-1px');
    },
  );

  it.each(['prefers-contrast: more', 'forced-colors: active'])(
    'restores the bar hairline as a COLOUR on the border it already has, under (%s)',
    (media) => {
      const bar = at(SHIPPED, BAR, media);
      expect(bar, `no bar fallback under (${media})`).toBeDefined();
      // The border-BOTTOM already has its width from TopNav's `border-b`; only
      // its colour was taken away, so giving the colour back moves nothing.
      expect(bar!.decls.get('border-bottom-color')).toBe('var(--el-border-strong)');
      expect(bar!.decls.has('border-bottom-width'), 'the width is never restated').toBe(false);
    },
  );

  it.each(['prefers-contrast: more', 'forced-colors: active'])(
    'declares no layout-affecting property under (%s)',
    (media) => {
      const rules = SHIPPED.filter(
        (r) => r.style === STYLE && r.media === media && CHROME_SELECTORS.includes(r.selector),
      );
      expect(rules.length, `no chrome fallback under (${media})`).toBeGreaterThan(0);
      for (const rule of rules)
        for (const prop of LAYOUT_PROPS)
          expect(
            rule.decls.has(prop),
            `${rule.selector} under (${media}) declares \`${prop}\` — the fallback moves the box`,
          ).toBe(false);
    },
  );

  it('drops the shadow only where the platform paints its own colours', () => {
    // `forced-colors` replaces the palette wholesale, so a multi-layer shadow is
    // noise there; `prefers-contrast: more` keeps the depth and adds the line.
    for (const selector of CHROME_SELECTORS) {
      expect(at(SHIPPED, selector, 'forced-colors: active')!.decls.get('box-shadow')).toBe('none');
      expect(
        at(SHIPPED, selector, 'prefers-contrast: more')!.decls.has('box-shadow'),
        'a high-contrast user keeps the depth',
      ).toBe(false);
    }
  });
});

// AC 4 + AC 12 — the inertness is the claim, not the token's existence.
describe('every other style is left exactly as it was', () => {
  it('is the ONLY style that moves the rail inset', async () => {
    const css = await compileGlobals();
    const moved = STYLE_IDS.filter(
      (id) => (tokenForStyle(css, '--spacing-rail-inset', id) ?? 0) !== 0,
    );
    expect(moved, 'exactly one style floats its rail').toEqual([STYLE]);
  });

  it('compiles both grid sums to today’s numbers for every other style', async () => {
    const css = await compileGlobals();
    const columns = [...css.matchAll(/grid-template-columns:\s*([^;]*?)\s+1fr;/g)].map(
      (m) => m[1]!,
    );
    expect(columns.length, 'both rail columns compiled').toBe(2);
    for (const column of columns)
      expect(column, 'both columns carry the inset term').toContain('var(--spacing-rail-inset)');

    for (const id of STYLE_IDS) {
      const inset = tokenForStyle(css, '--spacing-rail-inset', id);
      expect(inset, `no --spacing-rail-inset resolves for [data-style='${id}']`).not.toBeNull();
      if (id === STYLE) {
        expect(inset, 'the floating rail is held off the frame').toBe(10);
        continue;
      }
      // ZERO is the whole inertness claim: `calc(x + 2 * 0px)` is `x`, so the
      // ten styles whose rail keeps its shared edge lay out identically to
      // before this card. A style that gained a non-zero inset here would be
      // silently re-shaping a shell nobody reported.
      expect(inset, `[data-style='${id}'] must keep its rail flush`).toBe(0);
    }
  });

  it('adds this treatment to NO other style that already touched the chrome', () => {
    // DERIVED, not listed: whichever styles the stylesheet gives a chrome rule.
    expect(CHROME_STYLES, 'the derived chrome set must include this card').toContain(STYLE);
    expect(CHROME_STYLES.length, 'other styles already treated the chrome').toBeGreaterThan(1);

    const mine = new Set(
      [...at(SHIPPED, RAIL, '')!.decls.keys()].filter((p) => p !== 'box-shadow'),
    );
    for (const other of CHROME_STYLES.filter((s) => s !== STYLE)) {
      for (const rule of SHIPPED.filter(
        (r) => r.style === other && CHROME_SELECTORS.includes(r.selector),
      )) {
        for (const prop of mine)
          expect(
            rule.decls.has(prop),
            `[data-style='${other}'] ${rule.selector} gained \`${prop}\` — this card must not ` +
              'have touched another style’s chrome',
          ).toBe(false);
        expect(
          [...rule.decls.values()].join(' '),
          `[data-style='${other}'] must not read the inset token`,
        ).not.toContain('--spacing-rail-inset');
      }
    }
  });
});
