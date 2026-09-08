import { expect, test } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn, POST_AUTH_LANDING } from './_helpers/shell-session';
import { signUp as apiSignUp, createProject, TEST_PASSWORD } from './_helpers/work-item-setup';
import { workItemsService } from '@/lib/services/workItemsService';
import { watchersService } from '@/lib/services/watchersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { db as prisma } from '@/lib/db';

// E2E: the Workbench journey (Story MOTIR-2649 · MOTIR-2656, renamed and
// widened by Story MOTIR-4777 · MOTIR-4782) — the ASSEMBLED surface over the
// real stack. The correctness matrices (the access matrix, the dedupe across a
// page boundary) live at the vitest tier in `tests/integration/workbench/`; this
// drives what a PERSON does, and its first assertion is the one everything else
// depends on: signing in lands you here without navigating.
//
// ⚠️ IT IS ALSO THE STORY'S SMOKE, which is why it lands with the first card
// that renders the surface rather than with the E2E card. A whole class of
// Next.js server/client-boundary defect is invisible to type checking, to a
// production build and to component tests, because the boundary is only crossed
// at render — and one story in this project shipped a permanently-500ing page
// through five green pull requests before its own Playwright walk opened it.
// Six more cards merge on top of this page; from here their CI opens it.
//
// @smoke — it exercises the seam no unit can: the Server Component's
// active-project read → the tab strip's URL selection → the shipped row cells
// → the `?peek=` island, plus the two shell affordances this story moved out
// from under (the rail entry and the bell).
//
// ⚠️ The SCOPE assertions inverted with MOTIR-2761: `/workbench` reads the ACTIVE
// PROJECT, not the workspace. The two-project fixture is unchanged — it was
// always the right fixture; what changed is which answer it proves.
//
// Seed-then-signIn, the shape `ready.spec.ts` uses: the fixture is built through
// the OWNER's API session and the services before the browser signs in.
//
// ⚠️ NOTHING here waits an interval (CLAUDE.md § E2E authoritative signal). The
// paging step arms `waitForResponse` on the document fetch BEFORE clicking, and
// the tab-persistence step asserts after a real reload rather than trusting the
// rendered state.

test.describe.configure({ timeout: 90_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test.afterAll(async () => {
  await db.$disconnect();
});

const OWNER = 'home-owner@example.com';
/** A second actor with a workspace and NO project — the no-active-project case. */
const FRESH = 'home-fresh@example.com';

interface Seeded {
  workspaceId: string;
  ownerId: string;
  colleagueId: string;
  projectA: { id: string; identifier: string };
  projectB: { id: string; identifier: string };
  assigned: string;
  reported: string;
  both: string;
  agent: string;
  watched: string;
  /** In project B, and the reader's on EVERY axis — assignee, reporter, watcher. */
  otherProject: string;
}

/**
 * One workspace, TWO projects, and a reader holding every relation the page has
 * to distinguish: assigned-only, reported-only, BOTH, agent-executed, and one
 * watched-but-not-owned — all in project A, which is left ACTIVE.
 *
 * ⚠️ THE TWO-PROJECT SHAPE IS THE POINT, and it survived MOTIR-2761's inversion
 * unchanged in kind: project B holds ONE item the reader owns on every axis at
 * once — assignee, reporter AND watcher — so nothing but the project scope can
 * be keeping it out of either tab. A fixture whose second project held a row the
 * reader had no relation to would prove nothing about scope at all.
 */
async function seed(): Promise<Seeded> {
  const owner = await apiSignUp(OWNER);
  const colleague = await usersService.createUser({
    email: 'home-colleague@example.com',
    password: TEST_PASSWORD,
    name: 'Mei Lin',
  });
  await workspacesService.addMember({
    userId: colleague.id,
    workspaceId: owner.workspaceId,
    role: 'member',
  });

  const projectA = await createProject(owner, 'Motir', 'HOMA');
  const projectB = await createProject(owner, 'Atlas', 'HOMB');
  const ctx = { userId: owner.userId, workspaceId: owner.workspaceId };

  const make = async (projectId: string, title: string) =>
    workItemsService.createWorkItem({ projectId, kind: 'task', title }, ctx);

  // Project A: assigned-only, BOTH, and the agent-executed one.
  const assigned = await make(projectA.id, 'Assigned to me only');
  const both = await make(projectA.id, 'Assigned AND reported by me');
  const agent = await make(projectA.id, 'An agent is on this one');
  // Project A too: reported-only, and one the reader merely watches.
  const reported = await make(projectA.id, 'I filed it, someone else owns it');
  const watched = await make(projectA.id, 'Watched but not mine');
  // Project B — the INACTIVE project's single row, the reader's on every axis.
  const otherProject = await make(projectB.id, 'Mine, in the project I am not in');

  // The service writes the creator as REPORTER; point the rest by hand so each
  // row carries exactly one of the relations the page has to tell apart.
  await prisma.workItem.update({
    where: { id: assigned.id },
    data: { assigneeId: owner.userId, reporterId: colleague.id },
  });
  await prisma.workItem.update({
    where: { id: both.id },
    data: { assigneeId: owner.userId, reporterId: owner.userId },
  });
  await prisma.workItem.update({
    where: { id: agent.id },
    data: { assigneeId: owner.userId, executor: 'coding_agent', type: 'code' },
  });
  await prisma.workItem.update({
    where: { id: reported.id },
    data: { assigneeId: colleague.id, reporterId: owner.userId },
  });
  await prisma.workItem.update({
    where: { id: watched.id },
    data: { assigneeId: colleague.id, reporterId: colleague.id },
  });
  await prisma.workItem.update({
    where: { id: otherProject.id },
    data: { assigneeId: owner.userId, reporterId: owner.userId },
  });
  // ⚠️ CREATING AN ITEM AUTO-WATCHES YOU (`watchersService.autoWatch`, the
  // constant-on create-or-comment rule). The owner created all five, so without
  // this the Watching tab would legitimately hold every one of them and the two
  // tabs would be indistinguishable — which is a fact about the product, not a
  // bug, and exactly the sort of thing only a real-stack run surfaces. Unwatch
  // the four the reader should NOT be following so the fixture says what it
  // means: one item watched, and it is one they do not own.
  for (const item of [assigned, both, agent, reported]) {
    await watchersService.unwatch(item.id, ctx);
  }
  await watchersService.watch(watched.id, ctx);
  // `otherProject` keeps its auto-watch: the point is that a row the reader is
  // on in EVERY sense is still absent, so the Watching tab must exclude it too.

  // ⚠️ PIN THE ACTIVE PROJECT (MOTIR-2761). `/workbench` reads it now, so leaving it
  // to whatever `createProject` last set would make every assertion below depend
  // on an implementation detail of the fixture rather than on the surface.
  await projectsService.setActiveProject({
    userId: owner.userId,
    workspaceId: owner.workspaceId,
    projectId: projectA.id,
  });

  return {
    workspaceId: owner.workspaceId,
    ownerId: owner.userId,
    colleagueId: colleague.id,
    projectA,
    projectB,
    assigned: assigned.identifier,
    reported: reported.identifier,
    both: both.identifier,
    agent: agent.identifier,
    watched: watched.identifier,
    otherProject: otherProject.identifier,
  };
}

const row = (identifier: string) => `[data-testid="workbench-row-${identifier}"]`;

test.describe('the Workbench journey', () => {
  test('sign in lands on the Workbench; To do merges assigned and reported, deduped; Watching is its own audience', async ({
    page,
  }) => {
    const fx = await seed();

    // 1. SIGN IN — and LAND, without navigating. Half of what this spec is for:
    // if the landing breaks, nothing else about the story matters. The helper
    // settles on a rendered `/workbench` (MOTIR-2654 moved its target here).
    await signIn(page, OWNER, TEST_PASSWORD);
    await expect(page).toHaveURL(/\/workbench$/);
    await expect(page.getByTestId('workbench-page')).toBeVisible();

    // 1b. THE FIVE-TAB STRIP, as one landmark — the composition every later
    // card in this story merges on top of.
    await expect(page.getByTestId('workbench-tab-todo')).toHaveAttribute('aria-current', 'page');
    for (const tab of ['in-progress', 'finished', 'watching', 'approvals']) {
      await expect(page.getByTestId(`workbench-tab-${tab}`)).toBeVisible();
    }

    // 2. TO DO — all three relations present, from the ACTIVE project. Every
    // seeded row sits at the workflow's INITIAL status, so the default tab is
    // where they land.
    await expect(page.locator(row(fx.assigned))).toBeVisible();
    await expect(page.locator(row(fx.reported))).toBeVisible();
    await expect(page.locator(row(fx.both))).toBeVisible();
    // The watched-but-not-owned item is NOT here — it is the other tab's.
    await expect(page.locator(row(fx.watched))).toHaveCount(0);
    // Nor is the OTHER PROJECT's row, which the reader assigned, reported AND
    // watches — the project scope is the only thing that can exclude it
    // (MOTIR-2761).
    await expect(page.locator(row(fx.otherProject))).toHaveCount(0);

    await expect(page.locator(row(fx.assigned))).toContainText('Assigned');
    await expect(page.locator(row(fx.reported))).toContainText('Reported');
    // …and NO project cell: the header strip carries four columns now, and a
    // chip repeating the switcher above it would be the surface still claiming
    // to span projects.
    await expect(page.getByRole('columnheader', { name: 'Project' })).toHaveCount(0);
    await expect(page.locator(row(fx.assigned))).not.toContainText('Motir');
    // The subtitle names the PROJECT, which is what the page is now about — and
    // it is the REVISED line: the shipped "Everything in {project} that is
    // waiting on you" was false of a surface that also shows what you finished,
    // and was the exact sentence MOTIR-2758 was filed against.
    await expect(page.getByTestId('workbench-page')).toContainText('What you are doing in Motir');

    // ⚠️ A COUNT, not a visibility assertion. "Is it visible" passes perfectly
    // on a page showing the same item twice, which is exactly the bug the
    // merged assigned-OR-reported read can have.
    await expect(page.locator(row(fx.both))).toHaveCount(1);
    await expect(page.locator(row(fx.both))).toContainText('Both');

    // 3. THE AGENT ROW — in the same list, wearing its badge. It is a row
    // state; if an implementation ever sections agent work off, the row is no
    // longer inside the list this locator scopes to.
    const agentRow = page.locator(row(fx.agent));
    await expect(agentRow).toBeVisible();
    await expect(agentRow.getByText('An agent is executing this item')).toBeAttached();

    // 4. OPEN A ROW — the SAME `?peek=` quick view /items, /ready and the board
    // use. A plain click intercepts; the modal is the shipped one.
    await page.locator(row(fx.assigned)).getByRole('link').first().click();
    await expect(page).toHaveURL(new RegExp(`peek=${fx.assigned}`));
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // 4b. THE EMPTY TABS — Recently finished (nothing in the fixture has
    // finished) and To approve (which ships no rows at all until MOTIR-4778).
    // Only two of the five empty states carry an action, and neither of these
    // is one of them. Walked here rather than left to a component test because
    // the empty branch renders through its OWN async server component, and a
    // server/client-boundary defect there is invisible to types, to the
    // production build and to happy-dom — it only shows when the page is opened.
    await page.getByTestId('workbench-tab-finished').click();
    await expect(page).toHaveURL(/\?tab=finished$/);
    await expect(page.getByText('Nothing finished this week')).toBeVisible();
    await expect(page.getByText('Finished in the last 7 days.')).toBeVisible();

    await page.getByTestId('workbench-tab-approvals').click();
    await expect(page).toHaveURL(/\?tab=approvals$/);
    await expect(page.getByText('Nothing is waiting on your approval')).toBeVisible();

    // 5. WATCHING — a different audience, and the tab lives in the URL.
    await page.getByTestId('workbench-tab-watching').click();
    await expect(page).toHaveURL(/\?tab=watching$/);
    await expect(page.locator(row(fx.watched))).toBeVisible();
    await expect(page.locator(row(fx.watched))).toContainText('Watching');
    // An item the reader OWNS but does not follow is not here — the two tabs
    // are different audiences, not one list split in two.
    await expect(page.locator(row(fx.assigned))).toHaveCount(0);
    // And the other project's row is absent from THIS tab too, though the reader
    // watches it — both reads narrowed, not just My work.
    await expect(page.locator(row(fx.otherProject))).toHaveCount(0);

    // The selection SURVIVES A RELOAD, which is the property a tab held in
    // component state would not have.
    await page.reload();
    await expect(page.getByTestId('workbench-page')).toBeVisible();
    await expect(page.locator(row(fx.watched))).toBeVisible();
    await expect(page.getByTestId('workbench-tab-watching')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('the OLD address still lands — a permanent 308, with its query string intact', async ({
    page,
  }) => {
    await seed();
    await signIn(page, OWNER, TEST_PASSWORD);

    // A URL is a promise to strangers, and `/home` is the one every signed-in
    // reader has in muscle memory, in their history, and in whatever they pasted
    // into chat. Asserted at the RESPONSE, not just at the landed URL: a rewrite
    // would also land here, and a rewrite is the half-rename this story exists
    // to avoid — two addresses for one surface, and nothing saying which is real.
    const direct = await page.goto('/home');
    expect(direct?.status()).toBe(200);
    await expect(page).toHaveURL(/\/workbench$/);
    await expect(page.getByTestId('workbench-page')).toBeVisible();

    // …and the QUERY rides along, so a link to somebody's Watching tab survives
    // the move. Next carries it because the destination names no query of its
    // own — a property of the framework, which is why it is asserted rather
    // than assumed.
    await page.goto('/home?tab=watching');
    await expect(page).toHaveURL(/\/workbench\?tab=watching$/);
    await expect(page.getByTestId('workbench-tab-watching')).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('the rail entry and the bell both still work — the two shell affordances this story moved out from under', async ({
    page,
  }) => {
    await seed();
    await signIn(page, OWNER, TEST_PASSWORD);

    // The DOOR. A page nobody lands on is a page nobody has, and the rail row
    // is the half of that which does not depend on the sign-in default.
    const home = page.getByRole('link', { name: 'Workbench', exact: true });
    await expect(home).toHaveAttribute('aria-current', 'page');
    // /dashboard keeps its route AND its own row — nothing was re-homed.
    await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.getByRole('link', { name: 'Workbench', exact: true }).click();
    await expect(page.getByTestId('workbench-page')).toBeVisible();

    // THE BELL. This story deliberately does NOT mount notifications here —
    // "Needs you" was removed as a duplicate of this drawer. So the assertion
    // is not that two surfaces agree; it is that the ONE surface still works
    // after a story that repointed the landing and added a nav row, which is
    // exactly the class of edit that breaks a shell affordance nobody reopened.
    await page.getByRole('button', { name: /^Notifications,/ }).click();
    await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
  });

  test('the Workbench is PROJECT-scoped: switching the active project changes what it shows', async ({
    page,
  }) => {
    // ⚠️ THE INVERSION (MOTIR-2761). This test asserted the opposite until
    // 2026-08-17 — "switching the active project changes nothing" — which made
    // it a contract test for the defect: `/workbench` leads the PROJECT tier of the
    // rail, directly under the switcher, so a green assertion here certified
    // that a shipped control does nothing on the first screen after sign-in.
    // The fixture is unchanged; only the expectation is.
    const fx = await seed();
    await signIn(page, OWNER, TEST_PASSWORD);

    // Project A is active: its rows, and not project B's.
    await expect(page.locator(row(fx.assigned))).toBeVisible();
    await expect(page.locator(row(fx.otherProject))).toHaveCount(0);
    await expect(page.getByTestId('workbench-page')).toContainText('What you are doing in Motir');

    // Switch through the SERVICE — the thing every other list surface scopes
    // by, and now this one too — then reload the Workbench.
    await projectsService.setActiveProject({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectB.id,
    });
    await page.reload();
    await expect(page.getByTestId('workbench-page')).toBeVisible();

    // The lists SWAP. Asserting both directions is what keeps this from passing
    // on a page that merely went empty.
    await expect(page.locator(row(fx.otherProject))).toBeVisible();
    await expect(page.locator(row(fx.assigned))).toHaveCount(0);
    await expect(page.locator(row(fx.both))).toHaveCount(0);
    await expect(page.getByTestId('workbench-page')).toContainText('What you are doing in Atlas');
  });

  test('with NO active project, /workbench renders the create-first door and the rail offers no Workbench row', async ({
    page,
  }) => {
    // A brand-new actor: signed up, no project anywhere in the workspace. This
    // is the ONLY meaning of "no active project" — the resolver recovers to the
    // first visible project and persists the pointer, so `null` is "there is
    // nothing to pick", never "you have not picked yet"
    // (`docs/decisions/home-scope.md` §1).
    await apiSignUp(FRESH);
    await signIn(page, FRESH, TEST_PASSWORD);

    // It still LANDS here — the post-auth default is unchanged (§2.3).
    await expect(page).toHaveURL(/\/workbench$/);
    await expect(page.getByTestId('workbench-page')).toBeVisible();

    // The shipped create-first door, reused from `/dashboard` — not a new empty
    // state and not the actionless `/ready` notice, because this route is LANDED
    // on rather than navigated to (§2.2).
    await expect(page.getByRole('heading', { name: 'Create your first project' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create project' })).toBeVisible();

    // And NO Workbench row in the rail: the duplicate `!hasProject` entry is gone
    // (§2.1). The route stays reachable by URL — which is how we got here — but
    // the product no longer offers a door to a room it can open only sometimes.
    await expect(page.getByRole('link', { name: 'Workbench', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Boards', exact: true })).toHaveCount(0);
  });
});

// ── THE PAGER AND THE KIND ORDER (Story MOTIR-4850 · MOTIR-4855) ────────────
//
// The story's `verification_recipe`, automated. Everything above this line is
// MOTIR-4777's walk over the same surface; this is the paging half, seeded at
// the SIZE the assertions need rather than at the smallest size that renders:
// To do genuinely spans more than two pages, and Watching's `in_progress` group
// genuinely overflows one page on its own. A fixture that fits on one page
// would let every assertion below pass against a surface with no paging at all.
//
// ⚠️ NOTHING HERE WAITS AN INTERVAL. Every step waits on an authoritative
// signal — a rendered row, a URL, a `disabled` attribute — per CLAUDE.md § E2E.

/** The five kinds' lucide glyphs, in `READY_KIND_RANK` order. The icon is
 *  `aria-hidden` (the identifier carries the accessible name), so the ORDER is
 *  read off the rendered class rather than off the accessibility tree. */
const GLYPH_RANK: Record<string, number> = {
  'lucide-list-checks': 0, // subtask
  'lucide-bug': 1,
  'lucide-square-check-big': 2, // task
  'lucide-book-open': 3, // story
  'lucide-zap': 4, // epic
};

const PAGER_OWNER = 'pager-owner@example.com';
const PAGER_EMPTY = 'pager-empty@example.com';

/** The rendered rows' kind ranks, in DOM order. */
async function kindRanks(page: import('@playwright/test').Page): Promise<number[]> {
  const classes = await page
    .locator('[data-testid^="workbench-row-"]')
    .evaluateAll((rows) =>
      rows.map((row) => row.querySelector('svg[class*="lucide-"]')?.getAttribute('class') ?? ''),
    );
  return classes.map((cls) => {
    const hit = Object.keys(GLYPH_RANK).find((g) => cls.split(/\s+/).includes(g));
    return hit === undefined ? -1 : GLYPH_RANK[hit]!;
  });
}

async function seedPaging() {
  const owner = await apiSignUp(PAGER_OWNER);
  // ⚠️ THE EMPTY READER NEEDS A PROJECT OF THEIR OWN. Without one the page
  // renders the NO-PROJECT branch — a different screen, and a different card's
  // (MOTIR-4815 retires it) — so the empty-tab assertion would be passing on
  // the wrong state entirely.
  const emptyReader = await apiSignUp(PAGER_EMPTY);
  await createProject(emptyReader, 'Nothing here', 'PGE');
  const project = await createProject(owner, 'Motir', 'PGR');
  const ctx = { userId: owner.userId, workspaceId: owner.workspaceId };

  const kinds = ['epic', 'story', 'task', 'bug', 'subtask'] as const;
  // 55 rows over three pages at HOME_PAGE_SIZE = 25 — and seeded in the WRONG
  // order (epics first) so a read that had kept `updatedAt DESC` would return
  // this sequence reversed rather than sorted.
  const toDo: string[] = [];
  let story: string | undefined;
  for (const kind of kinds) {
    for (let i = 0; i < 11; i += 1) {
      // A subtask needs a parent (the kind-parent matrix); the stories seeded
      // one loop earlier are the legal home.
      const item = await workItemsService.createWorkItem(
        {
          projectId: project.id,
          kind,
          title: `${kind} ${i}`,
          ...(kind === 'subtask' ? { parentId: story! } : {}),
        },
        ctx,
      );
      if (kind === 'story' && story === undefined) story = item.id;
      toDo.push(item.id);
    }
  }
  // 30 watched rows in the MOVING band — more than one page on its own — and 6
  // waiting, so the boundary falls inside page 2.
  //
  // ⚠️ THE SIX WAITING ROWS ARE IN **To do** AS WELL, and that is the product
  // rather than the fixture: Watching is a different AUDIENCE, not a partition
  // of the work tabs, so a row the reader both owns and follows is returned by
  // both reads (MOTIR-2655 asserts the overlap on purpose). So To do holds
  // 55 + 6 = 61 and Watching holds 30 + 6 = 36.
  const moving: string[] = [];
  for (let i = 0; i < 30; i += 1) {
    const item = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: `Watched moving ${i}` },
      ctx,
    );
    moving.push(item.id);
  }
  await prisma.workItem.updateMany({
    where: { id: { in: moving } },
    data: { status: 'in_progress' },
  });
  const waiting: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const item = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: `Watched waiting ${i}` },
      ctx,
    );
    waiting.push(item.id);
  }
  // Everything the reader created is auto-watched; unwatch the To-do set so the
  // Watching tab holds exactly the 36 this fixture is about.
  for (const id of toDo) await watchersService.unwatch(id, ctx);
  await prisma.workItem.updateMany({
    where: { id: { in: [...toDo, ...moving, ...waiting] } },
    data: { assigneeId: owner.userId, reporterId: owner.userId },
  });
  return { owner, project };
}

test.describe('the pager and the kind order', () => {
  test('a reader walks their own work by page, in ready order, in both languages', async ({
    page,
  }) => {
    await seedPaging();
    await signIn(page, PAGER_OWNER, TEST_PASSWORD);

    // 1 ── the footer reads the range and the REAL total, and the run is there.
    const footer = page.getByRole('navigation', { name: 'Pagination' });
    await expect(page.getByText(/Showing 1–25 of 61/)).toBeVisible();
    await expect(footer).toBeVisible();
    await expect(page.getByRole('button', { name: 'Page 3' })).toBeVisible();

    // 6a ── the order, WITHIN page one, before the boundary is crossed.
    const pageOne = await kindRanks(page);
    expect(pageOne).toHaveLength(25);
    expect(pageOne, 'page 1 is not in kind order').toEqual([...pageOne].sort((a, b) => a - b));

    // 2 ── click page 3. The authoritative signal is the RENDERED range line,
    //      which only the server can produce for the third window.
    await page.getByRole('button', { name: 'Page 3' }).click();
    await expect(page.getByText(/Showing 51–61 of 61/)).toBeVisible();
    await expect(page).toHaveURL(/\?page=3$/);
    const pageThree = await kindRanks(page);
    expect(pageThree).toHaveLength(11);

    // 6b ── THE ORDER ACROSS A BOUNDARY, which a per-page assertion cannot see:
    //      the last rank on page 1 is ≤ the first rank on page 3, and the
    //      concatenation is non-decreasing.
    expect(Math.max(...pageOne)).toBeLessThanOrEqual(Math.min(...pageThree));
    const concatenated = [...pageOne, ...pageThree];
    expect(concatenated, 'the pages are individually sorted and jointly not').toEqual(
      [...concatenated].sort((a, b) => a - b),
    );
    // SENSITIVITY: the walk really did cross kinds, so the assertion above is
    // not vacuously true of a single-kind run.
    expect(new Set(concatenated).size).toBeGreaterThan(1);

    // 3 ── the back chevron returns page two.
    await page.getByRole('button', { name: 'Previous page' }).click();
    await expect(page.getByText(/Showing 26–50 of 61/)).toBeVisible();
    await expect(page).toHaveURL(/\?page=2$/);

    // 4 ── page one carries NO param, and prev is inert there.
    await page.getByRole('button', { name: 'Page 1' }).click();
    await expect(page.getByText(/Showing 1–25 of 61/)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${POST_AUTH_LANDING}$`));
    await expect(page.getByRole('button', { name: 'Previous page' })).toBeDisabled();

    // 5 ── every other tab carries the footer with its OWN total.
    await page.getByTestId('workbench-tab-watching').click();
    await expect(page.getByText(/Showing 1–25 of 36/)).toBeVisible();

    // 7 ── Watching's bands. Page 1 is wholly under `In progress`, because the
    //      moving group is larger than one page.
    await expect(page.getByRole('rowheader')).toHaveCount(1);
    await expect(page.getByRole('rowheader')).toHaveText('In progress');
    // …and the page where the boundary falls shows In progress ABOVE To do.
    await page.getByRole('button', { name: 'Page 2' }).click();
    await expect(page.getByText(/Showing 26–36 of 36/)).toBeVisible();
    await expect(page.getByRole('rowheader')).toHaveText(['In progress', 'To do']);

    // 11 ── a hand-edited page: non-numeric, and past the end. Both land on a
    //       real page rather than an error.
    await page.goto('/workbench?tab=watching&page=not-a-number');
    await expect(page.getByText(/Showing 1–25 of 36/)).toBeVisible();
    await page.goto('/workbench?tab=watching&page=999');
    await expect(page.getByText(/Showing 26–36 of 36/)).toBeVisible();

    // 10 ── `zh`. The pager's range line and its controls' accessible names are
    //       the Chinese strings, so an untranslated control fails the walk.
    await page.context().addCookies([{ name: 'NEXT_LOCALE', value: 'zh', url: page.url() }]);
    await page.goto('/workbench');
    await expect(page.getByText(/显示第 1–25 项，共 61 项/)).toBeVisible();
    await expect(page.getByRole('navigation', { name: '分页' })).toBeVisible();
    await expect(page.getByRole('button', { name: '下一页' })).toBeVisible();
    // Asserted NEGATIVELY too: the English literals this story removed must not
    // be reachable on a Chinese page.
    await expect(page.getByRole('navigation', { name: 'Pagination' })).toHaveCount(0);
  });

  test('an EMPTY tab shows its drawn empty state and NO pager', async ({ page }) => {
    await seedPaging();
    // The second seeded reader owns nothing, so every tab is empty for them.
    await signIn(page, PAGER_EMPTY, TEST_PASSWORD);

    await expect(page.getByRole('heading', { name: 'Nothing to start' })).toBeVisible();
    // ⚠️ THE ABSENCE IS THE ASSERTION. "A pager on every tab", read literally,
    // would put `Showing 0–0 of 0` under an empty state — a second, quieter way
    // of saying what the empty state has just said (`design/workbench/` Panel
    // 10). Asserting only the empty state's presence would pass either way.
    await expect(page.getByRole('navigation', { name: 'Pagination' })).toHaveCount(0);
    await expect(page.getByText(/Showing/)).toHaveCount(0);
  });
});
