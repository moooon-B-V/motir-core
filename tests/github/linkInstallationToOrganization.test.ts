import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import {
  InstallationNotLinkableError,
  RepoSelectionRequiredError,
  RepositoryNotVisibleError,
  RepositoryOwnedByOtherOrganizationError,
} from '@/lib/github/errors';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

// ONE GITHUB ACCOUNT, MANY ORGANISATIONS — the install service (Story
// MOTIR-8216 · MOTIR-8219), against a real Postgres. One GitHub installation
// (`inst-shared`, account `acme`) can be seen by several Motir organisations;
// each links it and claims its own subset, and nobody's tenancy or
// repositories are overwritten or pruned by somebody else's link.

const PASSWORD = 'hunter2hunter2';
const INSTALLATION = 'inst-shared';

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
          token: 'ghs_link',
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

async function makeOrg(email: string): Promise<{ workspaceId: string; organizationId: string }> {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: email,
    ownerUserId: user.id,
  });
  const row = await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
  return { workspaceId: workspace.id, organizationId: row.organizationId };
}

async function ownedBy(organizationId: string): Promise<string[]> {
  const rows = await adminDb.githubRepo.findMany({
    where: { organizationId },
    orderBy: { repoId: 'asc' },
  });
  return rows.map((r) => r.repoId);
}

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
  spyOnJobDispatch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('githubInstallationService.linkInstallationToOrganization', () => {
  it('links two organisations to one installation with disjoint subsets, leaving the first organisation’s tenancy and repositories alone', async () => {
    const x = await makeOrg('x@example.com');
    const y = await makeOrg('y@example.com');

    await githubInstallationService.linkInstallationToOrganization({
      workspaceId: x.workspaceId,
      installationId: INSTALLATION,
      repoIds: ['1', '2'],
    });
    const result = await githubInstallationService.linkInstallationToOrganization({
      workspaceId: y.workspaceId,
      installationId: INSTALLATION,
      repoIds: ['3', '4', '5'],
    });

    expect(result.installation.repos.map((r) => r.repoId).sort()).toEqual(['3', '4', '5']);
    expect(result.claimed.sort()).toEqual(['acme/c', 'acme/d', 'acme/e']);
    const installation = await adminDb.githubInstallation.findUniqueOrThrow({
      where: { installationId: INSTALLATION },
    });
    expect([installation.workspaceId, installation.organizationId]).toEqual([
      x.workspaceId,
      x.organizationId,
    ]);
    expect(await ownedBy(x.organizationId)).toEqual(['1', '2']);
    expect(await ownedBy(y.organizationId)).toEqual(['3', '4', '5']);
    expect(await adminDb.githubInstallationOrgLink.count()).toBe(2);
  });

  it('refuses a claim that includes another organisation’s repository, whole, naming only the repository', async () => {
    const x = await makeOrg('x2@example.com');
    const y = await makeOrg('y2@example.com');
    await githubInstallationService.linkInstallationToOrganization({
      workspaceId: x.workspaceId,
      installationId: INSTALLATION,
      repoIds: ['1', '2'],
    });

    const refusal = await githubInstallationService
      .linkInstallationToOrganization({
        workspaceId: y.workspaceId,
        installationId: INSTALLATION,
        repoIds: ['1', '3'],
      })
      .catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(RepositoryOwnedByOtherOrganizationError);
    const error = refusal as RepositoryOwnedByOtherOrganizationError;
    expect(error.repositories).toEqual([{ repoId: '1', fullName: 'acme/a' }]);
    expect(error.message).not.toContain(x.organizationId);
    expect(error.message).not.toContain(x.workspaceId);
    // All or nothing: org Y has no repositories and no link.
    expect(await ownedBy(y.organizationId)).toEqual([]);
    expect(await ownedBy(x.organizationId)).toEqual(['1', '2']);
    expect(
      await adminDb.githubInstallationOrgLink.count({
        where: { organizationId: y.organizationId },
      }),
    ).toBe(0);
  });

  it('two concurrent claims of one repository end with one owner and one typed refusal', async () => {
    const x = await makeOrg('x3@example.com');
    const y = await makeOrg('y3@example.com');
    const outcomes = await Promise.allSettled([
      githubInstallationService.linkInstallationToOrganization({
        workspaceId: x.workspaceId,
        installationId: INSTALLATION,
        repoIds: ['1'],
      }),
      githubInstallationService.linkInstallationToOrganization({
        workspaceId: y.workspaceId,
        installationId: INSTALLATION,
        repoIds: ['1'],
      }),
    ]);
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      RepositoryOwnedByOtherOrganizationError,
    );
    expect(await adminDb.githubRepo.count({ where: { repoId: '1' } })).toBe(1);
  });

  it('a refresh without repoIds keeps the organisation’s subset; with repoIds it adds and releases only its own', async () => {
    const x = await makeOrg('x4@example.com');
    const y = await makeOrg('y4@example.com');
    await githubInstallationService.linkInstallationToOrganization({
      workspaceId: x.workspaceId,
      installationId: INSTALLATION,
      repoIds: ['1', '2'],
    });
    await githubInstallationService.linkInstallationToOrganization({
      workspaceId: y.workspaceId,
      installationId: INSTALLATION,
      repoIds: ['3'],
    });

    await githubInstallationService.linkInstallationToOrganization({
      workspaceId: y.workspaceId,
      installationId: INSTALLATION,
    });
    expect(await ownedBy(y.organizationId)).toEqual(['3']);
    expect(
      await adminDb.githubInstallationOrgLink.count({
        where: { organizationId: y.organizationId },
      }),
    ).toBe(1);

    const changed = await githubInstallationService.linkInstallationToOrganization({
      workspaceId: y.workspaceId,
      installationId: INSTALLATION,
      repoIds: ['4', '5'],
    });
    expect(changed.released).toEqual(['acme/c']);
    expect(await ownedBy(y.organizationId)).toEqual(['4', '5']);
    expect(await ownedBy(x.organizationId)).toEqual(['1', '2']);
  });

  it('a NEW link without repoIds beside another organisation requires a choice', async () => {
    const x = await makeOrg('x5@example.com');
    const y = await makeOrg('y5@example.com');
    await githubInstallationService.linkInstallationToOrganization({
      workspaceId: x.workspaceId,
      installationId: INSTALLATION,
      repoIds: ['1'],
    });
    await expect(
      githubInstallationService.linkInstallationToOrganization({
        workspaceId: y.workspaceId,
        installationId: INSTALLATION,
      }),
    ).rejects.toBeInstanceOf(RepoSelectionRequiredError);
  });

  it('refuses a repository the App cannot see', async () => {
    const x = await makeOrg('x6@example.com');
    await expect(
      githubInstallationService.linkInstallationToOrganization({
        workspaceId: x.workspaceId,
        installationId: INSTALLATION,
        repoIds: ['1', '99'],
      }),
    ).rejects.toBeInstanceOf(RepositoryNotVisibleError);
    expect(await adminDb.githubRepo.count()).toBe(0);
  });

  it('never links Motir’s shared provisioning installation', async () => {
    const x = await makeOrg('x7@example.com');
    await adminDb.githubInstallation.create({
      data: {
        installationId: INSTALLATION,
        workspaceId: null,
        organizationId: null,
        accountLogin: 'motir-projects',
        accountType: 'Organization',
      },
    });
    await expect(
      githubInstallationService.linkInstallationToOrganization({
        workspaceId: x.workspaceId,
        installationId: INSTALLATION,
        repoIds: ['1'],
      }),
    ).rejects.toBeInstanceOf(InstallationNotLinkableError);
    expect(await adminDb.githubInstallationOrgLink.count()).toBe(0);
  });
});

describe('githubInstallationService.persistInstallation — the per-organisation reconcile', () => {
  it('reconciling for one organisation never deletes or takes another organisation’s repositories', async () => {
    const x = await makeOrg('x8@example.com');
    const y = await makeOrg('y8@example.com');
    await githubInstallationService.linkInstallationToOrganization({
      workspaceId: x.workspaceId,
      installationId: INSTALLATION,
      repoIds: ['1', '2'],
    });

    // GitHub's whole selection is 1..3; org Y's reconcile sees all of it.
    await githubInstallationService.persistInstallation({
      workspaceId: y.workspaceId,
      installation: {
        installationId: INSTALLATION,
        accountLogin: 'acme',
        accountType: 'Organization',
      },
      repos: [1, 2, 3].map((id) => ({
        providerRepoId: String(id),
        owner: 'acme',
        name: `r${id}`,
        defaultBranch: 'main',
        archived: false,
      })),
    });

    expect(await ownedBy(x.organizationId)).toEqual(['1', '2']);
    expect(await ownedBy(y.organizationId)).toEqual(['3']);
    const installation = await adminDb.githubInstallation.findUniqueOrThrow({
      where: { installationId: INSTALLATION },
    });
    expect(installation.organizationId).toBe(x.organizationId);
  });
});
