// E2E: the Account › Profile pane (Story 8.8 · Subtask 8.8.26) — the Profile
// feature proven end-to-end over the real stack. This is the story-closing
// `verification_recipe` for the pane the 8.8.24 slices assembled: the scaffold
// (name inline-edit + email display), avatar upload/remove (8.8.24a), verified
// email change (8.8.24b), and password & security (8.8.24c).
//
// It drives the human click-path, waiting ONLY on authoritative signals (route
// responses, the file outbox, a real re-sign-in) — never the optimistic UI
// alone, per the E2E discipline in motir-core/CLAUDE.md. The PER-METHOD service
// branches (every password/email-change error, the avatar GC, the DTO read-back)
// are proven at the unit/integration tiers (profile-service / email-change /
// users-service-password + tests/integration/profile-lifecycle); this spec does
// NOT re-assert those — it exercises the user-visible PANE through the browser.
//
// Account settings are PERSONAL (no active project needed — the area layout gates
// on session only), so a freshly signed-up user reaches the pane directly; no
// workspace/project cookie pinning is required (unlike the project-settings area).
//
// Email delivery uses the dev-only 'file' provider (EMAIL_PROVIDER=file in
// playwright.config.ts) + the Inngest dev server, so the email-change confirm
// link lands in /tmp/motir-test-emails.jsonl, which `waitForEmail` polls. Avatar
// uploads go through the real /api/upload/avatar route against the E2E blob mock
// (E2E_TEST_BLOB=1); the browser-side read of the returned public URL is
// fulfilled by `page.route` (the attachments-spec precedent), so nothing leaves
// localhost.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signUp, signIn, SHELL_PASSWORD } from './_helpers/shell-session';
import { waitForEmail, extractResetUrl } from './_helpers/email-capture';
import { usersService } from '@/lib/services/usersService';

// A minimal valid 1×1 PNG — the avatar upload payload. PNG passes the
// AvatarField client allowlist (PNG/JPG) and the /api/upload/avatar MIME gate.
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// The account-settings rail landmark (`<nav aria-label="Account settings">`),
// scoped so nav-row checks never collide with page content.
function accountNav(page: Page) {
  return page.getByRole('navigation', { name: 'Account settings' });
}

// The main content region (`#main`). The account rail header ALSO renders the
// user's name, email, and avatar, so content assertions scope here to avoid a
// strict-mode collision with the rail's copy of the same values.
function main(page: Page) {
  return page.locator('#main');
}

test.describe('profile — the Account › Profile pane journey', () => {
  // Each test signs up a fresh credential user (argon2 hash) + one or more real
  // sign-ins — generous headroom over the 30s default.
  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async () => {
    await resetDatabase();
  });

  test.afterAll(async () => {
    // Release the worktree-side Prisma pool so the runner exits cleanly.
    await db.$disconnect();
  });

  test('@smoke nav row active (not "Soon") → name inline-edit persists → avatar upload + remove', async ({
    page,
  }) => {
    await signUp(page, 'profile-e2e@example.com'); // name = "profile-e2e" → initial "P"

    // ── Enter the pane: the rail swaps to the account-settings nav ────────────
    await page.goto('/settings/account/profile');
    // The page heading (h2) — the card title is a sibling h3 "Profile", so pin the level.
    await expect(
      main(page).getByRole('heading', { name: 'Profile', exact: true, level: 2 }),
    ).toBeVisible();

    // The Profile rail row is a REAL, active link — not the disabled "Soon"
    // placeholder it shipped as in 7.8.2 (a placeholder renders as a
    // non-interactive span with a "Soon" badge, so a resolving role=link proves
    // it was lit up).
    const profileLink = accountNav(page).getByRole('link', { name: 'Profile', exact: true });
    await expect(profileLink).toBeVisible();
    await expect(profileLink).toHaveAttribute('aria-current', 'page');

    // The rail rows navigate (hop to Language and back) — proving they're live
    // links, the "active, not Soon" point made interactive.
    await accountNav(page).getByRole('link', { name: 'Language', exact: true }).click();
    await page.waitForURL('**/settings/account/language');
    await accountNav(page).getByRole('link', { name: 'Profile', exact: true }).click();
    await page.waitForURL('**/settings/account/profile');

    // ── Name inline-edit → persists across a reload ──────────────────────────
    await page.getByRole('button', { name: 'Edit' }).click();
    const nameInput = page.getByRole('textbox', { name: 'Name' });
    await expect(nameInput).toBeVisible();
    await nameInput.fill('Renamed Person');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Name updated', { exact: true })).toBeVisible(); // success toast
    await expect(main(page).getByText('Renamed Person', { exact: true })).toBeVisible();

    // Authoritative proof it persisted: reload re-reads from Postgres.
    await page.reload();
    await expect(main(page).getByText('Renamed Person', { exact: true })).toBeVisible();

    // ── Avatar upload → persists → remove reverts to initials ────────────────
    // Fulfil the browser-side read of the returned blob URL (the server-side
    // put is mocked by E2E_TEST_BLOB; this is the attachments-spec seam so the
    // <img> actually paints rather than rendering broken).
    await page.route(/\.public\.blob\.vercel-storage\.com\//, (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: PNG_1x1 }),
    );

    // Before upload: initials fallback, no image, no Remove control.
    await expect(main(page).getByRole('img', { name: 'Your avatar' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0);

    const uploadResp = page.waitForResponse(
      (r) => r.url().endsWith('/api/upload/avatar') && r.request().method() === 'POST',
    );
    await page.locator('input[type="file"]').setInputFiles({
      name: 'avatar.png',
      mimeType: 'image/png',
      buffer: PNG_1x1,
    });
    expect((await uploadResp).status()).toBe(200);

    const avatar = main(page).getByRole('img', { name: 'Your avatar' });
    await expect(avatar).toBeVisible();
    await expect(avatar).toHaveAttribute('src', /\.public\.blob\.vercel-storage\.com\/avatars\//);
    await expect(page.getByText('Photo updated', { exact: true })).toBeVisible();

    // Persisted across reload (the user row's `image` column).
    await page.reload();
    await expect(main(page).getByRole('img', { name: 'Your avatar' })).toBeVisible();

    // Remove → confirm modal → reverts to initials (no image).
    await page.getByRole('button', { name: 'Remove' }).click();
    const removeDialog = page.getByRole('alertdialog', { name: 'Remove photo?' });
    await expect(removeDialog).toBeVisible();
    await removeDialog.getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByText('Photo removed', { exact: true })).toBeVisible();
    await expect(main(page).getByRole('img', { name: 'Your avatar' })).toHaveCount(0);
  });

  test('password & security: validation → wrong-current → change → sign in with the NEW password', async ({
    page,
  }) => {
    const email = 'profile-pw-e2e@example.com';
    await signUp(page, email); // credential account, password = SHELL_PASSWORD
    const NEW_PASSWORD = 'brand-new-profile-pass-456';

    await page.goto('/settings/account/profile');
    await page.getByRole('button', { name: 'Change password' }).click();
    const modal = page.getByRole('dialog', { name: 'Change password' });
    await expect(modal).toBeVisible();

    const current = modal.getByLabel('Current password', { exact: true });
    const next = modal.getByLabel('New password', { exact: true });
    const confirm = modal.getByLabel('Confirm new password', { exact: true });
    const submit = modal.getByRole('button', { name: 'Update password' });

    // ── Client-side validation (no round-trip) ───────────────────────────────
    // Too-short new password.
    await current.fill(SHELL_PASSWORD);
    await next.fill('short');
    await confirm.fill('short');
    await submit.click();
    await expect(modal.getByText('New password must be at least 8 characters.')).toBeVisible();

    // Confirmation mismatch.
    await next.fill(NEW_PASSWORD);
    await confirm.fill('does-not-match-789');
    await submit.click();
    await expect(modal.getByText("Those passwords don't match.")).toBeVisible();

    // ── Wrong current password → server 's typed error inline ────────────────
    await current.fill('wrong-current-password');
    await next.fill(NEW_PASSWORD);
    await confirm.fill(NEW_PASSWORD);
    await submit.click();
    await expect(modal.getByText('The current password is incorrect.')).toBeVisible();
    await expect(modal).toBeVisible(); // stays open on error

    // ── Correct current → success toast, modal closes ────────────────────────
    await current.fill(SHELL_PASSWORD);
    await submit.click();
    await expect(page.getByText('Password updated', { exact: true })).toBeVisible();
    await expect(modal).toBeHidden();

    // ── The REAL proof: sign out, sign in with the NEW password ──────────────
    await page.context().clearCookies();
    await signIn(page, email, NEW_PASSWORD);
    await expect(page).toHaveURL(/\/dashboard/);

    // …and the OLD password no longer works (the anti-enumeration inline error).
    await page.context().clearCookies();
    await page.goto('/sign-in');
    await page.getByPlaceholder('Email address').fill(email);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByPlaceholder('Password').fill(SHELL_PASSWORD);
    await page.getByRole('button', { name: /^(Continue|Signing in…)$/ }).click();
    await expect(page.getByText(/That password isn't right/)).toBeVisible();
    expect(page.url()).toMatch(/\/sign-in/);
  });

  test('change email: validation + taken → pending-confirmation → confirm link swaps the address', async ({
    page,
  }) => {
    const email = 'profile-email-e2e@example.com';
    const takenEmail = 'profile-taken-e2e@example.com';
    const newEmail = 'profile-moved-e2e@example.com';

    await signUp(page, email);
    // A second REAL account so the email-taken path is genuine (not a stub).
    await usersService.createUser({
      email: takenEmail,
      password: SHELL_PASSWORD,
      name: 'Taken User',
    });

    await page.goto('/settings/account/profile');
    await page.getByRole('button', { name: 'Change email' }).click();
    const modal = page.getByRole('dialog', { name: 'Change email' });
    await expect(modal).toBeVisible();

    const field = modal.getByLabel('New email', { exact: true });
    const submit = modal.getByRole('button', { name: 'Send confirmation' });

    // ── Saving disabled while empty ──────────────────────────────────────────
    await expect(submit).toBeDisabled();

    // ── Invalid format (client-side) ─────────────────────────────────────────
    await field.fill('not-an-email');
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(modal.getByText('Enter a valid email address.')).toBeVisible();

    // ── Same as current address (client-side) ────────────────────────────────
    await field.fill(email);
    await submit.click();
    await expect(modal.getByText("That's already your email address.")).toBeVisible();

    // ── Taken by another account → route 409 → inline box error ──────────────
    await field.fill(takenEmail);
    const takenResp = page.waitForResponse(
      (r) =>
        r.url().includes('/api/account/request-email-change') && r.request().method() === 'POST',
    );
    await submit.click();
    expect((await takenResp).status()).toBe(409);
    await expect(modal.getByText('That email is already in use by another account.')).toBeVisible();

    // ── Valid new address → route 200 → pending banner + confirmation toast ──
    await field.fill(newEmail);
    const okResp = page.waitForResponse(
      (r) =>
        r.url().includes('/api/account/request-email-change') && r.request().method() === 'POST',
    );
    await submit.click();
    expect((await okResp).status()).toBe(200);
    await expect(modal).toBeHidden();
    await expect(page.getByText('Confirmation sent', { exact: true })).toBeVisible();
    await expect(page.getByText(`Pending → ${newEmail}`)).toBeVisible();

    // ── Confirm from the new inbox → the swap actually happens ────────────────
    const confirmEmail = await waitForEmail(newEmail);
    expect(confirmEmail.subject).toContain('Confirm your new Motir email');
    const confirmUrl = extractResetUrl(confirmEmail); // first http(s) URL = the confirm link
    await page.goto(confirmUrl);
    await page.waitForURL(/\/settings\/account/);

    // The email is now the new address: re-read the Email row.
    await page.goto('/settings/account/profile');
    await expect(main(page).getByText(newEmail, { exact: true })).toBeVisible();

    // The strongest proof — the new address is now the SIGN-IN key.
    await page.context().clearCookies();
    await signIn(page, newEmail, SHELL_PASSWORD);
    await expect(page).toHaveURL(/\/dashboard/);
  });
});
