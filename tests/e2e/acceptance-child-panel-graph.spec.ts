import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedChildPanelGraph, type ChildPanelGraphSeed } from './_helpers/child-panel-graph-seed';

// Story MOTIR-2284 — the Children panel's List ↔ Graph switcher (MOTIR-2290).
//
// The story's `verification_recipe`, driven in a browser, and the story's
// ACCEPTANCE RECEIPT: the happy path is recorded and published, because what
// this story ships is a surface a person watches rather than an API they read.
//
// Nothing is stubbed. The tree, its `is_blocked_by` edges, the per-level roadmap
// read the canvas hits and the panel's URL state are all real — which matters
// here more than usual, because almost everything this story does is behaviour
// that several pieces have to agree on at runtime. The load-bearing assertion is
// step 5: Back at the panel's first level must return to the ITEM's children and
// never to the project's roots. That one is invisible in code review, obvious the
// moment a user hits it, and is the reason the canvas is rooted (MOTIR-2287)
// rather than merely seeded at a level.
//
// DETERMINISM (`motir-core/CLAUDE.md` § E2E): every wait is a rendered node set,
// a settled URL, or a role/text landmark. The only holds are `chapter()`'s own
// pacing, which runs AFTER each phase's assertions have already proven the state.

test.describe.configure({ timeout: 240_000 });

let seed: ChildPanelGraphSeed;

test.beforeAll(async () => {
  await resetDatabase();
  seed = await seedChildPanelGraph('child-panel-graph@example.com');
});

/** A canvas node card, addressed by the identifier it renders. */
const node = (page: import('@playwright/test').Page, key: string) =>
  page.locator('[data-node-id]').filter({ hasText: key });

const childrenSection = (page: import('@playwright/test').Page) =>
  page.locator('section, div').filter({ hasText: 'Child work items' }).first();

test('the Children panel reads as a graph, rooted at the item', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-2284');

  await signIn(page, seed.email, seed.password);

  await chapter('The Children panel, as it ships today', async () => {
    await page.goto(`/items/${seed.storyKey}`);
    // List is the default, on a clean URL, showing the rows — unchanged.
    await expect(page.getByText('Child work items')).toBeVisible();
    await expect(page.getByRole('button', { name: 'List' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('link', { name: new RegExp(seed.designKey) })).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(seed.codeKey) })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('children')).toBeNull();
    await beat();
  });

  await chapter('Switch to Graph: the children, and the order they build in', async () => {
    await page.getByRole('button', { name: 'Graph' }).click();
    // The canvas's own authoritative signal: the level has rendered its nodes.
    await expect(node(page, seed.designKey)).toBeVisible();
    await expect(node(page, seed.codeKey)).toBeVisible();
    await expect(node(page, seed.testKey)).toBeVisible();
    // THE EDGES — the whole reason the mode exists. The seed wires
    // design → code → test, so the canvas draws two dependency connectors.
    await expect(page.locator('[data-testid="canvas-edges"] path')).toHaveCount(2);
    // …and the level is the ITEM's children, not the project's roots: an epic
    // that lives outside this story's subtree is drawn on the root level only.
    await expect(page.getByText(seed.otherEpicTitle)).toHaveCount(0);
    await beat();
  });

  await chapter('Drill a child — inside the panel, not away from the page', async () => {
    await node(page, seed.codeKey).click();
    await page.getByTestId('drill-button').click();
    await expect(node(page, seed.grandchildKey)).toBeVisible();
    // The breadcrumb's root crumb is the ITEM, so Back is self-describing.
    await expect(page.getByLabel('Breadcrumb')).toContainText(seed.storyKey);
    // Still on the item's own page — the panel never navigated.
    expect(new URL(page.url()).pathname).toBe(`/items/${seed.storyKey}`);
    await beat();
  });

  await chapter('Back lands on the item’s children — never on the project', async () => {
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(node(page, seed.designKey)).toBeVisible();
    await expect(node(page, seed.testKey)).toBeVisible();
    // THE FENCE. Stepping back out of a drilled child returns to this item's
    // children; a canvas merely SEEDED at a level would have landed here on the
    // project's root epics instead.
    await expect(page.getByText(seed.otherEpicTitle)).toHaveCount(0);
    await expect(node(page, seed.grandchildKey)).toHaveCount(0);
    await beat();
  });

  await chapter('Peek a child from the canvas', async () => {
    await node(page, seed.designKey).click();
    await page.getByTestId('view-button').click();
    const peek = page.getByRole('dialog');
    await expect(peek).toBeVisible();
    await expect(peek).toContainText(seed.designTitle);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await beat();
  });

  await chapter('The view is in the address bar', async () => {
    // A link to the graph is a link someone else opens ON the graph.
    await expect(page).toHaveURL(/\?children=graph$/);
    await page.reload();
    await expect(node(page, seed.designKey)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Graph' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await beat();
    // …and the browser's Back button undoes the switch, like it undoes anything.
    await page.goBack();
    await expect(page.getByRole('button', { name: 'List' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page).toHaveURL(new RegExp(`/items/${seed.storyKey}$`));
    await beat();
  });

  await chapter('Back to List: the rows, unchanged', async () => {
    await expect(page.getByRole('link', { name: new RegExp(seed.designKey) })).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(seed.testKey) })).toBeVisible();
    await expect(page.getByTestId('child-panel-graph')).toHaveCount(0);
    await beat();
  });
});

test('a leaf shows no Children section at all — no switcher, no empty panel', async ({ page }) => {
  await signIn(page, seed.email, seed.password);
  await page.goto(`/items/${seed.leafKey}`);
  // The page itself has rendered (so the absence below is a real absence, not a
  // race against first paint).
  await expect(page.getByRole('heading', { name: 'A task with no children' })).toBeVisible();
  await expect(page.getByText('Child work items')).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Children view' })).toHaveCount(0);
  await expect(page.getByTestId('child-panel-graph')).toHaveCount(0);
});

test('a deep link opens directly on the graph', async ({ page }) => {
  await signIn(page, seed.email, seed.password);
  await page.goto(`/items/${seed.storyKey}?children=graph`);
  await expect(node(page, seed.designKey)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Graph' })).toHaveAttribute('aria-pressed', 'true');
  await expect(childrenSection(page)).toBeVisible();
});
