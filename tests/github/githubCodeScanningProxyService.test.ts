import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubCodeScanningProxyService } from '@/lib/services/githubCodeScanningProxyService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { withSystemContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../helpers/db';
import type { NormalizedRepo } from '@/lib/git/types';

// MOTIR-1605 — the code-scanning proxy service, against a real Postgres. Proves
// the producer half of "private-repo code-scanning access": resolve a connected
// repo to its tenant installation (own-workspace only), mint the installation
// token via the provider seam, and read the code-scanning API authenticated —
// while every unresolvable / unconfigured / unavailable path DEGRADES to null
// (§10.3 is never a gate) and NO token is persisted or leaked cross-tenant.

const PASSWORD = 'hunter2hunter2';
const REPO: NormalizedRepo = {
  providerRepoId: '111',
  owner: 'moooon',
  name: 'motir-core',
  defaultBranch: 'main',
};
const REPO_REF = 'moooon/motir-core';

const ANALYSES_BODY = [
  { id: 42, tool: { name: 'CodeQL' }, created_at: '2026-07-01T00:00:00Z' },
  { id: 7, tool: { name: 'CodeQL' }, created_at: '2026-06-01T00:00:00Z' },
];
const SARIF_DOC = { version: '2.1.0', runs: [{ results: [] }] };

async function makeWorkspace(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  return { user, workspace };
}

/** Wire the GitHub App env + a fetch mock that answers the token-mint endpoint,
 *  the analyses list, and the SARIF fetch. Returns the mock for assertions. */
function stubGithub(): ReturnType<typeof vi.fn> {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_APP_ID', '999');
  vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
  const fetchMock = vi.fn(async (url: string): Promise<Response> => {
    const json = (b: unknown) =>
      new Response(JSON.stringify(b), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (url.endsWith('/access_tokens')) {
      return json({
        token: 'ghs_installtoken',
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (url.includes('/code-scanning/analyses/')) return json(SARIF_DOC);
    if (url.includes('/code-scanning/analyses')) return json(ANALYSES_BODY);
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function connectRepo(workspaceId: string, installationId: string, repo = REPO) {
  await githubInstallationService.persistInstallation({
    workspaceId,
    installation: { installationId, accountLogin: 'moooon', accountType: 'User' },
    repos: [repo],
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  _resetInstallationTokenCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await db.$disconnect();
});

describe('githubCodeScanningProxyService — private connected repo (AC1)', () => {
  it('lists analyses read with the tenant installation token', async () => {
    const fetchMock = stubGithub();
    const { user, workspace } = await makeWorkspace('a@example.com');
    await connectRepo(workspace.id, 'inst-1');

    const analyses = await githubCodeScanningProxyService.listAnalyses(
      { userId: user.id, workspaceId: workspace.id },
      REPO_REF,
    );
    expect(analyses).toEqual([
      { id: 42, toolName: 'CodeQL', createdAt: '2026-07-01T00:00:00Z' },
      { id: 7, toolName: 'CodeQL', createdAt: '2026-06-01T00:00:00Z' },
    ]);
    // The code-scanning read carried the minted INSTALLATION token.
    const scanCall = fetchMock.mock.calls.find(([u]) =>
      String(u).includes('/code-scanning/analyses'),
    );
    expect(scanCall).toBeDefined();
    expect(String(scanCall![0])).toBe(
      'https://api.github.com/repos/moooon/motir-core/code-scanning/analyses?per_page=50',
    );
    const headers = (scanCall![1] as RequestInit).headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer ghs_installtoken');
  });

  it('fetches a SARIF document for one analysis', async () => {
    stubGithub();
    const { user, workspace } = await makeWorkspace('b@example.com');
    await connectRepo(workspace.id, 'inst-2');

    const sarif = await githubCodeScanningProxyService.getSarif(
      { userId: user.id, workspaceId: workspace.id },
      REPO_REF,
      42,
    );
    expect(sarif).toEqual(SARIF_DOC);
  });
});

describe('githubCodeScanningProxyService — degrade paths (never a gate, AC3)', () => {
  it('returns null when the repo is not connected in this workspace', async () => {
    stubGithub();
    const { user, workspace } = await makeWorkspace('c@example.com');
    // No installation/repo connected at all.
    const analyses = await githubCodeScanningProxyService.listAnalyses(
      { userId: user.id, workspaceId: workspace.id },
      REPO_REF,
    );
    expect(analyses).toBeNull();
  });

  it('returns null for a malformed repoRef (no GitHub coordinates)', async () => {
    stubGithub();
    const { user, workspace } = await makeWorkspace('d@example.com');
    await connectRepo(workspace.id, 'inst-3');
    expect(
      await githubCodeScanningProxyService.listAnalyses(
        { userId: user.id, workspaceId: workspace.id },
        'not-a-repo-ref',
      ),
    ).toBeNull();
  });

  it('returns null (never throws) when the GitHub App is not configured', async () => {
    // No GITHUB_APP_* env → mintInstallationToken throws → degrade.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 })),
    );
    const { user, workspace } = await makeWorkspace('e@example.com');
    await connectRepo(workspace.id, 'inst-4');
    expect(
      await githubCodeScanningProxyService.listAnalyses(
        { userId: user.id, workspaceId: workspace.id },
        REPO_REF,
      ),
    ).toBeNull();
  });

  it('returns null when the code-scanning API is unavailable (404)', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string): Promise<Response> => {
        if (url.endsWith('/access_tokens')) {
          return new Response(
            JSON.stringify({
              token: 'ghs_x',
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('not found', { status: 404 }); // code scanning not enabled
      }),
    );
    const { user, workspace } = await makeWorkspace('f@example.com');
    await connectRepo(workspace.id, 'inst-5');
    expect(
      await githubCodeScanningProxyService.listAnalyses(
        { userId: user.id, workspaceId: workspace.id },
        REPO_REF,
      ),
    ).toBeNull();
  });
});

describe('githubCodeScanningProxyService — no cross-tenant leakage (AC1)', () => {
  it('a workspace cannot resolve a repo connected under ANOTHER workspace', async () => {
    stubGithub();
    // The repo is connected in workspace B…
    const { workspace: wsB } = await makeWorkspace('owner-b@example.com');
    await connectRepo(wsB.id, 'inst-b');
    // …but workspace A (its own user) audits the same owner/name.
    const { user: userA, workspace: wsA } = await makeWorkspace('owner-a@example.com');

    const analyses = await githubCodeScanningProxyService.listAnalyses(
      { userId: userA.id, workspaceId: wsA.id },
      REPO_REF,
    );
    expect(analyses).toBeNull();
  });

  it('never persists the minted token (negative DB read)', async () => {
    stubGithub();
    const { user, workspace } = await makeWorkspace('g@example.com');
    await connectRepo(workspace.id, 'inst-6');
    await githubCodeScanningProxyService.listAnalyses(
      { userId: user.id, workspaceId: workspace.id },
      REPO_REF,
    );
    const rows = await withSystemContext(async (tx) => ({
      installations: await tx.githubInstallation.findMany(),
      repos: await tx.githubRepo.findMany(),
    }));
    expect(JSON.stringify(rows)).not.toContain('ghs_installtoken');
  });
});
