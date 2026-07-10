// GitLab-integration E2E seed + webhook helpers (Story 7.23 · MOTIR-1480) — the
// GitLab mirror of github-seed.ts.
//
// GitLab is simulated at two REAL shipped seams, so every assertion is on Motir's
// observable behavior:
//
//   * The workspace CONNECTION (+ its selected project) is seeded through the
//     shipped repositories under `provider: 'gitlab'` — a GitLab connection is the
//     SHARED `GithubInstallation` entity, exactly as `gitlabConnectionService`
//     persists it (MOTIR-1474/1478). Tokens are opaque placeholders: the MR
//     status-sync path never decrypts them (it resolves repo → work item → status),
//     the same shortcut `gitlabWebhookService`'s vitest uses — so no real crypto is
//     needed here.
//   * MR deliveries are POSTed to the REAL `/api/gitlab/webhook` route carrying the
//     `X-Gitlab-Token` header GitLab echoes (the same GITLAB_WEBHOOK_SECRET
//     playwright.config.ts hands the dev server), so the MOTIR-1475 token gate + the
//     full shared status-sync path run end-to-end.

import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { withSystemContext } from '@/lib/workspaces/context';
import { E2E_GITLAB_PROJECT, E2E_GITLAB_USER, E2E_GITLAB_WEBHOOK_SECRET } from './gitlab-const';

/** The synthetic per-workspace GitLab connection id `gitlabConnectionService` mints
 *  (GitLab has no host "installation id"). */
function connectionId(workspaceId: string): string {
  return `gitlab-ws-${workspaceId}`;
}

/** Seed the workspace's GitLab connection (the shared `GithubInstallation` under
 *  `provider: 'gitlab'`), as the OAuth callback leaves it. Idempotent. Tokens are
 *  opaque — the status-sync path never reads them. */
export async function seedGitlabConnection(workspaceId: string): Promise<void> {
  await withSystemContext((tx) =>
    githubInstallationRepository.upsertGitlabConnection(
      {
        installationId: connectionId(workspaceId),
        workspaceId,
        accountLogin: E2E_GITLAB_USER.username,
        accountType: 'User',
        accessTokenEncrypted: 'enc',
        refreshTokenEncrypted: 'enc',
        tokenExpiresAt: new Date('2999-01-01T00:00:00.000Z'),
      },
      tx,
    ),
  );
}

/** Connect one project to the workspace's EXISTING GitLab connection (a
 *  `github_repo` row under `provider: 'gitlab'`) — the state the in-app project
 *  picker (MOTIR-1478) leaves behind, seeded directly so the E2E needs no GitLab
 *  API. Throws when the workspace has no GitLab connection yet. */
export async function seedGitlabProject(
  workspaceId: string,
  project: {
    providerRepoId: string;
    owner: string;
    name: string;
    defaultBranch: string;
  } = E2E_GITLAB_PROJECT,
): Promise<void> {
  await withSystemContext(async (tx) => {
    const conn = await githubInstallationRepository.findByWorkspaceAndProvider(
      workspaceId,
      'gitlab',
      tx,
    );
    if (!conn) throw new Error(`no GitLab connection for workspace ${workspaceId}`);
    await githubRepoRepository.upsert(
      {
        installationId: conn.id,
        repoId: project.providerRepoId,
        owner: project.owner,
        name: project.name,
        defaultBranch: project.defaultBranch,
        provider: 'gitlab',
      },
      tx,
    );
  });
}

/** POST one GitLab webhook delivery to the real route. By default it carries the
 *  configured `X-Gitlab-Token`; pass `{ token: null }` for an UNAUTHENTIC delivery
 *  (→ 401, rejected before any processing). Returns the raw response; callers
 *  assert status + the `result` body (the route awaits the full service handling
 *  before responding — the authoritative completion signal). */
export function postGitlabWebhook(
  request: Page['request'] | APIRequestContext,
  event: string,
  payload: unknown,
  opts: { token?: string | null } = {},
): Promise<APIResponse> {
  const token = opts.token === undefined ? E2E_GITLAB_WEBHOOK_SECRET : opts.token;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-gitlab-event': event,
  };
  if (token !== null) headers['x-gitlab-token'] = token;
  return request.post('/api/gitlab/webhook', { headers, data: JSON.stringify(payload) });
}

/** A minimal GitLab `merge_request` delivery carrying every field the provider
 *  seam's `parseChangeRequestEvent` + the shared sync read (project id, MR iid /
 *  state / action, source branch, title). `action` is the MR action; `state` is the
 *  resulting MR state (GitLab's `merged` is its own state, not a boolean). */
export function mergeRequestPayload(args: {
  action: 'open' | 'reopen' | 'close' | 'merge' | 'update';
  iid: number;
  title: string;
  sourceBranch: string;
  state: 'opened' | 'closed' | 'merged' | 'locked';
  projectId?: string;
}): Record<string, unknown> {
  return {
    object_kind: 'merge_request',
    project: { id: Number(args.projectId ?? E2E_GITLAB_PROJECT.providerRepoId) },
    object_attributes: {
      iid: args.iid,
      action: args.action,
      state: args.state,
      title: args.title,
      source_branch: args.sourceBranch,
    },
  };
}
