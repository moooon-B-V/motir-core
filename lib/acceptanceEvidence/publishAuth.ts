import { NextResponse } from 'next/server';
import type { WorkItem } from '@prisma/client';
import { authenticateApiToken } from '@/lib/apiTokens/routeAuth';
import { authenticateGithubOidc } from '@/lib/github/oidcAuth';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { projectsService } from '@/lib/services/projectsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { acceptanceVideoEligibilityService } from '@/lib/services/acceptanceVideoEligibilityService';
import { ProjectNotFoundError } from '@/lib/projects/errors';

// Shared gate for the acceptance-publish routes (MOTIR-1631/1681): both the
// mint-token route and the register route authenticate the CI caller (keyless
// GitHub OIDC first, else an `integration` PAT), resolve the STORY within the
// caller's workspace, and apply the plan/toggle eligibility gate — identically.

export interface AcceptancePublishGate {
  ctx: { userId: string; workspaceId: string };
  story: WorkItem;
}

/** Derive the owning project key from a `MOTIR-7`-style identifier. */
function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
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
  // Auth: keyless GitHub OIDC first (MOTIR-1650) when the caller opts in via the
  // `X-Motir-Auth: github-oidc` marker; otherwise the `integration` PAT.
  let ctx: { userId: string; workspaceId: string };
  const oidc = await authenticateGithubOidc(req);
  if (oidc) {
    if (!oidc.ok) {
      return oidc.status === 401
        ? NextResponse.json({ code: 'UNAUTHENTICATED', reason: oidc.reason }, { status: 401 })
        : NextResponse.json({ code: 'FORBIDDEN', reason: oidc.reason }, { status: 403 });
    }
    ctx = { userId: oidc.userId, workspaceId: oidc.workspaceId };
  } else {
    const auth = await authenticateApiToken(req, 'integration');
    if (!auth.ok) {
      return auth.reason === 'unauthenticated'
        ? NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 })
        : NextResponse.json(
            { code: 'FORBIDDEN', error: 'The token lacks the integration scope.' },
            { status: 403 },
          );
    }
    ctx = { userId: auth.userId, workspaceId: auth.workspaceId };
  }

  let story: WorkItem | null;
  try {
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    story = await withWorkspaceContext(ctx, (tx) =>
      workItemRepository.findByIdentifier(project.id, identifier, tx),
    );
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
  if (!story) {
    return NextResponse.json(
      { code: 'WORK_ITEM_NOT_FOUND', error: `${identifier} was not found.` },
      { status: 404 },
    );
  }

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
