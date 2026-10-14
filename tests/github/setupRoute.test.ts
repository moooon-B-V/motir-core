import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { encodeInstallState } from '@/lib/github/installState';
import {
  GITHUB_BANNER_STATUSES,
  GITHUB_BANNER_TONE,
  GITHUB_BENIGN_BANNER_STATUSES,
  type GithubBannerStatus,
} from '@/lib/github/bannerStatus';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';
import { DEFAULT_RETURN_PATH } from '@/lib/github/returnSurface';
import { adminDb } from '../helpers/adminDb';

// MOTIR-3755 — the App Setup URL's outcomes. The defect this suite exists for is
// a SUCCESS reported as a failure: editing an installation's repository
// selection on github.com redirects here with `setup_action=update` and NO
// `state` (there was no Motir link to mint one), and the `!state` arm answered
// `install_error` — "We couldn't finish setting up the GitHub App" — while the
// repository had in fact connected. So the regression guard is on the SUCCESS
// path, and it asserts the banner is not `install_error` as well as what it is.
//
// The only permitted mock is `getSession` (CLAUDE.md: the test env has no
// cookies) plus the 2FA policy, which every route now resolves first; every
// case below stops at a redirect before any provider call.

const SECRET = 'test-better-auth-secret-abcdef0123456789';
const USER_ID = 'usr_setup_route';
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

/** Wall-clock seconds. The route decodes with the real clock, so expiry is
 *  driven by minting the token in the PAST rather than by faking timers — fake
 *  timers around a route that awaits Prisma buy a hang, not determinism. */
const nowSeconds = () => Math.floor(Date.now() / 1000);
/** Old enough that `exp = mintedAt + 600` is already behind us. */
const EXPIRED_AT = () => nowSeconds() - 1000;

const session: { current: { user: { id: string } } | null } = { current: null };

vi.mock('@/lib/services/twoFactorPolicyService', async () =>
  (await import('../helpers/noTwoFactorPolicy')).noTwoFactorPolicy(),
);
vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));

const { GET } = await import('@/app/api/github/setup/route');

function setupReq(query: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/github/setup${query}`);
}

/** The `?github=<status>` the handler redirected to. */
async function bannerOf(query: string): Promise<string | null> {
  const res = await GET(setupReq(query));
  expect(REDIRECT_STATUSES).toContain(res.status);
  const location = res.headers.get('location');
  expect(location).toBeTruthy();
  return new URL(location!).searchParams.get('github');
}

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

describe('a repository-selection edit made on GitHub is NOT an error', () => {
  // THE REGRESSION GUARD (MOTIR-3755). GitHub's own installation settings send
  // `setup_action=update` with an `installation_id` and no `state`.
  it('answers a benign banner — never install_error — for setup_action=update with no state', async () => {
    const banner = await bannerOf('?installation_id=42&setup_action=update');
    expect(banner).not.toBe('install_error');
    expect(banner).toBe('repos_updated');
    expect(GITHUB_BANNER_TONE[banner as GithubBannerStatus]).not.toBe('danger');
  });

  it('does not depend on the installation_id being echoed back', async () => {
    expect(await bannerOf('?setup_action=update')).toBe('repos_updated');
  });

  it('still reports an unbound install — one started on GitHub, not in Motir', async () => {
    // Same missing state, opposite meaning: nothing wrote the installation →
    // workspace binding, so there IS something left to do.
    const banner = await bannerOf('?installation_id=42&setup_action=install');
    expect(banner).toBe('install_unbound');
    expect(GITHUB_BANNER_TONE[banner as GithubBannerStatus]).not.toBe('danger');
  });

  // AMENDED ON THE RECORD (MOTIR-8471). This case used to assert
  // `installed` for an organisation-approval request — the opposite of what
  // happened: a member who is not an owner asked, GitHub sent the request to an
  // owner, and NOTHING is installed until one approves. What it always asserted,
  // and still does, is that an org-approval action binds nothing.
  it('reports an org-approval request as PENDING, and binds nothing', async () => {
    const banner = await bannerOf('?installation_id=42&setup_action=request');
    expect(banner).toBe('install_requested');
    expect(banner).not.toBe('installed');
    expect(GITHUB_BANNER_TONE[banner as GithubBannerStatus]).toBe('info');
    expect(await adminDb.githubInstallation.count({ where: { installationId: '42' } })).toBe(0);
  });

  it('reports any other non-install action as unbound — nothing was bound', async () => {
    expect(await bannerOf('?installation_id=42&setup_action=deny')).toBe('install_unbound');
  });
});

describe('the org-approval request returns where the install started (MOTIR-8471)', () => {
  async function locationOf(query: string): Promise<URL> {
    const res = await GET(setupReq(query));
    expect(REDIRECT_STATUSES).toContain(res.status);
    return new URL(res.headers.get('location')!);
  }

  it("returns to a verified state's origin, carrying its context", async () => {
    const token = encodeInstallState({
      workspaceId: 'ws_1',
      userId: USER_ID,
      origin: 'onboardingMigrateConnect',
      context: { via: 'onboard_existing_project', backKind: 'roadmap' },
    });
    const url = await locationOf(`?installation_id=42&setup_action=request&state=${token}`);
    expect(`${url.pathname}${url.search}`).toBe(
      '/onboarding/migrate?via=onboard_existing_project&backKind=roadmap&github=install_requested',
    );
  });

  it("falls back for another user's state — its origin is not the actor's", async () => {
    const token = encodeInstallState({
      workspaceId: 'ws_1',
      userId: 'somebody_else',
      origin: 'onboardingMigrateConnect',
    });
    const url = await locationOf(`?installation_id=42&setup_action=request&state=${token}`);
    expect(url.pathname).toBe(DEFAULT_RETURN_PATH);
    expect(url.searchParams.get('github')).toBe('install_requested');
  });

  it('falls back with no state, and for an unreadable one', async () => {
    for (const query of [
      '?installation_id=42&setup_action=request',
      '?installation_id=42&setup_action=request&state=garbage.sig',
    ]) {
      const url = await locationOf(query);
      expect(url.pathname, query).toBe(DEFAULT_RETURN_PATH);
      expect(url.searchParams.get('github'), query).toBe('install_requested');
    }
  });
});

describe('the carried context is re-appended to the return address (MOTIR-8471)', () => {
  async function pathAndQuery(query: string): Promise<string> {
    const res = await GET(setupReq(query));
    expect(REDIRECT_STATUSES).toContain(res.status);
    const url = new URL(res.headers.get('location')!);
    return `${url.pathname}${url.search}`;
  }

  it('lands on the address the step left from plus github=<status>', async () => {
    const token = encodeInstallState({
      workspaceId: 'ws_not_a_member',
      userId: USER_ID,
      origin: 'onboardingMigrateConnect',
      context: {
        via: 'onboard_existing_project',
        steps: 'connect,index',
        backKind: 'work-item',
        backItem: 'MOTIR-12',
      },
    });
    expect(await pathAndQuery(`?installation_id=42&setup_action=install&state=${token}`)).toBe(
      '/onboarding/migrate?via=onboard_existing_project&steps=connect%2Cindex&backKind=work-item&backItem=MOTIR-12&github=install_forbidden',
    );
  });

  it('an EXPIRED state still lands on the step it started from, reported as expired', async () => {
    const token = encodeInstallState(
      {
        workspaceId: 'ws_1',
        userId: USER_ID,
        origin: 'onboardingMigrateConnect',
        context: { backKind: 'project' },
      },
      EXPIRED_AT(),
    );
    expect(await pathAndQuery(`?installation_id=42&setup_action=install&state=${token}`)).toBe(
      '/onboarding/migrate?backKind=project&github=install_expired',
    );
    // …and the binding was still refused.
    expect(await adminDb.githubInstallation.count({ where: { installationId: '42' } })).toBe(0);
  });

  it('a carried value that does not read back is dropped, never redirected', async () => {
    const token = encodeInstallState({
      workspaceId: 'ws_not_a_member',
      userId: USER_ID,
      origin: 'onboardingMigrateConnect',
      context: { via: 'https://evil.example', steps: 'connect,nope', backItem: 'MOTIR-1' },
    });
    expect(await pathAndQuery(`?installation_id=42&setup_action=install&state=${token}`)).toBe(
      '/onboarding/migrate?github=install_forbidden',
    );
  });

  it('with no context the address is exactly what the handler always produced', async () => {
    const token = encodeInstallState({ workspaceId: 'ws_not_a_member', userId: USER_ID });
    expect(await pathAndQuery(`?installation_id=42&setup_action=install&state=${token}`)).toBe(
      `${DEFAULT_RETURN_PATH}?github=install_forbidden`,
    );
  });
});

describe('the state rejections are distinguishable', () => {
  it('reads an EXPIRED state differently from a missing or tampered one', async () => {
    const token = encodeInstallState({ workspaceId: 'ws_1', userId: USER_ID }, EXPIRED_AT());

    const banner = await bannerOf(`?installation_id=42&setup_action=install&state=${token}`);
    expect(banner).toBe('install_expired');
    // The remedy differs from every other rejection's, so the banner must not
    // claim the setup failed.
    expect(banner).not.toBe('install_error');
    expect(GITHUB_BANNER_TONE[banner as GithubBannerStatus]).not.toBe('danger');
  });

  it('keeps install_error for a TAMPERED state', async () => {
    const token = encodeInstallState({ workspaceId: 'ws_1', userId: USER_ID });
    const [, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ w: 'ws_ATTACKER', u: USER_ID, exp: nowSeconds() + 600 }),
    ).toString('base64url');

    expect(await bannerOf(`?installation_id=42&state=${forged}.${sig}`)).toBe('install_error');
  });

  it('keeps install_error for a state minted for ANOTHER user', async () => {
    const token = encodeInstallState({ workspaceId: 'ws_1', userId: 'somebody_else' });
    expect(await bannerOf(`?installation_id=42&state=${token}`)).toBe('install_error');
  });

  it('reports a non-member actor as its own outcome', async () => {
    // A validly-signed state for a workspace the acting user is not a member of
    // — the authorization check is unchanged, only the banner it produces is
    // distinguishable from a broken state.
    const token = encodeInstallState({ workspaceId: 'ws_not_a_member', userId: USER_ID });
    expect(await bannerOf(`?installation_id=42&state=${token}`)).toBe('install_forbidden');
  });

  it('bounces an unauthenticated visitor to sign-in with the install params intact', async () => {
    session.current = null;
    const res = await GET(setupReq('?installation_id=42&setup_action=update'));
    const location = res.headers.get('location')!;
    expect(location).toContain('/sign-in?next=');
    expect(decodeURIComponent(location)).toContain('setup_action=update');
  });
});

describe('every banner status is renderable', () => {
  const catalogues = { en, zh } as Record<string, { github: { banner: Record<string, string> } }>;

  it.each(Object.keys(catalogues))('%s carries copy for every status', (locale) => {
    const banner = catalogues[locale]!.github.banner;
    for (const status of GITHUB_BANNER_STATUSES) {
      expect(banner[status], `${locale} github.banner.${status}`).toBeTruthy();
    }
    // And nothing else: an orphan key is copy for a status no route emits.
    expect(Object.keys(banner).sort()).toEqual([...GITHUB_BANNER_STATUSES].sort());
  });

  it('never renders a benign outcome in the danger tone', () => {
    for (const status of GITHUB_BENIGN_BANNER_STATUSES) {
      expect(GITHUB_BANNER_TONE[status], status).not.toBe('danger');
    }
  });
});
