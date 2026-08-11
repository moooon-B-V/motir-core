// Render `design/shell/context-row.mock.html` to its PNG export.
//
// Convention (motir-core CLAUDE.md § design assets): chromium, full-page, light
// theme, deviceScaleFactor 2, viewport width 1200. Re-run after any edit to the
// mock — the PNG is the reviewer-facing face of the asset and the three files
// ship together.
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const MOCK = resolve('design/shell/context-row.mock.html');
const OUT = resolve('design/shell/context-row.png');

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--no-sandbox'] });
const page = await browser.newPage({
  viewport: { width: 1200, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
});
await page.goto(pathToFileURL(MOCK).href, { waitUntil: 'load' });
await page.emulateMedia({ colorScheme: 'light' });

// Guard the thing this pass is about: the ORG TIER must never be content-free.
// Narrow on purpose — an icon-only hamburger / theme toggle / brand link is a
// legitimate control with a MEANING-carrying glyph. The regression this asset
// exists to prevent is different: a tier whose only content was its mark, left
// holding a chevron once the mark is deleted. So look only at the tier controls
// (a menu button whose accessible name is the org/workspace/project menu) and
// require text or an image inside.
const ghosts = await page.evaluate(() => {
  const bad = [];
  for (const panel of document.querySelectorAll('section.panel')) {
    const heading = panel.querySelector('.panel-h')?.textContent?.trim().slice(0, 40) ?? '?';
    for (const btn of panel.querySelectorAll('button[aria-label]')) {
      const label = btn.getAttribute('aria-label') || '';
      const isTier = /organi|workspace|project/i.test(label) && !/create|new|report/i.test(label);
      if (!isTier) continue;
      const text = (btn.textContent || '').replace(/\s+/g, '');
      if (!text && !btn.querySelector('img')) {
        bad.push(`${heading} :: ${label}`);
      }
    }
  }
  return bad;
});
if (ghosts.length) {
  console.log(`⚠️  CONTENT-FREE TIER CONTROL:\n  ${ghosts.join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log('no content-free tier control ✓');
}

await page.screenshot({ path: OUT, fullPage: true });
console.log(`wrote ${OUT}`);
await browser.close();
