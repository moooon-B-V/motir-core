import { NextResponse } from 'next/server';
import type { WorkItem } from '@/generated/prisma/client';
import {
  ACCEPTANCE_PUBLISH_PERMISSION,
  ACCEPTANCE_STATUS_READ_PERMISSION,
} from '@/lib/tokens/grant';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { acceptanceVideoEligibilityService } from '@/lib/services/acceptanceVideoEligibilityService';
import {
  authenticateCiPublisher,
  resolveWorkItemByIdentifier,
} from '@/lib/publishAuth/ciPublishAuth';

// Shared gate for the acceptance-publish routes (MOTIR-1631/1681): both the
// mint-token route and the register route authenticate the CI caller (keyless
// GitHub OIDC first, else a PAT holding the required permission), resolve the
// STORY within the caller's workspace, and apply the plan/toggle eligibility
// gate — identically.
//
// The auth + resolve halves moved to `lib/publishAuth/ciPublishAuth.ts` when the
// design result became a second CI publisher (MOTIR-2667); the two steps BELOW —
// the parent-story hop and the eligibility gate — are what make this gate
// acceptance's rather than every publisher's. Behaviour is unchanged.
//
// ⚠️ The PAT arm asks for `ACCEPTANCE_PUBLISH_PERMISSION`, NOT the old
// `'integration'` scope. MOTIR-2576 made that change on `main` while the
// extraction above was in flight, and it is the one caller that is neither MCP
// nor `/api/v1` — the one a migration of "the two big seams" leaves behind, with
// every story's acceptance video 403ing. The permission is threaded through the
// shared helper rather than baked into it, so the second publisher can ask for
// its own and neither can silently inherit the other's.

/**
 * Resolve a `MOTIR-7`-style identifier to the STORY an acceptance receipt hangs
 * on, inside the caller's workspace. Returns the story, or a ready 404
 * `Response` (finding #44 — a hidden / cross-workspace / missing item reads 404,
 * never 403).
 *
 * Acceptance evidence is a STORY-level artifact (Principle #18 — review at the
 * Story level). When the CI caller passes a non-story LEAF (a subtask / bug /
 * task PR key — the PR-title status-sync convention leaves the subtask's own
 * `MOTIR-<id>`, MOTIR-1684), resolve UP to its parent STORY so the video
 * attaches to the story, not the leaf. A story key resolves to itself. This is
 * the server-side, keyless-safe half of the PR-`MOTIR-<id>` → parent-story
 * resolution (the CI job has no DB access); a non-story leaf with no story
 * parent is left as-is → the caller rejects it NOT_A_STORY (422).
 *
 * ⚠️ SHARED BY THE PUBLISH AND THE STATUS READ, deliberately (MOTIR-4144). The
 * guard reads the receipt at the SAME coordinate the publisher wrote it to; two
 * copies of this hop would let the two disagree about which item's receipt is
 * under discussion, and the disagreement would be silent — the read would answer
 * "no receipt" for a story that has one.
 */
export async function resolveAcceptanceStory(
  identifier: string,
  ctx: { userId: string; workspaceId: string },
): Promise<WorkItem | Response> {
  const resolved = await resolveWorkItemByIdentifier(identifier, ctx);
  if (resolved instanceof Response) return resolved;
  return (await findOwningStoryParent(resolved, ctx)) ?? resolved;
}

/**
 * The HOP itself: the parent STORY that owns this item's receipt, or null when
 * the item owns it directly (it IS a story, it has no parent, or its parent is
 * not a story — the last case is left as-is so the caller rejects it
 * NOT_A_STORY rather than attaching a receipt to an epic).
 *
 * ⚠️ EXTRACTED, NOT COPIED (MOTIR-4704). The MCP publish tools resolve their
 * target through the read door the rest of the MCP surface uses, which raises a
 * typed error rather than the 404 `Response` the CI routes return — so they
 * cannot call {@link resolveAcceptanceStory}, whose first half is that
 * HTTP-shaped resolution. They need the SECOND half, and that half is what
 * MOTIR-4144's warning is about: a second copy of this hop is how the publisher
 * and the status read come to disagree about which card's receipt is under
 * discussion, silently — the read answering "no receipt" for a story that has
 * one. So the rule lives here once and every door reaches it, rather than each
 * door owning a plausible-looking three lines.
 *
 * Takes the minimal shape rather than a `WorkItem` so a caller holding a DTO
 * can ask the same question without a cast.
 */
export async function findOwningStoryParent(
  item: { kind: string; parentId: string | null },
  ctx: { userId: string; workspaceId: string },
): Promise<WorkItem | null> {
  if (item.kind === 'story' || !item.parentId) return null;
  const parentId = item.parentId;
  const parent = await withWorkspaceContext(ctx, (tx) => workItemRepository.findById(parentId, tx));
  return parent && parent.kind === 'story' ? parent : null;
}

export interface AcceptancePublishGate {
  ctx: { userId: string; workspaceId: string };
  story: WorkItem;
}

/**
 * Authenticate + resolve + eligibility-gate an acceptance publish. Returns the
 * resolved `{ ctx, story }`, or a ready error `Response` (401/402/403/404) the
 * route returns verbatim. A hidden / cross-workspace / missing story reads 404
 * (never 403 — finding #44).
 */
export async function authorizeAcceptancePublish(
  req: Request,
  identifier: string,
): Promise<AcceptancePublishGate | Response> {
  const ctx = await authenticateCiPublisher(req, ACCEPTANCE_PUBLISH_PERMISSION);
  if (ctx instanceof Response) return ctx;

  const story = await resolveAcceptanceStory(identifier, ctx);
  if (story instanceof Response) return story;

  // Eligibility gate (MOTIR-1630) — reject with the reason BEFORE any blob spend.
  const eligibility = await acceptanceVideoEligibilityService.resolve({
    actorUserId: ctx.userId,
    workspaceId: ctx.workspaceId,
  });
  if (!eligibility.eligible) {
    const status = eligibility.reason === 'no_plan' ? 402 : 403;
    return NextResponse.json(
      { code: 'ACCEPTANCE_VIDEO_INELIGIBLE', reason: eligibility.reason },
      { status },
    );
  }

  return { ctx, story };
}

/**
 * Authenticate + resolve a receipt-STATUS READ (MOTIR-4144). Returns the
 * resolved `{ ctx, story }`, or a ready error `Response` (401/403/404) the route
 * returns verbatim.
 *
 * TWO DELIBERATE DIFFERENCES FROM {@link authorizeAcceptancePublish}, and both
 * are the point of this function existing rather than the publish gate being
 * reused:
 *
 * 1. **The permission is {@link ACCEPTANCE_STATUS_READ_PERMISSION}
 *    (`project:browse`), not `work_item:edit`.** A read of one field of one work
 *    item asks for what every other read of a work item asks for — the key
 *    `get_work_item` and the rest of the MCP read surface assert. Requiring the
 *    publish permission would mean a credential that can only LOOK at receipts
 *    could also rewrite any work item in the project, which is the whole of what
 *    least privilege is about; and the lane guard that consumes this route wants
 *    exactly a read-only credential.
 * 2. **NO eligibility gate.** `acceptanceVideoEligibilityService` answers
 *    *"may this org publish an acceptance video?"* — an org toggle and a plan.
 *    That is a question about a WRITE, and the receipt it guards may already
 *    exist and be approved. Inheriting it would make an already-recorded receipt
 *    unreadable the day a plan lapses, and the lane guard's answer would silently
 *    change from "approved" to "not approved" for a reason that has nothing to do
 *    with the story.
 */
export async function authorizeAcceptanceStatusRead(
  req: Request,
  identifier: string,
): Promise<AcceptancePublishGate | Response> {
  const ctx = await authenticateCiPublisher(req, ACCEPTANCE_STATUS_READ_PERMISSION);
  if (ctx instanceof Response) return ctx;

  const story = await resolveAcceptanceStory(identifier, ctx);
  if (story instanceof Response) return story;

  return { ctx, story };
}
