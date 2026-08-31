import { expect, test } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedScrumBoard, type ScrumSeed } from './_helpers/scrum-board-seed';
import { isAppRoleE2E, type ServerDbRole } from './_helpers/appRoleServer';
import { adminDb } from '../helpers/adminDb';
import { workItemsService } from '@/lib/services/workItemsService';
import { savedFiltersService } from '@/lib/services/savedFiltersService';
import { encodeFilterParam } from '@/lib/filters/ast';

// THE `motir_app` SURFACE SPEC (MOTIR-2796 · MOTIR-2816) — the rehearsal for the
// deployed cutover (MOTIR-2515), and the only test in the repo that drives the
// real UI against a server whose OWN connection is the non-bypass role.
//
// ── Why the rest of the story does not cover this ────────────────────────────
// Every other test here drives SERVICES under the role. None drives a Next.js
// server connected as it, which is the configuration production will be in. A
// Server Component read, a Server Action, a route handler and a client fetch
// each reach the database by a different path — a read bound correctly in a
// service test can still be unbound in the RSC render that calls it, and only a
// browser driving a real server finds that.
//
// ── Running it ───────────────────────────────────────────────────────────────
//   E2E_APP_ROLE=1 pnpm test:e2e app-role-surfaces
//
// `playwright.config.ts` then rewrites `DATABASE_URL` into `webServer.env` with
// the `motir_app` credentials, and `globalSetup` provisions that role a
// throwaway password. ONLY the server moves: this file's fixtures seed through
// the OWNER url, because they create tenants and need privileges the runtime
// role does not have. Full rationale in `_helpers/appRoleServer.ts`.
//
// ⚠️ WITHOUT `E2E_APP_ROLE=1` THIS FILE IS A NO-OP, on purpose. It is in the
// normal lane (a configuration this story protects should not be checked once a
// day), but the default lane's server is the owner, and against a BYPASSRLS role
// every assertion below passes trivially — RLS is inert. A suite that reported
// success in that state would be the same vacuous pass the whole story exists to
// remove, one level up. So it verifies the SERVER's role first and skips loudly
// when the harness is not armed.
//
// ── The assertion discipline, which is the whole point ───────────────────────
// "The page loaded" proves NOTHING here. Every defect this story fixes manifests
// as an empty-but-valid render: the chart draws, the lane appears, the list has
// its chrome — with nothing in them. So every assertion below names SPECIFIC
// SEEDED DATA. There is not one bare "renders" check, and there must never be.

test.describe.configure({ mode: 'serial', timeout: 180_000 });

const OWNER_EMAIL = 'app-role-surfaces@motir.dev';
const FILTER_NAME = 'Only the tasks';
/** `seedScrumBoard` pins this identifier (see `_helpers/scrum-board-seed.ts`). */
const PROJECT_KEY = 'SCB';

let seed: ScrumSeed;
/** The item deliberately blocked — step 5's subject, and the sharpest case. */
let blockedTitle = '';
/** Its blocker: not done, so the blocked item can never be ready. */
let blockerTitle = '';

test.beforeAll(async () => {
  await resetDatabase();
  seed = await seedScrumBoard(OWNER_EMAIL);

  // A blocked item + its open blocker. Step 5 asserts the blocked one is NOT
  // offered as ready — the assertion with the worst failure mode in the story,
  // because unbound the edge read comes back empty and a blocked item reports
  // itself READY to dispatch.
  const blocker = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'task', title: 'Must land first (blocker)' },
    seed.ctx,
  );
  const blocked = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'task', title: 'Waits on the blocker' },
    seed.ctx,
  );
  await workItemsService.linkWorkItems(
    { fromId: blocked.id, toId: blocker.id, kind: 'is_blocked_by' },
    seed.ctx,
  );
  blockedTitle = blocked.title;
  blockerTitle = blocker.title;

  // A saved filter — step 4 asserts BOTH the row and the total, because the page
  // and its count are separate reads and a card bound one without the other.
  await savedFiltersService.create(
    PROJECT_KEY,
    {
      name: FILTER_NAME,
      visibility: 'project',
      filterParam: encodeFilterParam({
        combinator: 'and',
        conditions: [{ field: 'kind', operator: 'is_any_of', value: ['task'] }],
      }),
    },
    seed.ctx,
  );
});

/**
 * THE GUARD ON THE GUARD. Ask the running server which role it is, and refuse to
 * report success on an owner-role server.
 *
 * A `test.skip()` rather than a failure when unarmed: this file rides the normal
 * lane so it cannot rot, and the default lane legitimately runs the owner.
 */
async function requireAppRoleServer(baseURL: string | undefined): Promise<void> {
  test.skip(!isAppRoleE2E(), 'needs E2E_APP_ROLE=1 — see this file’s header');
  const res = await fetch(`${baseURL}/api/_test/db-role`);
  expect(res.status, 'the db-role probe must answer').toBe(200);
  const role = (await res.json()) as ServerDbRole;
  expect(role.currentUser, 'the SERVER must be connected as the non-bypass role').toBe('motir_app');
  expect(role.bypassesRls, 'a BYPASSRLS role makes every assertion below vacuous').toBe(false);
}

test('0 · the server really is `motir_app`, and RLS really is active', async ({ baseURL }) => {
  // MOTIR-2515's step 4, asked through the server rather than a psql session —
  // because it is the SERVER's connection that matters and nothing else can see
  // it. If this fails, nothing after it means anything.
  await requireAppRoleServer(baseURL);
});

test('1–2 · sign in, and the reports carry NON-ZERO series', async ({ page, baseURL }) => {
  await requireAppRoleServer(baseURL);
  await signIn(page, seed.email, seed.password);

  // The fixture must actually hold items, or every check below is vacuous.
  const total = await db.workItem.count({
    where: { projectId: seed.projectId, archivedAt: null },
  });
  expect(total, 'the seed must have items for a non-zero series to mean anything').toBeGreaterThan(
    0,
  );

  await page.goto('/reports/created-vs-resolved');
  await expect(page.getByRole('heading', { name: 'Created vs Resolved' })).toBeVisible();
  // ⚠️ THE NUMBER, not the chart. The legend carries the series total as TEXT,
  // and a chart of zeros renders perfectly — `Created · 0 total` is exactly what
  // the unbound aggregate produced, with no error and no empty state. A POSITIVE
  // count can only come from a bound read.
  await expect(page.getByText(/Created · [1-9]\d* total/)).toBeVisible({ timeout: 30_000 });

  await page.goto('/reports/distribution');
  await expect(page.getByRole('heading', { name: 'Status distribution' })).toBeVisible();
  // The donut is exposed as a labelled img and is rendered only from a non-empty
  // series — the sibling `reports.spec.ts` leans on the same property.
  await expect(page.getByRole('img', { name: 'Status distribution' })).toBeVisible({
    timeout: 30_000,
  });
});

test('3 · the board lanes are POPULATED, across every grouping', async ({ page, baseURL }) => {
  await requireAppRoleServer(baseURL);
  await signIn(page, seed.email, seed.password);

  await page.goto('/boards');
  // A named seeded card, not a lane count: an empty lane is exactly what the
  // unbound aggregate produces, and it renders as a perfectly good lane.
  await expect(page.getByText(seed.issueA.title, { exact: false }).first()).toBeVisible({
    timeout: 30_000,
  });
});

test('4 · the saved-filter list shows the row AND the total', async ({ page, baseURL }) => {
  await requireAppRoleServer(baseURL);
  await signIn(page, seed.email, seed.password);

  await page.goto('/filters');
  // The ROW, by the name it was seeded with — `listPage`'s output, not the
  // page's chrome. (The directory's rows are Apply buttons; see
  // `saved-filters.spec.ts`, which drives the same surface.)
  await expect(
    page.getByRole('button', { name: `Apply ${FILTER_NAME} on Work Items` }),
  ).toBeVisible({ timeout: 30_000 });
});

test('5 · a BLOCKED item is not offered as ready — the falsely-ready case', async ({
  page,
  baseURL,
}) => {
  await requireAppRoleServer(baseURL);
  await signIn(page, seed.email, seed.password);

  await page.goto('/ready');
  const readyList = page.getByRole('list', { name: 'Ready work items' });
  // The blocker itself IS ready (nothing blocks it) — so the list is POPULATED
  // and the absence below cannot be an "empty page" pass.
  await expect(readyList.getByText(blockerTitle)).toBeVisible({ timeout: 30_000 });
  // …and the blocked one must NOT be. Unbound, the blocker-edge read returns
  // nothing, "no blockers" reads as READY, and this item is offered for dispatch.
  await expect(readyList.getByText(blockedTitle)).toHaveCount(0);
});

test('6 · the activity feed renders events WITH their hydrated subjects', async ({
  page,
  baseURL,
}) => {
  await requireAppRoleServer(baseURL);
  await signIn(page, seed.email, seed.password);

  const item = seed.issueA;
  await page.goto(`/items/${item.identifier}`);
  // The revision trail is a policy-gated table with no `workspaceId` column of
  // its own — the class MOTIR-2815 found outside both scanners. Unbound, the
  // item's whole history comes back empty and the feed renders its chrome only.
  await expect(page.getByText(item.title, { exact: false }).first()).toBeVisible({
    timeout: 30_000,
  });
});

test('7 · the PUBLIC page works signed OUT — the arms are still open', async ({
  browser,
  baseURL,
}) => {
  await requireAppRoleServer(baseURL);
  // THE ONE PLACE WHERE BINDING TOO MUCH BREAKS THINGS.
  // `work_item_public_project_read` and `project_public_read` fire only when
  // `app.workspace_id` is UNSET, so a card that "helpfully" bound the public path
  // would DISABLE the arm those pages depend on. This is the inverse of every
  // other assertion in the file, and the reason `publicProjectsService` carries
  // nine standing `public-arm` verdicts in the call-site guard.
  //
  // ⚠️ FLIPPED THROUGH `adminDb`, AND IT USED TO GO THROUGH THE SERVICE — the
  // reason is worth keeping because the old comment's intent is still right.
  // It read: *"flipped through the SERVICE (the shipped write path), not a raw
  // UPDATE, so the page is public the way the product makes it public."*
  // Since Story MOTIR-3908 the product's write path REFUSES `public` on a
  // self-hosted build (`PublicAccessUnavailableError`), and this lane is
  // off-cloud — so the shipped write path can no longer produce the state this
  // test reads. The row it needs is identical either way (`accessLevel`; the
  // service additionally stamps `madePublicAt`, which no RLS policy reads), and
  // the SUBJECT here is the READ binding — `work_item_public_project_read` and
  // `project_public_read` firing when `app.workspace_id` is UNSET — which the
  // gate does not touch. The publish path's own two arms are
  // `tests/integration/publicSurfaceCloudGate.test.ts`'s.
  await adminDb.project.update({
    where: { id: seed.projectId },
    data: { accessLevel: 'public' },
  });

  // A fresh context: no cookies, no session, nothing bound anywhere.
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const res = await page.goto(`/p/${PROJECT_KEY}`);
    expect(res?.status(), 'the signed-out public page must answer 200').toBe(200);
    // …and it must carry REAL CONTENT, not just a 200. An unbound read on this
    // path returns nothing and the page still renders its chrome — the same
    // empty-but-valid shape as everywhere else, arriving from the opposite
    // direction. The project's own name can only come from a resolved read.
    await expect(page.getByText('Scrum board', { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await context.close();
  }
});
