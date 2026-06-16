// E2E: Story 6.13 — the PROJECT SQUARE discovery loop (Subtask 6.13.8). The full
// public-discovery journey in a real browser, **logged out**, proving the
// discovery → public-view handoff end to end without a session:
//
//   1. an ANONYMOUS visitor (no session) opens `/explore` directly (there is NO
//      app left-nav entry) — the cross-org card gallery renders for the public
//      projects across MORE THAN ONE org, a seeded NON-public project is absent,
//      and the SEO surface (a single <h1> + a JSON-LD application/ld+json script)
//      is present;
//   2. the Trending sort reflects recent demand (the project given the fresh
//      upvote burst is at the top) and switching to Popular INVERTS toward the
//      higher-lifetime project — the rank rides a real, crawlable URL param;
//   3. a search query narrows the gallery to the matching public project, then a
//      topic chip narrows it to that category — both COMPOSE with the active
//      rank, and the rank + search + tag are all in the URL (a reload restores
//      the whole state);
//   4. clicking a card lands on that project's 6.12.4 public read-only view —
//      the public projection still holds through the discovery entry (internal
//      fields — assignees / estimates / internal comments — are absent, and no
//      authed edit affordance is reachable).
//
// The integration suite (tests/projectSquare/*) pins the ranking math + the
// search/tag predicates + the public-only filter at the service/repository
// layer; this file owns the thing only a browser proves — the anonymous render,
// the URL-driven rank/search/tag navigation, and the card → public-view
// handoff.
//
// Setup mirrors public-project-flow.spec.ts (the 6.12.10 sibling): the public
// projects, their tags, votes, and made-public state are created SERVER-SIDE
// through the shipped services + the repository edge (the one sanctioned
// cross-layer reach for tests); EVERY navigation, sort, search, filter, and
// card click goes through the BROWSER — the surface under test. No sign-in.
//
// NB on the card's flagged knock-on: the card warned the 6.12.4 view might still
// be account-required (assert a sign-in redirect "until the 6.12-side anonymous
// revision lands"). That revision HAS landed — public-project-flow.spec.ts drives
// an anonymous visitor to `/p/<key>` and gets the public surface with no session
// — so this test asserts the real public view, not a redirect.

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { createTestWorkspace } from '../fixtures/workspaceFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { projectsService } from '@/lib/services/projectsService';
import { projectTagsService } from '@/lib/services/projectTagsService';
import { workItemsService } from '@/lib/services/workItemsService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

const DAY_MS = 24 * 60 * 60 * 1000;
const days = (n: number) => new Date(Date.now() - n * DAY_MS);

interface SeededProject {
  projectId: string;
  identifier: string;
  ctx: ServiceContext;
}

/** Create a project in its OWN fresh org/workspace (each `createTestWorkspace`
 *  mints a new organization), so the seeded set spans MORE THAN ONE org. The
 *  project is created at its default `open` access; the caller flips it public. */
async function seedProject(opts: {
  orgName: string;
  projectName: string;
  identifier: string;
}): Promise<SeededProject> {
  const { workspace, owner } = await createTestWorkspace({ name: opts.orgName });
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    name: opts.projectName,
    identifier: opts.identifier,
  });
  return {
    projectId: project.id,
    identifier: project.identifier,
    ctx: { userId: owner.id, workspaceId: workspace.id },
  };
}

/** Flip a project `public` directly, stamping the made-public time + the public
 *  overview snippet (the only public-safe description field, 6.12.3) so the card
 *  shows a description. */
async function makePublic(
  p: SeededProject,
  opts: { madePublicAt: Date; overview: string },
): Promise<void> {
  await db.project.update({
    where: { id: p.projectId },
    data: {
      accessLevel: 'public',
      madePublicAt: opts.madePublicAt,
      publicOverviewMd: opts.overview,
    },
  });
}

/** Assign a single curated topic tag through the shipped service (admin-gated;
 *  the project's owner is its workspace owner, so the manage check passes). */
async function tag(p: SeededProject, slug: string): Promise<void> {
  await projectTagsService.setProjectTags(p.identifier, [slug], p.ctx);
}

/** Create a public-request work item in the project and add `count` upvotes, each
 *  from a distinct fresh voter, stamped at `at` (the trending window keys off the
 *  vote timestamp). The request item also gives the project real, non-triaged
 *  recent activity so its board / list render content. */
async function addRequestWithVotes(p: SeededProject, count: number, at: Date): Promise<void> {
  const request = await workItemsService.createWorkItem(
    { projectId: p.projectId, kind: 'task', title: 'A public feature request', parentId: null },
    p.ctx,
  );
  for (let i = 0; i < count; i++) {
    const voter = await createTestUser();
    await db.publicRequestVote.create({
      data: { workItemId: request.id, userId: voter.id, createdAt: at },
    });
  }
}

/** The ordered card links in the gallery — each `<a aria-label="<name> — public
 *  project">`. Used to assert rank ORDER + result-set narrowing. */
function cards(page: Page) {
  return page.getByRole('link', { name: /— public project$/ });
}

test('@smoke the project square: a logged-out visitor browses the cross-org gallery, sorts by trending, searches + filters by topic (all in the URL), and clicks through to a public read-only view', async ({
  page,
  browser,
}) => {
  // ── seed: three PUBLIC projects across THREE orgs + one NON-public project ──
  // TRND — a FRESH upvote burst (5 votes today) → tops Trending this week.
  const trnd = await seedProject({
    orgName: 'Northwind Labs',
    projectName: 'Trendy Tracker',
    identifier: 'TRND',
  });
  await makePublic(trnd, { madePublicAt: days(2), overview: 'A fast product analytics tracker.' });
  await tag(trnd, 'productivity');
  await addRequestWithVotes(trnd, 5, days(0));

  // LEDG — higher LIFETIME demand (6 votes) but all STALE (60 days ago), so it
  // tops Popular yet sinks on Trending-this-week.
  const ledg = await seedProject({
    orgName: 'Globex Systems',
    projectName: 'Steady Ledger',
    identifier: 'LEDG',
  });
  await makePublic(ledg, { madePublicAt: days(30), overview: 'An open finance ledger.' });
  await tag(ledg, 'finance');
  await addRequestWithVotes(ledg, 6, days(60));

  // DESN — a small middle project (1 fresh vote).
  const desn = await seedProject({
    orgName: 'Initech Studio',
    projectName: 'Design Studio',
    identifier: 'DESN',
  });
  await makePublic(desn, { madePublicAt: days(1), overview: 'A shared design system studio.' });
  await tag(desn, 'design');
  await addRequestWithVotes(desn, 1, days(0));

  // PRIV — a NON-public project (left at the default `open`) → must be ABSENT.
  const priv = await seedProject({
    orgName: 'Hooli Internal',
    projectName: 'Internal Skunkworks',
    identifier: 'PRIV',
  });
  await addRequestWithVotes(priv, 9, days(0)); // votes can't surface a non-public project

  // ── 1. anonymous visitor opens /explore directly (NO session) ───────────────
  const res = await page.goto('/explore');
  expect(res?.status(), '/explore is 200 for a logged-out visitor').toBe(200);

  // SEO surface: exactly one <h1> + a JSON-LD application/ld+json script that
  // names a seeded public project (the ItemList of SoftwareApplication).
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Explore public project');
  const ld = await page.locator('script[type="application/ld+json"]').first().textContent();
  expect(ld, 'JSON-LD present').toContain('SoftwareApplication');
  expect(ld, 'JSON-LD lists a seeded public project').toContain('Trendy Tracker');

  // The cross-org gallery: all THREE public projects render, naming their orgs.
  await expect(page.getByRole('link', { name: 'Trendy Tracker — public project' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Steady Ledger — public project' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Design Studio — public project' })).toBeVisible();
  await expect(page.getByText('Northwind Labs')).toBeVisible();
  await expect(page.getByText('Globex Systems')).toBeVisible();
  // A card shows the public demand stat (upvotes) — the public-projection signal.
  await expect(page.getByLabel('5 upvotes')).toBeVisible();

  // The NON-public project is absent (the public-only directory filter), and no
  // card carries a "Public" pill (every project here is public by definition).
  await expect(page.getByText('Internal Skunkworks')).toHaveCount(0);

  // ── 2. Trending order reflects recent demand; Popular inverts toward lifetime ─
  // Default landing rank is Trending (week) → the fresh burst (TRND) is on top.
  await expect(cards(page).first()).toHaveAttribute(
    'aria-label',
    'Trendy Tracker — public project',
  );

  // Switch to Popular (a real crawlable URL param) → lifetime demand wins, so the
  // stale-but-higher LEDG floats to the top — the order INVERTS vs Trending.
  await page
    .getByRole('group', { name: 'Sort public projects' })
    .getByRole('link', { name: 'Popular' })
    .click();
  await page.waitForURL(/[?&]rank=popular\b/);
  await expect(cards(page).first()).toHaveAttribute('aria-label', 'Steady Ledger — public project');

  // ── 3. search narrows; a topic chip narrows further; rank+search+tag in URL ──
  // Search "Trendy" (composes with the active Popular rank via the form's hidden
  // rank field) → only the matching project remains.
  const search = page.getByRole('textbox', { name: 'Search public projects' });
  await search.fill('Trendy');
  await search.press('Enter');
  await page.waitForURL(/[?&]q=Trendy\b/);
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toHaveAttribute(
    'aria-label',
    'Trendy Tracker — public project',
  );
  // The rank survived the search (composed, not reset).
  await expect(page).toHaveURL(/[?&]rank=popular\b/);

  // Pick the Productivity topic chip (scoped to the filter group so it can't
  // collide with the browse-by-topic nav at the page foot) → narrows to that
  // topic, composing with the search + rank.
  await page
    .getByRole('group', { name: 'Filter public projects by topic' })
    .getByRole('link', { name: 'Productivity' })
    .click();
  await page.waitForURL(/[?&]category=productivity\b/);
  // All three params now ride the URL together.
  await expect(page).toHaveURL(/[?&]q=Trendy\b/);
  await expect(page).toHaveURL(/[?&]rank=popular\b/);
  await expect(page).toHaveURL(/[?&]category=productivity\b/);
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toHaveAttribute(
    'aria-label',
    'Trendy Tracker — public project',
  );

  // A reload restores the WHOLE state from the URL (server-rendered, no client
  // state): the same single result, the search input pre-filled, the topic chip
  // pressed.
  await page.reload();
  await expect(cards(page)).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: 'Search public projects' })).toHaveValue('Trendy');
  await expect(
    page
      .getByRole('group', { name: 'Filter public projects by topic' })
      .getByRole('link', { name: 'Productivity' }),
  ).toHaveAttribute('aria-pressed', 'true');

  // ── 4. click the card → the 6.12.4 public read-only view (projection holds) ──
  // The card IS the single `<a href="/p/<key>">` into the public view; the click
  // is the discovery → view handoff under test.
  const trndCard = cards(page).first();
  await expect(trndCard).toHaveAttribute('href', '/p/TRND');
  await trndCard.click();
  await page.waitForURL(/\/p\/TRND$/);
  // Read the destination deterministically: a hard load awaits the route's 200
  // (and, on a cold dev server, its first on-demand compile) — never racing the
  // soft-nav first-compile, the authoritative-signal rule (CLAUDE.md).
  const overviewRes = await page.reload();
  expect(overviewRes?.status(), 'the public view is 200 (not a sign-in redirect)').toBe(200);
  // The public overview: a single <h1> (the project name) + the public banner —
  // the read-only marketing surface, not the authed app shell.
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Trendy Tracker');
  await expect(page.getByText(/viewing a public project/)).toBeVisible();

  // The projection still holds through the discovery entry: the public Board
  // renders the note proving internal fields (assignees / estimates / internal
  // comments) are ABSENT — not fetched, not just hidden — and there is no authed
  // edit affordance (no "New work item" / "Create" control on the public view).
  // A hard nav (awaits the 200 + compile) keeps the cross-route hop deterministic.
  const boardRes = await page.goto('/p/TRND/board');
  expect(boardRes?.status(), 'the public board is 200').toBe(200);
  await expect(page.getByText(/hidden by the public projection/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /New work item|Create/ })).toHaveCount(0);

  // A defensive cross-check from a genuinely fresh, session-less context: the
  // explore page is reachable with NO cookies at all.
  const anonCtx = await browser.newContext();
  const anon = await anonCtx.newPage();
  const anonRes = await anon.goto('/explore');
  expect(anonRes?.status(), '/explore is 200 from a cookieless context').toBe(200);
  await expect(anon.getByRole('link', { name: 'Trendy Tracker — public project' })).toBeVisible();
  await anonCtx.close();
});
