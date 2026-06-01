// E2E setup helpers for the Story-1.4 work-item isolation spec (Subtask
// 1.4.8). Story 1.4 ships no production routes, so the spec drives the data
// layer through the throwaway `app/api/_test/*` endpoints. This module mints
// the prerequisites those endpoints need:
//
//   * a signed-in user (its own APIRequestContext carrying the Better-Auth
//     session cookie) — via the credential sign-up HTTP endpoint, the same
//     path the 1.2.7 / 1.3.6 specs exercise, but through Playwright's `request`
//     fixture rather than the browser (no page = much faster);
//   * one or more projects in that user's workspace — created directly via
//     projectsService (a server-side import, the one sanctioned cross-layer
//     reach for tests), because Story 1.4 has no project HTTP route either and
//     projects are a PREREQUISITE for work items, not the thing under test.
//
// The work items / links / revisions themselves are exercised over HTTP
// against the `_test` endpoints — that's the end-to-end surface 1.4.8 proves.
//
// Auth note: the `request` context sends an explicit Origin header equal to the
// dev-server base URL so Better-Auth's CSRF origin guard accepts the sign-up
// POST (trustedOrigins includes BETTER_AUTH_URL = BASE_URL — see
// playwright.config.ts + lib/auth/index.ts).

import { expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { projectsService } from '@/lib/services/projectsService';

export const TEST_PASSWORD = 'work-item-e2e-pass-123';

// Mirror playwright.config.ts's BASE_URL derivation so a worktree run on a
// custom port (E2E_BASE_URL / PORT) targets the same origin the dev server is
// spawned on.
export const BASE_URL =
  process.env['E2E_BASE_URL'] ?? `http://localhost:${process.env['PORT'] ?? '3000'}`;

export interface TestUser {
  /** A request context whose cookie jar holds this user's session. */
  ctx: APIRequestContext;
  userId: string;
  workspaceId: string;
  email: string;
}

export interface ProjectRef {
  id: string;
  identifier: string;
}

/**
 * Sign up a fresh user via POST /api/auth/sign-up/email and return a request
 * context bound to its session, plus the resolved user + workspace ids. The
 * workspace is the one Subtask 1.2.4's post-signup hook auto-creates; we poll
 * GET /api/workspaces/current until it resolves (the hook runs post-commit, so
 * it may lag the sign-up response by a tick).
 */
export async function signUp(email: string): Promise<TestUser> {
  const ctx = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Origin: BASE_URL },
  });

  const signUpRes = await ctx.post('/api/auth/sign-up/email', {
    data: { email, password: TEST_PASSWORD, name: email.split('@')[0] },
  });
  expect(signUpRes.ok(), `sign-up for ${email} should succeed (got ${signUpRes.status()})`).toBe(
    true,
  );

  // Resolve the active workspace + user id from /current. Poll: the
  // auto-workspace hook commits just after the sign-up response returns.
  let userId = '';
  let workspaceId = '';
  for (let attempt = 0; attempt < 25; attempt++) {
    const res = await ctx.get('/api/workspaces/current');
    if (res.status() === 200) {
      const body = (await res.json()) as {
        workspace: { id: string };
        membership: { userId: string };
      };
      workspaceId = body.workspace.id;
      userId = body.membership.userId;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(workspaceId, `workspace for ${email} should resolve`).not.toBe('');

  return { ctx, userId, workspaceId, email };
}

/**
 * Create a project in `user`'s workspace via the service (acting as the user,
 * who is the workspace owner/member). Returns the id + the normalized
 * identifier so work-item identifiers read predictably (e.g. P1ONE-1).
 */
export async function createProject(
  user: TestUser,
  name: string,
  identifier: string,
): Promise<ProjectRef> {
  const project = await projectsService.createProject({
    workspaceId: user.workspaceId,
    actorUserId: user.userId,
    name,
    identifier,
  });
  return { id: project.id, identifier: project.identifier };
}
