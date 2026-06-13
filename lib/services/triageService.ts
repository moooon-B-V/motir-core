import { projectRepository } from '@/lib/repositories/projectRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { TriageQueuePageDto } from '@/lib/dto/triage';
import { toTriageQueueItemDto } from '@/lib/mappers/triageMappers';
import { clampTriageLimit, decodeTriageCursor, encodeTriageCursor } from '@/lib/triage/triageQueue';

// Triage inbox — business logic (Story 6.11). Subtask 6.11.3 ships the READ
// side: the queue read, gated + paged + mapped to DTOs. The triage ACTIONS
// (accept / promote / decline / mark-duplicate-merge / snooze, 6.11.5) and the
// intake create paths (6.11.4) land their own methods here on top of the same
// `triagedAt` model. All reads/writes go through the shipped
// repositories/services (4-layer) — no raw Prisma in this layer.

export const triageService = {
  /**
   * One page of a project's ACTIVE triage queue (Subtask 6.11.3) — the inbox
   * an admin works through. Resolves + workspace-gates the project (a missing
   * or cross-workspace `projectId` → `ProjectNotFoundError`, no existence leak)
   * and asserts the actor can browse it (6.4), then reads ONLY triage items via
   * `findTriageQueue` (the single read that inverts the global triage exclusion).
   *
   * Cursor-paginated (finding #57 — the public form can flood the inbox, never
   * load-all): fetches `limit + 1` rows so `hasMore` needs no separate COUNT;
   * `nextCursor` is the opaque `(triagedAt, id)` seek-after token, or null on the
   * last page. The limit is clamped to `[1, TRIAGE_QUEUE_MAX_LIMIT]`; an invalid
   * cursor token throws `InvalidTriageCursorError` (→ 400 at the route).
   */
  async getTriageQueue(
    projectId: string,
    params: { cursor?: string; limit?: number },
    ctx: ServiceContext,
  ): Promise<TriageQueuePageDto> {
    const project = await projectRepository.findById(projectId);
    if (!project || project.workspaceId !== ctx.workspaceId) {
      throw new ProjectNotFoundError(projectId);
    }
    await projectAccessService.assertCanBrowse(projectId, ctx);

    const limit = clampTriageLimit(params.limit);
    const cursor = params.cursor ? decodeTriageCursor(params.cursor) : undefined;

    const rows = await workItemRepository.findTriageQueue(projectId, project.workspaceId, {
      limit: limit + 1,
      cursor: cursor ? { triagedAt: new Date(cursor.triagedAt), id: cursor.id } : undefined,
    });

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(toTriageQueueItemDto);
    const last = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeTriageCursor({ triagedAt: last.triagedAt!.toISOString(), id: last.id })
        : null;

    return { items, nextCursor };
  },
};
