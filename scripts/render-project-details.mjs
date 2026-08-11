// Render `design/projects/details.mock.html` to its PNG export.
// Convention (motir-core CLAUDE.md § design assets): chromium, full-page, light
// theme, deviceScaleFactor 2, viewport width 1200.
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const MOCK = resolve('design/projects/details.mock.html');
const OUT = resolve('design/projects/details.png');

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--no-sandbox'] });
const page = await browser.newPage({
  viewport: { width: 1200, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
});
await page.goto(pathToFileURL(MOCK).href, { waitUntil: 'load' });
await page.emulateMedia({ colorScheme: 'light' });

// Guard the decision this asset draws: nothing may render a project mark for a
// project that has none. A broken <img> (a src that resolves to nothing) would
// be exactly that — a reserved box with a failed image in it.
const broken = await page.evaluate(
  () => [...document.querySelectorAll('.pimg img')].filter((i) => !i.getAttribute('src')).length,
);
console.log(
  broken ? `⚠️  ${broken} mark box(es) with no src` : 'every mark box carries an image ✓',
);

await page.screenshot({ path: OUT, fullPage: true });
console.log(`wrote ${OUT}`);
await browser.close();
