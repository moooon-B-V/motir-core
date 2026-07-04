import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { githubInstallationService } from '@/lib/services/githubInstallationService';
import { githubWebhookService } from '@/lib/services/githubWebhookService';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { withSystemContext } from '@/lib/workspaces/context';
import { inngest } from '@/lib/jobs/client';
import { truncateAuthTables } from '../helpers/db';

// Story 7.10 · MOTIR-892 — the inbound webhook status-sync state machine, against
// a real Postgres (the motir-core convention). Covers: the PR-lifecycle →
// workflow-status transitions through the SHIPPED workItemsService, actor
// attribution (bound author vs the owner fallback), idempotency under a CONCURRENT
// redelivery race, the installation grant mirror (reconcile / remove / unbound),
// and the no-crash paths (no linked work item, an illegal transition).

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-1';
const REPO_PROVIDER_ID = '555';

async function makeWorkspace(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
  return { user, workspace };
}

/** A workspace + project + a work item already moved to `in_progress` (so a
 *  PR-opened → in_review is a legal transition), plus a seeded installation + repo. */
async function makeScenario(email: string) {
  const { user, workspace } = await makeWorkspace(email);
  const project = await projectsService.createProject({
    workspaceId: workspace.id,
    actorUserId: user.id,
    name: 'Acme',
    identifier: 'ACME',
  });
  const ctx = { userId: user.id, workspaceId: workspace.id };
  const item = await workItemsService.createWorkItem(
    { projectId: project.id, kind: 'task', title: 'A tracked change' },
    ctx,
  );
  await workItemsService.updateStatus(item.id, 'in_progress', ctx);
  await githubInstallationService.persistInstallation({
    workspaceId: workspace.id,
    installation: {
      installationId: INSTALLATION_ID,
      accountLogin: 'moooon',
      accountType: 'Organization',
    },
    repos: [
      { providerRepoId: REPO_PROVIDER_ID, owner: 'moooon', name: 'acme', defaultBranch: 'main' },
    ],
  });
  return { user, workspace, project, item, ctx };
}

/** A GitHub `pull_request` delivery body, referencing a work item by its head ref. */
function prPayload(opts: {
  action: string;
  identifier: string;
  number?: number;
  state?: 'open' | 'closed';
  merged?: boolean;
  authorGithubUserId?: number;
  installationId?: string;
  repoId?: number;
}) {
  return {
    action: opts.action,
    installation: {
      id: opts.installationId ?? INSTALLATION_ID,
      account: { login: 'moooon', type: 'Organization' },
    },
    repository: { id: opts.repoId ?? Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: opts.number ?? 7,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      title: `Some change (${opts.identifier})`,
      head: { ref: `feat/${opts.identifier}-a-change` },
      user: { id: opts.authorGithubUserId ?? 4242 },
    },
  };
}

async function statusOf(workItemId: string): Promise<string> {
  const row = await db.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
}

async function statusRevisions(workItemId: string) {
  return db.workItemRevision.findMany({
    where: { workItemId },
    orderBy: { changedAt: 'asc' },
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

describe('githubWebhookService — pull_request → status sync', () => {
  it('opened → in_review, closed+merged → done, closed+unmerged → in_progress', async () => {
    const s = await makeScenario('pr@example.com');

    const opened = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier }),
    );
    expect(opened).toMatchObject({
      event: 'pull_request',
      outcome: 'transitioned',
      toStatus: 'in_review',
    });
    expect(await statusOf(s.item.id)).toBe('in_review');

    // The PR row is upserted and linked to the resolved work item.
    const prRow = await db.githubPullRequest.findFirst({ where: { number: 7 } });
    expect(prRow).toMatchObject({ state: 'open', merged: false, workItemId: s.item.id });

    const merged = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'closed', identifier: s.item.identifier, state: 'closed', merged: true }),
    );
    expect(merged).toMatchObject({ outcome: 'transitioned', toStatus: 'done' });
    expect(await statusOf(s.item.id)).toBe('done');
  });

  it('closed WITHOUT merging returns the item to in_progress (the abandoned-work path)', async () => {
    const s = await makeScenario('unmerged@example.com');
    // Open first so the item sits in in_review.
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier }),
    );
    expect(await statusOf(s.item.id)).toBe('in_review');

    const closed = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: s.item.identifier,
        state: 'closed',
        merged: false,
      }),
    );
    expect(closed).toMatchObject({ outcome: 'transitioned', toStatus: 'in_progress' });
    expect(await statusOf(s.item.id)).toBe('in_progress');
  });

  it('records the transition in the activity log as the BOUND author when the PR author is a member', async () => {
    const s = await makeScenario('bound@example.com');
    // A second workspace member who has connected their GitHub identity.
    const dev = await usersService.createUser({
      email: 'dev@example.com',
      password: PASSWORD,
      name: 'Dev',
    });
    await withSystemContext(async (tx) => {
      await workspaceMembershipRepository.create(
        { userId: dev.id, workspaceId: s.workspace.id, role: 'member' },
        tx,
      );
      await githubIdentityRepository.upsertForUser(
        {
          userId: dev.id,
          githubUserId: '77',
          githubLogin: 'dev',
          avatarUrl: null,
          accessTokenEncrypted: 'x',
        },
        tx,
      );
    });

    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier, authorGithubUserId: 77 }),
    );

    const revs = await statusRevisions(s.item.id);
    const last = revs.at(-1)!;
    expect(last.diff).toMatchObject({ status: { to: 'in_review' } });
    expect(last.changedById).toBe(dev.id); // the bound author, not the owner
  });

  it('falls back to the workspace owner when the PR author is not a bound member', async () => {
    const s = await makeScenario('fallback@example.com');
    await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier, authorGithubUserId: 999999 }),
    );
    const last = (await statusRevisions(s.item.id)).at(-1)!;
    expect(last.diff).toMatchObject({ status: { to: 'in_review' } });
    expect(last.changedById).toBe(s.user.id); // the workspace owner
  });

  it('is idempotent under a CONCURRENT redelivery race — one transition, one PR row', async () => {
    const s = await makeScenario('race@example.com');
    const payload = prPayload({ action: 'opened', identifier: s.item.identifier });

    // Two identical deliveries at once (GitHub redelivers): the unique-(repo,number)
    // upsert race is caught (P2002 → converge), and the row-locked updateStatus
    // serializes so exactly ONE transition is recorded.
    const results = await Promise.all([
      githubWebhookService.handleEvent('pull_request', payload),
      githubWebhookService.handleEvent('pull_request', payload),
    ]);
    for (const r of results) expect(r.event).toBe('pull_request');

    expect(await statusOf(s.item.id)).toBe('in_review');
    const prRows = await db.githubPullRequest.findMany({ where: { number: 7 } });
    expect(prRows).toHaveLength(1);
    const inReviewRevs = (await statusRevisions(s.item.id)).filter(
      (r) => (r.diff as { status?: { to?: string } }).status?.to === 'in_review',
    );
    expect(inReviewRevs).toHaveLength(1);
  });

  it('a sequential redelivery of the same event is a no-op (already in the target)', async () => {
    const s = await makeScenario('redeliver@example.com');
    const payload = prPayload({ action: 'opened', identifier: s.item.identifier });
    await githubWebhookService.handleEvent('pull_request', payload);
    const again = await githubWebhookService.handleEvent('pull_request', payload);
    expect(again).toMatchObject({ outcome: 'noop', toStatus: 'in_review' });
  });

  it('a PR that references no work item upserts the PR row (null link) and does not transition', async () => {
    const s = await makeScenario('nowi@example.com');
    const res = await githubWebhookService.handleEvent('pull_request', {
      ...prPayload({ action: 'opened', identifier: 'ACME' }),
      pull_request: {
        number: 9,
        state: 'open',
        merged: false,
        title: 'no key here',
        head: { ref: 'feat/misc' },
        user: { id: 4242 },
      },
    });
    expect(res).toMatchObject({ event: 'pull_request', outcome: 'no_work_item' });
    expect(await statusOf(s.item.id)).toBe('in_progress'); // untouched
    const prRow = await db.githubPullRequest.findFirst({ where: { number: 9 } });
    expect(prRow).toMatchObject({ workItemId: null });
  });

  it('an illegal transition logs a no-op instead of crashing (item unchanged)', async () => {
    // A fresh item still in `todo`: a merged PR targets `done`, but todo→done is
    // NOT a legal edge in the default workflow — the webhook logs a no-op, never
    // throws, and the item is left as-is.
    const { user, workspace } = await makeWorkspace('illegal@example.com');
    const project = await projectsService.createProject({
      workspaceId: workspace.id,
      actorUserId: user.id,
      name: 'Beta',
      identifier: 'BETA',
    });
    const item = await workItemsService.createWorkItem(
      { projectId: project.id, kind: 'task', title: 'Still in todo' },
      { userId: user.id, workspaceId: workspace.id },
    );
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: { installationId: 'inst-2', accountLogin: 'moooon', accountType: 'User' },
      repos: [{ providerRepoId: '888', owner: 'moooon', name: 'beta', defaultBranch: 'main' }],
    });

    const res = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'closed',
        identifier: item.identifier,
        state: 'closed',
        merged: true,
        installationId: 'inst-2',
        repoId: 888,
      }),
    );
    expect(res).toMatchObject({ event: 'pull_request', outcome: 'illegal_transition' });
    expect(await statusOf(item.id)).toBe('todo'); // unchanged, no crash
  });

  it('a PR on an unknown installation is a no-op', async () => {
    const s = await makeScenario('unknown@example.com');
    const res = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: s.item.identifier, installationId: 'inst-nope' }),
    );
    expect(res).toMatchObject({ event: 'pull_request', outcome: 'unknown_installation' });
  });

  it('a non-lifecycle PR action (synchronize) is ignored', async () => {
    const s = await makeScenario('sync@example.com');
    const res = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'synchronize', identifier: s.item.identifier }),
    );
    expect(res).toMatchObject({ event: 'pull_request', outcome: 'ignored_action' });
  });
});

describe('githubWebhookService — installation grant mirror', () => {
  it('installation deleted removes the installation (idempotent)', async () => {
    const { workspace } = await makeWorkspace('del@example.com');
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: { installationId: 'inst-del', accountLogin: 'moooon', accountType: 'User' },
      repos: [{ providerRepoId: '1', owner: 'moooon', name: 'r', defaultBranch: 'main' }],
    });

    const first = await githubWebhookService.handleEvent('installation', {
      action: 'deleted',
      installation: { id: 'inst-del' },
    });
    expect(first).toMatchObject({ event: 'installation', outcome: 'removed' });
    const gone = await withSystemContext((tx) =>
      tx.githubInstallation.findUnique({ where: { installationId: 'inst-del' } }),
    );
    expect(gone).toBeNull();

    // Redelivery after the row is gone — still a clean no-crash.
    const second = await githubWebhookService.handleEvent('installation', {
      action: 'deleted',
      installation: { id: 'inst-del' },
    });
    expect(second).toMatchObject({ event: 'installation', outcome: 'removed' });
  });

  it('an installation event for an unbound installation is skipped', async () => {
    const res = await githubWebhookService.handleEvent('installation_repositories', {
      action: 'added',
      installation: { id: 'inst-unbound' },
    });
    expect(res).toMatchObject({ event: 'installation_repositories', outcome: 'skipped_unbound' });
  });

  it('installation_repositories reconciles the selected repos from the authoritative set', async () => {
    const { publicKey: _pub, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    void _pub;
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string): Promise<Response> => {
        const u = String(url);
        if (u.includes('/access_tokens')) {
          return new Response(
            JSON.stringify({
              token: 'ghs_x',
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u.includes('/installation/repositories')) {
          return new Response(
            JSON.stringify({
              repositories: [
                { id: 555, name: 'acme', default_branch: 'main', owner: { login: 'moooon' } },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );

    const { workspace } = await makeWorkspace('recon@example.com');
    // Seed with a DIFFERENT repo that the authoritative set no longer includes.
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: 'inst-recon',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [{ providerRepoId: '111', owner: 'moooon', name: 'stale', defaultBranch: 'main' }],
    });

    const res = await githubWebhookService.handleEvent('installation_repositories', {
      action: 'added',
      installation: { id: 'inst-recon', account: { login: 'moooon', type: 'Organization' } },
    });
    expect(res).toMatchObject({ event: 'installation_repositories', outcome: 'synced' });

    const repos = await withSystemContext((tx) =>
      tx.githubRepo.findMany({ where: { installation: { installationId: 'inst-recon' } } }),
    );
    expect(repos.map((r) => r.repoId)).toEqual(['555']); // reconciled to the authoritative set
  });
});

describe('githubWebhookService — code-graph index enqueue (MOTIR-1500)', () => {
  /** Stub the token + repositories endpoints; the authoritative set is `repos`. */
  function stubGithub(repos: Array<{ id: number; name: string }>): void {
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
        const u = String(url);
        if (u.includes('/access_tokens')) {
          return new Response(
            JSON.stringify({
              token: 'ghs_x',
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (u.includes('/installation/repositories')) {
          return new Response(
            JSON.stringify({
              repositories: repos.map((r) => ({
                id: r.id,
                name: r.name,
                default_branch: 'main',
                owner: { login: 'moooon' },
              })),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
  }

  it('enqueues one code-graph-index job per NEWLY-added repo and skips repos already present', async () => {
    // Authoritative set = the already-present `keep` (id 111) + a freshly-added
    // `fresh` (id 222). Only `fresh` should enqueue.
    stubGithub([
      { id: 111, name: 'keep' },
      { id: 222, name: 'fresh' },
    ]);
    const sendSpy = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);

    const { workspace } = await makeWorkspace('cg-enqueue@example.com');
    await githubInstallationService.persistInstallation({
      workspaceId: workspace.id,
      installation: {
        installationId: 'inst-cg',
        accountLogin: 'moooon',
        accountType: 'Organization',
      },
      repos: [{ providerRepoId: '111', owner: 'moooon', name: 'keep', defaultBranch: 'main' }],
    });
    // The bind above (persistInstallation directly) doesn't enqueue; clear anything.
    sendSpy.mockClear();

    const res = await githubWebhookService.handleEvent('installation_repositories', {
      action: 'added',
      installation: { id: 'inst-cg', account: { login: 'moooon', type: 'Organization' } },
    });
    expect(res).toMatchObject({ event: 'installation_repositories', outcome: 'synced' });

    const indexCalls = sendSpy.mock.calls.filter(
      ([e]) => (e as { name?: string }).name === 'system.code-graph-index',
    );
    expect(indexCalls).toHaveLength(1);
    expect((indexCalls[0]![0] as { data: Record<string, unknown> }).data).toMatchObject({
      installationId: 'inst-cg',
      workspaceId: workspace.id,
      repoOwner: 'moooon',
      repoName: 'fresh',
      defaultBranch: 'main',
    });
  });
});

describe('githubWebhookService — push → code-graph refresh enqueue (MOTIR-893)', () => {
  /** A GitHub `push` delivery body. The makeScenario repo is id 555 / branch `main`. */
  function pushPayload(
    opts: {
      ref?: string;
      repoId?: number;
      installationId?: string;
      deleted?: boolean;
    } = {},
  ) {
    return {
      ref: opts.ref ?? 'refs/heads/main',
      after: 'a'.repeat(40),
      ...(opts.deleted !== undefined ? { deleted: opts.deleted } : {}),
      repository: { id: opts.repoId ?? Number(REPO_PROVIDER_ID) },
      installation: { id: opts.installationId ?? INSTALLATION_ID },
    };
  }

  // `vi.spyOn` returns the SAME mock (with its accumulated history) when the
  // method is already spied, and the file's afterEach doesn't restore mocks —
  // so restore here to keep each push test's call history isolated.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A fresh, history-clean spy on the enqueue transport. */
  function spySend() {
    const spy = vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] } as never);
    spy.mockClear();
    return spy;
  }

  /** The spy's calls that enqueued the REFRESH event. */
  function refreshCalls(sendSpy: { mock: { calls: unknown[][] } }) {
    return sendSpy.mock.calls.filter(
      (call) => (call[0] as { name?: string }).name === 'system.code-graph-refresh',
    );
  }

  it('a default-branch push enqueues the incremental refresh job (async, not inline)', async () => {
    const { workspace } = await makeScenario('push-default@example.com');
    const sendSpy = spySend();

    const res = await githubWebhookService.handleEvent('push', pushPayload());
    expect(res).toEqual({ event: 'push', outcome: 'refresh_enqueued' });

    const calls = refreshCalls(sendSpy);
    expect(calls).toHaveLength(1);
    expect((calls[0]![0] as { data: Record<string, unknown> }).data).toEqual({
      installationId: INSTALLATION_ID,
      workspaceId: workspace.id,
      repoOwner: 'moooon',
      repoName: 'acme',
      defaultBranch: 'main',
    });
  });

  it('a push to a NON-default branch is ignored — no refresh enqueued', async () => {
    await makeScenario('push-feature@example.com');
    const sendSpy = spySend();

    const res = await githubWebhookService.handleEvent(
      'push',
      pushPayload({ ref: 'refs/heads/subtask/MOTIR-893-feature' }),
    );
    expect(res).toEqual({ event: 'push', outcome: 'ignored_ref' });
    expect(refreshCalls(sendSpy)).toHaveLength(0);
  });

  it('a tag push and a branch deletion are ignored (not branch pushes)', async () => {
    await makeScenario('push-tag@example.com');
    const sendSpy = spySend();

    const tag = await githubWebhookService.handleEvent(
      'push',
      pushPayload({ ref: 'refs/tags/v1.0.0' }),
    );
    expect(tag).toEqual({ event: 'push', outcome: 'ignored_ref' });

    const del = await githubWebhookService.handleEvent('push', pushPayload({ deleted: true }));
    expect(del).toEqual({ event: 'push', outcome: 'ignored_ref' });

    expect(refreshCalls(sendSpy)).toHaveLength(0);
  });

  it('a push to a repo we do not track (or an unknown installation) is a clean no-op', async () => {
    await makeScenario('push-unknown@example.com');
    const sendSpy = spySend();

    const repo = await githubWebhookService.handleEvent('push', pushPayload({ repoId: 999 }));
    expect(repo).toEqual({ event: 'push', outcome: 'unknown_repo' });

    const inst = await githubWebhookService.handleEvent(
      'push',
      pushPayload({ installationId: 'inst-nope' }),
    );
    expect(inst).toEqual({ event: 'push', outcome: 'unknown_installation' });

    expect(refreshCalls(sendSpy)).toHaveLength(0);
  });

  it('an enqueue transport failure never fails the ack (best-effort, fast 2xx)', async () => {
    await makeScenario('push-enqueue-down@example.com');
    vi.spyOn(inngest, 'send').mockRejectedValue(new Error('queue down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await githubWebhookService.handleEvent('push', pushPayload());
    expect(res).toEqual({ event: 'push', outcome: 'refresh_enqueued' });
    expect(errorSpy).toHaveBeenCalled(); // dropped refresh is logged, not thrown

    errorSpy.mockRestore();
  });
});

describe('githubWebhookService — dispatch', () => {
  it('ignores an unhandled event type (a fast no-op ack)', async () => {
    const res = await githubWebhookService.handleEvent('ping', { zen: 'Keep it simple' });
    expect(res).toMatchObject({ event: 'ignored' });
  });
});
