import { withWorkspaceContext } from '@/lib/workspaces/context';
import { getGitProvider } from '@/lib/git';
import { providerSupportsMerge } from '@/lib/git/provider';
import { MergeChangeRequestError } from '@/lib/git/errors';
import type { GitProviderId, MergeChangeRequestResult, MergeRefusalCode } from '@/lib/git/types';
import {
  pullRequestMergeGateHandler,
  pullRequestSubjectVersion,
} from '@/lib/approvalGates/pullRequestMergeHandler';
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
import { membersOf } from '@/lib/approvalGates/memberVersion';
import type {
  ApproveAndMergeMemberOutcomeDTO,
  PullRequestApprovalMemberDTO,
} from '@/lib/dto/approvalGate';
import { PermissionDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { projectAccessService } from './projectAccessService';
import {
  approvalGatesService,
  resolveGateAuthority,
  type DecideGateInput,
  type DecideGateOptions,
  type DecideGateResult,
} from './approvalGatesService';

// THE MERGE ENTRY POINT (Story MOTIR-4882 · MOTIR-5517; `approval-gates.md` §4's second
// amendment, decision 4) — the one path by which approving a `pull_request_merge` gate
// MERGES, or enqueues, its pull request.
//
// ⚠️ THE ORDER IS THE WHOLE DESIGN: CHECK, MERGE, THEN DECIDE. `approvalGatesService.decide`
// is one transaction with no post-commit hook, and a decided gate is immutable. Deciding
// first and merging second would leave a permanent approval over a merge the host
// refused; merging inside the decision would hold a row lock across a network call. So
//
//   1. the gate is CHECKED — decidable by this actor, still awaiting, and still asking
//      about the pull request as it stands (open, delivered, same head). A changed
//      subject SUPERSEDES the gate and calls no host: it is a withdrawn question, not a
//      refused merge;
//   2. the seam is called OUTSIDE ANY TRANSACTION;
//   3. only on `merged` or `enqueued` is the gate decided — through the ONE decide door
//      — and the outcome then recorded on the PULL REQUEST, never on the gate (the item
//      page reads a gate's outcome as a status key).
//
// A refusal decides nothing, and the gate stays awaiting with its reason on screen.
//
// ⚠️ THE WINDOW THIS CANNOT CLOSE, NAMED: a crash between a successful merge and step 3
// leaves the gate awaiting over a merged pull request. The merge webhook closes the pull
// request, which withdraws the gate (`mergeGates.withdrawMergeGatesOnClose`), and the card
// still reaches `done` through that webhook.

const KIND = 'pull_request_merge' as const;

/** The seam's refusal, one to one onto the gate refusal a person is shown (MOTIR-5512).
 *  `subject_changed` is absent on purpose: it supersedes, it does not refuse. */
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

/** Withdraw ONE card's merge question about ONE pull request. */
function supersedeGate(
  gate: { workItemId: string; subjectId: string },
  ctx: ServiceContext,
): Promise<number> {
  return withWorkspaceContext(ctx, (tx) =>
    approvalGateRepository.supersedeAwaitingBySubject(
      { kind: KIND, subjectId: gate.subjectId, workItemId: gate.workItemId },
      tx,
    ),
  );
}

/**
 * STEP 1 — everything decided before a host is called. Refusals the door itself would
 * give are thrown here with the door's own errors, so a press that cannot be honoured
 * never reaches GitHub. A subject that changed answers `stale`, after the gate is
 * superseded in the same transaction.
 */
async function checkMergeGate(
  gateId: string,
  ctx: ServiceContext,
): Promise<{ kind: 'mergeable'; target: MergeTarget } | { kind: 'stale' }> {
  return withWorkspaceContext(ctx, async (tx) => {
    const gate = await approvalGateRepository.findById(gateId, tx);
    if (!gate) throw new ApprovalGateNotFoundError(gateId);
    if (gate.kind !== KIND) {
      throw new Error(`approveMergeGate was handed a ${gate.kind} gate (${gateId})`);
    }
    const item = await workItemRepository.findById(gate.workItemId, tx);
    if (!item || item.workspaceId !== ctx.workspaceId) throw new ApprovalGateNotFoundError(gateId);

    // The door's two actor checks, in the door's order: the kind's floor, then §2's
    // relationship. `decide` asks both again under its lock; asking here is what keeps
    // an unauthorised press from merging anything first.
    await projectAccessService.assertPermission(
      item.projectId,
      ctx,
      pullRequestMergeGateHandler.permission,
      tx,
    );
    if (!(await resolveGateAuthority(item, ctx, tx))) {
      throw new ApprovalGateNotAuthorisedError(gateId);
    }
    if (gate.state === 'superseded') throw new ApprovalGateSupersededError(gateId);
    if (gate.state !== 'awaiting') {
      throw new ApprovalGateAlreadyDecidedError(
        gateId,
        gate.state,
        gate.decidedById,
        gate.decidedAt,
        gate.decidedByLabel,
      );
    }

    const pr = await githubPullRequestRepository.findByIdWithInstallation(gate.subjectId, tx);
    const delivered =
      pr !== null &&
      (await workItemDeliveryRepository.listByPullRequest(pr.id, tx)).some(
        (row) => row.workItemId === gate.workItemId,
      );
    const current = pr ? pullRequestSubjectVersion(pr) : null;
    if (
      !pr ||
      pr.state !== 'open' ||
      pr.merged ||
      !delivered ||
      !gate.subjectVersion ||
      current !== gate.subjectVersion
    ) {
      await approvalGateRepository.supersedeAwaitingBySubject(
        { kind: KIND, subjectId: gate.subjectId, workItemId: gate.workItemId },
        tx,
      );
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
        // The head the gate was raised on — `owner/name#number@<sha>`.
        expectedHeadSha: gate.subjectVersion.slice(gate.subjectVersion.lastIndexOf('@') + 1),
      },
    };
  });
}

const APPROVAL_KIND = 'pull_request_approval' as const;

/** What {@link pullRequestMergeService.approveMergeGate} returns: the decision, and whether the
 *  host merged the pull request or added it to its merge queue. */
export type ApproveMergeGateResult = DecideGateResult & { mergeOutcome: 'merged' | 'enqueued' };

/** One member of an approve-and-merge press, and what happened to it (MOTIR-5483) — the
 *  DTO the Development frame reads it as (MOTIR-5484). */
export type ApproveAndMergeMemberOutcome = ApproveAndMergeMemberOutcomeDTO;

/** The press's answer: the approval, which stands in every case, and every member's outcome. */
export interface ApproveAndMergeResult {
  approval: DecideGateResult;
  members: ApproveAndMergeMemberOutcome[];
}

export const pullRequestMergeService = {
  /**
   * EVERY decision a surface records enters here. An APPROVE on a merge gate merges
   * first ({@link approveMergeGate}); everything else — `request_changes` on any kind,
   * and every other kind — goes straight to the one decide door, unchanged.
   */
  async decideGate(input: DecideGateInput, ctx: ServiceContext): Promise<DecideGateResult> {
    if (input.decision === 'approve') {
      const gate = await withWorkspaceContext(ctx, (tx) =>
        approvalGateRepository.findById(input.gateId, tx),
      );
      if (gate?.kind === KIND) return pullRequestMergeService.approveMergeGate(input, ctx);
    }
    return approvalGatesService.decide(input, ctx);
  },

  /**
   * APPROVE a merge gate: check it, merge or enqueue its pull request, then decide it.
   *
   * Throws the door's own refusals (not found, not authorised, already decided,
   * superseded), `ApprovalGateMergeRefusedError` for a host refusal — the gate stays
   * awaiting and nothing is written — and `MergeChangeRequestError` when the host did
   * not answer, which is logged with the gate id and decides nothing.
   */
  async approveMergeGate(
    input: Omit<DecideGateInput, 'decision'>,
    ctx: ServiceContext,
    /** Internal — the approve-and-merge press's instant (MOTIR-5483). */
    options: DecideGateOptions = {},
  ): Promise<ApproveMergeGateResult> {
    const checked = await checkMergeGate(input.gateId, ctx);
    if (checked.kind === 'stale') throw new ApprovalGateSupersededError(input.gateId);
    const { target } = checked;

    // STEP 2 — the seam, with no transaction open.
    const provider = getGitProvider(target.provider);
    // A gate is only ever raised for a provider that can merge (`raiseMergeGates`), so a
    // provider without the capability here is a programming error, not a refusal.
    if (!providerSupportsMerge(provider)) {
      throw new Error(`a ${target.provider} pull request carries a merge gate (${input.gateId})`);
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
          '[pullRequestMergeService] the host did not answer the merge; nothing decided',
          {
            gateId: input.gateId,
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
        await supersedeGate(
          { workItemId: target.workItemId, subjectId: target.pullRequestId },
          ctx,
        );
        throw new ApprovalGateSupersededError(input.gateId);
      }
      throw new ApprovalGateMergeRefusedError(input.gateId, REFUSAL_TAG[result.refusal.code], {
        permission: result.refusal.permission ?? null,
        reason: result.refusal.reason ?? null,
      });
    }

    // STEP 3 — decide through the ONE door, which re-checks everything under its lock.
    const decided = await approvalGatesService.decide(
      { ...input, decision: 'approve' },
      ctx,
      options,
    );
    const mergeOutcomeRef =
      result.outcome === 'merged' ? result.commitSha : `queue:${result.entryId}`;
    await withWorkspaceContext(ctx, (tx) =>
      githubPullRequestRepository.recordMotirMerge(
        target.pullRequestId,
        { mergeAuthority: 'gate', mergeOutcomeRef },
        tx,
      ),
    );
    return { ...decided, mergeOutcome: result.outcome };
  },

  /**
   * The approve-and-merge set as the Development frame draws it on a READ (Story MOTIR-4909 ·
   * MOTIR-5484): each member of one APPROVED `pull_request_approval` gate, with the two facts
   * a reload still has once the press's response is gone —
   *
   *   · whether the member's merge gate still AWAITS, so *Retry merge* has a gate to press;
   *   · whether the press QUEUED it — its merge gate was decided and the pull request carries a
   *     `queue:` outcome and has not merged — so the row reads *Queued to merge* for as long as
   *     that is true.
   *
   * ⚠️ NO REFUSAL REASON: the press does not persist one. Empty for a gate that is not an
   * approved approval gate on this card.
   */
  async listApprovalMembers(
    input: { workItemId: string; approvalGateId: string },
    ctx: ServiceContext,
  ): Promise<PullRequestApprovalMemberDTO[]> {
    return withWorkspaceContext(ctx, async (tx) => {
      const approval = await approvalGateRepository.findById(input.approvalGateId, tx);
      if (
        !approval ||
        approval.kind !== APPROVAL_KIND ||
        approval.state !== 'approved' ||
        approval.workItemId !== input.workItemId
      ) {
        return [];
      }
      const mergeGates = await approvalGateRepository.findByWorkItemAndKind(
        input.workItemId,
        KIND,
        tx,
      );
      const pullRequests = await githubPullRequestRepository.findManyByIdsForSummary(
        [...new Set(mergeGates.map((gate) => gate.subjectId))],
        tx,
      );
      return membersOf(approval.subjectVersion).map(({ subjectVersion }) => {
        const gates = mergeGates.filter((gate) => gate.subjectVersion === subjectVersion);
        const awaiting = gates.find((gate) => gate.state === 'awaiting') ?? null;
        const approved = gates.find((gate) => gate.state === 'approved') ?? null;
        const pr = approved ? pullRequests.get(approved.subjectId) : undefined;
        return {
          subjectVersion,
          awaitingMergeGateId: awaiting?.id ?? null,
          queued:
            pr !== undefined && !pr.merged && (pr.mergeOutcomeRef?.startsWith('queue:') ?? false),
        };
      });
    });
  },

  /**
   * APPROVE AND MERGE — the one press behind the approve-and-merge gate (Story MOTIR-4909 ·
   * MOTIR-5483; `approval-gates.md` §8's amendment, decision 5).
   *
   * ⚠️ THE ORDER IS THE WHOLE DESIGN, one level up from `approveMergeGate`'s:
   *
   *   1. the APPROVAL commits first, through the ONE decide door, and the card moves
   *      `in_review → approved`. A refusal the door raises (not authorised, already decided,
   *      superseded) ends the press here, and nothing is merged or queued;
   *   2. AFTER that commit, each pull request in the approved set — in `subjectVersion`'s
   *      canonical order — is handed to the merge entry point above, which merges it or
   *      enqueues it and decides its merge gate only on success. This method never names a
   *      host;
   *   3. each merge gate carries the approval's `decidedAt` (and, through the door, the same
   *      actor and source), so the rows of one press read as one decision at one instant.
   *
   * EVERY member is attempted: a refusal on one does not stop the next, because the approval
   * covers all of them. The approval stands whatever the merges do, and the result reports
   * each member — `merged`, `enqueued`, `refused` with its typed refusal, or `no_merge_gate`
   * when none is awaiting for that exact head.
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

    // STEP 1 — the approval, committed in the door's own transaction.
    const approval = await approvalGatesService.decide({ ...input, decision: 'approve' }, ctx);
    const decidedAt = new Date(approval.gate.decidedAt!);

    // STEP 2 — each member, after that commit. A member is matched to its merge gate by the
    // exact `owner/name#number@headSha` both versions are spelled in, so a merge gate raised
    // for a different head is never merged on this approval.
    const awaiting = await withWorkspaceContext(ctx, (tx) =>
      approvalGateRepository.findAwaitingByWorkItem(approval.gate.workItemId, tx),
    );
    const mergeGateByVersion = new Map(
      awaiting
        .filter((row) => row.kind === KIND && row.subjectVersion !== null)
        .map((row) => [row.subjectVersion!, row]),
    );
    const members: ApproveAndMergeMemberOutcome[] = [];
    for (const { subjectVersion } of membersOf(approval.gate.subjectVersion)) {
      const mergeGate = mergeGateByVersion.get(subjectVersion);
      members.push(
        mergeGate
          ? await mergeMember(mergeGate, subjectVersion, input, ctx, decidedAt)
          : { subjectVersion, mergeGateId: null, pullRequestId: null, outcome: 'no_merge_gate' },
      );
    }
    return { approval, members };
  },

  /**
   * RETRY one refused member of an approve-and-merge press — step 2 of {@link approveAndMerge}
   * for that ONE merge gate alone, recorded at the approval's instant. The approval must
   * already be decided `approved`, and the merge gate must hang on the same card.
   */
  async retryApproveAndMergeMember(
    input: Omit<DecideGateInput, 'decision' | 'gateId'> & {
      approvalGateId: string;
      mergeGateId: string;
    },
    ctx: ServiceContext,
  ): Promise<ApproveAndMergeMemberOutcome> {
    const [approval, mergeGate] = await withWorkspaceContext(ctx, (tx) =>
      Promise.all([
        approvalGateRepository.findById(input.approvalGateId, tx),
        approvalGateRepository.findById(input.mergeGateId, tx),
      ]),
    );
    if (
      !approval ||
      approval.kind !== APPROVAL_KIND ||
      approval.state !== 'approved' ||
      !approval.decidedAt
    ) {
      throw new ApprovalGateNotFoundError(input.approvalGateId);
    }
    if (!mergeGate || mergeGate.kind !== KIND || mergeGate.workItemId !== approval.workItemId) {
      throw new ApprovalGateNotFoundError(input.mergeGateId);
    }
    return mergeMember(
      mergeGate,
      mergeGate.subjectVersion ?? '',
      { source: input.source, noteMd: input.noteMd },
      ctx,
      approval.decidedAt,
    );
  },
};

/**
 * Merge or enqueue ONE member of an approve-and-merge press through the merge entry point,
 * and turn a refusal into a result rather than a throw — so the next member is still tried.
 * An error that is not a refusal of this member is rethrown.
 */
async function mergeMember(
  mergeGate: { id: string; subjectId: string },
  subjectVersion: string,
  input: Pick<DecideGateInput, 'source' | 'noteMd'>,
  ctx: ServiceContext,
  decidedAt: Date,
): Promise<ApproveAndMergeMemberOutcome> {
  const member = { subjectVersion, mergeGateId: mergeGate.id, pullRequestId: mergeGate.subjectId };
  try {
    const decided = await pullRequestMergeService.approveMergeGate(
      { gateId: mergeGate.id, source: input.source, noteMd: input.noteMd ?? null },
      ctx,
      { decidedAt },
    );
    return { ...member, outcome: decided.mergeOutcome };
  } catch (err) {
    const refusal = memberRefusal(err);
    if (!refusal) throw err;
    return { ...member, outcome: 'refused', refusal };
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
