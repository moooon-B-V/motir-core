import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { buildScope, PROJECT_SCOPE_KEY } from '@/lib/planChange/scope';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

/**
 * Record the CONVERSATION half of a seeded planning turn (bug MOTIR-5640).
 *
 * ⚠️ WHY THE E2E SEEDS OWE THIS. A real submit does two things: it opens the
 * Plan bound to the job, AND it stamps that job onto the plan-change SESSION as
 * its `lastJobId` (`planChangeSessionsService.submit`). The seeds stood in for
 * the handler and did only the first, so the plans they produced belonged to no
 * conversation at all — a state the product cannot reach.
 *
 * That was invisible for as long as nothing read the link. It stopped being
 * invisible when a plan began PARKING its targets: a card may be planned by ONE
 * planner at a time, so a session-less seeded plan read as a SECOND planner
 * rather than as the same conversation taking its next turn. Two turns over one
 * card were refused with `PlanTargetLockedError`, and a contextual seed fought
 * the browser's own session-open on its anchor. Five at-scale E2E cases caught
 * it in the merge queue.
 *
 * ⚠️ AND IT IS BOUND, which the first draft of it was not. `db` is RLS-scoped:
 * an unbound read finds nothing and an unbound write is refused, so every tenant
 * statement here runs inside `withWorkspaceServiceContext` like the rest of the
 * codebase. The first version read `db.project` straight and got
 * `findUniqueOrThrow` on zero rows — the guard working, not a missing row.
 *
 * ONE session per `(project, scopeKey)`, and its `lastJobId` moves to the job
 * each turn starts — exactly the shape `submit` leaves behind, so a later turn
 * updates rather than forking a second conversation.
 */
export async function recordConversationTurn(
  ctx: ServiceContext,
  projectId: string,
  /** The anchor: a work-item ID when `anchorIsWorkItemId`, else a raw scope key.
   *  `null` means the project-wide thread. */
  anchor: string | null,
  jobId: string,
  opts: { anchorIsWorkItemId?: boolean } = {},
): Promise<void> {
  await withWorkspaceServiceContext(ctx.workspaceId, async (tx) => {
    let scopeKey = PROJECT_SCOPE_KEY;
    if (anchor !== null) {
      if (opts.anchorIsWorkItemId) {
        // The scope key is built from the anchor's `MOTIR-<n>` KEY, which is what
        // `buildScope` canonicalizes and what the contextual route persists.
        const item = await tx.workItem.findUniqueOrThrow({ where: { id: anchor } });
        scopeKey = buildScope([item.identifier]).scopeKey;
      } else {
        scopeKey = anchor;
      }
    }

    const existing = await tx.planChangeSession.findFirst({ where: { projectId, scopeKey } });
    if (existing) {
      await tx.planChangeSession.update({
        where: { id: existing.id },
        data: { lastJobId: jobId, lastSubmittedAt: new Date() },
      });
      return;
    }
    await tx.planChangeSession.create({
      data: {
        workspaceId: ctx.workspaceId,
        projectId,
        scopeKey,
        lastJobId: jobId,
        lastSubmittedAt: new Date(),
      },
    });
  });
}
