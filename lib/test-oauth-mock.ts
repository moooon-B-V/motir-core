// Node-only Google OAuth token-endpoint mock for E2E.
//
// Pulled out of instrumentation.ts so the imports of node:crypto and
// node:fs/promises never get analyzed by Next's Edge-runtime bundler.
// instrumentation.ts dynamic-imports this file ONLY when E2E_TEST_OAUTH=1
// AND NEXT_RUNTIME=nodejs, which keeps the production code path totally
// dormant.
//
// What the mock does:
//   - Adds its intercept to the SHARED MockAgent instrumentation.ts installs
//     as the global undici dispatcher (shared with lib/test-blob-mock — a
//     second setGlobalDispatcher would silently disconnect the first mock).
//   - Intercepts POST https://oauth2.googleapis.com/token with a fixed
//     synthetic token response. The id_token is a properly-formed JWT
//     whose payload Better-Auth's google provider decodes (no signature
//     check on this code path, since `getUserInfo` uses jose's `decodeJwt`
//     directly — `verifyIdToken` is a separate sign-in-with-id-token
//     path we don't exercise).
//   - Reads the per-test user identity from E2E_TEST_OAUTH_USER_PATH on
//     each invocation so a single dev-server run can serve multiple
//     sequential E2E tests with different synthetic users.
//
// CRITICAL — undici version coupling:
//   The undici devDep is pinned to ^6.x specifically because Node 22
//   ships with built-in undici@6.x (process.versions.undici). Node's
//   `globalThis.fetch` uses the built-in dispatcher; calling
//   `setGlobalDispatcher` from a *different major* of the undici package
//   silently sets a dispatcher on the wrong copy of undici and the
//   intercept never fires. If a future Node upgrade bumps the bundled
//   undici to v7+, bump this devDep in lockstep.

import type { MockAgent } from 'undici';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  const header = enc({ alg: 'HS256', typ: 'JWT', kid: 'test' });
  const body = enc({
    iss: 'https://accounts.google.com',
    aud: process.env['GOOGLE_CLIENT_ID'] ?? 'test',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...payload,
  });
  const sig = createHmac('sha256', 'test-only-not-a-real-secret')
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${header}.${body}.${sig}`;
}

export function installGoogleTokenMock(agent: MockAgent): void {
  const TEST_USER_PATH =
    process.env['E2E_TEST_OAUTH_USER_PATH'] ?? '/tmp/motir-test-oauth-user.json';

  const pool = agent.get('https://oauth2.googleapis.com');
  pool
    .intercept({ path: '/token', method: 'POST' })
    .reply(
      200,
      async () => {
        let profile: { sub: string; email: string; name: string; emailVerified: boolean };
        try {
          const raw = await readFile(TEST_USER_PATH, 'utf8');
          profile = JSON.parse(raw) as typeof profile;
        } catch {
          profile = {
            sub: 'test-sub-default',
            email: 'google-e2e@example.com',
            name: 'Google E2E',
            emailVerified: true,
          };
        }
        const idToken = makeJwt({
          sub: profile.sub,
          email: profile.email,
          name: profile.name,
          email_verified: profile.emailVerified,
          picture: 'https://example.com/avatar.png',
        });
        return {
          access_token: `mock-access-token-${profile.sub}`,
          refresh_token: `mock-refresh-token-${profile.sub}`,
          id_token: idToken,
          expires_in: 3600,
          token_type: 'Bearer',
          scope: 'openid email profile',
        };
      },
      { headers: { 'content-type': 'application/json' } },
    )
    .persist();
}

// GitHub identity-grant mock (Story 7.10 · MOTIR-897) — the same seam, two more
// endpoints. githubIdentityService.completeOAuthCallback POSTs the code→token
// exchange to github.com and reads the user from api.github.com; intercepting
// both lets Playwright drive the REAL /api/github/oauth/start → authorize →
// callback round-trip (the browser leg is intercepted by the spec via
// page.route) without leaving localhost. The identity is a fixed synthetic
// user — the spec asserts the settings panel binds to this login (the values
// mirror tests/e2e/_helpers/github-const.ts's E2E_GITHUB_USER; kept literal
// here so the lib/ seam never imports test helpers).
export function installGithubOAuthMock(agent: MockAgent): void {
  agent
    .get('https://github.com')
    .intercept({ path: '/login/oauth/access_token', method: 'POST' })
    .reply(
      200,
      { access_token: 'gho_e2e_synthetic_token', token_type: 'bearer' },
      { headers: { 'content-type': 'application/json' } },
    )
    .persist();

  agent
    .get('https://api.github.com')
    .intercept({ path: '/user', method: 'GET' })
    .reply(
      200,
      { id: 583231, login: 'e2e-octocat', avatar_url: null },
      { headers: { 'content-type': 'application/json' } },
    )
    .persist();
}

// GitLab connect-grant mock (Story 7.23 · MOTIR-1480) — the GitLab mirror of the
// GitHub seam. gitlabConnectionService.completeOAuthCallback POSTs the code→token
// exchange to gitlab.com/oauth/token and reads the user from gitlab.com/api/v4/user;
// intercepting both lets Playwright drive the REAL /api/gitlab/oauth/start →
// authorize → callback round-trip (the browser leg is performed by the spec) without
// leaving localhost. The identity is a fixed synthetic user — the spec asserts the
// settings panel binds to this username (the values mirror
// tests/e2e/_helpers/gitlab-const.ts's E2E_GITLAB_USER; kept literal here so the
// lib/ seam never imports test helpers). GitLab addresses ONE host for both OAuth and
// REST (unlike GitHub's github.com + api.github.com).
export function installGitlabOAuthMock(agent: MockAgent): void {
  const gitlab = agent.get('https://gitlab.com');

  gitlab
    .intercept({ path: '/oauth/token', method: 'POST' })
    .reply(
      200,
      {
        access_token: 'gl_e2e_access_token',
        refresh_token: 'gl_e2e_refresh_token',
        token_type: 'bearer',
        // ~2h from server boot — comfortably future for the near-immediate E2E run.
        expires_in: 7200,
        created_at: Math.floor(Date.now() / 1000),
      },
      { headers: { 'content-type': 'application/json' } },
    )
    .persist();

  gitlab
    .intercept({ path: '/api/v4/user', method: 'GET' })
    .reply(
      200,
      { id: 771234, username: 'e2e-glcat' },
      { headers: { 'content-type': 'application/json' } },
    )
    .persist();
}
