import { expect, test } from '@playwright/test';
import { db, resetDatabase } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';

/**
 * The operator ORG LOOKUP and ORG PAGE — MOTIR-4566, design
 * `platform-admin/design-notes.md` Panels 10 and 11.
 *
 * ⚠️ A SMOKE SPEC IN THE BUILDING CARD'S OWN PULL REQUEST, deliberately, rather
 * than deferred to the story's E2E card. This is the FIRST card in Story
 * MOTIR-4337 that renders a page, and a server/client-seam defect on a route
 * nobody opens survives every later card's green build — the later card would
 * find it, but only after four more cards had been written on top of it.
 *
 * Two assertions, and the second is the one that cannot be checked any other
 * way: the surface RENDERS for platform staff, and it is a 404 — not a 403, not
 * a redirect — for everybody else. The layout gate's own unit suite
 * (`tests/platform/adminRouteGate.test.ts`) proves the layout CALLS
 * `notFound()`; only a browser proves the response a non-staff person actually
 * receives.
 */

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('@smoke platform staff reach the Tenants list and an org page; a tenant user gets a 404', async ({
  page,
}) => {
  // A tenant user, signed up through the real UI — this also mints their own
  // organization, which is the one the operator will look up below.
  const tenantEmail = 'e2e-org-lookup-tenant@example.com';
  await signUp(page, tenantEmail);
  const tenant = await db.user.findUniqueOrThrow({ where: { email: tenantEmail } });
  const org = await db.organization.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });

  // ── A tenant user — including the OWNER of the org being viewed — gets the
  //    ordinary app 404 on both routes. No 403 body, no redirect: the console
  //    does not exist for them (`platform-staff-auth.md` §2).
  expect((await page.goto('/admin/tenants'))?.status()).toBe(404);
  expect((await page.goto(`/admin/tenants/${org.id}`))?.status()).toBe(404);
  // ⚠️ NOT converted and NOT scoped (MOTIR-5115) — `toHaveCount` resolves the WHOLE
  // match set, so it cannot throw strict mode and this site is not in the defect
  // class; and the claim is that no 403 body appears ANYWHERE, which is the
  // no-leak posture the line above asserts. A role or a subtree scope would prove
  // strictly less. Keeps its inventory row.
  await expect(page.getByText('403')).toHaveCount(0);

  // ── Now the same person as platform staff. Granting the standing to the
  //    SIGNED-IN user is what keeps this one browser session: the gate reads a
  //    fresh database row per request, so the next navigation sees it.
  await db.user.update({ where: { id: tenant.id }, data: { platformRole: 'superadmin' } });

  const lookup = await page.goto('/admin/tenants');
  expect(lookup?.status()).toBe(200);
  // LIST-FIRST since MOTIR-7287 (design D10): no idle state — the Organizations
  // card renders on arrival, as the spend table or, when the E2E stack runs no
  // motir-ai, as the list's error state. Either way the page itself rendered.
  await expect(page.getByRole('heading', { name: 'Tenants', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Organizations' })).toBeVisible();

  // ── The filter puts its query in the URL: a filtered list is linkable and
  //    survives a reload. Scoped to the page's own `role="search"` form — the
  //    admin shell carries a (disabled) global search button too.
  const filter = page.getByRole('search').getByRole('searchbox');
  await filter.fill(org.slug);
  await filter.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/admin/tenants\\?.*q=${org.slug}`));

  // ── The org page renders. A row needs spend in motir-ai's rollup to appear,
  //    which this fixture has none of, so it is opened by its id.
  await page.goto(`/admin/tenants/${org.id}`);
  await expect(page).toHaveURL(new RegExp(`/admin/tenants/${org.id}`));
  await expect(page.getByRole('heading', { name: org.name })).toBeVisible();
  // The org page's frame (MOTIR-733, design D5): ← Tenants and the three tabs.
  await expect(page.getByRole('link', { name: 'Tenants' }).first()).toBeVisible();
  const tabs = page.getByRole('navigation', { name: 'Organization sections' });
  await expect(tabs.getByRole('link', { name: 'Overview' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(tabs.getByRole('link', { name: 'Usage & cost' })).toBeVisible();
  await expect(tabs.getByRole('link', { name: 'Billing & plans' })).toBeVisible();

  // ── And the read wrote its audit row. The banner on screen claims it; this is
  //    the claim checked against the table, because a banner beside a read that
  //    wrote nothing would be a promise of accountability that is decoration.
  const audited = await db.platformAuditLog.findMany({
    where: { targetKind: 'organization', targetId: org.id },
  });
  expect(audited.length).toBeGreaterThan(0);
  expect(audited[0]?.actorUserId).toBe(tenant.id);
});
