// MOTIR-2674 — measure the context row with the marks REMOVED.
//
// Not a re-typed harness: it loads the shipped design asset itself
// (design/shell/context-row.mock.html), whose frames carry the REAL component
// markup and whose <style> block is the build's own CSS. Each variant is a DOM
// mutation applied to that real markup, so a measurement can never drift from
// what the components actually render.
//
// Variants, per band:
//   today     — as the asset ships (org MARK + project chip)
//   no-marks  — OrgAvatar and the project chip removed, nothing else changed
//               (what MOTIR-2679 would produce with no design decision)
//   org-name  — no-marks PLUS the org name revealed from md (the candidate that
//               gives the org tier something to render in the md–xl band)
//
// Reports, for the left cluster: natural width (scrollWidth) and the row's
// overflow against the viewport. Run: node scripts/measure-context-row.mjs
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const asset = path.join(root, 'design/shell/context-row.mock.html');

const VARIANTS = {
  today: () => {},
  'no-marks': () => {
    // OrgAvatar: the 20px `--el-tint-lavender` initial tile inside OrgControl.
    document.querySelectorAll('span.bg-\\(--el-tint-lavender\\)').forEach((el) => el.remove());
    // ProjectAvatar: the preset chip and its mono fallback.
    document
      .querySelectorAll('[class*="bg-(--el-avatar-"], span.bg-\\(--el-avatar-fallback\\)')
      .forEach((el) => el.remove());
  },
  'org-name': () => {
    document.querySelectorAll('span.bg-\\(--el-tint-lavender\\)').forEach((el) => el.remove());
    document
      .querySelectorAll('[class*="bg-(--el-avatar-"], span.bg-\\(--el-avatar-fallback\\)')
      .forEach((el) => el.remove());
    // Reveal the org NAME from md: the name span is `hidden xl:inline`.
    document.querySelectorAll('span.hidden.xl\\:inline').forEach((el) => {
      el.classList.remove('hidden', 'xl:inline');
    });
  },
};

const browser = await chromium.launch({
  args: ['--disable-dev-shm-usage', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`file://${asset}`);

const rows = [];
for (const [name, mutate] of Object.entries(VARIANTS)) {
  await page.reload();
  await page.evaluate(mutate);
  const measured = await page.evaluate(() => {
    const out = [];
    for (const device of document.querySelectorAll('.device[data-vw]')) {
      const vw = Number(device.dataset.vw);
      // Frames at the same width live in DIFFERENT panels (A is what ships
      // today, B is the target), so a measurement that merges them by width
      // alone compares the old bar with the new one. Carry the panel.
      const panel =
        device.closest('section.panel')?.querySelector('.panel-h')?.textContent?.trim() ?? '?';
      const caption = device.parentElement?.querySelector('figcaption')?.textContent?.trim() ?? '';
      const nav = device.querySelector('nav[aria-label="Global"]');
      if (!nav) continue;
      // The left cluster is the first flex child of the row.
      const left = nav.querySelector('div.flex.min-w-0');
      if (!left) continue;
      out.push({
        vw,
        panel: panel.split('·')[0].trim(),
        caption: caption.replace(/\s+/g, ' ').slice(0, 46),
        left: Math.round(left.scrollWidth),
        // Overflow of the ROW against the frame it must fit in.
        overflow: Math.round(nav.scrollWidth - device.clientWidth),
        // Is anything visible in the org tier other than a chevron?
        orgText: (nav.textContent || '').trim().slice(0, 40),
      });
    }
    return out;
  });
  for (const m of measured) rows.push({ variant: name, ...m });
}

// Collapse duplicate frames at the same width (the asset draws several panels).
const seen = new Map();
for (const r of rows) {
  const key = `${r.variant}@${r.panel}@${r.vw}@${r.caption}`;
  if (!seen.has(key)) seen.set(key, r);
}

console.log('panel     variant       vw   left-cluster  row-overflow  frame');
for (const r of [...seen.values()].sort(
  (a, b) => a.panel.localeCompare(b.panel) || a.vw - b.vw || a.variant.localeCompare(b.variant),
)) {
  console.log(
    `${r.panel.padEnd(9)} ${r.variant.padEnd(12)} ${String(r.vw).padStart(4)} ${String(r.left).padStart(9)}px ${String(r.overflow).padStart(10)}px  ${r.caption}`,
  );
}

await browser.close();
