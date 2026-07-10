import type { Prisma } from '@prisma/client';
import { getGitProvider } from '@/lib/git';
import type {
  GitProviderId,
  NormalizedChangeRequest,
  NormalizedStatusEvent,
} from '@/lib/git/types';
import { githubRepoRepository } from '@/lib/repositories/githubRepoRepository';
import { gitlabBaseUrl } from '@/lib/gitlab/gitlabOAuth';
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

// gitlabWebhookService (Story 7.23 · MOTIR-1475) — the inbound GitLab webhook
// logic layer, the GitLab mirror of `githubWebhookService`'s status sync. The HTTP
// route (`app/api/gitlab/webhook`) owns ONLY token verification + dispatch; ALL
// logic is here (CLAUDE.md 4-layer). A GitLab MERGE-REQUEST hook is normalized
// through the shared `GitProvider` seam and driven through THE shared status-sync
// state machine (`changeRequestStatusSync`) — the SAME consumer GitHub uses, not a
// GitLab-specific copy (the card's "no divergent second sync path"). GitLab differs
// only in how it resolves the connection + repo (by the project id, since a GitLab
// hook carries no Motir connection id) and in having no bound-identity table (the
// author is always the workspace owner).
//
// Scope: this service dispatches GitLab's MERGE-REQUEST hook to the shared status
// sync (MOTIR-1475) and its PIPELINE hook to the shared CI-feedback consumer
// (`applyCiStatusFeedback`, MOTIR-1477) — the SAME two consumers GitHub drives, not
// GitLab-specific copies. GitLab's `push` hook (the code-graph feed, MOTIR-1476)
// still rides the SAME endpoint but is IGNORED here (a fast 2xx no-op), owned by
// its own sibling card that extends the dispatch additively.

const PROVIDER: GitProviderId = 'gitlab';

/** GitLab MR actions that drive the status machine. Other `object_attributes.action`
 *  values (`update` — a title edit / new commits / label change / assignee change,
 *  `approved`, `unapproved`) carry no lifecycle change to sync — the GitLab
 *  analogue of GitHub's ignored `synchronize`. */
const HANDLED_MR_ACTIONS = new Set(['open', 'reopen', 'close', 'merge']);

export type GitlabWebhookResult =
  | { event: 'ignored'; reason: string }
  | ChangeRequestSyncResult
  | CiFeedbackResult;

export const gitlabWebhookService = {
  /**
   * Handle one verified delivery. `eventType` is the `X-Gitlab-Event` header; the
   * body's `object_kind` is the authoritative event discriminator GitLab always
   * carries. A `merge_request` hook drives the status sync and a `pipeline` hook
   * the CI-feedback loop; every other kind (push / note / …) is a fast 2xx no-op
   * here (owned by sibling cards). Idempotent under redelivery via the shared
   * consumers.
   */
  async handleEvent(eventType: string, payload: unknown): Promise<GitlabWebhookResult> {
    const body = asRecord(payload);
    if (!body) return { event: 'ignored', reason: 'malformed_body' };
    if (body['object_kind'] === 'merge_request') return this.handleMergeRequest(body);
    if (body['object_kind'] === 'pipeline') return this.handlePipeline(body);
    const kind = typeof body['object_kind'] === 'string' ? body['object_kind'] : eventType;
    return { event: 'ignored', reason: `unhandled_event:${kind || 'unknown'}` };
  },

  /**
   * Handle a `merge_request` hook — normalize it through the seam, gate on the
   * lifecycle-changing MR actions, and drive the linked work item through THE
   * shared status-sync state machine. Opened → In Review; merged → Done;
   * closed-unmerged → In Progress (the abandoned-work signal). A hook for an
   * unconnected project resolves to `unknown_repo` (a clean no-op).
   */
  async handleMergeRequest(body: Record<string, unknown>): Promise<GitlabWebhookResult> {
    const action = asRecord(body['object_attributes'])?.['action'];
    if (typeof action === 'string' && !HANDLED_MR_ACTIONS.has(action)) {
      return { event: 'pull_request', outcome: 'ignored_action' };
    }
    const provider = getGitProvider(PROVIDER);
    const cr = provider.parseChangeRequestEvent(body);
    if (!cr) return { event: 'pull_request', outcome: 'malformed' };
    const lifecycle = provider.changeRequestLifecycle(cr);
    return syncChangeRequestStatus(cr, lifecycle, (tx) =>
      resolveGitlabChangeRequestContext(cr, tx),
    );
  },

  /**
   * Handle a `pipeline` hook — the CI feedback half of the loop (MOTIR-1477).
   * Normalize it through the seam (a GitLab pipeline `status` → our CI conclusion;
   * the associated MR iid + branch are the resolver keys) and drive the linked
   * work item's verification feedback through THE shared consumer
   * (`applyCiStatusFeedback`) — the SAME path GitHub's `check_suite`/`check_run`
   * uses. A pipeline for an unconnected project resolves to `unknown_repo` (a clean
   * no-op); a pipeline with no linked MR / work item is a clean no-op too.
   */
  async handlePipeline(body: Record<string, unknown>): Promise<GitlabWebhookResult> {
    const provider = getGitProvider(PROVIDER);
    const event = provider.parseCiStatusEvent(body);
    if (!event) return { event: 'ci', outcome: 'malformed' };
    return applyCiStatusFeedback(event, (tx) => resolveGitlabCiContext(event, tx));
  },
};

/** Resolve the GitLab connection + repo for a merge-request event — the
 *  provider-specific half the shared status sync needs. A GitLab hook carries the
 *  project id but no Motir connection id, so resolve the connected repo by
 *  `(provider, projectId)` → its parent installation. GitLab has no bound-identity
 *  table, so the author is always null (→ the shared sync's workspace-owner
 *  fallback). `unknown_repo` when the project isn't connected in any workspace. */
async function resolveGitlabChangeRequestContext(
  cr: NormalizedChangeRequest,
  tx: Prisma.TransactionClient,
): Promise<ChangeRequestContextResolution> {
  const repo = await githubRepoRepository.findByRepoIdAndProvider(cr.providerRepoId, PROVIDER, tx);
  if (!repo) return { kind: 'unknown_repo' };
  return { kind: 'resolved', installation: repo.installation, repo, authorBoundUserId: null };
}

/** Resolve the GitLab connection + repo + checks-URL builder for a pipeline event —
 *  the provider-specific half the shared CI-feedback consumer needs. Keys on the
 *  project id (a GitLab hook carries no Motir connection id, exactly as the MR
 *  resolver does); the checks link points at the MR's pipelines tab on the GitLab
 *  host. `unknown_repo` when the project isn't connected in any workspace. */
async function resolveGitlabCiContext(
  event: NormalizedStatusEvent,
  tx: Prisma.TransactionClient,
): Promise<CiFeedbackContextResolution> {
  const repo = await githubRepoRepository.findByRepoIdAndProvider(
    event.providerRepoId,
    PROVIDER,
    tx,
  );
  if (!repo) return { kind: 'unknown_repo' };
  return {
    kind: 'resolved',
    installation: repo.installation,
    repo,
    buildChecksUrl: (number) =>
      `${gitlabBaseUrl()}/${repo.owner}/${repo.name}/-/merge_requests/${number}/pipelines`,
  };
}

/** Narrow an `unknown` webhook body to a plain object (defensive read over the
 *  untyped JSON). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
