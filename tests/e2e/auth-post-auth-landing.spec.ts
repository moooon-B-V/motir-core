import { expect, test } from '@playwright/test';
import { resetDatabase, db } from './_helpers/db-reset';
import { signIn, POST_AUTH_LANDING } from './_helpers/shell-session';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';

// E2E: the property MOTIR-2645 restores — **signing in performs exactly ONE
// navigation to the landing route, so a `page.goto` immediately afterwards
// lands where it was pointed.**
//
// This is the regression test for a flake that fired three times across two
// lanes (`acceptance-augment-replan.spec.ts:196` on PR #1640,
// `collab-at-scale.spec.ts:352` on #1772, `acceptance-quick-view-edit.spec.ts:237`
// on #2025), always with the same signature:
//
//     Error: page.goto: Navigation to ".../items" is interrupted by
//     another navigation to ".../dashboard"
//
// Signing in used to start TWO navigations to /dashboard — the page's own
// `router.push`, and a `window.location.href` that Better-Auth's client
// redirect plugin performed because the request carried a `callbackURL`. Either
// could win; the loser was aborted at the winner's commit, and when those few
// milliseconds fell the wrong side of the caller's `goto`, the loser committed
// into it instead. `_helpers/shell-session.ts`'s docstring carries the measured
// sequence.
//
// ── Why this test can FAIL, which is the point ──
//
// The abort window is milliseconds wide, so asserting on the ABORT would be
// asserting on a coin flip. What is deterministic is the thing that creates the
// window in the first place: a SECOND navigation existing at all. So the test
// counts every fetch of the landing route the sign-in performs — the document
// load and the soft push's RSC payload alike, since either can be the one that
// commits late — and requires exactly one. Against the pre-MOTIR-2645 code
// there are two and this fails; with the `router.push` gone there is one.
// Nothing here waits an interval to decide something is ready (CLAUDE.md § E2E
// authoritative signal).
//
// Prefetches are excluded by their `Next-Router-Prefetch` header: the shell
// prefetches its own nav links once the dashboard mounts, and a prefetch is a
// warm cache entry, not a navigation that can abort anything.
//
// The `goto` assertion below is then the behaviour that property buys, written
// the way the three occurrences were written: sign in, navigate, land.

const PWD = 'post-auth-landing-e2e-pass-123';
const OWNER_EMAIL = 'landing-owner@example.com';

test.describe('post-auth landing', () => {
  test.beforeEach(async () => {
    await resetDatabase();
  });

  test('signing in performs ONE navigation to the landing route, so the next page.goto lands', async ({
    page,
  }) => {
    const owner = await usersService.createUser({
      email: OWNER_EMAIL,
      password: PWD,
      name: 'Olivia Owner',
    });
    const { workspace } = await workspacesService.createWorkspace({
      name: 'Landing Workspace',
      ownerUserId: owner.id,
    });
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: owner.id,
      name: 'Landing Project',
      identifier: 'LAND',
    });
    await db.workspaceMembership.update({
      where: { userId_workspaceId: { userId: owner.id, workspaceId: workspace.id } },
      data: { activeProjectId: project.id },
    });

    // Every fetch of the landing route sign-in causes, labelled by kind: a
    // `document` request is a full page load, anything else is the RSC payload
    // of a soft navigation. Both are counted — a request that is ISSUED is a
    // race that exists, even if it is later aborted — and prefetches are not,
    // since they commit nothing.
    const landingNavigations: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname !== POST_AUTH_LANDING) return;
      if (r.headers()['next-router-prefetch'] === '1') return;
      landingNavigations.push(r.isNavigationRequest() ? 'document' : 'rsc');
    });

    await signIn(page, OWNER_EMAIL, PWD);

    expect(
      landingNavigations,
      'signing in must navigate to the landing route exactly ONCE — a second navigation to the same place races the first, and whichever loses is what aborts the caller\'s next goto. It must be the "document" one: the saved appearance is server-applied to the root layout\'s <html>, which only a fresh document render can rewrite (tests/e2e/appearance-sync.spec.ts).',
    ).toEqual(['document']);

    // The behaviour that buys: the navigation a spec writes immediately after
    // signing in is the one that lands.
    await page.goto('/items');
    await expect(page).toHaveURL(/\/items$/);
    await expect(page.getByRole('heading', { name: 'Work Items', exact: true })).toBeVisible();
  });
});
