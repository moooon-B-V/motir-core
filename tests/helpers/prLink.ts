import { githubPullRequestService } from '@/lib/services/githubPullRequestService';
import { adminDb } from './adminDb';

// The test-side door onto the ONLY association a pull request has (MOTIR-3674).
//
// Until that card, a suite could associate a pull request with a work item by
// naming the key in the head ref or the title and letting the sync's parse find
// it. The parse is retired, so every suite that means *this pull request
// delivers this card* now has to SAY so — which is exactly what a run does, via
// `link_pull_request`, immediately after `gh pr create`.
//
// Both helpers wrap `githubPullRequestService.linkPullRequestByCoordinates`, the
// same service method the MCP tool calls, rather than writing the column
// directly: a helper that reached past the product would let a suite pass while
// the door an agent actually uses was broken.
//
// They are deliberately callable BEFORE the pull request has been ingested —
// that is the case the coordinates form exists for, and it is the ordering a
// real run produces (the agent links the moment `gh pr create` returns, which is
// before GitHub's delivery arrives). Calling after an `opened` delivery works
// too, but then the card has already failed to move on that delivery.

/**
 * Every work-item id a pull-request ROW delivers, oldest link first.
 *
 * The test-side counterpart of the link helpers above, and it exists because
 * MOTIR-3757 dropped `github_pull_request.work_item_id`: a suite that used to
 * assert `prRow.workItemId` is asserting a column that no longer exists, and the
 * fact it was reaching for lives in `work_item_delivery`. Reading through
 * `adminDb` deliberately — the assertion is about what is STORED, not about what
 * a bound reader can see, which its own RLS suite covers.
 */
export async function deliveredItemIds(githubPullRequestId: string): Promise<string[]> {
  const rows = await adminDb.workItemDelivery.findMany({
    where: { githubPullRequestId },
    orderBy: { createdAt: 'asc' },
    select: { workItemId: true },
  });
  return rows.map((r) => r.workItemId);
}

export interface LinkPrArgs {
  /** The work item the pull request delivers. */
  workItemId: string;
  /** Its project — the permission assertion reads it. */
  projectId: string;
  owner: string;
  name: string;
  number: number;
  headRef: string;
  /** Defaults to `main`, which is every fixture repo's default branch. */
  baseRef?: string;
  title?: string | null;
}

/** Link a pull request to a work item the way a run does. Returns the service's
 *  own result, so a caller can assert `created` / `movedFrom` when that is the
 *  point of the test. */
export async function linkPr(args: LinkPrArgs, ctx: { userId: string; workspaceId: string }) {
  return githubPullRequestService.linkPullRequestByCoordinates(
    {
      workItemId: args.workItemId,
      projectId: args.projectId,
      owner: args.owner,
      name: args.name,
      number: args.number,
      headRef: args.headRef,
      baseRef: args.baseRef ?? 'main',
      title: args.title ?? null,
    },
    ctx,
  );
}

/**
 * The same link, addressed by the work item's IDENTIFIER (`ACME-7`) and acting
 * as its workspace OWNER.
 *
 * Exists because a suite's own PR-delivery helper usually holds the identifier
 * and nothing else — it was written when the identifier in the branch WAS the
 * link — so this lets such a helper gain one line instead of a new signature.
 * The owner is always edit-capable, which keeps the permission assertion out of
 * the way of tests that are about something else.
 */
export async function linkPrByIdentifier(args: {
  identifier: string;
  owner: string;
  name: string;
  number: number;
  headRef: string;
  baseRef?: string;
  title?: string | null;
}) {
  // ⚠️ Resolve the item in the workspace that actually has this repository
  // connected. A suite that builds TWO scenarios with the same project key has
  // two `ACME-1`s, and `persistInstallation` upserts by installation id — so the
  // repository moves to whichever workspace was seeded last. Matching on the
  // identifier alone picks the older item and the link then fails looking for a
  // repository that is no longer in its workspace.
  const candidates = await adminDb.workItem.findMany({
    where: { identifier: args.identifier },
    orderBy: { createdAt: 'desc' },
    select: { id: true, projectId: true, workspaceId: true },
  });
  let item: (typeof candidates)[number] | undefined;
  for (const c of candidates) {
    const repo = await adminDb.githubRepo.findFirst({
      where: {
        workspaceId: c.workspaceId,
        owner: { equals: args.owner, mode: 'insensitive' },
        name: { equals: args.name, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (repo) {
      item = c;
      break;
    }
  }
  if (!item)
    throw new Error(
      `linkPrByIdentifier: no ${args.identifier} in a workspace connected to ${args.owner}/${args.name}`,
    );
  // The OWNER membership — the oldest `role: 'owner'` row, exactly as
  // `workspaceMembershipRepository.findOwnerByWorkspace` resolves it.
  const owner = await adminDb.workspaceMembership.findFirstOrThrow({
    where: { workspaceId: item.workspaceId, role: 'owner' },
    orderBy: { createdAt: 'asc' },
    select: { userId: true },
  });
  return linkPr(
    {
      workItemId: item.id,
      projectId: item.projectId,
      owner: args.owner,
      name: args.name,
      number: args.number,
      headRef: args.headRef,
      baseRef: args.baseRef,
      title: args.title,
    },
    { userId: owner.userId, workspaceId: item.workspaceId },
  );
}
