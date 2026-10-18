// E2E: the DENSITY STEPS re-resolve inside a NESTED `[data-style]` scope
// (MOTIR-8901 — the proof MOTIR-2336's decision requires of a browser).
//
// The steps (`--spacing-control-x-8`, `--height-control-40`, …) are declared by
// ONE rule on `:root, [data-style]` in packages/design-system/theme.css, each as
// `round(nearest, calc(var(<base>) * N / ref), 1px)`. A custom property is
// substituted where it is DECLARED, so a rule on `:root` alone would resolve the
// base once and hand a frozen length to a nested scope that overrides the base.
// `tests/theme/densityScale.test.ts` pins the declaration; only a browser can show
// the computed length, which is the thing that matters.
//
// ⚠️ MEASURE THROUGH A REAL PROPERTY. An unregistered custom property's computed
// value is the UNRESOLVED token string, never a length, so each probe puts the
// step on `padding-left` / `height` and the spec reads `getComputedStyle`.
//
// The bases come from the stylesheet (warm-editorial: control-x 10px,
// height-control 36px; soft-playful: control-x 14px, height-control 40px), so the
// expected values are the decision's own arithmetic, not a snapshot:
//   warm-editorial  control-x-8  = round(10 * 8 / 10)  = 8px    control-40 = round(36 * 40 / 36) = 40px
//   soft-playful    control-x-8  = round(14 * 8 / 10)  = 11px   control-40 = round(40 * 40 / 36) = 44px

import { expect, test, type Page } from '@playwright/test';

interface Measured {
  paddingLeft: string;
  height: string;
}

/**
 * Append a probe under `<html data-style="warm-editorial">` and a second one
 * inside a nested `div[data-style="soft-playful"]`, then read both computed
 * boxes. `scope` is read back as `nested: null` when the nested probe is skipped,
 * so the same helper reads the outer probe on its own.
 */
async function measure(page: Page, withNested: boolean) {
  return page.evaluate((nested) => {
    const probe = (parent: HTMLElement): HTMLElement => {
      const el = document.createElement('div');
      el.style.paddingLeft = 'var(--spacing-control-x-8)';
      el.style.height = 'var(--height-control-40)';
      parent.appendChild(el);
      return el;
    };
    const read = (el: HTMLElement): Measured => {
      const cs = getComputedStyle(el);
      return { paddingLeft: cs.paddingLeft, height: cs.height };
    };
    const harness = document.createElement('div');
    harness.setAttribute('data-density-probe', '');
    document.body.appendChild(harness);
    const outer = probe(harness);
    const before = read(outer);
    let inner: Measured | null = null;
    if (nested) {
      const scope = document.createElement('div');
      scope.setAttribute('data-style', 'soft-playful');
      harness.appendChild(scope);
      inner = read(probe(scope));
    }
    return { before, after: read(outer), inner };
  }, withNested);
}

test.describe('the density steps re-resolve from the nearest [data-style] scope', () => {
  test('a nested soft-playful scope under a warm-editorial root resolves its OWN bases', async ({
    page,
  }) => {
    await page.goto('/tokens');
    await expect(page.locator('html')).toHaveAttribute('data-style', 'warm-editorial');

    const { before, after, inner } = await measure(page, true);

    // The root scope: every step is exactly its named pixel value.
    expect(before).toEqual({ paddingLeft: '8px', height: '40px' });
    // The nested scope overrides the bases (14px / 40px), so the SAME token names
    // resolve to round(14 * 8 / 10) = 11px and round(40 * 40 / 36) = 44px.
    expect(inner).toEqual({ paddingLeft: '11px', height: '44px' });
    // Adding the nested scope did not touch the outer probe.
    expect(after).toEqual(before);
  });

  test('without a nested scope the same probe stays on the root values', async ({ page }) => {
    await page.goto('/tokens');
    await expect(page.locator('html')).toHaveAttribute('data-style', 'warm-editorial');

    const { before, after, inner } = await measure(page, false);

    expect(inner).toBeNull();
    expect(before).toEqual({ paddingLeft: '8px', height: '40px' });
    expect(after).toEqual(before);
  });
});
