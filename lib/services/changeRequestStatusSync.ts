import { Prisma, type GithubInstallation, type GithubRepo } from '@/generated/prisma/client';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import type {
  ChangeRequestLifecycle,
  GitProviderId,
  NormalizedChangeRequest,
} from '@/lib/git/types';
import { changeRequestNoun } from '@/lib/git/labels';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { resolveExpectedRepos } from '@/lib/workItems/expectedRepos';
import {
  deliverySetShortfall,
  hasDeliverySetShortfall,
  EMPTY_DELIVERY_SHORTFALL,
  type DeliverySetShortfall,
} from '@/lib/workItems/deliverySet';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import {
  classifyRepoDelivery,
  hasRepoSetShortfall,
  repoSetShortfall,
  EMPTY_SHORTFALL,
  type RepoSetShortfall,
} from '@/lib/workItems/repoDelivery';
import {
  resolveChangeRequestWorkItemSet,
  type ChangeRequestWorkItemSet,
} from './changeRequestWorkItems';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { commentsService } from './commentsService';
import { workflowsService } from './workflowsService';
import { workItemsService } from './workItemsService';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { CompleteSessionItemResultDto } from '@/lib/dto/workItems';
import {
  ContainerHasOpenChildrenError,
  IllegalTransitionError,
  MissingArtifactEvidenceError,
  UnknownStatusError,
} from '@/lib/workItems/errors';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { NO_ARTIFACT_MARKER } from '@/lib/workItems/artifactEvidence';

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
//
// ⚠️ COMPLETION IS GATED TWICE, and both gates say "a merge event is not proof the
// deliverable shipped" (they are the same lesson at two different scopes):
//   * MOTIR-1604 — the merge must be the item's LAST open linked change request,
//     else a cross-repo two-PR card completes on half its work.
//   * MOTIR-1873 — the merge must have landed on the repository's DEFAULT branch,
//     else a change request STACKED on a sibling's branch completes while its code
//     sits on a dead branch with no path to the trunk. GitHub reports MERGED for
//     that merge, truthfully; the trunk is the only witness that matters.
//   * MOTIR-2729 — every repository the item CARRIES (`work_item.targetRepos`, the
//     repository SET) must have a merged linked change request on that repository's
//     own default branch. This is the gate the other two structurally cannot be:
//     both of them reason about change requests that EXIST, and a repository whose
//     pull request was never opened writes no row at all, so a two-repo card
//     completed on half its work (MOTIR-2664). The SET is the expected side; without
//     it "has everything merged?" is a question with no data behind it.
// All three HOLD the item at In Review rather than transitioning, and all three
// report a distinct outcome — never a silent no-op, because invisibility was the
// whole cost of MOTIR-1873's incident.
//
// ⚠️ A FOURTH HOLD IS DECIDED ELSEWHERE, and forgetting that cost a production
// incident (MOTIR-3364). MOTIR-2709's artifact-evidence gate lives inside
// `applyStatusTransition`, not up here, so it reaches this module only as a thrown
// error — and `classifyTransitionError` had no arm for it, so it RETHREW: a 500 on
// a successful merge delivery, and a `deploy` card parked at In Review with nothing
// on it to say why. The rule the three gates above state is not "these three are
// visible"; it is that EVERY hold is. `STATUS_TRANSITION_REFUSALS` is now the one
// list of what that authority can refuse, and both merge-driven consumers read it.

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
  // OPENED (MOTIR-3005). The `category` fallback is what a CUSTOM workflow with
  // no `implemented` status lands on — the same in-progress bucket `in_review`
  // resolved to before, so such a project keeps exactly the behaviour it had.
  implemented: { key: 'implemented', category: 'in_progress' },
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
    | 'session_closed' // a merged SESSION-branch delivery — every card on the branch closed (MOTIR-3007)
    | 'noop'
    | 'deferred_incomplete_delivery_set' // a pull request DELIVERING this item has not landed — item stays In Review (MOTIR-3659)
    | 'deferred_open_pr' // a merge that is NOT the item's last open linked change request — item stays In Review (MOTIR-1604)
    | 'deferred_non_default_base' // a merge into a NON-default base — the work never reached the trunk, item stays In Review (MOTIR-1873)
    | 'deferred_incomplete_repo_set' // a repository the item CARRIES has no merge on its default branch — item stays In Review (MOTIR-2729)
    | 'missing_artifact_evidence' // a `deploy` item whose comments record no published artifact — item stays where it is (MOTIR-2709 / MOTIR-3364)
    | 'no_work_item'
    | 'no_matching_status'
    | 'illegal_transition'
    | 'open_children' // the item is a CONTAINER whose own children are not landed — it stays where it is (MOTIR-3229)
    | 'access_denied'
    | 'unknown_installation'
    | 'unknown_repo'
    | 'ignored_action'
    | 'malformed';
  workItemId?: string;
  toStatus?: string;
  /** The session branch a `session_closed` delivery closed out (MOTIR-3007). */
  sessionBranch?: string;
  /** How the session close-out went, per item: moved to done / already there /
   *  reported-and-skipped. Present only on `session_closed`, because a delivery
   *  that closes N cards has to SAY N — reporting one of them is what this
   *  outcome exists to stop. */
  sessionItems?: { completed: number; alreadyDone: number; failed: number };
};

/** The connection + repo + resolved author a provider hands the shared sync, once
 *  it has resolved them from its own payload shape. The TENANT comes from
 *  `repo.workspaceId` (MOTIR-1931), never from `installation.workspaceId` — the
 *  installation selects which mirror rows a delivery may touch, the repo row says
 *  whose they are, and a shared provisioning installation has no workspace of its
 *  own. `authorBoundUserId` is the change-request author's Motir user id ONLY when
 *  they are a member of THAT workspace (so the edit gate passes) — null otherwise
 *  (the sync then attributes to the workspace owner). GitLab always passes null
 *  (it has no bound-identity table). */
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
  // the STORED link — MOTIR-3674 retired the head-ref / title parse), the
  // change-request row upsert, and the actor.
  const resolved = await withSystemContext(async (tx) => {
    const ctx = await resolveContext(tx);
    if (ctx.kind === 'unknown_installation') return { kind: 'unknown_installation' as const };
    if (ctx.kind === 'unknown_repo') return { kind: 'unknown_repo' as const };
    const { installation, repo, authorBoundUserId } = ctx;

    // ⚠️ BIND THE TENANT NOW — every statement below this line reads a table with
    // no `system_admin` arm (MOTIR-2880). `resolveContext` reached the CONNECTION
    // tier (`github_installation` / `github_repo`, whose policies read the system
    // flag) and that is what the system context is for; `work_item` and
    // `workspace_membership` are not in that set, so before this call the work-item
    // resolve returned NULL under `motir_app` and the sync silently stopped driving
    // any status. The binding is additive — the flag stays set, so the
    // `github_pull_request` lock/upsert below keeps its own arm.
    //
    // `repo.workspaceId`, never `installation.workspaceId` — the same tenancy rule
    // MOTIR-1931 pinned for the resolve itself, applied one layer down.
    await bindWorkspaceContext(tx, repo.workspaceId);

    // Resolve the change request's linked work item — THE STORED LINK, and
    // nothing else (MOTIR-3674). Lock the row, read it, and use the work item it
    // names. There is no second arm: a delivery for a pull request that carries
    // no link resolves to no work item, whatever its head ref or title says.
    //
    // ⚠️ WHAT WAS DELETED HERE, so the absence reads as a decision. The `else`
    // arm parsed `MOTIR-<n>` out of `${cr.headRef} ${cr.title}` and linked the
    // first candidate that resolved. That is a DIFFERENT question from the one
    // `link_pull_request` answers: the parse says *this text mentions this card*,
    // the link says *this pull request delivers this card*, and they coincide only
    // when the title happens to name the thing being delivered and nothing else.
    // A title naming the parent, a sibling, the bug being fixed or a rule being
    // cited is ordinary good writing, and every one of them mis-linked.
    //
    // ⚠️ THE CONDITION IS `workItemId`, NOT `linkedManually` — the GRANDFATHERING
    // decision, and it is load-bearing rather than incidental. Gating on
    // `linkedManually` would orphan every row the parse ever wrote: on production
    // that is 1026 of 1096 linked rows (70 are `linked_manually`), 1007 of them
    // already merged, and the next delivery for each would overwrite its
    // `work_item_id` with null and empty that card's Development surface. A stored
    // link is a link — MOTIR-3657's backfill already carried all 1096 into
    // `work_item_delivery` for exactly this reason. What this card retires is the
    // INFERENCE, not the history it produced. Prospectively the choice touches TWO
    // rows: the open, parse-linked pull requests on the day it ships.
    //
    // `linkedManually` is left on the row as the record of HOW the link was made,
    // and is now read by nothing here. Dropping the column is its own card, once
    // nothing reads it (MOTIR-3721).
    await githubPullRequestRepository.lockByRepoAndNumber(repo.id, cr.number, tx);
    const existingPr = await githubPullRequestRepository.findByRepoAndNumber(
      repo.id,
      cr.number,
      tx,
    );
    let workItem: ResolvedChangeRequestWorkItem | null = null;
    let linkedManually = false;
    if (existingPr?.workItemId) {
      const linked = await workItemRepository.findById(existingPr.workItemId, tx);
      // A link whose target was hard-deleted falls back to unlinked.
      workItem = linked
        ? {
            id: linked.id,
            identifier: linked.identifier,
            projectId: linked.projectId,
            status: linked.status,
            targetRepos: linked.targetRepos,
          }
        : null;
      linkedManually = linked !== null && existingPr.linkedManually;
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
      // The branch this change request TARGETS (MOTIR-2729). Read from the live
      // payload one screen below to decide THIS delivery; persisted here because
      // the repository-SET gate asks the same question about merges that already
      // happened in other repositories, whose only record is this row.
      baseRef: cr.baseRef,
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

    // MOTIR-3007 — WHICH ITEMS does this delivery carry? A `motir auto` run
    // integrates every card onto ONE session branch and opens ONE pull request,
    // whose branch deliberately carries no `MOTIR-<n>` (see
    // `resolveChangeRequestWorkItemSet`) — so the 1:1 resolve above returns null
    // and, before this, a merge closed nothing at all.
    //
    // Resolved ONLY on a `done` delivery, deliberately: an `opened` /
    // closed-unmerged delivery is byte-for-byte the path it always was, which is
    // the AC "the single-card path is untouched" taken literally. The read is one
    // indexed lookup inside the transaction already open, under the row lock taken
    // above, so a concurrent redelivery serializes on it exactly as the gates do.
    const delivery: ChangeRequestWorkItemSet | null =
      lifecycle === 'done'
        ? await resolveChangeRequestWorkItemSet({
            workspaceId: repo.workspaceId,
            headRef: cr.headRef,
            linked: workItem,
            tx,
          })
        : null;
    const sessionBranch = delivery?.kind === 'session_branch' ? delivery.sessionBranch : null;

    // A delivery that resolves NEITHER a linked item NOR a session branch is the
    // unchanged no-op it always was.
    if (!workItem && !sessionBranch) return { kind: 'no_work_item' as const };

    // MOTIR-1873 — a merge only COMPLETES the item when it landed on the trunk.
    // Compare the change request's base against the MIRRORED default branch, never
    // a hard-coded `'main'`: a self-hoster's repo defaults to `master` / `trunk`
    // and must behave identically. Only a `done` delivery can complete, so this is
    // meaningless for any other lifecycle.
    const mergedIntoNonDefaultBase = lifecycle === 'done' && cr.baseRef !== repo.defaultBranch;

    // MOTIR-1604 — a merge only COMPLETES the item when it is the item's LAST open
    // linked change request. A cross-repo (two-PR) card has >1 linked PR/MR; the
    // first merge must NOT flip Done while a sibling is still open. This row was
    // just upserted (closed, on a merge), so we count the item's OTHER open linked
    // change requests — non-zero means DEFER. Only a `done` delivery can complete,
    // and a stranded merge is already held by the gate above, so skip the read for
    // either.
    //
    // ⚠️ BOTH ITEM-SCOPED GATES ARE SKIPPED ON A SESSION CLOSE-OUT, and that is a
    // boundary rather than an omission (MOTIR-3007). They answer "is THIS item
    // finished", and a session delivery closes N items whose repository sets and
    // sibling change requests differ; `completeSession` walks the branch itself,
    // so there is no per-item exclusion to hand it. Composing the two is the
    // multi-repo axis MOTIR-2725 / MOTIR-2731 own, and this card's scope
    // deliberately stops short of it. Nothing is weakened by the skip: before
    // this card a session merge closed NOTHING, so the gates were never reached
    // on this path at all. The branch-scoped gate above (a merge that never
    // landed on the trunk) DOES still run, and holds the whole close-out.
    // MOTIR-3659 — the item completes only when EVERY pull request DELIVERING it
    // has merged onto its own repository's default branch. Read from the delivery
    // link table, which is the one association the ADR settles on, inside THIS
    // transaction and under the row lock taken above so concurrent redeliveries
    // serialize on it exactly as the other gates do.
    //
    // ⚠️ It ABSTAINS on an empty set, which is what keeps every card that predates
    // this table byte-identical: no links, no shortfall, no hold. Almost every
    // card in the tree is that case.
    const deliveryShortfall =
      lifecycle === 'done' && !mergedIntoNonDefaultBase && !sessionBranch && workItem !== null
        ? deliverySetShortfall(
            (await workItemDeliveryRepository.listByWorkItem(workItem.id, tx)).map((d) => ({
              repoLabel: `${d.repo.owner}/${d.repo.name}`,
              number: d.pullRequest.number,
              merged: d.pullRequest.merged,
              baseRef: d.pullRequest.baseRef,
              defaultBranch: d.repo.defaultBranch,
            })),
          )
        : EMPTY_DELIVERY_SHORTFALL;

    const hasOtherOpenLinkedPr =
      lifecycle === 'done' && !mergedIntoNonDefaultBase && !sessionBranch && workItem !== null
        ? (await githubPullRequestRepository.countOtherOpenByWorkItem(workItem.id, prId, tx)) > 0
        : false;

    // MOTIR-2729 — the item completes only when EVERY repository it CARRIES has a
    // merged change request on that repository's own default branch. The two gates
    // above reason about change requests that EXIST; a repository whose pull
    // request was never opened writes no row, so neither can see it. The expected
    // side is the item's own repository SET (MOTIR-2727).
    //
    // Read inside THIS transaction, after `bindWorkspaceContext` and under the row
    // lock taken above, so concurrent redeliveries serialize on it exactly as the
    // other two do. Skipped for any delivery the gates above already hold or that
    // cannot complete at all — the read costs nothing to skip and the outcome
    // would be discarded.
    const shortfall =
      lifecycle === 'done' &&
      !mergedIntoNonDefaultBase &&
      !hasOtherOpenLinkedPr &&
      !sessionBranch &&
      workItem !== null
        ? repoSetShortfall(
            classifyRepoDelivery(
              // RESOLVED through the references, not the stored name projection
              // (Story MOTIR-2732 · MOTIR-3043). The projection goes stale the
              // moment a repository is renamed on the host, and a gate reading
              // it compares a name no pull request will ever report again.
              await resolveExpectedRepos(workItem.id, workItem.targetRepos, tx),
              await githubPullRequestRepository.listCompletionFactsByWorkItem(workItem.id, tx),
            ),
          )
        : EMPTY_SHORTFALL;

    const owner = await workspaceMembershipRepository.findOwnerByWorkspace(repo.workspaceId, tx);
    return {
      kind: 'resolved' as const,
      workspaceId: repo.workspaceId,
      projectId: workItem?.projectId ?? null,
      workItemId: workItem?.id ?? null,
      currentStatus: workItem?.status ?? null,
      // Non-null ⇒ this merge closes out a whole run's branch (MOTIR-3007).
      sessionBranch,
      provider: installation.provider as GitProviderId,
      defaultBranch: repo.defaultBranch,
      mergedIntoNonDefaultBase,
      // Whether the row ALREADY recorded this merge before this delivery — read
      // under the row lock taken above, so concurrent redeliveries serialize on it.
      // It is what keeps the stranded-merge note POSTED ONCE: the note describes a
      // merge event, and GitHub redelivers events freely.
      mergeAlreadyRecorded: existingPr?.state === 'closed' && existingPr.merged === true,
      hasOtherOpenLinkedPr,
      deliveryShortfall,
      shortfall,
      actorUserId: authorBoundUserId ?? owner?.userId ?? null,
      ownerUserId: owner?.userId ?? null,
    };
  });

  if (resolved.kind === 'unknown_installation')
    return { event: 'pull_request', outcome: 'unknown_installation' };
  if (resolved.kind === 'unknown_repo') return { event: 'pull_request', outcome: 'unknown_repo' };
  if (resolved.kind === 'no_work_item') return { event: 'pull_request', outcome: 'no_work_item' };

  // A merge that did NOT land on the default branch leaves the item where it is —
  // In Review, from its own PR-opened delivery (MOTIR-1873). The work merged
  // SOMEWHERE, so it is neither abandoned (which would be `todo`) nor complete;
  // the umbrella change request that eventually reaches the trunk fires its own
  // delivery and completes the item then.
  //
  // Checked BEFORE the actor gate and BEFORE MOTIR-1604's, on purpose. Before the
  // actor gate because holding the item must not depend on there being someone to
  // author a note — the note is the diagnosis, the hold is the correctness. Before
  // 1604's because this is the stronger statement: a merge with no path to the
  // trunk is not partial completion, it is none.
  if (resolved.mergedIntoNonDefaultBase) {
    // Never a silent no-op — invisibility is what made the incident expensive. Say
    // WHICH base swallowed the merge, on the item itself, where the next person to
    // read the card (or the next `motir run` that treats it as a prerequisite) will
    // see it. Posted once per merge, and best-effort: a failed note must not turn a
    // correct hold into a 500 the host retries forever.
    if (resolved.actorUserId && resolved.workItemId && !resolved.mergeAlreadyRecorded) {
      try {
        await commentsService.addComment(
          resolved.workItemId,
          {
            bodyMd: strandedMergeCommentBody({
              noun: changeRequestNoun(resolved.provider),
              number: cr.number,
              baseRef: cr.baseRef,
              defaultBranch: resolved.defaultBranch,
            }),
          },
          { userId: resolved.actorUserId, workspaceId: resolved.workspaceId },
        );
      } catch (err) {
        console.error('[changeRequestStatusSync] stranded-merge note failed; item still held', {
          workItemId: resolved.workItemId,
          number: cr.number,
          baseRef: cr.baseRef,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
    return {
      event: 'pull_request',
      outcome: 'deferred_non_default_base',
      ...(resolved.workItemId ? { workItemId: resolved.workItemId } : {}),
      ...(resolved.sessionBranch ? { sessionBranch: resolved.sessionBranch } : {}),
    };
  }

  if (!resolved.actorUserId)
    // No workspace owner and no bound author — nothing can author the move.
    return {
      event: 'pull_request',
      outcome: 'access_denied',
      ...(resolved.workItemId ? { workItemId: resolved.workItemId } : {}),
    };

  // MOTIR-3659 — a merge that leaves any pull request DELIVERING this item
  // unlanded holds the item In Review. THIRD, ahead of the two gates below, because
  // it is the most specific answer available: a card that carries delivery links
  // should be decided by its links rather than fall through to a proxy for them.
  //
  // It abstains on a card with no links, so the two gates below are still the only
  // protection every card that predates this table has — which is nearly all of
  // them — and neither is weakened.
  if (
    lifecycle === 'done' &&
    resolved.workItemId &&
    hasDeliverySetShortfall(resolved.deliveryShortfall)
  ) {
    // Never a silent hold, for the reason MOTIR-1873 already paid for. Posted once
    // per merge (the same `mergeAlreadyRecorded` read taken under the row lock) and
    // best-effort — a failed note must not turn a correct hold into a 500 the host
    // redelivers forever.
    if (resolved.actorUserId && !resolved.mergeAlreadyRecorded) {
      try {
        await commentsService.addComment(
          resolved.workItemId,
          {
            bodyMd: incompleteDeliverySetCommentBody({
              noun: changeRequestNoun(resolved.provider),
              number: cr.number,
              shortfall: resolved.deliveryShortfall,
            }),
          },
          { userId: resolved.actorUserId, workspaceId: resolved.workspaceId },
        );
      } catch (err) {
        console.error('[changeRequestStatusSync] delivery-set note failed; item still held', {
          workItemId: resolved.workItemId,
          number: cr.number,
          outstanding: resolved.deliveryShortfall.outstanding,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
    return {
      event: 'pull_request',
      outcome: 'deferred_incomplete_delivery_set',
      workItemId: resolved.workItemId,
    };
  }

  // A merged change request that is NOT the item's last open linked one leaves the
  // item In Review — a cross-repo (two-PR) card completes only when its LAST linked
  // change request merges (MOTIR-1604).
  if (lifecycle === 'done' && resolved.hasOtherOpenLinkedPr && resolved.workItemId) {
    return { event: 'pull_request', outcome: 'deferred_open_pr', workItemId: resolved.workItemId };
  }

  // A merge that leaves any repository the item CARRIES without a merge of its own
  // holds the item In Review (MOTIR-2729). THIRD, not a replacement for the gate
  // above: that one works with no expected set at all and is therefore the only
  // protection every unpinned card in the product has. Where both hold, the one
  // above wins on purpose — "a sibling change request is still open" names an
  // artifact the reader can go and look at.
  if (lifecycle === 'done' && resolved.workItemId && hasRepoSetShortfall(resolved.shortfall)) {
    // Never a silent hold, for the reason MOTIR-1873 already paid for. Posted once
    // per merge (guarded by the same `mergeAlreadyRecorded` read taken under the
    // row lock) and best-effort — a failed note must not turn a correct hold into
    // a 500 the host retries forever.
    if (resolved.actorUserId && !resolved.mergeAlreadyRecorded) {
      try {
        await commentsService.addComment(
          resolved.workItemId,
          {
            bodyMd: incompleteRepoSetCommentBody({
              noun: changeRequestNoun(resolved.provider),
              number: cr.number,
              shortfall: resolved.shortfall,
            }),
          },
          { userId: resolved.actorUserId, workspaceId: resolved.workspaceId },
        );
      } catch (err) {
        console.error('[changeRequestStatusSync] repo-set note failed; item still held', {
          workItemId: resolved.workItemId,
          number: cr.number,
          outstanding: resolved.shortfall.outstanding,
          error: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
    return {
      event: 'pull_request',
      outcome: 'deferred_incomplete_repo_set',
      workItemId: resolved.workItemId,
    };
  }

  // ── The SESSION close-out (MOTIR-3007) ────────────────────────────────────
  // A merged delivery whose head ref is a session branch carrying work items
  // closes EVERY card on that branch, not the one a title happened to name.
  //
  // It runs through the shipped `completeSession` — the same authority
  // `motir done --session` calls — so every closure goes through
  // `applyStatusTransition` and records a revision, an item already `done` is an
  // idempotent no-op, and an item with no legal edge to `done` is REPORTED and
  // skipped rather than failing the delivery. The card named in the pull request
  // title is on the branch like every other, so it is closed exactly once, here;
  // there is no separate pass for it.
  //
  // IDEMPOTENT UNDER REDELIVERY by construction, with nothing added: the close-out
  // CLEARS `session_branch` as it goes, so a second delivery of the same merge
  // resolves an empty branch, falls through to the single-item path, and finds
  // either no work item at all or one already in `done`. The same is true of a
  // merge that arrives after a human already ran `motir done --session`.
  if (resolved.sessionBranch) {
    const summary = await closeOutSession(resolved.sessionBranch, {
      workspaceId: resolved.workspaceId,
      actorUserId: resolved.actorUserId,
      ownerUserId: resolved.ownerUserId,
    });
    return {
      event: 'pull_request',
      outcome: 'session_closed',
      sessionBranch: resolved.sessionBranch,
      sessionItems: summary,
      // The linked item, when the pull request also named one — it is IN the set
      // above, reported here only so a log line still points at a card.
      ...(resolved.workItemId ? { workItemId: resolved.workItemId } : {}),
    };
  }

  // Past this point the delivery is the ordinary single-item one, which only
  // exists when a work item resolved.
  if (!resolved.workItemId || !resolved.projectId || resolved.currentStatus === null)
    return { event: 'pull_request', outcome: 'no_work_item' };

  // Phase 2 — the status transition through the SHIPPED authority. Resolve the
  // concrete target status key by category against the project's live workflow.
  const targetKey = await workflowsService.resolveStatusKey(
    resolved.projectId,
    resolved.workspaceId,
    LIFECYCLE_TARGET[lifecycle],
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

  // The narrowed slice `reportTransitionRefusal` needs, hoisted once: the guards
  // above proved `workItemId` and `actorUserId` non-null, and that narrowing is
  // per-property — it does not survive passing `resolved` itself.
  const refusalContext = {
    workItemId: resolved.workItemId,
    workspaceId: resolved.workspaceId,
    actorUserId: resolved.actorUserId,
    provider: resolved.provider,
    mergeAlreadyRecorded: resolved.mergeAlreadyRecorded,
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
        return reportTransitionRefusal(retryErr, cr, refusalContext, targetKey);
      }
      return {
        event: 'pull_request',
        outcome: 'transitioned',
        workItemId: resolved.workItemId,
        toStatus: targetKey,
      };
    }
    return reportTransitionRefusal(err, cr, refusalContext, targetKey);
  }

  return {
    event: 'pull_request',
    outcome: 'transitioned',
    workItemId: resolved.workItemId,
    toStatus: targetKey,
  };
}

/**
 * Classify a refused transition AND — for the refusals that leave no other trace
 * — say so ON THE CARD (MOTIR-3364).
 *
 * ⚠️ WHY THIS SITS BETWEEN THE CATCH AND `classifyTransitionError`. The two holds
 * decided BEFORE the transition (`deferred_non_default_base`,
 * `deferred_incomplete_repo_set`) each post their own note inline, because the
 * facts they report — a base ref, a repository list — are in hand there. The
 * artifact-evidence gate is decided INSIDE `applyStatusTransition`, so its refusal
 * only ever surfaces here, as an exception. Before this function it surfaced as a
 * rethrow: a 500 on a successful merge delivery, and a card silently parked at In
 * Review. The hold was right; only its shape was wrong.
 *
 * The note is posted under the SAME two conditions the other two use: once per
 * merge (`mergeAlreadyRecorded` — the host redelivers events freely), and
 * best-effort, because a failed comment must never turn a correct hold back into
 * the 500 this card exists to remove.
 */
async function reportTransitionRefusal(
  err: unknown,
  cr: NormalizedChangeRequest,
  resolved: {
    workItemId: string;
    workspaceId: string;
    actorUserId: string;
    provider: GitProviderId;
    mergeAlreadyRecorded: boolean;
  },
  targetKey: string,
): Promise<ChangeRequestSyncResult> {
  const result = classifyTransitionError(err, resolved.workItemId, targetKey);
  if (result.outcome === 'missing_artifact_evidence' && !resolved.mergeAlreadyRecorded) {
    try {
      await commentsService.addComment(
        resolved.workItemId,
        {
          bodyMd: missingArtifactEvidenceCommentBody({
            noun: changeRequestNoun(resolved.provider),
            number: cr.number,
          }),
        },
        { userId: resolved.actorUserId, workspaceId: resolved.workspaceId },
      );
    } catch (noteErr) {
      console.error('[changeRequestStatusSync] artifact-evidence note failed; item still held', {
        workItemId: resolved.workItemId,
        number: cr.number,
        error: noteErr instanceof Error ? noteErr.message : 'unknown',
      });
    }
  }
  return result;
}

/** The missing-artifact-evidence note (MOTIR-2709's gate, MOTIR-3364's note) —
 *  posted on the linked item when a merge cannot complete a `deploy` card because
 *  no comment on it records what was published.
 *
 *  It carries the same two obligations as its two siblings below: name the fact
 *  that turns *"why isn't this Done?"* into a one-minute answer, and state the
 *  condition that WILL complete the item, so the hold never reads as a stuck
 *  integration.
 *
 *  ⚠️ **THE NOTE MUST NOT SATISFY THE GATE IT EXPLAINS, and that is a live trap
 *  rather than a theoretical one.** The check is a string SCAN over every comment
 *  body on the card (`assessArtifactEvidence`), and this note is a comment on that
 *  card — so an illustrative `1.4.0` in the text is indistinguishable, to the
 *  scanner, from a version somebody recorded. Drafted that way it turned the
 *  second delivery of the same merge into a `done`: the hold posted its own way
 *  out, and a redelivery — which the host does freely — closed the card the gate
 *  had just refused. The examples here are therefore deliberately shaped to match
 *  NOTHING: the two prefixes carry no digest body (the matchers need 12+ hex / 20+
 *  base64 characters after them), and the version is named rather than shown.
 *  `NO_ARTIFACT_MARKER` is safe to quote inline because its own matcher is
 *  line-anchored for exactly this reason. `tests/github/changeRequestArtifactEvidenceGate.test.ts`
 *  asserts the rendered body scans as `missing`.
 *
 *  Like the others it describes what did NOT happen rather than asserting a
 *  status: the sync leaves the item exactly where it was. */
function missingArtifactEvidenceCommentBody(args: { noun: string; number: number }): string {
  return (
    `⚠️ **Merged, but this release recorded nothing** — ${args.noun} #${args.number} merged, ` +
    `and this is a \`deploy\` item whose deliverable lives outside the repository, so the merge ` +
    `is not proof it shipped. No comment here records an artifact, so the item's status is left ` +
    `unchanged.\n\n` +
    `It completes once a comment on this item carries the identifier a consumer would install — ` +
    `the published version number, a registry digest (\`sha256:\` followed by the digest) or an ` +
    `integrity hash (\`sha512-\` followed by the hash). If this deliverable genuinely has no ` +
    `identifier (a DNS cutover, a console toggle), say so in a comment beginning ` +
    `\`${NO_ARTIFACT_MARKER}\` followed by the reason.`
  );
}

/** The incomplete-repository-set note (MOTIR-2729) — posted on the linked item
 *  when a merge leaves some repository the item carries without one of its own.
 *
 *  It names the repositories, because that single fact is what turns "why isn't
 *  this Done?" into a one-minute answer, and it states the condition that WILL
 *  complete the item so the hold never reads as a stuck integration — the same
 *  two obligations the stranded-merge note below carries.
 *
 *  Like that one, it describes what did NOT happen rather than asserting a
 *  status: the sync leaves the item exactly where it was.
 *
 *  ⚠️ THE HEADING SAYS NOTHING ABOUT HOW MANY REPOSITORIES (MOTIR-3034). It read
 *  "this item ships in more than one repository" until a ONE-element set was held
 *  by the unknown-base arm and the note told its reader something plainly false
 *  about their own card. The gate is about EVERY repository, never about more than
 *  one — the set of size one is not an edge case here, it is the common case. */
/** The incomplete-DELIVERY-SET note (MOTIR-3659) — posted on the item when a merge
 *  lands while another pull request DELIVERING that item has not.
 *
 *  Sibling of the repository-set note below, and deliberately distinguishable from
 *  it: that one names REPOSITORIES the card promised, this one names PULL REQUESTS
 *  that exist. A reader who cannot tell which gate held their card cannot tell
 *  whether to go and merge something or to fix the card's repository set.
 *
 *  Like both of its siblings it describes what did NOT happen rather than asserting
 *  a status: the sync leaves the item exactly where it was. */
function incompleteDeliverySetCommentBody(args: {
  noun: string;
  number: number;
  shortfall: DeliverySetShortfall;
}): string {
  const list = (names: string[]) => names.map((n) => `\`${n}\``).join(', ');
  const lines: string[] = [
    `⚠️ **Merged, but this item is not complete** — ${args.noun} ` +
      `#${args.number} merged, and another ${args.noun} delivering this item has not, ` +
      `so its status is left unchanged.`,
  ];
  if (args.shortfall.outstanding.length > 0) {
    lines.push(
      `Still open: ${list(args.shortfall.outstanding)} — ` +
        `${args.shortfall.outstanding.length === 1 ? 'it has' : 'they have'} not merged yet.`,
    );
  }
  if (args.shortfall.strandedBase.length > 0) {
    lines.push(
      `Merged, but not onto the trunk: ${list(args.shortfall.strandedBase)} — ` +
        `${args.shortfall.strandedBase.length === 1 ? 'it' : 'they'} landed on a base other ` +
        `than that repository's own default branch, so the work has not reached it. Merging ` +
        `that base forward is what completes this item.`,
    );
  }
  if (args.shortfall.unknownBase.length > 0) {
    lines.push(
      `No record of which branch the merge landed on for ${list(args.shortfall.unknownBase)} — ` +
        `Motir mirrored ${args.shortfall.unknownBase.length === 1 ? 'it' : 'them'} before it began ` +
        `recording base branches, so it cannot tell whether the work reached the trunk. An ` +
        `operator can repair this without a new merge — \`pnpm db:backfill:pr-base-ref\` reads ` +
        `the base back from the provider and re-runs this decision.`,
    );
  }
  lines.push(
    `The item completes when every ${args.noun} that delivers it has merged onto its own ` +
      `repository's default branch. If one of them does not in fact deliver this item, unlink it.`,
  );
  return lines.join('\n\n');
}

function incompleteRepoSetCommentBody(args: {
  noun: string;
  number: number;
  shortfall: RepoSetShortfall;
}): string {
  const list = (names: string[]) => names.map((n) => `\`${n}\``).join(', ');
  const lines: string[] = [
    `⚠️ **Merged, but this item is not complete** — ${args.noun} ` +
      `#${args.number} merged, and the item is not complete yet, so its status is left unchanged.`,
  ];
  if (args.shortfall.outstanding.length > 0) {
    lines.push(
      `Still outstanding: ${list(args.shortfall.outstanding)} — no ${args.noun} merged onto ` +
        `${args.shortfall.outstanding.length === 1 ? 'its' : 'their'} default ` +
        `branch${args.shortfall.outstanding.length === 1 ? '' : 'es'} yet.`,
    );
  }
  if (args.shortfall.unknownBase.length > 0) {
    lines.push(
      `No record of which branch the merge landed on for ${list(args.shortfall.unknownBase)} — ` +
        `${args.shortfall.unknownBase.length === 1 ? 'that repository has' : 'those repositories have'} ` +
        `a merged ${args.noun} that Motir mirrored before it began recording base branches, so it ` +
        `cannot tell whether the work reached the trunk. An operator can repair this without a new ` +
        `merge — \`pnpm db:backfill:pr-base-ref\` reads the base back from the provider and re-runs ` +
        `this decision (MOTIR-3034).`,
    );
  }
  if (args.shortfall.unestablished.length > 0) {
    // The third kind of shortfall (Story MOTIR-2732 · ADR §A5) — and the one
    // whose answer is NOT "open a pull request". The card points at a
    // `project_repository` row that names no repository yet, so telling the
    // reader to merge something would send them somewhere that does not exist.
    lines.push(
      `Not created yet: ${list(args.shortfall.unestablished)} — ` +
        `${args.shortfall.unestablished.length === 1 ? 'that repository is' : 'those repositories are'} ` +
        `still proposed on the project, so there is nothing to open a ${args.noun} against. ` +
        `Establish the ${args.shortfall.unestablished.length === 1 ? 'row' : 'rows'} in the ` +
        `project's repository settings, or skip ${args.shortfall.unestablished.length === 1 ? 'it' : 'them'} ` +
        `if the work does not ship there.`,
    );
  }
  lines.push(
    `The item completes when every repository it carries has a ${args.noun} merged onto that ` +
      `repository's own default branch. If one of them is not where this work ships, remove it ` +
      `from the item's repositories.`,
  );
  return lines.join('\n\n');
}

/** The stranded-merge note (MOTIR-1873) — posted on the linked item when a merge
 *  landed on a base other than the repository's default branch. It names the base
 *  that swallowed the merge, because that single fact is what turns "why isn't this
 *  Done?" into a one-minute answer, and states the condition that WILL complete the
 *  item so the hold never reads as a stuck integration.
 *
 *  It describes what did NOT happen rather than asserting a status: the sync leaves
 *  the item exactly where it was, and where that is depends on which of this change
 *  request's earlier deliveries were seen. */
function strandedMergeCommentBody(args: {
  noun: string;
  number: number;
  baseRef: string;
  defaultBranch: string;
}): string {
  return (
    `⚠️ **Merged, but not onto \`${args.defaultBranch}\`** — ${args.noun} #${args.number} ` +
    `merged into \`${args.baseRef}\`, which is not this repository's default branch. ` +
    `The code has not reached the trunk, so this merge does **not** move the item to ` +
    `**Done** — its status is left unchanged. It completes when a ${args.noun} carrying ` +
    `this work merges into \`${args.defaultBranch}\`; if \`${args.baseRef}\` has itself ` +
    `already been merged and deleted, the work is stranded and needs re-landing.`
  );
}

/** The work-item slice the change-request resolver returns — enough for the
 *  sync's transition decision and for the mirror's link column. */
export interface ResolvedChangeRequestWorkItem {
  id: string;
  /** `PROD-42` — carried so the shared delivery resolver (MOTIR-3007) can report
   *  the single-item path in the same shape as the session one. */
  identifier: string;
  projectId: string;
  status: string;
  /** The repositories this item ships in — the EXPECTED side of MOTIR-2729's
   *  completion gate. Empty for every card that names none, which is the common
   *  case and the one the gate abstains on. */
  targetRepos: string[];
}

/* ⚠️ `resolveChangeRequestWorkItem` — the head-ref / title PARSE — WAS HERE, and
 * is deleted by MOTIR-3674 along with `parseKeyCandidates` / `KEY_CANDIDATE_RE`.
 * Its MOTIR-1965 header argued that ONE resolver must serve both the live
 * delivery and the historical backfill, so the two could never drift. That
 * argument is kept and satisfied by removal: there is still exactly one rule, and
 * it is now `work_item_delivery` / `github_pull_request.work_item_id` — a stored
 * link, written by `link_pull_request` or `mark_integrated`, never inferred from
 * text. The backfill stops attributing rather than growing a parser of its own
 * (`historicalPullRequestBackfillService`, option A of the card).
 *
 * Recorded rather than silently deleted because the function was EXPORTED and its
 * absence is the decision: a reader who wants a title to link a pull request
 * again is re-opening MOTIR-3672, not filling a gap.
 */

/** Close out one session branch — every card a run integrated onto it (MOTIR-3007).
 *
 *  Attribution mirrors the single-item path exactly: the change request's author
 *  when they are a bound member with edit rights, else the workspace owner. The
 *  difference is HOW a denial surfaces — `completeSession` catches a per-item
 *  `ProjectAccessDeniedError` and reports the item as `failed` rather than
 *  throwing, so the single path's try/catch retry has nothing to catch. The retry
 *  is therefore driven off the RESULTS, and it is naturally scoped: a failed item
 *  still carries its branch (only a closed one is cleared), so the second pass
 *  sees exactly the items the first could not close and nothing else.
 *
 *  Returns the per-outcome counts, because a delivery that closes N cards has to
 *  say N — reporting one of them is the defect this whole card is about. */
async function closeOutSession(
  sessionBranch: string,
  actors: { workspaceId: string; actorUserId: string; ownerUserId: string | null },
): Promise<{ completed: number; alreadyDone: number; failed: number }> {
  const tally = (results: CompleteSessionItemResultDto[]) => ({
    completed: results.filter((r) => r.outcome === 'completed').length,
    alreadyDone: results.filter((r) => r.outcome === 'already_done').length,
    failed: results.filter((r) => r.outcome === 'failed').length,
  });

  const first = await workItemsService.completeSession(sessionBranch, {
    userId: actors.actorUserId,
    workspaceId: actors.workspaceId,
  });
  const counts = tally(first.results);
  if (counts.failed === 0 || !actors.ownerUserId || actors.ownerUserId === actors.actorUserId) {
    return counts;
  }

  // The author could not close some of them (a viewer, typically). Retry as the
  // owner — a manager, always edit-capable — exactly as the single-item path does,
  // and merge the two passes: the second only ever sees the first's failures.
  const retry = await workItemsService.completeSession(sessionBranch, {
    userId: actors.ownerUserId,
    workspaceId: actors.workspaceId,
  });
  const retried = tally(retry.results);
  return {
    completed: counts.completed + retried.completed,
    alreadyDone: counts.alreadyDone + retried.alreadyDone,
    failed: retried.failed,
  };
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
 *  re-throws (a 500 the host retries).
 *
 *  ⚠️ EVERY member of `STATUS_TRANSITION_REFUSALS` must have an arm here, and
 *  `tests/workItems/statusTransitionRefusals.test.ts` asserts it — the arms below
 *  are deliberately one-per-error rather than a single `isStatusTransitionRefusal`
 *  branch, because each refusal earns a DISTINCT outcome a log line can be read
 *  off. The predicate is what `completeSession` uses, where the reported shape is
 *  the same for all of them.
 *
 *  EXPORTED for that test, which needs to drive it with a constructed instance of
 *  each refusal; nothing else calls it from outside this module. */
export function classifyTransitionError(
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
  // The container-completeness gate (MOTIR-3229). A container whose own children
  // are not landed is a legitimate REFUSAL, not a fault: the sync leaves the item
  // where it is and says so, exactly as it does for a workflow with no legal edge.
  // Rethrowing would fail the webhook job and have the host retry it forever, on a
  // condition only a person adding work to the tree can clear. This is also the
  // shape MOTIR-1343 actually took — the PR-link automation moved the story to In
  // Review while two children sat at `todo`.
  if (err instanceof ContainerHasOpenChildrenError)
    return { event: 'pull_request', outcome: 'open_children', workItemId, toStatus };
  // The close-out artifact-evidence gate (MOTIR-2709). A `deploy` card whose
  // comments record no published artifact is a legitimate REFUSAL, like the two
  // above it: the merge happened, the release is unattested, and only a person can
  // clear that by recording what shipped. It reached this function as a RETHROW
  // until MOTIR-3364 — a 500 on a successful merge delivery, and a card left at In
  // Review with nothing on it to say why. `reportTransitionRefusal` posts that note.
  if (err instanceof MissingArtifactEvidenceError)
    return { event: 'pull_request', outcome: 'missing_artifact_evidence', workItemId, toStatus };
  throw err;
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

/**
 * Re-apply the sync for a pull request whose LINK has just arrived.
 *
 * ⚠️ WHY THIS EXISTS — the ordering the parse used to hide (Story MOTIR-3672).
 * A delivery resolves its card from the STORED link, and the link is written by
 * `link_pull_request` AFTER the pull request exists. In a real run those two
 * happen in this order: the agent runs `gh pr create`, GitHub delivers `opened`
 * within a second, and the agent's link call lands several seconds later. So the
 * `opened` delivery correctly finds no card and moves nothing — and under the
 * retired parse that never showed, because the title carried the key and the
 * delivery attributed itself.
 *
 * Without this, the card would sit in In Progress until the MERGE closed it,
 * silently skipping Implemented — the state MOTIR-2999 introduced to say "the
 * code is pushed and no build has spoken for it". The story's own acceptance
 * receipt asserts the card lands there from exactly this open-then-link
 * sequence, which is what surfaced the gap.
 *
 * So linking runs the sync the delivery could not: same function, same gates,
 * same outcomes. It is not a second status writer — every deferral, every repo-
 * and delivery-set check and every refusal comment is the shipped path's.
 *
 * ⚠️ ONLY WHERE A DELIVERY HAS ALREADY BEEN. The caller passes a pull request
 * whose row PRE-EXISTED the link; when the link is what created the row, no
 * delivery has arrived yet, there is nothing to catch up on, and the `opened`
 * delivery still to come does the transition itself. Resyncing there would move
 * the card early and leave that delivery reporting `noop` — a true statement
 * about a card that had already been moved by something other than the event
 * the outcome names.
 *
 * ⚠️ OPEN AND UNMERGED ONLY, and that is a decision rather than an omission. A
 * pull request that is already closed or merged reaches this through a `closed`
 * delivery, which carries the merge facts the completion gate reads; re-deriving
 * `done` from a link would let someone complete a card by attaching an old
 * merged pull request to it, which is a different feature and needs its own
 * argument. An open one asserts only what the link itself already says: this
 * code is being written for this card.
 *
 * Best-effort at the call site, like the check refresh beside it: the link is the
 * durable fact, this is a consequence of it, and a sync that cannot run must
 * never turn a recorded link into an error the caller sees.
 */
export async function resyncLinkedPullRequest(
  githubPullRequestId: string,
): Promise<ChangeRequestSyncResult | null> {
  const subject = await withSystemContext(async (tx: Prisma.TransactionClient) =>
    githubPullRequestRepository.findByIdWithInstallation(githubPullRequestId, tx),
  );
  if (!subject || subject.state !== 'open' || subject.merged) return null;
  // ⚠️ And a row with NO base ref does not resync. `baseRef` is nullable on the
  // stored row (rows written before it was captured) and REQUIRED on the
  // normalized shape, whose own contract is that a payload carrying no
  // destination does not normalize rather than defaulting to a guess. The
  // completion gate reads this field against the mirrored default branch, so a
  // guess here is not a cosmetic default — it is the difference between "reached
  // the trunk" and "merged onto a dead branch". `linkPullRequestByCoordinates`
  // always writes one, so this skips only rows an older delivery created.
  if (subject.baseRef === null) return null;

  const cr: NormalizedChangeRequest = {
    providerRepoId: subject.repo.repoId,
    number: subject.number,
    state: 'open',
    merged: false,
    headRef: subject.headRef,
    baseRef: subject.baseRef,
    title: subject.title,
  };

  return syncChangeRequestStatus(cr, 'implemented', async (tx) => {
    // The same bind the providers' own resolvers do, for the same reason: the
    // repo row is where the tenant is learned, and everything the sync reads
    // below it lives in tables with no `system_admin` arm (MOTIR-2880).
    await bindWorkspaceContext(tx, subject.repo.workspaceId);
    return {
      kind: 'resolved',
      installation: subject.repo.installation,
      repo: subject.repo,
      // The LINKER is not the pull request's author, and this argument names the
      // author. Passing null takes the documented owner-fallback attribution
      // rather than crediting the wrong person for opening the branch.
      authorBoundUserId: null,
    };
  });
}
