// E2E: the credential surfaces answer the SIGNED-IN visitor (MOTIR-3372).
//
// `/sign-in` and `/sign-up` had no session read anywhere above them, so a reader
// who was already signed in was shown a login form for the account they were
// already in — and the CLI hand-off, which arrives as
// `/sign-in?next=/device?user_code=…`, asked them for a password to reach a page
// they were entitled to. Both are now server shells that resolve the session
// first.
//
// The signed-OUT direction stays covered where it already was
// (`auth-credentials.spec.ts` drives the whole credential journey), so this file
// asserts only the state that had no test at all — plus one signed-out render,
// because "the bounce did not eat the form" is the regression this change could
// plausibly cause.

import { expect, test } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signUp, POST_AUTH_LANDING } from './_helpers/shell-session';

const EMAIL = 'signed-in-bounce@example.com';

test.describe('credential surfaces, signed in (MOTIR-3372)', () => {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test('/sign-in and /sign-up send a signed-in reader on, and ?next= is honoured', async ({
    page,
  }) => {
    await signUp(page, EMAIL);

    // The bare arrivals: a bookmark, an old link, the auth card's own wordmark.
    await page.goto('/sign-in');
    await expect(page).toHaveURL(new RegExp(`${POST_AUTH_LANDING}$`));
    await expect(page.getByTestId('home-page')).toBeVisible();

    await page.goto('/sign-up');
    await expect(page).toHaveURL(new RegExp(`${POST_AUTH_LANDING}$`));

    // The hand-off arrival: the destination is followed WITHOUT a second
    // authentication. This is the CLI-connect shape (`?next=/device?user_code=…`),
    // asserted on a route that needs no seeding.
    await page.goto('/sign-in?next=%2Fitems');
    await expect(page).toHaveURL(/\/items$/);

    // And an off-origin `next` is refused rather than followed — the shell is
    // not an open redirect.
    await page.goto('/sign-in?next=https%3A%2F%2Fevil.example%2Fsteal');
    await expect(page).toHaveURL(new RegExp(`${POST_AUTH_LANDING}$`));
  });

  test('a reader with no session still gets the form on both surfaces', async ({ page }) => {
    await page.context().clearCookies();

    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { name: 'Welcome back!' })).toBeVisible();

    await page.goto('/sign-up');
    await expect(page.getByPlaceholder('Email address')).toBeVisible();
  });
});
