import type { Prisma } from '@/generated/prisma/client';
import { getGitProvider } from '@/lib/git';
import type { ChangeRequestMergeability, GitProviderId } from '@/lib/git/types';
import { CONFLICTED_MERGEABLE_STATE } from '@/lib/github/mergeability';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { bindWorkspaceContext, withSystemContext } from '@/lib/workspaces/context';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { resolveDeliveredWorkItems } from './changeRequestWorkItems';
import { queueExitCardMoves, settleUnlandedOutcome } from './mergeQueueExitService';
import { withdrawPullRequestApprovalGatesOnConflict } from './pullRequestApprovalGates';

// THE HOST'S MERGEABILITY, ACTED ON (MOTIR-5914, for bug MOTIR-5907; design/github § 30).
//
// A conflict almost never arrives on the pull request itself: another merge moves the
// BASE, GitHub sends this pull request nothing, its checks stay green, and its
// approve-and-merge question sat in To approve until somebody pressed a button that could
// only be refused. This service is where Motir ASKS instead — and where what it hears
// withdraws the question.
//
// ⚠️ ONE ENTRY POINT FOR THE WITHDRAWAL — {@link pullRequestMergeabilityService.withdrawForConflict}.
// The base-branch push (this service's job), the reconcile tick and the press-time read
// (`pullRequestMergeService`) all call it, so the rule "a conflict is the CAN'T-LAND class
// however it is found" (§ 30 rule 2) is written once.
//
// ⚠️ `null` IS "NOT COMPUTED YET", NEVER A CONFLICT. GitHub computes `mergeable` lazily —
// asynchronously after the base moves — so a read may answer null; the job retries, and a
// reading still null is simply not persisted.

/** A pull request the base-branch push must re-read. */
export interface BaseMember {
  pullRequestId: string;
  number: number;
}

export interface BaseMovedInput {
  workspaceId: string;
  /** The `github_repo` ROW id. */
  repoId: string;
  /** The branch that moved — the repository's default branch. */
  baseRef: string;
  baseHeadSha: string | null;
}

export interface SettleSummary {
  /** Members whose host answer is still `null` — retried by the job, else left. */
  unknown: BaseMember[];
  /** Members stored `dirty` at their head by this pass. */
  conflicted: number;
  /** Awaiting `pull_request_approval` gates superseded with `conflict`. */
  withdrawn: number;
  /** Cards moved `in_review → implemented`. */
  held: number;
  /** Members whose read threw — not persisted, due again on the reconcile tick. */
  failed: number;
}

/** Whether a host answer says the head cannot combine with its base. */
export function isConflictReading(reading: ChangeRequestMergeability): boolean {
  return reading.mergeable === false || reading.mergeableState === CONFLICTED_MERGEABLE_STATE;
}

/** Whether a host answer says anything at all — `mergeable: null` is "ask again". */
export function isComputedReading(reading: ChangeRequestMergeability): boolean {
  return reading.mergeable !== null;
}

/** A card this service moved, for the post-commit `work-item/transitioned` event. */
type AppliedMove = {
  workItemId: string;
  fromStatusKey: string;
  toStatusKey: string;
  revisionId: string;
};

export const pullRequestMergeabilityService = {
  /**
   * Ask the HOST whether one pull request can merge into its base now. `null` when the
   * provider has no merge path (GitLab) — there is then nothing to be un-mergeable into.
   * Outside any transaction: a network call never holds a database transaction open.
   */
  async readFromHost(pullRequestId: string): Promise<ChangeRequestMergeability | null> {
    const pr = await withSystemContext((tx) =>
      githubPullRequestRepository.findByIdWithInstallation(pullRequestId, tx),
    );
    if (!pr) return null;
    const provider = getGitProvider(pr.repo.provider as GitProviderId);
    if (!provider.readChangeRequestMergeability) return null;
    return provider.readChangeRequestMergeability({
      installationId: pr.repo.installation.installationId,
      owner: pr.repo.owner,
      name: pr.repo.name,
      number: pr.number,
    });
  },

  /**
   * Store a COMPUTED reading and, when it is a conflict, withdraw the question — both in
   * one transaction (the reading first, so the withdrawal's re-ask already refuses the
   * member). A `null` reading writes nothing. Returns what it did.
   */
  async settleReading(
    workspaceId: string,
    pullRequestId: string,
    reading: ChangeRequestMergeability,
  ): Promise<{
    conflicted: boolean;
    withdrawn: number;
    moved: AppliedMove[];
    actor: ServiceContext | null;
  }> {
    if (!isComputedReading(reading)) {
      return { conflicted: false, withdrawn: 0, moved: [], actor: null };
    }
    const conflicted = isConflictReading(reading);
    const actor = await ownerContext(workspaceId);
    const outcome = await withSystemContext(async (tx) => {
      await bindWorkspaceContext(tx, workspaceId);
      await githubPullRequestRepository.setMergeability(
        pullRequestId,
        {
          // `mergeable: false` with no state word is still a conflict; store the word the
          // readers key on so the three readers agree with this one.
          mergeableState: conflicted
            ? CONFLICTED_MERGEABLE_STATE
            : (reading.mergeableState ?? 'clean'),
          headSha: reading.headSha,
        },
        tx,
      );
      if (!conflicted) return { withdrawn: 0, moved: [] as AppliedMove[] };
      return this.withdrawForConflict(pullRequestId, actor, tx);
    });
    await emitMoves(outcome.moved, actor);
    return { conflicted, ...outcome, actor };
  },

  /**
   * WITHDRAW THE QUESTION over every card this pull request delivers, and HOLD each card
   * that was waiting on a person at Implemented (§ 30 rules 1–2; § 28's CAN'T-LAND class).
   * In the caller's transaction; the caller has persisted the `dirty` reading first.
   *
   * ⚠️ ONLY A CARD AT `in_review` MOVES. That is where a person is being asked; a card
   * anywhere else (Implemented already, Approved mid-merge, a terminal status) is left
   * exactly where it is — the gate is still withdrawn, which is the part that matters for
   * To approve. `actor` null (a workspace with no owner) withdraws and moves nothing.
   */
  async withdrawForConflict(
    pullRequestId: string,
    actor: ServiceContext | null,
    tx: Prisma.TransactionClient,
  ): Promise<{ withdrawn: number; moved: AppliedMove[] }> {
    const refs = await resolveDeliveredWorkItems(pullRequestId, tx);
    // LOCK ORDER — each card's awaiting gates, then the card (ADR §6d amendment, rule 8),
    // the order `applyStatusTransition` takes them in.
    for (const ref of refs) await queueExitCardMoves.lockCard(ref.id, tx);
    const withdrawn = await withdrawPullRequestApprovalGatesOnConflict(pullRequestId, tx);
    const moved: AppliedMove[] = [];
    if (!actor) return { withdrawn, moved };
    for (const ref of refs) {
      const item = await workItemRepository.findById(ref.id, tx);
      if (!item || item.status !== 'in_review') continue;
      const settled = await settleUnlandedOutcome(item, 'cant_land', actor, tx);
      if (settled.transition) moved.push({ ...settled.transition, workItemId: item.id });
    }
    return { withdrawn, moved };
  },

  /** The members a push to `baseRef` must re-read. */
  async listBaseMembers(input: BaseMovedInput): Promise<BaseMember[]> {
    const rows = await withSystemContext((tx) =>
      githubPullRequestRepository.listOpenDeliveringByRepoAndBase(input.repoId, input.baseRef, tx),
    );
    return rows.map((row) => ({ pullRequestId: row.id, number: row.number }));
  },

  /**
   * ONE PASS of the base-branch re-evaluation: read each member from the host, store and
   * act on every computed answer, and hand back the members whose answer is still `null`
   * so the job can wait and ask again. A read that throws is counted and left for the
   * reconcile tick — one member's host failure never stops the others.
   */
  async settleBaseMembers(workspaceId: string, members: BaseMember[]): Promise<SettleSummary> {
    const summary: SettleSummary = { unknown: [], conflicted: 0, withdrawn: 0, held: 0, failed: 0 };
    for (const member of members) {
      let reading: ChangeRequestMergeability | null;
      try {
        reading = await this.readFromHost(member.pullRequestId);
      } catch (err) {
        summary.failed += 1;
        console.warn('[pullRequestMergeability] could not read a member from the host', {
          pullRequestId: member.pullRequestId,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (!reading) continue;
      if (!isComputedReading(reading)) {
        summary.unknown.push(member);
        continue;
      }
      const settled = await this.settleReading(workspaceId, member.pullRequestId, reading);
      if (settled.conflicted) summary.conflicted += 1;
      summary.withdrawn += settled.withdrawn;
      summary.held += settled.moved.length;
    }
    return summary;
  },
};

/** The workspace owner — the actor a system status write runs as, the same fallback the
 *  status sync and the queue-exit path use. */
async function ownerContext(workspaceId: string): Promise<ServiceContext | null> {
  const owner = await withSystemContext(async (tx) => {
    await bindWorkspaceContext(tx, workspaceId);
    return workspaceMembershipRepository.findOwnerByWorkspace(workspaceId, tx);
  });
  return owner ? { userId: owner.userId, workspaceId } : null;
}

/** Post-commit, never inside the transaction — a rollback must not have notified. */
async function emitMoves(moved: AppliedMove[], actor: ServiceContext | null): Promise<void> {
  if (!actor) return;
  for (const move of moved) {
    await queueExitCardMoves.emitMoved(move.workItemId, move, actor);
  }
}
