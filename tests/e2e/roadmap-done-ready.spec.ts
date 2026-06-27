// Roadmap done & ready styles E2E (Story MOTIR-1422 / Subtask MOTIR-1436) — the
// browser-level proof that done and ready nodes render as DISTINCT card states
// (MOTIR-1435): a done node recedes (faded), a ready node advances (mint wash), and
// neither is confused with the accent "you are here" frontier.
//
// Drives the REAL stack (Next + Postgres); the fixture seeds one level with all
// three states. Waits on the AUTHORITATIVE rendered state — each card's
// `data-node-state` attribute + its status pill — never fixed sleeps (the E2E
// discipline in motir-core/CLAUDE.md).

import { expect, test, type Locator, type Page } from '@playwright/test';

import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedDoneReadyRoadmap } from './_helpers/roadmap-seed';

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

const roadmapNav = (page: Page) =>
  page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Roadmap' });

const rootLevelLoad = (page: Page) =>
  page.waitForResponse(
    (r) =>
      r.url().includes('/api/projects/') &&
      r.url().includes('/roadmap') &&
      !r.url().includes('parentId') &&
      r.request().method() === 'GET' &&
      r.ok(),
  );

test('Roadmap: done and ready nodes render as distinct card states', async ({ page }) => {
  const seed = await seedDoneReadyRoadmap('roadmap-done-ready@example.com');
  await signIn(page, seed.email, seed.password);

  const nav = roadmapNav(page);
  await expect(nav).toBeVisible();
  const rootLoaded = rootLevelLoad(page);
  await nav.click();
  await page.waitForURL('**/roadmap');
  await rootLoaded;
  await expect(page.getByTestId('planning-canvas')).toBeVisible();

  // The card carrying a given title — its `data-node-state` is the authoritative state.
  const card = (title: string): Locator =>
    page.locator('[data-node-state]').filter({ hasText: title });

  // Each state renders its OWN card treatment...
  await expect(card(seed.doneTitle)).toHaveAttribute('data-node-state', 'done');
  await expect(card(seed.readyTitle)).toHaveAttribute('data-node-state', 'ready');
  await expect(card(seed.hereTitle)).toHaveAttribute('data-node-state', 'here');

  // ...with the distinct pills (a neutral "Done" check vs the success "Ready").
  await expect(card(seed.doneTitle).getByTestId('done-pill')).toBeVisible();
  await expect(card(seed.readyTitle).getByTestId('ready-pill')).toBeVisible();

  // done ≠ ready — the styles are tellable apart (proven by the differing state attrs:
  // the done card never carries the ready state, nor the ready pill).
  await expect(card(seed.doneTitle)).not.toHaveAttribute('data-node-state', 'ready');
  await expect(card(seed.doneTitle).getByTestId('ready-pill')).toHaveCount(0);
});
