// E2E: the COLLAPSED rail does not spend the vertical room the expanded rail
// keeps, and draws no scrollbar inside its icon column (MOTIR-7872).
//
// ── The defect ──────────────────────────────────────────────────────────────
// Under 3D / Immersive the collapsed rail drew a vertical scrollbar at laptop
// heights where the expanded rail — and every other style — fit. Three things
// added up there: the footer STACKS Help over the collapse toggle once the rail
// is too narrow for both side by side (one 32px button + its gap taller than
// the expanded footer), 3D floats the rail 10px off the frame on all four sides,
// and 3D's 40px `--height-control` makes every row 4px taller. Measured on the
// card against the real `Sidebar` and the compiled stylesheet, at 1440×860 under
// `3d-immersive`: collapsed `scrollHeight` 693 against `clientHeight` 680 (a
// bar), expanded 693 against 716 (none).
//
// And a bar in the collapsed rail is worse than a bar in the expanded one: the
// collapsed content box keeps 3–4px of slack around one `--height-control`
// square, so even a `thin` bar clips the row squares.
//
// ── The fix this pins ───────────────────────────────────────────────────────
// 1. The collapsed frame trims its own vertical chrome (`py-2`, `gap-2`,
//    `mt-2`, a `gap-0.5` footer stack), winning most of the stacked footer's
//    cost back. Before: the collapsed scroller was 36px shorter than the
//    expanded one at the SAME viewport, in every style. After: 22px, and the
//    collapsed content itself is 8px shorter (the tighter section gaps).
// 2. The collapsed scroller paints NO bar (`scrollbar-width: none`). Whatever
//    overflow remains at a short viewport still scrolls (wheel, touch, focus);
//    the expanded rail keeps its `thin` palette bar.
//
// ── Two readings, and why both ──────────────────────────────────────────────
// The card's own: at 1440×860 under 3D the collapsed rail fits outright. That
// depends on how many rows the actor is offered (permissions, the
// Resume-onboarding door), so it is asserted only for the row count it was
// measured with. The CHROME reading does not: the scroller's `clientHeight` is
// the viewport minus the frame around it, so the gap between the two modes'
// client heights at one viewport is a property of the rail's frame alone,
// whatever rows it holds. (A comparison of the two modes' overflow EXCESS was
// tried first and is not used: the expanded rail's content is taller than the
// collapsed one's in the live shell, so that difference passed on the defect.)
//
// Teeth, observed: against `origin/main` this spec fails with the collapsed
// scroller at 693 / 679 — the card's reading, to the pixel.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';

const EMAIL = 'e2e-shell-collapsed-rail-fit@example.com';
const APPEARANCE_URL = '/settings/account/appearance';
const VIEWPORT = { width: 1440, height: 860 };

/** How much shorter the collapsed scroller may be than the expanded one (was 36px). */
const MAX_COLLAPSED_CHROME_PX = 24;

interface RailReading {
  collapsed: boolean;
  rows: number;
  scrollHeight: number;
  clientHeight: number;
  scrollbarWidth: string;
}

/** The rail's scroller, as the browser lays it out. */
async function readRail(page: Page): Promise<RailReading> {
  return page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('nav[data-surface="sidebar"]');
    if (!nav) throw new Error('no sidebar rail on this route');
    const scroller = Array.from(nav.querySelectorAll<HTMLElement>(':scope > div')).find(
      (el) => getComputedStyle(el).overflowY === 'auto',
    );
    if (!scroller) throw new Error('the rail has no vertical scroller');
    return {
      collapsed: nav.hasAttribute('data-collapsed'),
      rows: scroller.querySelectorAll('a[href], [aria-disabled="true"]').length,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      scrollbarWidth: getComputedStyle(scroller).scrollbarWidth,
    };
  });
}

async function chooseStyle(page: Page, option: string, value: string): Promise<void> {
  const patch = page.waitForResponse(
    (r) => r.url().includes('/api/appearance-preference') && r.request().method() === 'PATCH',
  );
  await page
    .getByRole('radiogroup', { name: 'Style', exact: true })
    .getByRole('radio', { name: option, exact: true })
    .click();
  expect((await patch).status()).toBe(200);
  await expect(page.locator('html')).toHaveAttribute('data-style', value);
}

async function setCollapsed(page: Page, collapsed: boolean): Promise<void> {
  const nav = page.locator('nav[data-surface="sidebar"]');
  const isCollapsed = (await nav.getAttribute('data-collapsed')) !== null;
  if (isCollapsed !== collapsed) {
    await page
      .getByRole('button', { name: collapsed ? 'Collapse sidebar' : 'Expand sidebar' })
      .click();
  }
  if (collapsed) await expect(nav).toHaveAttribute('data-collapsed', 'true');
  else await expect(nav).not.toHaveAttribute('data-collapsed');
}

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('the collapsed 3D / Immersive rail keeps the vertical room the expanded rail has (MOTIR-7872)', async ({
  page,
}) => {
  await page.setViewportSize(VIEWPORT);
  await signUp(page, EMAIL);
  await page.goto(APPEARANCE_URL);
  await expect(page.getByRole('radiogroup', { name: 'Style', exact: true })).toBeVisible();
  await chooseStyle(page, '3D / Immersive', '3d-immersive');

  // The project rail, where the card's row count lives.
  await page.goto('/items');
  await expect(page.locator('nav[data-surface="sidebar"]')).toBeVisible();

  await setCollapsed(page, false);
  const expanded = await readRail(page);
  await setCollapsed(page, true);
  const collapsed = await readRail(page);

  expect(collapsed.rows, 'both modes render the same rows').toBe(expanded.rows);

  // ── The CHROME the collapsed mode costs, independent of the row count.
  expect(
    expanded.clientHeight - collapsed.clientHeight,
    `collapsed scroller ${collapsed.clientHeight}px vs expanded ${expanded.clientHeight}px: ` +
      `the collapsed frame may take at most ${MAX_COLLAPSED_CHROME_PX}px more of the viewport ` +
      'than the expanded one (it took 36px)',
  ).toBeLessThanOrEqual(MAX_COLLAPSED_CHROME_PX);

  test.info().annotations.push({
    type: 'rail',
    description: `rows ${collapsed.rows}; collapsed ${collapsed.scrollHeight}/${collapsed.clientHeight}; expanded ${expanded.scrollHeight}/${expanded.clientHeight}`,
  });

  // ── The card's own reading, where the fixture offers the rows it was measured
  // with (15 primary + Settings): at 860px the collapsed rail fits outright.
  if (collapsed.rows <= 16) {
    expect(
      collapsed.scrollHeight,
      'at 1440×860 the collapsed 3D rail fits without scrolling',
    ).toBeLessThanOrEqual(collapsed.clientHeight);
  }

  // ── No bar inside the icon column; the expanded rail keeps its thin one.
  expect(collapsed.scrollbarWidth).toBe('none');
  expect(expanded.scrollbarWidth).toBe('thin');
});
