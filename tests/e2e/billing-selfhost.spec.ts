import { expect, test } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { seedBillingOwner } from './_helpers/billing';

// Subtask 8.1.10 — the SELF-HOST gate, the inverse of the cloud-on journeys. This
// spec runs in the MAIN (off-cloud) lane (no MOTIR_CLOUD), so it asserts the whole
// commercial surface is ABSENT: the billing route 404s, the billing menu row is
// gone, and the AI paywall never fires (the entitlement read degrades to
// not-applicable). It deliberately lives here, not in the cloud-on billing lane —
// the off-cloud server is exactly the self-host build (mirrors org-admin.spec.ts,
// which already asserts the billing row absent off-cloud).

test.describe.configure({ timeout: 90_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('@smoke self-host: billing route 404s, the billing menu row + AI paywall are absent', async ({
  page,
}) => {
  const seed = await seedBillingOwner(page, 'e2e-billing-selfhost@example.com');

  // The commercial billing route does not exist off-cloud → notFound() (404).
  const resp = await page.goto('/settings/organization/billing');
  expect(resp?.status()).toBe(404);

  // The org settings page renders no Billing card, and no menu/nav links to it.
  await page.goto('/settings/organization');
  await expect(page.locator('a[href="/settings/organization/billing"]')).toHaveCount(0);

  // The AI entitlement read degrades to not-applicable off-cloud, so the AI entry
  // point shows no paywall. Wait on the authoritative read, then assert it.
  const access = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/ai/access' && r.request().method() === 'GET',
  );
  // The discovery hub (which reads /api/ai/access) is at /onboarding/discovery
  // now — /onboarding is the entrance fork (MOTIR-1462), which makes no AI read.
  await page.goto('/onboarding/discovery');
  expect((await (await access).json()).applicable).toBe(false);
  await expect(page.getByText('AI planning is a paid feature')).toHaveCount(0);
  await expect(page.getByText('Planning is paused')).toHaveCount(0);

  expect(seed.organizationId).toBeTruthy();
});
