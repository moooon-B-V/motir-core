// The BOARD, rendered under the CLOUD-ON posture (bug MOTIR-2912).
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
//
// `/boards` carries the heaviest server-side fan-out of any authed page — the
// page's `Promise.all` in `app/(authed)/boards/page.tsx` fires SEVEN service
// reads (assignable members · the workflow · sprints · custom fields ·
// components · referenced labels · the saved-filter tier) before it returns a
// single element, and a throw in any one of them takes the whole render. The
// `(authed)` segment ships no `error.tsx`, so such a throw surfaces as Next's
// BUILT-IN error page ("This page couldn't load"), not as a board-level state.
//
// Until this file, every board spec rode the MAIN lane — `board-load`,
// `board-a11y`, `board-filter`, `board-config`, the at-scale ones. That lane
// sets none of MOTIR_CLOUD / E2E_TEST_BILLING / MOTIR_AI_URL /
// E2E_TEST_CODE_HEALTH, and `playwright.config.ts` `testIgnore`s `cloud-*`, so
// the two sets were disjoint. The board was therefore rendered under the
// PRODUCTION posture by exactly one spec — `cloud-video.spec.ts`, which visits
// `/boards` to assert the "Awaiting acceptance" badge — and that spec seeds a
// PAID org (`seedBillingOwner` + `paidOrgState`) with the org/workspace context
// cookies pinned. The free-tier org on a plain sign-up, which is what a real
// new customer is, had never had its board rendered cloud-on by anything.
//
// That is the gap this file closes, and it is the gap rather than a specific
// defect that makes it worth a permanent spec: `MOTIR_CLOUD=true` makes the
// ADR §4 entitlement gates live and a freshly signed-up org sits on
// `PM_ENTITLEMENTS.free`, so the cheapest org in the product exercised the
// most fan-out-heavy page in the product zero times.
//
// ⚠️ THIS IS A POSTURE GUARD, NOT A SECOND COPY OF `board-load.spec.ts`.
// The load model — no per-column "Load more", virtualization, the Done-age
// window, the over-cap banner — stays in the main lane, where it belongs and
// where it is cheaper. What is asserted HERE is only what the main lane
// structurally cannot assert: that with the cloud flags ON and a free-tier org,
// the page renders its board instead of the server-error page. Keep it that
// way; a load-model assertion added here buys nothing and pays a second CI leg.
// (`notes.html` #267: a lane is its webServer ENV, not the glob that routes
// specs into it.)

import { expect, test, type Page } from '@playwright/test';
import { resetDatabase, adminDb } from './_helpers/db-reset';
import { signUp } from './_helpers/shell-session';
import { getBoard, columnByStatus } from './_helpers/board';
import { resetBillingFixture } from './_helpers/billing';
import { projectsService } from '@/lib/services/projectsService';
import { keyForAppend } from '@/lib/workItems/positioning';

test.describe.configure({ timeout: 90_000 });

test.beforeEach(async () => {
  await resetDatabase();
  // No fixture entry for this org → the E2E_TEST_BILLING mock reports it FREE.
  // Explicit rather than incidental: "free tier" is the precondition under test,
  // so a prior spec's leaked paid entry must not be able to satisfy it silently.
  resetBillingFixture();
});

test.afterAll(async () => {
  await adminDb.$disconnect();
});

interface Seed {
  userId: string;
  workspaceId: string;
  projectId: string;
  identifier: string;
}

/** A FRESH sign-up — the free-tier org — with a project pinned active. The same
 *  shape `board-load.spec.ts`'s `seedActiveProject` uses, deliberately: the
 *  posture is the only variable this file introduces. No context cookies are
 *  pinned, so the page must resolve its workspace/org context the way a real
 *  first-time user's browser does. */
async function seedFreeTierActiveProject(page: Page, email: string, identifier: string) {
  await signUp(page, email);
  const local = email.split('@')[0]!;
  // SEEDING runs as the OWNER (`adminDb`), never through `@/lib/db` — MOTIR-2939.
  // The read of `workspace` and the write to `workspace_membership` are both
  // against policy-gated tables with no workspace context bound, so under
  // `motir_app` the read returns `[]` and the update matches no row, neither
  // raising: the spec would drive the board against an unpopulated database.
  const user = await adminDb.user.findFirstOrThrow({ where: { email } });
  const ws = await adminDb.workspace.findFirstOrThrow({ where: { name: `${local}'s Workspace` } });
  const project = await projectsService.createProject({
    workspaceId: ws.id,
    actorUserId: user.id,
    name: 'Cloud Board',
    identifier,
  });
  await adminDb.workspaceMembership.update({
    where: { userId_workspaceId: { userId: user.id, workspaceId: ws.id } },
    data: { activeProjectId: project.id },
  });
  return { userId: user.id, workspaceId: ws.id, projectId: project.id, identifier } satisfies Seed;
}

async function seedCards(seed: Seed, status: string, count: number, startKey: number) {
  let position = keyForAppend(null);
  const rows = Array.from({ length: count }, (_, i) => {
    const key = startKey + i;
    const row = {
      workspaceId: seed.workspaceId,
      projectId: seed.projectId,
      kind: 'task' as const,
      key,
      identifier: `${seed.identifier}-${key}`,
      title: `Cloud card ${key}`,
      status,
      reporterId: seed.userId,
      position,
    };
    position = keyForAppend(position);
    return row;
  });
  await adminDb.workItem.createMany({ data: rows });
}

test('a FREE-TIER org renders its board cloud-on — not the server-error page', async ({ page }) => {
  const seed = await seedFreeTierActiveProject(page, 'cloud-board@example.com', 'CBD');
  await seedCards(seed, 'todo', 3, 1);
  await seedCards(seed, 'in_progress', 2, 101);

  await page.goto('/boards');

  // ⚠️ THE PRIMARY ASSERTION, AND IT IS ASSERTED FIRST AND EXPLICITLY.
  // The regression this file guards is a SERVER-SIDE THROW, whose visible form
  // is Next's built-in error page. Waiting only on `board` would report the
  // failure as a generic 30s locator timeout — true, but it names the symptom
  // furthest from the cause and sends the next reader hunting the board client
  // instead of the page's seven server reads. Assert the error page ABSENT by
  // name, so a regression says what actually happened. (The stack itself lands
  // in the webServer log, never in the Playwright trace — `acceptance-lane-cloud-on`.)
  await expect(
    page.getByText("This page couldn't load"),
    "the boards page rendered Next's built-in error page — a server read threw; " +
      'the stack is in the webServer output, not in this trace',
  ).toHaveCount(0);

  // The page's own header rendered, which means the seven-read `Promise.all`
  // resolved — this is the half the MAIN lane can never prove.
  await expect(page.getByRole('heading', { level: 1, name: 'Boards' })).toBeVisible();

  // …and the board itself loaded its projection and drew real columns/cards.
  await expect(page.getByTestId('board')).toBeVisible({ timeout: 30_000 });
  const board = await getBoard(page.request);
  const todo = columnByStatus(board, 'todo');
  expect(todo.totalCount).toBe(3);
  await expect(page.getByTestId(`board-count-${todo.id}`)).toHaveText('3');
  await expect(
    page.getByTestId(`board-column-${todo.id}`).locator('[data-testid^="board-card-"]').first(),
  ).toBeVisible();
});
