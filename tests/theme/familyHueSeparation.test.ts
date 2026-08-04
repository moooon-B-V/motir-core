import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE_ID, PALETTE_IDS } from '@/lib/theme/palettes';
import { PRIORITY_OPTIONS } from '@/lib/issues/priority';
import { LABEL_TINTS } from '@/lib/labels/labelTint';
import { AVATAR_COLORS } from '@/lib/projects/avatar';
import { loadTokenLayer, resolveToken, type ThemeContext } from './paletteCascade';
import { contrast, deltaE2000 } from './colorMetrics';

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

const { rules, baseBlock, paletteBlock } = loadTokenLayer();
const THEMES = ['light', 'dark'] as const;
const CONTEXTS: ThemeContext[] = PALETTE_IDS.flatMap((palette) =>
  THEMES.map((theme) => ({ palette, theme })),
);

/**
 * The floor for a family whose colour IS the whole signal — the same ΔE2000 10
 * `statusHueSeparation.test.ts` holds the status dot to, for the same reason.
 *
 * Tightest surviving pair after MOTIR-2085: graphite/light `highest` vs `high`
 * at **10.02**. That is real but near-zero headroom — graphite's warning is a
 * red-leaning burnt orange sitting next to its danger red, the same shape as the
 * cobalt 9.9 this card fixed, and it clears the bar only by rounding. It is left
 * alone deliberately: it is not a violation, and re-tuning a shipping palette
 * that passes is a design change no acceptance criterion asked for. Logged as
 * MOTIR-2094 so the next palette tweak does not discover it as a surprise red.
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

function hueOf(ctx: ThemeContext, token: string): string {
  const { value, unresolved } = resolveToken(rules, ctx, token);
  expect(unresolved, `${ctx.palette}/${ctx.theme} ${token} must resolve`).toEqual([]);
  return value.toLowerCase();
}

/** The `--color-*` source a base-block `--el-*` declaration references, if any. */
const sourceOf = (token: string) => baseBlock[token]?.match(/var\(\s*(--color-[\w-]+)/)?.[1];

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
    // Guards the guard: cobalt's `high`, in both themes (MOTIR-2085).
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it('keeps highest and high apart under Cobalt, in BOTH themes (MOTIR-2085)', () => {
    // The specific collision this card fixed, pinned by name so a regression
    // reads as itself rather than as one line in the sweep above. Cobalt's
    // warning is a red-leaning burnt orange next to its danger red, so the
    // PRIORITY ramp takes its own amber step instead of moving either semantic.
    for (const theme of THEMES) {
      const ctx: ThemeContext = { palette: 'cobalt', theme };
      const highest = hueOf(ctx, '--el-priority-highest');
      const high = hueOf(ctx, '--el-priority-high');
      expect(high, `cobalt/${theme} must not collapse high onto highest`).not.toBe(highest);
      expect(deltaE2000(highest, high)).toBeGreaterThan(MIN_DELTA_E_GLYPH);
    }
    // The semantics themselves are untouched — only the ramp took a new step.
    expect(sourceOf('--el-priority-highest')).toBe('--color-destructive');
    expect(sourceOf('--el-priority-high')).toBe('--color-warning');
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
