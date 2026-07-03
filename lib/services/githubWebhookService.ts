import { Prisma } from '@prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import { getGitProvider } from '@/lib/git';
import type {
  ChangeRequestLifecycle,
  GitProviderId,
  NormalizedChangeRequest,
  NormalizedStatusEvent,
} from '@/lib/git/types';
import { githubInstallationRepository } from '@/lib/repositories/githubInstallationRepository';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { githubCheckRunRepository } from '@/lib/repositories/githubCheckRunRepository';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { githubInstallationService } from './githubInstallationService';
import { commentsService } from './commentsService';
import { workflowsService } from './workflowsService';
import { workItemsService } from './workItemsService';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import { IllegalTransitionError, UnknownStatusError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

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

/** The concrete workflow target a canonical change-request lifecycle maps to.
 *  `key` is the CANONICAL status key we prefer; `category` is the fallback bucket
 *  when a custom workflow renamed the key — so we resolve BY category, never a
 *  hard-coded status id (the card's rule). Note the seam's canonical `todo`
 *  (closed-unmerged) maps to Motir's `in_progress`: the card's "back to
 *  in-progress — the work was abandoned, not finished", AND the only LEGAL move
 *  from `in_review` (the default workflow has an `in_review → in_progress` edge
 *  but no `in_review → todo`). The seam emits the provider-agnostic signal; the
 *  consumer (us) picks the concrete status — exactly as `lib/git/types.ts` says. */
const LIFECYCLE_TARGET: Record<
  ChangeRequestLifecycle,
  { key: string; category: StatusCategoryDto }
> = {
  in_review: { key: 'in_review', category: 'in_progress' },
  done: { key: 'done', category: 'done' },
  todo: { key: 'in_progress', category: 'in_progress' },
};

/** PR actions that drive the status machine. Other actions (`synchronize`,
 *  `edited`, `labeled`, …) are ignored — they carry no lifecycle change the card
 *  syncs. */
const HANDLED_PR_ACTIONS = new Set(['opened', 'reopened', 'closed']);

export type GithubWebhookResult =
  | { event: 'ignored'; reason: string }
  | { event: 'installation'; outcome: 'synced' | 'removed' | 'skipped_unbound' | 'malformed' }
  | { event: 'installation_repositories'; outcome: 'synced' | 'skipped_unbound' | 'malformed' }
  | {
      event: 'pull_request';
      outcome:
        | 'transitioned'
        | 'noop'
        | 'no_work_item'
        | 'no_matching_status'
        | 'illegal_transition'
        | 'access_denied'
        | 'unknown_installation'
        | 'unknown_repo'
        | 'ignored_action'
        | 'malformed';
      workItemId?: string;
      toStatus?: string;
    }
  | {
      event: 'ci';
      outcome:
        | 'verified' // a terminal SUCCESS → passing note + ciState 'passing'
        | 'failed' // a terminal FAILURE → failure summary + ciState 'failing'
        | 'noop' // a redelivery of an already-recorded conclusion
        | 'ignored_pending' // a non-terminal (pending) or neutral conclusion
        | 'no_pull_request' // no stored PR matches the check's PR list / branch
        | 'no_work_item' // the PR carries no linked work item — a clean no-op
        | 'unknown_installation'
        | 'unknown_repo'
        | 'malformed';
      workItemId?: string;
      ciState?: 'passing' | 'failing' | null;
    };

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

  async handlePullRequest(body: Record<string, unknown>): Promise<GithubWebhookResult> {
    if (!HANDLED_PR_ACTIONS.has(String(body['action']))) {
      return { event: 'pull_request', outcome: 'ignored_action' };
    }
    const provider = getGitProvider(PROVIDER);
    const cr = provider.parseChangeRequestEvent(body);
    if (!cr) return { event: 'pull_request', outcome: 'malformed' };

    const installationId = readInstallationId(body);
    if (!installationId) return { event: 'pull_request', outcome: 'unknown_installation' };
    const authorGithubUserId = readAuthorGithubUserId(body);

    // Phase 1 — resolve + persist under system context (one transaction): the
    // installation, its repo, the linked work item (from the head ref / title),
    // the PR row upsert, and the actor. Returns the data phase 2 needs.
    const resolved = await withSystemContext(async (tx) => {
      const installation = await githubInstallationRepository.findByInstallationId(
        installationId,
        tx,
      );
      if (!installation) return { kind: 'unknown_installation' as const };

      const repo = await githubRepoRepository.findByInstallationAndRepoId(
        installation.id,
        cr.providerRepoId,
        tx,
      );
      if (!repo) return { kind: 'unknown_repo' as const };

      const workItem = await resolveWorkItem(installation.workspaceId, cr, tx);

      // Upsert the PR row — the PR→work-item link entity. Idempotent under
      // concurrent redelivery: a lost unique-`(repo,number)` race throws P2002;
      // catch it and re-read (the row the winner wrote is the same state).
      try {
        await githubPullRequestRepository.upsert(
          {
            repoId: repo.id,
            number: cr.number,
            state: cr.state,
            merged: cr.merged,
            headRef: cr.headRef,
            workItemId: workItem?.id ?? null,
          },
          tx,
        );
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Converge: the concurrent winner wrote the same (repo, number); update
        // to reflect this delivery's state so the row is never left stale.
        await githubPullRequestRepository.upsert(
          {
            repoId: repo.id,
            number: cr.number,
            state: cr.state,
            merged: cr.merged,
            headRef: cr.headRef,
            workItemId: workItem?.id ?? null,
          },
          tx,
        );
      }

      if (!workItem) return { kind: 'no_work_item' as const };

      const boundUserId = await resolveBoundMember(
        authorGithubUserId,
        installation.workspaceId,
        tx,
      );
      const owner = await workspaceMembershipRepository.findOwnerByWorkspace(
        installation.workspaceId,
        tx,
      );
      return {
        kind: 'resolved' as const,
        workspaceId: installation.workspaceId,
        projectId: workItem.projectId,
        workItemId: workItem.id,
        currentStatus: workItem.status,
        actorUserId: boundUserId ?? owner?.userId ?? null,
        ownerUserId: owner?.userId ?? null,
      };
    });

    if (resolved.kind === 'unknown_installation')
      return { event: 'pull_request', outcome: 'unknown_installation' };
    if (resolved.kind === 'unknown_repo') return { event: 'pull_request', outcome: 'unknown_repo' };
    if (resolved.kind === 'no_work_item') return { event: 'pull_request', outcome: 'no_work_item' };
    if (!resolved.actorUserId)
      // No workspace owner and no bound author — nothing can author the move.
      return { event: 'pull_request', outcome: 'access_denied', workItemId: resolved.workItemId };

    // Phase 2 — the status transition through the SHIPPED authority. Resolve the
    // concrete target status key by category against the project's live workflow.
    const lifecycle = provider.changeRequestLifecycle(cr);
    const targetKey = await resolveTargetStatusKey(
      resolved.projectId,
      resolved.workspaceId,
      lifecycle,
    );
    if (!targetKey)
      // A custom workflow with no status in the target category — a logged no-op,
      // never a crash (the card's rule).
      return {
        event: 'pull_request',
        outcome: 'no_matching_status',
        workItemId: resolved.workItemId,
      };

    // Idempotent: already in the target (a redelivery) — updateStatus no-ops, but
    // short-circuit so the outcome reads `noop` rather than `transitioned`.
    if (resolved.currentStatus === targetKey)
      return {
        event: 'pull_request',
        outcome: 'noop',
        workItemId: resolved.workItemId,
        toStatus: targetKey,
      };

    try {
      await applyTransition(resolved.workItemId, targetKey, {
        userId: resolved.actorUserId,
        workspaceId: resolved.workspaceId,
      });
    } catch (err) {
      // The bound author lacked edit rights (e.g. a viewer) — retry once as the
      // owner (a manager, always edit-capable). This keeps the sync working while
      // still PREFERRING the author for the activity-log attribution.
      if (
        err instanceof ProjectAccessDeniedError &&
        resolved.ownerUserId &&
        resolved.ownerUserId !== resolved.actorUserId
      ) {
        try {
          await applyTransition(resolved.workItemId, targetKey, {
            userId: resolved.ownerUserId,
            workspaceId: resolved.workspaceId,
          });
        } catch (retryErr) {
          return classifyTransitionError(retryErr, resolved.workItemId, targetKey);
        }
        return {
          event: 'pull_request',
          outcome: 'transitioned',
          workItemId: resolved.workItemId,
          toStatus: targetKey,
        };
      }
      return classifyTransitionError(err, resolved.workItemId, targetKey);
    }

    return {
      event: 'pull_request',
      outcome: 'transitioned',
      workItemId: resolved.workItemId,
      toStatus: targetKey,
    };
  },

  /**
   * Handle a `check_suite` / `check_run` delivery — the CI feedback half of the
   * closed loop (MOTIR-894). Resolve the check → its PR (by the payload's
   * PR-number list, else the head branch) → the linked work item, then on a
   * TERMINAL conclusion post (or, on a re-run, UPDATE in place) a single feedback
   * comment and flip the item's `ciState` signal. The feedback is IDEMPOTENT on
   * `(pr, headSha, checkName)`: a redelivery of an already-recorded conclusion is
   * a no-op — no duplicate comment. A pending / neutral conclusion, a check for a
   * PR we don't track, or a PR with NO linked work item are all clean no-ops
   * (never a crash). Writes go through the shipped services — `commentsService`
   * for the comment, `workItemsService.setCiState` for the signal — never a raw
   * insert / update.
   */
  async handleCiStatus(body: Record<string, unknown>): Promise<GithubWebhookResult> {
    const provider = getGitProvider(PROVIDER);
    const event = provider.parseCiStatusEvent(body);
    if (!event) return { event: 'ci', outcome: 'malformed' };

    // Act only on a TERMINAL, meaningful conclusion. `pending` (still running) and
    // `neutral` (skipped / stale) carry no verification signal — a logged no-op.
    if (event.conclusion !== 'success' && event.conclusion !== 'failure') {
      return { event: 'ci', outcome: 'ignored_pending' };
    }

    const installationId = readInstallationId(body);
    if (!installationId) return { event: 'ci', outcome: 'unknown_installation' };

    // Phase 1 — resolve under system context (one tx, no writes): installation →
    // repo → PR (by PR-number list, else head branch) → linked work item, the
    // prior check row (for idempotency), and the actor (workspace OWNER — a check
    // event carries no author, so the CI feedback is attributed to the owner, the
    // same fallback the status sync uses).
    const resolved = await withSystemContext(async (tx) => {
      const installation = await githubInstallationRepository.findByInstallationId(
        installationId,
        tx,
      );
      if (!installation) return { kind: 'unknown_installation' as const };

      const repo = await githubRepoRepository.findByInstallationAndRepoId(
        installation.id,
        event.providerRepoId,
        tx,
      );
      if (!repo) return { kind: 'unknown_repo' as const };

      const pr = await resolvePullRequest(repo.id, event, tx);
      if (!pr) return { kind: 'no_pull_request' as const };
      if (!pr.workItemId) return { kind: 'no_work_item' as const };

      const workItem = await workItemRepository.findById(pr.workItemId, tx);
      if (!workItem) return { kind: 'no_work_item' as const };

      const existing = await githubCheckRunRepository.findByKey(
        pr.id,
        event.commitSha,
        event.context,
        tx,
      );
      const owner = await workspaceMembershipRepository.findOwnerByWorkspace(
        installation.workspaceId,
        tx,
      );
      return {
        kind: 'resolved' as const,
        workspaceId: installation.workspaceId,
        workItemId: workItem.id,
        prId: pr.id,
        checksUrl: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}/checks`,
        existing: existing
          ? { conclusion: existing.conclusion, feedbackCommentId: existing.feedbackCommentId }
          : null,
        actorUserId: owner?.userId ?? null,
      };
    });

    if (resolved.kind === 'unknown_installation')
      return { event: 'ci', outcome: 'unknown_installation' };
    if (resolved.kind === 'unknown_repo') return { event: 'ci', outcome: 'unknown_repo' };
    if (resolved.kind === 'no_pull_request') return { event: 'ci', outcome: 'no_pull_request' };
    if (resolved.kind === 'no_work_item') return { event: 'ci', outcome: 'no_work_item' };
    if (!resolved.actorUserId)
      // No workspace owner to author the feedback comment — nothing to attribute.
      return { event: 'ci', outcome: 'no_work_item', workItemId: resolved.workItemId };

    // Idempotent: a redelivery of the SAME conclusion we already recorded (and
    // commented) is a no-op — never a duplicate comment.
    if (
      resolved.existing &&
      resolved.existing.conclusion === event.conclusion &&
      resolved.existing.feedbackCommentId
    ) {
      return {
        event: 'ci',
        outcome: 'noop',
        workItemId: resolved.workItemId,
        ciState: event.conclusion === 'success' ? 'passing' : 'failing',
      };
    }

    const actorCtx = { userId: resolved.actorUserId, workspaceId: resolved.workspaceId };

    // Post the feedback (a NEW conclusion), or UPDATE the existing comment in
    // place (a re-run whose conclusion changed) — through the shipped comment
    // service, never a raw insert.
    const bodyMd =
      event.conclusion === 'success'
        ? passingCommentBody(event.context)
        : failingCommentBody(event.context, resolved.checksUrl);
    let feedbackCommentId: string;
    if (resolved.existing?.feedbackCommentId) {
      const edited = await commentsService.editComment(
        resolved.existing.feedbackCommentId,
        { bodyMd },
        actorCtx,
      );
      feedbackCommentId = edited.id;
    } else {
      const created = await commentsService.addComment(resolved.workItemId, { bodyMd }, actorCtx);
      feedbackCommentId = created.id;
    }

    // Record the check row (idempotency key) + derive the item's aggregate
    // `ciState` from ALL its terminal checks at this commit (any failure → failing).
    const ciState = await withSystemContext(async (tx) => {
      await githubCheckRunRepository.upsert(
        {
          pullRequestId: resolved.prId,
          commitSha: event.commitSha,
          checkName: event.context,
          conclusion: event.conclusion,
          feedbackCommentId,
        },
        tx,
      );
      const rows = await githubCheckRunRepository.listByPrAndSha(
        resolved.prId,
        event.commitSha,
        tx,
      );
      return deriveCiState(rows.map((r) => r.conclusion));
    });

    // Flip the verification signal through the service (no raw work_item write).
    await workItemsService.setCiState(resolved.workItemId, ciState, actorCtx);

    return {
      event: 'ci',
      outcome: event.conclusion === 'success' ? 'verified' : 'failed',
      workItemId: resolved.workItemId,
      ciState,
    };
  },
};

/** Resolve the stored PR for a CI event — by the payload's PR-number list first
 *  (the strongest link), else the head branch (stable across a re-push). Null
 *  when neither resolves to a stored PR row. */
async function resolvePullRequest(
  repoId: string,
  event: NormalizedStatusEvent,
  tx: Prisma.TransactionClient,
): Promise<{ id: string; number: number; workItemId: string | null } | null> {
  for (const number of event.prNumbers) {
    const pr = await githubPullRequestRepository.findByRepoAndNumber(repoId, number, tx);
    if (pr) return { id: pr.id, number: pr.number, workItemId: pr.workItemId };
  }
  if (event.headBranch) {
    const pr = await githubPullRequestRepository.findByRepoAndHeadRef(repoId, event.headBranch, tx);
    if (pr) return { id: pr.id, number: pr.number, workItemId: pr.workItemId };
  }
  return null;
}

/** The work item's aggregate CI signal from its terminal check conclusions at one
 *  commit: any failure → 'failing'; else at least one success → 'passing'; else
 *  null. Only success/failure rows are ever stored, so this is total over them. */
function deriveCiState(conclusions: string[]): 'passing' | 'failing' | null {
  if (conclusions.some((c) => c === 'failure')) return 'failing';
  if (conclusions.some((c) => c === 'success')) return 'passing';
  return null;
}

/** The passing-note body — a linked PR's checks succeeded (the work is verified). */
function passingCommentBody(checkName: string): string {
  return `✅ **CI passing** — checks (\`${checkName}\`) succeeded on the linked pull request. This work is verified.`;
}

/** The failure-summary body — which check failed + a link, and the not-ready flag. */
function failingCommentBody(checkName: string, checksUrl: string): string {
  return `❌ **CI failed** — \`${checkName}\` did not pass on the linked pull request ([view checks](${checksUrl})). This work item is marked **not-ready**; it needs another pass.`;
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
  return true;
}

/** Resolve the PR's linked work item from its head ref + title (the `MOTIR-<n>`
 *  hint the seam leaves for the consumer). Extracts every `<PREFIX>-<number>`
 *  candidate, resolves the project by prefix WITHIN the installation's workspace,
 *  then the work item by its full identifier. First resolved match wins; null
 *  when the PR references no work item in this workspace. */
async function resolveWorkItem(
  workspaceId: string,
  cr: NormalizedChangeRequest,
  tx: Prisma.TransactionClient,
): Promise<{ id: string; projectId: string; status: string } | null> {
  const seen = new Set<string>();
  for (const { prefix, number } of parseKeyCandidates(`${cr.headRef} ${cr.title ?? ''}`)) {
    const dedupeKey = `${prefix}-${number}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const project = await projectRepository.findByIdentifier(workspaceId, prefix, tx);
    if (!project) continue;
    const workItem = await workItemRepository.findByIdentifier(project.id, dedupeKey, tx);
    if (workItem)
      return { id: workItem.id, projectId: workItem.projectId, status: workItem.status };
  }
  return null;
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

/** Resolve the canonical lifecycle to a concrete status key in the project's live
 *  workflow — the preferred key if present, else the first status of the target
 *  CATEGORY (never a hard-coded id), else null (a custom workflow with no match →
 *  the caller logs a no-op). */
async function resolveTargetStatusKey(
  projectId: string,
  workspaceId: string,
  lifecycle: ChangeRequestLifecycle,
): Promise<string | null> {
  const target = LIFECYCLE_TARGET[lifecycle];
  const statuses = await workflowsService.listStatusesByProject(projectId, workspaceId);
  const byKey = statuses.find((s) => s.key === target.key);
  if (byKey) return byKey.key;
  const byCategory = statuses.find((s) => s.category === target.category);
  return byCategory?.key ?? null;
}

/** The status write — through the shipped authority, never a raw update. */
async function applyTransition(
  workItemId: string,
  toStatusKey: string,
  ctx: { userId: string; workspaceId: string },
): Promise<void> {
  await workItemsService.updateStatus(workItemId, toStatusKey, ctx);
}

/** Map a transition failure to a logged no-op outcome — the webhook never
 *  crashes on a workflow that can't legally take the move (the card's rule). A
 *  truly unexpected error re-throws (a 500 GitHub retries). */
function classifyTransitionError(
  err: unknown,
  workItemId: string,
  toStatus: string,
): GithubWebhookResult {
  if (err instanceof IllegalTransitionError)
    return { event: 'pull_request', outcome: 'illegal_transition', workItemId, toStatus };
  if (err instanceof UnknownStatusError)
    return { event: 'pull_request', outcome: 'no_matching_status', workItemId };
  if (err instanceof ProjectAccessDeniedError || err instanceof ProjectNotFoundError)
    return { event: 'pull_request', outcome: 'access_denied', workItemId };
  throw err;
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

const KEY_CANDIDATE_RE = /\b([A-Za-z][A-Za-z0-9]*)-(\d+)\b/g;

/** Extract `<PREFIX>-<number>` work-item-key candidates from free text (head ref
 *  + title), prefix upper-cased to match the stored project identifier. A prefix
 *  that resolves to no project is simply skipped by the caller. */
function parseKeyCandidates(text: string): Array<{ prefix: string; number: number }> {
  const out: Array<{ prefix: string; number: number }> = [];
  for (const match of text.matchAll(KEY_CANDIDATE_RE)) {
    out.push({ prefix: match[1]!.toUpperCase(), number: Number(match[2]) });
  }
  return out;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
