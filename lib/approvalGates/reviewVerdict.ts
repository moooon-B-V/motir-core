import type { GithubPullRequestReview } from '@/generated/prisma/client';
import { membersOf, type MemberVersion } from './memberVersion';

// THE SET RULE, as a pure function (Story MOTIR-4910 · MOTIR-5597;
// `docs/decisions/approval-gates.md` §8 FOURTH AMENDMENT, decisions 1, 2 and 3).
//
// ⚠️ ITS OWN MODULE, AND IT IMPORTS NO SERVICE — the same rule `deliverySetVersion.ts`
// records, for the same reason. Two places read it: the evaluator that DECIDES
// (`pullRequestReviewSync`), and the Development block's read that DRAWS what each member's
// review says (MOTIR-5602). A helper living beside the evaluator would drag a service import
// into a render path.
//
// ⚠️ IT DECIDES NOTHING ABOUT A GATE. It answers *what do these rows say about this set?*
// The gate, the lock, the refusals and the record are the door's.

/**
 * One member of a delivery set, as its `subjectVersion` names it.
 *
 * ⚠️ IT IS `memberVersion.ts`'s TYPE, NOT A SECOND ONE, and `parseDeliverySetVersion` below
 * is that module's `membersOf` under the name this card's criteria use. MOTIR-5597 specified
 * a fresh parser here; the shipped one already existed, with the same format, the same
 * skip-a-malformed-member rule and the same client-safe constraints — and two parsers for
 * one string is precisely how a format drifts. The round-trip test still proves the inverse;
 * it now proves it about the one implementation.
 */
export type DeliverySetMember = MemberVersion;

/**
 * The exact inverse of `deliverySetVersion` — `owner/name#number@headSha`, sorted and
 * comma-joined, back into its members. A member that does not parse is DROPPED rather than
 * guessed at.
 */
export const parseDeliverySetVersion = membersOf;

/** The permissions that let a review COUNT — GitHub's own rule for a required approving
 *  review: approvals count from people who can write. `unknown` is NOT among them, and that
 *  is the safe direction: a permission Motir could not read decides nothing, and the person
 *  can still approve in Motir. */
const CAN_WRITE = new Set(['admin', 'maintain', 'write']);

/** A review that counts — a stored row, narrowed to the fields the rule reads. */
export type CountableReview = Pick<
  GithubPullRequestReview,
  | 'githubReviewId'
  | 'reviewerGithubUserId'
  | 'reviewerLogin'
  | 'state'
  | 'commitSha'
  | 'reviewerPermission'
  | 'submittedAt'
>;

/** Newest first, tie-broken by the host's review id so the order is total and stable. */
function newestFirst(a: CountableReview, b: CountableReview): number {
  const byTime = b.submittedAt.getTime() - a.submittedAt.getTime();
  return byTime !== 0 ? byTime : b.githubReviewId.localeCompare(a.githubReviewId);
}

/**
 * Each reviewer's LATEST countable review at `headSha`, one row per reviewer.
 *
 * Four filters, each a clause of decision 2, and the ORDER of the last two is what makes
 * "a reviewer who approved and then requested changes counts as changes_requested" true:
 * the `dismissed` and `changes_requested` rows stay in the pool so they can WIN the
 * per-reviewer latest, and only then does a `dismissed` winner drop out. Filtering
 * `dismissed` away first would silently promote that reviewer's earlier approval.
 */
export function countableReviewsAtHead(
  rows: readonly CountableReview[],
  headSha: string,
): CountableReview[] {
  const eligible = rows.filter(
    (row) =>
      row.state !== 'commented' &&
      row.commitSha === headSha &&
      CAN_WRITE.has(row.reviewerPermission),
  );

  const latestPerReviewer = new Map<string, CountableReview>();
  for (const row of [...eligible].sort(newestFirst)) {
    if (!latestPerReviewer.has(row.reviewerGithubUserId)) {
      latestPerReviewer.set(row.reviewerGithubUserId, row);
    }
  }

  // A reviewer whose latest word was a dismissal has withdrawn it, and contributes nothing.
  return [...latestPerReviewer.values()].filter((row) => row.state !== 'dismissed');
}

/** One member of the set, with the reviews stored against it. */
export interface MemberReviews {
  member: DeliverySetMember;
  rows: readonly CountableReview[];
}

/** What a set's reviews say. `decider` is the review that MADE it so. */
export type SetVerdict =
  | { verdict: 'approved'; decider: CountableReview; counting: CountingReview[] }
  | { verdict: 'changes_requested'; decider: CountableReview }
  | { verdict: 'pending'; unapproved: DeliverySetMember[] };

/** One member's counting review, for the note the decision records. */
export interface CountingReview {
  member: DeliverySetMember;
  review: CountableReview;
}

/**
 * THE SET RULE (decision 1).
 *
 * The order of the two decisive arms is the rule, not an optimisation: **changes requested
 * on ANY member wins over every other member's approval.** One reviewer asking for changes
 * is already the answer, and a set that approved around them would merge code somebody
 * objected to.
 *
 * `approved` needs EVERY member to carry at least one countable approval. One member's
 * approval decides nothing, because the row would then claim commits nobody approved — which
 * is the whole reason the gate's subject is the set rather than a pull request.
 */
export function setVerdict(members: readonly MemberReviews[]): SetVerdict {
  if (members.length === 0) return { verdict: 'pending', unapproved: [] };

  const countableFor = members.map((m) => ({
    member: m.member,
    countable: countableReviewsAtHead(m.rows, m.member.headSha),
  }));

  const changes = countableFor
    .flatMap(({ countable }) => countable.filter((r) => r.state === 'changes_requested'))
    .sort(newestFirst);
  if (changes.length > 0) return { verdict: 'changes_requested', decider: changes[0]! };

  const counting: CountingReview[] = [];
  const unapproved: DeliverySetMember[] = [];
  for (const { member, countable } of countableFor) {
    const approvals = countable.filter((r) => r.state === 'approved').sort(newestFirst);
    if (approvals.length === 0) unapproved.push(member);
    else counting.push({ member, review: approvals[0]! });
  }
  if (unapproved.length > 0) return { verdict: 'pending', unapproved };

  // The decider is the review that COMPLETED the set — the most recent of the approvals
  // the decision rests on, across members. The decision has one decider, and that is the
  // one whose act made it true.
  const decider = [...counting].sort((a, b) => newestFirst(a.review, b.review))[0]!.review;
  return { verdict: 'approved', decider, counting };
}

/** The note a synced decision records: every member's counting review, one per line. */
export function countingReviewNote(counting: readonly CountingReview[]): string {
  return counting
    .map(
      ({ member, review }) =>
        `${member.repo}#${member.number}@${member.headSha} — approved by @${review.reviewerLogin}`,
    )
    .join('\n');
}
