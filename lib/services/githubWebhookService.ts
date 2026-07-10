import { Prisma } from '@prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import { getGitProvider } from '@/lib/git';
import type {
  GitProviderId,
  NormalizedChangeRequest,
  NormalizedStatusEvent,
} from '@/lib/git/types';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { githubInstallationService } from './githubInstallationService';
import { enqueueCodeGraphRefresh, enqueueNewlyAddedRepos } from '@/lib/github/indexEnqueue';
import {
  syncChangeRequestStatus,
  type ChangeRequestContextResolution,
  type ChangeRequestSyncResult,
} from './changeRequestStatusSync';
import {
  applyCiStatusFeedback,
  type CiFeedbackContextResolution,
  type CiFeedbackResult,
} from './changeRequestCiFeedback';

// githubWebhookService (Story 7.10 · MOTIR-892) — the inbound-webhook logic
// layer: the `installation` / `installation_repositories` grant-mirror + the
// `pull_request` → work-item status-sync state machine. The HTTP route
// (`app/api/github/webhook`) owns ONLY signature verification + dispatch; ALL
// logic is here (CLAUDE.md 4-layer). Every status write goes through the shipped
// `workItemsService` — the integration NEVER writes `workflow_status` raw (the
// write-authority rule); every payload is normalized through the `GitProvider`
// seam (`@/lib/git`), so this holds no GitHub-specific parsing.
//
// Design notes carried from the plan + the shipped reality:
//   * The webhook has NO active workspace, so the DB reads/writes run under
//     `withSystemContext` (the trusted-writer RLS escape, as `persistInstallation`
//     already does). The status transition itself is `workItemsService.updateStatus`,
//     called AFTER the context tx (it opens its own transaction) — mirroring the
//     automation engine, the shipped precedent for a non-human status move.
//   * Attribution + edit authority: `updateStatus` gates on `assertCanEdit`, so
//     the actor MUST be a member of the installation's workspace with edit rights.
//     We attribute to the PR author's bound Motir user when they are a workspace
//     member (the "bound GitHub identity" the card wants in the activity log),
//     else fall back to the workspace OWNER — a workspace manager who always
//     passes the edit gate. This is exactly the automation engine's
//     "transition as the owner" pattern (there is no per-tenant system member,
//     and the meta system principal can't pass a tenant workspace's edit gate).
//   * The installation → workspace BINDING is established by the connect flow
//     (the post-install redirect carries the workspace, as every GitHub-App
//     product does); a webhook alone cannot know the target workspace for a fresh
//     install. So the webhook MIRRORS GitHub's grant onto an ALREADY-bound
//     installation (reconcile repos / remove on uninstall) and no-ops a delivery
//     for an unbound installation.

const PROVIDER: GitProviderId = 'github';

/** PR actions that drive the status machine. Other actions (`synchronize`,
 *  `edited`, `labeled`, …) are ignored — they carry no lifecycle change the card
 *  syncs. */
const HANDLED_PR_ACTIONS = new Set(['opened', 'reopened', 'closed']);

export type GithubWebhookResult =
  | { event: 'ignored'; reason: string }
  | { event: 'installation'; outcome: 'synced' | 'removed' | 'skipped_unbound' | 'malformed' }
  | { event: 'installation_repositories'; outcome: 'synced' | 'skipped_unbound' | 'malformed' }
  | {
      event: 'push';
      outcome:
        | 'refresh_enqueued' // a default-branch push → the incremental refresh job is queued
        | 'ignored_ref' // a non-branch push (tag / delete) or a non-default branch — no refresh
        | 'unknown_installation'
        | 'unknown_repo';
    }
  | ChangeRequestSyncResult
  | CiFeedbackResult;

export const githubWebhookService = {
  /**
   * Handle one verified delivery. `eventType` is the `X-GitHub-Event` header;
   * `payload` is the already-parsed JSON body (the route verified the signature
   * over the RAW body BEFORE parsing). Returns a small result the route logs and
   * the tests assert on. Idempotent under redelivery: a re-applied transition is
   * a no-op, and the PR/installation upserts converge (a concurrent-redelivery
   * unique-constraint race is caught and re-read).
   */
  async handleEvent(eventType: string, payload: unknown): Promise<GithubWebhookResult> {
    const body = asRecord(payload);
    if (!body) return { event: 'ignored', reason: 'malformed_body' };

    switch (eventType) {
      case 'installation':
        return this.handleInstallation(body);
      case 'installation_repositories':
        return this.handleInstallationRepositories(body);
      case 'pull_request':
        return this.handlePullRequest(body);
      case 'push':
        return this.handlePush(body);
      case 'check_suite':
      case 'check_run':
        return this.handleCiStatus(body);
      default:
        // `ping` and every event we don't sync land here — a fast 2xx no-op.
        return { event: 'ignored', reason: `unhandled_event:${eventType}` };
    }
  },

  async handleInstallation(body: Record<string, unknown>): Promise<GithubWebhookResult> {
    const installationId = readInstallationId(body);
    if (!installationId) return { event: 'installation', outcome: 'malformed' };

    if (body['action'] === 'deleted') {
      await githubInstallationService.removeInstallation(installationId);
      // `removeInstallation` is idempotent; either way the grant is gone.
      return { event: 'installation', outcome: 'removed' };
    }

    const synced = await reconcileInstallation(installationId, body);
    return { event: 'installation', outcome: synced ? 'synced' : 'skipped_unbound' };
  },

  async handleInstallationRepositories(
    body: Record<string, unknown>,
  ): Promise<GithubWebhookResult> {
    const installationId = readInstallationId(body);
    if (!installationId) return { event: 'installation_repositories', outcome: 'malformed' };
    const synced = await reconcileInstallation(installationId, body);
    return { event: 'installation_repositories', outcome: synced ? 'synced' : 'skipped_unbound' };
  },

  /**
   * Handle a `push` delivery — the incremental code-graph feed trigger
   * (MOTIR-893). A push to a connected repo's DEFAULT branch enqueues the
   * debounced `system.code-graph-refresh` job (best-effort, post-tx) and
   * returns immediately — the fetch + re-index never run inline in the
   * webhook, so the 2xx stays fast. Any other ref (a feature branch, a tag, a
   * branch deletion) is a clean no-op: the graph tracks what SHIPPED, and
   * merged PRs land on the default branch as a push, so this one trigger also
   * covers "refresh on merge" without a second, coalescing-duplicate hook.
   */
  async handlePush(body: Record<string, unknown>): Promise<GithubWebhookResult> {
    const provider = getGitProvider(PROVIDER);
    const push = provider.parsePushEvent(body);
    // Not a branch push we refresh on (tag / delete / malformed) — a fast no-op.
    if (!push) return { event: 'push', outcome: 'ignored_ref' };

    const installationId = readInstallationId(body);
    if (!installationId) return { event: 'push', outcome: 'unknown_installation' };

    // Resolve the stored installation + repo under system context (reads only).
    const resolved = await withSystemContext(async (tx) => {
      const installation = await githubInstallationRepository.findByInstallationId(
        installationId,
        tx,
      );
      if (!installation) return { kind: 'unknown_installation' as const };
      const repo = await githubRepoRepository.findByInstallationAndRepoId(
        installation.id,
        push.providerRepoId,
        tx,
      );
      if (!repo) return { kind: 'unknown_repo' as const };
      return {
        kind: 'resolved' as const,
        workspaceId: installation.workspaceId,
        repoOwner: repo.owner,
        repoName: repo.name,
        defaultBranch: repo.defaultBranch,
      };
    });

    if (resolved.kind === 'unknown_installation')
      return { event: 'push', outcome: 'unknown_installation' };
    if (resolved.kind === 'unknown_repo') return { event: 'push', outcome: 'unknown_repo' };

    // Only the STORED default branch feeds the graph — the graph mirrors the
    // repo's shipped mainline, per tenant, per repo (the N-repo cardinality).
    if (push.branch !== resolved.defaultBranch) return { event: 'push', outcome: 'ignored_ref' };

    // POST-tx, best-effort: the ack never hinges on the queue. The job fetches
    // the default branch's CURRENT head at run time, so debounced/coalesced
    // pushes index the newest state once.
    await enqueueCodeGraphRefresh({
      installationId,
      workspaceId: resolved.workspaceId,
      repoOwner: resolved.repoOwner,
      repoName: resolved.repoName,
      defaultBranch: resolved.defaultBranch,
    });
    return { event: 'push', outcome: 'refresh_enqueued' };
  },

  async handlePullRequest(body: Record<string, unknown>): Promise<GithubWebhookResult> {
    if (!HANDLED_PR_ACTIONS.has(String(body['action']))) {
      return { event: 'pull_request', outcome: 'ignored_action' };
    }
    const provider = getGitProvider(PROVIDER);
    const cr = provider.parseChangeRequestEvent(body);
    if (!cr) return { event: 'pull_request', outcome: 'malformed' };
    // The canonical lifecycle this delivery maps to (opened → in_review, merged →
    // done, closed-unmerged → todo).
    const lifecycle = provider.changeRequestLifecycle(cr);

    // Drive the linked work item through THE shared status-sync state machine
    // (`changeRequestStatusSync`) — the same path GitLab uses (MOTIR-1475). The
    // only GitHub-specific part is resolving the connection + repo + author from
    // the App delivery's payload, which this provider supplies via the resolver.
    return syncChangeRequestStatus(cr, lifecycle, (tx) =>
      resolveGithubChangeRequestContext(body, cr, tx),
    );
  },

  /**
   * Handle a `check_suite` / `check_run` delivery — the CI feedback half of the
   * closed loop (MOTIR-894). Normalize the payload through the `GitProvider` seam,
   * then drive the linked work item's verification feedback through THE shared
   * consumer (`applyCiStatusFeedback`) — the same path GitLab's `pipeline` hook
   * uses (MOTIR-1477). The only GitHub-specific part is resolving the installation
   * → repo from the App delivery + the PR-checks URL, which this service supplies
   * via the resolver.
   */
  async handleCiStatus(body: Record<string, unknown>): Promise<GithubWebhookResult> {
    const provider = getGitProvider(PROVIDER);
    const event = provider.parseCiStatusEvent(body);
    if (!event) return { event: 'ci', outcome: 'malformed' };

    return applyCiStatusFeedback(event, (tx) => resolveGithubCiContext(body, event, tx));
  },
};

/** Resolve the GitHub connection + repo + checks-URL builder for a CI event — the
 *  provider-specific half the shared CI-feedback consumer needs. Keys on the App
 *  delivery's installation id (as the status/push paths do); the checks link points
 *  at the PR's checks tab on github.com. */
async function resolveGithubCiContext(
  body: Record<string, unknown>,
  event: NormalizedStatusEvent,
  tx: Prisma.TransactionClient,
): Promise<CiFeedbackContextResolution> {
  const installationId = readInstallationId(body);
  if (!installationId) return { kind: 'unknown_installation' };
  const installation = await githubInstallationRepository.findByInstallationId(installationId, tx);
  if (!installation) return { kind: 'unknown_installation' };
  const repo = await githubRepoRepository.findByInstallationAndRepoId(
    installation.id,
    event.providerRepoId,
    tx,
  );
  if (!repo) return { kind: 'unknown_repo' };
  return {
    kind: 'resolved',
    installation,
    repo,
    buildChecksUrl: (number) =>
      `https://github.com/${repo.owner}/${repo.name}/pull/${number}/checks`,
  };
}

/** Reconcile an installation's selected repos from GitHub's authoritative set —
 *  the `installation` (non-delete) + `installation_repositories` path. Only an
 *  ALREADY-bound installation is reconciled (the workspace binding is the connect
 *  flow's job); an unbound delivery is a no-op returning `false`. Fetches the
 *  current repo set through the seam and hands it to `persistInstallation`. */
async function reconcileInstallation(
  installationId: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  const existing = await withSystemContext((tx) =>
    githubInstallationRepository.findByInstallationId(installationId, tx),
  );
  if (!existing) return false;

  // The repos already persisted BEFORE this reconcile — the baseline we diff the
  // authoritative set against, so we index only NEWLY-added repos (a re-selection
  // that drops/keeps repos never re-indexes an unchanged one).
  const existingRepoIds = await withSystemContext(async (tx) => {
    const rows = await githubRepoRepository.listByInstallation(existing.id, tx);
    return rows.map((r) => r.repoId);
  });

  const account = asRecord(asRecord(body['installation'])?.['account']);
  const repos = await getGitProvider(existing.provider as GitProviderId).fetchInstallationRepos(
    installationId,
  );
  await githubInstallationService.persistInstallation({
    workspaceId: existing.workspaceId,
    installation: {
      installationId,
      accountLogin:
        typeof account?.['login'] === 'string' ? account['login'] : existing.accountLogin,
      accountType: typeof account?.['type'] === 'string' ? account['type'] : existing.accountType,
    },
    repos,
  });

  // POST-COMMIT, best-effort: kick off a code-graph index for each newly-added
  // repo (MOTIR-1500). Never blocks or fails the grant mirror.
  await enqueueNewlyAddedRepos({
    installationId,
    workspaceId: existing.workspaceId,
    repos,
    existingRepoIds,
  });
  return true;
}

/** Resolve the GitHub connection + repo + bound author for a change-request event
 *  — the provider-specific half the shared status sync (`changeRequestStatusSync`)
 *  needs. GitHub's App delivery carries its installation id at `installation.id`;
 *  the repo is that installation's selected repo for the payload's numeric repo
 *  id; the author is the PR user's bound Motir member (only when they belong to
 *  the workspace, so the edit gate passes — else null → the owner fallback). */
async function resolveGithubChangeRequestContext(
  body: Record<string, unknown>,
  cr: NormalizedChangeRequest,
  tx: Prisma.TransactionClient,
): Promise<ChangeRequestContextResolution> {
  const installationId = readInstallationId(body);
  if (!installationId) return { kind: 'unknown_installation' };
  const installation = await githubInstallationRepository.findByInstallationId(installationId, tx);
  if (!installation) return { kind: 'unknown_installation' };
  const repo = await githubRepoRepository.findByInstallationAndRepoId(
    installation.id,
    cr.providerRepoId,
    tx,
  );
  if (!repo) return { kind: 'unknown_repo' };
  const authorBoundUserId = await resolveBoundMember(
    readAuthorGithubUserId(body),
    installation.workspaceId,
    tx,
  );
  return { kind: 'resolved', installation, repo, authorBoundUserId };
}

/** The bound Motir user for a GitHub author, ONLY when they are a member of the
 *  target workspace (so `updateStatus`'s edit gate can pass). Null otherwise —
 *  the caller then attributes to the workspace owner. */
async function resolveBoundMember(
  authorGithubUserId: string | null,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<string | null> {
  if (!authorGithubUserId) return null;
  const identity = await githubIdentityRepository.findByGithubUserId(authorGithubUserId, tx);
  if (!identity) return null;
  const membership = await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
    identity.userId,
    workspaceId,
    tx,
  );
  return membership ? identity.userId : null;
}

// --- payload helpers (defensive reads over the untyped JSON) ---

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** GitHub's numeric installation id (as a string — the stored key) from the
 *  top-level `installation` object every App delivery carries. */
function readInstallationId(body: Record<string, unknown>): string | null {
  const id = asRecord(body['installation'])?.['id'];
  return typeof id === 'number' || typeof id === 'string' ? String(id) : null;
}

/** The PR author's numeric GitHub user id (as a string), for actor attribution. */
function readAuthorGithubUserId(body: Record<string, unknown>): string | null {
  const id = asRecord(asRecord(body['pull_request'])?.['user'])?.['id'];
  return typeof id === 'number' || typeof id === 'string' ? String(id) : null;
}
