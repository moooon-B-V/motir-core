// E2E: the DATA-SUBJECT-REQUEST journey (Story 8.4 · Subtask MOTIR-3706) — the
// interactive half of the story-level suite, in a real browser over the real
// stack.
//
// ── THE DIVISION OF LABOUR, STATED, BECAUSE IT IS THE CARD'S OWN CONSTRAINT ──
//
// Every slice already ships its own units, and this file deliberately asserts
// none of them again. `tests/settings/accountDeletionConfirm.test.tsx` proves
// the type-to-confirm gate against a MOCKED action; `accountDeletionBanner.
// test.tsx` proves the bar renders from a request row and that its cancel
// refreshes rather than reloads; `tests/account-deletion-schedule.test.ts`
// proves the service writes one row and revokes every session. All of those are
// one tier each.
//
// What only a browser can prove is the COMPOSITION between them, and it is not
// hypothetical — it is the shape MOTIR-3742 was filed for. Confirming SIGNS THE
// READER OUT (`revokeEverySession`, post-commit), so the two cancel doors the
// design draws are reachable only by signing back in. Until MOTIR-3742 that
// sign-in silently cancelled the deletion, and the banner therefore rendered
// only when the cancel had THROWN — every unit on both sides green, and the
// drawn path unreachable. This spec walks that path end to end:
//
//   1. the ledger's confirm is disabled until the typed value matches EXACTLY;
//   2. confirming schedules — and the next navigation is a sign-in, because the
//      account is closed as far as any open session is concerned;
//   3. signing back in lands on a route OUTSIDE `/settings/account`, and the
//      app-wide banner is there, carrying the ROW's erasure date;
//   4. the pane one route below shows the same date, from the same row;
//   5. cancelling from the BANNER clears it — and a fresh server read agrees,
//      with the row reading `cancelled`.
//
// Plus the one criterion the original card carried that no unit test reaches:
// the Privacy Policy's §7 link resolves to a page that actually renders.
//
// The sweep, the archive's contents and the blocked path are NOT driven here —
// they are integration work and they live in
// `tests/privacy/dataSubjectRequestJourney.test.ts`. Driving a thirty-day
// erasure sweep through a browser would be slower, flakier and prove less.
//
// ── HARNESS DISCIPLINE (CLAUDE.md § E2E) ────────────────────────────────────
// Every mutation is settled on an AUTHORITATIVE signal — the committed row, or
// a fresh server render — never on a timeout and never on the optimistic UI the
// banner deliberately paints on the click. `account_deletion_request` is
// RLS-gated on `app.user_id`, so the row reads below go through `adminDb`: the
// ordinary client would answer an unbound SELECT with ZERO ROWS and no error,
// which on this surface reads as "nothing was scheduled" when something was.
//
// ⚠️ NO `workspace_id` COOKIE PIN, and that is a reading of the rule rather than
// an omission of it. The pin is what a spec owes when it drives a
// `getWorkspaceContext`-gated API from the test context, because that gate
// resolves from the cookie and falls back to a resolver the moment a user holds
// more than one workspace. Nothing here does: every surface this spec touches is
// a PAGE render resolved from the session, and the one workspace-agnostic API —
// the export download, which is identity-scoped by design — is exercised at the
// integration tier. Pinning a cookie no read consults would be ceremony.
//
// The account itself is created through `signUp` rather than a seed helper,
// which is the one place this spec does drive the app to reach a state. It has
// to: the journey signs the reader OUT halfway through and requires them to sign
// back IN, so it needs a real credentialed account whose legal acceptance the
// sign-up hook has recorded — a seeded user meets the re-consent gate instead
// (Bug MOTIR-3713). Everything after that is navigation and assertion.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { SHELL_PASSWORD, signIn, signUp } from './_helpers/shell-session';
import { adminDb } from '@/tests/helpers/adminDb';
import { DATA_PRIVACY_PANE_PATH } from '@/lib/users/dataSubjectRequests';
import { formatDate } from '@/lib/utils/datetime';

/** The landing every credential flow settles on — deliberately NOT a settings route. */
const NON_SETTINGS_ROUTE = '/home';

test.beforeEach(async () => {
  await resetDatabase();
});

/** A fresh account, signed up through the real UI, on the Data & privacy pane. */
async function arriveOnThePane(page: Page, email: string): Promise<void> {
  await signUp(page, email);
  await page.goto(DATA_PRIVACY_PANE_PATH);
  await expect(page.getByRole('heading', { name: 'Data & privacy', exact: true })).toBeVisible();
}

test('@smoke the deletion journey: confirm through the ledger → signed out → sign back in → the app-wide banner on a non-settings route → cancel from the banner', async ({
  page,
}) => {
  const email = `dsr-delete-${Date.now()}@example.com`;
  await arriveOnThePane(page, email);

  // ── 1. THE LEDGER, AND ITS GATE ───────────────────────────────────────────
  await page.getByRole('button', { name: 'Delete account', exact: true }).click();
  const ledger = page.getByRole('alertdialog');
  await expect(ledger).toBeVisible();

  const confirmButton = ledger.getByRole('button', { name: 'Delete my account' });
  await expect(confirmButton).toBeDisabled();

  // A NEAR MISS is still a miss — the match is exact, and case-sensitive.
  const field = ledger.getByRole('textbox');
  await field.fill(email.toUpperCase());
  await expect(confirmButton).toBeDisabled();

  await field.fill(email);
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  // ── 2. IT SCHEDULED — asserted on the ROW, not on the dialog closing ──────
  await expect
    .poll(() => adminDb.accountDeletionRequest.count({ where: { status: 'scheduled' } }), {
      timeout: 20_000,
    })
    .toBe(1);
  const request = await adminDb.accountDeletionRequest.findFirstOrThrow();
  const erasureDate = formatDate(request.erasureDueAt.toISOString(), 'en');

  // …and the account is closed as far as any open session is concerned. This is
  // what made the two drawn doors unreachable before MOTIR-3742, so it is
  // asserted rather than worked around.
  await page.goto(NON_SETTINGS_ROUTE);
  await page.waitForURL((url) => url.pathname.startsWith('/sign-in'), { timeout: 30_000 });

  // ── 3. SIGNING BACK IN IS THE WAY TO THE WINDOW, NOT THE CANCEL ──────────
  await signIn(page, email, SHELL_PASSWORD);
  expect(new URL(page.url()).pathname).toBe(NON_SETTINGS_ROUTE);

  // The deletion SURVIVED the sign-in — the regression MOTIR-3742 removed, seen
  // from the reader's side rather than at the auth seam.
  expect(await adminDb.accountDeletionRequest.count({ where: { status: 'scheduled' } })).toBe(1);

  const banner = page.getByTestId('account-deletion-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(erasureDate);

  // ── 4. THE PANE'S OWN DOOR, one route below, from the SAME row ───────────
  await page.goto(DATA_PRIVACY_PANE_PATH);
  await expect(
    page.getByRole('heading', { name: `Your account will be erased on ${erasureDate}` }),
  ).toBeVisible();
  // One deletion card, never both: with a deletion pending there is nothing
  // left to ask for.
  await expect(page.getByRole('button', { name: 'Delete account', exact: true })).toHaveCount(0);

  // ── 5. CANCEL FROM THE BANNER, on a route that is not the pane ───────────
  await page.goto(NON_SETTINGS_ROUTE);
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'Cancel deletion' }).click();

  // The bar goes optimistically; the ROW is what settles it.
  await expect
    .poll(() => adminDb.accountDeletionRequest.count({ where: { status: 'cancelled' } }), {
      timeout: 20_000,
    })
    .toBe(1);

  // And a FRESH SERVER READ agrees — the assertion the optimistic removal
  // cannot make, and the one that catches a bar left standing over a cancelled
  // row (the failure the banner's own card names).
  await page.reload();
  await expect(page.getByTestId('home-page')).toBeVisible();
  await expect(page.getByTestId('account-deletion-banner')).toHaveCount(0);
});

test('the Privacy Policy’s §7 link resolves to the Data & privacy pane, and that page renders', async ({
  page,
}) => {
  // The criterion no unit test reaches: `content/legal/privacy.md` §7 promises
  // *"In your account settings you can export your personal data and request
  // deletion of your account"* and links there. This asserts the door opens —
  // the link exists on the published page, its target answers 200, and the
  // route it lands on is the one it named (no redirect loop back to sign-in,
  // and no 404).
  const email = `dsr-link-${Date.now()}@example.com`;
  await signUp(page, email);

  await page.goto('/legal/privacy');
  const link = page.locator(`a[href="${DATA_PRIVACY_PANE_PATH}"]`);
  await expect(link).toHaveCount(1);

  const response = await page.goto(DATA_PRIVACY_PANE_PATH);
  expect(response?.status()).toBe(200);
  expect(new URL(page.url()).pathname).toBe(DATA_PRIVACY_PANE_PATH);
  await expect(page.getByRole('heading', { name: 'Data & privacy', exact: true })).toBeVisible();
});

test('requesting an export from the pane opens a real request row and leaves the card in a non-idle state', async ({
  page,
}) => {
  // The interactive half of the export journey, and ONLY that half: the
  // request → build → ready → download composition is driven at the
  // integration tier, where the archive's bytes can be opened. What a browser
  // adds here is that the pane's own control opens the request — the Server
  // Action, the row, and the state the reader is left looking at.
  const email = `dsr-export-${Date.now()}@example.com`;
  await arriveOnThePane(page, email);

  await page.getByRole('button', { name: 'Request export' }).click();

  await expect.poll(() => adminDb.dataExportRequest.count(), { timeout: 20_000 }).toBe(1);

  // The card leaves its idle state. Either pill is a pass: whether the lane's
  // worker has built the archive by now is not this assertion's subject, and
  // pinning `In progress` would make it one.
  await expect(page.getByText(/In progress|Ready/).first()).toBeVisible();
});
