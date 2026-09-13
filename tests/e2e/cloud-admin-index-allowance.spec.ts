import { expect, test } from '@playwright/test';
import { adminDb } from '../helpers/adminDb';
import { resetDatabase } from './_helpers/db-reset';
import { E2E_INDEX_REPOS, seedConnectedRepos } from './_helpers/migrate-index-seed';
import { signUp } from './_helpers/shell-session';

/**
 * MONITORING · INDEX ALLOWANCE — the smoke spec (MOTIR-4595, design
 * `platform-admin/design-notes.md` Panel 13 revision 2).
 *
 * ⚠️ IN THE CLOUD LANE ON PURPOSE. Off-cloud the section renders "meter disabled"
 * and nothing else, so a spec in the default lane would only ever see that state.
 *
 * What only a browser proves: the section RENDERS for platform staff on the shipped
 * Monitoring page — a server component with a client filter island — and the route is
 * a 404 for a tenant, including the owner of the org it lists. The e2e motir-ai host
 * does not serve the admin reads, which is the "couldn't read" arm: the tier table
 * reads unknown and the list's tier column reads unknown, while the list itself —
 * motir-core's own rows — renders in full.
 *
 * ⚠️ Motir does not charge for code indexing. The section is internal accounting.
 */

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

test('@smoke staff see the index allowance section, a stopped org and its cost card; a tenant gets a 404', async ({
  page,
}, testInfo) => {
  const email = 'e2e-index-allowance-tenant@example.com';
  await signUp(page, email);
  const user = await adminDb.user.findUniqueOrThrow({ where: { email } });
  const org = await adminDb.organization.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
  const workspace = await adminDb.workspace.findFirstOrThrow({ where: { organizationId: org.id } });

  const [repo] = E2E_INDEX_REPOS;
  await seedConnectedRepos(workspace.id, [repo!]);
  await adminDb.githubRepo.updateMany({
    where: { workspaceId: workspace.id },
    data: {
      indexPausedReason: 'paused_index_no_credit',
      indexPausedAt: new Date(Date.now() - 3 * 86_400_000),
    },
  });

  // The org's own owner cannot reach the console that lists it — nor its own org page.
  expect((await page.goto('/admin/monitoring'))?.status()).toBe(404);
  expect((await page.goto(`/admin/tenants/${org.id}`))?.status()).toBe(404);

  await adminDb.user.update({ where: { id: user.id }, data: { platformRole: 'support' } });
  const res = await page.goto('/admin/monitoring');
  expect(res?.status()).toBe(200);

  await expect(
    page.getByRole('heading', { name: 'Index allowance · is the gate sized right?' }),
  ).toBeVisible();
  // motir-ai does not answer in this lane: UNKNOWN, in words — never a table of zeros.
  await expect(page.getByRole('heading', { name: 'Couldn’t read the allowance' })).toBeVisible();

  const stopped = page.getByRole('heading', { name: 'Stopped orgs' });
  await expect(stopped).toBeVisible();
  const filter = page.getByRole('group', { name: 'Stop reason' });
  await expect(filter.getByRole('button', { name: /All\s*1/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(filter.getByRole('button', { name: /No credit\s*1/ })).toBeEnabled();
  await expect(filter.getByRole('button', { name: /Margin ceiling/ })).toBeDisabled();

  const row = page.locator(`tr[data-org="${org.id}"]`);
  await expect(row).toContainText(org.name);
  await expect(row).toContainText('unknown');
  await expect(row).toContainText('No credit');
  await expect(row).toContainText('3 days');
  await expect(row).toContainText('on top-up or renewal');
  await expect(page.getByRole('main').getByText('Showing 1–1 of 1')).toBeVisible();

  // The filter drives the URL and the server-paged read: the Free filter is empty.
  await filter.getByRole('button', { name: /Free allowance used/ }).click();
  await expect(page).toHaveURL(/reason=allowance_exhausted/);
  await expect(
    page.getByRole('main').getByText('No stopped org matches this filter and search.'),
  ).toBeVisible();

  await page.goto('/admin/monitoring');
  await stopped.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('monitoring-index-allowance.png'),
    fullPage: true,
  });

  // ── The org page's Index & fleet cost card (MOTIR-5341, design Panel 14), reached
  //    from the stopped row's own link.
  await page
    .getByRole('main')
    .locator(`tr[data-org="${org.id}"]`)
    .getByRole('link', { name: org.name })
    .click();
  await expect(page).toHaveURL(new RegExp(`/admin/tenants/${org.id}$`));
  await expect(
    page.getByRole('heading', { name: 'Index & fleet cost · this period' }),
  ).toBeVisible();
  // motir-ai does not serve the pools read in this lane: UNKNOWN, never zero.
  await expect(page.getByRole('heading', { name: 'Couldn’t read the pools' })).toBeVisible();
  // No container ran for this org: every line is ABSENT, said in words.
  const workloads = page.getByRole('main').getByTestId('org-fleet-workloads');
  for (const workload of ['ci', 'index', 'agent']) {
    await expect(workloads.locator(`tr[data-workload="${workload}"]`)).toContainText(
      `absent — no ${workload} container ran this period (not a zero)`,
    );
  }
  await page.screenshot({ path: testInfo.outputPath('org-index-cost.png'), fullPage: true });
});
