// E2E: every label FITS its control in the longer-running languages (Story
// MOTIR-7730 · MOTIR-7759).
//
// German and Polish labels run 30–40% longer than English, Dutch, French,
// Spanish, Italian and Portuguese also run longer, and German and Dutch
// compounds cannot break at a space. The controls were sized for English, so a
// label that does not fit is clipped, spills out of a one-line box, breaks
// mid-word or slides under its neighbour — and stays VISIBLE throughout, which
// is why `assertLabelsFit` measures geometry rather than visibility.
//
// The walk is the shell plus the routes its primary navigation reaches, in
// `de pl nl fr es it pt` at 1280×800 (and `en` as the control), and in `de` and
// `pl` — the two longest — at 768×1024 too. The tenant is CROWDED (a work item
// per board column, an active sprint, a plan awaiting review, an unread
// notification), so labels that only render with content are on screen.
//
// The language is the account's SAVED language, which the request resolves
// first (MOTIR-7743); each locale is a write to that column and a reload. Every
// page is proven rendered by a role read before it is measured, and every menu
// is measured once its own `role="menu"` / `role="listbox"` is open — nothing
// waits on a timeout (CLAUDE.md, the authoritative-signal rule).

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { assertLabelsFit } from './_helpers/label-fit';
import { seedLabelFitTenant, type LabelFitSeed } from './_helpers/label-fit-seed';

const EMAIL = 'e2e-label-fit@example.com';

const RUNS: { locale: string; width: number; height: number }[] = [
  ...['en', 'de', 'pl', 'nl', 'fr', 'es', 'it', 'pt'].map((locale) => ({
    locale,
    width: 1280,
    height: 800,
  })),
  ...['de', 'pl'].map((locale) => ({ locale, width: 768, height: 1024 })),
];

const MENUS = '[aria-haspopup="menu"]';
const LISTBOXES = '[aria-haspopup="listbox"]';

/** The listed surfaces. `popups` selects the popup triggers whose open menu,
 *  listbox or popover is measured too: the shell's account, help and project
 *  menus once (on the first surface), a board card's actions menu, and the item
 *  page's menus and its pickers' option lists. */
function surfaces(seed: LabelFitSeed): { name: string; path: string; popups?: string }[] {
  return [
    {
      name: 'workbench',
      path: '/workbench',
      popups: `header ${MENUS}, aside ${MENUS}, aside ${LISTBOXES}, aside [aria-haspopup="dialog"]`,
    },
    { name: 'items', path: '/items' },
    { name: 'boards', path: '/boards', popups: `main ${MENUS}` },
    {
      name: 'item page',
      path: `/items/${seed.itemKey}`,
      popups: `main ${MENUS}, main ${LISTBOXES}`,
    },
    { name: 'backlog', path: '/backlog' },
    { name: 'sprints', path: '/sprints' },
    { name: 'plans', path: '/plans' },
    { name: 'plan detail', path: `/plans/${seed.planId}` },
    { name: 'approvals', path: '/approvals' },
    { name: 'account settings', path: '/settings/account' },
    { name: 'organization settings', path: '/settings/organization' },
    { name: 'project settings', path: '/settings/project' },
  ];
}

async function setAccountLanguage(email: string, locale: string): Promise<void> {
  await db.user.update({ where: { email }, data: { locale } });
}

/** Opens every popup trigger `selector` matches — a menu, a picker's listbox, the
 *  help popover — and measures the popup it controls. The popup is found by the
 *  trigger's own `aria-controls` once `aria-expanded` flips, so the wait is the
 *  trigger's authoritative state, never a timeout. */
async function openAndMeasurePopups(page: Page, selector: string, label: string) {
  const triggers = page.locator(selector);
  const count = await triggers.count();
  for (let i = 0; i < count; i += 1) {
    const trigger = triggers.nth(i);
    if (!(await trigger.isVisible()) || !(await trigger.isEnabled())) continue;
    const kind = (await trigger.getAttribute('aria-haspopup')) ?? 'menu';
    const name =
      (await trigger.getAttribute('aria-label')) ?? ((await trigger.textContent()) ?? '').trim();
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const controls = await trigger.getAttribute('aria-controls');
    expect(controls, `${label} · ${kind} trigger "${name}" names its popup`).toBeTruthy();
    const popup = page.locator(`[id="${controls}"]`);
    await expect(popup).toBeVisible();
    await assertLabelsFit(page, { scope: popup, label: `${label} · ${kind} "${name}"` });
    await page.keyboard.press('Escape');
    await expect(popup).toBeHidden();
  }
}

test.describe('labels fit their controls in the longer-running languages', () => {
  let seed: LabelFitSeed;

  test.beforeAll(async () => {
    await resetDatabase();
    seed = await seedLabelFitTenant(EMAIL);
  });

  test.afterAll(async () => {
    await setAccountLanguage(EMAIL, 'en').catch(() => undefined);
    await db.$disconnect();
  });

  for (const run of RUNS) {
    test(`${run.locale} at ${run.width}×${run.height}`, async ({ page }) => {
      test.setTimeout(240_000);
      await setAccountLanguage(EMAIL, run.locale);
      await page.setViewportSize({ width: run.width, height: run.height });
      await signIn(page, seed.email, seed.password);

      for (const surface of surfaces(seed)) {
        await page.goto(surface.path);
        await expect(page.locator('html')).toHaveAttribute('lang', run.locale);
        await expect(page.getByRole('main')).toBeVisible();
        const label = `${surface.name} · ${run.locale}`;
        await assertLabelsFit(page, { label });
        if (surface.popups) await openAndMeasurePopups(page, surface.popups, label);
      }
    });
  }
});
