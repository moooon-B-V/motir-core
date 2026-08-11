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
// workspace-scoped read → the tab strip's URL selection → the shipped row cells
// → the `?peek=` island, plus the two shell affordances this story moved out
// from under (the rail entry and the bell).
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
}

/**
 * One workspace, TWO projects, and a reader holding every relation the page has
 * to distinguish: assigned-only, reported-only, BOTH, agent-executed, and one
 * watched-but-not-owned.
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
  // Project B: reported-only, and one the reader merely watches.
  const reported = await make(projectB.id, 'I filed it, someone else owns it');
  const watched = await make(projectB.id, 'Watched but not mine');

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

    // 2. MY WORK — all three relations present, from BOTH projects, each row
    // saying which project it came from.
    await expect(page.locator(row(fx.assigned))).toBeVisible();
    await expect(page.locator(row(fx.reported))).toBeVisible();
    await expect(page.locator(row(fx.both))).toBeVisible();
    // The watched-but-not-owned item is NOT here — it is the other tab's.
    await expect(page.locator(row(fx.watched))).toHaveCount(0);

    await expect(page.locator(row(fx.assigned))).toContainText('Motir');
    await expect(page.locator(row(fx.reported))).toContainText('Atlas');
    await expect(page.locator(row(fx.assigned))).toContainText('Assigned');
    await expect(page.locator(row(fx.reported))).toContainText('Reported');

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

  test('Home is workspace-scoped: switching the active project changes nothing', async ({
    page,
  }) => {
    const fx = await seed();
    await signIn(page, OWNER, TEST_PASSWORD);

    const before = await page.locator('[data-testid^="home-row-"]').count();
    expect(before).toBeGreaterThan(1);

    // Switch through the SERVICE — the thing every other list surface scopes
    // by — then reload Home. Every other list would change here.
    await projectsService.setActiveProject({
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectB.id,
    });
    await page.reload();
    await expect(page.getByTestId('home-page')).toBeVisible();

    expect(await page.locator('[data-testid^="home-row-"]').count()).toBe(before);
    // Including the row from the project that is now INACTIVE.
    await expect(page.locator(row(fx.assigned))).toBeVisible();
  });
});
