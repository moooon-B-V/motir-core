import { test, expect } from './_helpers/acceptance-video';
import { resetDatabase } from './_helpers/db-reset';
import { signIn, POST_AUTH_LANDING } from './_helpers/shell-session';
import { signUp as apiSignUp, createProject, TEST_PASSWORD } from './_helpers/work-item-setup';
import { workItemsService } from '@/lib/services/workItemsService';
import { watchersService } from '@/lib/services/watchersService';
import { db as prisma } from '@/lib/db';

// THE ACCEPTANCE RECEIPT FOR THE PAGER AND THE KIND ORDER
// (Story MOTIR-4850 · MOTIR-4855).
//
// ── ⚠️ WHY THIS IS ITS OWN FILE AND NOT AN EDIT TO `acceptance-workbench` ───
//
// The card says to extend the existing acceptance spec, and the repo's own
// lifecycle rule says the opposite once you look at what that file IS:
// `acceptance-workbench.spec.ts` declares `acceptanceStory('MOTIR-4777')`, and
// a spec declares exactly ONE story. Re-pointing it at MOTIR-4850 would take
// the receipt away from a story that has already been accepted on it — which is
// the precise reflex `CLAUDE.md` § An `acceptance-*.spec.ts` is a RECEIPT names
// as the one to resist: *do NOT update the assertion to match today*, because
// that edits history to agree with the present.
//
// So the card's INTENT is honoured — reuse the seeding helper, the sign-in
// fixture and the recording/publish mechanism, introduce no new harness — and
// its letter is not, in the one place the two conflict. `playwright.acceptance
// .config.ts` matches `acceptance*.spec.ts`, so this file is in the lane by
// naming alone.
//
// ── WHAT A REVIEWER IS WATCHING FOR ─────────────────────────────────────────
//
// This story's outcome is a feeling more than a fact — *can I get around my own
// work* — and no assertion captures it. What a person needs to see is: a
// footer that says how much there IS, a page number they can jump to, a way
// BACK, and a list whose top is the work they could actually start. Thirty
// seconds of that answers the question a green tick cannot.
//
// ⚠️ THE PACING IS A REQUIREMENT OF THIS CARD, NOT A COURTESY, and this
// paragraph is the thing a later edit has to argue with before speeding the
// clip up. Acceptance in this project rides the receipt, so a clip that flicks
// through four tabs in three seconds proves the code works and shows the
// reviewer nothing. Every chapter ends on a `beat()`, and the ordering chapter
// holds twice — once to read the glyph column, once to read it again after the
// page turns — because the sorted run is the thing the story is FOR and it
// takes a moment to see.

const OWNER = 'accept-pager@example.com';

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async () => {
  await resetDatabase();
});

/**
 * A reader whose To do spans three pages across all five kinds, seeded in the
 * WRONG order — epics first — so a list that had kept `updatedAt DESC` would
 * show this fixture reversed rather than sorted. Watching's moving band is
 * larger than one page, which is the arrangement the keyset could never
 * produce.
 */
async function seed() {
  const owner = await apiSignUp(OWNER);
  const project = await createProject(owner, 'Motir', 'ACP');
  const ctx = { userId: owner.userId, workspaceId: owner.workspaceId };

  const created: string[] = [];
  let story: string | undefined;
  for (const kind of ['epic', 'story', 'task', 'bug', 'subtask'] as const) {
    for (let i = 0; i < 11; i += 1) {
      const item = await workItemsService.createWorkItem(
        {
          projectId: project.id,
          kind,
          title: `${kind === 'subtask' ? 'Subtask' : kind[0]!.toUpperCase() + kind.slice(1)} ${i + 1} — the work a reader picks up`,
          ...(kind === 'subtask' ? { parentId: story! } : {}),
        },
        ctx,
      );
      if (kind === 'story' && story === undefined) story = item.id;
      created.push(item.id);
    }
  }
  const watched: string[] = [];
  for (let i = 0; i < 30; i += 1) {
    const item = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: `Following this one ${i + 1}` },
      ctx,
    );
    watched.push(item.id);
  }
  await prisma.workItem.updateMany({
    where: { id: { in: watched } },
    data: { status: 'in_progress' },
  });
  for (const id of created) await watchersService.unwatch(id, ctx);
  await prisma.workItem.updateMany({
    where: { id: { in: [...created, ...watched] } },
    data: { assigneeId: owner.userId, reporterId: owner.userId },
  });
  return { owner, project };
}

test('a person walks their own Workbench by page, and the top of the list is what they can start', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  // The receipt belongs to the STORY, not to this subtask.
  acceptanceStory('MOTIR-4850');

  await seed();

  await chapter(
    'Signing in lands on the Workbench, with a footer that says how much there is',
    async () => {
      await signIn(page, OWNER, TEST_PASSWORD);
      await expect(page).toHaveURL(new RegExp(`${POST_AUTH_LANDING}$`));
      await expect(page.getByRole('heading', { name: 'Workbench', level: 1 })).toBeVisible();
      // The change a reader notices first: the list now says how far it goes.
      // Before this story it said `Next` and nothing else.
      await expect(page.getByText(/Showing 1–25 of 55/)).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Pagination' })).toBeVisible();
      await beat();
    },
  );

  await chapter('The top of the list is the work you can actually start', async () => {
    // ⚠️ HELD TWICE, and the reason is that this is the half of the story a
    // watcher has to READ rather than see. The glyph column runs subtask → bug
    // → task → story → epic — the same order `/ready` uses — so the granular,
    // runnable work is at the top of the page a person lands on, and the
    // containers are at the bottom.
    await expect(page.locator('[data-testid^="workbench-row-"]').first()).toBeVisible();
    await beat();
    await beat();
  });

  await chapter('Jump to page three — and the address goes with you', async () => {
    await page.getByRole('button', { name: 'Page 3' }).click();
    await expect(page.getByText(/Showing 51–55 of 55/)).toBeVisible();
    await expect(page).toHaveURL(/\?page=3$/);
    // Bookmarkable, shareable, and the server re-reads it — which is the whole
    // difference between a page number and an opaque cursor.
    await beat();
  });

  await chapter('And a way BACK, which the old one did not have at all', async () => {
    await page.getByRole('button', { name: 'Previous page' }).click();
    await expect(page.getByText(/Showing 26–50 of 55/)).toBeVisible();
    await expect(page).toHaveURL(/\?page=2$/);
    await beat();
    // Page one is the tab's own address — one canonical URL per view.
    await page.getByRole('button', { name: 'Page 1' }).click();
    await expect(page).toHaveURL(new RegExp(`${POST_AUTH_LANDING}$`));
    await expect(page.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await beat();
  });

  await chapter('The same footer on every tab, each counting its own set', async () => {
    await page.getByTestId('workbench-tab-watching').click();
    await expect(page.getByText(/Showing 1–25 of 30/)).toBeVisible();
    // What you are FOLLOWING that is moving, banded above what is waiting — and
    // the band survives a page boundary now, which it never had to before.
    await expect(page.getByRole('rowheader')).toHaveText('In progress');
    await beat();
  });
});
