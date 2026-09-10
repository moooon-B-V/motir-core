// E2E — THE REGISTRATION JOURNEY, end to end in a real browser (MOTIR-4876).
//
// Create an account → land on the onboarding entrance → be inside a project
// that already exists. That is the whole user-visible deliverable of the "you
// are always in a project" story, and until this file nothing asserted it as a
// journey: the seam has integration tests, the landing has unit tests, and the
// screens that went have guards, but no test walked a person through the door.
//
// ⚠️ IT USES `signUpToOnboarding`, NOT `signUp`. The shared `signUp` settles on
// the entrance and then navigates on to the landing, because ~85 specs mean
// "give me an authenticated session in the app" by it. This spec is about the
// step that helper walks past, so it stops where the registration actually
// lands — which is also why that helper exists as two functions rather than one
// with a hidden navigation.
//
// @smoke — MOTIR-4876.

import { expect, test } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { SHELL_PASSWORD, signUpToOnboarding, startSignedOut } from './_helpers/shell-session';
import { AUTHED_LANDING_PATH, ONBOARDING_ENTRY_PATH } from '@/lib/navigation/landing';

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('@smoke a new account lands on the onboarding entrance, inside a seeded project', async ({
  page,
}) => {
  await signUpToOnboarding(page, `first-run-${Date.now()}@example.com`);

  // 1 · WHERE IT LANDED. The registration arm of `resolvePostAuthDestination`
  //     (MOTIR-4871) — not the signed-in landing, which is where a sign-IN goes.
  await expect(page).toHaveURL(new RegExp(`${ONBOARDING_ENTRY_PATH}$`));

  // 2 · THE ENTRANCE RENDERED, rather than the actionless dead end it used to
  //     show a projectless reader. This is the assertion the story turns on:
  //     the entrance expects a project to exist, and before MOTIR-4870 the one
  //     reader guaranteed to arrive here had none.
  await expect(page.getByRole('textbox').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/no project/i)).toHaveCount(0);
});

test('@smoke the account is already IN a project — the shell proves it', async ({ page }) => {
  await signUpToOnboarding(page, `first-run-shell-${Date.now()}@example.com`);

  // The entrance sits OUTSIDE the authed group's shell, so the project has to
  // be checked where the shell is: one navigation to the landing.
  await page.goto(AUTHED_LANDING_PATH);
  await expect(page.getByTestId('workbench-page')).toBeVisible({ timeout: 30_000 });

  // The switcher, not a create-first door — and the project is named for its
  // workspace, which is what `ensureDefaultProject` chooses.
  const switcher = page.getByRole('button', { name: 'Switch project' });
  await expect(switcher).toBeVisible();
  await expect(switcher).toContainText('Workspace');
  await expect(page.getByRole('button', { name: 'Create your first project' })).toHaveCount(0);
});

test('a SIGN-IN still lands on the signed-in landing — the arm is registration-only', async ({
  page,
}) => {
  // The other half of the branch, and the half a spec that only ever registers
  // cannot see. `lib/navigation/landing.ts`'s own docstring records two defects
  // (MOTIR-3367, MOTIR-3372) that were exactly this: a surface answering for
  // one visitor and never asked about the other.
  const email = `first-run-signin-${Date.now()}@example.com`;
  await signUpToOnboarding(page, email);

  await startSignedOut(page);
  await page.goto('/sign-in');
  await page.getByPlaceholder('Email address').fill(email);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Password').fill(SHELL_PASSWORD);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();

  await page.waitForURL(`**${AUTHED_LANDING_PATH}`, { timeout: 30_000 });
  await expect(page.getByTestId('workbench-page')).toBeVisible({ timeout: 30_000 });
});
