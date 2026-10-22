import { describe, expect, it } from 'vitest';
import { PALETTE_IDS } from '@/lib/theme/palettes';
import { contrast, flattenColorMix, mixSrgb } from './colorMetrics';
import { declaredIn, loadTokenLayer, resolveValue, type ThemeContext } from './paletteCascade';

// The Motir mark AT WORK (MOTIR-9212 · MOTIR-9213) flows on the ink circle,
// `--el-accent`, in a gradient over `--el-mark-wave-1..3`. The mark is a graphic,
// so WCAG 1.4.11's 3:1 is the floor — and it must hold for everything the mark
// can paint, not only the three roles: every srgb blend between two neighbouring
// roles (the gradient), and every point of the start/stop ramp from a role toward
// the ink on the circle (`--el-accent-text`), in all twenty palette × theme pairs.

const THEMES = ['light', 'dark'] as const;
const FLOOR = 3;
const { rules } = loadTokenLayer();

/** Fold nested `color-mix(in srgb, …)` from the inside out, down to one hex. */
function flatten(value: string): string {
  let out = value;
  for (;;) {
    const next = out.replace(/color-mix\([^()]*\)/g, (inner) => flattenColorMix(inner));
    if (next === out) return out;
    out = next;
  }
}

function resolved(token: string, ctx: ThemeContext): string {
  const declarations = declaredIn(rules, ctx);
  return flatten(resolveValue(declarations[token] ?? '', declarations).value);
}

/** Percentages sampled across a blend: 0, 5, …, 100. */
const STEPS = Array.from({ length: 21 }, (_, i) => i * 5);

describe('the mark at work stays visible on its circle in every palette and theme', () => {
  for (const palette of PALETTE_IDS) {
    for (const theme of THEMES) {
      it(`${palette}/${theme}: every role, blend and ramp point clears 3:1 on --el-accent`, () => {
        const ctx = { palette, theme };
        const circle = resolved('--el-accent', ctx);
        const ink = resolved('--el-accent-text', ctx);
        const roles = [1, 2, 3].map((n) => resolved(`--el-mark-wave-${n}`, ctx));
        for (const [i, role] of roles.entries()) {
          expect(role, `--el-mark-wave-${i + 1}`).toMatch(/^#[0-9a-f]{6}$/i);
          const next = roles[(i + 1) % 3]!;
          for (const k of STEPS) {
            const blend = mixSrgb(next, k, role);
            expect(
              contrast(blend, circle),
              `${i + 1}→${((i + 1) % 3) + 1} at ${k}%`,
            ).toBeGreaterThanOrEqual(FLOOR);
            const ramp = mixSrgb(role, k, ink);
            expect(
              contrast(ramp, circle),
              `role ${i + 1} at ${k}% toward ink`,
            ).toBeGreaterThanOrEqual(FLOOR);
          }
        }
      });
    }
  }

  it('each role is its wave hue pulled toward the ink — 60% on Motir, 35% elsewhere', () => {
    for (const palette of PALETTE_IDS) {
      for (const theme of THEMES) {
        const ctx = { palette, theme };
        const share = palette === 'motir' ? 60 : 35;
        for (const n of [1, 2, 3]) {
          expect(resolved(`--el-mark-wave-${n}`, ctx), `${palette}/${theme} ${n}`).toBe(
            mixSrgb(
              resolved(`--el-showcase-wave-${n}`, ctx),
              share,
              resolved('--el-accent-text', ctx),
            ),
          );
        }
      }
    }
  });
});
