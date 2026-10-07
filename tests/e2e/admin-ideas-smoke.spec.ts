import { expect, test } from '@playwright/test';
import { adminDb, db, resetDatabase } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';

/**
 * The console's IDEAS list and detail — MOTIR-7680, design
 * `platform-admin/design-notes.md` § Ideas.
 *
 * ⚠️ A SMOKE SPEC IN THE BUILDING CARD'S OWN COMMIT, for the reason
 * `admin-org-lookup.spec.ts` gives: a server/client-seam defect on a route
 * nobody opens survives every later card's green build. The render tests
 * (`tests/platform/ideasConsolePage.test.tsx`) prove what the page draws; only
 * a browser proves it hydrates, and that a non-staff person receives the app
 * 404 rather than a 403 or a redirect. The story's full flow is MOTIR-7683's.
 */

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('@smoke platform staff reach the Ideas list and an idea; a tenant user gets a 404', async ({
  page,
}) => {
  const email = 'e2e-admin-ideas@example.com';
  await signUp(page, email);
  const user = await db.user.findUniqueOrThrow({ where: { email } });

  // `idea` carries FORCED row-level security whose write policy reads the
  // platform-staff context, so the fixture binds it for its own transaction.
  const idea = await adminDb.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.platform_staff', 'true', true)`;
    return tx.idea.create({
      data: {
        slug: 'e2e-smoke-idea',
        kind: 'direction',
        category: 'ecommerce',
        title: 'Stop returns before they happen',
        pitch: 'Predict the return before the parcel ships.',
        capabilities: ['Scores every order'],
      },
    });
  });

  // ── A tenant user gets the ordinary app 404 on both routes.
  expect((await page.goto('/admin/ideas'))?.status()).toBe(404);
  expect((await page.goto(`/admin/ideas/${idea.slug}`))?.status()).toBe(404);

  // ── The same person as support, the lowest standing that reads the console.
  //    The gate reads a fresh row per request, so the next navigation sees it.
  await db.user.update({ where: { id: user.id }, data: { platformRole: 'support' } });

  expect((await page.goto('/admin/ideas'))?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Ideas', level: 1 })).toBeVisible();
  const row = page.getByRole('link', { name: 'Stop returns before they happen' });
  await expect(row).toBeVisible();

  // ── A filter is a server-answered URL change: the status control writes it.
  await page
    .getByRole('group', { name: 'Status' })
    .getByRole('button', { name: 'Retired' })
    .click();
  await expect(page).toHaveURL(/\/admin\/ideas\?status=retired/);
  await expect(page.getByRole('heading', { name: 'No ideas match these filters' })).toBeVisible();

  // ── The detail renders, read-only for support.
  expect((await page.goto(`/admin/ideas/${idea.slug}`))?.status()).toBe(200);
  await expect(
    page.getByRole('heading', { name: 'Stop returns before they happen', level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole('main').getByText('Read-only for support.')).toBeVisible();
});
