import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PALETTE_IDS } from '@/lib/theme/palettes';
import { loadTokenLayer, resolveToken, type ThemeContext } from './paletteCascade';
import { contrast, flattenColorMix } from './colorMetrics';

// MOTIR-5711 — the Switch primitive's knob against its own track, measured over
// the whole palette x theme matrix.
//
// On a switch the KNOB'S POSITION IS THE STATE, so the knob has to be told apart
// from the track it sits on: WCAG 2.2 SC 1.4.11 (Non-text Contrast) asks 3:1 of
// the visual information needed to identify a component's state. The OFF knob
// shared `--el-switch-knob` (`--color-surface`) with the ON one and sat on
// `--el-muted`, which in the base palette is 1.01:1 in light and 1.00:1 in dark —
// the identical hex. Only a subtle shadow separated them. Measuring the ON half
// the same way found five more contexts under the bar (amber / citrine / candy /
// sienna light, garnet dark), where the palette's primary fill is light enough to
// swallow a surface-coloured knob.
//
// Same shape as `dangerFillInkContrast.test.ts`, and for the same reason: this is
// a property of the token LAYER used exactly as designed, invisible to any scan
// of the components, because `Switch.tsx` is correct — it paints the tokens it
// was told to.

const { rules } = loadTokenLayer();

const THEMES = ['light', 'dark'] as const;
const CONTEXTS: ThemeContext[] = PALETTE_IDS.flatMap((palette) =>
  THEMES.map((theme) => ({ palette, theme })),
);

/** WCAG AA for graphics and UI components — the state of a control. */
const AA_NON_TEXT = 3;

function resolved(ctx: ThemeContext, token: string): string {
  const { value, unresolved } = resolveToken(rules, ctx, token);
  expect(
    unresolved,
    `${token} must resolve to a concrete colour under palette=${ctx.palette} theme=${ctx.theme}`,
  ).toEqual([]);
  return flattenColorMix(value);
}

const label = (ctx: ThemeContext) => `${ctx.palette}/${ctx.theme}`;

/**
 * One state's knob-on-track pairing, measured as a TABLE: a per-context `expect`
 * reports the first failure and hides the rest, and what a reader needs when this
 * goes red is which palettes sit near the bar.
 */
function measure(knob: string, track: string) {
  const rows = CONTEXTS.map((ctx) => {
    const k = resolved(ctx, knob);
    const t = resolved(ctx, track);
    return { context: label(ctx), knob: k, track: t, ratio: contrast(k, t) };
  });
  const table = rows
    .map((r) => `  ${r.context.padEnd(18)} ${r.knob} on ${r.track} = ${r.ratio.toFixed(2)}:1`)
    .join('\n');
  return { under: rows.filter((r) => r.ratio < AA_NON_TEXT).map((r) => r.context), table };
}

/** The Switch source, where the tokens are bound to their states. */
const SWITCH_SRC = readFileSync(
  join(process.cwd(), 'packages/design-system/src/components/ui/Switch.tsx'),
  'utf8',
);

describe('the Switch knob is distinguishable from its track, in every palette and theme', () => {
  it('covers the whole matrix it claims to — every registered palette, both themes', () => {
    expect(PALETTE_IDS.length).toBeGreaterThanOrEqual(10);
    expect(CONTEXTS).toHaveLength(PALETTE_IDS.length * THEMES.length);
    expect(new Set(CONTEXTS.map(label)).size).toBe(CONTEXTS.length);
  });

  it('measures the pairs Switch.tsx actually paints', () => {
    // The ratios below are only about the component if these are the tokens it
    // binds to each state. A knob moved back onto one shared token, or a track
    // repainted, would leave this suite measuring a pairing nothing renders.
    expect(SWITCH_SRC).toContain("'border-(--el-switch-on) bg-(--el-switch-on)'");
    expect(SWITCH_SRC).toContain("'border-(--el-border-strong) bg-(--el-muted)'");
    expect(SWITCH_SRC).toContain("'translate-x-[18px] bg-(--el-switch-knob)'");
    expect(SWITCH_SRC).toContain("'translate-x-0.5 bg-(--el-switch-knob-off)'");
  });

  it('the OFF knob (`--el-switch-knob-off`) on the OFF track (`--el-muted`) clears 3:1', () => {
    const { under, table } = measure('--el-switch-knob-off', '--el-muted');
    expect(
      under,
      `An OFF switch's knob must clear ${AA_NON_TEXT}:1 against its track everywhere (WCAG 1.4.11).\n${table}\n`,
    ).toEqual([]);
  });

  it('the ON knob (`--el-switch-knob`) on the ON track (`--el-switch-on`) clears 3:1', () => {
    const { under, table } = measure('--el-switch-knob', '--el-switch-on');
    expect(
      under,
      `An ON switch's knob must clear ${AA_NON_TEXT}:1 against its track everywhere (WCAG 1.4.11).\n${table}\n`,
    ).toEqual([]);
  });
});
