import { projectsService } from '@/lib/services/projectsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { buildScope, MAX_SCOPE_TARGETS, PROJECT_SCOPE } from '@/lib/planChange/scope';
import type { PlanChangeScope } from '@/lib/planChange/scope';
import { TooManyPlanChangeTargetsError } from '@/lib/planChange/errors';
import { normalizeWorkItemKey } from '@/lib/api/v1/workItems/resolveKey';
import type { ProjectContext } from '@/lib/projects';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Resolving the planning conversation's COMPOSITE ADDRESS (Story 11.7 · Subtask
// 11.7.6 — MOTIR-2240) — one place, because all three endpoints address the
// same thread the same way.
//
// ── A thread is addressed by SCOPE, never by id ─────────────────────────────
// Its identity is `(project, anchor set)` and the database says so:
// `@@unique([projectId, scopeKey])`. So the address is `projectKey` + an
// optional `targetKeys` set, and re-opening the same set RESUMES the row the web
// panel is looking at rather than forking a second conversation about the same
// items. Nothing on this resource accepts a session id.
//
// ── The canonical form comes from the SERVICE's own helper ──────────────────
// `buildScope` dedupes, upper-cases and SORTS before deriving `scopeKey`, so
// `[MOTIR-9, MOTIR-4]` and `[MOTIR-4, MOTIR-9, MOTIR-4]` are one thread. That is
// read off `lib/planChange/scope.ts` and reused rather than reimplemented: a
// client that sorts its keys and one that does not must land on the same row,
// and the only way to guarantee that is to derive the key the same way the
// service and the repository do.
//
// The MCP tool does the same job (`lib/mcp/tools/planSession.ts`) and was READ
// while writing this, not imported — v1 never reaches into the tool layer. Both
// transports align through the SHARED scope helper, which is stronger than an
// import would be.

/** A project context plus the thread's canonical scope. */
export interface ResolvedPlanScope {
  pctx: ProjectContext;
  scope: PlanChangeScope;
}

/**
 * Resolve `{ projectKey, targetKeys? }` to the project and the thread's scope.
 *
 * Each anchor key is RESOLVED through the shipped read, so a key naming no item
 * — or one in a project this token cannot see — is that read's 404 rather than a
 * thread quietly anchored at a nonexistent item. The set is bounded BEFORE the
 * round-trips, because the cost of a huge set IS the resolution fan-out.
 */
export async function resolvePlanScope(
  projectKey: string,
  targetKeys: readonly string[] | undefined,
  ctx: ServiceContext,
): Promise<ResolvedPlanScope> {
  const project = await projectsService.getByKey(projectKey, ctx);
  const pctx: ProjectContext = {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    projectId: project.id,
    project,
  };

  const requested = (targetKeys ?? []).map(normalizeWorkItemKey).filter(Boolean);
  if (requested.length === 0) return { pctx, scope: PROJECT_SCOPE };
  if (requested.length > MAX_SCOPE_TARGETS) {
    throw new TooManyPlanChangeTargetsError(requested.length, MAX_SCOPE_TARGETS);
  }

  const identifiers: string[] = [];
  for (const key of requested) {
    const item = await workItemsService.getWorkItemByIdentifier(project.id, key, ctx);
    identifiers.push(item.identifier);
  }
  return { pctx, scope: buildScope(identifiers) };
}
