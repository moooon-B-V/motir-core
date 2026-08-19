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
  classifyRepoDelivery,
  hasRepoSetShortfall,
  repoSetShortfall,
  EMPTY_SHORTFALL,
  type RepoSetShortfall,
} from '@/lib/workItems/repoDelivery';
import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { commentsService } from './commentsService';
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
    | 'deferred_non_default_base' // a merge into a NON-default base — the work never reached the trunk, item stays In Review (MOTIR-1873)
    | 'deferred_incomplete_repo_set' // a repository the item CARRIES has no merge on its default branch — item stays In Review (MOTIR-2729)
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
  // the head ref / title), the change-request row upsert, and the actor.
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
    let workItem: ResolvedChangeRequestWorkItem | null;
    let linkedManually: boolean;
    if (existingPr?.linkedManually && existingPr.workItemId) {
      const manual = await workItemRepository.findById(existingPr.workItemId, tx);
      // A manual link whose target was hard-deleted falls back to unlinked.
      workItem = manual
        ? {
            id: manual.id,
            projectId: manual.projectId,
            status: manual.status,
            targetRepos: manual.targetRepos,
          }
        : null;
      linkedManually = manual !== null;
    } else {
      // `repo.workspaceId`, never `installation.workspaceId` (MOTIR-1931): the
      // installation SELECTED this repo, the repo row says whose it is. Under
      // Motir's shared provisioning installation the installation names no
      // workspace at all, and under a user's own grant the two are equal — so
      // this is the one tenancy read on both paths.
      workItem = await resolveChangeRequestWorkItem(repo.workspaceId, cr, tx);
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

    if (!workItem) return { kind: 'no_work_item' as const };

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
    const hasOtherOpenLinkedPr =
      lifecycle === 'done' && !mergedIntoNonDefaultBase
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
      lifecycle === 'done' && !mergedIntoNonDefaultBase && !hasOtherOpenLinkedPr
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
      projectId: workItem.projectId,
      workItemId: workItem.id,
      currentStatus: workItem.status,
      provider: installation.provider as GitProviderId,
      defaultBranch: repo.defaultBranch,
      mergedIntoNonDefaultBase,
      // Whether the row ALREADY recorded this merge before this delivery — read
      // under the row lock taken above, so concurrent redeliveries serialize on it.
      // It is what keeps the stranded-merge note POSTED ONCE: the note describes a
      // merge event, and GitHub redelivers events freely.
      mergeAlreadyRecorded: existingPr?.state === 'closed' && existingPr.merged === true,
      hasOtherOpenLinkedPr,
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
    if (resolved.actorUserId && !resolved.mergeAlreadyRecorded) {
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
      workItemId: resolved.workItemId,
    };
  }

  if (!resolved.actorUserId)
    // No workspace owner and no bound author — nothing can author the move.
    return { event: 'pull_request', outcome: 'access_denied', workItemId: resolved.workItemId };

  // A merged change request that is NOT the item's last open linked one leaves the
  // item In Review — a cross-repo (two-PR) card completes only when its LAST linked
  // change request merges (MOTIR-1604).
  if (lifecycle === 'done' && resolved.hasOtherOpenLinkedPr) {
    return { event: 'pull_request', outcome: 'deferred_open_pr', workItemId: resolved.workItemId };
  }

  // A merge that leaves any repository the item CARRIES without a merge of its own
  // holds the item In Review (MOTIR-2729). THIRD, not a replacement for the gate
  // above: that one works with no expected set at all and is therefore the only
  // protection every unpinned card in the product has. Where both hold, the one
  // above wins on purpose — "a sibling change request is still open" names an
  // artifact the reader can go and look at.
  if (lifecycle === 'done' && hasRepoSetShortfall(resolved.shortfall)) {
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
  projectId: string;
  status: string;
  /** The repositories this item ships in — the EXPECTED side of MOTIR-2729's
   *  completion gate. Empty for every card that names none, which is the common
   *  case and the one the gate abstains on. */
  targetRepos: string[];
}

/** Resolve the change request's linked work item from its head ref + title (the
 *  `MOTIR-<n>` hint the seam leaves for the consumer). Extracts every
 *  `<PREFIX>-<number>` candidate, resolves the project by prefix WITHIN the
 *  connection's workspace, then the work item by its full identifier. First
 *  resolved match wins; null when it references no work item in this workspace.
 *
 *  EXPORTED as THE resolver (MOTIR-1965), not merely as this module's helper.
 *  The historical-PR backfill mirrors change requests that predate the App
 *  installation, and it must attribute them EXACTLY as a live delivery would —
 *  a second parser would silently drift (a different key regex, a different
 *  prefix-resolution order) and hand two different work items the same PR
 *  depending on which path ingested it. There is one rule; this is it. */
export async function resolveChangeRequestWorkItem(
  workspaceId: string,
  cr: NormalizedChangeRequest,
  tx: Prisma.TransactionClient,
): Promise<ResolvedChangeRequestWorkItem | null> {
  const seen = new Set<string>();
  for (const { prefix, number } of parseKeyCandidates(`${cr.headRef} ${cr.title ?? ''}`)) {
    const dedupeKey = `${prefix}-${number}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const project = await projectRepository.findByIdentifier(workspaceId, prefix, tx);
    if (!project) continue;
    const workItem = await workItemRepository.findByIdentifier(project.id, dedupeKey, tx);
    if (workItem)
      return {
        id: workItem.id,
        projectId: workItem.projectId,
        status: workItem.status,
        targetRepos: workItem.targetRepos,
      };
  }
  return null;
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
