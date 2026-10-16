import { generateKeyPairSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getOrgInstallation,
  listInstallationRepositoryIds,
  OrgInstallationReadError,
} from '@/lib/github/orgInstallation';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';

// The two App-level reads behind the fleet readiness verdict (Story MOTIR-8699 ·
// MOTIR-8713). Only `fetch` is faked.

const TARGET = { org: 'acme-connected', installationId: '880011', role: 'provisioning' as const };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

let handler: (url: string) => Response | Promise<Response>;

beforeEach(() => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  vi.stubEnv('GITHUB_STUDIO_APP_ID', '4242');
  vi.stubEnv('GITHUB_STUDIO_APP_PRIVATE_KEY', privateKey);
  _resetInstallationTokenCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/access_tokens')) {
        return json(200, {
          token: 'ghs_secret',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      return handler(u);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('getOrgInstallation', () => {
  it('answers the installation with its permissions, events and selection', async () => {
    handler = () =>
      json(200, {
        id: 880011,
        permissions: { organization_self_hosted_runners: 'write', metadata: 'read' },
        events: ['workflow_job', 'push'],
        repository_selection: 'selected',
        suspended_at: null,
      });
    expect(await getOrgInstallation('acme-connected', 'provisioning')).toEqual({
      id: '880011',
      permissions: { organization_self_hosted_runners: 'write', metadata: 'read' },
      events: ['workflow_job', 'push'],
      repositorySelection: 'selected',
      suspendedAt: null,
    });
  });

  it('answers null on 404 — the App is not installed', async () => {
    handler = () => json(404, { message: 'Not Found' });
    expect(await getOrgInstallation('acme-connected', 'provisioning')).toBeNull();
  });

  it('throws a typed error carrying the status on any other refusal', async () => {
    handler = () => json(502, { message: 'Bad Gateway' });
    await expect(getOrgInstallation('acme-connected', 'provisioning')).rejects.toMatchObject({
      name: 'OrgInstallationReadError',
      status: 502,
    });
  });

  it('throws with a null status when GitHub is unreachable', async () => {
    handler = () => {
      throw new TypeError('fetch failed');
    };
    const err = await getOrgInstallation('acme-connected', 'provisioning').catch((e) => e);
    expect(err).toBeInstanceOf(OrgInstallationReadError);
    expect(err.status).toBeNull();
  });
});

describe('listInstallationRepositoryIds', () => {
  it('follows the Link header to the last page — 120 repositories, 120 ids', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => 5_000 + i);
    const seen: string[] = [];
    handler = (u) => {
      seen.push(u);
      const page = Number(new URL(u).searchParams.get('page') ?? '1');
      const slice = ids.slice((page - 1) * 100, page * 100);
      const link: Record<string, string> =
        page === 1
          ? {
              link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next", <https://api.github.com/installation/repositories?per_page=100&page=2>; rel="last"',
            }
          : {};
      return json(200, { total_count: 120, repositories: slice.map((id) => ({ id })) }, link);
    };

    expect(await listInstallationRepositoryIds(TARGET)).toEqual(ids);
    expect(seen).toHaveLength(2);
  });

  it('throws the typed error on a refused page', async () => {
    handler = () => json(403, { message: 'Forbidden' });
    await expect(listInstallationRepositoryIds(TARGET)).rejects.toMatchObject({ status: 403 });
  });
});
