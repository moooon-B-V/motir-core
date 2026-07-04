import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { db } from '@/lib/db';
import { mintJobToken } from '@/lib/ai/jobToken';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { GET as analysesGET } from '@/app/api/internal/ai/code-scanning/analyses/route';
import { GET as sarifGET } from '@/app/api/internal/ai/code-scanning/sarif/route';
import { createTestWorkspace, createTestProject } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';
import type { NormalizedRepo } from '@/lib/git/types';

// MOTIR-1605 — the code-scanning proxy READ-BACK routes end-to-end through the
// REAL route handlers, against a real Postgres. Exercises both §4 grants (service
// bearer + job token), the 400s on bad params, and the happy path that resolves a
// connected repo → installation token → code-scanning read (the ai→core seam the
// `code_audit` job drives).

const SERVICE_SECRET = 'core-callback-secret-test';
const REPO: NormalizedRepo = {
  providerRepoId: '111',
  owner: 'moooon',
  name: 'motir-core',
  defaultBranch: 'main',
};
const ANALYSES_BODY = [{ id: 42, tool: { name: 'CodeQL' }, created_at: '2026-07-01T00:00:00Z' }];
const SARIF_DOC = { version: '2.1.0', runs: [] };

beforeEach(async () => {
  process.env['CORE_CALLBACK_SECRET'] = SERVICE_SECRET;
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

function req(path: string, opts: { bearer?: string; token?: string }): Request {
  const headers: Record<string, string> = {};
  if (opts.bearer !== undefined) headers['authorization'] = `Bearer ${opts.bearer}`;
  if (opts.token !== undefined) headers['x-motir-job-token'] = opts.token;
  return new Request(`http://core${path}`, { headers });
}

function stubGithub(): void {
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
      const json = (b: unknown) =>
        new Response(JSON.stringify(b), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url.endsWith('/access_tokens'))
        return json({
          token: 'ghs_it',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      if (url.includes('/code-scanning/analyses/')) return json(SARIF_DOC);
      if (url.includes('/code-scanning/analyses')) return json(ANALYSES_BODY);
      return new Response('nf', { status: 404 });
    }),
  );
}

async function seedConnectedProject() {
  const { workspace, owner } = await createTestWorkspace({ name: 'Acme' });
  const project = await createTestProject({
    workspaceId: workspace.id,
    actorUserId: owner.id,
    identifier: 'ACME',
    name: 'Acme',
  });
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: { installationId: 'inst-1', accountLogin: 'moooon', accountType: 'User' },
    repos: [REPO],
  });
  const token = mintJobToken({
    userId: owner.id,
    workspaceId: workspace.id,
    projectId: project.id,
  });
  return { token };
}

describe('GET /api/internal/ai/code-scanning/* — read-back auth', () => {
  it('rejects a missing/wrong service bearer with 401', async () => {
    const res = await analysesGET(
      req('/api/internal/ai/code-scanning/analyses?repoRef=a/b', { token: 'x' }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'service_unauthorized' });
  });

  it('rejects a missing/tampered job token with 401', async () => {
    const res = await sarifGET(
      req('/api/internal/ai/code-scanning/sarif?repoRef=a/b&analysisId=1', {
        bearer: SERVICE_SECRET,
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'token_invalid' });
  });
});

describe('GET /api/internal/ai/code-scanning/* — validation', () => {
  it('400 when repoRef is missing', async () => {
    const { token } = await seedConnectedProject();
    const res = await analysesGET(
      req('/api/internal/ai/code-scanning/analyses', { bearer: SERVICE_SECRET, token }),
    );
    expect(res.status).toBe(400);
  });

  it('400 when analysisId is not a non-negative integer', async () => {
    const { token } = await seedConnectedProject();
    const res = await sarifGET(
      req('/api/internal/ai/code-scanning/sarif?repoRef=moooon/motir-core&analysisId=nope', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/internal/ai/code-scanning/* — happy path (connected repo)', () => {
  it('returns the code-scanning analyses for a connected repo', async () => {
    stubGithub();
    const { token } = await seedConnectedProject();
    const res = await analysesGET(
      req('/api/internal/ai/code-scanning/analyses?repoRef=moooon/motir-core', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      analyses: [{ id: 42, toolName: 'CodeQL', createdAt: '2026-07-01T00:00:00Z' }],
    });
  });

  it('returns the SARIF document for one analysis', async () => {
    stubGithub();
    const { token } = await seedConnectedProject();
    const res = await sarifGET(
      req('/api/internal/ai/code-scanning/sarif?repoRef=moooon/motir-core&analysisId=42', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sarif: SARIF_DOC });
  });

  it('returns { analyses: null } for a repo not connected in the workspace', async () => {
    stubGithub();
    const { token } = await seedConnectedProject();
    const res = await analysesGET(
      req('/api/internal/ai/code-scanning/analyses?repoRef=someone/else', {
        bearer: SERVICE_SECRET,
        token,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ analyses: null });
  });
});
