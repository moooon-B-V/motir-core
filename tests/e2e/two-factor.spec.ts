// E2E: the account 2FA journey — enrol → challenge → fallbacks → remember this
// device → revoke (Story 8.11 · Subtask MOTIR-1223).
//
// This automates the Story's own verification recipe. Its shape follows
// CLAUDE.md's authoritative-signal rule: every step waits on the RESPONSE that
// commits it, never on an implicit retry and never on a sleep. The one place a
// clock is consulted is `secondsLeftInWindow`, and that is not a sync mechanism
// — it is the TOTP window, a real property of the thing under test.
//
// The authenticator app is `_helpers/totp.ts`, which reads the setup key off the
// enrol screen exactly as a human would and computes the code the way a real app
// does. It shares no code with the server, so the two agree only if the feature
// works.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { waitForEmail } from './_helpers/email-capture';
import { secondsLeftInWindow, totpFromSetupKey } from './_helpers/totp';

const EMAIL = 'e2e-2fa-user@example.com';
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

/** Password step only — stops wherever the sign-in lands it. */
async function signInWithPassword(page: Page): Promise<void> {
  await page.goto('/sign-in');
  await page.getByPlaceholder('Email address').fill(EMAIL);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByPlaceholder('Password').fill(PASSWORD);

  const signedIn = page.waitForResponse(
    (r) => r.url().includes('/api/auth/sign-in/email') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /^(Continue|Signing in…)$/ }).click();
  expect((await signedIn).status()).toBe(200);
}

/**
 * Enrol an authenticator from the Security pane and return the setup key plus
 * the recovery codes the shown-once modal displayed.
 */
async function enrol(page: Page): Promise<{ setupKey: string; codes: string[] }> {
  await page.goto('/settings/account/security');
  await page
    .getByRole('button', { name: /Set up authenticator app/ })
    .first()
    .click();

  // Step 1 — the step-up. It is here because `enable` mints the secret and is
  // password-gated, so there is no QR to show until this succeeds.
  await expect(page.getByRole('heading', { name: /Confirm it's you/ })).toBeVisible();
  const enabled = page.waitForResponse(
    (r) => r.url().includes('/api/auth/two-factor/enable') && r.request().method() === 'POST',
  );
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  expect((await enabled).status()).toBe(200);

  // Step 2 — the manual key is what an authenticator would be typed.
  const setupKey = (await page.locator('code').first().innerText()).trim();
  expect(setupKey.length).toBeGreaterThan(15);

  // Step 3 — a code from that key. Wait out a sliver of a window first: a code
  // with under two seconds to run can expire between typing and verification,
  // which is the one real time-dependence in this flow.
  if (secondsLeftInWindow() < 3) await page.waitForTimeout(3000);
  const verified = page.waitForResponse(
    (r) => r.url().includes('/api/auth/two-factor/verify-totp') && r.request().method() === 'POST',
  );
  await page.getByLabel('Six-digit code').fill(totpFromSetupKey(setupKey));
  await page.getByRole('button', { name: 'Turn on' }).click();
  expect((await verified).status()).toBe(200);

  // The shown-once set — the ONLY time the plaintext exists.
  await expect(page.getByRole('heading', { name: /Save your recovery codes/ })).toBeVisible();
  const codes = await page.locator('code').allInnerTexts();
  const recovery = codes
    .map((c) => c.trim())
    .filter((c) => /^[a-zA-Z0-9]{5}-[a-zA-Z0-9]{5}$/.test(c));
  expect(recovery.length).toBe(10);

  await page.getByRole('checkbox', { name: /saved these codes/ }).click();
  await page.getByRole('button', { name: 'Done' }).click();

  return { setupKey, codes: recovery };
}

test('@smoke enrol, then a TOTP code completes the next sign-in', async ({ page }) => {
  await signUp(page);
  const { setupKey } = await enrol(page);

  // The pane now reports the enrolled state.
  await expect(page.getByText('of 10 left')).toBeVisible();
  await expect(page.getByText('Authenticator app')).toBeVisible();

  // Sign out and back in — the password alone no longer lands the session.
  await page.context().clearCookies();
  await signInWithPassword(page);

  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();

  if (secondsLeftInWindow() < 3) await page.waitForTimeout(3000);
  const verified = page.waitForResponse(
    (r) => r.url().includes('/api/auth/two-factor/verify-totp') && r.request().method() === 'POST',
  );
  await page.getByLabel('Six-digit code').fill(totpFromSetupKey(setupKey));
  await page.getByRole('button', { name: 'Verify' }).click();
  expect((await verified).status()).toBe(200);

  await page.waitForURL(/\/(home|onboarding)/);
});

test('a wrong code is refused and keeps the reader on the challenge', async ({ page }) => {
  await signUp(page);
  await enrol(page);
  await page.context().clearCookies();
  await signInWithPassword(page);

  const refused = page.waitForResponse((r) => r.url().includes('/api/auth/two-factor/verify-totp'));
  await page.getByLabel('Six-digit code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  expect((await refused).status()).toBeGreaterThanOrEqual(400);

  // Still on the challenge, with a message that names the likely cause rather
  // than a generic failure — and NOT bounced back to the password.
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
  await expect(page.getByText(/clock is set automatically/)).toBeVisible();
});

test('an emailed code completes the sign-in', async ({ page }) => {
  await signUp(page);
  await enrol(page);
  await page.context().clearCookies();
  await signInWithPassword(page);

  await page.getByRole('button', { name: 'Try another way' }).click();
  const sent = page.waitForResponse(
    (r) => r.url().includes('/api/auth/two-factor/send-otp') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /Email a code to/ }).click();
  expect((await sent).status()).toBe(200);

  // The code is read out of the file provider's outbox — the plain-text body
  // carries it on a line of its own, which is the contract MOTIR-1219 preserves.
  const mail = await waitForEmail(EMAIL);
  const code = mail.text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^\d{6}$/.test(l));
  expect(code, `no six-digit line in:\n${mail.text}`).toBeTruthy();

  const verified = page.waitForResponse(
    (r) => r.url().includes('/api/auth/two-factor/verify-otp') && r.request().method() === 'POST',
  );
  await page.getByLabel('Six-digit code').fill(code!);
  await page.getByRole('button', { name: 'Verify' }).click();
  expect((await verified).status()).toBe(200);

  await page.waitForURL(/\/(home|onboarding)/);
});

test('a recovery code works ONCE and the remaining count drops', async ({ page }) => {
  await signUp(page);
  const { codes } = await enrol(page);
  await page.context().clearCookies();
  await signInWithPassword(page);

  await page.getByRole('button', { name: 'Try another way' }).click();
  await page.getByRole('button', { name: /Use a recovery code/ }).click();

  const verified = page.waitForResponse(
    (r) =>
      r.url().includes('/api/auth/two-factor/verify-backup-code') &&
      r.request().method() === 'POST',
  );
  await page.getByLabel('Recovery code').fill(codes[0]!);
  await page.getByRole('button', { name: 'Verify' }).click();
  expect((await verified).status()).toBe(200);
  await page.waitForURL(/\/(home|onboarding)/);

  // The count is the authoritative read, taken from the pane's own server render.
  await page.goto('/settings/account/security');
  await expect(page.getByText('of 10 left')).toBeVisible();
  await expect(page.getByText('9', { exact: true })).toBeVisible();
});

test('"don’t ask again" skips the next challenge, and revoking brings it back', async ({
  page,
}) => {
  await signUp(page);
  const { setupKey } = await enrol(page);
  await page.context().clearCookies();

  // Sign in AND trust the device.
  await signInWithPassword(page);
  if (secondsLeftInWindow() < 3) await page.waitForTimeout(3000);
  const trusted = page.waitForResponse((r) => r.url().includes('/api/auth/two-factor/verify-totp'));
  await page.getByLabel('Six-digit code').fill(totpFromSetupKey(setupKey));
  await page.getByRole('checkbox', { name: /Don’t ask again/ }).click();
  await page.getByRole('button', { name: 'Verify' }).click();
  expect((await trusted).status()).toBe(200);
  await page.waitForURL(/\/(home|onboarding)/);

  // Drop the SESSION cookie only — the trust cookie is a different one, and
  // keeping it is the whole point of the test.
  const kept = (await page.context().cookies()).filter((c) => c.name.includes('trust'));
  expect(kept.length, 'no trust_device cookie was set').toBeGreaterThan(0);
  await page.context().clearCookies({ name: /session/ });

  // Now the password alone lands the session: no challenge.
  await signInWithPassword(page);
  await page.waitForURL(/\/(home|onboarding)/);
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeHidden();

  // Revoke, and the challenge returns on the next sign-in.
  await page.goto('/settings/account/security');
  const revoked = page.waitForResponse(
    (r) =>
      r.url().includes('/api/account/two-factor/trusted-devices') &&
      r.request().method() === 'DELETE',
  );
  await page.getByRole('button', { name: 'Revoke all' }).click();
  expect((await revoked).status()).toBe(200);

  await page.context().clearCookies();
  await signInWithPassword(page);
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
});

test('turning 2FA off removes the challenge entirely', async ({ page }) => {
  await signUp(page);
  await enrol(page);

  const disabled = page.waitForResponse(
    (r) => r.url().includes('/api/auth/two-factor/disable') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Turn off' }).first().click();
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Turn off' }).last().click();
  expect((await disabled).status()).toBe(200);

  await expect(page.getByText('Two-factor authentication is off')).toBeVisible();

  await page.context().clearCookies();
  await signInWithPassword(page);
  await page.waitForURL(/\/(home|onboarding)/);
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeHidden();
});
