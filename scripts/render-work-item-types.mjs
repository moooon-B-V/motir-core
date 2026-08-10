// Render the two work-item TYPE design assets to their PNG exports, and MEASURE
// the type picker against the ceiling the shipped Combobox actually imposes.
//
// The measurement is the point (MOTIR-2631). The card asks "does the picker
// still fit at the admitted count?", and the honest answer needs a number from
// the rendered DOM rather than an adjective: the row height, the group-header
// height, the resulting list height, and the 256px cap that
// `components/ui/Combobox.tsx` applies in BOTH hosts —
// `max-h-64 overflow-y-auto` on the listbox, and
// `Math.max(80, Math.min(256, avail - 12))` on the in-dialog branch.
//
// What it reports is what panel 5c states, so the asset and the notes cannot
// drift from each other: whoever changes the mock re-runs this and the numbers
// move together.
//
// Convention (motir-core CLAUDE.md § design assets): chromium, full-page, light
// theme, deviceScaleFactor 2, viewport width 1200.
import { chromium } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

// Every asset the fourteen-member set is DRAWN in. The first two own the
// surface; the last two enumerate the same vocabulary in their filter facet and
// would have gone stale silently — the disposition table in
// `design/work-items/design-notes.md` records why these four and not the other
// eighteen files a `--el-type-*` grep finds.
const ASSETS = [
  [
    'design/work-items/type-executor-picker.mock.html',
    'design/work-items/type-executor-picker.png',
  ],
  ['design/work-items/work-type-indicator.mock.html', 'design/work-items/work-type-indicator.png'],
  ['design/backlog/backlog-filter.mock.html', 'design/backlog/backlog-filter.png'],
  ['design/boards/board-filter.mock.html', 'design/boards/board-filter.png'],
];

// The shipped cap, from components/ui/Combobox.tsx. Not measured from the mock
// — READ from the component, so the mock is checked against the code and not
// against itself.
const SHIPPED_MENU_CAP = 256;

const browser = await chromium.launch();

for (const [mock, out] of ASSETS) {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  await page.goto(pathToFileURL(resolve(mock)).href, { waitUntil: 'load' });
  await page.emulateMedia({ colorScheme: 'light' });

  // ── MEASURE, before the screenshot resizes anything ──────────────────────
  const m = await page.evaluate(() => {
    const unrolled = document.querySelector('.cbx-menu.is-unrolled');
    if (!unrolled) return null;
    const rows = [...unrolled.querySelectorAll('.cbx-opt')];
    const heads = [...unrolled.querySelectorAll('.cbx-group')];
    const h = (el) => Math.round(el.getBoundingClientRect().height);
    const capped = document.querySelector('.cbx-menu:not(.is-unrolled)');
    return {
      optionCount: rows.length,
      optionHeight: rows.length ? h(rows[0]) : 0,
      groupCount: heads.length,
      groupHeight: heads.length ? h(heads[0]) : 0,
      listHeight: h(unrolled),
      cappedRendered: capped ? h(capped) : null,
    };
  });

  if (m) {
    const content = m.listHeight;
    const visible = Math.floor((SHIPPED_MENU_CAP - 8) / m.optionHeight);
    console.log(`── ${mock} ──`);
    console.log(`  options              ${m.optionCount}`);
    console.log(`  option row           ${m.optionHeight}px`);
    console.log(`  group headers        ${m.groupCount} × ${m.groupHeight}px`);
    console.log(`  list content         ${content}px`);
    console.log(`  shipped menu cap     ${SHIPPED_MENU_CAP}px  (Combobox max-h-64 / min(256, …))`);
    console.log(`  capped box, rendered ${m.cappedRendered}px`);
    console.log(
      `  VERDICT              ${content > SHIPPED_MENU_CAP ? 'SCROLLS' : 'FITS'} — ~${visible} of ${m.optionCount} rows visible, ` +
        `${Math.round((1 - (SHIPPED_MENU_CAP - 8) / content) * 100)}% below the fold`,
    );
  }

  await page.screenshot({ path: resolve(out), fullPage: true });
  console.log(`  wrote ${out}\n`);
  await page.close();
}

await browser.close();
