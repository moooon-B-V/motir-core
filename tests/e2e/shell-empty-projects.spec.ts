// E2E smoke: a FRESH ACCOUNT'S SHELL.
//
// ⚠️ INVERTED, WHOLE (MOTIR-4876). This file was "the empty-projects shell
// state (PRODECT_FINDINGS #29.1)": a fresh user's auto-workspace had zero
// projects, so the rail head rendered the "Create your first project" CTA card
// instead of the switcher and the project-scoped nav was hidden.
//
// Every clause of that is now false. A default project is seeded at the
// WORKSPACE tier (MOTIR-4870), so a fresh account is inside one from its first
// request; the CTA is retired (MOTIR-4873) and so is the `hasProject` gate that
// hid the nav.
//
// It is INVERTED rather than deleted because its subject survives its premise:
// what a brand-new account's shell looks like is exactly as worth a smoke test
// now as it was then — the answer is simply the opposite one, and asserting the
// opposite is what makes this file a detector rather than a fossil.
//
// @smoke — Subtask 1.5.3, inverted by MOTIR-4876.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { startSignedOut } from './_helpers/shell-session';

const PASSWORD = 'shell-empty-pass-123';
const USER_EMAIL = 'e2e-shell-empty@example.com';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

async function signUp(page: Page, email: string): Promise<void> {
  await startSignedOut(page);
  await page.goto('/sign-up');
  await page.getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Create a password').fill(PASSWORD);

  // ⚠️ A registration lands on the onboarding ENTRANCE now (MOTIR-4871); this
  // local helper keeps its contract — leave the caller in the app — by settling
  // there and navigating on.
  const createButton = page.getByRole('button', { name: /^(Create account|Creating account…)$/ });
  for (let attempt = 0; attempt < 3; attempt++) {
    await createButton.click();
    const landed = await page
      .waitForURL('**/onboarding', { timeout: 9_000 })
      .then(() => true)
      .catch(() => false);
    if (landed || page.url().includes('/onboarding')) break;
    await page.waitForTimeout(11_000);
  }
  await page.waitForURL('**/onboarding');
  await page.goto('/workbench');
  await page.waitForURL('**/workbench');
}

test('@smoke shell: a fresh account has a project — the switcher, the project nav, Settings/Git', async ({
  page,
}) => {
  await signUp(page, USER_EMAIL);
  await page.goto('/dashboard');

  // The rail head renders the project SWITCHER. There is no create-first CTA
  // anywhere, in the rail or in the bar — the state it served cannot occur.
  await expect(page.getByRole('button', { name: 'Switch project' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create your first project' })).toHaveCount(0);

  // The project-scoped nav RENDERS. It was hidden by the `hasProject` gate,
  // which is gone with the state it gated on.
  await expect(page.getByRole('link', { name: 'Work Items' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Boards' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Reports' })).toBeVisible();

  // Settings + Git (the bottom section) stay visible — unchanged. Docs and
  // Legal documents left this section for the Help menu (MOTIR-4239).
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Git' })).toBeVisible();
});
