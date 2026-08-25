import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedChildPanelGraph,
  CHILD_PANEL_GRAPH_PASSWORD,
  type ChildPanelGraphSeed,
} from './_helpers/child-panel-graph-seed';
import { seedPlanShapes, PLANS_SHAPES_PASSWORD } from './_helpers/plans-shapes-seed';

// ACCEPTANCE — navigation is instant (Story MOTIR-3430 · Subtask MOTIR-3438).
//
// ⚠️ WHY THIS STORY NEEDS A BROWSER AND A CLIP MORE THAN MOST. Everything it
// delivers is invisible to the assertions that normally protect a change. The
// item page renders the same regions before and after; the plan's Canvas and
// List bodies are unchanged; every URL still carries the same params and every
// deep link still resolves. What changed is WHEN things appear — and the only
// instrument that can see that is a browser, which is why this spec is the only
// place the story's actual claim is checked.
//
// TWO ASSERTIONS CARRY THE CARD, and both are shaped to fail on the OLD
// behaviour rather than pass slowly against it:
//
//   · THE ORDERED ARRIVAL. The item's title is asserted visible WHILE a late
//     section is still reading. An unordered "eventually the title is there" is
//     green today, against the very behaviour this story exists to remove — the
//     page that shows the previous surface for twenty-nine SEQUENTIAL reads
//     would satisfy it perfectly, just late. Ordering is the whole claim.
//   · THE ZERO-REQUEST SWITCH. A view switch looks identical either way; the
//     whole difference is a network request that either happens or does not. So
//     the switch is driven with a request listener armed, and the assertion is
//     that NO document or RSC request fires across it. That is the only direct
//     statement of what the shallow-URL card did.
//
// ── PACING IS A PROPERTY OF THIS SPEC, NOT AN ACCIDENT ─────────────────────
// The clip exists so a person can SEE the difference between arriving instantly
// and waiting. A recording driven at machine speed satisfies every assertion
// and shows a reviewer nothing they can accept on. So each step gets its own
// chapter and a `beat()` where the reader's eye needs to land — and the beats
// are around the ARRIVAL and the SWITCHES, which are the two moments the story
// is about.
//
// ── DETERMINISM ────────────────────────────────────────────────────────────
// Every wait is on an authoritative signal: a locator's state, a response, or a
// request event. There is no `waitForTimeout` in this file and no fixed sleep
// standing in for a signal — `beat()` is the camera's, and never the proof.
// Each assertion has already been made against a real state before any hold.
//
// ── THE LANE ───────────────────────────────────────────────────────────────
// The ACCEPTANCE lane, for the RECEIPT rather than the environment: nothing
// here needs a cloud-on flag. Its disposition when the receipt freezes is
// therefore a PROMOTE into the main lane — the ordered-arrival and zero-request
// assertions are exactly the regression guards this story wants standing
// afterwards, and they run identically under `playwright.config.ts`.

// This spec is six chapters and each is paced for a viewer, so the recording
// alone runs well past the lane's 90s default. A `timeout` is a ceiling, not a
// wait — raising it costs a green run nothing. Precedent:
// `acceptance-implemented-lifecycle.spec.ts`, `child-panel-graph.spec.ts`.
test.describe.configure({ timeout: 300_000 });

const ITEM_EMAIL = 'navigation-instant-item@example.com';
const PLAN_EMAIL = 'navigation-instant-plan@example.com';

/**
 * A late section still resolving — `SectionCardSkeleton`'s `aria-busy`, the one
 * node the item page's `<Suspense>` fallbacks render while the late stack reads.
 *
 * This replaced a `page-skeleton` testid that stood for a route-level pending
 * FRAME. That frame is gone and deliberately so: a `loading.tsx` fallback
 * flushes the response head before the page function runs, which fixes the
 * status at 200 and destroys the `notFound()` 404 on every route beneath it —
 * including this page's own cross-workspace no-existence-leak contract. The
 * story keeps the half that is safe (an in-page `<Suspense>`, which renders
 * after the gate) and drops the half that is not.
 */
const pendingSection = (page: Page) => page.locator('[aria-busy="true"]').first();

/**
 * Count DOCUMENT and RSC requests while `run` executes.
 *
 * This is the story's load-bearing measurement, so it is deliberately not a
 * "no navigation happened" vibe check: Next's RSC refetch is an ordinary `fetch`
 * carrying `RSC: 1`, so a `router.push` that re-runs the server page shows up
 * here as a request even though the URL bar looks the same either way.
 */
async function serverRequestsDuring(page: Page, run: () => Promise<void>): Promise<string[]> {
  const hits: string[] = [];
  const listener = (req: import('@playwright/test').Request) => {
    const isDoc = req.resourceType() === 'document';
    const isRsc = req.headers()['rsc'] !== undefined || req.url().includes('_rsc=');
    if (isDoc || isRsc) hits.push(`${req.method()} ${req.url()}`);
  };
  page.on('request', listener);
  try {
    await run();
  } finally {
    page.off('request', listener);
  }
  return hits;
}

test('a work item opens on the click, streams its sections in, and a client-only switch never waits for a server', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-3430');
  await resetDatabase();

  const seed: ChildPanelGraphSeed = await seedChildPanelGraph(ITEM_EMAIL);
  await signIn(page, seed.email, CHILD_PANEL_GRAPH_PASSWORD);

  // ── 1 — arrive by URL: the frame lands BEFORE the item ────────────────────
  await chapter('Typing a work-item URL opens the page immediately', async () => {
    // The reported symptom, driven exactly as reported: a URL typed into the
    // address bar, not a click inside the app.
    await page.goto(`/items/${seed.storyKey}`);

    // ORDERED, and this is the assertion the card turns on. The item's own
    // title is on screen while the LATE STACK is still reading — so the page
    // no longer waits for its slowest section to render its first. Before this
    // story the browser sat on the PREVIOUS surface until the last of
    // twenty-nine SEQUENTIAL reads settled; the title could not appear first
    // because nothing appeared until everything had.
    await expect(page.getByRole('heading', { name: seed.storyTitle })).toBeVisible();
    await expect(pendingSection(page)).toBeVisible();
    await beat();

    // …and only THEN the late sections settle behind it.
    await expect(pendingSection(page)).toBeHidden();
    await beat();
  });

  // ── 2 — the late sections arrive behind the page ──────────────────────────
  await chapter('The sections below the fold fill in behind it', async () => {
    // The children list is TIER TWO — it is in the first flush, from the read
    // the page already had.
    await expect(page.getByRole('heading', { name: seed.designTitle })).toBeVisible();

    // Development · Attachments · Activity are the late stack. They arrive after
    // the page, together — one settle, which is what the design decided.
    await expect(page.getByRole('heading', { name: 'Development' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Attachments' })).toBeVisible();
    await beat();

    // The EMPTY states the design names, on a freshly seeded item that has
    // neither comments nor attachments — the states a reviewer should see the
    // page settle into rather than a spinner that never resolves.
    // The real catalog string, not a guess: `attachments.empty` is
    // "No attachments yet — attach a file or drop one here" and
    // `attachments.emptyReadOnly` is "No attachments yet". Matched on the shared
    // prefix so the assertion holds for both actor shapes.
    await expect(page.getByText(/No attachments yet/i).first()).toBeVisible();
    await beat();
  });

  // ── 3 — the Children switch: no server, and Back restores ─────────────────
  await chapter('Switching Children between List and Graph asks no server', async () => {
    const list = page.getByRole('button', { name: 'List' });
    const graph = page.getByRole('button', { name: 'Graph' });
    await expect(list).toHaveAttribute('aria-pressed', 'true');

    // The page's scroll offset before the switch — criterion 4. A switch that
    // re-rendered the host page would return the reader to the top.
    const scrollBefore = await page.evaluate(() => document.querySelector('main')?.scrollTop ?? 0);

    const during = await serverRequestsDuring(page, async () => {
      await graph.click();
      // The authoritative signal that the switch LANDED: the pressed state
      // moved. Not a timeout, and not the graph's own async level fetch —
      // which is the canvas's own read and is allowed to happen.
      await expect(graph).toHaveAttribute('aria-pressed', 'true');
      await expect(page).toHaveURL(/children=graph/);
    });

    expect(
      during,
      'A Children switch must not re-run the item page — both bodies are already in the browser, ' +
        'and this is the twenty-nine-await round trip the story removed.',
    ).toEqual([]);

    const scrollAfter = await page.evaluate(() => document.querySelector('main')?.scrollTop ?? 0);
    expect(scrollAfter, 'the switch must not move the reader').toBe(scrollBefore);
    await beat();

    // Back restores the previous view — one history entry per switch. MOTIR-1549
    // exists because a toggle once used `replace` and broke exactly this.
    await page.goBack();
    await expect(list).toHaveAttribute('aria-pressed', 'true');
    await expect(page).not.toHaveURL(/children=graph/);
    await beat();
  });

  // ── 4 — leaving and returning through the rail ────────────────────────────
  await chapter('Leaving and returning through the rail', async () => {
    // ⚠️ THIS CHAPTER USED TO ASSERT A PENDING FRAME on a second route, drawn
    // by an `app/(authed)/loading.tsx` covering all 58 authed pages. That
    // boundary was removed before this receipt was ever recorded, because it
    // cost more than it bought: a `loading.tsx` fallback can render as soon as
    // its ancestor layouts resolve — before the page function runs — so the
    // response head is flushed and the status is fixed at 200. Every route
    // beneath it that calls `notFound()` then renders its not-found BODY under
    // a 200, and eleven of those fifty-eight do, including three isolation
    // contracts. Hoisting the gate into a `layout.tsx` was built and measured
    // and does NOT recover the status.
    //
    // So the chapter keeps the navigation and drops the frame claim. What the
    // story delivers on this route is unchanged and is asserted below: the
    // switch chapters pay no server round trip at all.
    await page.getByRole('link', { name: 'Backlog' }).click();
    await expect(page.getByRole('heading', { name: 'Backlog' })).toBeVisible();
    await beat();
  });

  // ── 5 — the plan detail's Canvas ↔ List, the switch that was reported ─────
  await chapter('The plan’s Canvas and List switch under the cursor', async () => {
    const plans = await seedPlanShapes(PLAN_EMAIL);
    await signIn(page, PLAN_EMAIL, PLANS_SHAPES_PASSWORD);
    await page.goto(`/plans/${plans.one.planId}`);

    const list = page.getByRole('button', { name: 'List' });
    const canvas = page.getByRole('button', { name: 'Canvas' });
    await expect(list.or(canvas).first()).toBeVisible();
    await beat();

    const during = await serverRequestsDuring(page, async () => {
      await canvas.click();
      await expect(canvas).toHaveAttribute('aria-pressed', 'true');
      await expect(page).toHaveURL(/view=canvas/);
    });
    expect(
      during,
      'The plan switch must not pay /plans/[id]/page.tsx’s seven awaits to render a body the ' +
        'island already holds — this is the exact complaint the story was reported for.',
    ).toEqual([]);
    await beat();

    const back = await serverRequestsDuring(page, async () => {
      await list.click();
      await expect(list).toHaveAttribute('aria-pressed', 'true');
    });
    expect(back).toEqual([]);
    await beat();

    // Back steps through both switches, in order.
    await page.goBack();
    await expect(canvas).toHaveAttribute('aria-pressed', 'true');
    await beat();
  });
});
