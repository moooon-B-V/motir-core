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
// window in the first place: a second navigation existing at all. So the test
// counts DOCUMENT navigation requests to the landing route across the whole
// sign-in. Against the pre-MOTIR-2645 code that count is 1 (the redirect
// plugin's full page load, on top of the soft push) and this fails; with the
// `callbackURL` removed at the source it is 0, and the soft push is the only
// navigation there is. Nothing here waits an interval to decide something is
// ready (CLAUDE.md § E2E authoritative signal).
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

    // A DOCUMENT request is the fingerprint of a full-page navigation; the soft
    // push fetches the same route as an RSC payload, which is not one. So this
    // counts the navigations sign-in performs BEYOND its own soft push —
    // including any that is aborted before it commits, since a request that is
    // issued is a race that exists.
    const landingDocumentRequests: string[] = [];
    page.on('request', (r) => {
      if (r.isNavigationRequest() && new URL(r.url()).pathname === POST_AUTH_LANDING) {
        landingDocumentRequests.push(r.url());
      }
    });

    await signIn(page, OWNER_EMAIL, PWD);

    expect(
      landingDocumentRequests,
      "signing in must not start a full-page navigation to the landing route — the page already soft-navigates there, and the second one is what aborts the caller's next goto",
    ).toEqual([]);

    // The behaviour that buys: the navigation a spec writes immediately after
    // signing in is the one that lands.
    await page.goto('/items');
    await expect(page).toHaveURL(/\/items$/);
    await expect(page.getByRole('heading', { name: 'Work Items', exact: true })).toBeVisible();
  });
});
