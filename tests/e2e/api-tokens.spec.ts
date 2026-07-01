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
  await expect(page.getByText('Token copied', { exact: true })).toBeVisible();

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

// The expiry half of the create flow (Story 7.7 · Subtask 7.7.12, the
// story-closing settings check): a token minted with a CHOSEN expiry (not the
// 90-day default) lists that expiry as a relative "in N days", proving the
// label + expiry → list-shows-expiry path the card calls out.
test('create with a chosen expiry → the list shows the expiry', async ({ page }) => {
  await signUp(page, 'tokens-expiry-e2e@example.com');

  await page.goto('/settings/account/api-tokens');
  await expect(page.getByRole('heading', { name: 'API tokens', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Create token' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Create API token' })).toBeVisible();
  await dialog.getByLabel('Label').fill('ci-token');

  // Pick a non-default expiry via the Expires combobox (default is 90 days).
  await dialog.getByRole('combobox', { name: 'Expires' }).click();
  await dialog.getByRole('option', { name: '30 days' }).click();

  const createResp = page.waitForResponse(
    (r) => r.url().endsWith('/api/me/api-tokens') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Create token', exact: true }).click();
  expect((await createResp).status()).toBe(201);

  await expect(dialog.getByRole('heading', { name: 'Token created' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();

  // The row carries the truncated prefix AND the chosen expiry as "in N days".
  const row = page.getByRole('row', { name: /ci-token/ });
  await expect(row).toBeVisible();
  await expect(row.getByText(/^motir_pat_.+…$/)).toBeVisible();
  await expect(row.getByText(/in \d+ days/)).toBeVisible();
});

// Permission-scope selection (Story 7.8 · Subtask 7.8.20, over the 7.7.19 UI):
// the human half of the scope contract proven end-to-end — create a token with
// a CUSTOM scope selection, confirm the shown-once secret, and confirm the list
// surfaces the granted scopes (the "Custom" summary + the per-scope detail
// chips, with the off scopes absent and no "Can delete" pill).
test('create with a custom scope selection → shown-once + the list shows the granted scopes', async ({
  page,
}) => {
  await signUp(page, 'tokens-scopes-e2e@example.com');

  await page.goto('/settings/account/api-tokens');
  await expect(page.getByRole('heading', { name: 'API tokens', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Create token' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Create API token' })).toBeVisible();
  await dialog.getByLabel('Label').fill('scoped-custom');

  // The Permissions picker opens on the default grant (all-on-except-delete):
  // a work-item write is on, the irreversible delete is off.
  await expect(dialog.getByRole('switch', { name: 'Edit work items', exact: true })).toBeChecked();
  await expect(
    dialog.getByRole('switch', { name: 'Delete work items', exact: true }),
  ).not.toBeChecked();

  // Narrow to a CUSTOM subset: turn OFF Manage sprints + Connect integrations
  // (keeping Read + Edit + Archive). Not the default set, not read-only, not
  // full → the list will summarise it as "Custom".
  await dialog.getByRole('switch', { name: 'Manage sprints', exact: true }).click();
  await dialog.getByRole('switch', { name: 'Connect integrations', exact: true }).click();
  await expect(
    dialog.getByRole('switch', { name: 'Manage sprints', exact: true }),
  ).not.toBeChecked();

  const createResp = page.waitForResponse(
    (r) => r.url().endsWith('/api/me/api-tokens') && r.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: 'Create token', exact: true }).click();
  expect((await createResp).status()).toBe(201);

  // SHOWN-ONCE — the full secret appears with its motir_pat_ prefix.
  await expect(dialog.getByRole('heading', { name: 'Token created' })).toBeVisible();
  const secret = dialog.getByTestId('api-token-secret');
  await expect(secret).toBeVisible();
  expect(((await secret.textContent()) ?? '').trim().startsWith('motir_pat_')).toBe(true);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();

  // The row summarises the grant as "Custom" and carries NO "Can delete" pill.
  const row = page.getByRole('row', { name: /scoped-custom/ });
  await expect(row).toBeVisible();
  await expect(row.getByText('Custom', { exact: true })).toBeVisible();
  await expect(row.getByText('Can delete')).toHaveCount(0);

  // Disclosing the scope detail lists exactly the granted scopes — the kept
  // three present, the toggled-off two and delete absent.
  await row.getByRole('button', { name: 'Show scopes for scoped-custom' }).click();
  await expect(page.getByText('Read everything', { exact: true })).toBeVisible();
  await expect(page.getByText('Edit work items', { exact: true })).toBeVisible();
  await expect(page.getByText('Archive work items', { exact: true })).toBeVisible();
  await expect(page.getByText('Manage sprints', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Connect integrations', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Delete work items', { exact: true })).toHaveCount(0);
});

// The DEFAULT grant (all-minus-delete): creating without touching the picker
// yields a "Standard" token with delete OFF — the user's "enable all but
// disable delete" requirement, proven through the modal + list.
test('create a default token → "Standard", and delete is off', async ({ page }) => {
  await signUp(page, 'tokens-default-e2e@example.com');

  await page.goto('/settings/account/api-tokens');
  await expect(page.getByRole('heading', { name: 'API tokens', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Create token' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Create API token' })).toBeVisible();
  await dialog.getByLabel('Label').fill('scoped-default');

  // Delete is off by default — the deliberate one-scope opt-in.
  await expect(
    dialog.getByRole('switch', { name: 'Delete work items', exact: true }),
  ).not.toBeChecked();

  const createResp = page.waitForResponse(
    (r) => r.url().endsWith('/api/me/api-tokens') && r.request().method() === 'POST',
  );
  // Submit WITHOUT changing scopes → the default all-minus-delete grant.
  await dialog.getByRole('button', { name: 'Create token', exact: true }).click();
  expect((await createResp).status()).toBe(201);

  await expect(dialog.getByRole('heading', { name: 'Token created' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toBeHidden();

  // The row reads "Standard" with NO "Can delete" pill, and the disclosed detail
  // omits the delete scope.
  const row = page.getByRole('row', { name: /scoped-default/ });
  await expect(row).toBeVisible();
  await expect(row.getByText('Standard', { exact: true })).toBeVisible();
  await expect(row.getByText('Can delete')).toHaveCount(0);

  await row.getByRole('button', { name: 'Show scopes for scoped-default' }).click();
  await expect(page.getByText('Read everything', { exact: true })).toBeVisible();
  await expect(page.getByText('Delete work items', { exact: true })).toHaveCount(0);
});
