// E2E: the Settings → Account → API tokens pane (Story 7.8 · Subtask 7.8.3) —
// the human half of the PAT lifecycle, proven end-to-end over the real stack.
// It drives the acceptance recipe: create → shown-once copy → revoke → the
// muted revoked-state render, plus the secret-never-reappears guarantee.
//
// Account settings are PERSONAL (no project needed), so a freshly signed-up user
// reaches the pane directly. Every mutation waits on its route response (the
// authoritative signal — never the optimistic UI alone, per the E2E discipline).

import { expect, test } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';

test.describe.configure({ timeout: 120_000 });

// The shown-once Copy affordance writes to the clipboard — grant it so the
// success toast ("Token copied") fires deterministically rather than the
// copy-failed fallback.
test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('create → shown-once copy → revoke → revoked render', async ({ page }) => {
  await signUp(page, 'tokens-e2e@example.com');

  await page.goto('/settings/account/api-tokens');
  // `exact` — "API tokens" is a substring of the empty-state heading "No API
  // tokens yet", which is also an <h2>; the page-head is the exact match.
  await expect(page.getByRole('heading', { name: 'API tokens', exact: true })).toBeVisible();

  // Empty state — no tokens yet.
  await expect(page.getByRole('heading', { name: 'No API tokens yet' })).toBeVisible();

  // CREATE — open the modal from the empty state, name the token, submit.
  await page.getByRole('button', { name: 'Create token' }).first().click();
  const createDialog = page.getByRole('dialog');
  await expect(createDialog.getByRole('heading', { name: 'Create API token' })).toBeVisible();
  await createDialog.getByLabel('Label').fill('claude-code');

  const createResp = page.waitForResponse(
    (r) => r.url().endsWith('/api/me/api-tokens') && r.request().method() === 'POST',
  );
  await createDialog.getByRole('button', { name: 'Create token', exact: true }).click();
  expect((await createResp).status()).toBe(201);

  // SHOWN-ONCE — the full secret appears exactly once with a Copy button.
  await expect(createDialog.getByRole('heading', { name: 'Token created' })).toBeVisible();
  const secret = createDialog.getByTestId('api-token-secret');
  await expect(secret).toBeVisible();
  const secretText = ((await secret.textContent()) ?? '').trim();
  expect(secretText.startsWith('motir_pat_')).toBe(true);

  // Copy → success toast.
  await createDialog.getByRole('button', { name: 'Copy' }).click();
  await expect(page.getByText('Token copied')).toBeVisible();

  // Done closes the modal; the row now shows only the truncated PREFIX.
  await createDialog.getByRole('button', { name: 'Done' }).click();
  await expect(createDialog).toBeHidden();

  const row = page.getByRole('row', { name: /claude-code/ });
  await expect(row).toBeVisible();
  await expect(row.getByText(/^motir_pat_.+…$/)).toBeVisible();
  // The full secret is irretrievable after close — only the prefix remains.
  await expect(page.getByText(secretText, { exact: true })).toHaveCount(0);

  // REVOKE — confirm, wait on the DELETE, then the row flips to muted "Revoked".
  await row.getByRole('button', { name: 'Revoke token claude-code' }).click();
  const revokeDialog = page.getByRole('dialog');
  await expect(revokeDialog.getByRole('heading', { name: 'Revoke "claude-code"?' })).toBeVisible();

  const revokeResp = page.waitForResponse(
    (r) => /\/api\/me\/api-tokens\/[^/]+$/.test(r.url()) && r.request().method() === 'DELETE',
  );
  await revokeDialog.getByRole('button', { name: 'Revoke token', exact: true }).click();
  expect((await revokeResp).status()).toBe(200);

  await expect(page.getByRole('row', { name: /claude-code/ }).getByText('Revoked')).toBeVisible();
});
