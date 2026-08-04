import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE_ID, PALETTE_IDS } from '@/lib/theme/palettes';
import { PRIORITY_OPTIONS } from '@/lib/issues/priority';
import { LABEL_TINTS } from '@/lib/labels/labelTint';
import { AVATAR_COLORS } from '@/lib/projects/avatar';
import { loadTokenLayer, resolveToken, type ThemeContext } from './paletteCascade';
import { contrast, deltaE2000, mixSrgb } from './colorMetrics';

// MOTIR-2085 — the OTHER four differentiating families, each at the floor its own
// surface needs.
//
// `statusHueSeparation.test.ts` (MOTIR-2073/2075) proved the status ramp stays
// perceptibly apart under every palette, at ΔE2000 >= 10. Sweeping the same
// metric across priority / label / avatar / selection found 104 pairs under that
// bar — and the point of this suite is that MOST OF THEM ARE NOT DEFECTS. A floor
// is only meaningful against the thing the colour has to do, and these four
// families do two different jobs:
//
//   GLYPH families (priority) — a small, isolated mark whose ONLY carrier is
//   colour, exactly like the 10px status dot ΔE 10 was calibrated for in
//   MOTIR-2073. Same job, same bar.
//
//   TINT-BACKGROUND families (label, avatar, selection) — a pale wash BEHIND a
//   primary cue the element renders itself: a label chip shows its own name, an
//   avatar its own initials, a selected row its own position. The colour is the
//   secondary cue, and pastels are DELIBERATELY close in lightness — that
//   coherence is what makes six tints read as one family rather than a clown
//   ramp. Forcing ΔE 10 between six pastels would either blow out the lightness
//   range every `docs/palettes/*.md` commits to or push them apart until the set
//   stops reading as one family. That is a palette redesign, not a bug fix, and
//   this card deliberately does not make it.
//
// So the tint bar is a DUPLICATE DETECTOR, not a legibility bar (see
// MIN_DELTA_E_TINT), and legibility on a tint is carried by the separate
// text-contrast assertion below — which is the bar that actually protects a chip.
//
// Every family is derived from its shipped registry (`PRIORITY_OPTIONS`,
// `LABEL_TINTS`, `AVATAR_COLORS`), never a list hand-copied here, so a registry
// that grows drags its new member into these checks automatically.
//
// MOTIR-2107 — and a family is measured on the value its CONSUMER paints, not
// on the token. `priority` has TWO shipped consumers doing the two different
// jobs above, so it takes two measurements; conflating them is the defect that
// card fixed:
//
//   the ICON — `PRIORITY_ICON_EL` (the automation rule editor's priority
//   Combobox) paints `--el-priority-*` at FULL saturation as a direction arrow.
//   That is the glyph the ΔE 10 bar was written for, so the source sweep keeps
//   it, and the routing is pinned so the bar cannot lose its consumer again.
//
//   the CHIP — `Pill`'s `priority` variant dilutes the same hue to a 14% wash
//   over `--el-surface` and prints `--el-text-strong` on it, which is the TINT
//   shape, not the glyph one. On the SOURCE, graphite's `highest` vs `high`
//   read 10.02 and passed while the chip a user sees was ΔE 4.6. So the chip is
//   measured on the RENDERED mix, derived from the Pill's own recipe (see
//   `pillChipRecipe`) so the floor cannot drift from the component.

const { rules, baseBlock, paletteBlock } = loadTokenLayer();
const THEMES = ['light', 'dark'] as const;
const CONTEXTS: ThemeContext[] = PALETTE_IDS.flatMap((palette) =>
  THEMES.map((theme) => ({ palette, theme })),
);

/**
 * The floor for a family whose colour IS the whole signal — the same ΔE2000 10
 * `statusHueSeparation.test.ts` holds the status dot to, for the same reason.
 *
 * For `priority` the surface this bar speaks for is the **direction icon** in
 * the automation rule editor's priority picker (`PRIORITY_ICON_EL`), which
 * paints `--el-priority-*` undiluted — pinned by the icon-routing test below,
 * because a bar with no consumer is the MOTIR-2107 defect. The `Pill` CHIP
 * dilutes the same hue and is measured separately, on what it renders.
 *
 * Tightest surviving pair after MOTIR-2094: garnet/light `highest` vs `high` at
 * **12.40**, then cobalt/dark `medium` vs `low` at **12.44** — real headroom
 * over the bar rather than the 0.02 graphite used to clear it by. MOTIR-2085
 * left graphite/light at 10.02 (it passed, so it was not that card's to change);
 * MOTIR-2094 gave that ramp its own amber step for the same reason cobalt got
 * one, since a pair sitting AT the perceptual minimum is one palette nudge away
 * from a surprise red. Both fixes are pinned by name below.
 */
const MIN_DELTA_E_GLYPH = 10;

/**
 * The floor for a family that paints a pale BACKGROUND under its own text.
 *
 * Set at 2 — twice the ~1.0 ΔE2000 just-noticeable difference. It answers only
 * "are these two washes actually different colours", which is the question a
 * six-chip ramp has to pass: below it, two labels are the SAME colour and the
 * ramp has silently shipped a duplicate. It is emphatically NOT a legibility
 * bar — how far apart pastels should sit beyond "not identical" is a
 * palette-identity decision, and this card does not make it for ten palettes.
 *
 * Tightest surviving pair: citrine/dark `lavender` vs `sky` at 2.78, then
 * candy/light `peach` vs `rose` at 2.98. The two that were UNDER the bar were
 * fixed rather than allowlisted — sienna's `sky` had collapsed onto `mint`
 * (ΔE 1.3 dark / 3.4 light) and amber's `peach` onto `yellow` (1.7 / 4.3),
 * because warming (resp. gilding) every tint had walked two of the six onto one
 * colour. See `docs/palettes/{sienna,amber}.md`.
 */
const MIN_DELTA_E_TINT = 2;

/**
 * The floor for the priority CHIP — the `Pill` wash, measured on what it
 * renders (MOTIR-2107).
 *
 * Set at the same 2 the pastel tints use, and for the same question: the chip
 * is a wash BEHIND the cues the element prints itself (its label, plus the
 * `PRIORITY_META` direction icon), so the bar asks "are these two chips
 * actually different colours", not "can colour alone carry the difference".
 *
 * Diluting to 14% compresses the source ramp by roughly 5–8x, so this is a far
 * tighter constraint than it looks: the tightest surviving pair is cobalt/dark
 * `medium` vs `low` at **3.40**, then cobalt/light `medium` vs `low` at 4.24.
 * Raising it further is a palette redesign, not a bug fix — the same call
 * MOTIR-2085 made for the pastel ramps. Two pairs are carved out below.
 */
const MIN_DELTA_E_CHIP = 2;

/**
 * The chip floor for the ramp's two NEUTRAL steps (`medium` slate vs `lowest`
 * stone) — the pair that is DELIBERATELY alike.
 *
 * Both ride a neutral Tier-0 source, so their whole separation is lightness,
 * and lightness is exactly what a 14% wash flattens: measured across all 20
 * palette x theme contexts the pair spans **1.35** (candy/light) to **4.39**
 * (citrine/dark) — under the chip floor in four light palettes. Pulling it over
 * 2 with headroom needs `medium` darkened to a 10–15:1 hue, which makes the
 * ramp's MIDDLE step its boldest and inverts the hierarchy `highest` is meant
 * to own (measured on candy / graphite / garnet / citrine, MOTIR-2107). So the
 * pair is accepted, not fixed — held only to the ~1.0 ΔE2000 just-noticeable
 * difference, i.e. "not literally the same colour", and separated on screen by
 * its own icon (Minus vs ArrowDown) and its own label.
 */
const MIN_DELTA_E_CHIP_NEUTRAL = 1;

/**
 * The chip floor for `highest` vs `high` — the ESCALATION pair.
 *
 * Both carry the same ArrowUp glyph and near-identical words ("Highest" /
 * "High"), so the chip is the only cue that separates them at a glance, and
 * mistaking one for the other is a triage error. They also ride two semantics
 * (`--color-destructive` / `--color-warning`) a palette moves independently,
 * which is why they have now collided three times: cobalt rendered **3.83**
 * (MOTIR-2085), graphite **4.64** (MOTIR-2094) and spectrum **4.17**
 * (MOTIR-2107) — every one of them while PASSING the source bar.
 *
 * So the bar is calibrated above the worst of those three rather than invented:
 * 5.5 clears graphite's 4.64 with margin. Tightest surviving pair: garnet/light
 * **6.04**, then sienna/light 6.12. Each palette that fails it takes its own
 * amber step (see `docs/palettes/{cobalt,graphite,spectrum}.md`) — neither
 * semantic moves.
 */
const MIN_DELTA_E_CHIP_ESCALATION = 5.5;

/** WCAG 1.4.11's 3:1, the bar `docs/palettes/*.md` state for icon/UI hues. */
const MIN_UI_CONTRAST = 3;

/** WCAG AA for normal text — what a chip's own label must clear on its tint. */
const MIN_TEXT_CONTRAST = 4.5;

const PRIORITY_TOKENS = PRIORITY_OPTIONS.map((option) => `--el-priority-${option.value}`);
const LABEL_TOKENS = LABEL_TINTS.map((_tint, index) => `--el-label-${index + 1}`);
const AVATAR_TOKENS = AVATAR_COLORS.map((colour) => `--el-avatar-${colour}`);
const SELECTION_TOKENS = ['--el-selection-bg', '--el-droptarget-bg'];

interface Family {
  tokens: string[];
  /** `glyph` = colour is the only carrier; `tint` = a wash behind its own text. */
  kind: 'glyph' | 'tint';
}

const FAMILIES: Record<string, Family> = {
  priority: { tokens: PRIORITY_TOKENS, kind: 'glyph' },
  label: { tokens: LABEL_TOKENS, kind: 'tint' },
  avatar: { tokens: AVATAR_TOKENS, kind: 'tint' },
  selection: { tokens: SELECTION_TOKENS, kind: 'tint' },
};

const floorFor = (family: Family) =>
  family.kind === 'glyph' ? MIN_DELTA_E_GLYPH : MIN_DELTA_E_TINT;

/**
 * Family pairs that resolve too close to tell apart, per palette x theme.
 *
 * Asserted EXACTLY, the house idiom from `paletteTokenCoverage.test.ts` /
 * `statusHueSeparation.test.ts`: a fixed entry turns this suite red until it is
 * deleted, so a stale allowlist cannot rot into a silent pass and a NEW collision
 * cannot hide behind an old one.
 *
 * EMPTY, and it should stay that way. A new entry means a palette shipped a
 * collision — NOT that the floor needs relaxing. If a genuinely-intentional pair
 * ever lands here, the honest fix is to say so in `kind` (a family whose members
 * are meant to be alike is not a `glyph` family) rather than to widen this list.
 */
const KNOWN_TOO_CLOSE: string[] = [];

/** The same list, for the RENDERED priority chip. Empty, and it should stay so. */
const KNOWN_CHIP_TOO_CLOSE: string[] = [];

function hueOf(ctx: ThemeContext, token: string): string {
  const { value, unresolved } = resolveToken(rules, ctx, token);
  expect(unresolved, `${ctx.palette}/${ctx.theme} ${token} must resolve`).toEqual([]);
  return value.toLowerCase();
}

/** The `--color-*` source a base-block `--el-*` declaration references, if any. */
const sourceOf = (token: string) => baseBlock[token]?.match(/var\(\s*(--color-[\w-]+)/)?.[1];

/**
 * The `color-mix()` recipe the SHIPPED `Pill` paints a priority chip with, read
 * out of the component itself (MOTIR-2107).
 *
 * Parsed, not re-typed: a constant copied into this file is a second source of
 * truth that drifts the first time someone tunes the wash, and the drift is
 * invisible — the suite keeps passing while measuring a colour the app stopped
 * rendering. If the recipe stops being a `color-mix` of one `--el-priority-*`
 * step over one element token, the parse fails loudly here rather than quietly
 * measuring the wrong thing.
 */
function pillChipRecipe(): { percent: number; base: string } {
  const source = readFileSync(
    join(process.cwd(), 'packages/design-system/src/components/ui/Pill.tsx'),
    'utf8',
  );
  const recipes = PRIORITY_OPTIONS.map(({ value }) => {
    const match = source.match(
      new RegExp(
        `bg-\\[color-mix\\(in_srgb,var\\(--el-priority-${value}\\)_(\\d+(?:\\.\\d+)?)%,var\\((--el-[\\w-]+)\\)\\)\\]`,
      ),
    );
    if (!match) throw new Error(`Pill.tsx no longer mixes a chip for priority "${value}"`);
    return { value, percent: Number(match[1]), base: match[2]! };
  });
  const [first] = recipes as [(typeof recipes)[number], ...typeof recipes];
  for (const recipe of recipes) {
    if (recipe.percent !== first.percent || recipe.base !== first.base) {
      throw new Error(
        `Pill.tsx mixes priority steps differently (${recipe.value}: ${recipe.percent}% over ${recipe.base}) — this suite measures ONE recipe`,
      );
    }
  }
  return { percent: first.percent, base: first.base };
}

const CHIP = pillChipRecipe();

/** What the `Pill` actually paints for one priority step, in one context. */
const chipOf = (ctx: ThemeContext, step: string) =>
  mixSrgb(hueOf(ctx, `--el-priority-${step}`), CHIP.percent, hueOf(ctx, CHIP.base));

const PRIORITY_STEPS = PRIORITY_OPTIONS.map((option) => option.value);

/**
 * Tier-0 sources whose whole job is to be NEUTRAL. A priority pair drawn from
 * two of them is the ramp's quiet end (`medium` slate vs `lowest` stone) — the
 * deliberately-alike pair `MIN_DELTA_E_CHIP_NEUTRAL` speaks for. Derived from
 * the base block rather than hand-listed, so re-pointing a step at a hue drags
 * it back under the full chip floor automatically.
 */
const NEUTRAL_SOURCES = ['--color-slate', '--color-stone'];
const isNeutralStep = (step: string) =>
  NEUTRAL_SOURCES.includes(sourceOf(`--el-priority-${step}`) ?? '');
const isEscalationPair = (a: string, b: string) =>
  [a, b].every((step) => step === 'highest' || step === 'high');

const chipFloorFor = (a: string, b: string) => {
  if (isEscalationPair(a, b)) return MIN_DELTA_E_CHIP_ESCALATION;
  if (isNeutralStep(a) && isNeutralStep(b)) return MIN_DELTA_E_CHIP_NEUTRAL;
  return MIN_DELTA_E_CHIP;
};

/** Every within-ramp priority pair, in registry order. */
const PRIORITY_PAIRS = PRIORITY_STEPS.flatMap((a, index) =>
  PRIORITY_STEPS.slice(index + 1).map((b) => [a, b] as const),
);

describe('family hue separation — each family at the floor its own surface needs', () => {
  it('resolves every family from its shipped registry, in every palette x theme', () => {
    // Guards the guard: a helper that silently resolved nothing, or a registry
    // that came back empty, would make every assertion below vacuous.
    expect(CONTEXTS).toHaveLength(PALETTE_IDS.length * 2);
    expect(PRIORITY_TOKENS).toHaveLength(PRIORITY_OPTIONS.length);
    expect(LABEL_TOKENS).toHaveLength(LABEL_TINTS.length);
    expect(AVATAR_TOKENS).toHaveLength(AVATAR_COLORS.length);
    expect(PRIORITY_TOKENS.length).toBeGreaterThanOrEqual(5);
    expect(LABEL_TOKENS.length).toBeGreaterThanOrEqual(6);
    for (const ctx of CONTEXTS) {
      for (const { tokens } of Object.values(FAMILIES)) {
        for (const token of tokens) expect(hueOf(ctx, token)).toMatch(/^#[0-9a-f]{3,8}$/);
      }
    }
  });

  it('separates every within-family pair by that family s own floor', () => {
    const tooClose: string[] = [];
    for (const ctx of CONTEXTS) {
      for (const [name, family] of Object.entries(FAMILIES)) {
        const { tokens } = family;
        for (let i = 0; i < tokens.length; i += 1) {
          for (let j = i + 1; j < tokens.length; j += 1) {
            const [a, b] = [tokens[i]!, tokens[j]!];
            const distance = deltaE2000(hueOf(ctx, a), hueOf(ctx, b));
            if (distance < floorFor(family)) {
              tooClose.push(
                `${ctx.palette}/${ctx.theme} ${name} ${a} vs ${b} — ΔE ${distance.toFixed(1)}`,
              );
            }
          }
        }
      }
    }
    expect(tooClose.sort()).toEqual([...KNOWN_TOO_CLOSE].sort());
  });

  it('holds the two floors apart — a tint family is NOT held to the glyph bar', () => {
    // The decision this card exists to make, asserted rather than described: if
    // someone later "simplifies" the two floors into one, this fails. The tint
    // bar must stay strictly the looser of the two, and the glyph bar must stay
    // the status dot's bar.
    expect(MIN_DELTA_E_TINT).toBeLessThan(MIN_DELTA_E_GLYPH);
    expect(FAMILIES.priority!.kind).toBe('glyph');
    for (const name of ['label', 'avatar', 'selection']) {
      expect(FAMILIES[name]!.kind, `${name} paints a background, not a glyph`).toBe('tint');
    }
    // Under the glyph bar the tint families would fail loudly — which is the
    // whole argument for two floors, so prove it rather than assert it in prose.
    const wouldFail = CONTEXTS.some((ctx) =>
      LABEL_TOKENS.some((a, i) =>
        LABEL_TOKENS.slice(i + 1).some(
          (b) => deltaE2000(hueOf(ctx, a), hueOf(ctx, b)) < MIN_DELTA_E_GLYPH,
        ),
      ),
    );
    expect(wouldFail, 'pastel tints cannot meet a dot bar — that is why they have their own').toBe(
      true,
    );
  });
});

describe('the label and avatar ramps are ONE ramp', () => {
  it('resolves both families through the SAME --color-tint-* sources', () => {
    // The fact that made this one defect and not two: `--el-label-N` and
    // `--el-avatar-<name>` are the same six colours, so any fix moves both
    // surfaces at once. Pinned so a future change cannot silently repair one
    // family and leave the other behind.
    expect(LABEL_TINTS).toEqual([...AVATAR_COLORS]);
    for (const [index, tint] of LABEL_TINTS.entries()) {
      const labelSource = sourceOf(`--el-label-${index + 1}`);
      const avatarSource = sourceOf(`--el-avatar-${tint}`);
      expect(labelSource, `--el-label-${index + 1} must ride a --color-tint-*`).toBe(
        `--color-tint-${tint}`,
      );
      expect(avatarSource, `--el-avatar-${tint} must ride the same source`).toBe(labelSource);
    }
    // The selection washes are drawn from that same ramp — which is why they get
    // the tint floor and not the dot's.
    expect(sourceOf('--el-selection-bg')).toBe('--color-tint-sky');
    expect(sourceOf('--el-droptarget-bg')).toBe('--color-tint-lavender');
  });

  it('keeps the two families pixel-identical in every palette x theme', () => {
    // The source check above is the mechanism; this is the OUTCOME. A palette
    // that overrode `--el-label-3` directly would pass the mechanism check and
    // fail here — which is the drift worth catching.
    const drifted: string[] = [];
    for (const ctx of CONTEXTS) {
      for (const [index, tint] of LABEL_TINTS.entries()) {
        const label = hueOf(ctx, `--el-label-${index + 1}`);
        const avatar = hueOf(ctx, `--el-avatar-${tint}`);
        if (label !== avatar) {
          drifted.push(
            `${ctx.palette}/${ctx.theme} label-${index + 1} ${label} vs ${tint} ${avatar}`,
          );
        }
      }
    }
    expect(drifted).toEqual([]);
  });
});

describe('tint backgrounds carry their own text at AA', () => {
  it(`keeps --el-text-strong past ${MIN_TEXT_CONTRAST}:1 on every tint wash`, () => {
    // The bar that actually protects a chip. `MultiSelectPicker` renders a label
    // chip as `bg-(--el-label-N) text-(--el-text-strong)` and `ProjectAvatar`
    // its initials the same way, so this is the shipped pairing — and it, not
    // the ΔE floor, is what makes a pale ramp safe to keep pale.
    const failures: string[] = [];
    let checked = 0;
    for (const ctx of CONTEXTS) {
      const ink = hueOf(ctx, '--el-text-strong');
      for (const token of [...LABEL_TOKENS, ...AVATAR_TOKENS, ...SELECTION_TOKENS]) {
        checked += 1;
        const ratio = contrast(ink, hueOf(ctx, token));
        if (ratio < MIN_TEXT_CONTRAST) {
          failures.push(
            `${ctx.palette}/${ctx.theme} --el-text-strong on ${token} — ${ratio.toFixed(2)}:1`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
    // Guards the guard: 20 contexts x (6 label + 6 avatar + 2 selection).
    expect(checked).toBe(CONTEXTS.length * 14);
  });
});

describe('the priority ramp is a GLYPH ramp', () => {
  it(`keeps every OVERRIDDEN priority step past ${MIN_UI_CONTRAST}:1 on card and surface`, () => {
    // Same shape as the status suite's override sweep, and NOT swept across the
    // whole ramp for the same reason: `--el-priority-lowest` rides
    // `--color-stone`, the documented "faint labels (decorative, sub-AA)" step,
    // and sits in the low 2s by design in most palettes. A step a palette moves
    // ON PURPOSE, though, has to clear the icon/UI bar. Derived from the
    // stylesheet, so a future palette override is dragged in automatically.
    const failures: string[] = [];
    let checked = 0;
    for (const ctx of CONTEXTS) {
      const block = paletteBlock(ctx.palette, ctx.theme);
      for (const token of PRIORITY_TOKENS) {
        if (!(token in block)) continue; // rides its --color-* source; not an override
        checked += 1;
        const hue = hueOf(ctx, token);
        for (const backdrop of ['--el-card', '--el-surface'] as const) {
          const ratio = contrast(hue, hueOf(ctx, backdrop));
          if (ratio < MIN_UI_CONTRAST) {
            failures.push(
              `${ctx.palette}/${ctx.theme} ${token} on ${backdrop} — ${ratio.toFixed(2)}:1`,
            );
          }
        }
      }
    }
    expect(failures).toEqual([]);
    // Guards the guard: cobalt's + graphite's `high`, each in both themes
    // (MOTIR-2085, MOTIR-2094).
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it('keeps highest and high APART, with headroom, in every palette that took an amber step', () => {
    // The three specific collisions, pinned by name so a regression reads as
    // itself rather than as one line in the sweep above. All three palettes ship
    // a red-leaning warning beside a danger red, and all three answer it the
    // same way: the PRIORITY ramp takes its own amber step instead of moving
    // either semantic.
    //
    // Asserted against 2x the floor, NOT the floor — because clearing the floor
    // is exactly what graphite did at ΔE 10.02, a distance no eye can tell from
    // the cobalt 9.92 that counted as a defect (MOTIR-2094). A documented step
    // exists to buy real margin, so the test asks for margin; a "fix" that lands
    // at 10.1 is not one.
    //
    // Which THEME carries the step is pinned per palette: cobalt and graphite
    // needed only light (their dark hues were already 25.8 apart) and re-assert
    // the warning source in dark for the cascade pairing; spectrum's dark
    // rendered 4.77 too (MOTIR-2107), so it carries an amber in both.
    const HEADROOM = MIN_DELTA_E_GLYPH * 2;
    const AMBER_STEP_PALETTES: Record<string, { light: RegExp; dark: RegExp | string }> = {
      cobalt: { light: /^#/, dark: 'var(--color-warning)' },
      graphite: { light: /^#/, dark: 'var(--color-warning)' },
      spectrum: { light: /^#/, dark: /^#/ },
    };
    // Derived, not just listed: any OTHER palette that starts overriding this
    // step has to be measured here too, so the list cannot silently fall behind.
    const declaring = PALETTE_IDS.filter(
      (palette) => '--el-priority-high' in paletteBlock(palette, 'light'),
    );
    expect(declaring.sort()).toEqual(Object.keys(AMBER_STEP_PALETTES).sort());

    for (const [palette, declared] of Object.entries(AMBER_STEP_PALETTES)) {
      for (const theme of THEMES) {
        const ctx: ThemeContext = { palette, theme };
        const highest = hueOf(ctx, '--el-priority-highest');
        const high = hueOf(ctx, '--el-priority-high');
        expect(high, `${palette}/${theme} must not collapse high onto highest`).not.toBe(highest);
        expect(
          deltaE2000(highest, high),
          `${palette}/${theme} highest vs high needs real headroom, not a rounding pass`,
        ).toBeGreaterThan(HEADROOM);
      }
      const inLight = paletteBlock(palette, 'light')['--el-priority-high'];
      const inDark = paletteBlock(palette, 'dark')['--el-priority-high'];
      expect(inLight, `${palette} light`).toMatch(declared.light);
      if (typeof declared.dark === 'string') expect(inDark, `${palette} dark`).toBe(declared.dark);
      else expect(inDark, `${palette} dark`).toMatch(declared.dark);
    }
    // The semantics themselves are untouched — only the ramp took a new step.
    expect(sourceOf('--el-priority-highest')).toBe('--color-destructive');
    expect(sourceOf('--el-priority-high')).toBe('--color-warning');
  });

  it('is the ramp the automation priority picker paints its direction icon from', () => {
    // The consumer that makes the glyph floor above mean something (MOTIR-2107).
    // Before this card `PRIORITY_ICON_EL` rode the SEMANTIC tokens instead —
    // which left the ΔE 10 bar guarding a ramp no undiluted surface rendered,
    // and (worse) painted `medium` and `lowest` with ONE token, so the picker
    // could not tell the ramp's two quiet steps apart at all. Read from the
    // component so the two cannot drift apart again.
    const source = readFileSync(
      join(
        process.cwd(),
        'app/(authed)/settings/project/automation/_components/AutomationParts.tsx',
      ),
      'utf8',
    );
    const routed = Object.fromEntries(
      [...source.matchAll(/^\s{2}(\w+): 'text-\(--el-([\w-]+)\)',$/gm)].map((m) => [m[1], m[2]]),
    );
    expect(routed).toEqual(
      Object.fromEntries(PRIORITY_STEPS.map((step) => [step, `priority-${step}`])),
    );
  });
});

describe('the priority CHIP — measured on what the shipped Pill renders', () => {
  it('derives the wash recipe from the Pill component itself', () => {
    // Guards the guard: the whole card turns on this parse being real. A recipe
    // that silently came back as "0% over --el-surface" would make every chip
    // identical to the surface and every assertion below vacuous.
    expect(CHIP.percent).toBeGreaterThan(0);
    expect(CHIP.percent).toBeLessThan(100);
    expect(CHIP.base).toMatch(/^--el-/);
    expect(hueOf({ palette: DEFAULT_PALETTE_ID, theme: 'light' }, CHIP.base)).toMatch(/^#/);
    // What it is TODAY, so a change to the shipped wash shows up as a diff here
    // (and re-runs the numbers in every docstring above) rather than passing
    // unremarked.
    expect(CHIP).toEqual({ percent: 14, base: '--el-surface' });
  });

  it('dilutes the ramp — the source ΔE is NOT the ΔE a user sees', () => {
    // The defect in one assertion. Every escalation pair renders CLOSER than its
    // source hues measure, which is why the source bar cannot speak for the chip:
    // graphite passed at 10.02 while painting 4.64.
    const notDiluted: string[] = [];
    for (const ctx of CONTEXTS) {
      const source = deltaE2000(
        hueOf(ctx, '--el-priority-highest'),
        hueOf(ctx, '--el-priority-high'),
      );
      const rendered = deltaE2000(chipOf(ctx, 'highest'), chipOf(ctx, 'high'));
      if (rendered >= source) notDiluted.push(`${ctx.palette}/${ctx.theme}`);
    }
    expect(notDiluted).toEqual([]);
  });

  it('separates every rendered chip pair by the floor that pair s cues need', () => {
    const tooClose: string[] = [];
    for (const ctx of CONTEXTS) {
      for (const [a, b] of PRIORITY_PAIRS) {
        const distance = deltaE2000(chipOf(ctx, a), chipOf(ctx, b));
        const floor = chipFloorFor(a, b);
        if (distance < floor) {
          tooClose.push(
            `${ctx.palette}/${ctx.theme} chip ${a} vs ${b} — ΔE ${distance.toFixed(1)} (floor ${floor})`,
          );
        }
      }
    }
    expect(tooClose.sort()).toEqual([...KNOWN_CHIP_TOO_CLOSE].sort());
  });

  it('carves out exactly ONE deliberately-alike pair, and records what it measures', () => {
    // The accepted exception, asserted rather than described (MOTIR-2107). If a
    // future palette re-points `medium` or `lowest` at a hue, `isNeutralStep`
    // stops matching and that pair falls back under the full chip floor — so the
    // carve-out cannot quietly widen.
    const neutralPairs = PRIORITY_PAIRS.filter(
      ([a, b]) => chipFloorFor(a, b) === MIN_DELTA_E_CHIP_NEUTRAL,
    );
    expect(neutralPairs).toEqual([['medium', 'lowest']]);
    expect(MIN_DELTA_E_CHIP_NEUTRAL).toBeLessThan(MIN_DELTA_E_CHIP);
    expect(MIN_DELTA_E_CHIP).toBeLessThan(MIN_DELTA_E_CHIP_ESCALATION);

    const measured = CONTEXTS.map((ctx) =>
      deltaE2000(chipOf(ctx, 'medium'), chipOf(ctx, 'lowest')),
    );
    // It is load-bearing: the pair really does render under the general floor in
    // some palettes, so "accepted" is a decision and not a formality.
    expect(Math.min(...measured)).toBeLessThan(MIN_DELTA_E_CHIP);
    // And it is bounded: the range the docstring records, kept honest.
    expect(Math.min(...measured)).toBeGreaterThan(MIN_DELTA_E_CHIP_NEUTRAL);
    expect(Math.max(...measured)).toBeLessThan(MIN_DELTA_E_CHIP_ESCALATION);
  });
});

describe('the cascade trap — every override declared in BOTH themes', () => {
  it('pairs every priority override across a palette s two blocks', () => {
    // `[data-palette='x']` and the base `[data-theme='dark']` TIE on specificity
    // (0,1,0) and the palette blocks come LATER in the sheet — so an override
    // written only in a palette's light block silently LEAKS onto its dark
    // canvas, where it was never measured. MOTIR-2075 proved this in Chromium
    // and in the cascade model for the status ramp; the priority ramp this card
    // touches has exactly the same exposure.
    const unpaired: string[] = [];
    for (const palette of PALETTE_IDS.filter((id) => id !== DEFAULT_PALETTE_ID)) {
      const [light, dark] = THEMES.map((theme) => paletteBlock(palette, theme));
      for (const token of PRIORITY_TOKENS) {
        const inLight = token in (light ?? {});
        const inDark = token in (dark ?? {});
        if (inLight !== inDark) {
          unpaired.push(`${palette} declares ${token} in ${inLight ? 'light' : 'dark'} only`);
        }
      }
    }
    expect(unpaired).toEqual([]);
  });

  it('pairs every --color-tint-* source across a palette s two blocks', () => {
    // The same trap one tier down, and the one that matters for label / avatar /
    // selection: those families are re-skinned through Tier-0 `--color-tint-*`,
    // so a palette that re-tints six washes in light and five in dark leaks the
    // sixth LIGHT pastel onto its dark canvas.
    const unpaired: string[] = [];
    for (const palette of PALETTE_IDS.filter((id) => id !== DEFAULT_PALETTE_ID)) {
      const [light, dark] = THEMES.map((theme) => paletteBlock(palette, theme));
      for (const tint of LABEL_TINTS) {
        const source = `--color-tint-${tint}`;
        const inLight = source in (light ?? {});
        const inDark = source in (dark ?? {});
        if (inLight !== inDark) {
          unpaired.push(`${palette} declares ${source} in ${inLight ? 'light' : 'dark'} only`);
        }
      }
    }
    expect(unpaired).toEqual([]);
  });
});
