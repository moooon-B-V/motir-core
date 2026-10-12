import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { codeGraphOffboardingService } from '@/lib/services/codeGraphOffboardingService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { dispatchedEvents, spyOnJobDispatch } from '../helpers/jobs';

// WEBHOOKS ON A SHARED INSTALLATION — Story MOTIR-8216 · MOTIR-8221, against a
// real Postgres. One GitHub installation (`inst-shared`, account `acme`) is
// linked to two organisations: X owns repositories 1 and 2 (a, b), Y owns 3, 4
// and 5 (c, d, e). Every delivery must land on the organisation that owns the
// repository it names, and an uninstall must take both down.
//
// The audit the card asks for — no per-repo webhook path reads its tenant from
// the INSTALLATION row — was a `git grep -nE "installation\??\.(workspaceId|
// organizationId)|existing\.workspaceId" -- lib app`. Its only webhook hit was
// `reconcileInstallation`, rewritten here; `handlePush`,
// `resolveGithubCiContext` and the status sync were already repo-keyed
// (`repo.workspaceId`, MOTIR-1931), which the push / pull_request / check_run
// cases below pin.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION = 'inst-shared';
const ACCOUNT = { login: 'acme', type: 'Organization' };

/** What GitHub currently shows the App on the installation. */
let visible: { id: number; name: string }[] = [];

function stubGithub(): void {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  const json = (o: unknown, status = 200): Response =>
    new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/access_tokens')) {
        return json({
          token: 'ghs_hooks',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (url.includes('/installation/repositories')) {
        return json({
          repositories: visible.map((r) => ({
            id: r.id,
            name: r.name,
            owner: { login: 'acme' },
            default_branch: 'main',
          })),
        });
      }
      if (url.includes('/app/installations/')) {
        return json({ id: 42, account: ACCOUNT });
      }
      // Anything a delivery reads besides the grant (changed files, check sets)
      // is best-effort in the service; answer it as GitHub would for a stranger.
      return json({ message: 'Not Found' }, 404);
    }),
  );
}

interface Org {
  workspaceId: string;
  organizationId: string;
}

async function makeOrg(email: string): Promise<Org> {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: email,
    ownerUserId: user.id,
  });
  const row = await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
  return { workspaceId: workspace.id, organizationId: row.organizationId };
}

async function ownedBy(org: Org): Promise<string[]> {
  const rows = await adminDb.githubRepo.findMany({
    where: { organizationId: org.organizationId },
    orderBy: { repoId: 'asc' },
  });
  return rows.map((r) => r.repoId);
}

/** X owns a, b; Y owns c, d, e — all on ONE installation. */
async function twoOrgs(): Promise<{ x: Org; y: Org }> {
  const x = await makeOrg('hooks-x@example.com');
  const y = await makeOrg('hooks-y@example.com');
  await githubInstallationService.linkInstallationToOrganization({
    workspaceId: x.workspaceId,
    installationId: INSTALLATION,
    repoIds: ['1', '2'],
  });
  await githubInstallationService.linkInstallationToOrganization({
    workspaceId: y.workspaceId,
    installationId: INSTALLATION,
    repoIds: ['3', '4', '5'],
  });
  return { x, y };
}

const installationRepositories = (): Record<string, unknown> => ({
  action: 'added',
  installation: { id: INSTALLATION, account: ACCOUNT },
});

function pullRequest(number: number, repoId: number): Record<string, unknown> {
  return {
    action: 'opened',
    installation: { id: INSTALLATION, account: ACCOUNT },
    repository: { id: repoId },
    pull_request: {
      number,
      state: 'open',
      merged: false,
      merged_at: null,
      title: 'A change',
      head: { ref: 'feature/a-change', sha: 'sha-c' },
      base: { ref: 'main' },
      user: { id: 4242 },
    },
  };
}

let sendSpy: ReturnType<typeof spyOnJobDispatch>;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.githubInstallation.deleteMany({});
  _resetInstallationTokenCache();
  visible = [
    { id: 1, name: 'a' },
    { id: 2, name: 'b' },
    { id: 3, name: 'c' },
    { id: 4, name: 'd' },
    { id: 5, name: 'e' },
  ];
  stubGithub();
  sendSpy = spyOnJobDispatch();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('repo-keyed deliveries land on the owning organisation', () => {
  it('a push to c’s default branch refreshes Y only and records the head on Y’s row only', async () => {
    const { x, y } = await twoOrgs();
    sendSpy.mockClear();

    const res = await githubWebhookService.handleEvent('push', {
      ref: 'refs/heads/main',
      after: 'c'.repeat(40),
      repository: { id: 3 },
      installation: { id: INSTALLATION },
    });

    expect(res).toEqual({ event: 'push', outcome: 'refresh_enqueued' });
    const refreshes = dispatchedEvents(sendSpy).filter(
      (e) => e.name === 'system.code-graph-refresh',
    );
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]!.data).toMatchObject({ workspaceId: y.workspaceId, repoName: 'c' });

    const heads = await adminDb.githubRepo.findMany({
      where: { defaultBranchHeadSha: { not: null } },
    });
    expect(heads.map((r) => [r.repoId, r.organizationId])).toEqual([['3', y.organizationId]]);
    expect(
      await adminDb.githubRepo.count({
        where: { organizationId: x.organizationId, defaultBranchHeadSha: { not: null } },
      }),
    ).toBe(0);
  });

  it('pull_request and check_run deliveries for c resolve and write only under Y', async () => {
    const { x, y } = await twoOrgs();

    await githubWebhookService.handleEvent('pull_request', pullRequest(31, 3));
    const ci = await githubWebhookService.handleEvent('check_run', {
      action: 'completed',
      installation: { id: INSTALLATION, account: ACCOUNT },
      repository: { id: 3 },
      check_run: {
        head_sha: 'sha-c',
        status: 'completed',
        conclusion: 'success',
        name: 'build',
        check_suite: { head_branch: 'feature/a-change' },
        pull_requests: [{ number: 31 }],
      },
    });

    const prs = await adminDb.githubPullRequest.findMany({ include: { repo: true } });
    expect(prs.map((pr) => [pr.number, pr.repo.repoId, pr.repo.organizationId])).toEqual([
      [31, '3', y.organizationId],
    ]);
    // The CI delivery resolved c's repository row (Y's) — an unresolved one is
    // `unknown_repo` — and found no card, because none is linked in this fixture.
    expect(ci).toEqual({ event: 'ci', outcome: 'no_work_item' });
    expect(
      await adminDb.githubPullRequest.count({
        where: { repo: { organizationId: x.organizationId } },
      }),
    ).toBe(0);
  });

  it('a delivery for a repository no organisation owns is unknown_repo and writes nothing', async () => {
    await twoOrgs();
    const before = await adminDb.githubRepo.findMany({ orderBy: { repoId: 'asc' } });

    const res = await githubWebhookService.handleEvent('push', {
      ref: 'refs/heads/main',
      after: 'f'.repeat(40),
      repository: { id: 999 },
      installation: { id: INSTALLATION },
    });

    expect(res).toEqual({ event: 'push', outcome: 'unknown_repo' });
    expect(await adminDb.githubRepo.findMany({ orderBy: { repoId: 'asc' } })).toEqual(before);
  });
});

describe('installation_repositories reconciles each organisation separately', () => {
  it('releases a repository GitHub stopped showing from its owner only, and claims no new one', async () => {
    const { x, y } = await twoOrgs();
    const offboard = vi.spyOn(codeGraphOffboardingService, 'enqueueForRepos');
    // b is removed from the installation on GitHub; f appears on the account.
    visible = visible.filter((r) => r.id !== 2).concat({ id: 6, name: 'f' });

    const res = await githubWebhookService.handleEvent(
      'installation_repositories',
      installationRepositories(),
    );

    expect(res).toEqual({ event: 'installation_repositories', outcome: 'synced' });
    expect(await ownedBy(x)).toEqual(['1']);
    expect(await ownedBy(y)).toEqual(['3', '4', '5']);
    expect(await adminDb.githubRepo.count({ where: { repoId: '6' } })).toBe(0);
    expect(offboard).toHaveBeenCalledWith(x.workspaceId, ['acme/b'], 'repo_disconnected');
    expect(
      offboard.mock.calls.filter(([ws, refs]) => ws === y.workspaceId && refs.length > 0),
    ).toEqual([]);
  });

  it('fetches the repository list from GitHub once per delivery, not once per organisation', async () => {
    await twoOrgs();
    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy.mockClear();

    await githubWebhookService.handleEvent('installation_repositories', installationRepositories());

    const listCalls = fetchSpy.mock.calls.filter(([input]) =>
      String(input instanceof Request ? input.url : input).includes('/installation/repositories'),
    );
    expect(listCalls).toHaveLength(1);
  });

  it('still auto-claims a new repository when only ONE organisation is linked', async () => {
    const x = await makeOrg('hooks-solo@example.com');
    await githubInstallationService.linkInstallationToOrganization({
      workspaceId: x.workspaceId,
      installationId: INSTALLATION,
      repoIds: ['1', '2'],
    });
    visible = [...visible, { id: 6, name: 'f' }];

    await githubWebhookService.handleEvent('installation_repositories', installationRepositories());

    expect(await ownedBy(x)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('a failure reconciling one organisation does not stop the other', async () => {
    const { x, y } = await twoOrgs();
    visible = visible.filter((r) => r.id !== 2 && r.id !== 5);
    const real = githubInstallationService.persistInstallation.bind(githubInstallationService);
    vi.spyOn(githubInstallationService, 'persistInstallation').mockImplementation(async (input) => {
      if (input.workspaceId === x.workspaceId) throw new Error('boom for X');
      return real(input);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await githubWebhookService.handleEvent(
      'installation_repositories',
      installationRepositories(),
    );

    expect(res).toEqual({ event: 'installation_repositories', outcome: 'synced' });
    expect(await ownedBy(x)).toEqual(['1', '2']); // untouched: its reconcile failed
    expect(await ownedBy(y)).toEqual(['3', '4']); // e released
  });

  it('fails the delivery when EVERY organisation’s reconcile fails', async () => {
    await twoOrgs();
    vi.spyOn(githubInstallationService, 'persistInstallation').mockRejectedValue(
      new Error('boom for everyone'),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      githubWebhookService.handleEvent('installation_repositories', installationRepositories()),
    ).rejects.toThrow('boom for everyone');
  });

  it('reconciles a legacy installation with no link rows under its stamped workspace', async () => {
    const x = await makeOrg('hooks-legacy@example.com');
    await githubInstallationService.linkInstallationToOrganization({
      workspaceId: x.workspaceId,
      installationId: INSTALLATION,
      repoIds: ['1', '2'],
    });
    // A row from before the link table existed: tenancy on the row, no link.
    await adminDb.githubInstallationOrgLink.deleteMany({});
    visible = visible.filter((r) => r.id !== 2);

    const res = await githubWebhookService.handleEvent(
      'installation_repositories',
      installationRepositories(),
    );

    expect(res).toEqual({ event: 'installation_repositories', outcome: 'synced' });
    expect(await ownedBy(x)).toEqual(['1', '3', '4', '5']);
  });

  it('never reconciles the shared provisioning installation', async () => {
    await adminDb.githubInstallation.create({
      data: {
        installationId: 'motir-provisioning-hooks',
        workspaceId: null,
        organizationId: null,
        accountLogin: 'motir-projects',
        accountType: 'Organization',
        provider: 'github',
      },
    });

    const res = await githubWebhookService.handleEvent('installation_repositories', {
      action: 'added',
      installation: { id: 'motir-provisioning-hooks', account: ACCOUNT },
    });

    expect(res).toEqual({
      event: 'installation_repositories',
      outcome: 'skipped_shared_installation',
    });
    expect(await adminDb.githubRepo.count()).toBe(0);
  });
});

describe('a GitHub-side uninstall', () => {
  it('removes every organisation’s link and repositories, offboarding each under its own workspace; a redelivery is a no-op', async () => {
    const { x, y } = await twoOrgs();
    const offboard = vi.spyOn(codeGraphOffboardingService, 'enqueueForRepos');
    const deleted = { action: 'deleted', installation: { id: INSTALLATION, account: ACCOUNT } };

    expect(await githubWebhookService.handleEvent('installation', deleted)).toEqual({
      event: 'installation',
      outcome: 'removed',
    });

    expect(await adminDb.githubInstallation.count()).toBe(0);
    expect(await adminDb.githubInstallationOrgLink.count()).toBe(0);
    expect(await adminDb.githubRepo.count()).toBe(0);
    const calls = offboard.mock.calls.map(([ws, refs, reason]) => [ws, [...refs].sort(), reason]);
    expect(calls).toEqual(
      expect.arrayContaining([
        [x.workspaceId, ['acme/a', 'acme/b'], 'repo_disconnected'],
        [y.workspaceId, ['acme/c', 'acme/d', 'acme/e'], 'repo_disconnected'],
      ]),
    );
    expect(calls).toHaveLength(2);

    offboard.mockClear();
    await githubWebhookService.handleEvent('installation', deleted);
    expect(offboard).not.toHaveBeenCalled();
  });
});
