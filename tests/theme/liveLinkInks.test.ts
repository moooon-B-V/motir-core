import { describe, expect, it } from 'vitest';
import { PALETTE_IDS } from '@/lib/theme/palettes';
import { flattenColorMix, contrast } from './colorMetrics';
import { declaredIn, loadTokenLayer, resolveValue, type ThemeContext } from './paletteCascade';

// motir.co's live link ("Motir builds itself" in the header) walks the wave
// hues in its words as well as its square. The words are TEXT, so every hue
// they pass through must clear AA (4.5:1 — 17px medium is not large text) on
// both grounds the header sits over: the page, and the hero's surface. The raw
// wave hues do not (teal and the warm accent reach 2.4:1 in light palettes),
// which is why `--el-live-text-*` exist apart from `--el-live-mark-*`.

const THEMES = ['light', 'dark'] as const;
const GROUNDS = ['--el-page-bg', '--el-surface'] as const;
const { rules } = loadTokenLayer();

function resolved(token: string, ctx: ThemeContext): string {
  const declarations = declaredIn(rules, ctx);
  return flattenColorMix(resolveValue(declarations[token] ?? '', declarations).value);
}

describe('the live link reads as text in every palette and theme', () => {
  for (const palette of PALETTE_IDS) {
    for (const theme of THEMES) {
      it(`${palette}/${theme}: --el-live-text-1..3 clear 4.5:1 on the page and the surface`, () => {
        const ctx = { palette, theme };
        for (const n of [1, 2, 3]) {
          for (const ground of GROUNDS) {
            const ratio = contrast(resolved(`--el-live-text-${n}`, ctx), resolved(ground, ctx));
            expect(ratio, `--el-live-text-${n} on ${ground}`).toBeGreaterThanOrEqual(4.5);
          }
        }
      });
    }
  }

  it('the marks are the wave hues, unmixed', () => {
    for (const palette of PALETTE_IDS) {
      for (const theme of THEMES) {
        for (const n of [1, 2, 3]) {
          expect(resolved(`--el-live-mark-${n}`, { palette, theme })).toBe(
            resolved(`--el-showcase-wave-${n}`, { palette, theme }),
          );
        }
      }
    }
  });
});
