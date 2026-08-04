import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE_ID, PALETTE_IDS } from '@/lib/theme/palettes';
import { DEFAULT_STATUSES } from '@/lib/workflows/defaultWorkflow';
import { statusElVar } from '@/lib/workflows/statusColor';
import { PRIORITY_OPTIONS } from '@/lib/issues/priority';
import { LABEL_TINTS } from '@/lib/labels/labelTint';
import { AVATAR_COLORS } from '@/lib/projects/avatar';
import { loadTokenLayer, declaredIn, resolveValue, type ThemeContext } from './paletteCascade';

// MOTIR-1278 · 1266.7 — the cross-cutting per-palette COVERAGE + SWAP-LAYER
// matrix for the element-token layer.
//
// The five sibling cards (1266.2–1266.6 / MOTIR-1273–1277) each pinned their own
// family's Tier-3 mapping — "`--el-status-blocked` is declared as
// `var(--color-warning)`". This suite deliberately does NOT re-list any of that
// (notes.html #118: a test card that re-lists coverage its siblings already
// shipped adds nothing). It asserts the property NONE of them could: that the
// mapping actually PAYS OFF once a palette is applied — every token resolves to
// a concrete colour in all 20 palette x theme contexts, every palette really
// re-skins it, and the hues that exist to differentiate still differ.
//
// ── Why the ACs read "set by every non-base palette block" but assert Tier-0 ──
// The card was written before 1266.2–1266.6 chose their mechanism. They did NOT
// re-declare each `--el-*` in each palette block; they mapped every new token to
// a Tier-0 `--color-*` and let the palette's existing `--color-*` override
// re-skin it — the gold-standard `--el-chart-*` / `--el-type-*` indirection,
// documented at theme.css's status-hue block ("no per-palette block needed").
// So "set by every non-base palette block" is discharged one layer down, and
// that is what this suite checks: the Tier-0 SOURCE each token rides is declared
// by every palette. Same contract, at the layer that actually implements it.

const { rules, baseBlock, elementTokens } = loadTokenLayer();

const NON_BASE_PALETTES = PALETTE_IDS.filter((id) => id !== DEFAULT_PALETTE_ID);
const THEMES = ['light', 'dark'] as const;
const CONTEXTS: ThemeContext[] = PALETTE_IDS.flatMap((palette) =>
  THEMES.map((theme) => ({ palette, theme })),
);

/** Every `--el-*` token resolved to a concrete value, for one context. */
function resolvedTokens(ctx: ThemeContext): Record<string, string> {
  const declarations = declaredIn(rules, ctx);
  const out: Record<string, string> = {};
  for (const token of elementTokens) {
    out[token] = resolveValue(declarations[token] ?? '', declarations).value.toLowerCase();
  }
  return out;
}

const RESOLVED = new Map<string, Record<string, string>>(
  CONTEXTS.map((ctx) => [`${ctx.palette}/${ctx.theme}`, resolvedTokens(ctx)]),
);
const at = (palette: string, theme: 'light' | 'dark') => RESOLVED.get(`${palette}/${theme}`)!;

// ── Known, DOCUMENTED exceptions ────────────────────────────────────────────
// Each is asserted EXACTLY (not as a floor), so a fixed exception turns this
// suite red until it is deleted here — a stale allowlist cannot rot into a
// silent pass, and a NEW gap cannot hide behind an old one.

/** `--el-*` tokens whose resolved value is identical under ALL ten palettes. */
const KNOWN_PALETTE_INVARIANT = [
  // INTENTIONAL: the modal/dialog scrim is plain black at two opacities — it
  // sits UNDER the dialog and carries no palette identity. theme.css documents
  // it as the lone concrete-value token, with a dark companion, not a hue.
  '--el-overlay-scrim',
];

/** Tier-0 sources an `--el-*` rides that NOT ONE non-base palette declares. */
const TIER0_SOURCES_NO_PALETTE_SETS: string[] = [];

describe('swap layer — every element token resolves to a concrete colour', () => {
  it('leaves no dangling var() in any palette x theme context', () => {
    const dangling: string[] = [];
    for (const ctx of CONTEXTS) {
      const declarations = declaredIn(rules, ctx);
      for (const token of elementTokens) {
        const declared = declarations[token];
        if (declared === undefined) {
          dangling.push(`${ctx.palette}/${ctx.theme} ${token} — not declared at all`);
          continue;
        }
        const { value, unresolved } = resolveValue(declared, declarations);
        if (unresolved.length) {
          dangling.push(`${ctx.palette}/${ctx.theme} ${token} → unresolved ${unresolved.join()}`);
        } else if (!value) {
          dangling.push(`${ctx.palette}/${ctx.theme} ${token} → empty`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  it('covers the whole matrix it claims to (all ten palettes, both themes)', () => {
    // Guards the guard: a resolver that silently matched nothing would make
    // every assertion above vacuously true.
    expect(CONTEXTS).toHaveLength(PALETTE_IDS.length * 2);
    expect(elementTokens.length).toBeGreaterThan(150);
    expect(elementTokens).toContain('--el-status-blocked'); // 1266.2
    expect(elementTokens).toContain('--el-label-1'); // 1266.3
    expect(elementTokens).toContain('--el-icon-muted'); // 1266.4
    expect(elementTokens).toContain('--el-selection-bg'); // 1266.5
    expect(elementTokens).toContain('--el-diff-added'); // 1266.6
  });
});

describe('palette coverage — every element token is actually re-skinned', () => {
  it('declares every Tier-0 source an element token rides in EVERY non-base palette block', () => {
    // The mechanism the family cards chose: a palette re-skins `--el-x` by
    // overriding the `--color-y` it references. A source no palette declares is
    // a token no palette can reach.
    const sources = new Set<string>();
    for (const token of elementTokens) {
      const match = baseBlock[token]?.match(/var\(\s*(--color-[\w-]+)/);
      if (match) sources.add(match[1]!);
    }
    expect(sources.size).toBeGreaterThan(30);

    const unreachable = [...sources].sort().filter((source) =>
      NON_BASE_PALETTES.every((palette) => {
        const block = rules.find((rule) =>
          rule.selectors.some((s) => s.trim() === `[data-palette='${palette}']`),
        );
        return !(source in (block?.declarations ?? {}));
      }),
    );
    expect(unreachable).toEqual(TIER0_SOURCES_NO_PALETTE_SETS);
  });

  it('gives every element token a palette-dependent value, bar the documented exceptions', () => {
    const invariant = elementTokens.filter((token) =>
      PALETTE_IDS.every((palette) =>
        THEMES.every((theme) => at(palette, theme)[token] === at(DEFAULT_PALETTE_ID, theme)[token]),
      ),
    );
    expect(invariant.sort()).toEqual([...KNOWN_PALETTE_INVARIANT].sort());
  });

  it('keeps each palette dark block in parity with its light block', () => {
    // A Tier-0 var a palette re-skins for light but forgets in dark keeps its
    // LIGHT value on the dark canvas (the palette block outranks the base
    // `[data-theme='dark']` block — same specificity, later in the sheet). That
    // is how a pale tint leaks into dark mode.
    const gaps: string[] = [];
    for (const palette of NON_BASE_PALETTES) {
      const light = rules.find((r) =>
        r.selectors.some((s) => s.trim() === `[data-palette='${palette}']`),
      );
      const dark = rules.find((r) =>
        r.selectors.some((s) => s.trim() === `[data-palette='${palette}'][data-theme='dark']`),
      );
      expect(light, `${palette} must ship a light block`).toBeDefined();
      expect(dark, `${palette} must ship a dark companion`).toBeDefined();
      for (const name of Object.keys(light!.declarations)) {
        if (!(name in dark!.declarations)) gaps.push(`${palette}: ${name}`);
      }
    }
    expect(gaps).toEqual([]);
  });
});

// ── MOTIR-2072: the recessed board must still READ as recessed ──────────────
//
// Declaring `--color-canvas` in every palette block is only half the fix. The
// board is what raised cards SIT ON — `--el-card` is `var(--color-background)`
// — so a palette that re-tints the canvas to something at or above the page
// inverts the recess and the cards lose their edge. The base ramp puts the
// canvas below BOTH the page and the section surface, in light and in dark
// (motir light `#ecebe7` < `#f6f5f4` < `#ffffff`; dark `#0e0e0e` < `#0f0f0f` <
// `#1a1a1a`), and that ordering is the property every palette has to preserve.

/** WCAG relative luminance of a `#rrggbb` value. */
function luminance(hex: string): number {
  const rgb = /^#([0-9a-f]{6})$/.exec(hex.trim().toLowerCase());
  if (!rgb) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const channels = [0, 2, 4].map((offset) => {
    const value = parseInt(rgb[1]!.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

describe('recessed canvas — the planning board reads as a recess in every palette', () => {
  it('keeps the canvas strictly below the page and the section surface', () => {
    const inverted: string[] = [];
    for (const palette of PALETTE_IDS) {
      for (const theme of THEMES) {
        const resolved = at(palette, theme);
        const canvas = resolved['--el-canvas']!;
        for (const above of ['--el-page-bg', '--el-surface'] as const) {
          if (luminance(canvas) >= luminance(resolved[above]!)) {
            inverted.push(`${palette}/${theme}: ${canvas} not below ${above} ${resolved[above]}`);
          }
        }
      }
    }
    expect(inverted).toEqual([]);
  });

  it("tunes the canvas to each palette's own ramp, never re-using the Motir grey", () => {
    // The defect 2072 fixed: every palette painted its canvas in Motir's warm
    // house grey because no block overrode the Tier-0 source. Asserted per
    // palette AND per theme — the invariant check above only needs ONE context
    // to differ, which a light-only override would satisfy while dark still
    // leaked the base value.
    const reused: string[] = [];
    for (const palette of NON_BASE_PALETTES) {
      for (const theme of THEMES) {
        if (at(palette, theme)['--el-canvas'] === at(DEFAULT_PALETTE_ID, theme)['--el-canvas']) {
          reused.push(`${palette}/${theme}`);
        }
      }
    }
    expect(reused).toEqual([]);
  });
});

// ── The MOTIR-1266 regression: hues that exist to DIFFER must still differ ───
//
// Each family is enumerated from the shipped source of truth — the workflow's
// own status list through `statusElVar`, the priority option list, the label
// tint ramp, the avatar colour keys — never from a list hand-copied here, so a
// registry that grows drags its new member into this check automatically
// (auto-memory: write the assertion as a derivation, not a frozen count).

const STATUS_TOKENS = DEFAULT_STATUSES.map((status) => statusElVar(status));
const PRIORITY_TOKENS = PRIORITY_OPTIONS.map((option) => `--el-priority-${option.value}`);
const LABEL_TOKENS = LABEL_TINTS.map((_tint, index) => `--el-label-${index + 1}`);
const AVATAR_TOKENS = AVATAR_COLORS.map((colour) => `--el-avatar-${colour}`);
const SELECTION_TOKENS = ['--el-selection-bg', '--el-droptarget-bg'];

const FAMILIES: Record<string, string[]> = {
  status: STATUS_TOKENS,
  priority: PRIORITY_TOKENS,
  label: LABEL_TOKENS,
  avatar: AVATAR_TOKENS,
  selection: SELECTION_TOKENS,
};

/**
 * Families whose members collapse onto one hue under a given palette.
 *
 * EMPTY, and that is the contract: the last entry (Graphite's status family)
 * was fixed by MOTIR-2073, which gave the status ramp its own second step of
 * the accent instead of letting `--color-info` = `--color-primary` re-collapse
 * `in_review` onto `in_progress`. The assertion below is an exact `toEqual`, so
 * this cannot rot back into a floor — a new collision fails here rather than
 * hiding behind an old exception.
 */
const KNOWN_FAMILY_COLLISIONS: Record<string, string[]> = {};

describe('rendered specimen — the differentiating hues still differentiate', () => {
  it('binds each family to the component that actually renders it', () => {
    // Without this, the suite could pass while asserting tokens nothing paints.
    const pill = readFileSync(
      join(process.cwd(), 'packages/design-system/src/components/ui/Pill.tsx'),
      'utf8',
    );
    for (const token of PRIORITY_TOKENS) expect(pill).toContain(token);

    const picker = readFileSync(
      join(process.cwd(), 'packages/design-system/src/components/ui/MultiSelectPicker.tsx'),
      'utf8',
    );
    for (const token of LABEL_TOKENS) expect(picker).toContain(token);

    const projectAvatar = readFileSync(
      join(process.cwd(), 'app/(authed)/_components/ProjectAvatar.tsx'),
      'utf8',
    );
    for (const token of AVATAR_TOKENS) expect(projectAvatar).toContain(token);

    // `statusElVar` IS the shipped helper StatusPicker calls, so STATUS_TOKENS
    // is what the dot paints by construction — assert it covers every status.
    expect(new Set(STATUS_TOKENS).size).toBe(DEFAULT_STATUSES.length);

    const backlogRow = readFileSync(
      join(process.cwd(), 'app/(authed)/backlog/_components/BacklogRow.tsx'),
      'utf8',
    );
    expect(backlogRow).toContain('--el-selection-bg');
  });

  it('keeps every member of a family distinct WITHIN each palette', () => {
    const collisions: Record<string, string[]> = {};
    for (const palette of PALETTE_IDS) {
      for (const theme of THEMES) {
        const resolved = at(palette, theme);
        for (const [family, tokens] of Object.entries(FAMILIES)) {
          const values = tokens.map((token) => resolved[token]);
          if (new Set(values).size !== values.length) {
            (collisions[palette] ??= []).push(family);
          }
        }
      }
    }
    // De-duplicate light/dark hits so the shape matches the known-collision map.
    for (const palette of Object.keys(collisions)) {
      collisions[palette] = [...new Set(collisions[palette]!)].sort();
    }
    expect(collisions).toEqual(KNOWN_FAMILY_COLLISIONS);
  });

  it('renders every family differently under every non-base palette (the 1266 regression)', () => {
    // The complaint that opened MOTIR-1266: a palette swap left status /
    // priority / label / avatar / selection looking identical. Each family must
    // therefore differ from the Motir base in EVERY other palette — well past
    // the card's "across >= 2 palettes" floor, which 10 palettes make trivial.
    const unchanged: string[] = [];
    for (const palette of NON_BASE_PALETTES) {
      for (const [family, tokens] of Object.entries(FAMILIES)) {
        const differs = THEMES.some((theme) =>
          tokens.some(
            (token) => at(palette, theme)[token] !== at(DEFAULT_PALETTE_ID, theme)[token],
          ),
        );
        if (!differs) unchanged.push(`${palette}/${family}`);
      }
    }
    expect(unchanged).toEqual([]);
  });
});
