import type { WorkItem } from '@/generated/prisma/client';
import { DESIGN_PUBLISH_PERMISSION } from '@/lib/tokens/grant';
import {
  authenticateCiPublisher,
  resolveWorkItemByIdentifier,
} from '@/lib/publishAuth/ciPublishAuth';

// Shared gate for the design-publish routes (Story MOTIR-2664 · Subtask
// MOTIR-2667): both the mint-token route and the register route authenticate the
// CI caller (keyless GitHub OIDC first, else a PAT granted
// `DESIGN_PUBLISH_PERMISSION`) and resolve
// the target work item within that caller's workspace — identically.
//
// ⚠️ It is deliberately SHORTER than the acceptance gate beside it, in two ways,
// and both are decisions rather than omissions (docs/decisions/design-result.md):
//
//   · **No parent-story hop (§3).** A design result attaches to the card that
//     PRODUCED it. Acceptance rolls a leaf key up to its story because a story
//     has exactly one end-to-end receipt; a story has MANY designs, one per
//     design subtask, so rolling up would pile unrelated surfaces onto one panel
//     and lose which card produced which. The kind check itself lives in the
//     service, where it can raise a typed domain error.
//   · **No eligibility gate (§2).** A design result is tens of kilobytes and
//     reading the design of the work you are reviewing is core project
//     management, not a paid AI feature — so there is no plan axis and no org
//     toggle to consult. The mechanical cost bounds still apply at register.

export interface DesignPublishGate {
  ctx: { userId: string; workspaceId: string };
  item: WorkItem;
}

/**
 * Authenticate + resolve a design publish. Returns the resolved `{ ctx, item }`,
 * or a ready error `Response` (401/403/404) the route returns verbatim. A hidden
 * / cross-workspace / missing item reads 404 (never 403 — finding #44).
 */
export async function authorizeDesignPublish(
  req: Request,
  identifier: string,
): Promise<DesignPublishGate | Response> {
  const ctx = await authenticateCiPublisher(req, DESIGN_PUBLISH_PERMISSION);
  if (ctx instanceof Response) return ctx;

  const item = await resolveWorkItemByIdentifier(identifier, ctx);
  if (item instanceof Response) return item;

  return { ctx, item };
}
