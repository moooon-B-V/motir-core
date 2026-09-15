import { expect, test } from '@playwright/test';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanShapes, PLANS_SHAPES_PASSWORD } from './_helpers/plans-shapes-seed';

// MOTIR-5547 AC 7 — the PLAN HISTORY section is on `/items/<key>` for a card a
// plan names, so later CI runs open the surface. A SMOKE, not the story's walk:
// the oldest-first order, Show more and the acceptance clip are MOTIR-5549's.
//
// It reuses `seedPlanShapes` rather than seeding its own plans. Shape two is a
// `planned` plan that MODIFIES a committed story and ADDS two stories under its
// epic — so one seed gives both relation arms the section reads (a `modify` on
// the story, children on the epic) and an untouched sibling for the negative.
//
// Every assertion is `getByRole` on the section's own landmark: the list is
// labelled "Plans that shaped <key>", which is immune to the hidden-subtree
// duplicate a navigation can leave in the DOM.

test.describe.configure({ timeout: 300_000 });

test.beforeAll(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

test('a card a plan names shows its plan history, and an untouched card shows none', async ({
  page,
}) => {
  const seed = await seedPlanShapes('item-plan-history@example.com');
  await signIn(page, seed.email, PLANS_SHAPES_PASSWORD);

  // The MODIFIED story: one row, in the proposal tense, linking to its plan.
  const story = seed.two.modified;
  await page.goto(`/items/${story.identifier}`);
  const storyPlans = page.getByRole('list', { name: `Plans that shaped ${story.identifier}` });
  await expect(storyPlans).toBeVisible();
  const storyRow = storyPlans.getByRole('link');
  await expect(storyRow).toHaveCount(1);
  await expect(storyRow).toHaveAttribute('href', `/plans/${seed.two.planId}`);
  await expect(storyRow).toContainText('Proposes changes to this item');

  // The EPIC the same plan adds two stories under: the children arm.
  const epic = seed.two.epic;
  await page.goto(`/items/${epic.identifier}`);
  const epicPlans = page.getByRole('list', { name: `Plans that shaped ${epic.identifier}` });
  await expect(epicPlans).toBeVisible();
  await expect(
    epicPlans.getByRole('link', { name: /Proposes 2 work items under this item/ }),
  ).toHaveAttribute('href', `/plans/${seed.two.planId}`);

  // An untouched sibling: no section. Wait on the page's own heading first, so
  // the absence is asserted against a rendered page rather than a blank one.
  const untouched = seed.two.untouched[0]!;
  await page.goto(`/items/${untouched.identifier}`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(
    page.getByRole('list', { name: `Plans that shaped ${untouched.identifier}` }),
  ).toHaveCount(0);
});
