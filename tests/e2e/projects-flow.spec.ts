// E2E smoke: the projects UI arc — sign-up → projects empty-state →
// create-modal → switcher → second-create → switch → archive → fallback
// — with light + dark mode screenshots for visual verification.
//
// Subtask 1.3.4. Reuses the auto-workspace-on-signup from Story 1.2,
// so a fresh user lands with one workspace and zero projects (the
// empty-state surface).

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';

const PASSWORD = 'projects-flow-pass-123';
const USER_EMAIL = 'e2e-projects@example.com';
const SCREENSHOT_DIR = '/tmp/prodect-smoke';

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
  const rateLimitAlert = page.getByText('Something went wrong. Please try again.');

  for (let attempt = 0; attempt < 3; attempt++) {
    await createButton.click();
    const landed = await Promise.race([
      page
        .waitForURL('**/dashboard', { timeout: 9_000 })
        .then(() => true)
        .catch(() => false),
      rateLimitAlert
        .waitFor({ state: 'visible', timeout: 9_000 })
        .then(() => false)
        .catch(() => false),
    ]);
    if (landed || page.url().includes('/dashboard')) return;
    await page.waitForTimeout(11_000);
  }
  await page.waitForURL('**/dashboard');
}

async function applyTheme(page: Page, mode: 'light' | 'dark'): Promise<void> {
  // The design system reads data-theme on <html>; toggle it from devtools-
  // style for parity verification.
  await page.evaluate((m) => {
    document.documentElement.setAttribute('data-theme', m);
  }, mode);
}

test('projects UI happy path with theme parity screenshots', async ({ page }) => {
  await signUp(page, USER_EMAIL);

  // 1) Empty-state surface — light
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Create your first project' })).toBeVisible();
  await expect(page.getByText('Projects group your work items')).toBeVisible();
  // Top-nav project switcher slot must NOT be there yet (workspace has
  // no projects, so the switcher renders "No project" only inside the
  // top-nav — which IS rendered since the workspace exists).
  await expect(page.getByRole('button', { name: 'Switch project' })).toBeVisible();
  await applyTheme(page, 'light');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-empty-state-light.png`, fullPage: true });

  // 1b) Empty-state surface — dark
  await applyTheme(page, 'dark');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-empty-state-dark.png`, fullPage: true });
  await applyTheme(page, 'light');

  // 2) Open create modal from the empty-state CTA
  await page.getByRole('button', { name: 'Create project' }).first().click();
  await expect(page.getByRole('heading', { name: 'Create project' })).toBeVisible();
  await page.getByLabel('Project name').fill('Mobile App');
  // Identifier should auto-derive to MOBIL (5 chars, uppercased name)
  await expect(page.getByLabel('Identifier')).toHaveValue('MOBIL');
  await expect(page.getByText(/Work items will be keyed MOBIL-1, MOBIL-2/)).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-create-modal-light.png`, fullPage: false });

  await applyTheme(page, 'dark');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-create-modal-dark.png`, fullPage: false });
  await applyTheme(page, 'light');

  // Submit
  await page.getByRole('button', { name: 'Create project', exact: true }).last().click();
  // Toast appears
  await expect(page.getByText('Project created').first()).toBeVisible({ timeout: 5_000 });
  // Top-nav switcher now shows Mobile App
  await expect(page.getByRole('button', { name: 'Switch project' })).toContainText('Mobile App');
  await expect(page.getByText('Active project:')).toBeVisible();

  // 3) Switcher — open state
  await page.getByRole('button', { name: 'Switch project' }).click();
  await expect(page.getByText('Projects', { exact: true })).toBeVisible(); // header
  await expect(page.getByRole('button', { name: /Create project/ }).last()).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-switcher-open-light.png`, fullPage: false });

  await applyTheme(page, 'dark');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-switcher-open-dark.png`, fullPage: false });
  await applyTheme(page, 'light');

  // 4) Create a second project from the switcher's Create entry
  await page
    .getByRole('button', { name: /Create project/ })
    .last()
    .click();
  await page.getByLabel('Project name').fill('Marketing Site');
  await expect(page.getByLabel('Identifier')).toHaveValue('MARKE');
  await page.getByRole('button', { name: 'Create project', exact: true }).last().click();
  await expect(page.getByText('Project created').first()).toBeVisible({ timeout: 5_000 });
  // Second project becomes active
  await expect(page.getByRole('button', { name: 'Switch project' })).toContainText(
    'Marketing Site',
  );

  // 5) Switch back to Mobile App via the switcher
  await page.getByRole('button', { name: 'Switch project' }).click();
  await page.getByRole('button', { name: /^Mobile App/ }).click();
  await expect(page.getByRole('button', { name: 'Switch project' })).toContainText('Mobile App');

  // 6) Archive — navigate to project settings, open archive modal
  await page.goto('/settings/project');
  await expect(page.getByRole('heading', { name: 'Project settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Archive Mobile App\?/ })).toBeVisible();
  // Danger button disabled until identifier matches
  const archiveBtn = page.getByRole('button', { name: 'Archive project' });
  await expect(archiveBtn).toBeDisabled();
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/04-archive-disabled-light.png`,
    fullPage: false,
  });

  // Type a partial identifier — still disabled
  await page.getByLabel(/Type MOBIL to confirm/).fill('MOBI');
  await expect(archiveBtn).toBeDisabled();
  // Type full identifier — armed
  await page.getByLabel(/Type MOBIL to confirm/).fill('MOBIL');
  await expect(archiveBtn).toBeEnabled();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04-archive-armed-light.png`, fullPage: false });

  await applyTheme(page, 'dark');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04-archive-armed-dark.png`, fullPage: false });
  await applyTheme(page, 'light');

  await archiveBtn.click();
  await expect(page.getByText('Project archived').first()).toBeVisible({ timeout: 5_000 });
  // Active project should fall back to Marketing Site
  await expect(page.getByRole('button', { name: 'Switch project' })).toContainText(
    'Marketing Site',
  );

  // 7) Archive the remaining project — empty state should return
  await page.goto('/settings/project');
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await page.getByLabel(/Type MARKE to confirm/).fill('MARKE');
  await page.getByRole('button', { name: 'Archive project' }).click();
  await expect(page.getByText('Project archived').first()).toBeVisible({ timeout: 5_000 });

  // Navigate back to dashboard — empty state again
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Create your first project' })).toBeVisible();
});
