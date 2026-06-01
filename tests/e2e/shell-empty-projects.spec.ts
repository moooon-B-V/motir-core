// E2E smoke: the empty-projects shell state (PRODECT_FINDINGS #29.1). A fresh
// user's auto-workspace has zero projects, so the sidebar header renders the
// "Create your first project" CTA card instead of the switcher, the project-
// scoped nav (Issues/Boards/Reports) is hidden, and Settings/Docs remain.
//
// @smoke — Subtask 1.5.3.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';

const PASSWORD = 'shell-empty-pass-123';
const USER_EMAIL = 'e2e-shell-empty@example.com';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

async function signUp(page: Page, email: string): Promise<void> {
  await page.goto('/sign-up');
  await page.getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Create a password').fill(PASSWORD);

  const createButton = page.getByRole('button', { name: /^(Create account|Creating account…)$/ });
  for (let attempt = 0; attempt < 3; attempt++) {
    await createButton.click();
    const landed = await page
      .waitForURL('**/dashboard', { timeout: 9_000 })
      .then(() => true)
      .catch(() => false);
    if (landed || page.url().includes('/dashboard')) return;
    await page.waitForTimeout(11_000);
  }
  await page.waitForURL('**/dashboard');
}

test('@smoke shell: zero-projects sidebar shows the CTA, hides project nav, keeps Settings/Docs', async ({
  page,
}) => {
  await signUp(page, USER_EMAIL);
  await page.goto('/dashboard');

  // (#29.1) The sidebar header renders the "Create your first project" CTA
  // card (a button) in place of the project switcher.
  await expect(page.getByRole('button', { name: 'Create your first project' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch project' })).toHaveCount(0);

  // Project-scoped nav items are hidden when there's no active project.
  await expect(page.getByRole('link', { name: 'Issues' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Boards' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Reports' })).toHaveCount(0);

  // Settings + Docs (the bottom section) stay visible.
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Docs' })).toBeVisible();
});
