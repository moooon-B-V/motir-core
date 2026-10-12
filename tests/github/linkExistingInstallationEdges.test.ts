import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import {
  InstallationNotAccessibleError,
  RepositoryOwnedByOtherOrganizationError,
} from '@/lib/github/errors';
import { OrgForbiddenError } from '@/lib/organizations/errors';
import { encryptToken } from '@/lib/github/tokenCrypto';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { spyOnJobDispatch } from '../helpers/jobs';

// The edges of linking an EXISTING installation to an organisation (Story
// MOTIR-8216 · MOTIR-8219 / MOTIR-8220) that the story's scenario does not
// reach: who may link without a live GitHub identity, which workspace a link
// is made from when the hint is outside the organisation, the shared
// provisioning installation, and a claim that loses the race at the database
// guard rather than at the up-front check. Real Postgres; only GitHub (at
// `fetch`) is faked.

const INSTALLATION = '5151';
const OTHER_INSTALLATION = '5252';
const NAMES: Record<number, string> = { 1: 'a', 2: 'b' };

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
  const json = (o: unknown): Response =>
    new Response(JSON.stringify(o), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
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
          repositories: [1, 2].map((id) => ({
            id,
            name: NAMES[id],
            owner: { login: 'acme' },
            default_branch: 'main',
          })),
        });
      }
      return json({ id: 42, account: { login: 'acme', type: 'Organization' } });
    }),
  );
}

interface Org {
  organizationId: string;
  workspaceId: string;
  ownerId: string;
}

async function makeOrg(slug: string, opts: { identity?: boolean } = {}): Promise<Org> {
  const user = await usersService.createUser({
    email: `${slug}@example.com`,
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: slug,
    ownerUserId: user.id,
  });
  const row = await adminDb.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
  if (opts.identity !== false) {
    await adminDb.githubIdentity.create({
      data: {
        userId: user.id,
        githubUserId: `gh-${user.id}`,
        githubLogin: `login-${slug}`,
        accessTokenEncrypted: encryptToken(`gho_${slug}`),
      },
    });
    userInstallations[`gho_${slug}`] = [Number(INSTALLATION), Number(OTHER_INSTALLATION)];
  }
  return { organizationId: row.organizationId, workspaceId: workspace.id, ownerId: user.id };
}

function link(
  org: Org,
  extra: {
    installationId?: string;
    repoIds?: string[];
    via?: 'picker' | 'install_return';
    workspaceIdHint?: string;
    requireHintInOrganization?: boolean;
  },
) {
  return githubInstallationService.linkExistingInstallation({
    organizationId: org.organizationId,
    actorUserId: org.ownerId,
    installationId: extra.installationId ?? INSTALLATION,
    via: extra.via ?? 'picker',
    ...(extra.repoIds ? { repoIds: extra.repoIds } : {}),
    ...(extra.workspaceIdHint ? { workspaceIdHint: extra.workspaceIdHint } : {}),
    ...(extra.requireHintInOrganization ? { requireHintInOrganization: true } : {}),
  });
}

async function linkedWorkspace(org: Org): Promise<string | undefined> {
  const row = await adminDb.githubInstallationOrgLink.findFirst({
    where: { organizationId: org.organizationId },
  });
  return row?.workspaceId;
}

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.githubInstallation.deleteMany({});
  _resetInstallationTokenCache();
  userInstallations = {};
  stubGithub();
  spyOnJobDispatch();
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

describe('linking an existing installation — access', () => {
  it('refuses the picker for an admin with no GitHub identity', async () => {
    const x = await makeOrg('noid', { identity: false });
    await expect(link(x, { repoIds: ['1'] })).rejects.toBeInstanceOf(
      InstallationNotAccessibleError,
    );
    expect(await adminDb.githubInstallationOrgLink.count()).toBe(0);
  });

  it('lets the install round trip through without an identity (GitHub just vouched for it)', async () => {
    const x = await makeOrg('roundtrip', { identity: false });
    const result = await link(x, { via: 'install_return' });
    expect(result.claimed.sort()).toEqual(['acme/a', 'acme/b']);
  });

  it('refuses an installation the admin cannot see on GitHub', async () => {
    const x = await makeOrg('blind');
    userInstallations['gho_blind'] = [];
    await expect(link(x, { repoIds: ['1'] })).rejects.toBeInstanceOf(
      InstallationNotAccessibleError,
    );
  });

  it('refuses the shared provisioning installation even when GitHub shows it', async () => {
    const x = await makeOrg('shared');
    await adminDb.githubInstallation.create({
      data: {
        installationId: INSTALLATION,
        accountLogin: 'acme',
        accountType: 'Organization',
        workspaceId: null,
        organizationId: null,
      },
    });
    await expect(link(x, { repoIds: ['1'] })).rejects.toBeInstanceOf(
      InstallationNotAccessibleError,
    );
    expect(await adminDb.githubInstallationOrgLink.count()).toBe(0);
  });
});

describe('linking an existing installation — which workspace it is made from', () => {
  it('uses the organisation’s own workspace when no hint is given', async () => {
    const x = await makeOrg('nohint');
    await link(x, {});
    expect(await linkedWorkspace(x)).toBe(x.workspaceId);
  });

  it('ignores a hint outside the organisation for the picker', async () => {
    const x = await makeOrg('ignore');
    const y = await makeOrg('elsewhere', { identity: false });
    await link(x, { workspaceIdHint: y.workspaceId });
    expect(await linkedWorkspace(x)).toBe(x.workspaceId);
  });

  it('refuses a hint outside the organisation when the hint must agree', async () => {
    const x = await makeOrg('strict');
    const y = await makeOrg('foreign', { identity: false });
    await expect(
      link(x, { workspaceIdHint: y.workspaceId, requireHintInOrganization: true }),
    ).rejects.toBeInstanceOf(OrgForbiddenError);
    expect(await adminDb.githubInstallationOrgLink.count()).toBe(0);
  });
});

describe('a claim that loses at the database guard', () => {
  async function ownedElsewhere(): Promise<{ x: Org; y: Org }> {
    const x = await makeOrg('racer');
    const y = await makeOrg('owner');
    // Y owns repository 1 through a DIFFERENT installation of the same host repo.
    await link(y, { installationId: OTHER_INSTALLATION, repoIds: ['1'] });
    return { x, y };
  }

  it('re-reads after the guard fires and refuses by name (a chosen set)', async () => {
    const { x } = await ownedElsewhere();
    // The up-front check reads before the rival commits: it sees nobody.
    vi.spyOn(githubRepoRepository, 'findByHostRepoId').mockResolvedValueOnce([]);
    const err = await link(x, { repoIds: ['1'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RepositoryOwnedByOtherOrganizationError);
    expect((err as RepositoryOwnedByOtherOrganizationError).repositories).toEqual([
      { repoId: '1', fullName: 'acme/a' },
    ]);
    expect(await linkedWorkspace(x)).toBeUndefined();
  });

  it('re-reads every visible repository when the set was omitted', async () => {
    const { x } = await ownedElsewhere();
    vi.spyOn(githubRepoRepository, 'findByHostRepoId')
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await expect(
      githubInstallationService.linkInstallationToOrganization({
        workspaceId: x.workspaceId,
        installationId: INSTALLATION,
        provider: 'github',
      }),
    ).rejects.toBeInstanceOf(RepositoryOwnedByOtherOrganizationError);
  });

  it('rethrows the database error when the re-read finds no owner', async () => {
    const { x } = await ownedElsewhere();
    vi.spyOn(githubRepoRepository, 'findByHostRepoId').mockResolvedValue([]);
    await expect(link(x, { repoIds: ['1'] })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rethrows any other failure untouched', async () => {
    const x = await makeOrg('broken');
    vi.spyOn(githubRepoRepository, 'upsert').mockRejectedValueOnce(new Error('disk full'));
    await expect(link(x, { repoIds: ['1'] })).rejects.toThrow('disk full');
  });
});

describe('the older doors onto the same path', () => {
  it('binds through the per-organisation link with an explicit provider', async () => {
    const x = await makeOrg('bind');
    const dto = await githubInstallationService.bindInstallationForWorkspace({
      workspaceId: x.workspaceId,
      installationId: INSTALLATION,
      provider: 'github',
    });
    expect(dto.repos.map((r) => r.repoId).sort()).toEqual(['1', '2']);
  });
});
