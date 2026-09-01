import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanShapes, PLANS_SHAPES_PASSWORD } from './_helpers/plans-shapes-seed';
import { test, expect } from './_helpers/promoted-regression';
import type { Page } from '@playwright/test';

// ACCEPTANCE — the plan DETAIL at three plan SHAPES (Story MOTIR-3232 · Subtask
// MOTIR-3263). Verification-recipe steps 6, 7 and 8, driven through the real
// stack, and recorded as the SECOND HALF of the story's receipt.
//
// ⚠️ IT SITS BESIDE `plans-review.spec.ts`, and does not extend it — the card
// asks for that decision to be stated. That spec is Story 7.21's proof of the
// REVIEW journey (a stale plan, approve-anyway, decline), and every assertion in
// it is still true and still wanted; none of it is about where a canvas arrives,
// what an emphasis marks, or which body a plan opens in. It is also not in this
// lane, so the receipt half could not live there at all.
//
// ⚠️ AND THE OTHER BOUNDARY: recipe steps 1–5 — the tabs, the paging, the
// attribution, the discard valve — belong to `acceptance-plans-surface.spec.ts`
// (MOTIR-3243) and to nothing here. The story's receipt is TWO clips, one from
// each card's own pull-request run, and the story is not accepted until both are
// on it.
//
// ── The three legs are three SHAPES, not three features ──────────────────────
//
// Each is a topology a real planning pass produces, and each is the input at
// which one of the three canvas cards changes what a person sees:
//
//   1. a proposed story with subtasks hung off it  → where the canvas ARRIVES
//   2. two adds and a modify under one epic        → what Show changes MARKS
//   3. proposals under two distinct containers     → which BODY opens
//
// DETERMINISM: every wait is on an authoritative signal — a rendered node, a
// crumb, a URL, an attribute. There is no bare timeout in this file and no
// `retries`. The pacing helpers are not waits: each runs AFTER the assertion that
// already proved the state (see the note at `CHAPTER_HOLD_MS`).

// The seed builds a tenant, three committed subtrees and three plans, and the
// recorded walk holds ~60s for a viewer on top of that. A timeout is a CEILING,
// not a wait — a green run pays nothing for the headroom.
test.describe.configure({ timeout: 900_000 });

/** Wide enough for the canvas to lay a level out without the nodes stacking, and
 *  tall enough that a four-child level is on screen at once. */
const VIEWPORT = { width: 1440, height: 900 };

/**
 * Every uncaught client error the page threw, for the WHOLE test.
 *
 * ⚠️ THE CANVAS IS WHY THIS IS NOT OPTIONAL. It mounts a layout engine over a
 * level whose node set changes on every drill, and this spec drills, crumbs back
 * up, toggles an emphasis over most of the screen and swaps the whole body twice.
 * A thrown render there is the failure mode that a passing assertion somewhere
 * else will happily talk over.
 */
const pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on('pageerror', (error) => pageErrors.push(`${error.message}\n${error.stack ?? ''}`));
});

test.afterEach(() => {
  expect(pageErrors, `uncaught client errors:\n${pageErrors.join('\n---\n')}`).toEqual([]);
});

test.beforeAll(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Locators ─────────────────────────────────────────────────────────────────
//
// A canvas node is addressed by `data-node-id`, which is what `planReviewService`
// keys a node by: the work item a proposal is ABOUT, falling back to the
// plan-item id when there is not one yet. Every id here comes from the seed's
// return value — never from a query written in this file.

const canvas = (page: Page) => page.getByTestId('roadmap-canvas');
const node = (page: Page, nodeId: string) => page.locator(`[data-node-id="${nodeId}"]`);
/** The wrapper `renderNode` puts the ring, the emphasis attribute and the dim on
 *  — a CHILD of the positioned node box, not the box itself. */
const nodeBox = (page: Page, nodeId: string) =>
  page.locator(`[data-node-id="${nodeId}"] > div`).first();
const crumbs = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });
const showChanges = (page: Page) => page.getByTestId('show-changes-toggle');
const viewSwitcher = (page: Page) => page.getByRole('group', { name: 'Plan view' });

/** The plan's own emphasis attribute, read as a nullable string so the ABSENT
 *  case is expressible — which is the half of leg 2 that catches an
 *  implementation marking everything. */
async function emphasisOf(page: Page, nodeId: string): Promise<string | null> {
  return nodeBox(page, nodeId).getAttribute('data-emphasised');
}

test('Plan detail: the canvas lands where the plan is, Show changes marks what it touches, and a straddling plan opens as a list', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The clip publishes to the STORY from this card's own pull-request run, and
  // joins MOTIR-3243's there. Neither is the whole receipt.
  acceptanceStory('MOTIR-3232');

  await page.setViewportSize(VIEWPORT);
  const seed = await seedPlanShapes('plan-shapes-acceptance@example.com');
  await signIn(page, seed.email, PLANS_SHAPES_PASSWORD);

  // ── LEG 1 · recipe step 6 — the canvas arrives ON the proposed story ───────
  await chapter('A plan of one story and its subtasks lands on the story', async () => {
    await page.goto(`/plans/${seed.one.planId}`);

    // ⚠️ IT OPENS ON THE LIST, and that is this shape rather than a surprise: its
    // proposals sit under TWO containers (the epic holds the story, the story
    // holds the subtasks), which is exactly the straddle MOTIR-3262's derived
    // default is about. The card was written before that rule landed. Asserting
    // it here, on a DIFFERENT topology from leg 3's, is stronger than leg 3
    // alone — a rule that keyed off "has an intra-plan ref" would pass leg 3 and
    // fail here.
    await expect(page.getByTestId('plan-proposal-list')).toBeVisible();
    expect(new URL(page.url()).search).toBe('');
    await beat();

    await viewSwitcher(page).getByRole('button', { name: 'Canvas' }).click();
    await page.waitForURL(`**/plans/${seed.one.planId}?view=canvas`);
    await expect(canvas(page)).toBeVisible();

    // The three proposed subtasks are here…
    for (const title of seed.one.subtaskTitles) {
      await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
    }
    // …and the epic's committed sibling stories are NOT. This is the half that
    // fails on a canvas showing the whole tree, and the half an assertion about
    // the subtasks alone would pass straight over.
    for (const sibling of seed.one.committedSiblings) {
      await expect(node(page, sibling.id)).toHaveCount(0);
    }
    await beat();

    // THE BREADCRUMB IS THE CHAIN, not one crumb: the level's own crumb names the
    // PROPOSED story (the proposed word where a key would go — nothing is real
    // until approve), and the crumb above it names the committed epic.
    await expect(
      crumbs(page).getByRole('button', { name: seed.one.proposedStory.crumb }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(crumbs(page).getByRole('button', { name: seed.one.epic.crumb })).toBeVisible();
    await beat();

    // …and it is an ORDINARY drilled view: the ancestor crumb navigates up, and
    // on the epic's level the proposed story is one card among its committed
    // siblings rather than a special case.
    await crumbs(page).getByRole('button', { name: seed.one.epic.crumb }).click();
    await expect(node(page, seed.one.proposedStory.id)).toBeVisible();
    await expect(node(page, seed.one.committedSiblings[0]!.id)).toBeVisible();
    await beat();
  });

  // ── LEG 2 · recipe step 7 — Show changes marks the PLAN, not the new ───────
  await chapter('Show changes marks everything the plan touches, and only that', async () => {
    await page.goto(`/plans/${seed.two.planId}`);

    // ⚠️ AND THIS IS ALSO LEG 3's CONTROL CASE. Every proposal here sits under ONE
    // container, so the derived default is the CANVAS and the URL stays clean. A
    // rule that always answered "list" would pass leg 3 and fail this line.
    await expect(canvas(page)).toBeVisible();
    expect(new URL(page.url()).search).toBe('');
    // It opened on the EPIC's level — the same fullest-container rule as leg 1,
    // landing somewhere else, which is what says the arrival is derived rather
    // than a hard-coded depth.
    await expect(crumbs(page).getByRole('button', { name: seed.two.epic.crumb })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await beat();

    // ⚠️ ARMED ON ARRIVAL (MOTIR-4020, design Part XIII §3). This leg used to
    // press the control first; it now asserts the state a reader LANDS in, with
    // no interaction at all, because that is the whole change. The click below
    // therefore DISARMS — which is the other half of §3b's answer: the pressed
    // treatment plus `aria-pressed` is the affordance, and a reader who did not
    // arm it can still turn it off.
    await expect(showChanges(page)).toBeEnabled();
    await expect(showChanges(page)).toHaveAttribute('aria-pressed', 'true');

    // THE EMPHASIS SPANS TWO OPS: the two proposed stories AND the committed
    // story the plan modifies. An implementation that marked "the new cards"
    // would satisfy a one-op leg and miss what the control is for.
    for (const id of [...seed.two.addedNodeIds, seed.two.modified.id]) {
      await expect(nodeBox(page, id)).toHaveAttribute('data-emphasised', 'true');
      await expect(nodeBox(page, id)).not.toHaveClass(/opacity-35/);
    }
    // …and the COMPLEMENT, which is the assertion that makes the first one mean
    // something: the untouched siblings carry no emphasis and DO carry the dim.
    // Asserted on the shipped class, never on a computed opacity — that would be
    // a brittle reading of a token the style axis is allowed to move.
    for (const untouched of seed.two.untouched) {
      expect(await emphasisOf(page, untouched.id)).toBeNull();
      await expect(nodeBox(page, untouched.id)).toHaveClass(/opacity-35/);
    }
    await beat();

    // Press it ONCE and BOTH go: the marks and the dimming.
    await showChanges(page).click();
    await expect(showChanges(page)).toHaveAttribute('aria-pressed', 'false');
    for (const id of [...seed.two.addedNodeIds, seed.two.modified.id]) {
      expect(await emphasisOf(page, id)).toBeNull();
    }
    for (const untouched of seed.two.untouched) {
      await expect(nodeBox(page, untouched.id)).not.toHaveClass(/opacity-35/);
    }
    await beat();
  });

  // ── LEG 3 · recipe step 8 — a straddling plan opens as a LIST ──────────────
  await chapter('A plan spread across two containers opens as a list', async () => {
    await page.goto(`/plans/${seed.three.planId}`);

    // No single canvas level can show this plan — its proposals sit under a
    // committed story AND a committed epic — so the surface opens on the body
    // that can answer the question, instead of insisting on the one that cannot.
    await expect(page.getByTestId('plan-proposal-list')).toBeVisible();
    await expect(canvas(page)).toHaveCount(0);
    for (const title of [...seed.three.addedSubtaskTitles, seed.three.addedStoryTitle]) {
      await expect(page.getByTestId('plan-proposal-list')).toContainText(title);
    }

    // ⚠️ AND THE URL IS STILL CLEAN. This is the part a reasonable implementation
    // gets wrong: the DEFAULT writes no parameter, whatever the default IS, so a
    // `/plans/[id]` link written before this story is still byte-identical.
    expect(new URL(page.url()).search).toBe('');
    await beat();

    // The switcher flips to the canvas, and NOW the URL carries the parameter —
    // because the canvas is not this plan's default.
    await viewSwitcher(page).getByRole('button', { name: 'Canvas' }).click();
    await page.waitForURL(`**/plans/${seed.three.planId}?view=canvas`);
    await expect(canvas(page)).toBeVisible();
    await beat();

    // A reload keeps it — the URL is the single source of truth…
    await page.reload();
    await expect(canvas(page)).toBeVisible();

    // …and Back returns to the list, because the switch pushed history.
    await page.goBack();
    await page.waitForURL(`**/plans/${seed.three.planId}`);
    await expect(page.getByTestId('plan-proposal-list')).toBeVisible();
    await beat();
  });
});

test('Plan detail: the two degenerate canvas levels — all proposals, and none', async ({
  page,
}) => {
  await page.setViewportSize(VIEWPORT);
  const seed = await seedPlanShapes('plan-shapes-degenerate@example.com');
  await signIn(page, seed.email, PLANS_SHAPES_PASSWORD);

  // ── DEGENERATE 1 — a level that is ENTIRELY proposals ─────────────────────
  //
  // Reached by the arrival itself: shape one's canvas opens inside a container
  // that does not exist yet, so the level has no committed neighbours at all.
  // No component test reaches this — the level's membership is computed from a
  // real plan against a real tree.
  await page.goto(`/plans/${seed.one.planId}?view=canvas`);
  await expect(canvas(page)).toBeVisible();
  await expect(page.getByTestId('plan-item-node')).toHaveCount(seed.one.subtaskTitles.length);
  // EVERY node on the level is one of them — the honest way to say "no committed
  // neighbours", and it does not depend on knowing which committed ids to name.
  expect(await page.locator('[data-node-id]').count()).toBe(seed.one.subtaskTitles.length);

  // ⚠️ REVERSED by MOTIR-4020 (design Part XIII §3d), and the reversal is the
  // point. This case used to press the control and assert that every card lit —
  // Part IX §L6's *"correct and harmless"*. It was, of a state the reader CHOSE.
  // Now the emphasis is ARMED ON ARRIVAL, so that same screen would arrive
  // unasked: every card ringed, none dimmed, teaching the reader at the moment
  // they land that the ring means nothing. So this level DISABLES the control,
  // with its own reason — the mirror of degenerate 2 below, same disposition and
  // opposite emptiness.
  await expect(showChanges(page)).toBeDisabled();
  await expect(showChanges(page)).toHaveAttribute(
    'title',
    "Every item on this level is this plan's",
  );
  const levelNodes = page.locator('[data-node-id]');
  for (let i = 0; i < (await levelNodes.count()); i += 1) {
    const box = levelNodes.nth(i).locator('> div').first();
    // Nothing is ringed and nothing is dimmed: the screen says nothing, and now
    // says so with a control that explains why rather than with a lit board.
    await expect(box).not.toHaveAttribute('data-emphasised', 'true');
    await expect(box).not.toHaveClass(/opacity-35/);
  }

  // ── DEGENERATE 2 — a level the plan does not reach AT ALL ──────────────────
  //
  // The project's top level: shape two's plan lives under one epic, so none of
  // its cards are here. The control is DISABLED and says why, rather than
  // switching on to dim every card and ring none — a screen that says nothing is
  // worse than a control that says why it cannot help.
  await page.goto(`/plans/${seed.two.planId}`);
  await expect(canvas(page)).toBeVisible();
  await expect(showChanges(page)).toBeEnabled();

  await crumbs(page).getByRole('button', { name: 'Roadmap' }).click();
  // The epic is a card on the root level; none of the plan's cards are.
  await expect(node(page, seed.two.epic.id)).toBeVisible();
  for (const id of [...seed.two.addedNodeIds, seed.two.modified.id]) {
    await expect(node(page, id)).toHaveCount(0);
  }
  await expect(showChanges(page)).toBeDisabled();
  await expect(showChanges(page)).toHaveAttribute(
    'aria-description',
    'No proposed changes on this level',
  );

  // The verdict for both legs is `afterEach`'s: `pageErrors` empty throughout.
});
