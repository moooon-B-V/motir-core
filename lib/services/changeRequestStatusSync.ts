import { Prisma, type GithubInstallation, type GithubRepo } from '@prisma/client';
import { withSystemContext } from '@/lib/workspaces/context';
import type { ChangeRequestLifecycle, NormalizedChangeRequest } from '@/lib/git/types';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { workflowsService } from './workflowsService';
import { workItemsService } from './workItemsService';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import { IllegalTransitionError, UnknownStatusError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';

// The provider-agnostic change-request → work-item status-sync state machine
// (Story 7.10 · MOTIR-892, generalized for GitLab in Story 7.23 · MOTIR-1475).
// This is THE ONE status-sync path: both the GitHub webhook (`githubWebhookService`)
// and the GitLab webhook (`gitlabWebhookService`) normalize their host's
// merge/pull-request payload through the shared `GitProvider` seam and hand the
// resulting `NormalizedChangeRequest` here. Nothing below is host-specific — the
// two providers differ ONLY in how they resolve the connection + repo + author
// from their raw payload (GitHub keys on its App installation id; GitLab keys on
// the project id, and has no bound-identity table), which each provider supplies
// through the `resolveContext` callback. There is deliberately no second, divergent
// sync path (the MOTIR-1475 rule).
//
// Every status write goes through the shipped `workItemsService.updateStatus` (the
// write-authority rule) under `withSystemContext` (the webhook has no active
// workspace — the trusted-writer RLS escape), attributed to the change request's
// author when they are a bound workspace member, else the workspace owner (the
// automation-engine precedent). The transition itself runs AFTER the resolve tx,
// in its own transaction, exactly as the GitHub path always did.

/** The concrete workflow target a canonical change-request lifecycle maps to.
 *  `key` is the CANONICAL status key we prefer; `category` is the fallback bucket
 *  when a custom workflow renamed the key — so we resolve BY category, never a
 *  hard-coded status id. Note the seam's canonical `todo` (closed-unmerged) maps
 *  to Motir's `in_progress`: the work was abandoned, not finished, AND the only
 *  LEGAL move from `in_review` (the default workflow has an `in_review →
 *  in_progress` edge but no `in_review → todo`). The seam emits the
 *  provider-agnostic signal; this consumer picks the concrete status. */
const LIFECYCLE_TARGET: Record<
  ChangeRequestLifecycle,
  { key: string; category: StatusCategoryDto }
> = {
  in_review: { key: 'in_review', category: 'in_progress' },
  done: { key: 'done', category: 'done' },
  todo: { key: 'in_progress', category: 'in_progress' },
};

/** The status-sync result — the canonical change-request outcome, shared by both
 *  providers. The `event: 'pull_request'` tag is the internal name for "a change
 *  request drove a status move" (a PR on GitHub, an MR on GitLab); it is for
 *  logging / test assertions, not a wire contract. */
export type ChangeRequestSyncResult = {
  event: 'pull_request';
  outcome:
    | 'transitioned'
    | 'noop'
    | 'deferred_open_pr' // a merge that is NOT the item's last open linked change request — item stays In Review (MOTIR-1604)
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
};

/** The connection + repo + resolved author a provider hands the shared sync, once
 *  it has resolved them from its own payload shape. `authorBoundUserId` is the
 *  change-request author's Motir user id ONLY when they are a member of the
 *  connection's workspace (so the edit gate passes) — null otherwise (the sync
 *  then attributes to the workspace owner). GitLab always passes null (it has no
 *  bound-identity table). */
export interface ChangeRequestSyncContext {
  installation: GithubInstallation;
  repo: GithubRepo;
  authorBoundUserId: string | null;
}

/** What a provider's `resolveContext` returns: the resolved context, or a typed
 *  "couldn't resolve" reason the sync surfaces as a clean no-op outcome. */
export type ChangeRequestContextResolution =
  | ({ kind: 'resolved' } & ChangeRequestSyncContext)
  | { kind: 'unknown_installation' }
  | { kind: 'unknown_repo' };

/**
 * Drive the linked work item's status from one normalized change-request event.
 * `resolveContext` runs INSIDE the resolve transaction and maps the provider's raw
 * payload to `{ installation, repo, authorBoundUserId }` (or a "couldn't resolve"
 * reason). Idempotent under redelivery: a re-applied transition is a no-op, and the
 * change-request row upsert converges (a concurrent-redelivery unique-constraint
 * race is caught and re-read).
 */
export async function syncChangeRequestStatus(
  cr: NormalizedChangeRequest,
  lifecycle: ChangeRequestLifecycle,
  resolveContext: (tx: Prisma.TransactionClient) => Promise<ChangeRequestContextResolution>,
): Promise<ChangeRequestSyncResult> {
  // Phase 1 — resolve + persist under system context (one transaction): the
  // connection + repo (via the provider's resolver), the linked work item (from
  // the head ref / title), the change-request row upsert, and the actor.
  const resolved = await withSystemContext(async (tx) => {
    const ctx = await resolveContext(tx);
    if (ctx.kind === 'unknown_installation') return { kind: 'unknown_installation' as const };
    if (ctx.kind === 'unknown_repo') return { kind: 'unknown_repo' as const };
    const { installation, repo, authorBoundUserId } = ctx;

    // Resolve the change request's linked work item. A MANUAL link (MOTIR-1596,
    // the explicit item→PR affordance) is the STICKY override of this branch/title
    // auto-resolver: lock the row, and if it is already manually linked, keep that
    // work item — this delivery does NOT re-derive the link (so a change request
    // whose branch never named the key stays linked and still drives the status
    // sync below, e.g. merged → Done). Otherwise resolve from the head ref / title
    // as before. The lock closes the clobber race with a concurrent manual link.
    await githubPullRequestRepository.lockByRepoAndNumber(repo.id, cr.number, tx);
    const existingPr = await githubPullRequestRepository.findByRepoAndNumber(
      repo.id,
      cr.number,
      tx,
    );
    let workItem: { id: string; projectId: string; status: string } | null;
    let linkedManually: boolean;
    if (existingPr?.linkedManually && existingPr.workItemId) {
      const manual = await workItemRepository.findById(existingPr.workItemId, tx);
      // A manual link whose target was hard-deleted falls back to unlinked.
      workItem = manual
        ? { id: manual.id, projectId: manual.projectId, status: manual.status }
        : null;
      linkedManually = manual !== null;
    } else {
      workItem = await resolveWorkItem(installation.workspaceId, cr, tx);
      linkedManually = false;
    }

    // Upsert the change-request row — the change-request→work-item link entity.
    // Idempotent under concurrent redelivery: a lost unique-`(repo,number)` race
    // throws P2002; catch it and re-write (the row the winner wrote is the same
    // state). `provider` stamps the row so the Development surface renders the
    // right host mark.
    const prRow = {
      provider: installation.provider,
      repoId: repo.id,
      number: cr.number,
      state: cr.state,
      merged: cr.merged,
      headRef: cr.headRef,
      title: cr.title,
      workItemId: workItem?.id ?? null,
      linkedManually,
    };
    let prId: string;
    try {
      prId = (await githubPullRequestRepository.upsert(prRow, tx)).id;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Converge: the concurrent winner wrote the same (repo, number); update to
      // reflect this delivery's state so the row is never left stale.
      prId = (await githubPullRequestRepository.upsert(prRow, tx)).id;
    }

    if (!workItem) return { kind: 'no_work_item' as const };

    // MOTIR-1604 — a merge only COMPLETES the item when it is the item's LAST open
    // linked change request. A cross-repo (two-PR) card has >1 linked PR/MR; the
    // first merge must NOT flip Done while a sibling is still open. This row was
    // just upserted (closed, on a merge), so we count the item's OTHER open linked
    // change requests — non-zero means DEFER. Only a `done` delivery can complete,
    // so skip the read for any other lifecycle.
    const hasOtherOpenLinkedPr =
      lifecycle === 'done'
        ? (await githubPullRequestRepository.countOtherOpenByWorkItem(workItem.id, prId, tx)) > 0
        : false;

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
      hasOtherOpenLinkedPr,
      actorUserId: authorBoundUserId ?? owner?.userId ?? null,
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

  // A merged change request that is NOT the item's last open linked one leaves the
  // item In Review — a cross-repo (two-PR) card completes only when its LAST linked
  // change request merges (MOTIR-1604).
  if (lifecycle === 'done' && resolved.hasOtherOpenLinkedPr) {
    return { event: 'pull_request', outcome: 'deferred_open_pr', workItemId: resolved.workItemId };
  }

  // Phase 2 — the status transition through the SHIPPED authority. Resolve the
  // concrete target status key by category against the project's live workflow.
  const targetKey = await resolveTargetStatusKey(
    resolved.projectId,
    resolved.workspaceId,
    lifecycle,
  );
  if (!targetKey)
    // A custom workflow with no status in the target category — a logged no-op,
    // never a crash.
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
}

/** Resolve the change request's linked work item from its head ref + title (the
 *  `MOTIR-<n>` hint the seam leaves for the consumer). Extracts every
 *  `<PREFIX>-<number>` candidate, resolves the project by prefix WITHIN the
 *  connection's workspace, then the work item by its full identifier. First
 *  resolved match wins; null when it references no work item in this workspace. */
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

/** Map a transition failure to a logged no-op outcome — the webhook never crashes
 *  on a workflow that can't legally take the move. A truly unexpected error
 *  re-throws (a 500 the host retries). */
function classifyTransitionError(
  err: unknown,
  workItemId: string,
  toStatus: string,
): ChangeRequestSyncResult {
  if (err instanceof IllegalTransitionError)
    return { event: 'pull_request', outcome: 'illegal_transition', workItemId, toStatus };
  if (err instanceof UnknownStatusError)
    return { event: 'pull_request', outcome: 'no_matching_status', workItemId };
  if (err instanceof ProjectAccessDeniedError || err instanceof ProjectNotFoundError)
    return { event: 'pull_request', outcome: 'access_denied', workItemId };
  throw err;
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
