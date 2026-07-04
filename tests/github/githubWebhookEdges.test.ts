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
import { _resetInstallationTokenCache } from '@/lib/github/appAuth';
import { withSystemContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../helpers/db';

// Story 7.10 · MOTIR-896 — the webhook state machine's GUARD arms (the malformed
// / unknown / unresolvable deliveries) the per-subtask suites leave uncovered.
// GitHub redelivers aggressively and forwards whatever a repo emits, so every
// one of these must resolve to a TYPED no-op outcome — never a crash (a thrown
// error 500s the route and GitHub retries the poison delivery forever).

const PASSWORD = 'hunter2hunter2';
const INSTALLATION_ID = 'inst-edges';
const REPO_PROVIDER_ID = '888';

async function makeScenario(email: string) {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Owner' });
  const { workspace } = await workspacesService.createWorkspace({
    name: 'Acme',
    ownerUserId: user.id,
  });
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

function prPayload(opts: {
  action: string;
  identifier?: string;
  title?: string;
  headRef?: string;
  number?: number;
  state?: 'open' | 'closed';
  merged?: boolean;
  user?: { id: number } | null;
  installationId?: string | null;
  repoId?: number;
}) {
  return {
    action: opts.action,
    ...(opts.installationId === null
      ? {}
      : {
          installation: {
            id: opts.installationId ?? INSTALLATION_ID,
            account: { login: 'moooon', type: 'Organization' },
          },
        }),
    repository: { id: opts.repoId ?? Number(REPO_PROVIDER_ID) },
    pull_request: {
      number: opts.number ?? 7,
      state: opts.state ?? 'open',
      merged: opts.merged ?? false,
      title: opts.title ?? `Some change (${opts.identifier ?? 'ACME-1'})`,
      head: { ref: opts.headRef ?? `feat/${opts.identifier ?? 'ACME-1'}-a-change` },
      ...(opts.user === null ? {} : { user: opts.user ?? { id: 4242 } }),
    },
  };
}

function checkSuitePayload(opts: {
  conclusion: string | null;
  headSha: string;
  prNumbers?: number[];
  installationId?: string;
  repoId?: number;
}) {
  return {
    action: 'completed',
    installation: {
      id: opts.installationId ?? INSTALLATION_ID,
      account: { login: 'moooon', type: 'Organization' },
    },
    repository: { id: opts.repoId ?? Number(REPO_PROVIDER_ID) },
    check_suite: {
      head_sha: opts.headSha,
      head_branch: null,
      status: 'completed',
      conclusion: opts.conclusion,
      app: { slug: 'github-actions' },
      pull_requests: (opts.prNumbers ?? []).map((n) => ({ number: n })),
    },
  };
}

function checkRunPayload(opts: {
  conclusion: string | null;
  headSha: string;
  prNumbers?: number[];
}) {
  return {
    action: 'completed',
    installation: {
      id: INSTALLATION_ID,
      account: { login: 'moooon', type: 'Organization' },
    },
    repository: { id: Number(REPO_PROVIDER_ID) },
    check_run: {
      head_sha: opts.headSha,
      status: 'completed',
      conclusion: opts.conclusion,
      name: 'build',
      check_suite: { head_branch: null },
      pull_requests: (opts.prNumbers ?? []).map((n) => ({ number: n })),
    },
  };
}

async function statusOf(workItemId: string): Promise<string> {
  const row = await db.workItem.findUnique({ where: { id: workItemId } });
  return row!.status;
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

describe('githubWebhookService — malformed deliveries are typed no-ops (MOTIR-896)', () => {
  it('a non-object body is ignored as malformed', async () => {
    expect(await githubWebhookService.handleEvent('pull_request', null)).toEqual({
      event: 'ignored',
      reason: 'malformed_body',
    });
  });

  it('an installation event with no installation id is malformed', async () => {
    expect(await githubWebhookService.handleEvent('installation', { action: 'created' })).toEqual({
      event: 'installation',
      outcome: 'malformed',
    });
  });

  it('an installation_repositories event with no installation id is malformed', async () => {
    expect(
      await githubWebhookService.handleEvent('installation_repositories', { action: 'added' }),
    ).toEqual({ event: 'installation_repositories', outcome: 'malformed' });
  });

  it('a NON-delete installation event for an unbound installation is skipped', async () => {
    const result = await githubWebhookService.handleEvent('installation', {
      action: 'created',
      installation: { id: 'inst-nobody', account: { login: 'x', type: 'User' } },
    });
    expect(result).toEqual({ event: 'installation', outcome: 'skipped_unbound' });
  });

  it('a pull_request payload missing the PR object is malformed', async () => {
    const result = await githubWebhookService.handleEvent('pull_request', {
      action: 'opened',
      installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
      repository: { id: Number(REPO_PROVIDER_ID) },
      pull_request: { title: 'no number' },
    });
    expect(result).toEqual({ event: 'pull_request', outcome: 'malformed' });
  });

  it('a pull_request with no installation id resolves unknown_installation', async () => {
    const result = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', installationId: null }),
    );
    expect(result).toEqual({ event: 'pull_request', outcome: 'unknown_installation' });
  });

  it('a check event with no installation id is a typed no-op', async () => {
    const payload = checkSuitePayload({ conclusion: 'success', headSha: 'sha1' }) as Record<
      string,
      unknown
    >;
    delete payload['installation'];
    expect(await githubWebhookService.handleEvent('check_suite', payload)).toEqual({
      event: 'ci',
      outcome: 'unknown_installation',
    });
  });

  it('a check_suite object missing head_sha is malformed', async () => {
    const result = await githubWebhookService.handleEvent('check_suite', {
      action: 'completed',
      installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
      repository: { id: Number(REPO_PROVIDER_ID) },
      check_suite: { status: 'completed' },
    });
    expect(result).toEqual({ event: 'ci', outcome: 'malformed' });
  });

  it('a check_run object missing head_sha is malformed', async () => {
    const result = await githubWebhookService.handleEvent('check_run', {
      action: 'completed',
      installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
      repository: { id: Number(REPO_PROVIDER_ID) },
      check_run: { status: 'completed' },
    });
    expect(result).toEqual({ event: 'ci', outcome: 'malformed' });
  });

  it('a check event with no check payload is malformed', async () => {
    const result = await githubWebhookService.handleEvent('check_suite', {
      action: 'completed',
      installation: { id: INSTALLATION_ID, account: { login: 'moooon', type: 'Organization' } },
      repository: { id: Number(REPO_PROVIDER_ID) },
    });
    expect(result).toEqual({ event: 'ci', outcome: 'malformed' });
  });

  it('a check event for an unknown installation is a typed no-op', async () => {
    const result = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'success', headSha: 'sha1', installationId: 'inst-nobody' }),
    );
    expect(result).toEqual({ event: 'ci', outcome: 'unknown_installation' });
  });
});

describe('githubWebhookService — unresolvable deliveries against a real installation (MOTIR-896)', () => {
  it('a PR on a repo outside the grant mirror is unknown_repo', async () => {
    await makeScenario('edge-a@example.com');
    const result = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', repoId: 999999 }),
    );
    expect(result).toEqual({ event: 'pull_request', outcome: 'unknown_repo' });
  });

  it('a check on a repo outside the grant mirror is unknown_repo', async () => {
    await makeScenario('edge-b@example.com');
    const result = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'success', headSha: 'sha1', repoId: 999999 }),
    );
    expect(result).toEqual({ event: 'ci', outcome: 'unknown_repo' });
  });

  it('a check whose PR list matches no stored PR is no_pull_request', async () => {
    await makeScenario('edge-c@example.com');
    const result = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'success', headSha: 'sha1', prNumbers: [42] }),
    );
    expect(result).toEqual({ event: 'ci', outcome: 'no_pull_request' });
  });

  it('a check on a stored PR with NO linked work item is no_work_item', async () => {
    await makeScenario('edge-d@example.com');
    // Store a PR that resolves to no work item (unknown identifier) — the row
    // persists with a null link…
    const opened = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: 'ZZZ-9' }),
    );
    expect(opened).toEqual({ event: 'pull_request', outcome: 'no_work_item' });
    // …so its checks are a clean no-op.
    const result = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'success', headSha: 'sha1', prNumbers: [7] }),
    );
    expect(result).toEqual({ event: 'ci', outcome: 'no_work_item' });
  });

  it('a failing check_run flips the linked item to ciState failing with the failure summary', async () => {
    const { item } = await makeScenario('edge-e@example.com');
    await githubWebhookService.handleEvent('pull_request', prPayload({ action: 'opened' }));

    const result = await githubWebhookService.handleEvent(
      'check_run',
      checkRunPayload({ conclusion: 'failure', headSha: 'sha2', prNumbers: [7] }),
    );

    expect(result).toMatchObject({ event: 'ci', outcome: 'failed', ciState: 'failing' });
    const row = await db.workItem.findUnique({ where: { id: item.id } });
    expect(row!.ciState).toBe('failing');
    const comments = await db.comment.findMany({ where: { workItemId: item.id } });
    expect(comments.some((c) => c.bodyMd.includes('CI failed'))).toBe(true);

    // A REDELIVERY of the same failing conclusion is a noop that still reports
    // the failing state (the non-success redelivery arm).
    const redelivered = await githubWebhookService.handleEvent(
      'check_run',
      checkRunPayload({ conclusion: 'failure', headSha: 'sha2', prNumbers: [7] }),
    );
    expect(redelivered).toMatchObject({ event: 'ci', outcome: 'noop', ciState: 'failing' });
    const after = await db.comment.findMany({ where: { workItemId: item.id } });
    expect(after).toHaveLength(comments.length); // no duplicate comment
  });

  it('a check on a PR whose linked work item was DELETED is no_work_item', async () => {
    const { item } = await makeScenario('edge-x@example.com');
    await githubWebhookService.handleEvent('pull_request', prPayload({ action: 'opened' }));
    // Deleting the item SetNulls the PR's link (the schema's onDelete), so the
    // check resolves a stored PR with no work item — the clean no-op.
    await withSystemContext(async (tx) => {
      await tx.workItemRevision.deleteMany({ where: { workItemId: item.id } });
      await tx.workItem.delete({ where: { id: item.id } });
    });

    const result = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'success', headSha: 'sha4', prNumbers: [7] }),
    );

    expect(result).toMatchObject({ event: 'ci', outcome: 'no_work_item' });
  });
});

describe('githubWebhookService — work-item resolution edges (MOTIR-896)', () => {
  it('a PR with NO title still resolves via the head ref', async () => {
    const { item } = await makeScenario('edge-t@example.com');
    const payload = prPayload({ action: 'opened' }) as {
      pull_request: Record<string, unknown>;
    };
    delete payload.pull_request['title'];
    const result = await githubWebhookService.handleEvent('pull_request', payload);
    expect(result).toMatchObject({ outcome: 'transitioned', workItemId: item.id });
  });

  it('a key whose project exists but whose item number does not resolves nothing', async () => {
    await makeScenario('edge-u@example.com');
    const result = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', identifier: 'ACME-999' }),
    );
    expect(result).toEqual({ event: 'pull_request', outcome: 'no_work_item' });
  });

  it('a bound member DENIED on a private project → the transition retries as the owner', async () => {
    const { user, workspace, project, item } = await makeScenario('edge-v@example.com');
    // A private project admits only explicit project members; the bound author
    // is a workspace member but NOT a project member, so the authority throws
    // ProjectAccessDeniedError and the sync retries as the owner (the
    // prefer-the-author-but-never-strand-the-move arm).
    const dev = await usersService.createUser({
      email: 'dev-denied@example.com',
      password: PASSWORD,
      name: 'Dev',
    });
    await withSystemContext(async (tx) => {
      await tx.workspaceMembership.create({
        data: { userId: dev.id, workspaceId: workspace.id, role: 'member' },
      });
      await githubIdentityRepository.upsertForUser(
        {
          userId: dev.id,
          githubUserId: '4242',
          githubLogin: 'dev-denied',
          avatarUrl: null,
          accessTokenEncrypted: 'x',
        },
        tx,
      );
      await tx.project.update({ where: { id: project.id }, data: { accessLevel: 'private' } });
    });

    const result = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', user: { id: 4242 } }),
    );

    expect(result).toMatchObject({
      outcome: 'transitioned',
      workItemId: item.id,
      toStatus: 'in_review',
    });
    // Attributed to the OWNER (the retry), not the denied author.
    const revision = await db.workItemRevision.findFirst({
      where: { workItemId: item.id },
      orderBy: { changedAt: 'desc' },
    });
    expect(revision!.changedById).toBe(user.id);
  });

  it('a check on a linked PR with NO owner membership is a clean no-op', async () => {
    const { user, workspace, item } = await makeScenario('edge-w@example.com');
    await githubWebhookService.handleEvent('pull_request', prPayload({ action: 'opened' }));
    await withSystemContext(async (tx) => {
      await tx.workspaceMembership.deleteMany({
        where: { workspaceId: workspace.id, userId: user.id },
      });
    });

    const result = await githubWebhookService.handleEvent(
      'check_suite',
      checkSuitePayload({ conclusion: 'success', headSha: 'sha3', prNumbers: [7] }),
    );

    expect(result).toMatchObject({ event: 'ci', outcome: 'no_work_item' });
    const comments = await db.comment.findMany({ where: { workItemId: item.id } });
    expect(comments).toHaveLength(0);
  });

  it('dedupes repeated key candidates and skips unknown project prefixes, still resolving the item', async () => {
    const { item } = await makeScenario('edge-f@example.com');
    // `ZZZ-9` matches no project (the continue arm); `ACME-1` appears in BOTH
    // the head ref and the title (the dedupe arm); the item still resolves.
    const result = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({
        action: 'opened',
        headRef: 'feat/ACME-1-a-change',
        title: 'Fixes ZZZ-9 ACME-1 (ACME-1)',
      }),
    );
    expect(result).toMatchObject({
      event: 'pull_request',
      outcome: 'transitioned',
      workItemId: item.id,
      toStatus: 'in_review',
    });
  });

  it('a PR payload with NO author attributes the transition to the workspace owner', async () => {
    const { user, item } = await makeScenario('edge-g@example.com');
    const result = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', user: null }),
    );
    expect(result).toMatchObject({ outcome: 'transitioned', workItemId: item.id });
    const revision = await db.workItemRevision.findFirst({
      where: { workItemId: item.id, changedById: user.id },
      orderBy: { changedAt: 'desc' },
    });
    expect(revision).not.toBeNull();
  });

  it('an author with a BOUND identity but no workspace membership falls back to the owner', async () => {
    const { user, item } = await makeScenario('edge-h@example.com');
    // A real user with a bound GitHub identity — but NOT a member of the
    // installation's workspace (the L611 false arm).
    const outsider = await usersService.createUser({
      email: 'outsider@example.com',
      password: PASSWORD,
      name: 'Outsider',
    });
    await withSystemContext(async (tx) => {
      await githubIdentityRepository.upsertForUser(
        {
          userId: outsider.id,
          githubUserId: '31337',
          githubLogin: 'outsider',
          avatarUrl: null,
          accessTokenEncrypted: 'x',
        },
        tx,
      );
    });

    const result = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened', user: { id: 31337 } }),
    );

    expect(result).toMatchObject({ outcome: 'transitioned', workItemId: item.id });
    const revision = await db.workItemRevision.findFirst({
      where: { workItemId: item.id },
      orderBy: { changedAt: 'desc' },
    });
    expect(revision!.changedById).toBe(user.id); // the owner, not the outsider
  });

  it('no owner and no bound author → access_denied (nothing can author the move)', async () => {
    const { user, workspace, item } = await makeScenario('edge-i@example.com');
    // Degenerate state: the workspace owner's membership is gone (system-level
    // removal) and the PR author is unbound — no principal can author the move.
    await withSystemContext(async (tx) => {
      await tx.workspaceMembership.deleteMany({
        where: { workspaceId: workspace.id, userId: user.id },
      });
    });

    const result = await githubWebhookService.handleEvent(
      'pull_request',
      prPayload({ action: 'opened' }),
    );

    expect(result).toEqual({
      event: 'pull_request',
      outcome: 'access_denied',
      workItemId: item.id,
    });
    expect(await statusOf(item.id)).toBe('in_progress');
  });
});

describe('githubWebhookService — installation reconcile account fallbacks (MOTIR-896)', () => {
  it('a reconcile delivery MISSING the account object keeps the stored account fields', async () => {
    const { workspace } = await makeScenario('edge-j@example.com');
    // The reconcile refetches the authoritative repo set through the seam.
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    vi.stubEnv('GITHUB_APP_ID', '999');
    vi.stubEnv('GITHUB_APP_PRIVATE_KEY', privateKey);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request): Promise<Response> => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const json = (o: unknown): Response =>
          new Response(JSON.stringify(o), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        if (url.includes('/access_tokens')) {
          return json({
            token: 'ghs_reconcile',
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          });
        }
        if (url.includes('/installation/repositories')) {
          return json({
            repositories: [
              { id: 888, name: 'acme', owner: { login: 'moooon' }, default_branch: 'main' },
            ],
          });
        }
        throw new Error(`unexpected fetch in test: ${url}`);
      }),
    );

    const result = await githubWebhookService.handleEvent('installation', {
      action: 'new_permissions_accepted',
      installation: { id: INSTALLATION_ID }, // no account object on the delivery
    });

    expect(result).toEqual({ event: 'installation', outcome: 'synced' });
    const row = await withSystemContext((tx) =>
      tx.githubInstallation.findUnique({ where: { installationId: INSTALLATION_ID } }),
    );
    // The stored account survives the account-less delivery (the ?? fallback).
    expect(row).toMatchObject({ accountLogin: 'moooon', accountType: 'Organization' });
    void workspace;
  });
});
