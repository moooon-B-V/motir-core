import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { expect, test } from '@playwright/test';

// STORY E2E — a `renderMock` document opens OFFLINE, styled, and recoloured by
// palette (Story MOTIR-6960 · MOTIR-6967, the story's Verification step 2).
//
// The unit and seam suites prove what the string holds. Only a browser proves
// what a person opening the file sees: that the one inlined `<style>` actually
// applies with NO network at all, and that a different palette id produces a
// different colour on the same part — not merely a different block in the
// source.
//
// No app route and no seeding: the documents are rendered here, in the runner,
// from the BUILT package through its published `./mock` subpath, and opened from
// `file://`. No acceptance video — the story has no surface in Motir's own UI.

const PALETTES = ['motir', 'cobalt'] as const;

async function writeMock(paletteId: string, file: string): Promise<string> {
  const { renderMock } = await import('@motir/design-system/mock');
  const { Button, Card, Pill } = await import('@motir/design-system');
  const html = await renderMock({
    title: `Save bar — ${paletteId}`,
    axes: { styleId: 'warm-editorial', paletteId, typeId: 'motir' },
    panels: [
      {
        label: 'Unsaved changes',
        element: createElement(
          Card,
          // CardProps does not declare data-* attributes; Card spreads `rest` onto its div.
          { 'data-testid': 'mock-card' } as never,
          createElement(Pill, { status: 'in-progress' }, 'Unsaved'),
          createElement(Button, { variant: 'primary' }, 'Save'),
        ),
      },
    ],
  });
  writeFileSync(file, html, 'utf8');
  return pathToFileURL(file).href;
}

/** The computed styles a person sees, read from the loaded, offline document. */
async function open(page: import('@playwright/test').Page, url: string) {
  const attempted: string[] = [];
  page.on('request', (request) => attempted.push(request.url()));
  // EVERY request is refused except the document itself: a mock that needed a
  // stylesheet, a font or a script from anywhere would lose it here.
  await page.route('**/*', (route) =>
    route.request().url() === url ? route.continue() : route.abort(),
  );
  // `load` is the authoritative signal: every stylesheet the document has is
  // inline, so once it fires the cascade the browser computes is final.
  await page.goto(url, { waitUntil: 'load' });

  const button = page.getByRole('button', { name: 'Save' });
  await expect(button).toBeVisible();
  const background = await button.evaluate((el) => getComputedStyle(el).backgroundColor);
  const radius = await page
    .getByTestId('mock-card')
    .evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  return { attempted, background, radius };
}

test.describe('a renderMock document, opened offline in a real browser', () => {
  test('is styled with no network, and a second palette recolours the same part', async ({
    page,
    browser,
  }, testInfo) => {
    const results: Record<string, Awaited<ReturnType<typeof open>>> = {};
    for (const paletteId of PALETTES) {
      const url = await writeMock(paletteId, testInfo.outputPath(`${paletteId}.mock.html`));
      // A fresh page per document, so one palette's cascade cannot linger.
      const target = paletteId === PALETTES[0] ? page : await browser.newPage();
      results[paletteId] = await open(target, url);

      // Nothing but the file itself was requested — no font, no stylesheet, no script.
      expect(results[paletteId]!.attempted).toEqual([url]);
      // The primary Button is actually painted…
      expect(results[paletteId]!.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(results[paletteId]!.background).toMatch(/^(rgb|oklch|color|lab)/);
      // …and the Card takes its radius from the style axis.
      expect(Number.parseFloat(results[paletteId]!.radius)).toBeGreaterThan(0);
    }

    expect(results.motir!.background).not.toBe(results.cobalt!.background);
  });
});
