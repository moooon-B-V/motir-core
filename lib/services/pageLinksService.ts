import { withWorkspaceContext } from '@/lib/workspaces/context';
import { readWorkItem } from '@/lib/workspaces/tenantRead';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { folderRepository } from '@/lib/repositories/folderRepository';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { pageWorkItemLinkRepository } from '@/lib/repositories/pageWorkItemLinkRepository';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { PageArchivedError, PageNotFoundError } from '@/lib/pages';
import { PageLinkAlreadyExistsError, PageLinkNotFoundError } from '@/lib/pages/linkErrors';
import { toWorkItemPageLinkRowDto } from '@/lib/mappers/pageLinkMappers';
import {
  decodeWorkItemPagesCursor,
  encodeWorkItemPagesCursor,
  workItemPagesLimit,
} from '@/lib/pages/workItemPagesCursor';
import type { PageLinkPairDto, WorkItemPagesDto } from '@/lib/dto/pageLinks';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { Prisma } from '@/generated/prisma/client';

type Tx = Prisma.TransactionClient;
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

export interface LinkPageForWorkItemInput {
  workItemId: string;
  pageId: string;
}

// The hand link's write (Story MOTIR-7567 · MOTIR-9197) — a `manual` row of the
// pair, created and deleted from either surface through one route family. Both
// operations resolve the work item FIRST under the reader's normal access, then
// open ONE transaction bound to its project: `work_item:edit`, then `page:view`,
// then the page (a page of another project is the same not-found an unknown
// one is), then the row and the work item's revision on that same `tx`.
//
// ⚠️ THE ARCHIVE REFUSAL IS ON CREATION ONLY. Linking an archived page is
// `PAGE_ARCHIVED`; unlinking one asks no archive question at all, so a hand link
// whose page was archived since stays removable. A DELETE therefore never
// answers `PAGE_ARCHIVED` — a pair with no hand link is `PAGE_LINK_NOT_FOUND`.
//
// ⚠️ A DUPLICATE IS A WRITTEN COUNT, NOT A CAUGHT VIOLATION. `createManual`
// returns what `skipDuplicates` actually wrote; 0 is "already linked". A caught
// unique violation would abort the transaction and the revision with it.

/**
 * The resolved item and the transaction scope both write paths open. A
 * `'browse'` denial from EITHER assert is the same not-found the read gives a
 * stranger; an `'edit'` denial passes through (→ 403, naming no page).
 */
async function withHandLinkGates<T>(
  ctx: ServiceContext,
  workItemId: string,
  body: (item: { id: string; workspaceId: string; projectId: string }, tx: Tx) => Promise<T>,
): Promise<T> {
  const item = await readWorkItem(workItemId, ctx);
  if (!item || item.workspaceId !== ctx.workspaceId) throw new WorkItemNotFoundError(workItemId);

  const scope = { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: item.projectId };
  return withWorkspaceContext(scope, async (tx) => {
    try {
      await projectAccessService.assertCanEdit(item.projectId, ctx, tx);
      await projectAccessService.assertCanViewPages(item.projectId, ctx, tx);
    } catch (err) {
      if (err instanceof ProjectAccessDeniedError && err.kind === 'browse') {
        throw new WorkItemNotFoundError(workItemId);
      }
      throw err;
    }
    return body(item, tx);
  });
}

/** The page, refused as unknown unless it lives in the work item's project. */
async function findPageInProject(pageId: string, projectId: string, tx: Tx) {
  const page = await pageRepository.findById(pageId, tx);
  if (!page || page.projectId !== projectId) throw new PageNotFoundError(pageId);
  return page;
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

  /** Link a page to a work item by hand; see the header above. */
  async linkPageForWorkItem(
    ctx: ServiceContext,
    input: LinkPageForWorkItemInput,
  ): Promise<PageLinkPairDto> {
    return withHandLinkGates(ctx, input.workItemId, async (item, tx) => {
      const page = await findPageInProject(input.pageId, item.projectId, tx);
      // Creation only — the row would land in a page no surface lists.
      if (page.archivedAt !== null) throw new PageArchivedError(page.id);

      const written = await pageWorkItemLinkRepository.createManual(
        {
          workspaceId: item.workspaceId,
          projectId: item.projectId,
          pageId: page.id,
          workItemId: item.id,
          createdById: ctx.userId,
        },
        tx,
      );
      if (written === 0) throw new PageLinkAlreadyExistsError(page.id, item.id);

      await workItemRevisionsService.recordRevision(
        {
          workItemId: item.id,
          changedById: ctx.userId,
          changeKind: 'updated',
          diff: { pageLinks: { added: [{ pageId: page.id, title: page.title }] } },
        },
        tx,
      );
      return { pageId: page.id, workItemId: item.id, source: 'manual' as const };
    });
  },

  /** Remove the hand link of a pair; see the header above. */
  async unlinkPageForWorkItem(
    ctx: ServiceContext,
    input: LinkPageForWorkItemInput,
  ): Promise<PageLinkPairDto> {
    return withHandLinkGates(ctx, input.workItemId, async (item, tx) => {
      // No archive question: a link whose page was archived since stays removable.
      const page = await findPageInProject(input.pageId, item.projectId, tx);

      const removed = await pageWorkItemLinkRepository.deleteManual(page.id, item.id, tx);
      if (removed === 0) throw new PageLinkNotFoundError(page.id, item.id);

      await workItemRevisionsService.recordRevision(
        {
          workItemId: item.id,
          changedById: ctx.userId,
          changeKind: 'updated',
          diff: { pageLinks: { removed: [{ pageId: page.id, title: page.title }] } },
        },
        tx,
      );
      return { pageId: page.id, workItemId: item.id, source: 'manual' as const };
    });
  },
};
