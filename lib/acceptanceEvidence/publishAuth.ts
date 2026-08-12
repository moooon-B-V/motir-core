import { NextResponse } from 'next/server';
import type { WorkItem } from '@/generated/prisma/client';
import { ACCEPTANCE_PUBLISH_PERMISSION } from '@/lib/tokens/grant';
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

  const resolved = await resolveWorkItemByIdentifier(identifier, ctx);
  if (resolved instanceof Response) return resolved;
  let story: WorkItem = resolved;

  // Acceptance evidence is a STORY-level artifact (Principle #18 — review at the
  // Story level). When the CI caller passes a non-story LEAF (a subtask / bug /
  // task PR key — the PR-title status-sync convention leaves the subtask's own
  // `MOTIR-<id>`, MOTIR-1684), resolve UP to its parent STORY so the video
  // attaches to the story, not the leaf. A story key resolves to itself. This is
  // the server-side, keyless-safe half of the PR-`MOTIR-<id>` → parent-story
  // resolution (the CI job has no DB access); a non-story leaf with no story
  // parent is left as-is → the service rejects it NOT_A_STORY (422).
  if (story.kind !== 'story' && story.parentId) {
    const parentId = story.parentId;
    const parent = await withWorkspaceContext(ctx, (tx) =>
      workItemRepository.findById(parentId, tx),
    );
    if (parent && parent.kind === 'story') story = parent;
  }

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
