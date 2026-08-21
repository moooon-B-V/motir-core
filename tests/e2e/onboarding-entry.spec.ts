// E2E: the motir-core entry rework (Subtask 7.22.1 / MOTIR-1457).
//
// Logged-out, no DB seeding — deterministic. Asserts the two front-door
// contracts in a real browser:
//   1. GET / redirects to /sign-in (the marketing hero relocated out; the root
//      is now just the login door).
//   2. The "Plan with AI" control on /sign-in is the onboarding door: it links
//      to /onboarding, and following it while logged out lands on
//      /sign-in?next=/onboarding (the onboarding auth gate preserves intent).
//
// The self-host Connect gate is opt-in (MOTIR_SELFHOST_CONNECT_GATE, off by
// default), so /onboarding does NOT show it here — it reaches the auth gate,
// which is what this spec exercises.

import { expect, test } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signUp, POST_AUTH_LANDING } from './_helpers/shell-session';

test.describe('motir-core entry rework (7.22.1)', () => {
  test('root redirects to /sign-in — no marketing hero', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/');
    await page.waitForURL(/\/sign-in/);
    await expect(page).toHaveURL(/\/sign-in$/);
    // The relocated marketing hero's idea-capture form is gone from the root.
    await expect(page.getByRole('heading', { name: 'Welcome back!' })).toBeVisible();
  });

  test('"Plan with AI" door routes to /onboarding (preserving next when logged out)', async ({
    page,
  }) => {
    await page.context().clearCookies();
    await page.goto('/sign-in');

    const door = page.getByRole('link', { name: /plan with ai/i });
    await expect(door).toBeVisible();
    await expect(door).toHaveAttribute('href', '/onboarding');

    await door.click();
    // Logged out → the onboarding layout bounces to sign-in, preserving the
    // onboarding intent so the visitor lands back in onboarding after auth.
    await page.waitForURL(/\/sign-in\?next=%2Fonboarding/);
    await expect(page).toHaveURL(/next=%2Fonboarding/);
  });
});

// The OTHER visitor state (MOTIR-3367). The two tests above clear cookies
// first — which is how you make an entry-route fixture deterministic, and also
// why the root's missing branch stayed green: for months a signed-in reader
// opening the product's own domain got the login form for the account they were
// already in, and no suite could go red about a state no test entered.
//
// It is a separate describe because it is the only test in this file that needs
// a database: the visitor state IS a real session, so it is created through the
// real sign-up flow rather than asserted about a cookie.
test.describe('motir-core entry rework — the SIGNED-IN visitor (MOTIR-3367)', () => {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test('root sends a signed-in reader to /home, not to the sign-in form', async ({ page }) => {
    // A fresh account, so the assertion holds for the reader with the LEAST
    // context in the product: `/home`'s no-project branch is the shipped
    // create-first door (MOTIR-2761), which is what makes `/home` the right
    // destination for every signed-in actor (docs/decisions/home-scope.md §2.3).
    await signUp(page, 'entry-signed-in@example.com');

    await page.goto('/');

    await expect(page).toHaveURL(new RegExp(`${POST_AUTH_LANDING}$`));
    await expect(page.getByTestId('home-page')).toBeVisible();
    // The form the reader used to land on is not what they get.
    await expect(page.getByRole('heading', { name: 'Welcome back!' })).toBeHidden();
  });
});
