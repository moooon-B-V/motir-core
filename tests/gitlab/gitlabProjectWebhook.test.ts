import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { gitlabConnectionService } from '@/lib/services/gitlabConnectionService';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { encryptToken } from '@/lib/gitlab/tokenCrypto';
import { withSystemContext } from '@/lib/workspaces/context';
import {
  GitlabWebhookNotConfiguredError,
  GitlabWebhookRegistrationError,
} from '@/lib/gitlab/errors';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-5349 — connecting a GitLab project REGISTERS the project webhook the connect
// screen promises ("adds a webhook for merge-request, pipeline, push and deployment
// events"), re-connecting converges on ONE hook, and disconnecting removes it.
// Real Postgres for every DB path; only `fetch` (the GitLab host) is replaced — by a
// small STATEFUL fake of the projects + hooks endpoints, so idempotency is asserted
// against what GitLab would hold rather than against a call count alone.

const PASSWORD = 'hunter2hunter2';
const KEY = 'a'.repeat(64);
const SECRET = 'webhook-secret';
const BASE = 'https://motir.test';
const HOOK_URL = `${BASE}/api/gitlab/webhook`;

beforeEach(async () => {
  await truncateAuthTables();
  vi.stubEnv('GITLAB_APP_CLIENT_ID', 'client-id');
  vi.stubEnv('GITLAB_APP_CLIENT_SECRET', 'client-secret');
  vi.stubEnv('GITLAB_TOKEN_ENCRYPTION_KEY', KEY);
  vi.stubEnv('GITLAB_WEBHOOK_SECRET', SECRET);
  vi.stubEnv('MOTIR_BASE_URL', BASE);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function scenario(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  await withSystemContext((tx) =>
    githubInstallationRepository.upsertGitlabConnection(
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
    ),
  );
  return { userId: user.id, workspaceId: workspace.id };
}

interface FakeHook {
  id: number;
  url: string;
  token?: string;
  [flag: string]: unknown;
}

/** A stateful fake GitLab: two member projects (12, 34) and a hooks table per
 *  project. `refuse` makes the named method answer with that status. */
function fakeGitlab(opts: { refuse?: { method: string; status: number } } = {}) {
  const hooks = new Map<string, FakeHook[]>([
    ['12', []],
    ['34', []],
  ]);
  let nextId = 1;
  const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];

  const fetchMock = vi.fn(async (input: string, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    calls.push({ method, url, body });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer good-token');

    if (opts.refuse && opts.refuse.method === method && url.includes('/hooks')) {
      return new Response('{"message":"403 Forbidden"}', { status: opts.refuse.status });
    }
    const hookPath = url.match(/\/api\/v4\/projects\/([^/]+)\/hooks(?:\/(\d+))?$/);
    if (hookPath) {
      const list = hooks.get(decodeURIComponent(hookPath[1]!));
      if (!list) return new Response('{"message":"404 Project Not Found"}', { status: 404 });
      const hookId = hookPath[2] ? Number(hookPath[2]) : null;
      if (method === 'GET') return Response.json(list);
      if (method === 'POST') {
        const created = { ...body, id: nextId++ } as FakeHook;
        list.push(created);
        return Response.json(created, { status: 201 });
      }
      const idx = list.findIndex((h) => h.id === hookId);
      if (idx < 0) return new Response('{"message":"404 Not found"}', { status: 404 });
      if (method === 'PUT') {
        list[idx] = { ...list[idx]!, ...body, id: hookId! };
        return Response.json(list[idx]);
      }
      if (method === 'DELETE') {
        list.splice(idx, 1);
        return new Response(null, { status: 204 });
      }
    }
    if (url.includes('/api/v4/projects?')) {
      return Response.json([
        { id: 12, path: 'core', path_with_namespace: 'moooon/core', default_branch: 'main' },
        { id: 34, path: 'web', path_with_namespace: 'moooon/web', default_branch: 'main' },
      ]);
    }
    throw new Error(`unexpected GitLab call ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { hooks, calls };
}

async function connectedRepoIds(ctx: { userId: string; workspaceId: string }) {
  const read = await gitlabConnectionService.getConnectionForWorkspace(ctx);
  return (read?.repos ?? []).map((r) => r.repoId).sort();
}

describe('gitlabConnectionService — project webhook registration (MOTIR-5349)', () => {
  it('connecting a project registers ONE hook at Motir’s URL with the secret and all four event flags', async () => {
    const ctx = await scenario('hook-connect@example.com');
    const gitlab = fakeGitlab();

    await gitlabConnectionService.connectProject(ctx, '12');

    expect(gitlab.hooks.get('12')).toEqual([
      expect.objectContaining({
        url: HOOK_URL,
        token: SECRET,
        enable_ssl_verification: true,
        merge_requests_events: true,
        pipeline_events: true,
        push_events: true,
        deployment_events: true,
      }),
    ]);
    expect(gitlab.hooks.get('34')).toEqual([]);
    expect(await connectedRepoIds(ctx)).toEqual(['12']);
  });

  it('re-connecting is idempotent — the existing hook is UPDATED, never a second one', async () => {
    const ctx = await scenario('hook-reconnect@example.com');
    const gitlab = fakeGitlab();

    await gitlabConnectionService.connectProject(ctx, '12');
    vi.stubEnv('GITLAB_WEBHOOK_SECRET', 'rotated-secret');
    await gitlabConnectionService.connectProject(ctx, '12');

    const hooks = gitlab.hooks.get('12')!;
    expect(hooks).toHaveLength(1);
    expect(hooks[0]!.token).toBe('rotated-secret'); // the refresh reaches an old hook
    expect(gitlab.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(gitlab.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });

  it('collapses duplicate Motir hooks to one and leaves a hook at another URL alone', async () => {
    const ctx = await scenario('hook-dupes@example.com');
    const gitlab = fakeGitlab();
    gitlab.hooks.set('12', [
      { id: 901, url: HOOK_URL },
      { id: 902, url: HOOK_URL },
      { id: 903, url: 'https://ci.example.com/hook' },
    ]);

    await gitlabConnectionService.connectProject(ctx, '12');

    expect(gitlab.hooks.get('12')!.map((h) => h.id)).toEqual([901, 903]);
    expect(gitlab.hooks.get('12')![0]).toMatchObject({ token: SECRET, deployment_events: true });
  });

  it('refuses to connect — and writes no row — when GITLAB_WEBHOOK_SECRET is unset', async () => {
    const ctx = await scenario('hook-nosecret@example.com');
    const gitlab = fakeGitlab();
    vi.stubEnv('GITLAB_WEBHOOK_SECRET', '');

    await expect(gitlabConnectionService.connectProject(ctx, '12')).rejects.toBeInstanceOf(
      GitlabWebhookNotConfiguredError,
    );
    expect(gitlab.hooks.get('12')).toEqual([]);
    expect(await connectedRepoIds(ctx)).toEqual([]);
  });

  it('refuses to connect — and writes no row — when GitLab refuses the hook (e.g. 403, not a Maintainer)', async () => {
    const ctx = await scenario('hook-forbidden@example.com');
    fakeGitlab({ refuse: { method: 'POST', status: 403 } });

    const err = await gitlabConnectionService.connectProject(ctx, '12').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitlabWebhookRegistrationError);
    expect((err as GitlabWebhookRegistrationError).status).toBe(403);
    expect(await connectedRepoIds(ctx)).toEqual([]);
  });

  it('disconnecting a project removes its hook and keeps the others', async () => {
    const ctx = await scenario('hook-disconnect@example.com');
    const gitlab = fakeGitlab();
    await gitlabConnectionService.connectProject(ctx, '12');
    await gitlabConnectionService.connectProject(ctx, '34');
    gitlab.hooks.get('12')!.push({ id: 999, url: 'https://ci.example.com/hook' });

    await gitlabConnectionService.disconnectProject(ctx, '12');

    expect(gitlab.hooks.get('12')!.map((h) => h.url)).toEqual(['https://ci.example.com/hook']);
    expect(gitlab.hooks.get('34')).toHaveLength(1);
    expect(await connectedRepoIds(ctx)).toEqual(['34']);
  });

  it('disconnecting the whole connection removes every project’s hook while the token still exists', async () => {
    const ctx = await scenario('hook-disconnect-all@example.com');
    const gitlab = fakeGitlab();
    await gitlabConnectionService.connectProject(ctx, '12');
    await gitlabConnectionService.connectProject(ctx, '34');

    await gitlabConnectionService.disconnect(ctx);

    expect(gitlab.hooks.get('12')).toEqual([]);
    expect(gitlab.hooks.get('34')).toEqual([]);
    expect(await gitlabConnectionService.getConnectionForWorkspace(ctx)).toBeNull();
  });

  it('a hook-removal failure never blocks the disconnect (best-effort, logged)', async () => {
    const ctx = await scenario('hook-disconnect-fail@example.com');
    const gitlab = fakeGitlab();
    await gitlabConnectionService.connectProject(ctx, '12');
    fakeGitlab({ refuse: { method: 'GET', status: 500 } });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await gitlabConnectionService.disconnectProject(ctx, '12');

    expect(await connectedRepoIds(ctx)).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
    expect(gitlab.hooks.get('12')).toHaveLength(1); // left behind, and said so
  });
});
