// MOTIR-2674 — apply `docs/decisions/entity-marks.md` to the asset's TARGET panels.
//
// Panel G alone was not enough. Panels B, C and E draw the TARGET row and were
// left with the org mark and the project's PRESET chip still in them, so the
// asset described two different targets at once — which is worse than describing
// the old one, because a reader cannot tell which is current.
//
// Panel A is deliberately EXEMPT: it is captioned "what ships today" and is the
// historical record the finding is measured against. An asset that erases its
// own before-state cannot show what changed.
//
// Idempotent: re-running finds nothing left to strip.
// Run: node scripts/apply-entity-marks.mjs
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { resolve } from 'node:path';

const ASSET = resolve('design/shell/context-row.mock.html');
const TARGET_PANELS = ['Panel B', 'Panel C', 'Panel E'];

const browser = await chromium.launch({ args: ['--disable-dev-shm-usage', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(pathToFileURL(ASSET).href, { waitUntil: 'load' });

const result = await page.evaluate((names) => {
  const report = [];
  for (const panel of document.querySelectorAll('section.panel')) {
    const heading = panel.querySelector('.panel-h')?.textContent?.trim() ?? '';
    if (!names.some((n) => heading.startsWith(n))) continue;

    let orgMarks = 0;
    let presetChips = 0;
    let namesRevealed = 0;

    // 1. The ORG mark leaves — an organization carries no mark at all (§2).
    for (const el of panel.querySelectorAll('span.bg-\\(--el-tint-lavender\\)')) {
      el.remove();
      orgMarks++;
    }
    // 2. The org NAME is revealed from md, which is what replaces it in the
    //    md–xl band (the amended ladder).
    for (const el of panel.querySelectorAll('span.hidden.xl\\:inline')) {
      el.classList.remove('hidden', 'xl:inline');
      namesRevealed++;
    }
    // 3. The project's PRESET chip leaves. The default state of a project is
    //    "no image", and the preset registry is retired — so the target draws
    //    nothing here. Panel G carries the with-an-image variant.
    for (const el of panel.querySelectorAll(
      '[class*="bg-(--el-avatar-"], span.bg-\\(--el-avatar-fallback\\)',
    )) {
      el.remove();
      presetChips++;
    }
    report.push({ heading: heading.slice(0, 46), orgMarks, presetChips, namesRevealed });
  }

  // 4. Captions that describe the org as its MARK are now wrong.
  let captions = 0;
  for (const cap of document.querySelectorAll('figcaption')) {
    if (/the org returns as its MARK|the org as its MARK/i.test(cap.innerHTML)) {
      cap.innerHTML = cap.innerHTML
        .replace(/the org returns as its MARK/gi, 'the org returns as its NAME')
        .replace(/the org as its MARK/gi, 'the org as its NAME');
      captions++;
    }
  }
  return { report, captions, html: document.documentElement.outerHTML };
}, TARGET_PANELS);

await browser.close();

for (const r of result.report) {
  console.log(
    `${r.heading.padEnd(48)} org-marks -${r.orgMarks}  preset-chips -${r.presetChips}  names +${r.namesRevealed}`,
  );
}
console.log(`captions corrected: ${result.captions}`);

fs.writeFileSync(ASSET, `<!doctype html>\n${result.html}\n`);
console.log(`rewrote ${ASSET}`);
