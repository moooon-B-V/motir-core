import { expect, test, type Page, type Response } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn, SHELL_PASSWORD } from './_helpers/shell-session';
import {
  seedBillingOwner,
  addOrgMember,
  pinContextCookies,
  setOrgBillingState,
  resetBillingFixture,
  freeOrgState,
  paidOrgState,
  TIERS,
  type BillingSeed,
} from './_helpers/billing';
import { E2E_CHECKOUT_URL, E2E_PORTAL_URL } from '@/lib/test-billing-mock';

// Subtask 8.1.10 — the billing user journeys, CLOUD-ON lane (MOTIR_CLOUD via
// playwright.billing.config.ts). The motir-ai side (AI plan/usage + Stripe
// sessions) is the E2E_TEST_BILLING boundary mock; the browser-side navigation to
// the (synthetic) Stripe hosted URLs is fulfilled by page.route, so nothing leaves
// localhost. EVERY persisted-state assertion waits on the AUTHORITATIVE response
// (status + body), never the optimistic UI — the CLAUDE.md E2E discipline /
// notes.html #37 (a billing tier that "settles" via a webhook is the textbook
// eventually-consistent surface).

test.describe.configure({ timeout: 90_000 });

test.beforeEach(async () => {
  await resetDatabase();
  resetBillingFixture();
});

test.afterAll(async () => {
  await db.$disconnect();
});

/** Stub the browser navigations to the synthetic Stripe hosts so a redirect never
 *  leaves localhost (the blob-mock split: server-side mock + browser-side route). */
async function stubStripeHosts(page: Page): Promise<void> {
  await page.route('https://checkout.stripe.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body>stripe checkout</body></html>',
    }),
  );
  await page.route('https://billing.stripe.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body>stripe portal</body></html>',
    }),
  );
}

/** Wait on the AUTHORITATIVE billing status GET (not the /checkout or /portal POST
 *  that share the `/billing` prefix). */
function billingStatusGet(page: Page, seed: BillingSeed): Promise<Response> {
  return page.waitForResponse(
    (r) =>
      r.request().method() === 'GET' &&
      new URL(r.url()).pathname === `/api/organizations/${seed.organizationId}/billing`,
  );
}

const billingPath = '/settings/organization/billing';

test('@smoke upgrade journey: free org → checkout redirect → tier reflected after the webhook', async ({
  page,
}) => {
  const seed = await seedBillingOwner(page, 'e2e-billing-upgrade@example.com');
  setOrgBillingState(seed.organizationId, freeOrgState(0)); // no AI plan yet
  await stubStripeHosts(page);

  // Open billing — wait on the authoritative status read, then assert the free
  // AI line (the owner can manage, so the "Choose Plan" CTA is live).
  const firstLoad = billingStatusGet(page, seed);
  await page.goto(billingPath);
  expect((await firstLoad).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Billing & plans' })).toBeVisible();
  const choosePlan = page.getByRole('button', { name: 'Choose a Motir AI plan' });
  await expect(choosePlan).toBeVisible();

  // Into the storefront, then upgrade to Pro. Arm the checkout-response wait
  // BEFORE the click so it can't be missed; assert the boundary returned the
  // hosted Checkout URL and the browser redirected there.
  await choosePlan.click();
  const upgradePro = page.getByRole('button', { name: 'Upgrade to Pro' });
  await expect(upgradePro).toBeVisible();
  const checkoutResp = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === `/api/organizations/${seed.organizationId}/billing/checkout`,
  );
  await upgradePro.click();
  // The redirect is the authoritative signal: the boundary returned a hosted URL
  // and the client navigated to it. (Don't read the POST body after the nav — the
  // navigation discards the response resource; the landed URL IS the proof.)
  const checkout = await checkoutResp;
  expect(checkout.status()).toBe(200);
  await page.waitForURL(/checkout\.stripe\.com/);
  expect(page.url()).toBe(E2E_CHECKOUT_URL);

  // Simulate the Stripe webhook landing in motir-ai (free → Pro): rewrite the
  // boundary fixture so the next authoritative read reports the new tier.
  setOrgBillingState(
    seed.organizationId,
    paidOrgState({ tier: TIERS.pro, priceLookupKey: 'pro_pool_monthly' }),
  );

  // Return to billing (?checkout=success) — wait on the authoritative status GET
  // and assert the NEW tier from its BODY (never the optimistic UI), then the
  // panel reflects Pro (the "Change Plan" CTA replaces "Choose Plan").
  const reload = billingStatusGet(page, seed);
  await page.goto(`${billingPath}?checkout=success`);
  const reflected = await reload;
  expect(reflected.status()).toBe(200);
  expect((await reflected.json()).motirAi.tier.key).toBe('pro');
  // The panel now reflects Pro: its credit allotment + the "Change plan" CTA
  // (status is active, so the "Choose a Motir AI plan" CTA is gone).
  await expect(page.getByText('8,000 credits / mo')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change plan' })).toBeVisible();
});

test('@smoke paywall: a free / out-of-credits org hitting AI sees the upgrade prompt, CTA → pricing', async ({
  page,
}) => {
  const seed = await seedBillingOwner(page, 'e2e-billing-paywall@example.com');
  setOrgBillingState(seed.organizationId, freeOrgState(0)); // balance 0 → proactively blocked

  // The onboarding AI entry point reads the entitlement (GET /api/ai/access);
  // wait on that authoritative read, then the proactive tier-gate paywall renders.
  const accessRead = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/ai/access' && r.request().method() === 'GET',
  );
  await page.goto('/onboarding');
  const access = await accessRead;
  expect(access.status()).toBe(200);
  expect((await access.json()).balance).toBeLessThanOrEqual(0);

  await expect(page.getByText('AI planning is a paid feature')).toBeVisible();
  const seePlans = page.getByRole('link', { name: 'See Motir AI plans' });
  await expect(seePlans).toHaveAttribute('href', billingPath);

  // The Upgrade CTA navigates to the pricing/checkout entry.
  const statusLoad = billingStatusGet(page, seed);
  await seePlans.click();
  await page.waitForURL(new RegExp(billingPath.replace(/\//g, '\\/')));
  expect((await statusLoad).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Billing & plans' })).toBeVisible();
});

test('@smoke customer portal: Manage plan triggers the portal session + redirect', async ({
  page,
}) => {
  const seed = await seedBillingOwner(page, 'e2e-billing-portal@example.com');
  // A paid, active org so the AI line shows the "Manage plan" (portal) button.
  setOrgBillingState(
    seed.organizationId,
    paidOrgState({ tier: TIERS.standard, priceLookupKey: 'standard_pool_monthly' }),
  );
  await stubStripeHosts(page);

  const load = billingStatusGet(page, seed);
  await page.goto(billingPath);
  expect((await load).status()).toBe(200);

  const managePlan = page.getByRole('button', { name: 'Manage plan & payment' }).first();
  await expect(managePlan).toBeVisible();
  const portalResp = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === `/api/organizations/${seed.organizationId}/billing/portal`,
  );
  await managePlan.click();
  // The redirect to the hosted portal IS the authoritative signal (see the
  // checkout note — don't read the POST body after the navigation discards it).
  const portal = await portalResp;
  expect(portal.status()).toBe(200);
  await page.waitForURL(/billing\.stripe\.com/);
  expect(page.url()).toBe(E2E_PORTAL_URL);
});

test('@smoke permission gate: a non-admin member gets the view-only / ask-your-owner gate, no CTA', async ({
  page,
}) => {
  const seed = await seedBillingOwner(page, 'e2e-billing-perm-owner@example.com');
  const memberEmail = 'e2e-billing-perm-member@example.com';
  await addOrgMember(seed, memberEmail);
  setOrgBillingState(seed.organizationId, paidOrgState({ tier: TIERS.standard }));

  // Re-auth as the plain member, pin the same active org, open billing. The
  // service forbids a non-admin VIEW (403) → the client shows the member gate.
  await page.context().clearCookies();
  await signIn(page, memberEmail, SHELL_PASSWORD);
  await pinContextCookies(page, {
    workspaceId: seed.workspaceId,
    organizationId: seed.organizationId,
  });

  const load = page.waitForResponse(
    (r) =>
      r.request().method() === 'GET' &&
      new URL(r.url()).pathname === `/api/organizations/${seed.organizationId}/billing`,
  );
  await page.goto(billingPath);
  expect((await load).status()).toBe(403);

  await expect(page.getByText('Billing is managed by your org owner')).toBeVisible();
  // The only affordance is "contact an owner" — never an active billing CTA.
  await expect(page.getByRole('button', { name: 'Choose a Motir AI plan' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change plan' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Manage plan & payment' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Upgrade Motir' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Contact an owner' })).toBeVisible();
});
