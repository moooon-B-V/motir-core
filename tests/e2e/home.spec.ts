import { expect, test } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { signUp as apiSignUp, createProject, TEST_PASSWORD } from './_helpers/work-item-setup';
import { workItemsService } from '@/lib/services/workItemsService';
import { watchersService } from '@/lib/services/watchersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { db as prisma } from '@/lib/db';

// E2E: the Home journey (Story MOTIR-2649 · Subtask MOTIR-2656) — the ASSEMBLED
// surface over the real stack. The correctness matrices (the access matrix, the
// dedupe across a page boundary) live at the vitest tier in
// `tests/integration/home/`; this drives what a PERSON does, and its first
// assertion is the one everything else depends on: signing in lands you here
// without navigating.
//
// @smoke — it exercises the seam no unit can: the Server Component's
// active-project read → the tab strip's URL selection → the shipped row cells
// → the `?peek=` island, plus the two shell affordances this story moved out
// from under (the rail entry and the bell).
//
// ⚠️ The SCOPE assertions inverted with MOTIR-2761: `/home` reads the ACTIVE
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

  // ⚠️ PIN THE ACTIVE PROJECT (MOTIR-2761). `/home` reads it now, so leaving it
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

const row = (identifier: string) => `[data-testid="home-row-${identifier}"]`;

test.describe('the Home journey', () => {
  test('sign in lands on Home; My work merges assigned and reported, deduped; Watching is its own audience', async ({
    page,
  }) => {
    const fx = await seed();

    // 1. SIGN IN — and LAND, without navigating. Half of what this spec is for:
    // if the landing breaks, nothing else about the story matters. The helper
    // settles on a rendered `/home` (MOTIR-2654 moved its target here).
    await signIn(page, OWNER, TEST_PASSWORD);
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByTestId('home-page')).toBeVisible();

    // 2. MY WORK — all three relations present, from the ACTIVE project.
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
    // The subtitle names the PROJECT, which is what the page is now about.
    await expect(page.getByTestId('home-page')).toContainText('Everything in Motir');

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

    // 5. WATCHING — a different audience, and the tab lives in the URL.
    await page.getByTestId('home-tab-watching').click();
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
    await expect(page.getByTestId('home-page')).toBeVisible();
    await expect(page.locator(row(fx.watched))).toBeVisible();
    await expect(page.getByTestId('home-tab-watching')).toHaveAttribute('aria-current', 'page');
  });

  test('the rail entry and the bell both still work — the two shell affordances this story moved out from under', async ({
    page,
  }) => {
    await seed();
    await signIn(page, OWNER, TEST_PASSWORD);

    // The DOOR. A page nobody lands on is a page nobody has, and the rail row
    // is the half of that which does not depend on the sign-in default.
    const home = page.getByRole('link', { name: 'Home', exact: true });
    await expect(home).toHaveAttribute('aria-current', 'page');
    // /dashboard keeps its route AND its own row — nothing was re-homed.
    await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.getByRole('link', { name: 'Home', exact: true }).click();
    await expect(page.getByTestId('home-page')).toBeVisible();

    // THE BELL. This story deliberately does NOT mount notifications on Home —
    // "Needs you" was removed as a duplicate of this drawer. So the assertion
    // is not that two surfaces agree; it is that the ONE surface still works
    // after a story that repointed the landing and added a nav row, which is
    // exactly the class of edit that breaks a shell affordance nobody reopened.
    await page.getByRole('button', { name: /^Notifications,/ }).click();
    await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
  });

  test('Home is PROJECT-scoped: switching the active project changes what it shows', async ({
    page,
  }) => {
    // ⚠️ THE INVERSION (MOTIR-2761). This test asserted the opposite until
    // 2026-08-17 — "switching the active project changes nothing" — which made
    // it a contract test for the defect: `/home` leads the PROJECT tier of the
    // rail, directly under the switcher, so a green assertion here certified
    // that a shipped control does nothing on the first screen after sign-in.
    // The fixture is unchanged; only the expectation is.
    const fx = await seed();
    await signIn(page, OWNER, TEST_PASSWORD);

    // Project A is active: its rows, and not project B's.
    await expect(page.locator(row(fx.assigned))).toBeVisible();
    await expect(page.locator(row(fx.otherProject))).toHaveCount(0);
    await expect(page.getByTestId('home-page')).toContainText('Everything in Motir');

    // Switch through the SERVICE — the thing every other list surface scopes
    // by, and now this one too — then reload Home.
    await projectsService.setActiveProject({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectB.id,
    });
    await page.reload();
    await expect(page.getByTestId('home-page')).toBeVisible();

    // The lists SWAP. Asserting both directions is what keeps this from passing
    // on a page that merely went empty.
    await expect(page.locator(row(fx.otherProject))).toBeVisible();
    await expect(page.locator(row(fx.assigned))).toHaveCount(0);
    await expect(page.locator(row(fx.both))).toHaveCount(0);
    await expect(page.getByTestId('home-page')).toContainText('Everything in Atlas');
  });

  test('with NO active project, /home renders the create-first door and the rail offers no Home row', async ({
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
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByTestId('home-page')).toBeVisible();

    // The shipped create-first door, reused from `/dashboard` — not a new empty
    // state and not the actionless `/ready` notice, because this route is LANDED
    // on rather than navigated to (§2.2).
    await expect(page.getByRole('heading', { name: 'Create your first project' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create project' })).toBeVisible();

    // And NO Home row in the rail: the duplicate `!hasProject` entry is gone
    // (§2.1). The route stays reachable by URL — which is how we got here — but
    // the product no longer offers a door to a room it can open only sometimes.
    await expect(page.getByRole('link', { name: 'Home', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Boards', exact: true })).toHaveCount(0);
  });
});
