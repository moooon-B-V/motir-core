import type { Prisma } from '@/generated/prisma/client';
import { workItemRepository } from '@/lib/repositories/workItemRepository';

// WHICH WORK ITEMS DOES THIS CHANGE REQUEST DELIVER? (MOTIR-3007)
//
// ── Why this is a module and not two lines inside the sync ──────────────────
// `github_pull_request.work_item_id` is a single nullable column, so the schema
// can only answer "which ONE item is this change request linked to". That was
// true enough while every pull request carried one card. `motir auto` broke the
// assumption: it integrates a whole run onto ONE session branch and opens ONE
// pull request for it, and `sessionBranchName` (`packages/cli/src/git.ts`)
// deliberately keeps `MOTIR-<n>` OUT of that branch precisely so the 1:1
// resolver cannot pick one of the run's cards at random. The consequence was
// that merging a session pull request closed NOTHING.
//
// TWO consumers need the same answer, one hop apart:
//
//   * the MERGE (`changeRequestStatusSync`) — every card the run delivered goes
//     to `done`;
//   * CI GREEN (MOTIR-3006, `changeRequestCiFeedback`) — every card the run
//     delivered is promoted out of `implemented`.
//
// They must never disagree about the membership, and the membership is
// UNRECOVERABLE after the fact: `work_item.session_branch` is the only record of
// it, and `completeSession` CLEARS the column as it closes each item. A second,
// divergent copy of this rule would therefore produce two different answers to
// "which cards did that pull request carry" with no way to tell which was right.
// So the rule lives here once, with no caller-specific behaviour, and both
// consumers call it unmodified.
//
// ── The rule ────────────────────────────────────────────────────────────────
// The head ref names a session branch that HAS work items ⇒ the delivery carries
// every item recorded on that branch. Otherwise ⇒ the single linked item,
// exactly as before (the head-ref/title resolve, or a sticky manual link).
//
// "HAS work items" is the whole test — there is no name pattern to match, and
// deliberately so. `motir/auto-<runId>` is the CLI's current shape and nothing
// should depend on it: a branch is a session branch when cards say they were
// integrated onto it, which is the fact that actually matters and the one a
// future runner (or a hand-run close-out) sets the same way.

/** One work item a change request delivers — the slice both consumers need. */
export interface ChangeRequestWorkItemRef {
  id: string;
  identifier: string;
  projectId: string;
  status: string;
  /** The repositories the item ships in — MOTIR-2729's completion gate reads it. */
  targetRepos: string[];
}

/** How the delivery's work items were resolved. `session_branch` is the many-card
 *  run; `single_item` is every ordinary pull request, and is the common case. */
export type ChangeRequestDeliveryKind = 'session_branch' | 'single_item';

export interface ChangeRequestWorkItemSet {
  kind: ChangeRequestDeliveryKind;
  /** The branch the items were integrated onto — non-null iff `session_branch`. */
  sessionBranch: string | null;
  /** Every work item this change request delivers; empty when it delivers none. */
  items: ChangeRequestWorkItemRef[];
}

/**
 * Resolve the work items one change request delivers.
 *
 * `linked` is the 1:1 resolve the caller already performed (head ref / title, or
 * a sticky manual link) — it is used ONLY when the head ref is not a session
 * branch, so a caller never has to decide which of the two answers to prefer.
 *
 * Reads inside the caller's transaction, so it sees the same snapshot (and the
 * same row locks) as the decision it feeds.
 */
export async function resolveChangeRequestWorkItemSet(args: {
  workspaceId: string;
  headRef: string;
  linked: ChangeRequestWorkItemRef | null;
  tx: Prisma.TransactionClient;
}): Promise<ChangeRequestWorkItemSet> {
  const onBranch = await workItemRepository.findBySessionBranch(
    args.headRef,
    args.workspaceId,
    args.tx,
  );
  if (onBranch.length > 0) {
    return {
      kind: 'session_branch',
      sessionBranch: args.headRef,
      items: onBranch.map((item) => ({
        id: item.id,
        identifier: item.identifier,
        projectId: item.projectId,
        status: item.status,
        targetRepos: item.targetRepos,
      })),
    };
  }
  return {
    kind: 'single_item',
    sessionBranch: null,
    items: args.linked ? [args.linked] : [],
  };
}
