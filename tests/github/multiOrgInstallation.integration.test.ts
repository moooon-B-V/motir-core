import { generateKeyPairSync } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubAccountDisconnectService } from '@/lib/services/githubAccountDisconnectService';
import { codeGraphOffboardingService } from '@/lib/services/codeGraphOffboardingService';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import {
  InstallationNotLinkedError,
  RepositoryOwnedByOtherOrganizationError,
} from '@/lib/github/errors';
import { encryptToken } from '@/lib/github/tokenCrypto';
import { encodeInstallState } from '@/lib/github/installState';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { dispatchedEvents, spyOnJobDispatch } from '../helpers/jobs';
import { linkWorkspaceReposToProject } from '../helpers/projectRepoLink';

// ONE GITHUB ACCOUNT, TWO ORGANISATIONS — the story as ONE scenario (Story
// MOTIR-8216 · MOTIR-8224), against a real Postgres, through the shipped
// services and route handlers. Every card under the story tests its own unit;
// this spec asserts the SEAMS: the rows the connect flow writes are the rows
// the webhooks route on, what a disconnect leaves is what an uninstall
// removes, and the legacy tenancy columns, the link table and the per-org
// repository rows agree throughout.
//
// One installation (4242, account `acme`) shows repositories A..E (ids 1..5).
// Org X links A, B; org Y links C, D, E — both through
// `linkExistingInstallation`, the entrance the picker and the setup route
// share. Only GitHub (at `fetch`) and the session gate are faked.

const PASSWORD = 'hunter2hunter2';
const SECRET = 'test-better-auth-secret-abcdef0123456789';
const INSTALLATION = '4242';
const NAMES: Record<number, string> = { 1: 'a', 2: 'b', 3: 'c', 4: 'd', 5: 'e', 6: 'f' };

const session: { userId: string | null } = { userId: null };
const workspace: { id: string | null } = { id: null };

vi.mock('@/lib/auth/requireCompliantSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/requireCompliantSession')>()),
  requireCompliantSession: async () =>
    session.userId
      ? { ok: true, session: { user: { id: session.userId } } }
      : { ok: false, response: NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 }) },
  requireCompliantWorkspaceContext: async () =>
    session.userId && workspace.id
      ? { ok: true, ctx: { userId: session.userId, workspaceId: workspace.id } }
      : { ok: false, response: NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 }) },
  resolveTwoFactorHold: async () => null,
}));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => (session.userId ? { user: { id: session.userId } } : null),
}));
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () =>
    session.userId && workspace.id ? { userId: session.userId, workspaceId: workspace.id } : null,
}));

const accountsRoute = await import('@/app/api/organizations/[orgId]/github/accounts/route');
const reposRoute =
  await import('@/app/api/organizations/[orgId]/github/accounts/[installationId]/repositories/route');
const installationsRoute =
  await import('@/app/api/organizations/[orgId]/github/installations/route');
const disconnectRoute =
  await import('@/app/api/organization/github/accounts/[installationId]/route');
const setupRoute = await import('@/app/api/github/setup/route');

/** What GitHub shows the App on installation 4242. */
let visible: number[] = [];
/** The installations each user token can see on GitHub. */
let userInstallations: Record<string, number[]> = {};

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
      if (url.includes('/user/installations')) {
        const token = (new Headers(init?.headers).get('authorization') ?? '').replace(
          /^Bearer /,
          '',
        );
        return json({
          installations: (userInstallations[token] ?? []).map((id) => ({
            id,
            app_id: 999,
            repository_selection: 'selected',
            account: { login: 'acme', type: 'Organization', avatar_url: null },
          })),
        });
      }
      if (url.includes('/access_tokens')) {
        return json({
          token: 'ghs_app',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (url.includes('/installation/repositories')) {
        return json({
          repositories: visible.map((id) => ({
            id,
            name: NAMES[id],
            owner: { login: 'acme' },
            default_branch: 'main',
          })),
        });
      }
      if (url.includes('/app/installations/')) {
        return json({ id: 42, account: { login: 'acme', type: 'Organization' } });
      }
      // Best-effort reads a delivery makes (changed files, check sets).
      return json({ message: 'Not Found' }, 404);
    }),
  );
}

interface Org {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
  projectId: string;
}

async function makeOrg(slug: string): Promise<Org> {
  const user = await usersService.createUser({
    email: `${slug}@example.com`,
    password: PASSWORD,
    name: 'Owner',
  });
  const { workspace: ws } = await workspacesService.createWorkspace({
    name: slug,
    ownerUserId: user.id,
  });
  const row = await adminDb.workspace.findUniqueOrThrow({ where: { id: ws.id } });
  const project = await projectsService.createProject({
    workspaceId: ws.id,
    actorUserId: user.id,
    name: `P ${slug}`,
    identifier: slug.toUpperCase(),
  });
  await adminDb.githubIdentity.create({
    data: {
      userId: user.id,
      githubUserId: `gh-${user.id}`,
      githubLogin: `login-${slug}`,
      accessTokenEncrypted: encryptToken(`gho_${slug}`),
    },
  });
  userInstallations[`gho_${slug}`] = [Number(INSTALLATION)];
  return {
    organizationId: row.organizationId,
    workspaceId: ws.id,
    ownerId: user.id,
    projectId: project.id,
  };
}

async function link(org: Org, repoIds: string[]): Promise<void> {
  await githubInstallationService.linkExistingInstallation({
    organizationId: org.organizationId,
    actorUserId: org.ownerId,
    installationId: INSTALLATION,
    repoIds,
    via: 'picker',
    workspaceIdHint: org.workspaceId,
  });
  await linkWorkspaceReposToProject({
    workspaceId: org.workspaceId,
    projectId: org.projectId,
    names: repoIds.map((id) => NAMES[Number(id)]!),
  });
}

function signIn(org: Org, userId = org.ownerId): void {
  session.userId = userId;
  workspace.id = org.workspaceId;
}

const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

async function ownedBy(org: Org): Promise<string[]> {
  const rows = await adminDb.githubRepo.findMany({
    where: { organizationId: org.organizationId },
    orderBy: { repoId: 'asc' },
  });
  return rows.map((r) => r.repoId);
}

/** Everything of X's the story promises Y never touches. */
async function snapshotOf(org: Org) {
  return {
    links: await adminDb.githubInstallationOrgLink.findMany({
      where: { organizationId: org.organizationId },
    }),
    repos: await adminDb.githubRepo.findMany({
      where: { organizationId: org.organizationId },
      orderBy: { repoId: 'asc' },
    }),
    projectRepos: await adminDb.projectRepo.findMany({
      where: { projectId: org.projectId },
      orderBy: { name: 'asc' },
    }),
  };
}

let x: Org;
let y: Org;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.githubInstallation.deleteMany({});
  _resetInstallationTokenCache();
  vi.stubEnv('BETTER_AUTH_SECRET', SECRET);
  visible = [1, 2, 3, 4, 5];
  userInstallations = {};
  stubGithub();
  spyOnJobDispatch();
  x = await makeOrg('xorg');
  y = await makeOrg('yorg');
  await link(x, ['1', '2']);
  await link(y, ['3', '4', '5']);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  session.userId = null;
  workspace.id = null;
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('one GitHub account linked to two organisations', () => {
  it('1 · both linked: disjoint repositories, two links, one installation still stamped with X', async () => {
    expect(await ownedBy(x)).toEqual(['1', '2']);
    expect(await ownedBy(y)).toEqual(['3', '4', '5']);
    expect(await adminDb.githubInstallation.count()).toBe(1);
    expect(await adminDb.githubInstallationOrgLink.count()).toBe(2);
    const installation = await adminDb.githubInstallation.findFirstOrThrow();
    expect(installation).toMatchObject({
      workspaceId: x.workspaceId,
      organizationId: x.organizationId,
    });
  });

  it('2 · each organisation lists only its own, and Y’s listing names nothing of X', async () => {
    signIn(y);
    const accounts = await (
      await accountsRoute.GET(new Request('http://l/x'), params({ orgId: y.organizationId }))
    ).json();
    expect(accounts.accounts).toEqual([
      expect.objectContaining({ installationId: INSTALLATION, linkState: 'linked_here' }),
    ]);
    const res = await reposRoute.GET(
      new Request('http://l/x'),
      params({ orgId: y.organizationId, installationId: INSTALLATION }),
    );
    const body = await res.json();
    const byId = Object.fromEntries(
      (body.repos as { repoId: string; availability: string }[]).map((r) => [
        r.repoId,
        r.availability,
      ]),
    );
    expect(byId).toEqual({
      '1': 'connected_elsewhere',
      '2': 'connected_elsewhere',
      '3': 'connected_here',
      '4': 'connected_here',
      '5': 'connected_here',
    });
    const serialised = JSON.stringify(body);
    for (const id of [x.organizationId, x.workspaceId, x.projectId]) {
      expect(serialised).not.toContain(id);
    }

    const xInstallations = await githubInstallationService.listOrganizationInstallations({
      userId: x.ownerId,
      workspaceId: x.workspaceId,
    });
    expect(xInstallations.flatMap((i) => i.repos.map((r) => r.repoId)).sort()).toEqual(['1', '2']);

    // Y's Git room lists the SAME account, with only Y's repositories on it — the
    // installation row is stamped with X, so a read keyed on the stamp showed Y
    // no account at all (MOTIR-8223).
    const yInstallations = await githubInstallationService.listOrganizationInstallations({
      userId: y.ownerId,
      workspaceId: y.workspaceId,
    });
    expect(yInstallations.map((i) => i.installationId)).toEqual([INSTALLATION]);
    expect(yInstallations.flatMap((i) => i.repos.map((r) => r.repoId)).sort()).toEqual([
      '3',
      '4',
      '5',
    ]);
  });

  it('3 · X is byte-identical before and after Y links', async () => {
    await githubAccountDisconnectService.disconnectAccountFromOrganization({
      userId: y.ownerId,
      workspaceId: y.workspaceId,
      installationId: INSTALLATION,
    });
    const before = await snapshotOf(x);
    // Y's project rows outlived the disconnect, so only the link is re-made.
    await githubInstallationService.linkExistingInstallation({
      organizationId: y.organizationId,
      actorUserId: y.ownerId,
      installationId: INSTALLATION,
      repoIds: ['3', '4', '5'],
      via: 'picker',
      workspaceIdHint: y.workspaceId,
    });
    expect(await snapshotOf(x)).toEqual(before);
  });

  it('4 · a claim of A is refused by the service and by HTTP, all-or-nothing', async () => {
    const before = { x: await snapshotOf(x), y: await snapshotOf(y) };

    await expect(
      githubInstallationService.linkExistingInstallation({
        organizationId: y.organizationId,
        actorUserId: y.ownerId,
        installationId: INSTALLATION,
        repoIds: ['1'],
        via: 'picker',
      }),
    ).rejects.toBeInstanceOf(RepositoryOwnedByOtherOrganizationError);

    signIn(y);
    const res = await installationsRoute.POST(
      new Request('http://l/x', {
        method: 'POST',
        body: JSON.stringify({ installationId: INSTALLATION, repoIds: ['3', '1'] }),
      }),
      params({ orgId: y.organizationId }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('repository_owned_by_other_organization');
    expect(body.repos.map((r: { repoId: string }) => r.repoId)).toEqual(['1']);

    expect({ x: await snapshotOf(x), y: await snapshotOf(y) }).toEqual(before);
  });

  it('5 · the database refuses A under Y when the service is bypassed', async () => {
    const installation = await adminDb.githubInstallation.findFirstOrThrow();
    await expect(
      adminDb.githubRepo.create({
        data: {
          installationId: installation.id,
          workspaceId: y.workspaceId,
          organizationId: y.organizationId,
          repoId: '1',
          owner: 'acme',
          name: 'a-forced',
          defaultBranch: 'main',
          archived: false,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('6 · two organisations racing for one free repository end with one owner', async () => {
    visible = [1, 2, 3, 4, 5, 6];
    const z = await makeOrg('zorg');
    const results = await Promise.allSettled([
      githubInstallationService.linkExistingInstallation({
        organizationId: x.organizationId,
        actorUserId: x.ownerId,
        installationId: INSTALLATION,
        repoIds: ['1', '2', '6'],
        via: 'picker',
      }),
      githubInstallationService.linkExistingInstallation({
        organizationId: z.organizationId,
        actorUserId: z.ownerId,
        installationId: INSTALLATION,
        repoIds: ['6'],
        via: 'picker',
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(RepositoryOwnedByOtherOrganizationError);
    expect(await adminDb.githubRepo.count({ where: { repoId: '6' } })).toBe(1);
  });

  it('7 · push, pull_request and check_run for C touch only Y; an unowned repo is unknown_repo', async () => {
    const before = await snapshotOf(x);
    const sendSpy = spyOnJobDispatch();
    sendSpy.mockClear();

    expect(
      await githubWebhookService.handleEvent('push', {
        ref: 'refs/heads/main',
        after: 'c'.repeat(40),
        repository: { id: 3 },
        installation: { id: INSTALLATION },
      }),
    ).toEqual({ event: 'push', outcome: 'refresh_enqueued' });
    await githubWebhookService.handleEvent('pull_request', {
      action: 'opened',
      installation: { id: INSTALLATION },
      repository: { id: 3 },
      pull_request: {
        number: 31,
        state: 'open',
        merged: false,
        merged_at: null,
        title: 'A change',
        head: { ref: 'feature/c', sha: 'sha-c' },
        base: { ref: 'main' },
        user: { id: 4242 },
      },
    });
    expect(
      await githubWebhookService.handleEvent('check_run', {
        action: 'completed',
        installation: { id: INSTALLATION },
        repository: { id: 3 },
        check_run: {
          head_sha: 'sha-c',
          status: 'completed',
          conclusion: 'success',
          name: 'build',
          check_suite: { head_branch: 'feature/c' },
          pull_requests: [{ number: 31 }],
        },
      }),
    ).not.toMatchObject({ outcome: 'unknown_repo' });

    const xWorkspaceEvents = dispatchedEvents(sendSpy).filter((e) =>
      JSON.stringify(e.data).includes(x.workspaceId),
    );
    expect(xWorkspaceEvents).toEqual([]);
    const prs = await adminDb.githubPullRequest.findMany({ include: { repo: true } });
    expect(prs.map((p) => p.repo.organizationId)).toEqual([y.organizationId]);
    expect(await snapshotOf(x)).toEqual(before);

    expect(
      await githubWebhookService.handleEvent('push', {
        ref: 'refs/heads/main',
        after: 'f'.repeat(40),
        repository: { id: 999 },
        installation: { id: INSTALLATION },
      }),
    ).toEqual({ event: 'push', outcome: 'unknown_repo' });
  });

  it('8 · installation_repositories releases B from X only and claims a new F for nobody', async () => {
    const yBefore = await snapshotOf(y);
    visible = [1, 3, 4, 5, 6];

    await githubWebhookService.handleEvent('installation_repositories', {
      action: 'removed',
      installation: { id: INSTALLATION, account: { login: 'acme', type: 'Organization' } },
    });

    expect(await ownedBy(x)).toEqual(['1']);
    // The reconcile refreshes Y's rows (updatedAt) but changes nothing else.
    const stable = (rows: { updatedAt: Date }[]) => rows.map(({ updatedAt: _u, ...rest }) => rest);
    expect(stable((await snapshotOf(y)).repos)).toEqual(stable(yBefore.repos));
    expect(await adminDb.githubRepo.count({ where: { repoId: '6' } })).toBe(0);
  });

  it('9 · disconnecting Y leaves X working; a second disconnect is not linked', async () => {
    const before = await snapshotOf(x);
    const offboard = vi.spyOn(codeGraphOffboardingService, 'enqueueQuietly');

    const result = await githubAccountDisconnectService.disconnectAccountFromOrganization({
      userId: y.ownerId,
      workspaceId: y.workspaceId,
      installationId: INSTALLATION,
    });

    expect(result.installationRemoved).toBe(false);
    expect(await ownedBy(y)).toEqual([]);
    expect(await snapshotOf(x)).toEqual(before);
    expect(await adminDb.githubInstallation.findFirstOrThrow()).toMatchObject({
      organizationId: x.organizationId,
    });
    expect(offboard.mock.calls.map(([input]) => input.coreWorkspaceId)).toEqual([y.workspaceId]);
    await expect(
      githubAccountDisconnectService.disconnectAccountFromOrganization({
        userId: y.ownerId,
        workspaceId: y.workspaceId,
        installationId: INSTALLATION,
      }),
    ).rejects.toBeInstanceOf(InstallationNotLinkedError);

    // X's deliveries still land: the installation, link and repos it relies on
    // are intact.
    expect(
      await githubWebhookService.handleEvent('push', {
        ref: 'refs/heads/main',
        after: 'a'.repeat(40),
        repository: { id: 1 },
        installation: { id: INSTALLATION },
      }),
    ).toEqual({ event: 'push', outcome: 'refresh_enqueued' });
  });

  it('10 · disconnecting X (the stamped organisation) moves the tenancy to Y', async () => {
    await githubAccountDisconnectService.disconnectAccountFromOrganization({
      userId: x.ownerId,
      workspaceId: x.workspaceId,
      installationId: INSTALLATION,
    });

    expect(await adminDb.githubInstallation.findFirstOrThrow()).toMatchObject({
      workspaceId: y.workspaceId,
      organizationId: y.organizationId,
    });
    expect(
      await withSystemContext((tx) =>
        githubInstallationRepository.findByWorkspaceId(x.workspaceId, tx),
      ),
    ).toBeNull();
    expect(await ownedBy(y)).toEqual(['3', '4', '5']);
    expect(
      await githubWebhookService.handleEvent('push', {
        ref: 'refs/heads/main',
        after: 'd'.repeat(40),
        repository: { id: 4 },
        installation: { id: INSTALLATION },
      }),
    ).toEqual({ event: 'push', outcome: 'refresh_enqueued' });
  });

  it('11 · an uninstall removes every organisation, offboarding each under its own workspace', async () => {
    const offboard = vi.spyOn(codeGraphOffboardingService, 'enqueueForRepos');
    const deleted = {
      action: 'deleted',
      installation: { id: INSTALLATION, account: { login: 'acme', type: 'Organization' } },
    };

    await githubWebhookService.handleEvent('installation', deleted);

    expect(await adminDb.githubInstallation.count()).toBe(0);
    expect(await adminDb.githubInstallationOrgLink.count()).toBe(0);
    expect(await adminDb.githubRepo.count()).toBe(0);
    expect(offboard.mock.calls.map(([ws]) => ws).sort()).toEqual(
      [x.workspaceId, y.workspaceId].sort(),
    );

    offboard.mockClear();
    await githubWebhookService.handleEvent('installation', deleted);
    expect(offboard).not.toHaveBeenCalled();
  });

  it('12 · a re-install refreshes in place; a new organisation beside two is sent to choose', async () => {
    const state = (org: Org) =>
      encodeInstallState({
        workspaceId: org.workspaceId,
        userId: org.ownerId,
        organizationId: org.organizationId,
        origin: 'organizationGit',
      });
    const setup = async (org: Org) => {
      signIn(org);
      const res = await setupRoute.GET(
        new NextRequest(
          `http://localhost:3000/api/github/setup?installation_id=${INSTALLATION}&setup_action=install&state=${encodeURIComponent(state(org))}`,
        ),
      );
      return new URL(res.headers.get('location')!).searchParams.get('github');
    };

    expect(await setup(y)).toBe('installed');
    expect(await setup(y)).toBe('installed');
    expect(
      await adminDb.githubInstallationOrgLink.count({
        where: { organizationId: y.organizationId },
      }),
    ).toBe(1);
    expect(await ownedBy(y)).toEqual(['3', '4', '5']);

    const z = await makeOrg('zorg');
    expect(await setup(z)).toBe('select_repos');
    expect(await ownedBy(z)).toEqual([]);
    expect(
      await adminDb.githubInstallationOrgLink.count({
        where: { organizationId: z.organizationId },
      }),
    ).toBe(0);
  });

  it('13 · the shared provisioning installation appears in no list and is never reconciled', async () => {
    const shared = await adminDb.githubInstallation.create({
      data: {
        installationId: 'motir-provisioning-story',
        workspaceId: null,
        organizationId: null,
        accountLogin: 'motir-projects',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    await adminDb.githubRepo.create({
      data: {
        installationId: shared.id,
        workspaceId: x.workspaceId,
        organizationId: x.organizationId,
        repoId: '777',
        owner: 'motir-projects',
        name: 'hosted',
        defaultBranch: 'main',
        archived: false,
      },
    });
    userInstallations['gho_xorg'] = [Number(INSTALLATION), 777];

    for (const org of [x, y]) {
      signIn(org);
      const accounts = await (
        await accountsRoute.GET(new Request('http://l/x'), params({ orgId: org.organizationId }))
      ).json();
      expect(JSON.stringify(accounts)).not.toContain('motir-projects');
    }
    const before = await adminDb.githubRepo.count();
    expect(
      await githubWebhookService.handleEvent('installation_repositories', {
        action: 'added',
        installation: { id: 'motir-provisioning-story' },
      }),
    ).toEqual({ event: 'installation_repositories', outcome: 'skipped_shared_installation' });
    expect(await adminDb.githubRepo.count()).toBe(before);
  });

  it('14 · a plain member is refused at every seam, and an inaccessible installation is a 403', async () => {
    const member = await usersService.createUser({
      email: 'member-story@example.com',
      password: PASSWORD,
      name: 'Member',
    });
    await adminDb.organizationMembership.create({
      data: { organizationId: y.organizationId, userId: member.id, role: 'member' },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: y.workspaceId, userId: member.id, workspaceRole: 'member' },
    });
    signIn(y, member.id);

    const post = await installationsRoute.POST(
      new Request('http://l/x', {
        method: 'POST',
        body: JSON.stringify({ installationId: INSTALLATION, repoIds: ['3'] }),
      }),
      params({ orgId: y.organizationId }),
    );
    expect(post.status).toBe(403);
    const disconnect = await disconnectRoute.DELETE(
      new Request('http://l/x', { method: 'DELETE' }),
      params({ installationId: INSTALLATION }),
    );
    expect(disconnect.status).toBe(403);
    const memberState = encodeInstallState({
      workspaceId: y.workspaceId,
      userId: member.id,
      organizationId: y.organizationId,
    });
    const setupRes = await setupRoute.GET(
      new NextRequest(
        `http://localhost:3000/api/github/setup?installation_id=${INSTALLATION}&setup_action=install&state=${encodeURIComponent(memberState)}`,
      ),
    );
    expect(new URL(setupRes.headers.get('location')!).searchParams.get('github')).toBe(
      'install_forbidden',
    );
    expect(await ownedBy(y)).toEqual(['3', '4', '5']);

    // An admin of Y with a valid session cannot link an installation GitHub
    // says they cannot see.
    userInstallations['gho_yorg'] = [];
    signIn(y);
    const refused = await installationsRoute.POST(
      new Request('http://l/x', {
        method: 'POST',
        body: JSON.stringify({ installationId: INSTALLATION, repoIds: ['3'] }),
      }),
      params({ orgId: y.organizationId }),
    );
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe('installation_not_accessible');
  });
});
