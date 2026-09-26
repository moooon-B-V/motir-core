import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import {
  countingReviewNote,
  parseDeliverySetVersion,
  setVerdict,
  type CountableReview,
  type DeliverySetMember,
  type MemberReviews,
} from '@/lib/approvalGates/reviewVerdict';
import {
  ApprovalGateAlreadyDecidedError,
  ApprovalGateSupersededError,
} from '@/lib/approvalGates/errors';
import { approvalGateRepository } from '@/lib/repositories/approvalGateRepository';
import { githubIdentityRepository } from '@/lib/repositories/githubIdentityRepository';
import { githubPullRequestReviewRepository } from '@/lib/repositories/githubPullRequestReviewRepository';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { workspaceMembershipRepository } from '@/lib/repositories/workspaceMembershipRepository';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import type { Prisma } from '@/generated/prisma/client';
import { approvalGatesService } from './approvalGatesService';
import { resolveRunTargetFor } from './runTarget';
import { runSyncedMerge } from './syncedMergeRunner';
import { designResultHoldsMerge } from './mergeGates';
import { decisionHoldsMerge } from '@/lib/approvalGates/decisionApprovalHandler';

// A REVIEW DECIDES THE SET (Story MOTIR-4910 · MOTIR-5597;
// `docs/decisions/approval-gates.md` §8 FOURTH AMENDMENT, decisions 1, 2, 3 and 8).
//
// Recorded reviews in; a decision on the RUN TARGET's one approve-to-merge gate out. The
// rule itself is pure and lives in `reviewVerdict.ts`; this module is the part that needs a
// database: which gate, whose reviews, and who Motir records and acts as.
//
// ── WHY TWO REVIEWS ARRIVING AT ONCE IS SAFE, stated rather than assumed ──────────────
// A card's two members can be approved simultaneously, and each delivery is evaluated after
// its OWN review row has committed. So whichever evaluation runs second reads both rows and
// sees the complete set; the one that ran first saw an incomplete set and correctly returned
// `pending`. If they overlap exactly, both may compute `approved` — and the DOOR's row lock
// settles it: one decides, the other meets `ApprovalGateAlreadyDecidedError` and reports
// `already_decided`. The gate is decided once and the merge is handed off once.
//
// The defeat condition worth testing is therefore not the lock (which is the door's) but
// the READ: an evaluation that read reviews BEFORE its own row committed would see an
// incomplete set and leave the gate awaiting with nobody left to wake it. That is what the
// concurrent test pins.
//
// ⚠️ IT NEVER CREATES OR WITHDRAWS A GATE. Raising is `pullRequestApprovalGates`'s, on green,
// and withdrawing is its head-move / close / set-change arms'. This module only decides one
// that already exists.

const KIND = 'pull_request_approval' as const;

/** What one gate's evaluation concluded. */
export type ReviewEvaluationOutcome =
  | 'decided_approved'
  | 'decided_changes_requested'
  | 'pending'
  /** The card has no awaiting approve-to-merge gate — the ordinary state before CI is green,
   *  and in an `auto` project, where no gate is ever raised (decision 10). */
  | 'no_awaiting_gate'
  /** Somebody — or some earlier review — already answered it. First decision stands. */
  | 'already_decided'
  /** The set changed under the question, so it was withdrawn. */
  | 'superseded'
  /** Every member is approved on GitHub, and the card carries a design result nobody has
   *  approved (Bug MOTIR-5762; `design-result.md` AMENDMENT 6 Q1). The reviews stay
   *  recorded and the merge gate stays open: the design's own press merges the set, or a
   *  later evaluation applies the reviews once the design is approved alone. */
  | 'held_by_design'
  /** Every member is approved on GitHub, and the card is a DECISION card whose decision
   *  nobody has accepted yet (MOTIR-5677; `approval-gates.md` §8's FIFTH AMENDMENT,
   *  clause 5). The reviews stay recorded; the decision's own press merges the set, and
   *  nobody is asked twice. */
  | 'held_by_decision';

export interface ReviewEvaluation {
  workItemId: string;
  gateId: string | null;
  outcome: ReviewEvaluationOutcome;
}

interface Ctx {
  userId: string;
  workspaceId: string;
}

/** The gate, its members and the reviews stored against them — everything the verdict needs,
 *  read in ONE pass. */
interface GateReviewSet {
  gateId: string;
  workItemId: string;
  workspaceId: string;
  members: MemberReviews[];
  /** Every member's pull-request row id, in the gate's own order. */
  memberPullRequestIds: string[];
  /** What each review SAID, by `githubReviewId` — kept beside the verdict rather than
   *  inside it, because the verdict reads a review's standing and never its text. */
  bodies: Map<string, string | null>;
}

/**
 * Read one card's awaiting gate and the reviews for every member of the set it asked about.
 *
 * ⚠️ ONE `listForPullRequests` CALL PER GATE, however many members the set has — the read is
 * keyed on the pull-request ids, not looped over them. A set spanning four repositories is
 * one query, not four.
 */
async function readGateReviewSet(
  workItemId: string,
  tx: Prisma.TransactionClient,
): Promise<GateReviewSet | null> {
  const gate = (await approvalGateRepository.findAwaitingByWorkItem(workItemId, tx)).find(
    (row) => row.kind === KIND,
  );
  if (!gate) return null;

  const asked = parseDeliverySetVersion(gate.subjectVersion);
  if (asked.length === 0) return null;

  // Match each member the gate NAMED to the card's current delivery rows. A member the card
  // no longer delivers simply finds no row: the set then cannot be complete, the verdict is
  // `pending`, and the withdraw path — not this one — is what retires the question.
  const deliveries = await workItemDeliveryRepository.listByWorkItemWithChecks(workItemId, tx);
  const byKey = new Map(
    deliveries.map((d) => [`${d.repo.owner}/${d.repo.name}#${d.pullRequest.number}`, d]),
  );

  const pairs: { member: DeliverySetMember; pullRequestId: string }[] = [];
  for (const member of asked) {
    const delivery = byKey.get(`${member.repo}#${member.number}`);
    if (!delivery) return null;
    pairs.push({ member, pullRequestId: delivery.githubPullRequestId });
  }

  const rows = await githubPullRequestReviewRepository.listForPullRequests(
    pairs.map((p) => p.pullRequestId),
    tx,
  );
  const byPullRequest = new Map<string, CountableReview[]>();
  for (const row of rows) {
    const list = byPullRequest.get(row.githubPullRequestId) ?? [];
    list.push(row);
    byPullRequest.set(row.githubPullRequestId, list);
  }

  return {
    gateId: gate.id,
    workItemId,
    workspaceId: gate.workspaceId,
    members: pairs.map(({ member, pullRequestId }) => ({
      member,
      rows: byPullRequest.get(pullRequestId) ?? [],
    })),
    memberPullRequestIds: pairs.map((p) => p.pullRequestId),
    bodies: new Map(rows.map((row) => [row.githubReviewId, row.body])),
  };
}

/** Who Motir records as the DECIDER, and who it writes the status AS (decisions 3 and 5). */
async function resolveActors(
  reviewerGithubUserId: string,
  workspaceId: string,
  tx: Prisma.TransactionClient,
): Promise<{ writerUserId: string } | null> {
  const identity = await githubIdentityRepository.findByGithubUserId(reviewerGithubUserId, tx);
  const member = identity
    ? await workspaceMembershipRepository.findByUserAndWorkspaceInTx(
        identity.userId,
        workspaceId,
        tx,
      )
    : null;
  if (member && identity) return { writerUserId: identity.userId };

  // The reviewer is not a Motir member, so somebody else has to be entitled to write the
  // status. The workspace OWNER is the fallback `changeRequestStatusSync` already uses for a
  // webhook-driven move, and reusing it keeps one answer to "who writes when nobody clicked".
  const owner = await workspaceMembershipRepository.findStandInManagerByWorkspace(workspaceId, tx);
  return owner ? { writerUserId: owner.userId } : null;
}

/** Decide one gate from its set's reviews, and hand an approval to the merge step. */
async function evaluateOne(workItemId: string, workspaceId: string): Promise<ReviewEvaluation> {
  const systemCtx: Ctx = { userId: '', workspaceId };

  // PASS 1 — read, in a transaction of its own. The decision is a SECOND transaction (the
  // door's), which is what keeps this read off the gate's row lock.
  const read = await withWorkspaceContext(systemCtx, async (tx) => {
    const set = await readGateReviewSet(workItemId, tx);
    if (!set) return null;
    const verdict = setVerdict(set.members);
    if (verdict.verdict === 'pending') return { set, verdict, actors: null, held: false as const };
    // ⚠️ AN APPROVAL ON GITHUB DOES NOT MERGE OVER AN UNANSWERED DESIGN (Bug MOTIR-5762).
    // The design is the PRIMARY question and the merge follows it; deciding the merge gate
    // from reviews alone would merge a design nobody approved. A request for changes is
    // still applied — it merges nothing.
    if (verdict.verdict === 'approved' && (await designResultHoldsMerge(workItemId, tx))) {
      return { set, verdict, actors: null, held: 'held_by_design' as const };
    }
    // ⚠️ …NOR A DECISION NOBODY ACCEPTED (MOTIR-5677) — the same rule for the other primary
    // kind. The approve-to-merge gate's own `approve` would refuse it under the door's lock;
    // asking here first turns that into an outcome rather than a thrown error on a webhook.
    if (verdict.verdict === 'approved') {
      const item = await workItemRepository.findById(workItemId, tx);
      if (item && (await decisionHoldsMerge(item, tx))) {
        return { set, verdict, actors: null, held: 'held_by_decision' as const };
      }
    }
    const actors = await resolveActors(verdict.decider.reviewerGithubUserId, set.workspaceId, tx);
    return { set, verdict, actors, held: false as const };
  });

  if (!read) return { workItemId, gateId: null, outcome: 'no_awaiting_gate' };
  const { set, verdict, actors, held } = read;
  if (held) return { workItemId, gateId: set.gateId, outcome: held };
  if (verdict.verdict === 'pending') {
    return { workItemId, gateId: set.gateId, outcome: 'pending' };
  }
  if (!actors) {
    // No member and no owner: nobody can author the status write. The reviews stay recorded
    // and the next evaluation tries again — exactly what `changeRequestStatusSync` does.
    return { workItemId, gateId: set.gateId, outcome: 'pending' };
  }

  const decision = verdict.verdict === 'approved' ? 'approve' : 'request_changes';
  // ⚠️ A REFUSAL SAYS WHY — and on GitHub, what the reviewer WROTE is the why (ADR §10b,
  // MOTIR-6074). The deciding review's body becomes the gate's reason; a review with no
  // text records NULL, which a surface reads as *no reason given on GitHub*. This path is
  // never refused for an empty reason: the door keys that rule on a source somebody
  // PRESSED, and nobody pressed this in Motir.
  const noteMd =
    verdict.verdict === 'approved'
      ? countingReviewNote(verdict.counting)
      : (set.bodies.get(verdict.decider.githubReviewId) ?? null);
  const ctx: Ctx = { userId: actors.writerUserId, workspaceId: set.workspaceId };

  try {
    await approvalGatesService.decide(
      // A reviewer on GitHub: no Motir page was rendered, so there is no stamp to
      // hand back (MOTIR-5234). The door's state refusals still apply.
      { gateId: set.gateId, decision, source: 'github', noteMd, stamp: DECIDED_WITHOUT_A_READER },
      ctx,
      {
        synced: {
          reviewerGithubUserId: verdict.decider.reviewerGithubUserId,
          reviewerLogin: verdict.decider.reviewerLogin,
        },
      },
    );
  } catch (err) {
    // Both are ORDINARY answers on this path, not failures: a gate somebody already decided,
    // or one withdrawn under the question. They are reported as outcomes and never rethrown,
    // so a redelivery is harmless.
    if (err instanceof ApprovalGateAlreadyDecidedError) {
      return { workItemId, gateId: set.gateId, outcome: 'already_decided' };
    }
    if (err instanceof ApprovalGateSupersededError) {
      return { workItemId, gateId: set.gateId, outcome: 'superseded' };
    }
    throw err;
  }

  if (verdict.verdict === 'approved') {
    // ⚠️ AFTER THE DECISION COMMITS, never inside it (decision 6). The approval stands
    // whatever the host says about any member.
    await runSyncedMerge({
      gateId: set.gateId,
      workItemId,
      workspaceId: set.workspaceId,
      actorUserId: actors.writerUserId,
      members: set.members.map((m) => m.member),
    });
    return { workItemId, gateId: set.gateId, outcome: 'decided_approved' };
  }
  return { workItemId, gateId: set.gateId, outcome: 'decided_changes_requested' };
}

/**
 * Evaluate every card ONE pull request delivers — the arm a `pull_request_review` delivery
 * runs after recording its row.
 *
 * ⚠️ IT EVALUATES THE RUN TARGET, NOT THE CARD THE PULL REQUEST NAMES. A child card that the
 * same pull requests deliver has no gate of its own (MOTIR-5479, decision 1); its ancestor's
 * gate is the one a review decides, and resolving it here is what makes a review on a
 * child's pull request reach the question a person is actually asked.
 */
export async function evaluateForPullRequest(
  githubPullRequestId: string,
  workspaceId: string,
): Promise<ReviewEvaluation[]> {
  const targets = await withWorkspaceContext({ userId: '', workspaceId }, async (tx) => {
    const deliveries = await workItemDeliveryRepository.listByPullRequest(githubPullRequestId, tx);
    const ids = new Set<string>();
    for (const delivery of deliveries) {
      const item = await workItemRepository.findById(delivery.workItemId, tx);
      if (!item) continue;
      const runTarget = await resolveRunTargetFor(item, tx);
      ids.add(runTarget.kind === 'ancestor' ? runTarget.holder.id : item.id);
    }
    return [...ids];
  });

  const evaluations: ReviewEvaluation[] = [];
  for (const workItemId of targets) {
    evaluations.push(await evaluateOne(workItemId, workspaceId));
  }
  return evaluations;
}

/**
 * Evaluate ONE run target — decision 8's arm.
 *
 * Reviews are recorded whether or not a gate exists, so an approval given while CI was still
 * running has nowhere to be applied. When the gate is finally raised, THIS is what applies
 * the reviews that were already there, and the reviewer is never asked a second time.
 */
export async function evaluateForWorkItem(
  workItemId: string,
  workspaceId: string,
): Promise<ReviewEvaluation> {
  return evaluateOne(workItemId, workspaceId);
}

/**
 * The post-raise evaluation, wrapped so it can never fail its caller (decision 8).
 *
 * ⚠️ BEST-EFFORT BY DESIGN. The promotion that raised the gate has COMMITTED by the time this
 * runs; throwing here would fail a request whose real work is already done, and the card
 * would read as un-promoted when it is not. A failure is logged with the card, and the next
 * review event evaluates again — the reviews are still recorded, so nothing is lost.
 */
export async function evaluateAfterRaise(workItemId: string, workspaceId: string): Promise<void> {
  try {
    await evaluateForWorkItem(workItemId, workspaceId);
  } catch (err) {
    console.warn('[pullRequestReviewSync] post-raise evaluation failed', {
      workItemId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
