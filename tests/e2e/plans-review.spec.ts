// Plans review E2E (Subtask 7.21.5 / MOTIR-1339) — the browser-level proof of
// the AI-plan review experience (Story 7.21): the left-nav entry → the plans
// list (status / count / when + a staleness indicator) → a plan's detail
// (proposed items on the canvas, status + history, per-item stale badges +
// reasons) → the stale-warning APPROVE-ANYWAY (materialize) and the DECLINE
// branch → the empty-state CTA.
//
// Drives the REAL stack (Next + Postgres) end to end. The fixture seeds three
// plans through the shipped services (plans-review-seed.ts): a STALE `planned`
// plan (parent_removed), a clean `planned` plan, and an
// already-`approved` plan. Waits on AUTHORITATIVE signals — the rendered rows
// and the persisted approve/decline POST 200 — never fixed sleeps (the E2E
// discipline in motir-core/CLAUDE.md; notes.html #37).
//
// ⚠️ AMENDED by MOTIR-3163 (bug MOTIR-3154) — the browser-level proof that a
// DECIDED plan still shows its cards. The defect was distributed across the
// whole stack (rows deleted in a service, the pane swapped on a page, the
// treatment missing from a component, the overlay cleared in a hook), so four
// green unit suites was exactly the state the product was in when the cards
// disappeared. Only this layer can answer what a person SEES after they click.
//
// The assertion worth protecting most is the one that stays NEGATIVE: retaining
// a declined plan's proposals must never put them in the tree. A change that
// made the cards visible by quietly materializing them would satisfy the report
// and destroy the feature, so the declined proposal's absence from the ready set
// is untouched and must stay that way.

import { expect, test } from '@playwright/test';

import { resetDatabase, db, adminDb } from './_helpers/db-reset';
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
  await adminDb.$disconnect();
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
  //
  // ⚠️ ONE, not two (MOTIR-3777). The fixture drifts the tree twice and only ONE
  // of those drifts is a reason now: the archived parent. The other — an
  // unrelated card landing under the OTHER proposal's still-living parent — used
  // to raise `siblings_added` and raises nothing, which is the whole of the fix.
  // The count on this row is `staleCountFor`'s, a SECOND reader of the same
  // verdict as the rail's summary below, so it is asserted here as well.
  const staleRow = page.locator(`a[href="/plans/${seed.stalePlan.id}"]`);
  await expect(staleRow).toContainText('Planned');
  await expect(staleRow).toContainText('1 may be out of date');

  // ⚠️ THE APPROVED PLAN IS IN ITS OWN TAB (MOTIR-3241). `/plans` is no longer one
  // reverse-chronological stream of every plan: it is a tab per lifecycle state,
  // `Planned` — the plans awaiting a decision — selected by default and writing a
  // CLEAN url. So a decided plan is one press away rather than three rows down.
  // The assertion is unchanged in meaning; only where it is made moved.
  await page.goto('/plans?status=approved');
  const approvedRow = page.locator(`a[href="/plans/${seed.approvedPlan.id}"]`);
  await expect(approvedRow).toContainText('Approved');

  // ── 2. Enter the stale plan → the detail ──────────────────────────────────
  await page.goto('/plans');
  await staleRow.click();
  await page.waitForURL(`**/plans/${seed.stalePlan.id}`);

  // Status + history timeline.
  await expect(page.getByTestId('plan-status-pill')).toContainText('Ready to review');
  await expect(page.getByText('Generation started')).toBeVisible();
  await expect(page.getByText('Plan ready')).toBeVisible();
  await expect(page.getByText('Awaiting your review')).toBeVisible();

  // ⚠️ THE CANVAS IS ASKED FOR, NOT ASSUMED (MOTIR-3262). The detail's default
  // body is DERIVED from the plan's shape: the LIST when its proposals sit under
  // more than one distinct container, because no single canvas level can show
  // such a plan. THIS plan is exactly that — its two adds hang under two
  // different committed parents — so it now opens on the list, and every canvas
  // assertion below is about the canvas, so the spec navigates to it. The URL is
  // the single source of truth for which body is showing, which is what makes
  // that a one-parameter change rather than a click.
  await page.goto(`/plans/${seed.stalePlan.id}?view=canvas`);

  // The proposed items render on the canvas (with a stale badge on the drifted
  // ones) — the canvas MOUNTS the proposed PlanItems, it doesn't redraw a tree.
  await expect(page.getByLabel('Proposed plan canvas')).toBeVisible();
  await expect(page.getByTestId('plan-item-node').first()).toBeVisible();
  await expect(page.getByTestId('stale-badge').first()).toBeVisible();

  // Per-item staleness summary: the drifted item, with its reason.
  const staleSummary = page.getByTestId('stale-summary');
  await expect(staleSummary).toContainText('1 item may be out of date');
  await expect(staleSummary).toContainText(seed.staleProposalOrphan);
  await expect(staleSummary).toContainText('Parent removed since planned');

  // ⚠️ MOTIR-3777, guarded on ABSENCE (CLAUDE.md § E2E). The OTHER proposal's
  // parent gained an unrelated child after `plannedAt` — the exact mutation that
  // used to raise "New sibling items since planned" on it. It declared no edge to
  // that child, so nothing about it drifted, and the reviewer is told nothing.
  // The whole fixture is here and the summary names ONE item, not two.
  await expect(staleSummary).not.toContainText(seed.cleanProposalUnderBusyParent);
  await expect(staleSummary).not.toContainText('New sibling items since planned');

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

  // ── MOTIR-3161 / MOTIR-3165 (bug MOTIR-3154) — an APPROVED plan still SHOWS
  //    what was approved, on the cards it became, and stops warning about it ──
  //
  // The whole of the reported defect, at the browser: the four cards the user
  // approved a second earlier used to be nowhere on this page. They are here,
  // marked accepted, ON the committed work items — and the page is quiet.
  const acceptedNodes = page.getByTestId('plan-item-node');
  await expect(acceptedNodes.first()).toBeVisible();
  // Queried by TEXT, so a colour-only treatment cannot pass.
  await expect(page.getByTestId('plan-item-outcome').first()).toHaveText('accepted');

  // ONE node per approved `add`, carrying the REAL identifier its materialized
  // work item was given — which is what proves the node landed ON the committed
  // card rather than beside it as a second, keyless ghost.
  const materialized = await adminDb.workItem.findFirstOrThrow({
    where: { projectId: seed.projectId, title: seed.cleanProposalUnderBusyParent },
  });
  const acceptedCard = page
    .getByTestId('plan-item-node')
    .filter({ hasText: materialized.identifier });
  await expect(acceptedCard).toHaveCount(1);
  await expect(acceptedCard.getByTestId('plan-item-outcome')).toHaveText('accepted');

  // Guarded on ABSENCE (CLAUDE.md § E2E): a DECIDED plan can never be decided
  // again, so every staleness warning on it is advice about a choice nobody can
  // make. Both surfaces must be quiet. (The warnings such a plan used to carry
  // were caused BY the approval, since the cards it created under one parent
  // counted as unexplained new siblings against each other — MOTIR-3777 retired
  // that rule, and MOTIR-3165's status guard, asserted here, is what still holds
  // the line for every reason that remains.)
  await expect(page.getByTestId('stale-summary')).toHaveCount(0);
  await expect(page.getByTestId('stale-badge')).toHaveCount(0);

  // The bundle became real, dispatchable work: the cleanly-materialized add
  // (under the still-living parent) appears in the ready set.
  await page.goto('/ready');
  await expect(
    page
      .getByRole('list', { name: 'Ready work items' })
      .getByText(seed.cleanProposalUnderBusyParent),
  ).toBeVisible();

  // ── 4. Decline branch on the clean plan ───────────────────────────────────
  //
  // `?view=canvas` is written even though this plan's proposals sit under ONE
  // container and the canvas is therefore already its default (MOTIR-3262): the
  // assertions below are about the canvas, and a spec that relies on a DERIVED
  // default is a spec that silently changes subject when the fixture changes
  // shape by one proposal.
  await page.goto(`/plans/${seed.declinePlan.id}?view=canvas`);
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

  // ── MOTIR-3160 / MOTIR-3161 (bug MOTIR-3154) — …ALONGSIDE the cards ────────
  //
  // The comment above used to open "Decline DROPS every proposed item". It no
  // longer does: not writing to the tree is what declining MEANS, and erasing
  // the proposal was a separate act that destroyed the only record of what was
  // offered and refused. The MOTIR-1377 outcome assertion above is UNCHANGED in
  // meaning and still passes; what is new is that it now stands beside the cards
  // it decided about.
  const declinedCard = page.getByTestId('plan-item-node').filter({ hasText: seed.declineProposal });
  await expect(declinedCard).toHaveCount(1);
  // By TEXT, not by a class — a colour-only treatment must not pass here either.
  await expect(declinedCard.getByTestId('plan-item-outcome')).toHaveText('declined');
  // It never became anything, so it has no key to show and none is invented.
  await expect(declinedCard).toContainText('New');

  // The list also reflects the declined status on its pill — and its REAL item
  // count, which read `0 items` for as long as the rows were deleted.
  await page.goto('/plans?status=declined');
  const declinedRow = page.locator(`a[href="/plans/${seed.declinePlan.id}"]`);
  await expect(declinedRow).toContainText('Declined');
  await expect(declinedRow).toContainText('1 item');

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

// MOTIR-3073 — a project that ALREADY HAS CODE must land on its new items, not on
// the code-hosting step. The defect: `proposeRepositorySet`'s only gate asked "has
// this project's set been proposed before?", which is always false for a project
// that arrived through the migrate path (that path records its repository on the
// onboarding run and never writes the set table). So approval proposed a starter
// repo, the step took the canvas the approved plan's items belong on, and the row
// it created became the project's whole repo-pin domain.
//
// Guarded on ABSENCE (CLAUDE.md § E2E): the assertion is that the hosting step's
// heading is NOT there. Asserting some other thing IS there would pass while the
// step rendered beside it.
test('Plans: approving on a project that already has code shows the items, not the hosting step', async ({
  page,
}) => {
  const seed = await seedPlansReview('plans-review-has-code@example.com');

  // The project ARRIVED with its code — the migrate path's record, which is the
  // project-scoped signal the proposer's gate reads.
  // `adminDb`: `migrate_onboarding` is RLS-bound to the active workspace GUC, which
  // a spec's own client does not set — seeding goes through the superuser client.
  await adminDb.migrateOnboarding.create({
    data: {
      workspaceId: seed.workspaceId,
      projectId: seed.projectId,
      step: 'done',
      status: 'completed',
      connectedRepoRef: 'acme/existing-app',
      codeGraphReady: true,
    },
  });

  await signIn(page, seed.email, PLANS_SEED_PASSWORD);
  await page.goto(`/plans/${seed.declinePlan.id}`);
  await expect(page.getByTestId('plan-status-pill')).toContainText('Ready to review');

  const approveResponse = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/plans/${seed.declinePlan.id}/approve`) &&
      r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /Approve.*to your backlog/ }).click();
  expect((await approveResponse).status()).toBe(200);

  // Approved, WITHOUT re-navigating — the surface the user is left looking at is
  // the one under test.
  await expect(page.getByTestId('plan-status-pill')).toContainText('Approved');

  // The hosting step is ABSENT …
  await expect(page.getByText('Motir will host your code')).toHaveCount(0);
  // … and the canvas is still showing the plan's own items.
  await expect(page.getByText(seed.declineProposal)).toBeVisible();

  // ⚠️ READ against Part VI §4 by MOTIR-3163, and UNCHANGED — deliberately.
  // Part VI re-decides what the pane holds when a set IS proposed: the step now
  // takes a BAND above the canvas instead of replacing it. This project arrives
  // with code, so `proposeRepositorySet`'s gate proposes NOTHING and there is no
  // band to draw — the absence assertion above is about a step that was never
  // summoned, not about a step that was replaced. Both assertions therefore mean
  // exactly what they meant before, and the count below still pins the durable
  // half. The BAND's own case is pinned by the `PlanDetail` component test.
  await expect(page.getByTestId('plan-detail-establish-band')).toHaveCount(0);

  // And nothing was provisioned: the visible half of this defect was a screen, the
  // durable half was a row that should never have existed.
  expect(await adminDb.projectRepo.count({ where: { projectId: seed.projectId } })).toBe(0);
});

// MOTIR-3074 — the rail's status tag COLLIDED with the plan title. Plan titles are
// GENERATED: long by default, and routinely carrying an unbreakable token (a
// SCREAMING_CASE constant, a cuid). The title and a `shrink-0` pill shared one
// `flex items-center` row, so the title wrapped to five lines while the one-line
// pill stayed centred against the block — the tag landed inside the title's text
// column — and the title's own min-content (its longest word) pushed the `<aside>`
// past its fixed 22rem track.
//
// This is the GEOMETRY half of the fix, and it lives here rather than in a
// component test on purpose: happy-dom reports all-zero geometry, so
// `tests/components/plan-review-rail-status-overline.test.tsx` can only pin the
// STRUCTURE. Measured at the SHIPPED rail width (the real 22rem column of the real
// page), not at a full-page viewport — a page-level `scrollWidth` check passes
// while the rail overflows inside its own scroll container.
test('Plans: a long unbreakable title never overflows the rail, and the status tag stays clear of it', async ({
  page,
}) => {
  const seed = await seedPlansReview('plans-review-long-title@example.com');

  // The reported title, both unbreakable tokens intact: a SCREAMING_CASE constant
  // and a 25-character cuid. `adminDb` — `plan` is RLS-bound to the active
  // workspace GUC, which a spec's own client does not set.
  const LONG_TITLE =
    'Mirror the sweep-is-not-its-grep-pattern limb into SHARED_PLANNING_RULES (motir-ai) — supersedes plan cmszanri500bfi3phws7wdiu8';
  await adminDb.plan.update({
    where: { id: seed.declinePlan.id },
    data: { title: LONG_TITLE },
  });

  await signIn(page, seed.email, PLANS_SEED_PASSWORD);
  await page.goto(`/plans/${seed.declinePlan.id}`);

  const rail = page.getByRole('complementary', { name: 'Plan review' });
  await expect(rail).toBeVisible();
  const pill = page.getByTestId('plan-status-pill');
  await expect(pill).toContainText('Ready to review');
  const heading = page.getByRole('heading', { level: 2, name: LONG_TITLE });
  await expect(heading).toBeVisible();

  const geometry = await rail.evaluate((el) => {
    const h2 = el.querySelector('h2') as HTMLElement;
    const tag = el.querySelector('[data-testid="plan-status-pill"]') as HTMLElement;
    const railBox = el.getBoundingClientRect();
    const titleBox = h2.getBoundingClientRect();
    const tagBox = tag.getBoundingClientRect();
    const padRight = parseFloat(getComputedStyle(el).paddingRight);
    return {
      railOverflow: el.scrollWidth - el.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      // How far the title's box runs past the rail's padded content edge.
      titleOverhang: titleBox.right - (railBox.right - padRight),
      // The title genuinely WRAPS here — otherwise this asserts nothing. Counted
      // off the rendered line boxes rather than height/line-height, which returns
      // NaN whenever `line-height` computes to `normal`.
      titleLines: (() => {
        const range = document.createRange();
        range.selectNodeContents(h2);
        return range.getClientRects().length;
      })(),
      // The defect, stated as geometry: the tag's box inside the title's rows.
      tagOverlapsTitle: !(
        tagBox.bottom <= titleBox.top + 0.5 || tagBox.top >= titleBox.bottom - 0.5
      ),
    };
  });

  // No horizontal overflow — of the rail's own scroll container, or of the page.
  expect(geometry.railOverflow).toBeLessThanOrEqual(1);
  expect(geometry.pageOverflow).toBeLessThanOrEqual(1);
  // The title stays inside the rail's content column …
  expect(geometry.titleOverhang).toBeLessThanOrEqual(1);
  // … while actually wrapping (a one-line title would make the rest vacuous) …
  expect(geometry.titleLines).toBeGreaterThan(1);
  // … and no text runs under the tag.
  expect(geometry.tagOverlapsTitle).toBe(false);
});
