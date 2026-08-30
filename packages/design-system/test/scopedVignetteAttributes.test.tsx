import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PALETTE_IDS } from '../src/theme/palettes';
import { TYPE_IDS } from '../src/theme/typography';
import { STYLE_IDS } from '../src/theme/styles';
import { StyleVignette } from '../src/components/theme/StyleVignette';

/*
 * MOTIR-3933 — the MARKUP half of "a scoped preview shows its own axis".
 *
 * `StyleVignette` set `data-style` / `data-palette` / `data-type` and not
 * `data-appearance-scope`, which is what re-emits the Tier-3 `--el-*` layer
 * onto the scoped element. Without it a nested `data-palette` overrode Tier-0
 * that nothing in the subtree read, and every tile in a ten-palette gallery
 * rendered the ACTIVE palette.
 *
 * ⚠️ THIS FILE ASSERTS THE ATTRIBUTE, WHICH IS NOT THE SAME AS ASSERTING THE
 * FIX. The attribute being present is necessary and nowhere near sufficient —
 * the defect was invisible to markup, because the axis attributes were all
 * present and correct while the render was still the ancestor's palette. What
 * proves the behaviour is the RESOLVED VALUE, over both registries and both
 * themes, and that lives in `tests/theme/scopedPreviewIsolation.test.ts` where
 * the cascade resolver is. This package's suite is deliberately pure — no
 * server, no DB, no browser (see `vitest.config.ts`) — so the half that needs a
 * cascade belongs in the lane that already has one, not behind a browser
 * install added to this job.
 */

describe('StyleVignette — SCOPED mode carries the token-layer scope attribute', () => {
  it('emits `data-appearance-scope` for every axis a caller can pin', () => {
    for (const [axis, markup] of [
      ['palette', renderToStaticMarkup(<StyleVignette palette={PALETTE_IDS[1]} />)],
      ['type', renderToStaticMarkup(<StyleVignette type={TYPE_IDS[1]} />)],
      ['style', renderToStaticMarkup(<StyleVignette styleId={STYLE_IDS[1]} />)],
    ] as const) {
      expect(markup, `${axis} scope`).toContain('data-appearance-scope');
    }
  });

  it('emits it once for a MULTI-axis scope, alongside each axis attribute', () => {
    const markup = renderToStaticMarkup(
      <StyleVignette palette={PALETTE_IDS[2]} type={TYPE_IDS[2]} styleId={STYLE_IDS[2]} />,
    );
    expect(markup.match(/data-appearance-scope/g)).toHaveLength(1);
    expect(markup).toContain(`data-palette="${PALETTE_IDS[2]}"`);
    expect(markup).toContain(`data-type="${TYPE_IDS[2]}"`);
    expect(markup).toContain(`data-style="${STYLE_IDS[2]}"`);
  });

  it('does NOT emit it in LIVE mode — the vignette must follow the global selection', () => {
    /*
     * LIVE mode (no axis prop) is what the appearance preview mounts: it is
     * meant to re-render as the user changes the global theme. Re-emitting the
     * token layer locally would pin the subtree to whatever resolved at mount —
     * the exact opposite of the thing it exists to show.
     */
    const markup = renderToStaticMarkup(<StyleVignette />);
    expect(markup).not.toContain('data-appearance-scope');
    expect(markup).not.toContain('data-palette');
    expect(markup).not.toContain('data-style=');
    expect(markup).not.toContain('data-type');
  });
});
