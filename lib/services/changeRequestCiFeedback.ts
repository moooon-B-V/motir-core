import { Prisma, type GithubInstallation, type GithubRepo } from '@prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import type { GitProviderId, NormalizedStatusEvent } from '@/lib/git/types';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { githubCheckRunRepository } from '@/lib/repositories/githubCheckRunRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { commentsService } from './commentsService';
import { workItemsService } from './workItemsService';

// The provider-agnostic CI / pipeline → work-item feedback consumer (Story 7.10 ·
// MOTIR-894, generalized for GitLab in Story 7.23 · MOTIR-1477). This is THE ONE
// verification-feedback path: both the GitHub webhook (`githubWebhookService`,
// `check_suite`/`check_run`) and the GitLab webhook (`gitlabWebhookService`,
// `pipeline`) normalize their host's CI payload through the shared `GitProvider`
// seam and hand the resulting `NormalizedStatusEvent` here. Nothing below is
// host-specific — the two providers differ ONLY in how they resolve the connection
// + repo from their raw payload (GitHub keys on its App installation id; GitLab
// keys on the project id) and in the host URL a "view checks" link points at,
// which each provider supplies through the `resolveContext` callback. There is
// deliberately no second, divergent feedback path (the MOTIR-1475 rule that shaped
// `changeRequestStatusSync`).
//
// On a TERMINAL conclusion the consumer posts (or, on a re-run, UPDATES in place) a
// single feedback comment and flips the item's `ciState` verification signal — both
// through the shipped services (`commentsService`, `workItemsService.setCiState`),
// never a raw write, under `withSystemContext` (a webhook has no active workspace).
// The feedback is IDEMPOTENT on `(pr, headSha, checkName)`: a redelivery of an
// already-recorded conclusion is a no-op. A pending conclusion is RECORDED as a
// row (so the Development surface can derive "Checks running", MOTIR-1579) with
// NONE of the terminal side-effects; a neutral conclusion, a check for a change
// request we don't track, or one with no linked work item are all clean no-ops.

/** The CI-feedback result — the canonical outcome shared by both providers. The
 *  `event: 'ci'` tag is for logging / test assertions, not a wire contract. */
export type CiFeedbackResult = {
  event: 'ci';
  outcome:
    | 'verified' // a terminal SUCCESS → passing note + ciState 'passing'
    | 'failed' // a terminal FAILURE → failure summary + ciState 'failing'
    | 'noop' // a redelivery of an already-recorded conclusion
    | 'pending_recorded' // an in-flight check RECORDED as a pending row (MOTIR-1579) — no comment, no ciState
    | 'ignored_pending' // a neutral (skipped / stale) conclusion — a clean no-op
    | 'no_pull_request' // no stored change request matches the event's PR/MR list / branch
    | 'no_work_item' // the change request carries no linked work item — a clean no-op
    | 'unknown_installation'
    | 'unknown_repo'
    | 'malformed';
  workItemId?: string;
  ciState?: 'passing' | 'failing' | null;
};

/** The connection + repo a provider hands the shared consumer, once it has
 *  resolved them from its own payload shape, plus the host-specific "view checks"
 *  URL builder (given the resolved change-request number). GitHub links to the
 *  PR's checks tab; GitLab to the MR's pipelines tab. */
export interface CiFeedbackContext {
  installation: GithubInstallation;
  repo: GithubRepo;
  buildChecksUrl: (changeRequestNumber: number) => string;
}

/** What a provider's `resolveContext` returns: the resolved context, or a typed
 *  "couldn't resolve" reason the consumer surfaces as a clean no-op outcome. */
export type CiFeedbackContextResolution =
  | ({ kind: 'resolved' } & CiFeedbackContext)
  | { kind: 'unknown_installation' }
  | { kind: 'unknown_repo' };

/**
 * Apply one normalized CI / pipeline event to its linked work item's verification
 * feedback. `resolveContext` runs INSIDE the resolve transaction and maps the
 * provider's raw payload to `{ installation, repo, buildChecksUrl }` (or a
 * "couldn't resolve" reason). The event's change request (a GitHub PR / GitLab MR)
 * is resolved from the shared change-request table by the event's PR/MR-number
 * list first, else the head branch — the same resolver both hosts share.
 */
export async function applyCiStatusFeedback(
  event: NormalizedStatusEvent,
  resolveContext: (tx: Prisma.TransactionClient) => Promise<CiFeedbackContextResolution>,
): Promise<CiFeedbackResult> {
  // `neutral` (skipped / stale / manual) carries no signal at all — a logged no-op,
  // BEFORE any resolution (nothing to record for it either).
  if (event.conclusion === 'neutral') {
    return { event: 'ci', outcome: 'ignored_pending' };
  }

  // Phase 1 — resolve under system context (one tx, no writes): connection + repo
  // (via the provider's resolver) → change request (by PR/MR-number list, else head
  // branch) → linked work item, the prior check row (for idempotency), and the
  // actor (workspace OWNER — a CI event carries no author, so the feedback is
  // attributed to the owner, the same fallback the status sync uses).
  const resolved = await withSystemContext(async (tx) => {
    const ctx = await resolveContext(tx);
    if (ctx.kind === 'unknown_installation') return { kind: 'unknown_installation' as const };
    if (ctx.kind === 'unknown_repo') return { kind: 'unknown_repo' as const };
    const { installation, repo, buildChecksUrl } = ctx;

    const cr = await resolveChangeRequest(repo.id, event, tx);
    if (!cr) return { kind: 'no_pull_request' as const };
    if (!cr.workItemId) return { kind: 'no_work_item' as const };

    const workItem = await workItemRepository.findById(cr.workItemId, tx);
    if (!workItem) return { kind: 'no_work_item' as const };

    const existing = await githubCheckRunRepository.findByKey(
      cr.id,
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
      provider: installation.provider as GitProviderId,
      workItemId: workItem.id,
      prId: cr.id,
      checksUrl: buildChecksUrl(cr.number),
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

  // An in-flight check: RECORD the row (conclusion 'pending') so the per-change-request
  // "Checks running" state is derivable (MOTIR-1579), but with NONE of the terminal
  // side-effects — no feedback comment, no `WorkItem.ciState` flip (both stay
  // terminal-only, the MOTIR-894 contract). The upsert PRESERVES an existing
  // feedback-comment link so a re-run's later terminal conclusion still updates the
  // same comment in place.
  if (event.conclusion === 'pending') {
    await withSystemContext(async (tx) => {
      await githubCheckRunRepository.upsert(
        {
          pullRequestId: resolved.prId,
          commitSha: event.commitSha,
          checkName: event.context,
          conclusion: 'pending',
          feedbackCommentId: resolved.existing?.feedbackCommentId ?? null,
        },
        tx,
      );
    });
    return { event: 'ci', outcome: 'pending_recorded', workItemId: resolved.workItemId };
  }

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
  const noun = changeRequestNoun(resolved.provider);

  // Post the feedback (a NEW conclusion), or UPDATE the existing comment in place
  // (a re-run whose conclusion changed) — through the shipped comment service,
  // never a raw insert.
  const bodyMd =
    event.conclusion === 'success'
      ? passingCommentBody(event.context, noun)
      : failingCommentBody(event.context, resolved.checksUrl, noun);
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

  // Record the check row (idempotency key) + derive the item's aggregate `ciState`
  // from ALL its terminal checks at this commit (any failure → failing).
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
    const rows = await githubCheckRunRepository.listByPrAndSha(resolved.prId, event.commitSha, tx);
    return deriveCiState(rows.map((r) => r.conclusion));
    // (deriveCiState ignores non-terminal conclusions — pending rows at this sha,
    // recorded for the Development surface, never gate the verdict.)
  });

  // Flip the verification signal through the service (no raw work_item write).
  await workItemsService.setCiState(resolved.workItemId, ciState, actorCtx);

  return {
    event: 'ci',
    outcome: event.conclusion === 'success' ? 'verified' : 'failed',
    workItemId: resolved.workItemId,
    ciState,
  };
}

/** Resolve the stored change request (PR / MR) for a CI event — by the event's
 *  PR/MR-number list first (the strongest link), else the head branch (stable
 *  across a re-push). Null when neither resolves to a stored row. */
async function resolveChangeRequest(
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

/** The work item's aggregate CI signal from its TERMINAL check conclusions at one
 *  commit: any failure → 'failing'; else at least one success → 'passing'; else
 *  null. Non-terminal rows ('pending', recorded for the Development surface since
 *  MOTIR-1579) match neither predicate, so they never gate the verdict. */
function deriveCiState(conclusions: string[]): 'passing' | 'failing' | null {
  if (conclusions.some((c) => c === 'failure')) return 'failing';
  if (conclusions.some((c) => c === 'success')) return 'passing';
  return null;
}

/** The host's noun for a change request — a GitHub `pull request`, a GitLab `merge
 *  request` — so the feedback comment reads naturally on either host. */
function changeRequestNoun(provider: GitProviderId): string {
  return provider === 'gitlab' ? 'merge request' : 'pull request';
}

/** The passing-note body — a linked change request's checks succeeded (verified). */
function passingCommentBody(checkName: string, noun: string): string {
  return `✅ **CI passing** — checks (\`${checkName}\`) succeeded on the linked ${noun}. This work is verified.`;
}

/** The failure-summary body — which check failed + a link, and the not-ready flag. */
function failingCommentBody(checkName: string, checksUrl: string, noun: string): string {
  return `❌ **CI failed** — \`${checkName}\` did not pass on the linked ${noun} ([view checks](${checksUrl})). This work item is marked **not-ready**; it needs another pass.`;
}
