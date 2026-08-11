import { NextResponse } from 'next/server';
import type { WorkItem } from '@/generated/prisma/client';
import { authenticateApiToken } from '@/lib/apiTokens/routeAuth';
import type { PermissionKey } from '@/lib/permissions/catalog';
import { authenticateGithubOidc } from '@/lib/github/oidcAuth';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { projectsService } from '@/lib/services/projectsService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { ProjectNotFoundError } from '@/lib/projects/errors';

// The CI-publish gate shared by every artifact class a trusted CI job publishes
// onto a work item (Story MOTIR-2664 · Subtask MOTIR-2667). Extracted from
// `lib/acceptanceEvidence/publishAuth.ts` when the design result became the
// SECOND publisher: a second copy of a keyless-identity verification is the kind
// of duplication where one copy quietly gets a fix and the other does not.
//
// What is genuinely shared: authenticating the caller (keyless GitHub OIDC
// first, else a PAT) and resolving the target work item inside that caller's
// workspace. What is NOT shared, and stays with each publisher:
//   · acceptance resolves a leaf key UP to its parent STORY and applies the
//     plan/toggle eligibility gate;
//   · a design result attaches to the card that PRODUCED it, with no
//     eligibility axis at all (docs/decisions/design-result.md §2, §3).

export interface CiPublisherContext {
  userId: string;
  workspaceId: string;
}

/** Derive the owning project key from a `MOTIR-7`-style identifier. */
export function projectKeyOf(identifier: string): string {
  const dash = identifier.lastIndexOf('-');
  return dash > 0 ? identifier.slice(0, dash) : identifier;
}

/**
 * Authenticate a CI publisher: keyless GitHub OIDC first (MOTIR-1650) when the
 * caller opts in via the `X-Motir-Auth: github-oidc` marker; otherwise a PAT
 * whose GRANT contains `requiredPermission`. Returns the resolved workspace
 * context, or a ready error `Response` (401/403) the route returns verbatim.
 *
 * ⚠️ The permission is a PARAMETER, not a constant baked in here. A token used
 * to be checked for the `'integration'` SCOPE; MOTIR-2576 replaced that with the
 * permission the operation actually asserts, precisely because the publish route
 * is the one token-reachable caller that is neither MCP nor `/api/v1` and so is
 * the one a scope migration leaves behind — with every publish 403ing. Threading
 * it through means a second publisher asks for its own and neither silently
 * inherits the other's.
 */
export async function authenticateCiPublisher(
  req: Request,
  requiredPermission: PermissionKey,
): Promise<CiPublisherContext | Response> {
  const oidc = await authenticateGithubOidc(req);
  if (oidc) {
    if (!oidc.ok) {
      return oidc.status === 401
        ? NextResponse.json({ code: 'UNAUTHENTICATED', reason: oidc.reason }, { status: 401 })
        : NextResponse.json({ code: 'FORBIDDEN', reason: oidc.reason }, { status: 403 });
    }
    return { userId: oidc.userId, workspaceId: oidc.workspaceId };
  }

  const auth = await authenticateApiToken(req, requiredPermission);
  if (!auth.ok) {
    return auth.reason === 'unauthenticated'
      ? NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 })
      : NextResponse.json(
          {
            code: 'FORBIDDEN',
            error: `The token is not granted the "${requiredPermission}" permission.`,
          },
          { status: 403 },
        );
  }
  return { userId: auth.userId, workspaceId: auth.workspaceId };
}

/**
 * Resolve a `MOTIR-7`-style identifier to a work item inside the caller's
 * workspace. A hidden / cross-workspace / missing item reads **404, never 403**
 * (finding #44 — "you can't see it" is indistinguishable from "it doesn't
 * exist"). Returns the item, or a ready 404 `Response`.
 */
export async function resolveWorkItemByIdentifier(
  identifier: string,
  ctx: CiPublisherContext,
): Promise<WorkItem | Response> {
  let item: WorkItem | null;
  try {
    const project = await projectsService.getByKey(projectKeyOf(identifier), ctx);
    item = await withWorkspaceContext(ctx, (tx) =>
      workItemRepository.findByIdentifier(project.id, identifier, tx),
    );
  } catch (err) {
    if (err instanceof ProjectNotFoundError) {
      return NextResponse.json({ code: err.code, error: err.message }, { status: 404 });
    }
    throw err;
  }
  if (!item) {
    return NextResponse.json(
      { code: 'WORK_ITEM_NOT_FOUND', error: `${identifier} was not found.` },
      { status: 404 },
    );
  }
  return item;
}
