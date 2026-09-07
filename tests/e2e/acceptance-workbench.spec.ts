import type { Page } from '@playwright/test';
import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signIn, POST_AUTH_LANDING } from './_helpers/shell-session';
import { workItemsService } from '@/lib/services/workItemsService';
import { watchersService } from '@/lib/services/watchersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workflowsRepository } from '@/lib/repositories/workflowsRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { HOME_FINISHED_WINDOW_DAYS } from '@/lib/services/homeService';

// THE WORKBENCH, END TO END — AND THE ACCEPTANCE RECEIPT FOR IT
// (Story MOTIR-4777 · MOTIR-4785).
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// The story takes ONE list and splits it along the axis a person actually works
// on. So the acceptance question is not "does a list render" — the vitest gate
// answers that at the service layer, over a real Postgres, with a custom
// workflow and a partition property. It is whether a person opening Motir can
// SEE the split: whether the four tabs hold what their labels promise, whether
// the row that just landed is where they would look for it, and whether the
// address they have in muscle memory still works.
//
// The clip is therefore a walk across four tabs with the SAME rows underneath,
// held long enough on each that a watcher can read the rows before the next
// click. That pacing is a requirement of this card, not a courtesy: in this
// project acceptance rides the receipt, so a clip that flicks through four tabs
// in three seconds proves the code works and shows the reviewer nothing.
//
// ── ⚠️ THE TWO ASSERTIONS THAT CARRY THE STORY ──────────────────────────────
//
// **`Implemented` and `In Review` are IN PROGRESS.** They are where an agent
// leaves finished work for a person, so on this product they are the most
// important rows on the surface — and they are exactly the rows a predicate
// written against the single status spelled `in_progress` would silently lose.
// A walk that only checks a row sitting in `In Progress` passes on a broken
// implementation, which is why chapter 3 asserts all four in-progress-category
// statuses by name.
//
// **The finished window reads `completedAt`, not `updatedAt`.** Chapter 4
// TOUCHES the eight-day-old row's `updated_at` mid-walk and re-reads the tab. A
// window built on last-touch would list work finished in April that somebody
// re-titled today — the defect MOTIR-2758 was filed for, and one that never
// errors. This is the beat that goes red on the one shortcut a later refactor
// would reach for.
//
// ── ⚠️ THE CLOCK — VERIFIED BEFORE A LINE WAS WRITTEN, AND IT IS NOT THERE ───
//
// The card asks for the 7-day boundary "with a clock the test controls", and
// the pre-flight it also asks for found that THIS LANE HAS NO SUCH CONTROL and
// building one is a production seam this card does not own. The page runs in a
// SEPARATE Next process; `playwright.acceptance.config.ts` sets no `MOTIR_NOW`,
// there is no `/api/_test/` clock route, and a Playwright spec cannot move
// another process's `Date.now()`. Writing the boundary as if it could is
// exactly the vacuous pass the card warns about — green forever, measuring
// nothing.
//
// So the boundary is split by tier, deliberately:
//
//   * The EXACT boundary — seven days minus a second, and plus a second — is
//     asserted where a clock CAN be controlled: `tests/integration/workbench/
//     story-gate.test.ts`, in-process, under `vi.useFakeTimers({ toFake:
//     ['Date'] })` (MOTIR-4784).
//   * HERE the fixture is controlled instead of the clock: two days in and
//     eight days out, both offsets computed from the same wall clock the server
//     reads, with a six-day margin against any drift a run can produce. Plus
//     the falsifiability beat above, which is the half of the criterion that
//     actually bites — it fails if the predicate moves to `updatedAt`, and no
//     clock is needed to make it do so.
//
// ── WHAT THIS SPEC DELIBERATELY DOES NOT WALK ───────────────────────────────
//
// **The To-approve tab's CONTENTS.** Chapter 6 asserts the tab EXISTS and shows
// its empty state. The rows, the gate records and the approve control are the
// sibling story's (MOTIR-4778), which records its own receipt. Asserting them
// here would make this spec depend on a story that has not shipped.
//
// **The partition as a property, the custom workflow, tenant isolation.** All
// three are MOTIR-4784's, against real Postgres. This drives the browser.

const OWNER = 'workbench-owner@example.com';
const COLLEAGUE = 'workbench-colleague@example.com';
const FRESH = 'workbench-fresh@example.com';
const PASSWORD = 'workbench-acceptance-pass-123';

// ⚠️ SEEDED THROUGH THE SERVICES, never over HTTP. `_helpers/work-item-setup`'s
// `signUp` posts to `BASE_URL`, which defaults to port 3000 — the MAIN lane's.
// This lane runs on 3200 (`playwright.acceptance.config.ts` gives it a port of
// its own so all three lanes can run concurrently), so an HTTP sign-up from here
// reaches nothing: `connect ECONNREFUSED`, measured. Every other acceptance spec
// that seeds a user does it this way for the same reason.

const DAY = 24 * 60 * 60 * 1000;
const row = (identifier: string) => `[data-testid="workbench-row-${identifier}"]`;

interface Seeded {
  workspaceId: string;
  ownerId: string;
  /** By the status each one is parked at — the tab assertions read this map. */
  at: Record<string, string>;
  /** The eight-day-old row's id, for the `updatedAt` beat in chapter 4. */
  staleId: string;
}

/**
 * One project, one actor, and a row parked at every status the tabs partition.
 *
 * ⚠️ EVERY ROW IS MOVED THROUGH THE SERVICE, never by writing `work_item.status`.
 * `completedAt` is stamped by `applyStatusTransition` (MOTIR-4780), so a fixture
 * that set the column directly would produce rows that are `done` with no
 * completion time — and every assertion about the finished window would then
 * pass for the wrong reason. Only the two BACK-DATES touch a column, and both
 * move a stamp a real transition already wrote.
 */
async function seed(): Promise<Seeded> {
  const owner = await usersService.createUser({
    email: OWNER,
    password: PASSWORD,
    name: 'Zhu Yue',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: owner.id,
  });
  const colleague = await usersService.createUser({
    email: COLLEAGUE,
    password: PASSWORD,
    name: 'Mei Lin',
  });
  await workspacesService.addMember({
    userId: colleague.id,
    workspaceId: workspace.id,
    role: 'member',
  });
  const project = await projectsService.createProject({
    name: 'Motir',
    identifier: 'WBA',
    workspaceId: workspace.id,
    actorUserId: owner.id,
  });
  const ctx = { userId: owner.id, workspaceId: workspace.id };

  const statusId = async (key: string): Promise<string> => {
    const found = await withWorkspaceServiceContext(workspace.id, (tx) =>
      workflowsRepository.findStatusByKey(project.id, key, workspace.id, tx),
    );
    if (!found) throw new Error(`seeded status ${key} missing`);
    return found.id;
  };
  const allow = async (from: string, to: string): Promise<void> => {
    await workflowsService.addTransition({
      userId: owner.id,
      workspaceId: workspace.id,
      projectId: project.id,
      fromStatusId: await statusId(from),
      toStatusId: await statusId(to),
    });
  };

  const make = async (title: string, ...path: string[]) => {
    const item = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title },
      ctx,
    );
    for (const key of path) await workItemsService.updateStatus(item.id, key, ctx);
    return item;
  };

  // TO DO — the two `todo`-category statuses.
  const waiting = await make('Write the launch note');
  const blocked = await make('Waiting on the design review', 'blocked');

  // IN PROGRESS — all FOUR of the in-progress-category statuses. `implemented`
  // and `in_review` are the pair this walk exists to prove.
  const moving = await make('Rework the empty states', 'in_progress');
  const built = await make('Agent finished it; nobody has looked', 'in_progress', 'implemented');
  const reviewing = await make('Pull request open', 'in_progress', 'in_review');
  const planning = await make('Being re-planned', 'planning');

  // RECENTLY FINISHED — one two days old, one eight days old, and a Cancelled
  // row inside the window (a `done`-CATEGORY status that means abandoned).
  await allow('done', 'cancelled');
  const shipped = await make('Shipped on Tuesday', 'in_progress', 'done');
  const stale = await make('Shipped last month', 'in_progress', 'done');
  const dropped = await make('Written off this week', 'in_progress', 'done', 'cancelled');
  const backdate = async (id: string, days: number) => {
    await adminDb.workItem.update({
      where: { id },
      data: { completedAt: new Date(Date.now() - days * DAY) },
    });
  };
  await backdate(shipped.id, 2);
  await backdate(stale.id, HOME_FINISHED_WINDOW_DAYS + 1);
  await backdate(dropped.id, 1);

  // WATCHING — two rows the reader FOLLOWS and does not own, in two different
  // categories, so the group band has something to separate.
  const colleagueCtx = { userId: colleague.id, workspaceId: workspace.id };
  const followedMoving = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: "Mei's migration, in flight" },
    colleagueCtx,
  );
  await workItemsService.updateStatus(followedMoving.id, 'in_progress', colleagueCtx);
  const followedWaiting = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: "Mei's follow-up, not started" },
    colleagueCtx,
  );

  // ⚠️ CREATING AN ITEM AUTO-WATCHES YOU. Without this the reader would watch
  // all nine of their own rows and the Watching tab would be indistinguishable
  // from the others — a fact about the product, not a bug, and exactly the sort
  // of thing only a real-stack run surfaces.
  for (const item of [
    waiting,
    blocked,
    moving,
    built,
    reviewing,
    planning,
    shipped,
    stale,
    dropped,
  ]) {
    await watchersService.unwatch(item.id, ctx);
  }
  await watchersService.watch(followedMoving.id, ctx);
  await watchersService.watch(followedWaiting.id, ctx);

  // Pin the ACTIVE project: the Workbench reads it, so leaving it to whatever
  // `createProject` last set would make every assertion depend on the fixture.
  await projectsService.setActiveProject({
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });

  return {
    workspaceId: workspace.id,
    ownerId: owner.id,
    staleId: stale.id,
    at: {
      todo: waiting.identifier,
      blocked: blocked.identifier,
      in_progress: moving.identifier,
      implemented: built.identifier,
      in_review: reviewing.identifier,
      planning: planning.identifier,
      shipped: shipped.identifier,
      stale: stale.identifier,
      cancelled: dropped.identifier,
      followedMoving: followedMoving.identifier,
      followedWaiting: followedWaiting.identifier,
    },
  };
}

/** Switch tabs by clicking the strip, and wait on the RENDERED tab. */
async function openTab(page: Page, key: string): Promise<void> {
  await page.getByTestId(`workbench-tab-${key}`).click();
  await expect(page.getByTestId(`workbench-tab-${key}`)).toHaveAttribute('aria-current', 'page');
}

/** Exactly these rows are on screen, and nothing else the fixture holds. */
async function holdsExactly(page: Page, all: string[], expected: string[]): Promise<void> {
  for (const identifier of expected) {
    await expect(page.locator(row(identifier)), `${identifier} should be here`).toBeVisible();
  }
  for (const identifier of all.filter((i) => !expected.includes(i))) {
    await expect(page.locator(row(identifier)), `${identifier} should NOT be here`).toHaveCount(0);
  }
}

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

test('the landing surface splits by LIFECYCLE — to do, in flight, just landed, and what you follow', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-4777');

  const fx = await seed();
  const every = Object.values(fx.at);

  await chapter('Signing in lands on the Workbench, without navigating', async () => {
    // The authoritative signal is the RENDERED page, never a URL that merely
    // reads right and never an interval (CLAUDE.md § E2E). `signIn` settles on
    // it; this re-asserts the address, because the address is half the story.
    await signIn(page, OWNER, PASSWORD);
    await expect(page).toHaveURL(new RegExp(`${POST_AUTH_LANDING}$`));
    await expect(page.getByRole('heading', { name: 'Workbench', level: 1 })).toBeVisible();
    await expect(page.getByTestId('workbench-page')).toContainText('What you are doing in Motir');
    await beat();
  });

  await chapter('Five tabs, and the one you land on is what to start', async () => {
    for (const key of ['todo', 'in-progress', 'finished', 'watching', 'approvals']) {
      await expect(page.getByTestId(`workbench-tab-${key}`)).toBeVisible();
    }
    // To do is the DEFAULT, and it is spelled as the absence of `?tab=` — one
    // canonical URL per tab, so a link to the Workbench and a link to To do are
    // the same link.
    await expect(page.getByTestId('workbench-tab-todo')).toHaveAttribute('aria-current', 'page');
    await holdsExactly(page, every, [fx.at.todo!, fx.at.blocked!]);
    await beat();
  });

  await chapter(
    'In progress holds everything in flight — Implemented and In Review included',
    async () => {
      // ⚠️ THE ASSERTION THAT CARRIES THE STORY. All FOUR in-progress-category
      // statuses, by name. A predicate written against the single status spelled
      // `in_progress` would lose three of these rows — including the two where an
      // agent leaves finished work for a person, which are the rows on this
      // product a reader most needs to find.
      await openTab(page, 'in-progress');
      await expect(page).toHaveURL(/\?tab=in-progress$/);
      await holdsExactly(page, every, [
        fx.at.in_progress!,
        fx.at.implemented!,
        fx.at.in_review!,
        fx.at.planning!,
      ]);
      await expect(page.locator(row(fx.at.implemented!))).toContainText('Implemented');
      await expect(page.locator(row(fx.at.in_review!))).toContainText('In Review');
      await beat();
    },
  );

  await chapter('Recently finished says what you have just done, and what bounds it', async () => {
    await openTab(page, 'finished');
    await expect(page).toHaveURL(/\?tab=finished$/);

    // A bounded list that does not say what bounds it reads as a list that is
    // missing things.
    await expect(page.getByTestId('workbench-page')).toContainText('Finished in the last 7 days.');
    // The Cancelled row lands here too — it is `done`-CATEGORY — and it is drawn
    // beside Done rather than as it: abandoned is not accomplished.
    await holdsExactly(page, every, [fx.at.shipped!, fx.at.cancelled!]);
    await expect(page.locator(row(fx.at.cancelled!))).toContainText('Cancelled');
    await beat();
  });

  await chapter('The window reads when work FINISHED, not when it was last touched', async () => {
    // ⚠️ THE FALSIFIABILITY BEAT. Touch the eight-day-old row's `updated_at` to
    // right now and re-read the tab. A window built on last-touch would list
    // work finished last month that somebody re-titled today — the defect
    // MOTIR-2758 was filed for, and one that never errors. This is the step
    // that goes red on the shortcut a later refactor would reach for.
    await adminDb.workItem.update({
      where: { id: fx.staleId },
      data: { updatedAt: new Date() },
    });
    await page.reload();
    await expect(page.getByTestId('workbench-tab-finished')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.locator(row(fx.at.stale!))).toHaveCount(0);
    await expect(page.locator(row(fx.at.shipped!))).toBeVisible();
    await beat();
  });

  await chapter('Watching leads with what is moving', async () => {
    await openTab(page, 'watching');
    await expect(page).toHaveURL(/\?tab=watching$/);

    // A different AUDIENCE, not a partition of the work tabs: these are rows the
    // reader follows and does not own, which is why none of the nine above is
    // here.
    await holdsExactly(page, every, [fx.at.followedMoving!, fx.at.followedWaiting!]);
    await expect(page.locator(row(fx.at.followedMoving!))).toContainText('Watching');

    // …and the ORDER is the point of the tab's revision: what is moving sits
    // above what is waiting, under the two group bands.
    const bands = page.getByRole('rowheader');
    await expect(bands).toHaveCount(2);
    await expect(bands.first()).toHaveText(/In progress/i);
    await expect(bands.last()).toHaveText(/To do/i);
    const order = await page.getByRole('row').allTextContents();
    expect(order.findIndex((t) => t.includes(fx.at.followedMoving!))).toBeLessThan(
      order.findIndex((t) => t.includes(fx.at.followedWaiting!)),
    );
    await beat();
  });

  await chapter('To approve has its slot, and says so plainly until it is filled', async () => {
    // The tab's PRESENCE is this story's; its rows, its gates and its approve
    // control are the sibling story's (MOTIR-4778). Nothing here asserts a gate.
    await openTab(page, 'approvals');
    await expect(page).toHaveURL(/\?tab=approvals$/);
    await expect(page.getByText('Nothing is waiting on your approval')).toBeVisible();
    await holdsExactly(page, every, []);
    await beat();
  });

  await chapter('The address people already have still lands, with its query', async () => {
    // A URL is a promise to strangers. `/home` answers a permanent 308, and it
    // carries the query string — so a link to somebody's Watching tab, pasted
    // into chat months ago, still opens their Watching tab.
    const direct = await page.goto('/home');
    expect(direct?.status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`${POST_AUTH_LANDING}$`));

    await page.goto('/home?tab=watching');
    await expect(page).toHaveURL(new RegExp(`${POST_AUTH_LANDING}\\?tab=watching$`));
    await expect(page.getByTestId('workbench-tab-watching')).toHaveAttribute(
      'aria-current',
      'page',
    );
    await beat();
  });
});

test('a reader with nothing anywhere meets the all-empty page, not five zeroes', async ({
  page,
}) => {
  // On its OWN path, and not recorded: the happy walk above is the receipt, and
  // a clip that ends on an empty screen records the wrong thing. This is a
  // regression assertion about the first screen a brand-new account sees.
  const fresh = await usersService.createUser({
    email: FRESH,
    password: PASSWORD,
    name: 'Newcomer',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Fresh',
    ownerUserId: fresh.id,
  });
  const project = await projectsService.createProject({
    name: 'Fresh',
    identifier: 'WBF',
    workspaceId: workspace.id,
    actorUserId: fresh.id,
  });
  // A project, and nothing in it — which is the state this asserts. The
  // NO-project state is a different screen and a different card's (MOTIR-4815
  // retires it entirely by seeding a default project at registration).
  await projectsService.setActiveProject({
    userId: fresh.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  await signIn(page, FRESH, PASSWORD);

  await expect(page.getByTestId('workbench-page')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nothing to start' })).toBeVisible();
  // The empty To do state is one of the two that carry an action — it sends you
  // to Ready, because that emptiness is one a reader can do something about.
  await expect(page.getByRole('link', { name: 'Find something to start' })).toBeVisible();

  // ⚠️ AND EVERY COUNT IS SUPPRESSED. A row of five "0"s is five numbers a
  // brand-new user has to read and then discard, which is why the rule is
  // all-zero rather than each-zero.
  for (const key of ['todo', 'in-progress', 'finished', 'watching', 'approvals']) {
    await expect(page.getByTestId(`workbench-tab-${key}`)).not.toContainText('0');
  }
});
