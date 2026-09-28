// E2E: a server render failure lands on Motir's own error page — MOTIR-6855
// (Bug MOTIR-6776 · design MOTIR-6854, `design/shell/server-error.mock.html`).
//
// ## The defect
//
// motir-core had no error boundary outside two settings panes, so a page that
// threw during its server render reached Next's `onUncaughtError` and the tab
// was left with nothing on it — no message, no Retry, no way back. In
// production that was a P2028 transaction stall in `app/(authed)/layout.tsx`.
//
// ## What is asserted
//
// State 1 — a page under `(authed)` failed and the shell survived — driven with
// the test-only `/_test/render-error` page, which throws on every render:
//
//   1. the in-shell error panel renders (`role="alert"` with the page title),
//      so the tab did not crash;
//   2. the rail is still there (a navigation landmark), which is the whole
//      reason state 1 draws no second door;
//   3. Try again is a real button, and pressing it re-renders the SAME panel
//      (the probe throws again) rather than a blank tab or a second card.
//
// And the boundary must not swallow what is not an error:
//
//   4. `/items/<a missing key>` still answers 404 with the existing not-found
//      page — `notFound()` is a router signal Next re-throws past an error
//      boundary, and this spec is where that is checked in a real build.
//
// States 2 and 3 (a throw in `app/(authed)/layout.tsx` / `app/layout.tsx`)
// cannot be forced from a spec without adding a failure switch to a production
// layout, which is a worse trade than the coverage; they are covered by
// `tests/components/server-error-boundaries.test.tsx` and guarded as files by
// `tests/navigation/error-boundary-files.test.ts`.
//
// Authoritative signals only (CLAUDE.md § E2E): the status is read off the
// navigation response, and the retry's completion off the refresh request it
// makes — never a sleep.
import { expect, test } from '@playwright/test';
import enMessages from '@/messages/en.json';
import { resetDatabase } from './_helpers/db-reset';
import { createFirstProject, signUp } from './_helpers/shell-session';

const USER = 'e2e-server-error-boundary@example.com';
const MISSING_KEY = 'ZZZZ-999999';
const PAGE_TITLE = enMessages.errors.serverError.pageTitle;
const RETRY = enMessages.common.retry;
const NOT_FOUND_TITLE = enMessages.errors.notFound.title;

test.beforeEach(async ({ page }) => {
  await resetDatabase();
  await signUp(page, USER);
  await createFirstProject(page, 'Error boundary');
});

test('a page that fails to render lands on the in-shell error panel, and Retry keeps it', async ({
  page,
}) => {
  await page.goto('/_test/render-error');

  // Scoped by its title: Next's route announcer is a second `role="alert"`.
  const panel = page.getByRole('alert').filter({ hasText: PAGE_TITLE });
  await expect(panel).toBeVisible();
  await expect(page.getByRole('navigation').first()).toBeVisible();
  await expect(page.getByRole('link', { name: enMessages.errors.notFound.homeAction })).toHaveCount(
    0,
  );

  const retry = page.getByRole('button', { name: RETRY });
  await expect(retry).toBeEnabled();
  const refetch = page.waitForResponse(
    (response) =>
      response.url().includes('/_test/render-error') && response.request().method() === 'GET',
  );
  await retry.click();
  await refetch;

  // The probe throws again, so the retry lands on the same page — one panel,
  // Retry back at rest.
  await expect(panel).toHaveCount(1);
  await expect(page.getByRole('button', { name: RETRY })).toBeEnabled();
});

test('a missing work item still answers 404 with the not-found page, not the error panel', async ({
  page,
}) => {
  const response = await page.goto(`/items/${MISSING_KEY}`);
  expect(response?.status()).toBe(404);
  await expect(page.getByText(NOT_FOUND_TITLE)).toBeVisible();
  await expect(page.getByText(PAGE_TITLE)).toHaveCount(0);
});
