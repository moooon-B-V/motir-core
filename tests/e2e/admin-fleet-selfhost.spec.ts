import { expect, test } from '@playwright/test';
import { adminDb, resetDatabase } from './_helpers/db-reset';
import { signUpToOnboarding } from './_helpers/shell-session';
import { seedRunningCi, seedTenantOrg } from './_helpers/fleet-monitor-seed';
import enMessages from '@/messages/en.json';

/**
 * THE FLEET MONITOR, SELF-HOSTED (Story MOTIR-6905 · MOTIR-7322) — the disabled
 * state, in the default lane because `playwright.config.ts` IS the off-cloud arm
 * (no `MOTIR_CLOUD`), the same shape as `billing-selfhost.spec.ts`.
 *
 * A self-hosted build has no orchestrator and no meter, so `/admin/monitoring`
 * draws ONE "Disabled on this deployment" card in place of both Fleet cards —
 * no figure at all, because a zero would claim a measurement — and the org page
 * draws no Fleet card and no Stop control. A container row is seeded anyway, to
 * prove the disabled state does not depend on there being nothing to count.
 */

const fm = enMessages.platformAdmin.monitoring.fleet;
const tf = enMessages.platformAdmin.tenant.fleet;

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

test('off-cloud the Fleet section is one disabled card and the org page has no Stop', async ({
  page,
}) => {
  const email = 'e2e-fleet-selfhost@example.com';
  await signUpToOnboarding(page, email);
  await adminDb.user.update({ where: { email }, data: { platformRole: 'superadmin' } });

  const org = await seedTenantOrg('Selfhost Fleet Org', 'e2e-fleet-selfhost');
  await seedRunningCi(org, 1, new Date(Date.now() - 30 * 60_000));

  expect((await page.goto('/admin/monitoring'))?.status()).toBe(200);
  const main = page.getByRole('main');
  const disabled = main.getByTestId('fleet-disabled');
  await expect(disabled.getByRole('heading', { name: fm.disabled.empty.title })).toBeVisible();
  await expect(disabled.getByText(fm.disabled.pill)).toBeVisible();
  await expect(main.getByRole('heading', { name: fm.orgs.title })).toHaveCount(0);
  await expect(main.getByRole('heading', { name: fm.kills.title })).toHaveCount(0);

  expect((await page.goto(`/admin/tenants/${org.organizationId}`))?.status()).toBe(200);
  await expect(main.getByRole('heading', { name: 'Selfhost Fleet Org', level: 1 })).toBeVisible();
  await expect(main.getByRole('heading', { name: tf.title })).toHaveCount(0);
  await expect(main.getByRole('button', { name: tf.stop.button })).toHaveCount(0);
});
