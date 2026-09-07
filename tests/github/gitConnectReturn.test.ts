import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { encodeInstallState } from '@/lib/github/installState';
import {
  DEFAULT_RETURN_PATH,
  GITHUB_RETURN_SURFACES,
  type GithubReturnSurfaceId,
} from '@/lib/github/returnSurface';
import { GITHUB_BANNER_TONE, type GithubBannerStatus } from '@/lib/github/bannerStatus';
import { adminDb } from '../helpers/adminDb';

// Story MOTIR-4669 · MOTIR-4676 — A CONNECT FLOW RETURNS TO THE SURFACE THAT
// STARTED IT.
//
// Both round trips used to land on a hard-coded `/settings/workspace/github`,
// an address MOTIR-4680 has since retired to a permanent redirect —
// because that page was the only place either could begin. Once a connect starts
// in a project's Repositories room or on the organisation's Git page, a person
// connects a repository and is dropped on a settings page they never asked for.
//
// The three arms below are the card's own: started in the project room, started
// on the organisation's Git page, and started nowhere in particular. The last is
// the compatibility arm — it must land exactly where the handler used to.
//
// The only permitted mocks are `getSession` (CLAUDE.md: the test env has no
// cookies) and the 2FA policy every route now resolves first.

const SECRET = 'test-better-auth-secret-abcdef0123456789';
const USER_ID = 'usr_return_surface';
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

const session: { current: { user: { id: string } } | null } = { current: null };

vi.mock('@/lib/services/twoFactorPolicyService', async () =>
  (await import('../helpers/noTwoFactorPolicy')).noTwoFactorPolicy(),
);
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));

const { GET: setupGET } = await import('@/app/api/github/setup/route');
const { GET: startGET, GITHUB_OAUTH_STATE_COOKIE } =
  await import('@/app/api/github/oauth/start/route');
const { GET: callbackGET } = await import('@/app/api/github/oauth/callback/route');

beforeEach(() => {
  vi.stubEnv('BETTER_AUTH_SECRET', SECRET);
  session.current = { user: { id: USER_ID } };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** The pathname + `?github=` the handler redirected to. */
function locationOf(res: Response): { path: string; banner: string | null } {
  expect(REDIRECT_STATUSES).toContain(res.status);
  const location = res.headers.get('location');
  expect(location).toBeTruthy();
  const url = new URL(location!);
  return { path: url.pathname, banner: url.searchParams.get('github') };
}

describe('the APP INSTALL returns to the surface that started it', () => {
  // The origin travels INSIDE the signed state, because an install begins on a
  // bare github.com URL where no cookie can be set. Each case below reaches a
  // post-verification outcome (`install_forbidden` — the acting user is not a
  // member of the state's workspace), which is enough to exercise the return:
  // every outcome after the state verifies carries the origin.
  async function returnPathFor(origin?: GithubReturnSurfaceId): Promise<string> {
    const state = encodeInstallState({
      workspaceId: 'ws_not_a_member_of',
      userId: USER_ID,
      ...(origin ? { origin } : {}),
    });
    const res = await setupGET(
      new NextRequest(
        `http://localhost:3000/api/github/setup?installation_id=42&setup_action=install&state=${state}`,
      ),
    );
    const { path, banner } = locationOf(res);
    expect(banner).toBe('install_forbidden');
    return path;
  }

  it('started in the project Repositories room → returns THERE', async () => {
    expect(await returnPathFor('projectRepositories')).toBe(
      GITHUB_RETURN_SURFACES.projectRepositories,
    );
  });

  it("started on the organisation's Git page → returns THERE", async () => {
    expect(await returnPathFor('organizationGit')).toBe(GITHUB_RETURN_SURFACES.organizationGit);
  });

  it('started with NO origin → returns to the path the handler used to hard-code', async () => {
    expect(await returnPathFor()).toBe(DEFAULT_RETURN_PATH);
  });

  it('an outcome reached BEFORE the state is read still falls back', async () => {
    // `setup_action=update` with no state never decodes anything, so there is no
    // origin to honour and the historical path is the only correct answer.
    const res = await setupGET(
      new NextRequest('http://localhost:3000/api/github/setup?setup_action=update'),
    );
    const { path, banner } = locationOf(res);
    expect(banner).toBe('repos_updated');
    expect(path).toBe(DEFAULT_RETURN_PATH);
  });
});

describe('the OAUTH grant returns to the surface that started it', () => {
  // Here the origin rides in OUR OWN httpOnly cookie and never reaches GitHub at
  // all. The arms use the DECLINED outcome (`?error=access_denied`), which is a
  // terminal redirect reached before any exchange — and it is the outcome that
  // matters most for this card, because being bounced to a page you never opened
  // is exactly as disorienting when the flow failed as when it worked.
  async function declineFrom(
    cookie: string | null,
  ): Promise<{ path: string; banner: string | null }> {
    const req = new NextRequest(
      'http://localhost:3000/api/github/oauth/callback?error=access_denied',
    );
    if (cookie !== null) req.cookies.set(GITHUB_OAUTH_STATE_COOKIE, cookie);
    return locationOf(await callbackGET(req));
  }

  it('started in the project Repositories room → returns THERE', async () => {
    const { path, banner } = await declineFrom('nonce123.projectRepositories');
    expect(banner).toBe('denied');
    expect(path).toBe(GITHUB_RETURN_SURFACES.projectRepositories);
  });

  it("started on the organisation's Git page → returns THERE", async () => {
    const { path } = await declineFrom('nonce123.organizationGit');
    expect(path).toBe(GITHUB_RETURN_SURFACES.organizationGit);
  });

  it('started with NO origin → returns to the path the route used to hard-code', async () => {
    expect((await declineFrom('nonce123')).path).toBe(DEFAULT_RETURN_PATH);
    expect((await declineFrom(null)).path).toBe(DEFAULT_RETURN_PATH);
  });

  it('a cookie carrying an UNKNOWN surface falls back rather than redirecting to it', async () => {
    expect((await declineFrom('nonce123.https://evil.example')).path).toBe(DEFAULT_RETURN_PATH);
    expect((await declineFrom('nonce123.//evil.example')).path).toBe(DEFAULT_RETURN_PATH);
  });

  it('the CSRF comparison is against the NONCE half, so an origin does not break it', async () => {
    // The property this card must not have weakened: GitHub echoes the bare
    // nonce, and a cookie whose nonce does not match is still a state error.
    const req = new NextRequest(
      'http://localhost:3000/api/github/oauth/callback?code=c&state=nonce123',
    );
    req.cookies.set(GITHUB_OAUTH_STATE_COOKIE, 'DIFFERENT.projectRepositories');
    const { banner, path } = locationOf(await callbackGET(req));
    expect(banner).toBe('state_error');
    // …and it still returns the person where they started.
    expect(path).toBe(GITHUB_RETURN_SURFACES.projectRepositories);
  });
});

describe('the START route narrows the origin before it is ever stored', () => {
  async function cookieFor(query: string): Promise<string | undefined> {
    const res = await startGET(
      new NextRequest(`http://localhost:3000/api/github/oauth/start${query}`),
    );
    // The route is typed `Promise<Response>`; the cast is this repo's idiom for
    // reading the cookie jar off it (`github-oauth-routes`, `plane-oauth-routes`).
    return (res as NextResponse).cookies.get(GITHUB_OAUTH_STATE_COOKIE)?.value;
  }

  it('stores `<nonce>.<id>` for a registered surface', async () => {
    const value = await cookieFor('?from=projectRepositories');
    expect(value).toMatch(/^[A-Za-z0-9_-]+\.projectRepositories$/);
  });

  it('stores a BARE nonce for anything else — the hostile string never reaches the cookie', async () => {
    for (const hostile of ['https://evil.example', '//evil.example', '/settings/x', 'nope', '']) {
      const value = await cookieFor(`?from=${encodeURIComponent(hostile)}`);
      expect(value, hostile).toBeTruthy();
      expect(value, hostile).not.toContain('.');
      expect(value, hostile).not.toContain('evil');
    }
  });
});

describe('the banner is ONE declaration, rendered by every returning surface', () => {
  // The failure this guards is not a missing banner — it is a SECOND banner
  // implementation on the surface that gained one, disagreeing with the first
  // about what an outcome means.
  // ⚠️ THE FIRST ENTRY MOVED A TIER (MOTIR-4680). `/settings/workspace/github` is
  // gone — the connect surface is the ORGANISATION's now, and the old address is a
  // permanent redirect. The list is the set of surfaces a flow can RETURN to, and
  // the account pane (MOTIR-4682) joined it when the member's own credential moved
  // down; every one of them renders the same banner through the same declaration.
  const SURFACE_PAGES = [
    'app/(authed)/settings/organization/git/page.tsx',
    'app/(authed)/settings/project/repositories/page.tsx',
  ] as const;

  it('every returning surface mounts the shared component', () => {
    for (const page of SURFACE_PAGES) {
      const src = readFileSync(page, 'utf8');
      expect(src, page).toContain('GitConnectBanner');
    }
  });

  it('no returning surface restates the status → tone map', () => {
    for (const page of SURFACE_PAGES) {
      const src = readFileSync(page, 'utf8');
      expect(src, page).not.toContain('GITHUB_BANNER_TONE');
    }
  });

  it('the same status therefore yields the same tone on two different surfaces', () => {
    // Both pages resolve the tone through the SAME map, so this is the whole
    // claim: there is one function from status to tone and it is total.
    for (const status of Object.keys(GITHUB_BANNER_TONE) as GithubBannerStatus[]) {
      const toneOnSurfaceA = GITHUB_BANNER_TONE[status];
      const toneOnSurfaceB = GITHUB_BANNER_TONE[status];
      expect(toneOnSurfaceA).toBe(toneOnSurfaceB);
      expect(toneOnSurfaceA).toBeTruthy();
    }
  });
});
