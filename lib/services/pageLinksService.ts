import { withWorkspaceContext } from '@/lib/workspaces/context';
import { readWorkItem } from '@/lib/workspaces/tenantRead';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { folderRepository } from '@/lib/repositories/folderRepository';
import { pageWorkItemLinkRepository } from '@/lib/repositories/pageWorkItemLinkRepository';
import { toWorkItemPageLinkRowDto } from '@/lib/mappers/pageLinkMappers';
import {
  decodeWorkItemPagesCursor,
  encodeWorkItemPagesCursor,
  workItemPagesLimit,
} from '@/lib/pages/workItemPagesCursor';
import type { WorkItemPagesDto } from '@/lib/dto/pageLinks';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { isVisitorContext } from '@/lib/visitor/readScope';

// The work item's Pages read (Story MOTIR-7565 · MOTIR-7573) — "which pages link
// to this work item?", read from `page_work_item_link` (`docs/decisions/pages.md`
// §8.1) and rendered by the work item's Pages section.
//
// ⚠️ TWO GATES, AND ONE ANSWER FOR BOTH KINDS OF STRANGER. The work item is
// resolved under the reader's normal access, and its project's `page:view` is
// asserted. A reader who cannot see the work item — unknown id, another
// workspace, a project they may not browse — gets `WorkItemNotFoundError`, the
// answer the work item's own page gives. A browser without `page:view` gets the
// `'edit'` refusal (→ 403), naming no page.
//
// ⚠️ A VISITOR IS ANSWERED AS A STRANGER. No Visitor route serves pages, so no
// Visitor payload may name one (`docs/decisions/epic-privacy.md` §3): the read
// refuses a Visitor context with the same not-found, before any query.

export interface ListPagesForWorkItemInput {
  workItemId: string;
  cursor?: string | null;
  limit?: number | null;
}

export const pageLinksService = {
  async listPagesForWorkItem(
    ctx: ServiceContext | VisitorReadContext,
    input: ListPagesForWorkItemInput,
  ): Promise<WorkItemPagesDto> {
    if (isVisitorContext(ctx)) throw new WorkItemNotFoundError(input.workItemId);
    const after = input.cursor ? decodeWorkItemPagesCursor(input.cursor) : null;
    const limit = workItemPagesLimit(input.limit);

    const item = await readWorkItem(input.workItemId, ctx);
    if (!item || item.workspaceId !== ctx.workspaceId) {
      throw new WorkItemNotFoundError(input.workItemId);
    }

    const scope = { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: item.projectId };
    return withWorkspaceContext(scope, async (tx) => {
      try {
        await projectAccessService.assertCanViewPages(item.projectId, ctx, tx);
      } catch (err) {
        if (err instanceof ProjectAccessDeniedError && err.kind === 'browse') {
          throw new WorkItemNotFoundError(input.workItemId);
        }
        throw err;
      }

      const window = await pageWorkItemLinkRepository.listPagesForWorkItem(
        item.id,
        after,
        limit + 1,
        tx,
      );
      const served = window.slice(0, limit);

      // The places' folder chains in ONE batched read, however many pages.
      const folderIds = [
        ...new Set(served.flatMap((r) => (r.placeFolderId === null ? [] : [r.placeFolderId]))),
      ];
      const trails = await folderRepository.findTrailsByIds(folderIds, ctx.workspaceId, tx);
      const pathByFolder = new Map(trails.map((t) => [t.id, t.trail.map((step) => step.name)]));

      const last = served[served.length - 1];
      return {
        rows: served.map((r) =>
          toWorkItemPageLinkRowDto(
            r,
            r.placeFolderId === null ? [] : (pathByFolder.get(r.placeFolderId) ?? []),
          ),
        ),
        nextCursor:
          window.length > limit && last
            ? encodeWorkItemPagesCursor({ updatedAt: last.updatedAt, id: last.pageId })
            : null,
      };
    });
  },
};
