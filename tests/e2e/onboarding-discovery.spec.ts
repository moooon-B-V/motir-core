// E2E — the authed discovery onboarding flow (Subtask 7.3.8 / MOTIR-836).
//
// Drives the chat discovery loop end to end in a real browser and proves the
// FULL read surface lands in the reader: a chat turn drives the interview, the
// conductor produces the 4 direction tiers, and each tier's read-only review —
// PLUS the feature catalog folded into the vision tier — renders from
// /api/ai/pre-plan. This is the rescoped version of the original 3-doc E2E:
// 4 tiers + the catalog (the catalog seam is 7.3.78/MOTIR-1243 motir-ai +
// 7.3.79/MOTIR-1244 motir-core).
//
// motir-ai is server-to-server infrastructure with no presence in CI, so the
// three browser-reachable AI endpoints are STUBBED via page.route — exactly the
// boundary the open-core split draws (the browser only ever talks to
// motir-core's /api/ai/* routes). That keeps the test deterministic and scopes
// it to what 836 actually verifies: motir-core's consumer flow (the
// useDiscoveryChat hook + the discoveryLoop reducer + the gate/reader
// components) rendering a known conductor response — NOT motir-ai's planning.
//
//   GET  /api/ai/pre-plan        → resume read (empty before the turn; the full
//                                  4-tier + catalog state after it)
//   POST /api/ai/chat            → { jobId }
//   GET  /api/ai/chat/:id/stream → the conductor SSE (assistant + a docs frame
//                                  announcing all 4 tiers)

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase } from './_helpers/db-reset';
import { signUp, createFirstProject } from './_helpers/shell-session';
import { stubDiscoveryApi, TIER_BODY, TIER_TITLE, type Tier } from './_helpers/onboarding-stubs';

// Browser sign-up + project + a cold-compiled /onboarding route: more than the
// 30s default.
test.describe.configure({ timeout: 120_000 });

function reader(page: Page) {
  return {
    title: (kind: Tier) => page.getByRole('heading', { name: TIER_TITLE[kind], exact: true }),
    body: (kind: Tier) => page.getByText(TIER_BODY[kind]),
    crossLink: (kind: Tier) => page.getByRole('button', { name: TIER_TITLE[kind], exact: true }),
    catalogHeading: () => page.getByRole('heading', { name: 'The feature catalog' }),
  };
}

test.beforeEach(async () => {
  await resetDatabase();
});

test('chat discovery flow → the 4 tiers + the feature catalog appear in the reader', async ({
  page,
}) => {
  await stubDiscoveryApi(page);

  // Authed onboarding needs a session + an active project (the page gates on
  // both). Sign up + create the first project through the real UI, then enter
  // the immersive onboarding surface.
  const email = `discovery-${Date.now()}@example.com`;
  await signUp(page, email);
  await createFirstProject(page, 'Invoicer');

  // The onboarding hub moved to /onboarding/discovery; /onboarding is now the
  // entrance fork (MOTIR-1462). Enter the discovery chat surface directly.
  await page.goto('/onboarding/discovery');

  // Fresh session → the onboarding hub with its chat composer (no docs yet).
  const composer = page.getByRole('textbox', { name: 'Reply, or ask a question…' });
  await expect(composer).toBeVisible();
  const r = reader(page);

  // Drive the interview with one chat turn.
  await composer.fill('A tool that chases unpaid invoices for freelancers.');
  await page.getByRole('button', { name: 'Send' }).click();

  // The conductor produced all four tiers; the loop opens the last one
  // (validation) into its read-only review gate.
  await expect(r.title('validation')).toBeVisible();
  await expect(r.body('validation')).toBeVisible();
  // The catalog is folded into VISION only — not shown on the validation tier.
  await expect(r.catalogHeading()).toHaveCount(0);

  // The vision tier carries the folded-in feature catalog.
  await r.crossLink('vision').click();
  await expect(r.title('vision')).toBeVisible();
  await expect(r.body('vision')).toBeVisible();
  await expect(r.catalogHeading()).toBeVisible();
  await expect(page.getByRole('heading', { name: /Invoicing/ })).toBeVisible(); // a catalog category
  await expect(page.getByText('Recurring invoices')).toBeVisible(); // a catalog feature

  // The remaining two tiers each render their read-only review too — all 4
  // direction tiers are reachable in the reader.
  await r.crossLink('feasibility').click();
  await expect(r.title('feasibility')).toBeVisible();
  await expect(r.body('feasibility')).toBeVisible();

  await r.crossLink('discovery').click();
  await expect(r.title('discovery')).toBeVisible();
  await expect(r.body('discovery')).toBeVisible();
});
