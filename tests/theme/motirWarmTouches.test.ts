import { describe, expect, it } from 'vitest';
import { PALETTE_IDS } from '@/lib/theme/palettes';
import { loadTokenLayer, resolveToken, type ThemeContext } from './paletteCascade';
import { contrast, deltaE2000, flattenColorMix } from './colorMetrics';

// MOTIR-7584 — the warm touches in the default `motir` palette (design MOTIR-7583,
// `design/design-system/design-notes.md` §8).
//
// Motir's decorative accent moved from the link blue to a warm orange, Design took
// the Citrine palette's own gold, and the peach / yellow washes warmed. The orange
// sits in a NARROW slot: in light it has the burnt-orange warning on one side and
// the amber priority-high step on the other, so this suite pins the pairs the
// design's matrix measured and no other suite covers — the new hues against their
// warm neighbours, the danger red and every surface they paint on — in both themes.
// It also pins the two halves of the change that are not about a hue at all: the
// identity roles that must NOT move, and the two new roles resolving, everywhere
// but motir, to exactly what their consumers painted before the roles existed.

const { rules } = loadTokenLayer();
const THEMES = ['light', 'dark'] as const;

const resolved = (ctx: ThemeContext, token: string): string => {
  const { value, unresolved } = resolveToken(rules, ctx, token);
  expect(unresolved, `${ctx.palette}/${ctx.theme} ${token}`).toEqual([]);
  return flattenColorMix(value).toLowerCase();
};
const motir = (theme: ThemeContext['theme']): ThemeContext => ({ palette: 'motir', theme });

/** The glyph floor every hue-separation suite uses (statusHueSeparation's MIN_DELTA_E). */
const MIN_DELTA_E = 10;
/** WCAG 1.4.11 — a hue that is a glyph's only carrier. */
const MIN_ICON_CONTRAST = 3;
/** WCAG 1.4.3 — ink on a wash. */
const MIN_TEXT_CONTRAST = 4.5;

const SURFACES = [
  '--el-page-bg',
  '--el-surface',
  '--el-surface-soft',
  '--el-muted',
  '--el-canvas',
  '--el-selection-bg',
];

/** The approved table (§8.1), verbatim — the values the code writes. */
const APPROVED = {
  light: {
    '--el-highlight': '#d66000',
    '--el-type-epic': '#d66000',
    '--el-epic-accent': '#d66000',
    '--el-chart-cat-6': '#d66000',
    '--el-progress-fill': '#d66000',
    '--el-type-design': '#746019',
    '--el-editor-focus': '#155bc4',
    '--el-tint-peach': '#fde0c8',
    '--el-tint-yellow': '#fdf0c6',
  },
  dark: {
    '--el-highlight': '#fa5500',
    '--el-type-epic': '#fa5500',
    '--el-epic-accent': '#fa5500',
    '--el-chart-cat-6': '#fa5500',
    '--el-progress-fill': '#fa5500',
    '--el-type-design': '#ffd02f',
    '--el-editor-focus': '#7db1ff',
    '--el-tint-peach': '#36230f',
    '--el-tint-yellow': '#302a12',
  },
} as const;

/** Identity roles that stay exactly as they were on `origin/main` (§8.1). */
const IDENTITY = {
  light: {
    '--el-accent': '#1a1d21',
    '--el-accent-text': '#ffffff',
    '--el-accent-on-surface': '#155bc4',
    '--el-link': '#155bc4',
    '--focus-ring-color': '#155bc4',
    '--el-info': '#155bc4',
    '--el-selection-bg': '#dde9f6',
    '--el-warning': '#c2410c',
    '--el-priority-high': '#ab6400',
    '--el-danger': '#c92a2a',
  },
  dark: {
    '--el-accent': '#edeef0',
    '--el-accent-text': '#0c0d0f',
    '--el-link': '#7db1ff',
    '--focus-ring-color': '#7db1ff',
    '--el-info': '#7db1ff',
    '--el-selection-bg': '#15233a',
    '--el-warning': '#f08a4b',
    '--el-priority-high': '#f08a4b',
    '--el-danger': '#d83847',
  },
} as const;

describe('motir writes the approved warm-touch table, in both themes', () => {
  for (const theme of THEMES) {
    for (const [token, hex] of Object.entries(APPROVED[theme])) {
      it(`${theme} ${token} = ${hex}`, () => {
        expect(resolved(motir(theme), token)).toBe(hex);
      });
    }
  }
});

describe('motir identity roles do not move', () => {
  for (const theme of THEMES) {
    for (const [token, hex] of Object.entries(IDENTITY[theme])) {
      it(`${theme} ${token} stays ${hex}`, () => {
        expect(resolved(motir(theme), token)).toBe(hex);
      });
    }
  }
});

describe('the warm orange clears its warm neighbours and every surface', () => {
  for (const theme of THEMES) {
    const ctx = motir(theme);
    it(`${theme}: ΔE2000 ≥ ${MIN_DELTA_E} from warning, priority-high and danger`, () => {
      const orange = resolved(ctx, '--el-highlight');
      for (const neighbour of ['--el-warning', '--el-priority-high', '--el-danger']) {
        const d = deltaE2000(orange, resolved(ctx, neighbour));
        expect(d, `${orange} vs ${neighbour}`).toBeGreaterThanOrEqual(MIN_DELTA_E);
      }
    });
    it(`${theme}: ≥ ${MIN_ICON_CONTRAST}:1 on every surface it paints on`, () => {
      const orange = resolved(ctx, '--el-highlight');
      for (const surface of SURFACES) {
        const c = contrast(orange, resolved(ctx, surface));
        expect(c, `${orange} on ${surface}`).toBeGreaterThanOrEqual(MIN_ICON_CONTRAST);
      }
    });
    // §8.9 — the roadmap's kind tile. The Epic glyph sits on --el-tint-rose; in
    // light it is the tightest figure in the design (3.01:1), so it is pinned
    // here, where a later tint change cannot push it under without a red test.
    it(`${theme}: the Epic glyph clears ${MIN_ICON_CONTRAST}:1 on its rose kind tile`, () => {
      const c = contrast(resolved(ctx, '--el-type-epic'), resolved(ctx, '--el-tint-rose'));
      expect(c).toBeGreaterThanOrEqual(MIN_ICON_CONTRAST);
    });
  }
});

describe('the citrine Design hue stands apart from every other glyph hue', () => {
  const GLYPH_PREFIXES = ['--el-status-', '--el-priority-', '--el-type-'];
  const NAMED = ['--el-warning', '--el-danger', '--el-success', '--el-info', '--el-highlight'];
  for (const theme of THEMES) {
    const ctx = motir(theme);
    it(`${theme}: ΔE2000 ≥ ${MIN_DELTA_E} from every status, priority and type hue`, () => {
      const citrine = resolved(ctx, '--el-type-design');
      const { elementTokens } = loadTokenLayer();
      const neighbours = [
        ...elementTokens.filter(
          (t) => GLYPH_PREFIXES.some((p) => t.startsWith(p)) && t !== '--el-type-design',
        ),
        ...NAMED,
      ];
      const tooClose = neighbours
        .map((t) => [t, resolved(ctx, t)] as const)
        .filter(([, hex]) => hex.startsWith('#'))
        .map(([t, hex]) => [t, deltaE2000(citrine, hex)] as const)
        .filter(([, d]) => d < MIN_DELTA_E);
      expect(tooClose).toEqual([]);
    });
    it(`${theme}: ≥ ${MIN_ICON_CONTRAST}:1 on every surface`, () => {
      const citrine = resolved(ctx, '--el-type-design');
      for (const surface of SURFACES) {
        const c = contrast(citrine, resolved(ctx, surface));
        expect(c, `${citrine} on ${surface}`).toBeGreaterThanOrEqual(MIN_ICON_CONTRAST);
      }
    });
  }
});

describe('the warmed washes keep their ink legible', () => {
  for (const theme of THEMES) {
    const ctx = motir(theme);
    for (const wash of ['--el-tint-peach', '--el-tint-yellow']) {
      it(`${theme}: --el-text-strong and --el-text-secondary clear AA on ${wash}`, () => {
        for (const ink of ['--el-text-strong', '--el-text-secondary']) {
          const c = contrast(resolved(ctx, ink), resolved(ctx, wash));
          expect(c, `${ink} on ${wash}`).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
        }
      });
    }
  }
});

describe('the two new roles change nothing outside motir', () => {
  // --el-progress-fill replaced --el-accent on the upload / import bars, and
  // --el-editor-focus replaced --el-highlight on the editor's focus border and
  // rings. Every other palette must paint exactly what it painted before.
  for (const palette of PALETTE_IDS.filter((id) => id !== 'motir')) {
    for (const theme of THEMES) {
      const ctx: ThemeContext = { palette, theme };
      it(`${palette}/${theme}: progress fill = --el-accent, editor focus = --el-highlight`, () => {
        expect(resolved(ctx, '--el-progress-fill')).toBe(resolved(ctx, '--el-accent'));
        expect(resolved(ctx, '--el-editor-focus')).toBe(resolved(ctx, '--el-highlight'));
      });
    }
  }
});
