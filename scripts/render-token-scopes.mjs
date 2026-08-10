// Render `design/settings/token-scopes.mock.html` to its PNG export, and MEASURE
// the create-modal panel against the real `max-h-[90vh]` ceiling.
//
// The measurement is the point (MOTIR-2578): the composition decision this asset
// makes is a question about height, and an adjective is not an answer. It reports
// the panel's natural height and the ceiling at a set of real viewport heights,
// so the notes can carry the NUMBER.
//
// Convention (motir-core CLAUDE.md § design assets): chromium, full-page, light
// theme, deviceScaleFactor 2, viewport width 1200.
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const MOCK = resolve('design/settings/token-scopes.mock.html');
const OUT = resolve('design/settings/token-scopes.png');

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1200, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
});
await page.goto(pathToFileURL(MOCK).href, { waitUntil: 'load' });
await page.emulateMedia({ colorScheme: 'light' });

// ── MEASURE, before the screenshot resizes anything ────────────────────────
// Every `.modal` in the asset, by the panel it sits in: its natural (unclipped)
// height, so the notes can compare it to 90vh at each real viewport.
const measured = await page.evaluate(() => {
  const rows = [];
  for (const modal of document.querySelectorAll('.modal')) {
    const panel = modal.closest('.panel');
    const label = panel?.previousElementSibling?.textContent?.trim().slice(0, 60) ?? '(unlabelled)';
    rows.push({ label, height: Math.round(modal.getBoundingClientRect().height) });
  }
  return rows;
});

const VIEWPORTS = [
  ['13" laptop', 800],
  ['15" laptop', 900],
  ['1080p', 1080],
  ['short window', 720],
];
console.log('── modal heights (natural, unclipped) ──');
for (const row of measured) console.log(`  ${String(row.height).padStart(5)}px  ${row.label}`);
console.log('── 90vh ceiling ──');
for (const [name, h] of VIEWPORTS) {
  console.log(`  ${String(Math.round(h * 0.9)).padStart(5)}px  ${name} (${h}px tall)`);
}
const tallest = Math.max(...measured.map((r) => r.height));
console.log(`\nTALLEST MODAL: ${tallest}px`);
for (const [name, h] of VIEWPORTS) {
  const ceiling = Math.round(h * 0.9);
  console.log(`  ${name}: ${tallest <= ceiling ? 'FITS' : 'SCROLLS'} (${tallest} vs ${ceiling})`);
}

await page.screenshot({ path: OUT, fullPage: true });
console.log(`\nwrote ${OUT}`);
await browser.close();
