// Plans review E2E (Subtask 7.21.5 / MOTIR-1339) — the browser-level proof of
// the AI-plan review experience (Story 7.21): the left-nav entry → the plans
// list (status / count / when + a staleness indicator) → a plan's detail
// (proposed items on the canvas, status + history, per-item stale badges +
// reasons) → the stale-warning APPROVE-ANYWAY (materialize) and the DECLINE
// branch → the empty-state CTA.
//
// Drives the REAL stack (Next + Postgres) end to end. The fixture seeds three
// plans through the shipped services (plans-review-seed.ts): a STALE `planned`
// plan (parent_removed + siblings_added), a clean `planned` plan, and an
// already-`approved` plan. Waits on AUTHORITATIVE signals — the rendered rows
// and the persisted approve/decline POST 200 — never fixed sleeps (the E2E
// discipline in motir-core/CLAUDE.md; notes.html #37).

import { expect, test } from '@playwright/test';

import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedPlansReview,
  seedEmptyPlansProject,
  PLANS_SEED_PASSWORD,
} from './_helpers/plans-review-seed';

// Service-side seeding of a whole tenant + tree + three plans, plus the sign-in
// flow and the canvas render, comfortably exceeds the 30s default.
test.describe.configure({ timeout: 120_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

test('Plans: nav → list → stale detail → approve-anyway → decline', async ({ page }) => {
  const seed = await seedPlansReview('plans-review@example.com');
  await signIn(page, seed.email, PLANS_SEED_PASSWORD);

  // ── 1. The "Plans" left-nav entry → the list ──────────────────────────────
  const plansNav = page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Plans' });
  await expect(plansNav).toBeVisible();
  await plansNav.click();
  await page.waitForURL('**/plans');

  const list = page.getByRole('list', { name: 'Plans' });
  await expect(list).toBeVisible();

  // The stale `planned` plan's row shows its status + the "N may be out of date"
  // indicator; the approved plan's row shows its Approved status.
  const staleRow = page.locator(`a[href="/plans/${seed.stalePlan.id}"]`);
  await expect(staleRow).toContainText('Planned');
  await expect(staleRow).toContainText('2 may be out of date');

  const approvedRow = page.locator(`a[href="/plans/${seed.approvedPlan.id}"]`);
  await expect(approvedRow).toContainText('Approved');

  // ── 2. Enter the stale plan → the detail ──────────────────────────────────
  await staleRow.click();
  await page.waitForURL(`**/plans/${seed.stalePlan.id}`);

  // Status + history timeline.
  await expect(page.getByTestId('plan-status-pill')).toContainText('Ready to review');
  await expect(page.getByText('Generation started')).toBeVisible();
  await expect(page.getByText('Plan ready')).toBeVisible();
  await expect(page.getByText('Awaiting your review')).toBeVisible();

  // The proposed items render on the canvas (with a stale badge on the drifted
  // ones) — the canvas MOUNTS the proposed PlanItems, it doesn't redraw a tree.
  await expect(page.getByLabel('Proposed plan canvas')).toBeVisible();
  await expect(page.getByTestId('plan-item-node').first()).toBeVisible();
  await expect(page.getByTestId('stale-badge').first()).toBeVisible();

  // Per-item staleness summary: both drifted items, each with its reason.
  const staleSummary = page.getByTestId('stale-summary');
  await expect(staleSummary).toContainText('2 items may be out of date');
  await expect(staleSummary).toContainText(seed.staleProposalSiblings);
  await expect(staleSummary).toContainText('New sibling items since planned');
  await expect(staleSummary).toContainText(seed.staleProposalOrphan);
  await expect(staleSummary).toContainText('Parent removed since planned');

  // ── 3. Approve → the stale-warning confirm → approve anyway ───────────────
  await page.getByRole('button', { name: /Approve.*to your backlog/ }).click();
  const confirm = page.getByRole('dialog');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('Some items may be out of date');
  await expect(confirm).toContainText('drifted since this plan was generated');

  // Arm the response wait BEFORE the click so the persisted flip can't be missed.
  const approveResponse = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/plans/${seed.stalePlan.id}/approve`) &&
      r.request().method() === 'POST',
  );
  await confirm.getByRole('button', { name: 'Approve anyway' }).click();
  expect((await approveResponse).status()).toBe(200);

  // The plan flips to approved (status pill + the materialize outcome).
  await expect(page.getByTestId('plan-status-pill')).toContainText('Approved');
  await expect(page.getByText(/Added .* to your backlog/)).toBeVisible();

  // The bundle became real, dispatchable work: the cleanly-materialized add
  // (under the still-living parent) appears in the ready set.
  await page.goto('/ready');
  await expect(
    page.getByRole('list', { name: 'Ready work items' }).getByText(seed.staleProposalSiblings),
  ).toBeVisible();

  // ── 4. Decline branch on the clean plan ───────────────────────────────────
  await page.goto(`/plans/${seed.declinePlan.id}`);
  await expect(page.getByTestId('plan-status-pill')).toContainText('Ready to review');

  const declineResponse = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/plans/${seed.declinePlan.id}/decline`) &&
      r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Decline' }).click();
  expect((await declineResponse).status()).toBe(200);

  // Decline DROPS every proposed item, but a DECIDED plan still shows its outcome
  // in the review rail — the detail island refetches into the declined-outcome
  // rail, NOT the "no proposals" empty state (MOTIR-1377: the empty guard used to
  // shadow the rail's declined branch for a zero-item declined plan).
  await expect(page.getByTestId('plan-status-pill')).toContainText('Declined');
  await expect(page.getByText('Plan declined — your tree was left untouched')).toBeVisible();

  // The list also reflects the declined status on its pill.
  await page.goto('/plans');
  await expect(page.locator(`a[href="/plans/${seed.declinePlan.id}"]`)).toContainText('Declined');

  // Declining a bundle of proposed adds leaves the tree untouched — the proposed
  // item was never materialized, so it's absent from the ready set.
  await page.goto('/ready');
  await expect(
    page.getByRole('list', { name: 'Ready work items' }).getByText(seed.declineProposal),
  ).toHaveCount(0);
});

test('Plans: empty state shows the generate-your-first-plan CTA', async ({ page }) => {
  const empty = await seedEmptyPlansProject('plans-empty@example.com');
  await signIn(page, empty.email, PLANS_SEED_PASSWORD);

  await page.goto('/plans');
  await expect(page.getByRole('heading', { name: 'No plans yet' })).toBeVisible();
  await expect(
    page.getByText(/Generate your first plan to see proposed work here\./),
  ).toBeVisible();
});
