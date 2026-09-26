import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { encryptToken } from '@/lib/gitlab/tokenCrypto';
import {
  organizationGitOffboardingService,
  type GitOffboardingDeps,
} from '@/lib/services/organizationGitOffboardingService';
import { RepoDeletionError, repoDeletionClient } from '@/lib/github/repoDeletion';
import { AppUninstallError, appInstallationsClient } from '@/lib/github/appInstallations';
import { revokeToken } from '@/lib/gitlab/gitlabOAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The organization GIT OFFBOARDING (Story MOTIR-6306 · MOTIR-6397). The rows are
// real Postgres (the resume property is about which rows a failure leaves behind);
// the HOSTS are stubbed through the service's injected seams, and the three HTTP
// clients are exercised on their own below against a stubbed `fetch`.

const HOST = 'motir-projects';

type Calls = {
  deleted: Array<{ installationId: string; owner: string; repo: string }>;
  uninstalled: string[];
  webhooksRemoved: string[];
  revoked: string[];
};

function stubDeps(overrides: Partial<GitOffboardingDeps> = {}): {
  deps: GitOffboardingDeps;
  calls: Calls;
} {
  const calls: Calls = { deleted: [], uninstalled: [], webhooksRemoved: [], revoked: [] };
  const deps: GitOffboardingDeps = {
    async deleteRepo(input) {
      calls.deleted.push(input);
      return 'deleted';
    },
    async uninstallInstallation(id) {
      calls.uninstalled.push(id);
      return 'uninstalled';
    },
    async removeGitlabWebhook(_token, projectId) {
      calls.webhooksRemoved.push(projectId);
    },
    async revokeGitlabToken(token) {
      calls.revoked.push(token);
      return true;
    },
    hostOwner: () => HOST,
    ...overrides,
  };
  return { deps, calls };
}

let seq = 0;

async function makeOrg(slug: string) {
  const organization = await adminDb.organization.create({ data: { name: slug, slug } });
  const workspace = await adminDb.workspace.create({
    data: { name: slug, slug: `${slug}-ws`, organizationId: organization.id },
  });
  return { organizationId: organization.id, workspaceId: workspace.id };
}

async function makeInstallation(
  org: { organizationId: string | null; workspaceId: string | null },
  provider: 'github' | 'gitlab' = 'github',
  extra: { accessTokenEncrypted?: string; refreshTokenEncrypted?: string } = {},
) {
  seq += 1;
  return adminDb.githubInstallation.create({
    data: {
      provider,
      installationId: `${provider}-inst-${seq}`,
      workspaceId: org.workspaceId,
      organizationId: org.organizationId,
      accountLogin: `acct-${seq}`,
      accountType: 'Organization',
      ...extra,
    },
  });
}

async function makeRepo(
  org: { organizationId: string; workspaceId: string },
  installationFk: string,
  owner: string,
  name: string,
  provider: 'github' | 'gitlab' = 'github',
) {
  seq += 1;
  return adminDb.githubRepo.create({
    data: {
      provider,
      installationId: installationFk,
      workspaceId: org.workspaceId,
      organizationId: org.organizationId,
      repoId: `r${seq}`,
      owner,
      name,
      defaultBranch: 'main',
    },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.githubInstallation.deleteMany({});
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

describe('offboardGit', () => {
  it('deletes the two hosted repositories, never the customer’s, removes all rows and uninstalls', async () => {
    const org = await makeOrg('gone');
    // Motir's shared provisioning installation: owned by no organization.
    const provisioning = await makeInstallation({ organizationId: null, workspaceId: null });
    const own = await makeInstallation(org);
    const hostedA = await makeRepo(org, provisioning.id, HOST, 'site-a');
    const hostedB = await makeRepo(org, provisioning.id, 'Motir-Projects', 'site-b');
    const theirs = await makeRepo(org, own.id, 'acme', 'product');
    const { deps, calls } = stubDeps();

    const counts = await organizationGitOffboardingService.offboardGit(org.organizationId, deps);

    expect(counts).toEqual({
      hostedReposDeleted: 2,
      customerRepoRowsRemoved: 1,
      installationsUninstalled: 1,
      installationsUnlinked: 0,
      gitlabConnectionsRemoved: 0,
    });
    expect(calls.deleted.map((c) => c.repo).sort()).toEqual(['site-a', 'site-b']);
    expect(calls.deleted.every((c) => c.installationId === provisioning.installationId)).toBe(true);
    expect(calls.deleted.some((c) => c.owner === 'acme')).toBe(false);
    expect(calls.uninstalled).toEqual([own.installationId]);
    const left = await adminDb.githubRepo.findMany({
      where: { id: { in: [hostedA.id, hostedB.id, theirs.id] } },
    });
    expect(left).toEqual([]);
    expect(await adminDb.githubInstallation.count({ where: { id: own.id } })).toBe(0);
    // The shared provisioning installation is never uninstalled nor removed.
    expect(await adminDb.githubInstallation.count({ where: { id: provisioning.id } })).toBe(1);
  });

  it('a second run makes no remote call and returns zeros', async () => {
    const org = await makeOrg('twice');
    const provisioning = await makeInstallation({ organizationId: null, workspaceId: null });
    await makeRepo(org, provisioning.id, HOST, 'site');
    await makeInstallation(org);
    await organizationGitOffboardingService.offboardGit(org.organizationId, stubDeps().deps);

    const { deps, calls } = stubDeps();
    expect(await organizationGitOffboardingService.offboardGit(org.organizationId, deps)).toEqual({
      hostedReposDeleted: 0,
      customerRepoRowsRemoved: 0,
      installationsUninstalled: 0,
      installationsUnlinked: 0,
      gitlabConnectionsRemoved: 0,
    });
    expect(calls).toEqual({ deleted: [], uninstalled: [], webhooksRemoved: [], revoked: [] });
  });

  it('only unlinks an installation another live org still uses — no uninstall, no row delete', async () => {
    const org = await makeOrg('leaving');
    const other = await makeOrg('staying');
    const inst = await makeInstallation(org);
    await makeRepo(org, inst.id, 'acme', 'mine');
    const othersRepo = await makeRepo(other, inst.id, 'acme', 'theirs');
    const { deps, calls } = stubDeps();

    const counts = await organizationGitOffboardingService.offboardGit(org.organizationId, deps);

    expect(counts).toMatchObject({ installationsUnlinked: 1, installationsUninstalled: 0 });
    expect(calls.uninstalled).toEqual([]);
    const row = await adminDb.githubInstallation.findUniqueOrThrow({ where: { id: inst.id } });
    expect(row.organizationId).toBe(other.organizationId);
    expect(await adminDb.githubRepo.count({ where: { id: othersRepo.id } })).toBe(1);
    // And the next run does not find it again.
    expect(
      (await organizationGitOffboardingService.offboardGit(org.organizationId, stubDeps().deps))
        .installationsUnlinked,
    ).toBe(0);
  });

  it('a GitHub 500 on the second repository leaves the first gone and the second present; a re-run finishes', async () => {
    const org = await makeOrg('flaky');
    const provisioning = await makeInstallation({ organizationId: null, workspaceId: null });
    const first = await makeRepo(org, provisioning.id, HOST, 'a-first');
    const second = await makeRepo(org, provisioning.id, HOST, 'b-second');
    let n = 0;
    const { deps } = stubDeps({
      async deleteRepo() {
        n += 1;
        if (n === 2) throw new RepoDeletionError(500, 'boom');
        return 'deleted';
      },
    });

    await expect(
      organizationGitOffboardingService.offboardGit(org.organizationId, deps),
    ).rejects.toBeInstanceOf(RepoDeletionError);
    expect(await adminDb.githubRepo.count({ where: { id: first.id } })).toBe(0);
    expect(await adminDb.githubRepo.count({ where: { id: second.id } })).toBe(1);

    const { deps: again, calls } = stubDeps();
    const counts = await organizationGitOffboardingService.offboardGit(org.organizationId, again);
    expect(counts.hostedReposDeleted).toBe(1);
    expect(calls.deleted.map((c) => c.repo)).toEqual(['b-second']);
    expect(await adminDb.githubRepo.count({ where: { id: second.id } })).toBe(0);
  });

  it('deletes no repository at all on a deployment with no provisioning org', async () => {
    const org = await makeOrg('selfhost');
    const inst = await makeInstallation(org);
    await makeRepo(org, inst.id, HOST, 'looks-hosted');
    const { deps, calls } = stubDeps({ hostOwner: () => null });
    const counts = await organizationGitOffboardingService.offboardGit(org.organizationId, deps);
    expect(calls.deleted).toEqual([]);
    expect(counts.customerRepoRowsRemoved).toBe(1);
  });

  it('removes a GitLab connection: webhooks off, both tokens revoked, rows gone', async () => {
    vi.stubEnv('GITLAB_TOKEN_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
    const org = await makeOrg('lab');
    const conn = await makeInstallation(org, 'gitlab', {
      accessTokenEncrypted: encryptToken('glpat-access'),
      refreshTokenEncrypted: encryptToken('glpat-refresh'),
    });
    const project = await makeRepo(org, conn.id, 'group', 'proj', 'gitlab');
    const { deps, calls } = stubDeps({
      async removeGitlabWebhook(_t, id) {
        calls.webhooksRemoved.push(id);
        throw new Error('best-effort: ignored');
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const counts = await organizationGitOffboardingService.offboardGit(org.organizationId, deps);

    expect(counts.gitlabConnectionsRemoved).toBe(1);
    expect(calls.webhooksRemoved).toEqual([project.repoId]);
    expect(calls.revoked).toEqual(['glpat-access', 'glpat-refresh']);
    expect(calls.deleted).toEqual([]);
    expect(await adminDb.githubInstallation.count({ where: { id: conn.id } })).toBe(0);
    expect(await adminDb.githubRepo.count({ where: { id: project.id } })).toBe(0);
  });

  it('touches no other organization', async () => {
    const org = await makeOrg('target');
    const bystander = await makeOrg('bystander');
    const provisioning = await makeInstallation({ organizationId: null, workspaceId: null });
    const theirs = await makeRepo(bystander, provisioning.id, HOST, 'keep');
    const theirInst = await makeInstallation(bystander);
    const { deps, calls } = stubDeps();
    await organizationGitOffboardingService.offboardGit(org.organizationId, deps);
    expect(calls).toEqual({ deleted: [], uninstalled: [], webhooksRemoved: [], revoked: [] });
    expect(await adminDb.githubRepo.count({ where: { id: theirs.id } })).toBe(1);
    expect(await adminDb.githubInstallation.count({ where: { id: theirInst.id } })).toBe(1);
  });
});

describe('the host clients', () => {
  function stubFetch(status: number, body: unknown = {}) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('deleteRepo: DELETEs the repository with the provisioning token; 204 and 404 both succeed', async () => {
    vi.spyOn(await import('@/lib/github/appAuth'), 'mintInstallationToken').mockResolvedValue({
      token: 'ghs_x',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    let f = stubFetch(204);
    // A 204 has no body; the Response constructor needs null for it.
    f.mockImplementation(async () => new Response(null, { status: 204 }));
    expect(
      await repoDeletionClient.deleteRepo({ installationId: '9', owner: HOST, repo: 's' }),
    ).toBe('deleted');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.github.com/repos/${HOST}/s`);
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer ghs_x');

    f = stubFetch(404);
    expect(
      await repoDeletionClient.deleteRepo({ installationId: '9', owner: HOST, repo: 's' }),
    ).toBe('absent');
    stubFetch(403, { message: 'Must have admin rights' });
    await expect(
      repoDeletionClient.deleteRepo({ installationId: '9', owner: HOST, repo: 's' }),
    ).rejects.toMatchObject({ status: 403, detail: 'Must have admin rights' });
  });

  it('deleteRepo: an unmintable token and an unreachable host are typed failures', async () => {
    const auth = await import('@/lib/github/appAuth');
    vi.spyOn(auth, 'mintInstallationToken').mockRejectedValueOnce(new Error('no app'));
    await expect(
      repoDeletionClient.deleteRepo({ installationId: '9', owner: HOST, repo: 's' }),
    ).rejects.toMatchObject({ status: null });
    vi.spyOn(auth, 'mintInstallationToken').mockResolvedValue({
      token: 't',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    await expect(
      repoDeletionClient.deleteRepo({ installationId: '9', owner: HOST, repo: 's' }),
    ).rejects.toBeInstanceOf(RepoDeletionError);
  });

  it('uninstallInstallation: DELETEs the installation with the App JWT; 404 is success', async () => {
    vi.spyOn(await import('@/lib/github/appAuth'), 'createAppJwt').mockReturnValue('jwt');
    const f = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', f);
    expect(await appInstallationsClient.uninstallInstallation('77')).toBe('uninstalled');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.github.com/app/installations/77');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer jwt');
    stubFetch(404);
    expect(await appInstallationsClient.uninstallInstallation('77')).toBe('absent');
    stubFetch(500);
    await expect(appInstallationsClient.uninstallInstallation('77')).rejects.toBeInstanceOf(
      AppUninstallError,
    );
  });

  it('uninstallInstallation: an unconfigured App and an unreachable host are typed failures', async () => {
    const auth = await import('@/lib/github/appAuth');
    vi.spyOn(auth, 'createAppJwt').mockImplementationOnce(() => {
      throw new Error('unset');
    });
    await expect(appInstallationsClient.uninstallInstallation('1')).rejects.toMatchObject({
      status: null,
    });
    vi.spyOn(auth, 'createAppJwt').mockReturnValue('jwt');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      }),
    );
    await expect(appInstallationsClient.uninstallInstallation('1')).rejects.toBeInstanceOf(
      AppUninstallError,
    );
  });

  it('revokeToken: posts the client credentials and never throws', async () => {
    vi.stubEnv('GITLAB_APP_CLIENT_ID', 'cid');
    vi.stubEnv('GITLAB_APP_CLIENT_SECRET', 'secret');
    const f = stubFetch(200);
    expect(await revokeToken('tok')).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gitlab.com/oauth/revoke');
    expect(JSON.parse(String(init.body))).toEqual({
      client_id: 'cid',
      client_secret: 'secret',
      token: 'tok',
    });
    stubFetch(400);
    expect(await revokeToken('tok')).toBe(false);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('down');
      }),
    );
    expect(await revokeToken('tok')).toBe(false);
    vi.stubEnv('GITLAB_APP_CLIENT_ID', '');
    expect(await revokeToken('tok')).toBe(false);
  });
});
