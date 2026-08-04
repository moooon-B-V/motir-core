import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE_ID, PALETTE_IDS } from '@/lib/theme/palettes';
import { DEFAULT_STATUSES } from '@/lib/workflows/defaultWorkflow';
import { statusElVar } from '@/lib/workflows/statusColor';
import { loadTokenLayer, resolveToken, type ThemeContext } from './paletteCascade';

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

const { rules } = loadTokenLayer();
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
 * Applied to the hue MOTIR-2073 introduces, under the palette it introduces it
 * in. It is deliberately NOT swept across the whole ramp: `--el-status-todo`
 * (`--color-stone`) and, in a few palettes, `--el-status-done` sit in the low
 * 2s by design — `stone` is the documented "faint labels (decorative, sub-AA)"
 * step, the dots are `aria-hidden` and always rendered beside the status LABEL,
 * and two of the three consumers ring them with `border-(--el-border)`. So they
 * are decoration, not a graphical object required to understand the content,
 * and re-tuning ten palettes' neutral step is not this card's business.
 */
const MIN_UI_CONTRAST = 3;

/**
 * Status pairs that resolve too close to tell apart, per palette x theme.
 *
 * Asserted EXACTLY, the house idiom from `paletteTokenCoverage.test.ts`: a
 * fixed entry turns this suite red until it is deleted, so a stale allowlist
 * cannot rot into a silent pass and a NEW collision cannot hide behind an old
 * one. Every entry below is MOTIR-2075 — the same defect class MOTIR-2073 fixed
 * in Graphite, found in five more palettes by this sweep (a bare `!==` never
 * saw them because the hexes differ). Remove them as 2075 lands.
 */
const KNOWN_TOO_CLOSE = [
  // in_progress `--color-info` #0d63b8 vs in_review `--color-primary` #3a57cf.
  'cobalt/light --el-status-in-progress vs --el-status-in-review — ΔE 8.4',
  // in_review `--color-primary` (emerald) vs done `--color-success` (grass) —
  // the palette's own comment says they should "read apart"; they do not.
  'evergreen/light --el-status-in-review vs --el-status-done — ΔE 5.5',
  'evergreen/dark --el-status-in-review vs --el-status-done — ΔE 4.7',
  // todo `--color-stone` vs cancelled `--color-steel` — the two-greys pair the
  // base keeps ~12 apart, compressed by these palettes' neutral ramps.
  'evergreen/dark --el-status-todo vs --el-status-cancelled — ΔE 8.3',
  'garnet/light --el-status-todo vs --el-status-cancelled — ΔE 8.8',
  'citrine/light --el-status-todo vs --el-status-cancelled — ΔE 10.0',
  // blocked `--color-warning` vs in_review `--color-primary` — both gold in
  // Citrine (#ffd850 vs #ffd02f in dark is a 3.0), flame-vs-amber in Sienna.
  'sienna/light --el-status-blocked vs --el-status-in-review — ΔE 7.1',
  'citrine/light --el-status-blocked vs --el-status-in-review — ΔE 9.7',
  'citrine/dark --el-status-blocked vs --el-status-in-review — ΔE 3.0',
];

// ── Colour maths (sRGB → CIELAB → CIEDE2000, and WCAG relative luminance) ────

function channels(hex: string): [number, number, number] {
  const value = hex.trim().replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;
  expect(full, `expected a 6-digit hex, got "${hex}"`).toMatch(/^[0-9a-f]{6}$/i);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => linear(c / 255)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** CIELAB under D65, the space CIEDE2000 is defined in. */
function lab(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map((c) => linear(c / 255)) as [number, number, number];
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** CIEDE2000 colour difference — the perceptual metric, not a naive RGB distance. */
function deltaE2000(hexA: string, hexB: string): number {
  const [l1, a1, b1] = lab(hexA);
  const [l2, a2, b2] = lab(hexB);
  const cBar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const [ap1, ap2] = [(1 + g) * a1, (1 + g) * a2];
  const [cp1, cp2] = [Math.hypot(ap1, b1), Math.hypot(ap2, b2)];
  const hp = (b: number, ap: number) =>
    (cp1 === 0 && cp2 === 0 ? 0 : (Math.atan2(b, ap) * 180) / Math.PI + 360) % 360;
  const [hp1, hp2] = [hp(b1, ap1), hp(b2, ap2)];

  const dLp = l2 - l1;
  const dCp = cp2 - cp1;
  let dhp = 0;
  if (cp1 * cp2 !== 0) {
    dhp = hp2 - hp1;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(cp1 * cp2) * Math.sin(rad(dhp) / 2);

  const lBar = (l1 + l2) / 2;
  const cpBar = (cp1 + cp2) / 2;
  let hBar = hp1 + hp2;
  if (cp1 * cp2 !== 0) {
    if (Math.abs(hp1 - hp2) <= 180) hBar = (hp1 + hp2) / 2;
    else hBar = hp1 + hp2 < 360 ? (hp1 + hp2 + 360) / 2 : (hp1 + hp2 - 360) / 2;
  }
  const t =
    1 -
    0.17 * Math.cos(rad(hBar - 30)) +
    0.24 * Math.cos(rad(2 * hBar)) +
    0.32 * Math.cos(rad(3 * hBar + 6)) -
    0.2 * Math.cos(rad(4 * hBar - 63));
  const sL = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sC = 1 + 0.045 * cpBar;
  const sH = 1 + 0.015 * cpBar * t;
  const rT =
    -2 *
    Math.sqrt(cpBar ** 7 / (cpBar ** 7 + 25 ** 7)) *
    Math.sin(rad(60 * Math.exp(-(((hBar - 275) / 25) ** 2))));

  return Math.sqrt(
    (dLp / sL) ** 2 + (dCp / sC) ** 2 + (dHp / sH) ** 2 + rT * (dCp / sC) * (dHp / sH),
  );
}

// ── The resolved status ramp, per palette x theme ───────────────────────────

function hueOf(ctx: ThemeContext, token: string): string {
  const { value, unresolved } = resolveToken(rules, ctx, token);
  expect(unresolved, `${ctx.palette}/${ctx.theme} ${token} must resolve`).toEqual([]);
  return value.toLowerCase();
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

  it(`keeps Graphite's review step past ${MIN_UI_CONTRAST}:1 on the surfaces the dot sits on`, () => {
    const failures: string[] = [];
    for (const theme of THEMES) {
      const ctx: ThemeContext = { palette: 'graphite', theme };
      const hue = hueOf(ctx, '--el-status-in-review');
      // `--el-card` is the row/card fill under most dots; `--el-surface` is the
      // sectioned backdrop the card sits in — the AC's named pairing.
      for (const backdrop of ['--el-card', '--el-surface'] as const) {
        const ratio = contrast(hue, hueOf(ctx, backdrop));
        if (ratio < MIN_UI_CONTRAST) {
          failures.push(`graphite/${theme} on ${backdrop} — ${ratio.toFixed(2)}:1`);
        }
      }
    }
    expect(failures).toEqual([]);
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
