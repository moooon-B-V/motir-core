import { expect, test, type Page } from '@playwright/test';
import { adminDb, db, resetDatabase } from './_helpers/db-reset';
import { addVirtualAuthenticator, type VirtualAuthenticator } from './_helpers/webauthn';

// Story 8.12 · Subtask MOTIR-3615 — the passkey journey, end to end.
//
// This is the story's REGRESSION gate on the main lane: it runs on every pull
// request. The recorded, human-paced receipt is a different file in a different
// lane (`acceptance-passkeys.spec.ts`, MOTIR-3616).
//
// ⚠️ THE FILENAME IS LOAD-BEARING. `playwright.acceptance.config.ts` matches
// `**/acceptance*.spec.ts` and this config `testIgnore`s the same pattern, so a
// name starting with `acceptance` would move this spec silently OUT of the lane
// that gates merges and into one whose workflow only fires on pull requests that
// touch an acceptance spec — i.e. almost never.
//
// ── THREE THINGS THE NEXT READER WOULD OTHERWISE HAVE TO RE-DERIVE ────────
//
//   1. THE MECHANISM. There is no fingerprint reader on a CI runner. The browser
//      is given a fake one over the Chrome DevTools Protocol's `WebAuthn`
//      domain, wrapped in `./_helpers/webauthn.ts` — which this story wrote,
//      because nothing in this repo had ever driven WebAuthn before it.
//   2. THE LANE IS CHROMIUM-ONLY, and that is safe: CDP is a Chromium protocol
//      and `playwright.config.ts`'s `projects` array has exactly one entry. A
//      second project would strand this spec, so it would need a guard.
//   3. THE ORIGIN CHECK PASSES because `playwright.config.ts` sets
//      `MOTIR_BASE_URL: BASE_URL` on the webServer: `lib/baseUrl.ts` resolves
//      the lane's own origin, so the plugin's `rpID` / `origin` match the page
//      the browser is really on, whatever port this run took. Without that env
//      the assertion is rejected for an origin mismatch and the error points at
//      the passkey code rather than at the lane.
//
// Every wait below is on an authoritative signal — the response that commits the
// state, or a rendered assertion. No `waitForTimeout` (CLAUDE.md).

const EMAIL = 'e2e-passkey-user@example.com';
const PASSWORD = 'original-password-123';

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

async function signUp(page: Page): Promise<void> {
  await page.goto('/sign-up');
  await page.getByPlaceholder('Email address').fill(EMAIL);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Create a password').fill(PASSWORD);
  await page.getByRole('button', { name: /^(Create account|Creating account…)$/ }).click();
  await page.waitForURL('**/home');
}

/**
 * Register a passkey from the Security pane and wait on the VERIFY response —
 * the call that commits the credential — rather than on the row appearing.
 */
async function addPasskey(page: Page): Promise<void> {
  const verified = page.waitForResponse(
    (r) =>
      r.url().includes('/api/auth/passkey/verify-registration') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Add a passkey' }).click();
  expect((await verified).status()).toBe(200);
}

/**
 * End the session and land back on the signed-out card.
 *
 * `clearCookies` rather than driving the account menu — the same choice
 * `two-factor.spec.ts` makes, and for the same reason: this spec is about what
 * happens on the way back IN, and routing the way out through a popover adds a
 * surface that can fail for reasons this spec is not testing.
 */
async function signOut(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
}

test.describe('passkeys', () => {
  let authenticator: VirtualAuthenticator;

  test.beforeEach(async ({ context, page }) => {
    authenticator = await addVirtualAuthenticator(context, page);
  });

  test.afterEach(async () => {
    // ⚠️ NOT OPTIONAL. The context is reused across the tests in this file, so a
    // credential left behind would be offerable to the next test — and the
    // second test below asserts a ZERO state, which is precisely what a leaked
    // credential would silently turn into a false pass.
    await authenticator.remove();
  });

  test('register a passkey, sign in with it, and remove it', async ({ page }) => {
    // 1 — an ordinary password account.
    await signUp(page);

    // 2 — the pane's zero state.
    await page.goto('/settings/account/security');
    // `exact` — without it this matches the zero state's own "No passkeys yet"
    // heading too and fails strict mode.
    await expect(page.getByRole('heading', { name: 'Passkeys', exact: true })).toBeVisible();
    await expect(page.getByText('No passkeys yet')).toBeVisible();
    // The account holds no passkey, so the methods list carries no Passkey row.
    await expect(page.getByText('Counts as two factors')).toHaveCount(0);

    // 3 — register. The row arrives AND the methods card gains its entry, with
    // no navigation between the response and these assertions: that shared
    // state is the contract MOTIR-3612 owes and the thing two independent
    // islands would get wrong.
    const urlBefore = page.url();
    await addPasskey(page);
    await expect(page.getByRole('button', { name: 'Rename' })).toBeVisible();
    await expect(page.getByText('Counts as two factors')).toBeVisible();
    await expect(page.getByText('Managed above')).toBeVisible();
    expect(page.url()).toBe(urlBefore);
    expect(await authenticator.credentialCount()).toBe(1);

    // 4 — rename it.
    await page.getByRole('button', { name: 'Rename' }).click();
    const renamed = page.waitForResponse(
      (r) =>
        r.url().includes('/api/auth/passkey/update-passkey') && r.request().method() === 'POST',
    );
    // `getByRole('textbox')`, not `getByLabel('Name')` — the latter also matches
    // the DIALOG, whose accessible name is "Rename this passkey".
    await page.getByRole('textbox', { name: 'Name' }).fill('Work laptop');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await renamed).status()).toBe(200);
    await expect(page.getByText('Work laptop')).toBeVisible();

    // 5 — sign out, then in again WITHOUT a password. The email field is left
    // empty on purpose: that is what proves the discoverable-credential path,
    // and it is the shape that makes this better than typing anything.
    await signOut(page);
    await expect(page.getByPlaceholder('Email address')).toHaveValue('');

    const assertion = page.waitForResponse(
      (r) =>
        r.url().includes('/api/auth/passkey/verify-authentication') &&
        r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    expect((await assertion).status()).toBe(200);
    await page.waitForURL('**/home');

    // Asserted NEGATIVELY, because the point is what never happened: a passkey
    // mints a session outright, so neither the password step nor the two-factor
    // challenge is ever presented on this path.
    await expect(page.getByPlaceholder('Password')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /Two-factor|Confirm it's you/ })).toHaveCount(0);

    // 6 — remove it; the row goes and the methods entry goes with it.
    await page.goto('/settings/account/security');
    await expect(page.getByText('Work laptop')).toBeVisible();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    const deleted = page.waitForResponse(
      (r) =>
        r.url().includes('/api/auth/passkey/delete-passkey') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Remove passkey' }).click();
    expect((await deleted).status()).toBe(200);

    await expect(page.getByText('No passkeys yet')).toBeVisible();
    await expect(page.getByText('Counts as two factors')).toHaveCount(0);
  });

  test('a sign-in the SERVER cannot match is refused, and no session is created', async ({
    page,
  }) => {
    // This test starting from a zero state is also what proves the teardown
    // above works: the previous test registered a credential on this context.
    await signUp(page);
    await page.goto('/settings/account/security');
    await expect(page.getByText('No passkeys yet')).toBeVisible();

    await addPasskey(page);
    await expect(page.getByRole('button', { name: 'Rename' })).toBeVisible();

    // ⚠️ THE REFUSAL IS DRIVEN, NOT STUBBED — and this one is driven at the
    // SERVER, which is the arm the inline alert's `PASSKEY_NOT_FOUND` copy
    // exists for.
    //
    // The credential is ORPHANED rather than removed: the row is deleted
    // underneath the browser, which still holds the private half. So the
    // ceremony completes normally, the assertion is posted, and the SERVER is
    // the thing that cannot match it — which is the only way to exercise that
    // response from a test.
    //
    // (The other refusal, where the browser itself refuses, is the test below.)
    const deleted = await adminDb.passkey.deleteMany({});
    expect(deleted.count).toBe(1);

    await signOut(page);

    const refused = page.waitForResponse((r) =>
      r.url().includes('/api/auth/passkey/verify-authentication'),
    );
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    expect((await refused).status()).not.toBe(200);

    // No session: the reader is still on the sign-in card, and the card says how
    // to get through rather than only what failed.
    // Scoped past Next's `__next-route-announcer__`, which is also `role="alert"`
    // and is present on every page — an unscoped `getByRole('alert')` is a strict
    // -mode violation on any route, not just this one.
    await expect(
      page.getByRole('alert').filter({ hasText: /No passkey on this device/ }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in/);
    // Still usable — a refusal must not leave the control stuck pending.
    await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeEnabled();
  });

  test('an authenticator that cannot verify the user is refused in the BROWSER', async ({
    page,
  }) => {
    // The client-side arm. `lib/auth/index.ts` pins
    // `userVerification: 'required'` (MOTIR-3610), so an authenticator that
    // reports the user as unverified cannot satisfy the request.
    //
    // ⚠️ TWO THINGS HERE WERE MEASURED, NOT REASONED, AND THE FIRST GUESS WAS
    // WRONG BOTH TIMES:
    //
    //   1. `verify-authentication` is NEVER CALLED. Chrome refuses the ceremony
    //      itself, `startAuthentication` throws, and nothing is posted — so a
    //      spec that waits on that response times out on a flow that is
    //      behaving correctly. That was this file's first failure.
    //   2. The code the plugin's client surfaces is NOT the cancellation code.
    //      The plausible reading — that the browser collapses "you dismissed
    //      it" and "this device cannot verify you" into one indistinguishable
    //      `NotAllowedError`, so both must draw nothing — is FALSE here: this
    //      path raises a distinct `WebAuthnError`, which the plugin surfaces
    //      verbatim, and the UI therefore treats it as the dead end it is.
    //
    // That is the right product answer as well as the observed one. A reader who
    // DISMISSED the sheet made a decision and gets silence (asserted by the
    // component tests, which can name the code); a reader whose device simply
    // cannot do this clicked and got nothing, and needs to be told the way
    // through.
    await signUp(page);
    await page.goto('/settings/account/security');
    await addPasskey(page);
    await expect(page.getByRole('button', { name: 'Rename' })).toBeVisible();

    await signOut(page);
    await authenticator.setUserVerified(false);

    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();

    await expect(
      page.getByRole('alert').filter({ hasText: /No passkey on this device/ }),
    ).toBeVisible();
    // No session, and no exception escaped to the page.
    await expect(page).toHaveURL(/\/sign-in/);
    expect(pageErrors).toEqual([]);
    // The control recovers — a refusal must never leave it stuck pending.
    await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeEnabled();
    await expect(page.getByText(/waiting for your browser/i)).toHaveCount(0);
  });
});
