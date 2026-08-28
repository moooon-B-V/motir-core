import type { Prisma } from '@/generated/prisma/client';
import { workItemDeliveryRepository } from '@/lib/repositories/workItemDeliveryRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';

// WHICH WORK ITEMS DOES THIS CHANGE REQUEST DELIVER? (MOTIR-3007 · MOTIR-3721)
//
// ── Why this is a module and not two lines inside the sync ──────────────────
// `github_pull_request.work_item_id` is a single nullable column, so the schema
// could only ever answer "which ONE item is this change request linked to". That
// was true enough while every pull request carried one card. `motir auto` broke
// the assumption: it integrates a whole run onto ONE session branch and opens ONE
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
// They must never disagree about the membership. So the rule lives here once,
// with no caller-specific behaviour, and both consumers call it unmodified.
//
// ── The rule ────────────────────────────────────────────────────────────────
// The head ref names a session branch that HAS work items ⇒ the delivery carries
// every item recorded on that branch. Otherwise ⇒ every card the pull request's
// DELIVERY LINKS name (`work_item_delivery`).
//
// "HAS work items" is the whole test — there is no name pattern to match, and
// deliberately so. `motir/auto-<runId>` is the CLI's current shape and nothing
// should depend on it: a branch is a session branch when cards say they were
// integrated onto it, which is the fact that actually matters and the one a
// future runner (or a hand-run close-out) sets the same way.
//
// ── ⚠️ WHAT MOTIR-3721 CHANGED, and why the second arm is no longer capped ──
// This module used to take a `linked: ChangeRequestWorkItemRef | null` argument —
// the 1:1 resolve the caller had already performed off the scalar column — and
// its non-session arm returned `args.linked ? [args.linked] : []`. The RETURN
// TYPE was already set-shaped, so the cap was invisible in it: it lived in a
// `| null` in a parameter, which is why `git grep work_item_id` could not find
// it (`docs/decisions/delivery-reader-migration.md` §2). An explicitly-linked
// pull request was therefore capped at ONE work item by this function's own
// signature, whatever the delivery table held — and the measured cost was four
// merged pull requests delivering seven cards of which six never moved.
//
// The arm now reads `work_item_delivery` itself, keyed on the pull-request row,
// so the caller hands over the pull request rather than a pre-resolved answer.
// `single_item` was renamed `linked` with it: the member named a CARDINALITY it
// no longer has, and `linked` names the RESOLUTION (the delivery links), which
// stays true at every N including 0.

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
 *  run; `linked` is every ordinary pull request — its DELIVERY LINKS, which are
 *  usually one and are not capped at one (MOTIR-3721). */
export type ChangeRequestDeliveryKind = 'session_branch' | 'linked';

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
 * `githubPullRequestId` is the stored change-request ROW's id. It is read only
 * when the head ref is not a session branch, so a caller never has to decide
 * which of the two answers to prefer.
 *
 * Reads inside the caller's transaction, so it sees the same snapshot (and the
 * same row locks) as the decision it feeds — and inside the caller's TENANT
 * context: `work_item_delivery` carries a `system_admin` arm as of MOTIR-3721,
 * but `work_item` does not, so the `findByIds` below still needs a bound
 * workspace (MOTIR-2880). Both live callers bind before they get here.
 */
export async function resolveChangeRequestWorkItemSet(args: {
  workspaceId: string;
  headRef: string;
  githubPullRequestId: string;
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
      items: onBranch.map(toRef),
    };
  }

  return {
    kind: 'linked',
    sessionBranch: null,
    items: await resolveDeliveredWorkItems(args.githubPullRequestId, args.tx),
  };
}

/**
 * The LINKED arm on its own — every card this pull request's delivery links name.
 *
 * Exported because one caller needs exactly this arm and not the other: the
 * status sync consults the SESSION arm only on a `done` delivery, since its only
 * consumer is the session close-out and nothing but a merge may run that. Before
 * MOTIR-3721 that caller expressed the same restriction by simply not calling
 * this module at all for a non-`done` delivery and reading the link column
 * itself — which is precisely the reader being moved. Two entry points onto ONE
 * implementation is the shape that keeps the membership rule single.
 */
export async function resolveDeliveredWorkItems(
  githubPullRequestId: string,
  tx: Prisma.TransactionClient,
): Promise<ChangeRequestWorkItemRef[]> {
  // Oldest link first — `listByPullRequest` orders by `created_at`, and
  // `findByIds` does not, so the order is re-imposed here rather than left to
  // whatever the id read returns. It decides nothing, but a non-deterministic
  // order in a set two gates iterate is a flake waiting for a reason.
  const deliveries = await workItemDeliveryRepository.listByPullRequest(githubPullRequestId, tx);
  const ids = deliveries.map((d) => d.workItemId);
  if (ids.length === 0) return [];
  // A link whose target was hard-deleted cannot survive: the delivery row is
  // `onDelete: Cascade` on `work_item`. The lookup is still tolerant of a short
  // answer, because a row the tenant context cannot see must not become a
  // fabricated item.
  const byId = new Map((await workItemRepository.findByIds(ids, tx)).map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [toRef(row)] : [];
  });
}

function toRef(item: {
  id: string;
  identifier: string;
  projectId: string;
  status: string;
  targetRepos: string[];
}): ChangeRequestWorkItemRef {
  return {
    id: item.id,
    identifier: item.identifier,
    projectId: item.projectId,
    status: item.status,
    targetRepos: item.targetRepos,
  };
}
