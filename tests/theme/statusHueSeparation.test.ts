import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE_ID, PALETTE_IDS } from '@/lib/theme/palettes';
import { DEFAULT_STATUSES } from '@/lib/workflows/defaultWorkflow';
import { statusElVar } from '@/lib/workflows/statusColor';
import { isMeasuredStep, loadTokenLayer, resolveToken, type ThemeContext } from './paletteCascade';
import { contrast, deltaE2000, flattenColorMix, lab } from './colorMetrics';

// MOTIR-2073 — the status ramp must be PERCEPTIBLY separated, not merely unequal.
//
// The defect this pins: MOTIR-1273 un-collapsed the workflow statuses by giving
// each its own Tier-0 source (`--el-status-in-progress: var(--color-info)` vs
// `--el-status-in-review: var(--color-primary)`), but that differentiation only
// survives while a palette keeps those two sources APART. Graphite — monochrome
// with one chromatic accent — set `--color-info` = `--color-primary`, which
// re-collapsed in_review onto in_progress one layer down. Nothing in the token
// layer recorded "these two must stay distinct", so the invariant lived only in
// the palette author's eye.
//
// ── Why a MEASURED floor and not `!==` ──────────────────────────────────────
// MOTIR-1278's coverage matrix already asserts the six hues are unequal STRINGS
// under every palette. That is necessary but not sufficient: two blues one hex
// apart pass it and are indistinguishable on a 10px dot. This suite asserts the
// property the dot actually needs — a perceptual floor (CIEDE2000) between every
// pair, plus the icon/UI contrast bar against the surfaces the dot sits on. A
// palette that unifies two Tier-0 sources fails HERE, at the layer where the
// collision happens, rather than shipping a UI that cannot tell two states apart.
//
// The status list is derived from the shipped workflow through `statusElVar` —
// the same helper StatusPicker paints with — so a workflow that grows a status
// drags it into this check automatically.

const { rules, paletteBlock } = loadTokenLayer();
const THEMES = ['light', 'dark'] as const;
const STATUS_TOKENS = DEFAULT_STATUSES.map((status) => statusElVar(status));

/**
 * The perceptual floor, in CIEDE2000 units. Set at 10 — comfortably under the
 * TIGHTEST deliberate pair any shipped palette has (Graphite's two greys,
 * todo/cancelled, at ~11.8) and far above the "different hex, same colour"
 * band a bare `!==` admits. It is a floor on the SHIPPED set, so raising it
 * is a design decision; lowering it to admit a new palette is the smell this
 * suite exists to catch.
 */
const MIN_DELTA_E = 10;

/**
 * The contrast floor for a hue that carries meaning as a GRAPHICAL OBJECT — the
 * 3:1 of WCAG 1.4.11, and the bar `docs/palettes/*.md` state for icon/UI hues.
 *
 * Applied to every step a palette OVERRIDES directly — MOTIR-2073's Graphite
 * hue and the eight MOTIR-2075 added across five palettes — AND, since
 * MOTIR-3954, to every step of the BASE palette. It is deliberately NOT swept
 * across the whole ramp of the other nine: `--el-status-todo` (`--color-stone`)
 * and, in a few palettes, `--el-status-done` sit in the low 2s by design —
 * `stone` is the documented "faint labels (decorative, sub-AA)" step, the dots
 * are `aria-hidden` and always rendered beside the status LABEL, and two of the
 * three consumers ring them with `border-(--el-border)`. So they are decoration,
 * not a graphical object required to understand the content, and re-tuning ten
 * palettes' neutral step is not this suite's business.
 */
const MIN_UI_CONTRAST = 3;

/**
 * The surfaces a status dot sits on — MOTIR-3954 added `--el-page-bg`.
 *
 * `--el-card` is the row/card fill under most dots and `--el-surface` the
 * sectioned backdrop the card sits in (MOTIR-2075's named pairing); the third is
 * the bare page, where the board's column headers and the item page's own status
 * control render with no card under them. It resolves to the same value as
 * `--el-card` in all ten palettes today, so it costs one comparison and catches
 * the palette that later moves one and not the other.
 */
const BACKDROPS = ['--el-card', '--el-surface', '--el-page-bg'] as const;

/**
 * Steps that are BELOW the bar on purpose, keyed `<palette>/<theme> <token>`,
 * each with the reason it is not a defect. Asserted EXACTLY in both directions,
 * the house idiom `KNOWN_TOO_CLOSE` uses above: an entry that stops failing
 * turns this suite red until it is deleted, and a step that starts failing is
 * red whether or not something else already is.
 *
 * ⚠️ Every entry is the BASE palette, and that is the point of MOTIR-3954 rather
 * than an accident: the nine override blocks are swept for the steps they
 * declare, so a palette that overrides a step has already accepted the bar for
 * it. The base declares the whole ramp, decoration included, so widening the
 * sweep to reach it necessarily reaches the two neutrals the bar was never
 * written for — and naming them here is what makes that carve-out READABLE.
 * It used to be structural: the base had no `[data-palette]` block, so all eight
 * of its inks were skipped by a rule about overrides, and nothing said so.
 */
const KNOWN_SUB_BAR: Record<string, string> = {
  // `--color-stone`, the documented "faint labels (decorative, sub-AA)" step —
  // the exemption the MIN_UI_CONTRAST doc above already states, now spelled out
  // where the sweep can check it. 2.61:1 light, 2.82:1 dark.
  'motir/light --el-status-todo': 'rides --color-stone, the documented decorative step',
  'motir/dark --el-status-todo': 'rides --color-stone, the documented decorative step',
};

/**
 * Status pairs that resolve too close to tell apart, per palette x theme.
 *
 * Asserted EXACTLY, the house idiom from `paletteTokenCoverage.test.ts`: a
 * fixed entry turns this suite red until it is deleted, so a stale allowlist
 * cannot rot into a silent pass and a NEW collision cannot hide behind an old
 * one.
 *
 * EMPTY as of MOTIR-2075, and it should stay that way: every palette x theme
 * now clears the floor, so a new entry here means a palette shipped a collision
 * rather than that the check needs relaxing. The nine it used to hold were the
 * same defect class MOTIR-2073 fixed in Graphite, found in five more palettes by
 * this sweep (a bare `!==` never saw them because the hexes differ) — each fixed
 * the same way: keep the palette's Tier-0 identity choices and give the STATUS
 * RAMP its own documented step. See `docs/palettes/{citrine,cobalt,evergreen,
 * garnet,sienna}.md` for the per-palette reasoning.
 */
const KNOWN_TOO_CLOSE: string[] = [];

// The colour maths lives in `./colorMetrics` — `familyHueSeparation.test.ts`
// (MOTIR-2085) measures the other four families with the same metric, and one
// CIEDE2000 shared beats two copies drifting apart.

// ── The resolved status ramp, per palette x theme ───────────────────────────

function hueOf(ctx: ThemeContext, token: string): string {
  const { value, unresolved } = resolveToken(rules, ctx, token);
  expect(unresolved, `${ctx.palette}/${ctx.theme} ${token} must resolve`).toEqual([]);
  // A status hue may be expressed as a `color-mix` of two other status tokens
  // (MOTIR-3003's `--el-status-implemented` is a desaturated `in_review`, so it
  // tracks whatever a palette does to the brand hue). The resolver substitutes
  // the vars and leaves the wrapper; fold it, or every metric below throws on a
  // value it should be measuring.
  return flattenColorMix(value).toLowerCase();
}

const CONTEXTS: ThemeContext[] = PALETTE_IDS.flatMap((palette) =>
  THEMES.map((theme) => ({ palette, theme })),
);

describe('status hue separation — every palette keeps the six statuses apart', () => {
  it('resolves the ramp from the shipped workflow, in every palette x theme', () => {
    // Guards the guard: a helper that silently resolved nothing would make the
    // separation assertions vacuous.
    expect(STATUS_TOKENS).toHaveLength(DEFAULT_STATUSES.length);
    expect(new Set(STATUS_TOKENS).size).toBe(DEFAULT_STATUSES.length);
    expect(STATUS_TOKENS).toContain('--el-status-in-progress');
    expect(STATUS_TOKENS).toContain('--el-status-in-review');
    expect(CONTEXTS).toHaveLength(PALETTE_IDS.length * 2);
    for (const ctx of CONTEXTS) {
      for (const token of STATUS_TOKENS) expect(hueOf(ctx, token)).toMatch(/^#[0-9a-f]{3,8}$/);
    }
  });

  it(`separates every pair by at least ΔE2000 ${MIN_DELTA_E}`, () => {
    const tooClose: string[] = [];
    for (const ctx of CONTEXTS) {
      for (let i = 0; i < STATUS_TOKENS.length; i += 1) {
        for (let j = i + 1; j < STATUS_TOKENS.length; j += 1) {
          const [a, b] = [STATUS_TOKENS[i]!, STATUS_TOKENS[j]!];
          const distance = deltaE2000(hueOf(ctx, a), hueOf(ctx, b));
          if (distance < MIN_DELTA_E) {
            tooClose.push(`${ctx.palette}/${ctx.theme} ${a} vs ${b} — ΔE ${distance.toFixed(1)}`);
          }
        }
      }
    }
    expect(tooClose.sort()).toEqual([...KNOWN_TOO_CLOSE].sort());
    // Graphite is fixed, so it appears nowhere in the allowlist.
    expect(KNOWN_TOO_CLOSE.filter((entry) => entry.startsWith('graphite/'))).toEqual([]);
  });

  it('keeps in_progress and in_review apart under Graphite, in BOTH themes (MOTIR-2073)', () => {
    // The specific collision this card fixed, pinned by name so a regression
    // reads as itself rather than as one line in the sweep above. Graphite
    // deliberately unifies --color-info with --color-primary (monochrome, one
    // accent), so the ramp gets its own SECOND STEP of that accent instead.
    for (const theme of THEMES) {
      const ctx: ThemeContext = { palette: 'graphite', theme };
      const inProgress = hueOf(ctx, '--el-status-in-progress');
      const inReview = hueOf(ctx, '--el-status-in-review');
      expect(inReview, `graphite/${theme} must not re-collapse in_review`).not.toBe(inProgress);
      expect(deltaE2000(inProgress, inReview)).toBeGreaterThan(MIN_DELTA_E);
      // Still ONE chromatic accent: the review step is a blue, not a new hue
      // family — its own Tier-0 source stays out of it, so the palette's
      // `--color-info` / `--color-primary` identity choice is untouched.
      const [, a, b] = lab(inReview);
      expect(b, `graphite/${theme} review step should stay on the blue axis`).toBeLessThan(a);
    }
  });

  it(`keeps every OVERRIDDEN step AND the BASE ramp past ${MIN_UI_CONTRAST}:1 on the surfaces the dot sits on`, () => {
    // Generalised from Graphite-only by MOTIR-2075, which added eight more
    // overrides across five palettes. The set is DERIVED from the stylesheet
    // rather than listed here, so a palette that gains a status override in
    // future is dragged into this bar automatically instead of being covered
    // only if someone remembered to extend a literal list.
    //
    // ⚠️ MOTIR-3954 — and the derivation is exactly what left a hole. "Derived
    // from the stylesheet" meant "declared in a `[data-palette]` block", and the
    // BASE palette has none: its ramp is the Tier-3 block every other palette is
    // measured against. So the one palette whose values a default install
    // actually renders was the one palette this bar could not see, and
    // `--el-status-implemented` sat at 2.66:1 on `--el-card` under it. The
    // population is now overrides ∪ base (`isMeasuredStep`), with the steps that
    // are sub-bar ON PURPOSE named in `KNOWN_SUB_BAR` rather than skipped by a
    // rule that never meant to skip them.
    const failures: string[] = [];
    let checked = 0;
    let baseChecked = 0;
    for (const ctx of CONTEXTS) {
      for (const token of STATUS_TOKENS) {
        if (!isMeasuredStep(paletteBlock, DEFAULT_PALETTE_ID, ctx, token)) continue;
        checked += 1;
        if (ctx.palette === DEFAULT_PALETTE_ID) baseChecked += 1;
        const hue = hueOf(ctx, token);
        for (const backdrop of BACKDROPS) {
          const ratio = contrast(hue, hueOf(ctx, backdrop));
          if (ratio < MIN_UI_CONTRAST) {
            failures.push(
              `${ctx.palette}/${ctx.theme} ${token} on ${backdrop} — ${ratio.toFixed(2)}:1`,
            );
          }
        }
      }
    }
    // Forward direction, with the ratios: anything failing that is not a named
    // carve-out. Reported per SURFACE so the message says which one gave way.
    const stepOf = (failure: string) => failure.slice(0, failure.indexOf(' on '));
    expect(failures.filter((failure) => !(stepOf(failure) in KNOWN_SUB_BAR))).toEqual([]);
    // Reverse direction: a carve-out that no longer describes anything. Without
    // this the map rots into a silent pass the moment a step is fixed.
    const failing = new Set(failures.map(stepOf));
    expect(
      Object.keys(KNOWN_SUB_BAR)
        .filter((step) => !failing.has(step))
        .sort(),
    ).toEqual([]);
    // Guards the guard, against a FIXED count rather than a ratio: the base
    // contributes its whole ramp in both themes, so a `isMeasuredStep` that
    // stopped admitting it would fail here rather than pass vacuously.
    expect(baseChecked).toBe(THEMES.length * STATUS_TOKENS.length);
    // And the override half is still swept — Graphite (1 token x 2 themes) +
    // MOTIR-2075's five.
    expect(checked - baseChecked).toBeGreaterThanOrEqual(14);
  });

  it('declares every status override in BOTH themes of its palette (the cascade trap)', () => {
    // `[data-palette='x']` and the base `[data-theme='dark']` TIE on specificity
    // (0,1,0), and the palette blocks come LATER in the sheet — so a status
    // override written only in a palette's light block silently LEAKS onto its
    // dark canvas, where it was never measured. Verified in the cascade model
    // and in Chromium (MOTIR-2075).
    //
    // The rule is therefore about PAIRING, not about the value: where a theme
    // needs no change, its block re-asserts the same `var(--color-*)` source
    // explicitly. That is why several blocks carry what looks like a no-op.
    const unpaired: string[] = [];
    for (const palette of PALETTE_IDS.filter((id) => id !== DEFAULT_PALETTE_ID)) {
      const [light, dark] = THEMES.map((theme) => paletteBlock(palette, theme));
      for (const token of STATUS_TOKENS) {
        const inLight = token in (light ?? {});
        const inDark = token in (dark ?? {});
        if (inLight !== inDark) {
          unpaired.push(`${palette} declares ${token} in ${inLight ? 'light' : 'dark'} only`);
        }
      }
    }
    expect(unpaired).toEqual([]);
  });

  it('re-skins the ramp away from the base in every other palette', () => {
    // Cheap cross-check that the resolution is really palette-sensitive — a
    // model that returned the base block for every context would pass all of
    // the above.
    for (const palette of PALETTE_IDS.filter((id) => id !== DEFAULT_PALETTE_ID)) {
      const differs = THEMES.some((theme) =>
        STATUS_TOKENS.some(
          (token) =>
            hueOf({ palette, theme }, token) !==
            hueOf({ palette: DEFAULT_PALETTE_ID, theme }, token),
        ),
      );
      expect(differs, `${palette} must re-skin the status ramp`).toBe(true);
    }
  });
});
