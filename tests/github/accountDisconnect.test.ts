import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubAccountDisconnectService } from '@/lib/services/githubAccountDisconnectService';
import { codeGraphOffboardingService } from '@/lib/services/codeGraphOffboardingService';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { InstallationNotLinkedError } from '@/lib/github/errors';
import { OrgForbiddenError } from '@/lib/organizations/errors';
import { CODE_GRAPH_RETENTION_WINDOW_DAYS } from '@/lib/codeGraph/offboarding';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';
import { linkWorkspaceReposToProject } from '../helpers/projectRepoLink';

// DISCONNECT ONE ORGANISATION FROM A SHARED GITHUB ACCOUNT — Story MOTIR-8216 ·
// MOTIR-8222, against a real Postgres. One installation (`inst-shared`, account
// `acme`): org X owns a, b; org Y owns c, d, e; each has a project using its
// repositories. Disconnecting one organisation must leave the other exactly as
// it was.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION = 'inst-shared';

const visible = [
  { id: 1, name: 'a' },
  { id: 2, name: 'b' },
  { id: 3, name: 'c' },
  { id: 4, name: 'd' },
  { id: 5, name: 'e' },
];

function stubGithub(): void {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  const json = (o: unknown): Response =>
    new Response(JSON.stringify(o), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/access_tokens')) {
        return json({
          token: 'ghs_disconnect',
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
        return json({ id: 42, account: { login: 'acme', type: 'Organization' } });
      }
      throw new Error(`unexpected fetch in test: ${url}`);
    }),
  );
}

interface Org {
  userId: string;
  workspaceId: string;
  organizationId: string;
  projectId: string;
}

async function makeOrg(slug: string, repoIds: string[], names: string[]): Promise<Org> {
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
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: `P ${slug}`,
    identifier: slug.toUpperCase(),
  });
  await githubInstallationService.linkInstallationToOrganization({
    workspaceId: workspace.id,
    installationId: INSTALLATION,
    repoIds,
  });
  await linkWorkspaceReposToProject({ workspaceId: workspace.id, projectId: project.id, names });
  return {
    userId: user.id,
    workspaceId: workspace.id,
    organizationId: row.organizationId,
    projectId: project.id,
  };
}

const ctxOf = (org: Org) => ({
  userId: org.userId,
  workspaceId: org.workspaceId,
  installationId: INSTALLATION,
});

async function ownedBy(org: Org): Promise<string[]> {
  const rows = await adminDb.githubRepo.findMany({
    where: { organizationId: org.organizationId },
    orderBy: { repoId: 'asc' },
  });
  return rows.map((r) => r.repoId);
}

async function linkedRepoNames(org: Org): Promise<(string | null)[]> {
  const rows = await adminDb.projectRepo.findMany({
    where: { projectId: org.projectId },
    include: { githubRepo: true },
    orderBy: { name: 'asc' },
  });
  return rows.map((r) => r.githubRepo?.name ?? null);
}

let x: Org;
let y: Org;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.githubInstallation.deleteMany({});
  _resetInstallationTokenCache();
  stubGithub();
  spyOnJobDispatch();
  x = await makeOrg('xorg', ['1', '2'], ['a', 'b']);
  y = await makeOrg('yorg', ['3', '4', '5'], ['c', 'd', 'e']);
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

describe('githubAccountDisconnectService.disconnectAccountFromOrganization', () => {
  it('removes Y’s link and repositories and leaves X, its links and the installation alone', async () => {
    const offboard = vi.spyOn(codeGraphOffboardingService, 'enqueueQuietly');

    const result = await githubAccountDisconnectService.disconnectAccountFromOrganization(ctxOf(y));

    expect(result).toEqual({
      releasedRepos: ['acme/c', 'acme/d', 'acme/e'],
      clearedLinks: 3,
      installationRemoved: false,
    });
    expect(await ownedBy(x)).toEqual(['1', '2']);
    expect(await ownedBy(y)).toEqual([]);
    const links = await adminDb.githubInstallationOrgLink.findMany();
    expect(links.map((l) => l.organizationId)).toEqual([x.organizationId]);
    const installation = await adminDb.githubInstallation.findUniqueOrThrow({
      where: { installationId: INSTALLATION },
    });
    expect(installation.organizationId).toBe(x.organizationId);

    // Y's project rows stay with their links cleared; X's are untouched.
    expect(await linkedRepoNames(y)).toEqual([null, null, null]);
    expect(await linkedRepoNames(x)).toEqual(['a', 'b']);

    expect(offboard).toHaveBeenCalledTimes(1);
    expect(offboard.mock.calls[0]![0]).toMatchObject({
      coreWorkspaceId: y.workspaceId,
      coreProjectIds: [y.projectId],
      reason: 'repo_disconnected',
    });
    expect([...(offboard.mock.calls[0]![0].repoRefs ?? [])].sort()).toEqual([
      'acme/c',
      'acme/d',
      'acme/e',
    ]);
  });

  it('moves the installation’s tenancy to Y when X (the stamped organisation) disconnects', async () => {
    await githubAccountDisconnectService.disconnectAccountFromOrganization(ctxOf(x));

    const installation = await adminDb.githubInstallation.findUniqueOrThrow({
      where: { installationId: INSTALLATION },
    });
    expect(installation).toMatchObject({
      workspaceId: y.workspaceId,
      organizationId: y.organizationId,
    });
    expect(
      await withSystemContext((tx) =>
        githubInstallationRepository.findByWorkspaceId(x.workspaceId, tx),
      ),
    ).toBeNull();
    expect(
      await withSystemContext((tx) =>
        githubInstallationRepository.listByOrganizationId(x.organizationId, tx),
      ),
    ).toEqual([]);
    expect(await ownedBy(y)).toEqual(['3', '4', '5']);
  });

  it('removes the installation row when the last organisation disconnects', async () => {
    await githubAccountDisconnectService.disconnectAccountFromOrganization(ctxOf(y));
    const last = await githubAccountDisconnectService.disconnectAccountFromOrganization(ctxOf(x));

    expect(last.installationRemoved).toBe(true);
    expect(await adminDb.githubInstallation.count()).toBe(0);
    expect(await adminDb.githubRepo.count()).toBe(0);
  });

  it('a second disconnect is InstallationNotLinkedError', async () => {
    await githubAccountDisconnectService.disconnectAccountFromOrganization(ctxOf(y));
    await expect(
      githubAccountDisconnectService.disconnectAccountFromOrganization(ctxOf(y)),
    ).rejects.toBeInstanceOf(InstallationNotLinkedError);
  });

  it('the shared provisioning installation is not disconnectable', async () => {
    await adminDb.githubInstallation.create({
      data: {
        installationId: 'motir-provisioning-dc',
        workspaceId: null,
        organizationId: null,
        accountLogin: 'motir-projects',
        accountType: 'Organization',
        provider: 'github',
      },
    });
    await expect(
      githubAccountDisconnectService.disconnectAccountFromOrganization({
        ...ctxOf(y),
        installationId: 'motir-provisioning-dc',
      }),
    ).rejects.toBeInstanceOf(InstallationNotLinkedError);
  });

  it('refuses a plain member of the organisation and changes nothing', async () => {
    const member = await usersService.createUser({
      email: 'member-dc@example.com',
      password: PASSWORD,
      name: 'Member',
    });
    await adminDb.organizationMembership.create({
      data: { organizationId: y.organizationId, userId: member.id, role: 'member' },
    });
    await adminDb.workspaceMembership.create({
      data: { workspaceId: y.workspaceId, userId: member.id, workspaceRole: 'member' },
    });

    await expect(
      githubAccountDisconnectService.disconnectAccountFromOrganization({
        ...ctxOf(y),
        userId: member.id,
      }),
    ).rejects.toBeInstanceOf(OrgForbiddenError);
    expect(await ownedBy(y)).toEqual(['3', '4', '5']);
  });

  it('ends consistent when another organisation claims while Y disconnects', async () => {
    const z = await (async () => {
      const user = await usersService.createUser({
        email: 'zorg@example.com',
        password: PASSWORD,
        name: 'Owner',
      });
      const { workspace } = await workspacesService.createWorkspace({
        name: 'zorg',
        ownerUserId: user.id,
      });
      const row = await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
      return { workspaceId: workspace.id, organizationId: row.organizationId };
    })();

    const [disconnect, claim] = await Promise.allSettled([
      githubAccountDisconnectService.disconnectAccountFromOrganization(ctxOf(y)),
      githubInstallationService.linkInstallationToOrganization({
        workspaceId: z.workspaceId,
        installationId: INSTALLATION,
        repoIds: ['3'],
      }),
    ]);

    expect(disconnect.status).toBe('fulfilled');
    // Either Z claimed after Y let go, or it was refused while Y still held c —
    // never both, never a raw database error.
    const zOwns = (
      await adminDb.githubRepo.findMany({ where: { organizationId: z.organizationId } })
    ).map((r) => r.repoId);
    if (claim.status === 'fulfilled') expect(zOwns).toEqual(['3']);
    else {
      expect((claim.reason as { code?: string }).code).toBe(
        'GITHUB_REPO_OWNED_BY_OTHER_ORGANIZATION',
      );
      expect(zOwns).toEqual([]);
    }
    expect(await ownedBy(y)).toEqual([]);
    expect(await ownedBy(x)).toEqual(['1', '2']);
    expect(await adminDb.githubRepo.count({ where: { repoId: '3' } })).toBeLessThanOrEqual(1);
  });
});

describe('githubAccountDisconnectService.previewAccountDisconnect', () => {
  it('lists the account, Y’s repositories, the live projects the disconnect clears, and the retention constant', async () => {
    const preview = await githubAccountDisconnectService.previewAccountDisconnect(ctxOf(y));

    expect(preview).toMatchObject({
      accountLogin: 'acme',
      accountType: 'Organization',
      retentionWindowDays: CODE_GRAPH_RETENTION_WINDOW_DAYS,
    });
    expect(preview.repos.map((r) => r.repoRef)).toEqual(['acme/c', 'acme/d', 'acme/e']);
    expect(preview.projects.map((p) => p.id)).toEqual([y.projectId]);
    expect(JSON.stringify(preview)).not.toContain(x.organizationId);
    expect(JSON.stringify(preview)).not.toContain(x.workspaceId);
  });
});
