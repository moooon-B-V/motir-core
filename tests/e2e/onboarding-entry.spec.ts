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
