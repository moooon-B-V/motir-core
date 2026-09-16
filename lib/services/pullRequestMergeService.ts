import { withWorkspaceContext } from '@/lib/workspaces/context';
import { getGitProvider } from '@/lib/git';
import { providerSupportsMerge } from '@/lib/git/provider';
import { MergeChangeRequestError } from '@/lib/git/errors';
import type { GitProviderId, MergeChangeRequestResult, MergeRefusalCode } from '@/lib/git/types';
// ⚠️ The MEMBER SPELLING, not a merge gate: `owner/name#number@headSha` is how the
// surviving approval gate names each of its members, so the pull request's version now
// and the version the card was approved at are comparable (MOTIR-5613). It lives beside
// the set version since MOTIR-5616 retired the handler it was written in.
import { pullRequestSubjectVersion } from '@/lib/approvalGates/deliverySetVersion';
import {
  ApprovalGateAlreadyDecidedError,
  ApprovalGateError,
  ApprovalGateMergeRefusedError,
  ApprovalGateNotAuthorisedError,
  ApprovalGateNotFoundError,
  ApprovalGateSupersededError,
  type MergeRefusalTag,
} from '@/lib/approvalGates/errors';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { githubPullRequestRepository } from '@/lib/repositories/githubPullRequestRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { toGateRefusal, type GateRefusal } from '@/lib/approvalGates/refusals';
import { membersOf, type MemberVersion } from '@/lib/approvalGates/memberVersion';
import type {
  ApproveAndMergeMemberOutcomeDTO,
  PullRequestApprovalMemberDTO,
} from '@/lib/dto/approvalGate';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { projectAccessService } from './projectAccessService';
import { pullRequestApprovalMembersService } from './pullRequestApprovalMembersService';
import {
  approvalGatesService,
  resolveGateAuthority,
  type DecideGateInput,
  type DecideGateResult,
} from './approvalGatesService';

// THE MERGE ENTRY POINT (Story MOTIR-4882 · MOTIR-5517 · MOTIR-5613; `approval-gates.md`
// §8's SECOND AMENDMENT, decisions 4 and 6) — the one path by which an approved card's
// pull requests are MERGED, or enqueued.
//
// ⚠️ IT IS KEYED ON (THE CARD'S OWN GATE, ONE PULL REQUEST) — never on a gate of its own.
// Until MOTIR-5611 each pull request carried a `pull_request_merge` gate and a merge was
// addressed by that gate's id. There is now ONE gate per card, so a merge is addressed by
// the card's approved `pull_request_approval` gate plus the pull request being merged, and
// nothing here needs a merge-gate row to exist.
//
// ⚠️ THE ORDER IS THE WHOLE DESIGN: CHECK, MERGE, THEN RECORD.
//
//   1. the member is CHECKED — the card's gate is approved and decidable by this actor,
//      and the pull request is still delivered by the card, still open and still at the
//      head the gate was approved at. A member that no longer answers that description is
//      `stale`: the question was withdrawn, and no host is called;
//   2. the seam is called OUTSIDE ANY TRANSACTION;
//   3. the outcome is recorded on the PULL REQUEST (`merge_authority` / `merge_outcome_ref`),
//      which is where it belonged all along — a fact about a pull request, not about a gate.
//
// ⚠️ NOTHING IS DECIDED HERE ANY MORE. The card's one gate was decided when the person
// pressed *Approve and merge*; a merge that follows carries that decision out, and a
// refusal leaves the approval standing with its reason on screen. That is why a retry can
// address a single member without asking anyone to approve anything twice.

/** The one gate a merge now carries out — the card's own (MOTIR-5611). */
const APPROVAL_KIND = 'pull_request_approval' as const;

/**
 * That gate's PERMISSION FLOOR, `pullRequestApprovalGateHandler.permission`.
 *
 * ⚠️ COPIED, NOT IMPORTED, AND THAT IS DELIBERATE. `pullRequestApprovalHandler` imports
 * `workItemsService` for its status write, so importing it here evaluates that handler
 * BEFORE `approvalGatesService` pulls in the registry — and the registry then records
 * `undefined` for the kind still mid-evaluation, which fails every status transition in
 * the process. It is the module cycle `deliverySetVersion.ts` exists to avoid, reached
 * from the other side. `tests/github/pullRequestMergeEntry.test.ts` pins this constant to
 * the handler's own value, so the copy cannot drift.
 */
export const APPROVAL_MERGE_PERMISSION = 'work_item:edit' as const;

/** The seam's refusal, one to one onto the gate refusal a person is shown (MOTIR-5512).
 *  `subject_changed` is absent on purpose: it makes a member stale, it does not refuse. */
const REFUSAL_TAG: Record<Exclude<MergeRefusalCode, 'subject_changed'>, MergeRefusalTag> = {
  checks_not_green: 'MERGE_CHECKS_NOT_GREEN',
  conflict: 'MERGE_CONFLICT',
  branch_protected: 'MERGE_BRANCH_PROTECTED',
  already_merged: 'MERGE_ALREADY_MERGED',
  app_permission_missing: 'MERGE_APP_PERMISSION_MISSING',
};

interface MergeTarget {
  pullRequestId: string;
  workItemId: string;
  provider: GitProviderId;
  installationId: string;
  owner: string;
  name: string;
  number: number;
  expectedHeadSha: string;
}

/**
 * STEP 1 — everything decided before a host is called, asked about ONE member of the card's
 * approved gate. Refusals the door itself would give are thrown here with the door's own
 * errors, so a press that cannot be honoured never reaches GitHub. A member whose pull
 * request has moved, closed or left the card answers `stale`, and NOTHING is written: the
 * card's gate is already decided and there is no per-member question left to withdraw.
 */
async function checkMember(
  args: { approvalGateId: string; member: MemberVersion },
  ctx: ServiceContext,
): Promise<{ kind: 'mergeable'; target: MergeTarget } | { kind: 'stale' }> {
  const { approvalGateId, member } = args;
  return withWorkspaceContext(ctx, async (tx) => {
    const gate = await approvalGateRepository.findById(approvalGateId, tx);
    if (!gate || gate.kind !== APPROVAL_KIND) throw new ApprovalGateNotFoundError(approvalGateId);
    const item = await workItemRepository.findById(gate.workItemId, tx);
    if (!item || item.workspaceId !== ctx.workspaceId) {
      throw new ApprovalGateNotFoundError(approvalGateId);
    }

    // The door's two actor checks, in the door's order: the kind's floor, then §2's
    // relationship. A merge carries out a decision, so the actor who may carry it out is
    // the actor who could have made it.
    await projectAccessService.assertPermission(item.projectId, ctx, APPROVAL_MERGE_PERMISSION, tx);
    if (!(await resolveGateAuthority(item, ctx, tx))) {
      throw new ApprovalGateNotAuthorisedError(approvalGateId);
    }

    if (gate.state === 'superseded') throw new ApprovalGateSupersededError(approvalGateId);
    // A merge only ever follows an APPROVAL: changes requested on the set merges none of it.
    if (gate.state === 'changes_requested') {
      throw new ApprovalGateAlreadyDecidedError(
        approvalGateId,
        gate.state,
        gate.decidedById,
        gate.decidedAt,
        gate.decidedByLabel,
      );
    }
    // `awaiting` means nobody has decided anything yet, so there is no decision to carry
    // out. Both callers commit or verify the approval before they reach here, so this is a
    // programming error rather than a refusal a person should be shown.
    if (gate.state !== 'approved') {
      throw new Error(`a merge was attempted under an ${gate.state} gate (${approvalGateId})`);
    }

    // The member must still be one of THIS card's deliveries — a pull request unlinked
    // after the approval is no longer covered by it.
    const deliveries = await workItemDeliveryRepository.listByWorkItemWithChecks(
      gate.workItemId,
      tx,
    );
    const delivery = deliveries.find(
      (row) =>
        `${row.repo.owner}/${row.repo.name}` === member.repo &&
        row.pullRequest.number === member.number,
    );
    if (!delivery) return { kind: 'stale' };

    const pr = await githubPullRequestRepository.findByIdWithInstallation(
      delivery.pullRequest.id,
      tx,
    );
    // …and it must still be the SAME COMMITS the card was approved at.
    const current = pr ? pullRequestSubjectVersion(pr) : null;
    if (!pr || pr.state !== 'open' || pr.merged || current !== member.subjectVersion) {
      return { kind: 'stale' };
    }

    return {
      kind: 'mergeable',
      target: {
        pullRequestId: pr.id,
        workItemId: gate.workItemId,
        provider: pr.repo.provider as GitProviderId,
        installationId: pr.repo.installation.installationId,
        owner: pr.repo.owner,
        name: pr.repo.name,
        number: pr.number,
        // The head the card was approved on.
        expectedHeadSha: member.headSha,
      },
    };
  });
}

/** One member of an approve-and-merge press, and what happened to it (MOTIR-5483) — the
 *  DTO the Development frame reads it as (MOTIR-5484). */
export type ApproveAndMergeMemberOutcome = ApproveAndMergeMemberOutcomeDTO;

/** The press's answer: the approval, which stands in every case, and every member's outcome. */
export interface ApproveAndMergeResult {
  approval: DecideGateResult;
  members: ApproveAndMergeMemberOutcome[];
}

/**
 * MERGE OR ENQUEUE ONE checked member — steps 2 and 3, with no transaction open across the
 * host call and nothing decided afterwards.
 *
 * Throws `ApprovalGateMergeRefusedError` for a host refusal (nothing is written),
 * `ApprovalGateSupersededError` when the host reports the head moved under us, and
 * `MergeChangeRequestError` when the host did not answer at all.
 */
async function mergeOrEnqueue(
  approvalGateId: string,
  target: MergeTarget,
  ctx: ServiceContext,
): Promise<'merged' | 'enqueued'> {
  const provider = getGitProvider(target.provider);
  // A card only reaches an approve-to-merge gate when every member is a merge candidate
  // (`raisePullRequestApprovalGate`), so a provider without the capability here is a
  // programming error, not a refusal.
  if (!providerSupportsMerge(provider)) {
    throw new Error(
      `a ${target.provider} pull request is a member of an approved gate (${approvalGateId})`,
    );
  }
  let result: MergeChangeRequestResult;
  try {
    result = await provider.mergeChangeRequest({
      installationId: target.installationId,
      owner: target.owner,
      name: target.name,
      number: target.number,
      expectedHeadSha: target.expectedHeadSha,
    });
  } catch (err) {
    if (err instanceof MergeChangeRequestError) {
      console.error(
        '[pullRequestMergeService] the host did not answer the merge; nothing recorded',
        {
          approvalGateId,
          pullRequestId: target.pullRequestId,
          reason: err.reason,
        },
      );
    }
    throw err;
  }

  if (result.outcome === 'refused') {
    // A head that moved between the check and the merge (the host's 409) is the same
    // withdrawn question step 1 would have found.
    if (result.refusal.code === 'subject_changed') {
      throw new ApprovalGateSupersededError(approvalGateId);
    }
    throw new ApprovalGateMergeRefusedError(approvalGateId, REFUSAL_TAG[result.refusal.code], {
      permission: result.refusal.permission ?? null,
      reason: result.refusal.reason ?? null,
    });
  }

  // STEP 3 — the outcome, on the PULL REQUEST. No gate is decided by a merge any more.
  await withWorkspaceContext(ctx, (tx) =>
    githubPullRequestRepository.recordMotirMerge(
      target.pullRequestId,
      {
        mergeAuthority: 'gate',
        mergeOutcomeRef: result.outcome === 'merged' ? result.commitSha : `queue:${result.entryId}`,
      },
      tx,
    ),
  );
  return result.outcome;
}

/**
 * A decision as a surface records it: what the door decided, plus every member the decision
 * MERGED (MOTIR-5624). `members` is empty for every decision that merges nothing — any
 * `request_changes`, and an `approve` on a kind that is not the approve-to-merge gate.
 */
export interface DecideGateWithMergeResult extends DecideGateResult {
  members: ApproveAndMergeMemberOutcome[];
}

export const pullRequestMergeService = {
  /**
   * EVERY decision a surface records enters here — the decide route and the item page's
   * decide action both call it rather than the door (MOTIR-5517).
   *
   * ⚠️ AN APPROVE ON THE APPROVE-TO-MERGE GATE IS {@link approveAndMerge}, WHATEVER DOOR IT
   * CAME THROUGH (MOTIR-5624; `approval-gates.md` §8's THIRD AMENDMENT). MOTIR-5613 made this
   * a straight pass-through because no kind merges BEFORE it is decided — true about ORDER,
   * and it left the REST route approving the card's one gate while merging nothing, with no
   * gate left for anyone to press. `approveAndMerge` decides FIRST and merges after, so the
   * order 5613 protected still holds; what this restores is that every door to the same gate
   * means the same thing. Every other decision reaches the door unchanged.
   */
  async decideGate(
    input: DecideGateInput,
    ctx: ServiceContext,
  ): Promise<DecideGateWithMergeResult> {
    if (input.decision === 'approve') {
      // Routing only: the door re-reads everything the decision turns on under its own lock.
      const gate = await withWorkspaceContext(ctx, (tx) =>
        approvalGateRepository.findById(input.gateId, tx),
      );
      if (gate?.kind === APPROVAL_KIND) {
        const { approval, members } = await approveAndMergeGate(input, ctx);
        return { ...approval, members };
      }
    }
    return { ...(await approvalGatesService.decide(input, ctx)), members: [] };
  },

  /**
   * The approve-and-merge set as the Development frame draws it on a READ (Story MOTIR-4909 ·
   * MOTIR-5484 · MOTIR-5613): each member of one APPROVED `pull_request_approval` gate, with
   * the facts a reload still has once the press's response is gone —
   *
   *   · the PULL REQUEST the member names, while the card still delivers it;
   *   · whether the press QUEUED it — the pull request carries a `queue:` outcome and has not
   *     merged — so the row reads *Queued to merge* for as long as that is true;
   *   · whether a RETRY is offered, which is now a fact about the pull request rather than
   *     about a second gate: the approval stands, and this member has no merge outcome yet.
   *
   * ⚠️ NO REFUSAL REASON: the press does not persist one. Empty for a gate that is not an
   * approved approval gate on this card.
   */
  async listApprovalMembers(
    input: { workItemId: string; approvalGateId: string },
    ctx: ServiceContext,
  ): Promise<PullRequestApprovalMemberDTO[]> {
    return pullRequestApprovalMembersService.listForGate(input, ctx);
  },

  /**
   * APPROVE AND MERGE — the one press behind the approve-and-merge gate (Story MOTIR-4909 ·
   * MOTIR-5483 · MOTIR-5613; `approval-gates.md` §8's SECOND AMENDMENT, decisions 1 and 4).
   *
   * ⚠️ THE ORDER IS THE WHOLE DESIGN:
   *
   *   1. the card's ONE gate is decided first, through the ONE decide door, and the card moves
   *      `in_review → approved`. A refusal the door raises (not authorised, already decided,
   *      superseded) ends the press here, and nothing is merged or queued;
   *   2. AFTER that commit, each member of the approved set — in `subjectVersion`'s canonical
   *      order — is merged or enqueued by the entry point above, and its outcome recorded on
   *      its own pull request. This method never names a host.
   *
   * EVERY member is attempted: a refusal on one does not stop the next, because the approval
   * covers all of them. The approval stands whatever the merges do, and the result reports each
   * member — `merged`, `enqueued`, `refused` with its typed refusal, or `no_merge_gate` when the
   * member is no longer a pull request this card delivers at that head.
   */
  async approveAndMerge(
    input: Omit<DecideGateInput, 'decision'>,
    ctx: ServiceContext,
  ): Promise<ApproveAndMergeResult> {
    const gate = await withWorkspaceContext(ctx, (tx) =>
      approvalGateRepository.findById(input.gateId, tx),
    );
    if (gate && gate.kind !== APPROVAL_KIND) {
      throw new Error(`approveAndMerge was handed a ${gate.kind} gate (${input.gateId})`);
    }
    return approveAndMergeGate(input, ctx);
  },

  /**
   * RETRY one refused member of an approve-and-merge press — step 2 of {@link approveAndMerge}
   * for that ONE pull request alone (MOTIR-5613).
   *
   * ⚠️ ADDRESSED BY (THE CARD'S GATE, THE PULL REQUEST), and it decides NOTHING: the card's
   * gate was decided when it was approved, and a retry carries that same decision out again
   * for the one member the host refused. The approval must still stand, and the pull request
   * must still be a member of it at the head it was approved at — otherwise this is a
   * withdrawn question, refused with the door's own error rather than re-asked.
   */
  async retryApproveAndMergeMember(
    input: Omit<DecideGateInput, 'decision' | 'gateId'> & {
      approvalGateId: string;
      pullRequestId: string;
    },
    ctx: ServiceContext,
  ): Promise<ApproveAndMergeMemberOutcome> {
    const found = await withWorkspaceContext(ctx, async (tx) => {
      const approval = await approvalGateRepository.findById(input.approvalGateId, tx);
      if (!approval || approval.kind !== APPROVAL_KIND) {
        throw new ApprovalGateNotFoundError(input.approvalGateId);
      }
      // Each non-approved state gets the refusal that is TRUE of it: a withdrawn question
      // is superseded, changes requested is a decision that merges nothing, and an
      // awaiting gate has no press to retry a member of.
      if (approval.state === 'superseded') {
        throw new ApprovalGateSupersededError(input.approvalGateId);
      }
      if (approval.state === 'changes_requested') {
        throw new ApprovalGateAlreadyDecidedError(
          input.approvalGateId,
          approval.state,
          approval.decidedById,
          approval.decidedAt,
          approval.decidedByLabel,
        );
      }
      if (approval.state !== 'approved' || !approval.decidedAt) {
        throw new ApprovalGateNotFoundError(input.approvalGateId);
      }
      const delivered = (
        await workItemDeliveryRepository.listByWorkItemWithChecks(approval.workItemId, tx)
      ).find((row) => row.pullRequest.id === input.pullRequestId);
      if (!delivered) return null;
      // The member is matched by `owner/name#number`, so a pull request whose head has moved
      // since the approval is found here and goes stale in the check — not silently skipped.
      return (
        membersOf(approval.subjectVersion).find(
          (member) =>
            member.repo === `${delivered.repo.owner}/${delivered.repo.name}` &&
            member.number === delivered.pullRequest.number,
        ) ?? null
      );
    });
    // Not delivered by this card, or never a member of what was approved: there is no
    // question to carry out, and the card's gate is not re-asked.
    if (!found) throw new ApprovalGateSupersededError(input.approvalGateId);
    return mergeMember(input.approvalGateId, found, ctx);
  },
};

/**
 * The press's two steps, once the gate is known to be the approve-to-merge kind — shared by
 * {@link pullRequestMergeService.approveAndMerge} and the route's `decideGate` so the two
 * doors cannot drift apart again.
 */
async function approveAndMergeGate(
  input: Omit<DecideGateInput, 'decision'>,
  ctx: ServiceContext,
): Promise<ApproveAndMergeResult> {
  // STEP 1 — the approval, committed in the door's own transaction.
  const approval = await approvalGatesService.decide({ ...input, decision: 'approve' }, ctx);

  // STEP 2 — each member, after that commit, addressed by (this gate, its pull request).
  const members: ApproveAndMergeMemberOutcome[] = [];
  for (const member of membersOf(approval.gate.subjectVersion)) {
    members.push(await mergeMember(input.gateId, member, ctx));
  }
  return { approval, members };
}

/**
 * Merge or enqueue ONE member of an approved card through the entry point above, and turn a
 * refusal into a result rather than a throw — so the next member is still tried. An error
 * that is not a refusal of this member is rethrown.
 */
async function mergeMember(
  approvalGateId: string,
  member: MemberVersion,
  ctx: ServiceContext,
): Promise<ApproveAndMergeMemberOutcome> {
  let target: MergeTarget;
  try {
    const checked = await checkMember({ approvalGateId, member }, ctx);
    // ⚠️ `no_merge_gate` NO LONGER NAMES A GATE (MOTIR-5613). It is the member this card no
    // longer delivers at the head it was approved at — nothing to merge, and nothing
    // refused. The literal is kept so the frame's copy stays MOTIR-5615's to rename.
    if (checked.kind === 'stale') {
      return {
        subjectVersion: member.subjectVersion,
        pullRequestId: null,
        outcome: 'no_merge_gate',
      };
    }
    target = checked.target;
  } catch (err) {
    const refusal = memberRefusal(err);
    if (!refusal) throw err;
    return {
      subjectVersion: member.subjectVersion,
      pullRequestId: null,
      outcome: 'refused',
      refusal,
    };
  }

  try {
    const outcome = await mergeOrEnqueue(approvalGateId, target, ctx);
    return { subjectVersion: member.subjectVersion, pullRequestId: target.pullRequestId, outcome };
  } catch (err) {
    const refusal = memberRefusal(err);
    if (!refusal) throw err;
    return {
      subjectVersion: member.subjectVersion,
      pullRequestId: target.pullRequestId,
      outcome: 'refused',
      refusal,
    };
  }
}

/** A member's refusal in the frame's own vocabulary — the mapping the decide action uses. */
function memberRefusal(err: unknown): GateRefusal | null {
  if (err instanceof ApprovalGateMergeRefusedError) {
    return toGateRefusal(err.tag, { permission: err.permission, reason: err.reason });
  }
  if (err instanceof ApprovalGateAlreadyDecidedError) {
    return toGateRefusal(err.tag, { decidedByLabel: err.decidedByLabel });
  }
  if (err instanceof ApprovalGateError) return toGateRefusal(err.tag);
  if (err instanceof PermissionDeniedError) return toGateRefusal('APPROVAL_GATE_NOT_AUTHORISED');
  if (err instanceof ProjectNotFoundError) return toGateRefusal('APPROVAL_GATE_NOT_FOUND');
  // The host did not answer: nothing was decided, and there is no host refusal to draw.
  if (err instanceof MergeChangeRequestError) return toGateRefusal('UNEXPECTED');
  return null;
}
