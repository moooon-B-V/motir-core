// E2E smoke: the projects UI arc — sign-up → projects empty-state →
// create-modal → switcher → second-create → switch → archive → fallback
// — with light + dark mode screenshots for visual verification.
//
// Subtask 1.3.4. Reuses the auto-workspace-on-signup from Story 1.2,
// so a fresh user lands with one workspace and zero projects (the
// empty-state surface).

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { startSignedOut } from './_helpers/shell-session';

const PASSWORD = 'projects-flow-pass-123';
const USER_EMAIL = 'e2e-projects@example.com';
const SCREENSHOT_DIR = '/tmp/motir-smoke';
/**
 * The project the WORKSPACE seeds for itself (MOTIR-4870), named after it. It
 * exists before step 2 — the first authed request makes it — so it is the
 * OLDEST project here, which is what decides the archive fallback below.
 */
const SEEDED_PROJECT = `${USER_EMAIL.split('@')[0]}'s Workspace`;

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

  // ⚠️ A registration lands on the onboarding ENTRANCE (MOTIR-4871), not on the
  // signed-in landing. This helper's contract is "leave the caller in the app",
  // so it settles where the registration actually lands and navigates on — the
  // same two-step the shared `signUp` and the other local ones use. The retry
  // loop is about the RATE LIMIT and is unchanged; only the URL it waits for
  // moved, because the wait is what tells a throttled click from a landed one.
  const createButton = page.getByRole('button', { name: /^(Create account|Creating account…)$/ });
  const rateLimitAlert = page.getByText('Something went wrong. Please try again.');

  for (let attempt = 0; attempt < 3; attempt++) {
    await createButton.click();
    const landed = await Promise.race([
      page
        .waitForURL('**/onboarding', { timeout: 9_000 })
        .then(() => true)
        .catch(() => false),
      rateLimitAlert
        .waitFor({ state: 'visible', timeout: 9_000 })
        .then(() => false)
        .catch(() => false),
    ]);
    if (landed || page.url().includes('/onboarding')) {
      await page.goto('/workbench');
      await page.waitForURL('**/workbench');
      return;
    }
    await page.waitForTimeout(11_000);
  }
  await page.waitForURL('**/onboarding');
  await page.goto('/workbench');
  await page.waitForURL('**/workbench');
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

  // 1) A fresh account's surface — light
  //
  // ⚠️ INVERTED (MOTIR-4876). This was the EMPTY-STATE surface: with zero
  // projects the page rendered "Create your first project" and the sidebar
  // rendered the CTA card in place of the switcher (PRODECT_FINDINGS #29.1). A
  // fresh account has a seeded project now (MOTIR-4870), so the switcher is
  // what renders and the screenshots below capture that instead. The theme
  // parity they exist for is unaffected — it is the same two renders of the
  // same route.
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Create your first project' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Switch project' })).toBeVisible();
  await applyTheme(page, 'light');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-fresh-account-light.png`, fullPage: true });

  // 1b) The same fresh-account surface — dark
  await applyTheme(page, 'dark');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-fresh-account-dark.png`, fullPage: true });
  await applyTheme(page, 'light');

  // 2) Open the create modal from THE SWITCHER (MOTIR-4876).
  //
  // ⚠️ This used to read "open create modal from the empty-state CTA", and the
  // click below went straight to a `Create project` button that the projectless
  // `/dashboard` rendered inline. That surface is deleted, not merely unrouted —
  // creating a project is a workspace-tier act, and the switcher is the door
  // that owns it (`tests/navigation/no-create-project-screen-guard.test.ts`).
  // Step 1 above was inverted in the same pass this comment belongs to; the
  // click was not, so the spec asserted the new world and then drove the old
  // one. It is the two-step `createFirstProject` performs — open the switcher,
  // then the create door — spelled out here because this test screenshots the
  // modal between the steps.
  await page.getByRole('button', { name: 'Switch project' }).click();
  await page.getByRole('button', { name: 'Create project' }).first().click();
  await expect(page.getByRole('heading', { name: 'Create project' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Mobile App');
  // Identifier should auto-derive to MOBIL (5 chars, uppercased name)
  await expect(page.getByRole('textbox', { name: 'Identifier' })).toHaveValue('MOBIL');
  await expect(page.getByText(/Work items will be keyed MOBIL-1, MOBIL-2/)).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-create-modal-light.png`, fullPage: false });

  await applyTheme(page, 'dark');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-create-modal-dark.png`, fullPage: false });
  await applyTheme(page, 'light');

  // Submit
  await page.getByRole('button', { name: 'Create project', exact: true }).last().click();
  // Toast appears
  await expect(page.getByText('Project created', { exact: true }).first()).toBeVisible({
    timeout: 5_000,
  });
  // Top-nav switcher now shows Mobile App
  await expect(page.getByRole('button', { name: 'Switch project' })).toContainText('Mobile App');
  // /dashboard now lands on the dashboards home (Subtask 6.3.5 replaced the
  // 1.1.2 smoke greeting per the page-comment contract); with a project but no
  // dashboards yet it renders the "Dashboards" heading + the create-first
  // empty state.
  await expect(page.getByRole('heading', { name: 'Dashboards', exact: true })).toBeVisible();

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
  await page.getByRole('textbox', { name: 'Project name' }).fill('Marketing Site');
  await expect(page.getByRole('textbox', { name: 'Identifier' })).toHaveValue('MARKE');
  await page.getByRole('button', { name: 'Create project', exact: true }).last().click();
  await expect(page.getByText('Project created', { exact: true }).first()).toBeVisible({
    timeout: 5_000,
  });
  // Second project becomes active
  await expect(page.getByRole('button', { name: 'Switch project' })).toContainText(
    'Marketing Site',
  );

  // 5) Switch back to Mobile App via the switcher. Switching the active project
  // LANDS the reader somewhere (MOTIR-1559 — the MOTIR-1312 context-switch
  // landing contract) instead of refreshing in place, so a stale, old-project
  // URL / client island can't linger. ⚠️ WHERE it lands moved from `/items` to
  // the signed-in landing (MOTIR-5132): a switch and a sign-in are the same act
  // and now share one owner. Wait for the landing, where the top-bar switcher
  // reflects the newly-active project.
  await page.getByRole('button', { name: 'Switch project' }).click();
  await page.getByRole('button', { name: /^Mobile App/ }).click();
  await page.waitForURL('**/workbench');
  await expect(page.getByRole('button', { name: 'Switch project' })).toContainText('Mobile App');

  // 6) Archive — navigate to project settings, open archive modal. The area now
  // LANDS on the read-only Details page (Subtask 6.5.3); its danger zone re-homes
  // the Archive control (admin-only — this actor owns the workspace).
  await page.goto('/settings/project');
  await expect(page.getByRole('heading', { name: 'Details', exact: true })).toBeVisible();
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
  await page.getByRole('textbox', { name: /Type MOBIL to confirm/ }).fill('MOBI');
  await expect(archiveBtn).toBeDisabled();
  // Type full identifier — armed
  await page.getByRole('textbox', { name: /Type MOBIL to confirm/ }).fill('MOBIL');
  await expect(archiveBtn).toBeEnabled();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04-archive-armed-light.png`, fullPage: false });

  await applyTheme(page, 'dark');
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04-archive-armed-dark.png`, fullPage: false });
  await applyTheme(page, 'light');

  await archiveBtn.click();
  await expect(page.getByText('Project archived', { exact: true }).first()).toBeVisible({
    timeout: 5_000,
  });
  // ⚠️ THE FALLBACK IS THE SEEDED PROJECT, NOT 'Marketing Site' (MOTIR-4876).
  // `getActiveProject` falls back to the workspace's FIRST non-archived project
  // by creation, and this workspace now holds THREE: the seeded default, then
  // Mobile App, then Marketing Site. The old expectation was exactly right when
  // the only projects were the two this test makes — it named the survivor by
  // assuming there was one other. The contract it was written for is unchanged;
  // the population it counted is.
  //
  // The project-settings AREA (Story 6.5.2) shows the back-to-project/identity
  // header instead of the ProjectSwitcher, so the fallback surfaces in the
  // settings rail itself (no extra navigation — this test is already near its
  // time budget).
  await expect(page.getByRole('navigation', { name: 'Project settings' })).toContainText(
    SEEDED_PROJECT,
  );

  // 7) Archive Marketing Site too — the reader still lands in a project.
  //
  // ⚠️ IT HAS TO BE SWITCHED TO FIRST (MOTIR-4876). This step used to read
  // "archive the remaining project" and go straight to `/settings/project`,
  // because archiving Mobile App left Marketing Site active. The fallback above
  // now lands on the seeded project instead, so that route would have opened
  // the WRONG project's settings and typed MARKE into a confirm field asking
  // for a different identifier. The switcher does not live in the settings
  // area, so this goes out to `/items` for it — and the switch then pushes on
  // to the signed-in landing (MOTIR-5132), which is where the assertion below
  // reads the top bar.
  await page.goto('/items');
  await page.getByRole('button', { name: 'Switch project' }).click();
  await page.getByRole('button', { name: /^Marketing Site/ }).click();
  await page.waitForURL('**/workbench');
  await expect(page.getByRole('button', { name: 'Switch project' })).toContainText(
    'Marketing Site',
  );

  await page.goto('/settings/project');
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await page.getByRole('textbox', { name: /Type MARKE to confirm/ }).fill('MARKE');
  await page.getByRole('button', { name: 'Archive project' }).click();
  await expect(page.getByText('Project archived', { exact: true }).first()).toBeVisible({
    timeout: 5_000,
  });

  // ⚠️ INVERTED (MOTIR-4876). Archiving the last project used to return the
  // reader to the empty state, and this spec used to BE that reader — with both
  // of its projects archived the workspace held none. It holds the seeded one,
  // so the resolver does not even reach the heal here; what this now witnesses
  // is the plainer half of the same invariant, that a member archiving their
  // way down still lands in a project rather than on a CTA. The heal itself —
  // archiving genuinely every project and getting a fresh one back — is
  // asserted at the service tier, where it can be seen directly
  // (`tests/default-project-per-workspace.test.ts`, door 3).
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Create your first project' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Switch project' })).toBeVisible();
});
