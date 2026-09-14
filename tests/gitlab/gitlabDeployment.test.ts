import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { gitlabWebhookService } from '@/lib/services/gitlabWebhookService';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { encryptToken } from '@/lib/gitlab/tokenCrypto';
import { withSystemContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// GitLab preview URLs (Story MOTIR-4906 · MOTIR-5332) — a GitLab `deployment` hook
// normalized through the SAME seam method GitHub implements and written by the
// SAME `repoDeploymentService.record`. The integration cases enter at the route
// with a valid token, on real Postgres, with `fetch` stubbed to throw so any call
// to the GitLab host fails the test.

const SECRET = 'gitlab-test-secret';
const KEY = 'a'.repeat(64);
const PROJECT_ID = '42';
const SHA = 'c'.repeat(40);

function hook(
  over: {
    status?: string;
    url?: string | null;
    at?: string;
    deploymentId?: number;
    projectId?: number;
  } = {},
): Record<string, unknown> {
  return {
    object_kind: 'deployment',
    status: over.status ?? 'success',
    status_changed_at: over.at ?? '2026-09-13 12:00:00 +0200',
    deployment_id: over.deploymentId ?? 15,
    deployable_id: 796,
    environment: 'review/feat-x',
    environment_slug: 'review-feat-x',
    environment_external_url:
      over.url === undefined ? 'https://feat-x.review.example.com' : over.url,
    project: { id: over.projectId ?? Number(PROJECT_ID), name: 'acme' },
    ref: 'feat/x',
    sha: SHA,
  };
}

const gitlab = getGitProvider('gitlab');

describe('gitlab.parseDeploymentStatusEvent', () => {
  it.each([
    ['created', 'pending'],
    ['running', 'in_progress'],
    ['success', 'success'],
    ['failed', 'failure'],
    ['canceled', 'canceled'],
  ])('maps status %s → %s', (status, state) => {
    expect(gitlab.parseDeploymentStatusEvent!(hook({ status }))).toEqual({
      providerRepoId: PROJECT_ID,
      providerDeploymentId: '15',
      commitSha: SHA,
      ref: 'feat/x',
      environment: 'review/feat-x',
      state,
      environmentUrl: 'https://feat-x.review.example.com',
      // GitLab's non-ISO `YYYY-MM-DD HH:MM:SS +ZZZZ`, read with its offset.
      occurredAt: new Date('2026-09-13T10:00:00Z'),
    });
  });

  it('reads environment_external_url, null when absent', () => {
    expect(gitlab.parseDeploymentStatusEvent!(hook({ url: null }))?.environmentUrl).toBeNull();
  });

  it('accepts an ISO status_changed_at and a UTC suffix', () => {
    expect(
      gitlab.parseDeploymentStatusEvent!(hook({ at: '2026-09-13T10:00:00Z' }))?.occurredAt,
    ).toEqual(new Date('2026-09-13T10:00:00Z'));
    expect(
      gitlab.parseDeploymentStatusEvent!(hook({ at: '2026-09-13 10:00:00 UTC' }))?.occurredAt,
    ).toEqual(new Date('2026-09-13T10:00:00Z'));
  });

  it('refuses an unknown status, another object_kind, and a body missing a field', () => {
    expect(gitlab.parseDeploymentStatusEvent!(hook({ status: 'blocked' }))).toBeNull();
    expect(gitlab.parseDeploymentStatusEvent!({ ...hook(), object_kind: 'pipeline' })).toBeNull();
    expect(gitlab.parseDeploymentStatusEvent!({ ...hook(), sha: undefined })).toBeNull();
    expect(gitlab.parseDeploymentStatusEvent!({ ...hook(), status_changed_at: 'soon' })).toBeNull();
  });
});

// ── the hook, end to end ────────────────────────────────────────────────────

const fetchSpy = vi.fn(async () => {
  throw new Error('deployment ingestion made an outbound call');
});

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('GITLAB_WEBHOOK_SECRET', SECRET);
  vi.stubEnv('GITLAB_APP_CLIENT_ID', 'client-id');
  vi.stubEnv('GITLAB_APP_CLIENT_SECRET', 'client-secret');
  vi.stubEnv('GITLAB_TOKEN_ENCRYPTION_KEY', KEY);
  fetchSpy.mockClear();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function connectedProject() {
  const user = await usersService.createUser({
    email: 'owner@ex.com',
    password: 'hunter2hunter2',
    name: 'Owner',
  });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  await withSystemContext(async (tx) => {
    const connection = await githubInstallationRepository.upsertGitlabConnection(
      {
        installationId: `gitlab-ws-${workspace.id}`,
        workspaceId: workspace.id,
        organizationId: workspace.organizationId,
        accountLogin: 'octocat',
        accountType: 'User',
        accessTokenEncrypted: encryptToken('good-token'),
        refreshTokenEncrypted: encryptToken('r'),
        tokenExpiresAt: new Date(Date.now() + 3_600_000),
      },
      tx,
    );
    await githubRepoRepository.upsert(
      {
        installationId: connection.id,
        workspaceId: workspace.id,
        organizationId: workspace.organizationId,
        repoId: PROJECT_ID,
        owner: 'octocat',
        name: 'acme',
        defaultBranch: 'main',
        archived: false,
        provider: 'gitlab',
      },
      tx,
    );
  });
  return { workspace };
}

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/gitlab/webhook', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'x-gitlab-event': 'Deployment Hook',
      'x-gitlab-token': SECRET,
    },
  });
}

async function rows() {
  return adminDb.repoDeployment.findMany({ orderBy: { createdAt: 'asc' } });
}

describe('POST /api/gitlab/webhook — deployment', () => {
  it('writes a repo_deployment row with provider gitlab for a connected project', async () => {
    const { workspace } = await connectedProject();
    const { POST } = await import('@/app/api/gitlab/webhook/route');

    const res = await POST(post(hook()));
    expect(res.status).toBe(200);
    expect((await res.json()).result).toEqual({
      event: 'deployment_status',
      outcome: 'recorded',
    });
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      workspaceId: workspace.id,
      provider: 'gitlab',
      providerDeploymentId: '15',
      commitSha: SHA,
      ref: 'feat/x',
      environment: 'review/feat-x',
      state: 'success',
      environmentUrl: 'https://feat-x.review.example.com',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('re-delivery leaves one row; an older status_changed_at does not overwrite a newer one', async () => {
    await connectedProject();
    await gitlabWebhookService.handleEvent('Deployment Hook', hook());
    await gitlabWebhookService.handleEvent('Deployment Hook', hook());
    expect(await rows()).toHaveLength(1);

    const late = await gitlabWebhookService.handleEvent(
      'Deployment Hook',
      hook({ status: 'running', at: '2026-09-13 11:59:00 +0200', url: null }),
    );
    expect(late).toEqual({ event: 'deployment_status', outcome: 'stale' });
    const [row] = await rows();
    expect(row!.state).toBe('success');
  });

  it('stores a non-http(s) environment_external_url as null', async () => {
    await connectedProject();
    await gitlabWebhookService.handleEvent('Deployment Hook', hook({ url: 'javascript:alert(1)' }));
    expect((await rows())[0]!.environmentUrl).toBeNull();
  });

  it('an unconnected project is unknown_repo and writes nothing', async () => {
    await connectedProject();
    await expect(
      gitlabWebhookService.handleEvent('Deployment Hook', hook({ projectId: 999 })),
    ).resolves.toEqual({ event: 'deployment_status', outcome: 'unknown_repo' });
    expect(await rows()).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a malformed deployment hook is refused', async () => {
    await connectedProject();
    await expect(
      gitlabWebhookService.handleEvent('Deployment Hook', { object_kind: 'deployment' }),
    ).resolves.toEqual({ event: 'deployment_status', outcome: 'malformed' });
  });
});
