// E2E smoke: the app shell wire-up (Subtask 1.5.3). Signs in, creates a
// first project so the project-scoped nav appears, then confirms the sidebar
// renders and navigation + active-item highlighting work.
//
// @smoke — verifies the AppLayout migration: the sidebar (not the old top-nav
// switcher) carries the project nav, the placeholder routes resolve, and the
// active row gets aria-current="page".

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';

const PASSWORD = 'shell-spec-pass-123';
const USER_EMAIL = 'e2e-shell@example.com';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

// Sign up a fresh user → auto-workspace, zero projects → lands on /dashboard.
// Mirrors projects-flow.spec's resilient sign-up (the shared dev server
// applies E2E_DISABLE_RATE_LIMIT, but keep the retry as belt + suspenders).
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

async function createFirstProject(page: Page, name: string): Promise<void> {
  // The dashboard empty-state CTA opens the create-project modal.
  await page.getByRole('button', { name: 'Create project' }).first().click();
  await expect(page.getByRole('heading', { name: 'Create project' })).toBeVisible();
  await page.getByLabel('Project name').fill(name);
  await page.getByRole('button', { name: 'Create project', exact: true }).last().click();
  await expect(page.getByText('Project created').first()).toBeVisible({ timeout: 5_000 });
}

test('@smoke shell: sidebar nav renders, navigates, and marks the active item', async ({
  page,
}) => {
  await signUp(page, USER_EMAIL);
  await page.goto('/dashboard');
  await createFirstProject(page, 'Mobile App');

  // The sidebar now carries the project switcher + project-scoped nav.
  await expect(page.getByRole('button', { name: 'Switch project' })).toContainText('Mobile App');
  const issuesLink = page.getByRole('link', { name: 'Work Items' });
  await expect(issuesLink).toBeVisible();
  await expect(page.getByRole('link', { name: 'Boards' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Reports' })).toBeVisible();

  // On /dashboard the Dashboard item is current, Issues is not.
  await expect(page.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(issuesLink).not.toHaveAttribute('aria-current', 'page');

  // Navigate to Issues → the real issue list renders (empty state for a fresh
  // project, Subtask 2.5.3) + Issues becomes current.
  await issuesLink.click();
  await page.waitForURL('**/issues');
  await expect(page.getByRole('heading', { name: 'Work Items', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No work items yet' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Work Items' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});
