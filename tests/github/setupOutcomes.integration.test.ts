import { generateKeyPairSync } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { encryptToken } from '@/lib/github/tokenCrypto';
import { encodeInstallState, decodeInstallStateResult } from '@/lib/github/installState';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import {
  DEFAULT_RETURN_PATH,
  GITHUB_RETURN_SURFACES,
  type GithubReturnSurfaceId,
} from '@/lib/github/returnSurface';
import {
  GITHUB_BANNER_STATUSES,
  GITHUB_BANNER_TONE,
  type GithubBannerStatus,
} from '@/lib/github/bannerStatus';
import type { TwoFactorRequiredBody } from '@/lib/auth/requireCompliantSession';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

// THE SETUP CALLBACK'S OUTCOMES, ACROSS BOTH RETURN SURFACES, AGAINST THE REAL
// DATASTORE (Story MOTIR-8241 · MOTIR-8476).
//
// `GET /api/github/setup` is driven end to end, and every outcome is read as
// THREE things together: the `?github=` status, the destination
// (`new URL(location).pathname`), and the rows it wrote or refused to write. The
// unit suites read one each — `setupRoute.test.ts` the status (its `bannerOf`
// discards the path), `gitConnectReturn.test.ts` the destination — and neither
// can see a `select_repos` that bound the account anyway, or an
// `install_forbidden` that left a row behind. That pairing is this file's job.
//
// THE TWO RETURN SURFACES. Every outcome reached once the signed state VERIFIES
// for the acting user is driven twice — origin `onboardingMigrateConnect`
// (`/onboarding/migrate`, the migrate wizard's connect step) and origin
// `organizationGit` (`DEFAULT_RETURN_PATH`, Settings → Organisation → Git) — and
// the two destinations are separate assertions, so no single path can satisfy
// both.
//
// FOLLOWS the fixture idiom and the two seams of the two shipped integration
// suites, `tests/github/multiOrgInstallation.integration.test.ts` and
// `tests/github/connectFlowApi.test.ts`.
//
// THE FOUR SEAMS — everything else is real, including Postgres:
//   1. the session      → `vi.mock('@/lib/auth')`'s `getSession` (no cookies here);
//   2. the 2FA policy   → `@/lib/auth/requireCompliantSession`'s
//                         `resolveTwoFactorHold`, which is also what makes the
//                         2FA arm reachable;
//   3. `fetch`          → `vi.stubGlobal('fetch', …)` with a generated RSA key and
//                         stubbed `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` /
//                         `GITHUB_APP_SLUG`; nothing leaves the process, and the
//                         suite passes with GitHub unreachable;
//   4. `BETTER_AUTH_SECRET` → stubbed, because the install state is signed with it.
// Rows are asserted through `adminDb` and truncated between tests.
//
// VERIFIED AGAINST commit 139c15205 (branch parent/MOTIR-8241-onboarding-github-
// connect, MOTIR-8471's round trip on it). Two expectations follow THAT
// contract rather than the card's original reading of the route, because the
// round-trip card changed them on purpose: an EXPIRED state, and a verified
// state with no `installation_id`, both return to the origin the state names
// (`returnTargetOf` in the route). Re-verify against the route's header comment
// before changing either; do not re-derive them from an older control flow.
//
// Renders no component and reads no `messages/*.json`: copy and pixels are other
// tiers' (the connect step's component suite, E2E).

const PASSWORD = 'hunter2hunter2';
const SECRET = 'test-better-auth-secret-abcdef0123456789';
const INSTALLATION = '4242';
const OTHER_INSTALLATION = '5555';
const ONBOARDING_PATH = '/onboarding/migrate';

const session: { userId: string | null } = { userId: null };
const twoFactor: { hold: TwoFactorRequiredBody | null } = { hold: null };

vi.mock('@/lib/auth/requireCompliantSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/requireCompliantSession')>()),
  resolveTwoFactorHold: async () => twoFactor.hold,
}));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => (session.userId ? { user: { id: session.userId } } : null),
}));

const setupRoute = await import('@/app/api/github/setup/route');

// ── GitHub, faked at fetch ─────────────────────────────────────────────────────

/** What the App sees on each installation, by installation id. */
let visibleByInstallation: Record<string, number[]> = {};
/** The installations each user token can see on GitHub, by token. */
let userInstallations: Record<string, number[]> = {};
/** When set, every api.github.com call answers this status. */
let githubDown: number | null = null;
/** Every URL the handler asked for — none may be anything but the stub. */
let fetched: string[] = [];

function stubGithub(): void {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  vi.stubEnv('GITHUB_APP_SLUG', 'motir-test');
  const json = (o: unknown, status = 200): Response =>
    new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      fetched.push(url);
      if (githubDown !== null) return json({ message: 'Server Error' }, githubDown);
      const token = (new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, '');
      if (url.includes('/user/installations')) {
        return json({
          installations: (userInstallations[token] ?? []).map((id) => ({
            id,
            app_id: 999,
            repository_selection: 'selected',
            account: { login: `acct-${id}`, type: 'Organization', avatar_url: null },
          })),
        });
      }
      // The installation token names its installation, so the repository list
      // below can answer per installation.
      const mint = /\/app\/installations\/(\d+)\/access_tokens/.exec(url);
      if (mint) {
        return json({
          token: `ghs_${mint[1]}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (url.includes('/installation/repositories')) {
        const id = token.replace(/^ghs_/, '');
        return json({
          repositories: (visibleByInstallation[id] ?? []).map((repoId) => ({
            id: repoId,
            name: `r${repoId}`,
            owner: { login: `acct-${id}` },
            default_branch: 'main',
          })),
        });
      }
      const account = /\/app\/installations\/(\d+)$/.exec(url);
      if (account) {
        return json({
          id: Number(account[1]),
          account: { login: `acct-${account[1]}`, type: 'Organization' },
        });
      }
      return json({ message: 'Not Found' }, 404);
    }),
  );
}

// ── Fixture ────────────────────────────────────────────────────────────────────

interface Org {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
}

async function makeOrg(slug: string): Promise<Org> {
  const user = await usersService.createUser({
    email: `${slug}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: slug,
    ownerUserId: user.id,
  });
  const row = await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
  return { organizationId: row.organizationId, workspaceId: workspace.id, ownerId: user.id };
}

async function connectIdentity(userId: string, token: string): Promise<void> {
  await adminDb.githubIdentity.create({
    data: {
      userId,
      githubUserId: `gh-${userId}`,
      githubLogin: `login-${userId}`,
      accessTokenEncrypted: encryptToken(token),
    },
  });
}

/** A workspace-binding state — the shape the onboarding mint signs (no org). */
function workspaceState(org: Org, origin?: GithubReturnSurfaceId, userId = org.ownerId): string {
  return encodeInstallState({
    workspaceId: org.workspaceId,
    userId,
    ...(origin ? { origin } : {}),
  });
}

/** An organisation-link state — the shape the Git room's "Install on another
 *  account" signs, here with either origin. */
function orgState(org: Org, origin: GithubReturnSurfaceId, userId = org.ownerId): string {
  return encodeInstallState({
    workspaceId: org.workspaceId,
    userId,
    organizationId: org.organizationId,
    origin,
  });
}

function setupUrl(query: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, v);
  return `http://localhost:3000/api/github/setup?${params.toString()}`;
}

interface Outcome {
  res: Response;
  location: URL;
  path: string;
  github: GithubBannerStatus;
}

async function callSetup(url: string): Promise<Outcome> {
  const res = await setupRoute.GET(new NextRequest(url));
  expect([302, 303, 307, 308]).toContain(res.status);
  const location = new URL(res.headers.get('location')!);
  return {
    res,
    location,
    path: location.pathname,
    github: location.searchParams.get('github') as GithubBannerStatus,
  };
}

async function setup(
  state: string | undefined,
  setupAction = 'install',
  /** `null` sends no `installation_id` at all. */
  installationId: string | null = INSTALLATION,
): Promise<Outcome> {
  return callSetup(
    setupUrl({ installation_id: installationId ?? undefined, setup_action: setupAction, state }),
  );
}

async function installationRowsFor(workspaceId: string): Promise<number> {
  return adminDb.githubInstallation.count({ where: { workspaceId } });
}
async function linksOf(org: Org): Promise<number> {
  return adminDb.githubInstallationOrgLink.count({ where: { organizationId: org.organizationId } });
}
async function reposOf(org: Org): Promise<string[]> {
  const rows = await adminDb.githubRepo.findMany({
    where: { organizationId: org.organizationId },
    orderBy: { repoId: 'asc' },
  });
  return rows.map((r) => r.repoId);
}
/** Everything an organisation holds on the GitHub side. */
async function snapshotOf(org: Org) {
  return {
    installations: await adminDb.githubInstallation.findMany({
      where: { organizationId: org.organizationId },
      orderBy: { installationId: 'asc' },
    }),
    links: await adminDb.githubInstallationOrgLink.findMany({
      where: { organizationId: org.organizationId },
    }),
    repos: await adminDb.githubRepo.findMany({
      where: { organizationId: org.organizationId },
      orderBy: { repoId: 'asc' },
    }),
  };
}

/** The two return surfaces, each with the path it must resolve to. */
const SURFACES: readonly { origin: GithubReturnSurfaceId; path: string; label: string }[] = [
  { origin: 'onboardingMigrateConnect', path: ONBOARDING_PATH, label: 'onboarding connect step' },
  { origin: 'organizationGit', path: DEFAULT_RETURN_PATH, label: 'Settings → Organisation → Git' },
];

let a: Org;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.githubInstallation.deleteMany({});
  _resetInstallationTokenCache();
  vi.stubEnv('BETTER_AUTH_SECRET', SECRET);
  visibleByInstallation = { [INSTALLATION]: [1, 2, 3], [OTHER_INSTALLATION]: [1, 9] };
  userInstallations = {};
  githubDown = null;
  fetched = [];
  twoFactor.hold = null;
  stubGithub();
  spyOnJobDispatch();
  a = await makeOrg('aorg');
  await connectIdentity(a.ownerId, 'gho_a');
  userInstallations['gho_a'] = [Number(INSTALLATION)];
  session.userId = a.ownerId;
});

afterEach(() => {
  // Nothing the handler asked for may be anything but GitHub's API host —
  // and the stub answered every one of those, so none left the process.
  for (const url of fetched) expect(new URL(url).host).toBe('api.github.com');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  session.userId = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the map this suite drives', () => {
  it('has an onboarding entry at /onboarding/migrate, distinct from the default', () => {
    expect(GITHUB_RETURN_SURFACES.onboardingMigrateConnect).toBe(ONBOARDING_PATH);
    expect(DEFAULT_RETURN_PATH).toBe(GITHUB_RETURN_SURFACES.organizationGit);
    expect(ONBOARDING_PATH).not.toBe(DEFAULT_RETURN_PATH);
  });
});

describe.each(SURFACES)('the origin is honoured — returning to the $label', ({ origin, path }) => {
  it('binds the workspace → installed, with exactly one installation row', async () => {
    const out = await setup(workspaceState(a, origin));
    expect(out.github).toBe('installed');
    expect(out.path).toBe(path);
    expect(out.location.searchParams.get('installation_id')).toBeNull();
    expect(await installationRowsFor(a.workspaceId)).toBe(1);
    expect(await reposOf(a)).toEqual(['1', '2', '3']);
  });

  it('replayed (Browser Back) → installed again, still one installation row', async () => {
    const state = workspaceState(a, origin);
    expect((await setup(state)).github).toBe('installed');
    const again = await setup(state);
    expect(again.github).toBe('installed');
    expect(again.path).toBe(path);
    expect(await installationRowsFor(a.workspaceId)).toBe(1);
    expect(await linksOf(a)).toBe(1);
  });

  it('an install granting no usable repository → installed, a binding with no repository', async () => {
    visibleByInstallation[INSTALLATION] = [];
    const out = await setup(workspaceState(a, origin));
    expect(out.github).toBe('installed');
    expect(out.path).toBe(path);
    // The input the connect-state read turns into "no repositories selected".
    expect(await installationRowsFor(a.workspaceId)).toBe(1);
    expect(await linksOf(a)).toBe(1);
    expect(await reposOf(a)).toEqual([]);
  });

  it('a workspace the actor is not a member of → install_forbidden, nothing written', async () => {
    const stranger = await makeOrg('stranger');
    const out = await setup(
      encodeInstallState({ workspaceId: stranger.workspaceId, userId: a.ownerId, origin }),
    );
    expect(out.github).toBe('install_forbidden');
    expect(out.path).toBe(path);
    expect(await adminDb.githubInstallation.count()).toBe(0);
    expect(await adminDb.githubInstallationOrgLink.count()).toBe(0);
  });

  it('App credentials unset → install_provider_error as a redirect, nothing written', async () => {
    vi.stubEnv('GITHUB_APP_ID', '');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', '');
    const out = await setup(workspaceState(a, origin));
    expect(out.res.status).not.toBe(500);
    expect(out.github).toBe('install_provider_error');
    expect(out.path).toBe(path);
    expect(await adminDb.githubInstallation.count()).toBe(0);
  });

  it('GitHub answers 5xx → install_provider_error as a redirect, nothing written', async () => {
    githubDown = 503;
    const out = await setup(workspaceState(a, origin));
    expect(out.res.status).not.toBe(500);
    expect(out.github).toBe('install_provider_error');
    expect(out.path).toBe(path);
    expect(await adminDb.githubInstallation.count()).toBe(0);
  });

  describe('the organisation branch', () => {
    it('a re-run of the same install → installed, exactly one organisation link', async () => {
      const first = await setup(orgState(a, origin));
      expect(first.github).toBe('installed');
      expect(first.path).toBe(path);
      const second = await setup(orgState(a, origin));
      expect(second.github).toBe('installed');
      expect(second.path).toBe(path);
      expect(await linksOf(a)).toBe(1);
      expect(await reposOf(a)).toEqual(['1', '2', '3']);
    });

    it('an account another organisation uses → select_repos with installation_id, no link', async () => {
      await githubInstallationService.linkInstallationToOrganization({
        workspaceId: a.workspaceId,
        installationId: INSTALLATION,
        repoIds: ['1'],
      });
      const aBefore = await snapshotOf(a);
      const b = await makeOrg('borg');
      await connectIdentity(b.ownerId, 'gho_b');
      userInstallations['gho_b'] = [Number(INSTALLATION)];
      session.userId = b.ownerId;

      const out = await setup(orgState(b, origin));
      expect(out.github).toBe('select_repos');
      expect(out.path).toBe(path);
      expect(out.location.searchParams.get('installation_id')).toBe(INSTALLATION);
      expect(await linksOf(b)).toBe(0);
      expect(await reposOf(b)).toEqual([]);
      expect(await snapshotOf(a)).toEqual(aBefore);
    });

    it('the actor cannot see the installation → installation_not_accessible, nothing written', async () => {
      userInstallations['gho_a'] = [];
      const out = await setup(orgState(a, origin));
      expect(out.github).toBe('installation_not_accessible');
      expect(out.path).toBe(path);
      expect(await adminDb.githubInstallation.count()).toBe(0);
      expect(await linksOf(a)).toBe(0);
    });

    it('a plain member, not an admin → install_forbidden, nothing written', async () => {
      const member = await usersService.createUser({
        email: 'member@example.com',
        password: PASSWORD,
        name: 'Member',
      });
      await adminDb.organizationMembership.create({
        data: { organizationId: a.organizationId, userId: member.id, role: 'member' },
      });
      await adminDb.workspaceMembership.create({
        data: { workspaceId: a.workspaceId, userId: member.id, workspaceRole: 'member' },
      });
      await connectIdentity(member.id, 'gho_member');
      userInstallations['gho_member'] = [Number(INSTALLATION)];
      session.userId = member.id;

      const out = await setup(orgState(a, origin, member.id));
      expect(out.github).toBe('install_forbidden');
      expect(out.path).toBe(path);
      expect(await adminDb.githubInstallation.count()).toBe(0);
      expect(await linksOf(a)).toBe(0);
    });

    it('a repository another organisation owns → repo_unavailable, both organisations untouched', async () => {
      // B owns repository 1 through ANOTHER installation; A's install of 4242
      // would claim it.
      const b = await makeOrg('borg');
      await githubInstallationService.linkInstallationToOrganization({
        workspaceId: b.workspaceId,
        installationId: OTHER_INSTALLATION,
      });
      expect(await reposOf(b)).toEqual(['1', '9']);
      const bBefore = await snapshotOf(b);

      const out = await setup(orgState(a, origin));
      expect(out.github).toBe('repo_unavailable');
      expect(out.path).toBe(path);
      expect(await snapshotOf(a)).toEqual({ installations: [], links: [], repos: [] });
      expect(
        await adminDb.githubInstallation.count({ where: { installationId: INSTALLATION } }),
      ).toBe(0);
      expect(await snapshotOf(b)).toEqual(bBefore);
    });
  });

  it('setup_action=request with a verifying state → pending, not installed, not danger', async () => {
    const out = await setup(workspaceState(a, origin), 'request');
    expect(out.github).not.toBe('installed');
    expect(GITHUB_BANNER_STATUSES).toContain(out.github);
    expect(GITHUB_BANNER_TONE[out.github]).not.toBe('danger');
    expect(out.path).toBe(path);
    expect(await adminDb.githubInstallation.count()).toBe(0);
  });

  it('setup_action=deny with a verifying state → not installed, not danger', async () => {
    const out = await setup(workspaceState(a, origin), 'deny');
    expect(out.github).not.toBe('installed');
    expect(GITHUB_BANNER_STATUSES).toContain(out.github);
    expect(GITHUB_BANNER_TONE[out.github]).not.toBe('danger');
    expect(out.path).toBe(path);
    expect(await adminDb.githubInstallation.count()).toBe(0);
  });

  // MOTIR-8471's contract: the signature verified, so the target is honoured
  // even though the TTL refuses the binding.
  it('an EXPIRED state → install_expired (not install_error) at its origin, nothing bound', async () => {
    const expired = encodeInstallState(
      { workspaceId: a.workspaceId, userId: a.ownerId, origin },
      Math.floor(Date.now() / 1000) - 1000,
    );
    const out = await setup(expired);
    expect(out.github).toBe('install_expired');
    expect(out.github).not.toBe('install_error');
    expect(GITHUB_BANNER_TONE[out.github]).not.toBe('danger');
    expect(out.path).toBe(path);
    expect(await adminDb.githubInstallation.count()).toBe(0);
  });

  it('a verified state with no installation_id → install_error at its origin', async () => {
    const out = await setup(workspaceState(a, origin), 'install', null);
    expect(out.github).toBe('install_error');
    expect(out.path).toBe(path);
    expect(await adminDb.githubInstallation.count()).toBe(0);
  });
});

describe('the real onboarding mint feeds the callback', () => {
  it("installUrlForOnboardingConnect's state binds and returns to the connect step", async () => {
    const url = await githubInstallationService.installUrlForOnboardingConnect({
      workspaceId: a.workspaceId,
      actorUserId: a.ownerId,
    });
    const state = new URL(url!).searchParams.get('state')!;
    const out = await setup(state);
    expect(out.github).toBe('installed');
    expect(out.path).toBe(ONBOARDING_PATH);
    expect(await installationRowsFor(a.workspaceId)).toBe(1);
  });
});

describe('the owner-approval request and the deny, with no state', () => {
  it.each(['request', 'deny'])(
    'setup_action=%s → not installed, not danger, at DEFAULT_RETURN_PATH, nothing written',
    async (action) => {
      const out = await setup(undefined, action);
      expect(out.github).not.toBe('installed');
      expect(GITHUB_BANNER_STATUSES).toContain(out.github);
      expect(GITHUB_BANNER_TONE[out.github]).not.toBe('danger');
      expect(out.path).toBe(DEFAULT_RETURN_PATH);
      expect(await adminDb.githubInstallation.count()).toBe(0);
    },
  );
});

describe('the origin is not recoverable — the fallback is DEFAULT_RETURN_PATH', () => {
  it('no state, setup_action=update → repos_updated (MOTIR-3755)', async () => {
    const out = await setup(undefined, 'update');
    expect(out.github).toBe('repos_updated');
    expect(out.path).toBe(DEFAULT_RETURN_PATH);
  });

  it('no state, setup_action=install → install_unbound, nothing written', async () => {
    const out = await setup(undefined, 'install');
    expect(out.github).toBe('install_unbound');
    expect(out.path).toBe(DEFAULT_RETURN_PATH);
    expect(await adminDb.githubInstallation.count()).toBe(0);
  });

  it('an expired state that names no origin → install_expired at DEFAULT_RETURN_PATH', async () => {
    const expired = encodeInstallState(
      { workspaceId: a.workspaceId, userId: a.ownerId },
      Math.floor(Date.now() / 1000) - 1000,
    );
    const out = await setup(expired);
    expect(out.github).toBe('install_expired');
    expect(GITHUB_BANNER_TONE[out.github]).not.toBe('danger');
    expect(out.path).toBe(DEFAULT_RETURN_PATH);
  });

  it('a tampered state (forged onboarding payload under a valid signature) → install_error, nothing written', async () => {
    const genuine = workspaceState(a, 'organizationGit');
    const signature = genuine.slice(genuine.lastIndexOf('.') + 1);
    const stranger = await makeOrg('stranger');
    const forged = Buffer.from(
      JSON.stringify({
        w: stranger.workspaceId,
        u: a.ownerId,
        exp: Math.floor(Date.now() / 1000) + 600,
        o: 'onboardingMigrateConnect',
      }),
    ).toString('base64url');
    const out = await setup(`${forged}.${signature}`);
    expect(out.github).toBe('install_error');
    expect(out.path).toBe(DEFAULT_RETURN_PATH);
    expect(await adminDb.githubInstallation.count()).toBe(0);
  });

  it('a verified state minted for a different user → install_error, nothing written', async () => {
    const other = await makeOrg('other');
    const out = await setup(workspaceState(a, 'onboardingMigrateConnect', other.ownerId));
    expect(out.github).toBe('install_error');
    expect(out.path).toBe(DEFAULT_RETURN_PATH);
    expect(await adminDb.githubInstallation.count()).toBe(0);
  });

  it('a verified state for another user, with no installation_id → install_error at DEFAULT_RETURN_PATH', async () => {
    const other = await makeOrg('other');
    const out = await setup(
      workspaceState(a, 'onboardingMigrateConnect', other.ownerId),
      'install',
      null,
    );
    expect(out.github).toBe('install_error');
    expect(out.path).toBe(DEFAULT_RETURN_PATH);
  });
});

describe('the run survives the detours that reach the callback with no session', () => {
  /** Follow a detour's `next` back into the callback, as the browser would. */
  function nextOf(location: URL): URL {
    const next = location.searchParams.get('next')!;
    expect(next.startsWith('/api/github/setup?')).toBe(true);
    return new URL(next, 'http://localhost:3000');
  }

  function expectCarried(next: URL, state: string): void {
    expect(next.pathname).toBe('/api/github/setup');
    expect(next.searchParams.get('installation_id')).toBe(INSTALLATION);
    expect(next.searchParams.get('setup_action')).toBe('install');
    expect(next.searchParams.get('state')).toBe(state);
    // The origin travelled INSIDE the state, not beside it.
    const decoded = decodeInstallStateResult(next.searchParams.get('state')!);
    expect(decoded.ok && decoded.state.origin).toBe('onboardingMigrateConnect');
  }

  it('no session → /sign-in?next=<the callback>, and the install binds afterwards', async () => {
    const state = workspaceState(a, 'onboardingMigrateConnect');
    session.userId = null;
    const detour = await setup(state);
    expect(detour.path).toBe('/sign-in');
    const next = nextOf(detour.location);
    expectCarried(next, state);
    expect(await adminDb.githubInstallation.count()).toBe(0);

    session.userId = a.ownerId;
    const out = await callSetup(next.href);
    expect(out.github).toBe('installed');
    expect(out.path).toBe(ONBOARDING_PATH);
    expect(await installationRowsFor(a.workspaceId)).toBe(1);
  });

  it('the 2FA hold → its enrolAt with next=<the callback>, and the install binds afterwards', async () => {
    const state = workspaceState(a, 'onboardingMigrateConnect');
    twoFactor.hold = {
      code: 'TWO_FACTOR_REQUIRED',
      tier: 'organization',
      tierName: 'aorg',
      enrolAt: '/two-factor-required',
    };
    const detour = await setup(state);
    expect(detour.path).toBe('/two-factor-required');
    const next = nextOf(detour.location);
    expectCarried(next, state);
    expect(await adminDb.githubInstallation.count()).toBe(0);

    twoFactor.hold = null;
    const out = await callSetup(next.href);
    expect(out.github).toBe('installed');
    expect(out.path).toBe(ONBOARDING_PATH);
    expect(await installationRowsFor(a.workspaceId)).toBe(1);
  });
});

// ── An already-installed account, picked from onboarding (MOTIR-8760) ─────────
//
// The onboarding connect step mints a WORKSPACE-binding state (no `g`), so a
// pick of an account another organisation already uses reaches the callback's
// workspace branch — not the org branch the `select_repos` case above drives.
// `bindInstallationForWorkspace` refuses with `RepoSelectionRequiredError`, and
// the route answers `select_repos` at the state's origin with the installation
// named: the redirect the connect step's repository picker opens on. Pinned
// here, against the datastore, because the defect that matters is a
// `select_repos` that ALSO wrote a row.
describe('onboarding picks an account another organisation already uses', () => {
  let b: Org;

  /** A already links INSTALLATION with repository 1; B's owner can see it. */
  async function shareInstallation(): Promise<Awaited<ReturnType<typeof snapshotOf>>> {
    await githubInstallationService.linkInstallationToOrganization({
      workspaceId: a.workspaceId,
      installationId: INSTALLATION,
      repoIds: ['1'],
    });
    const aBefore = await snapshotOf(a);
    b = await makeOrg('borg');
    await connectIdentity(b.ownerId, 'gho_b');
    userInstallations['gho_b'] = [Number(INSTALLATION)];
    session.userId = b.ownerId;
    return aBefore;
  }

  it('the workspace branch → select_repos at /onboarding/migrate with installation_id, nothing written for B', async () => {
    const aBefore = await shareInstallation();
    const out = await setup(workspaceState(b, 'onboardingMigrateConnect'));
    expect(out.github).toBe('select_repos');
    expect(out.path).toBe(ONBOARDING_PATH);
    expect(out.location.searchParams.get('installation_id')).toBe(INSTALLATION);
    expect(await linksOf(b)).toBe(0);
    expect(await reposOf(b)).toEqual([]);
    expect(await installationRowsFor(b.workspaceId)).toBe(0);
    expect(await snapshotOf(a)).toEqual(aBefore);
  });

  it("the step's own context rides ahead of github=select_repos, so the wizard reopens as left", async () => {
    const aBefore = await shareInstallation();
    const state = encodeInstallState({
      workspaceId: b.workspaceId,
      userId: b.ownerId,
      origin: 'onboardingMigrateConnect',
      context: {
        via: 'onboard_existing_project',
        steps: 'connect,index',
        backKind: 'work-item',
        backItem: 'MOTIR-12',
      },
    });
    const out = await setup(state);
    expect(out.github).toBe('select_repos');
    expect(out.path).toBe(ONBOARDING_PATH);
    expect(out.location.searchParams.get('via')).toBe('onboard_existing_project');
    expect(out.location.searchParams.get('steps')).toBe('connect,index');
    expect(out.location.searchParams.get('backItem')).toBe('MOTIR-12');
    const search = out.location.search;
    expect(search.indexOf('via=')).toBeGreaterThanOrEqual(0);
    expect(search.indexOf('via=')).toBeLessThan(search.indexOf('github=select_repos'));
    expect(out.location.searchParams.get('installation_id')).toBe(INSTALLATION);
    expect(await linksOf(b)).toBe(0);
    expect(await reposOf(b)).toEqual([]);
    expect(await snapshotOf(a)).toEqual(aBefore);
  });

  it('an EXPIRED onboarding state → install_expired at /onboarding/migrate, nothing bound', async () => {
    const aBefore = await shareInstallation();
    const expired = encodeInstallState(
      { workspaceId: b.workspaceId, userId: b.ownerId, origin: 'onboardingMigrateConnect' },
      Math.floor(Date.now() / 1000) - 1000,
    );
    const out = await setup(expired);
    expect(out.github).toBe('install_expired');
    expect(out.path).toBe(ONBOARDING_PATH);
    expect(await linksOf(b)).toBe(0);
    expect(await reposOf(b)).toEqual([]);
    expect(await snapshotOf(a)).toEqual(aBefore);
  });

  it('a plain member, not an organisation admin → still select_repos at /onboarding/migrate', async () => {
    const aBefore = await shareInstallation();
    const member = await usersService.createUser({
      email: 'bmember@example.com',
      password: PASSWORD,
      name: 'Member',
    });
    await adminDb.organizationMembership.create({
      data: { organizationId: b.organizationId, userId: member.id, role: 'member' },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: b.workspaceId, userId: member.id, workspaceRole: 'member' },
    });
    await connectIdentity(member.id, 'gho_bmember');
    userInstallations['gho_bmember'] = [Number(INSTALLATION)];
    session.userId = member.id;

    const out = await setup(workspaceState(b, 'onboardingMigrateConnect', member.id));
    expect(out.github).toBe('select_repos');
    expect(out.path).toBe(ONBOARDING_PATH);
    expect(out.location.searchParams.get('installation_id')).toBe(INSTALLATION);
    expect(await linksOf(b)).toBe(0);
    expect(await reposOf(b)).toEqual([]);
    expect(await snapshotOf(a)).toEqual(aBefore);
  });

  it('the state the onboarding mint signs carries no organisation', async () => {
    const url = await githubInstallationService.installUrlForOnboardingConnect({
      workspaceId: a.workspaceId,
      actorUserId: a.ownerId,
      context: { via: 'onboard_existing_project', steps: 'connect,index' },
    });
    const decoded = decodeInstallStateResult(new URL(url!).searchParams.get('state')!);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.state.origin).toBe('onboardingMigrateConnect');
    expect(decoded.state.organizationId).toBeUndefined();
    expect(decoded.state.workspaceId).toBe(a.workspaceId);
  });
});
