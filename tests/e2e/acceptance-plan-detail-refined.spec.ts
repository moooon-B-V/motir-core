import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanShapes, PLANS_SHAPES_PASSWORD } from './_helpers/plans-shapes-seed';
import { test, expect } from './_helpers/acceptance-video';
import type { Page } from '@playwright/test';

// ACCEPTANCE — the plan DETAIL, refined (Story MOTIR-4016 · Subtask MOTIR-4026).
// The story's `verification_recipe`, walked end to end and recorded as the
// receipt a person watches to accept it.
//
// ⚠️ IT SITS BESIDE `acceptance-plan-shapes.spec.ts`, and does not extend it.
// That spec is MOTIR-3232's proof of three plan SHAPES — where the canvas
// arrives, what Show changes marks, which body opens — and every assertion in it
// is still true and still wanted. This one is about what those surfaces SAY: the
// title a rename proposes, the room the pane takes, the state it arrives in, the
// words its search box uses, the door a list row is, and where the decision sits.
// Two clips, one per card, and the story is not accepted until both are on it.
//
// ── What "authoritative" means here ─────────────────────────────────────────
//
// Every assertion reads an accessible name, a `data-testid` or a SHIPPED class.
// Two legs own a geometry check and say so at the assertion — leg 2's fold and
// leg 8's decision — because those two deliverables ARE geometry and nothing else
// can stand in for them. Nothing else in this file reads a pixel, and nothing
// anywhere reads a computed opacity, which is a token the style axis may move.

test.describe.configure({ timeout: 900_000 });

/** The default walk. Wide enough for a level to lay out without stacking. */
const VIEWPORT = { width: 1440, height: 900 };
/** The floor this story is measured against — the tightest real laptop. */
const NARROW = { width: 1366, height: 768 };

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
const nodeBox = (page: Page, nodeId: string) =>
  page.locator(`[data-node-id="${nodeId}"] > div`).first();
const showChanges = (page: Page) => page.getByTestId('show-changes-toggle');
const locateButton = (page: Page) => page.getByTestId('locate-button');
const proposalList = (page: Page) => page.getByTestId('plan-proposal-list');
const transcript = (page: Page) => page.getByTestId('plan-review-transcript');
const searchBox = (page: Page) => page.getByRole('searchbox');
const approve = (page: Page) => page.getByRole('button', { name: /^Approve/ });
const decline = (page: Page) => page.getByRole('button', { name: 'Decline' });

/** Is the element fully inside the window, vertically? The two geometry legs. */
async function isWithinFold(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight + 1;
  }, selector);
}

test('the plan detail, refined — the story’s verification recipe', async ({
  page,
  chapter,
  acceptanceStory,
}) => {
  // WHICH STORY THIS CLIP BELONGS TO. Without it the recording can never be
  // published to the story, and `e2e-acceptance-lane-membership.test.ts` fails
  // the unit lane rather than letting a receipt go nowhere. It is a FIXTURE, not
  // a module import — the uploader reads the fixture, not the prose.
  acceptanceStory('MOTIR-4016');
  const seed = await seedPlanShapes('acceptance-plan-detail-refined@example.com');
  await page.setViewportSize(VIEWPORT);
  await signIn(page, seed.email, PLANS_SHAPES_PASSWORD);

  // ── LEG 1 · recipe step 1 — the PROPOSED title, in both bodies ─────────────
  await chapter('A plan that renames a card shows the name it is ASKING for', async () => {
    await page.goto(`/plans/${seed.two.planId}`);

    // The canvas node's headline is the PROPOSED title, not the one the card is
    // about to stop being called. The node is a SIGNAL; the list SPELLS the
    // change, and both are asserted because the defect was that they disagreed.
    const modified = nodeBox(page, seed.two.modified.id);
    await expect(modified).toContainText('Invoice templates + branding');

    await page.goto(`/plans/${seed.two.planId}?view=list`);
    const row = proposalList(page).getByRole('button', {
      name: `Open ${seed.two.modified.identifier} · Invoice templates + branding`,
    });
    await expect(row).toBeVisible();
    // …and the TITLE change line still spells old → new: the outgoing name
    // survives, on the one surface whose job it is.
    await expect(proposalList(page)).toContainText('Invoice templates');
  });

  // ── LEG 2 · recipe step 2 — the pane FILLS THE FOLD ────────────────────────
  await chapter(
    'The pane reaches the bottom of the window, at 1440×900 and at 1366×768',
    async () => {
      for (const viewport of [VIEWPORT, NARROW]) {
        await page.setViewportSize(viewport);
        await page.goto(`/plans/${seed.two.planId}`);
        await expect(nodeBox(page, seed.two.modified.id)).toBeVisible();

        // ⚠️ ONE OF THIS FILE'S TWO GEOMETRY CHECKS, and it is here because the
        // deliverable IS geometry. The pane's bottom edge sits within the shell's
        // own clearance of the window bottom — no dead band — and the page does not
        // scroll. The shipped shape left 91–99px of empty page under the graph.
        const fold = await page.evaluate(() => {
          const box = document.querySelector('main div.overflow-hidden') as HTMLElement | null;
          const rect = box?.getBoundingClientRect();
          return {
            gap: rect ? Math.round(window.innerHeight - rect.bottom) : null,
            scrolls: document.documentElement.scrollHeight > window.innerHeight + 1,
          };
        });
        expect(fold.scrolls, `the page scrolls at ${viewport.width}x${viewport.height}`).toBe(
          false,
        );
        // `--shell-bottom-clearance` is 6rem with the orb mounted and 1.5rem
        // without, so the band the pane may leave is at most the orb's.
        expect(fold.gap, `dead band at ${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(
          96,
        );
      }
      await page.setViewportSize(VIEWPORT);
    },
  );

  // ── LEG 3 · recipe step 3 — the changes are LIT ON ARRIVAL ─────────────────
  await chapter('The plan’s changes are already marked when the reader lands', async () => {
    await page.goto(`/plans/${seed.two.planId}`);
    await expect(nodeBox(page, seed.two.modified.id)).toBeVisible();

    // ARMED, with no interaction: this is the whole deliverable.
    await expect(showChanges(page)).toHaveAttribute('aria-pressed', 'true');
    for (const id of [...seed.two.addedNodeIds, seed.two.modified.id]) {
      await expect(nodeBox(page, id)).toHaveAttribute('data-emphasised', 'true');
    }
    // …and the COMPLEMENT, which is what makes the first assertion mean
    // something. On the shipped class, never a computed opacity.
    for (const untouched of seed.two.untouched) {
      await expect(nodeBox(page, untouched.id)).toHaveClass(/opacity-35/);
    }

    // The pressed control has a real, non-transparent fill — the defect was a
    // token that did not exist, so the control rendered with no background at
    // all while every other signal was green.
    const fill = await showChanges(page).evaluate(
      (el) => getComputedStyle(el as HTMLElement).backgroundColor,
    );
    expect(fill, 'the pressed control has no background').not.toBe('rgba(0, 0, 0, 0)');
    expect(fill).not.toBe('transparent');

    // A reader who did not arm it can still turn it off.
    await showChanges(page).click();
    await expect(showChanges(page)).toHaveAttribute('aria-pressed', 'false');
    for (const untouched of seed.two.untouched) {
      await expect(nodeBox(page, untouched.id)).not.toHaveClass(/opacity-35/);
    }
  });

  await chapter('A level that is entirely the plan’s arrives unlit, and says why', async () => {
    // Shape ONE hangs three subtasks off a PROPOSED story, and the canvas ARRIVES
    // on the level the plan most fills (Part IX §1) — which for this shape is the
    // proposed story's own children. That level has no committed neighbourhood at
    // all, so ringing every card would say nothing: it is the mirror of the level
    // the plan does not reach, and it takes the same disposition for the opposite
    // reason (Part XIII §3d, reversing Part IX §L6).
    //
    // ⚠️ `?view=canvas` IS LOAD-BEARING, and it is a fact about this shape rather
    // than a convenience: shape ONE straddles two containers (the epic holds the
    // story, the story holds the subtasks), so the derived default correctly
    // opens it as a LIST — Part IX §3's arm, unchanged by this story. The
    // emphasis lives on the canvas, so the walk asks for it.
    await page.goto(`/plans/${seed.one.planId}?view=canvas`);
    await expect(page.getByText(seed.one.subtaskTitles[0]!)).toBeVisible();

    await expect(showChanges(page)).toBeDisabled();
    await expect(showChanges(page)).toHaveAttribute(
      'title',
      "Every item on this level is this plan's",
    );
    // The LOCATE control stays enabled: ringing everything says nothing, walking
    // everything says something. The two fail on opposite degeneracies.
    await expect(locateButton(page)).toBeEnabled();
  });

  // ── LEG 4 · recipe step 4 — the search box’s own words ─────────────────────
  await chapter(
    'The search box on a plan says “Search this plan”, and the roadmap keeps its own',
    async () => {
      await page.goto(`/plans/${seed.two.planId}`);
      await expect(searchBox(page)).toHaveAttribute('aria-label', 'Search this plan');
      await expect(searchBox(page)).toHaveAttribute('placeholder', 'Search this plan');

      // BOTH surfaces. "The roadmap keeps its sentence" is the half a sweep of this
      // shape is most likely to break.
      await page.goto('/roadmap');
      await expect(searchBox(page)).toHaveAttribute('aria-label', 'Search the roadmap');
    },
  );

  // ── LEG 5 · recipe step 5 — the LOCATE walk ───────────────────────────────
  await chapter('The locate control walks the plan’s own cards, and wraps', async () => {
    await page.goto(`/plans/${seed.two.planId}`);
    await expect(nodeBox(page, seed.two.modified.id)).toBeVisible();

    await expect(locateButton(page)).toBeEnabled();
    await locateButton(page).click();
    await expect(page.getByTestId('locate-hint')).toHaveText('1 / 3');
    await locateButton(page).click();
    await expect(page.getByTestId('locate-hint')).toHaveText('2 / 3');
    await locateButton(page).click();
    await expect(page.getByTestId('locate-hint')).toHaveText('3 / 3');
    // Past the last it wraps rather than stopping.
    await locateButton(page).click();
    await expect(page.getByTestId('locate-hint')).toHaveText('1 / 3');
  });

  // ── LEG 6 · recipe step 6 — a LIST ROW opens its proposal ──────────────────
  await chapter('A list row opens the same read view the canvas’s View pill opens', async () => {
    await page.goto(`/plans/${seed.two.planId}?view=list`);
    const row = proposalList(page).getByRole('button', { name: /^Open New · Usage metering/ });
    await expect(row).toBeVisible();

    // THE POINTER PATH.
    await row.click();
    const peek = page.getByTestId('proposal-quick-view');
    await expect(peek).toBeVisible();
    // ONE close affordance. The shipped modal rendered two, 40px apart, with the
    // identical accessible name.
    await expect(page.getByRole('dialog').getByRole('button', { name: /close/i })).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(peek).toBeHidden();

    // THE KEYBOARD PATH, driven as a keyboard user drives it — the row is REACHED
    // with focus, opened with Enter, and closed with Escape, and focus comes back
    // to the row it left. (Opening by MOUSE and asserting focus return is a
    // different claim and not the one the a11y contract makes: the dialog returns
    // focus to whatever had it, which after a click is the pointer's business.)
    await row.focus();
    await expect(row).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('proposal-quick-view')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('proposal-quick-view')).toBeHidden();
    await expect(row).toBeFocused();
  });

  // ── LEG 7 · recipe step 7 — the LIST opens when the canvas cannot hold them ─
  await chapter('A plan buried in a crowded container opens as a LIST', async () => {
    // ONE container, so the shipped container-count rule says canvas; eighteen
    // nodes, so the level cannot arrive legibly and the widened rule says list.
    // Indistinguishable from shape TWO to a reader who only counts containers.
    await page.goto(`/plans/${seed.four.planId}`);
    await expect(proposalList(page)).toBeVisible();
    // The URL stays CLEAN whatever the default resolves to.
    expect(new URL(page.url()).searchParams.get('view')).toBeNull();

    // The switcher still flips to the canvas and back.
    await page.getByRole('button', { name: 'Canvas' }).click();
    await expect(page.getByTestId('roadmap-canvas')).toBeVisible();
    await page.getByRole('button', { name: 'List' }).click();
    await expect(proposalList(page)).toBeVisible();
  });

  // ── LEG 8 · recipe step 8 — the rail LANDS ON ITS DECISION ─────────────────
  await chapter(
    'The decision is on screen on a long plan, at 1440×900 and at 1366×768',
    async () => {
      for (const viewport of [VIEWPORT, NARROW]) {
        await page.setViewportSize(viewport);
        await page.goto(`/plans/${seed.four.planId}`);
        // The plan with the long generated title and the long summary.
        await expect(page.getByRole('heading', { level: 2 })).toContainText('Re-plan MOTIR-3232');

        // The transcript opens at its LATEST turn.
        const atEnd = await transcript(page).evaluate(
          (el) => el.scrollHeight - el.clientHeight - el.scrollTop <= 2,
        );
        expect(atEnd, `the transcript is not at its end at ${viewport.width}`).toBe(true);

        // ⚠️ THE SECOND GEOMETRY CHECK, and the deliverable IS geometry: the two
        // controls the page exists for are inside the window WITHOUT scrolling.
        // The shipped rail put Approve 361px below the fold at this width.
        await expect(approve(page)).toBeVisible();
        await expect(decline(page)).toBeVisible();
        expect(
          await isWithinFold(page, 'aside[aria-label] > div:last-child'),
          `the decision footer is not fully inside the fold at ${viewport.width}x${viewport.height}`,
        ).toBe(true);
      }
      await page.setViewportSize(VIEWPORT);
    },
  );
});
