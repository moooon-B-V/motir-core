import { withWorkspaceContext } from '@/lib/workspaces/context';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { toLockedPageRow, toPageDto } from '@/lib/mappers/pageMappers';
import {
  PageNotFoundError,
  createPage as createPageProcedure,
  pageStoreFor,
  renamePage as renamePageProcedure,
  savePageUpdate as savePageUpdateProcedure,
  systemClock,
  type PageRow,
  type PageStore,
} from '@/lib/pages';
import type {
  CreatePageInput,
  GetPageInput,
  PageDto,
  PageSummaryDto,
  RenamePageInput,
  SavePageResultDto,
  SavePageUpdateInput,
} from '@/lib/dto/pages';
import type { ServiceContext } from '@/lib/workItems/serviceContext';

// Page service (Story MOTIR-5752 · MOTIR-7277) — who may create, read, rename and
// save a project's pages, and the transaction each of those runs in. No route
// and no Server Action lives here (CLAUDE.md's 4-layer contract).
//
// ── THE CONTRACTS THIS FILE HOLDS ─────────────────────────────────────────
//
// 1. THE SERVICE DECIDES ACCESS; THE PACKAGE DECIDES CONTENT. Every method opens
//    ONE `withWorkspaceContext` transaction, asserts its key FIRST, then runs
//    `@motir/pages`' procedure over `pageStoreFor(tx)`. Every refusal the
//    package raises (`PageBodyTooLargeError`, `PageTitleTooLongError`,
//    `PageNotFoundError`) passes through unchanged for the routes to map.
//
// 2. A PAGE IN ANOTHER PROJECT IS AN UNKNOWN PAGE. The caller names the project
//    it was granted on; a page id from a different project raises the package's
//    own `PageNotFoundError`, so the two are indistinguishable — the gate on
//    project A must never confirm a page exists in project B.
//
// 3. BOTH WRITES THAT READ BEFORE THEY WRITE ARE SERIALISED IN THE PACKAGE. A
//    save merges onto the state it read under `lockPage` (`FOR UPDATE`), and a
//    create mints its position after `lockSiblings`. That is why two concurrent
//    saves both land and two concurrent creates take distinct positions —
//    `tests/services/pagesService.integration.test.ts` proves it with real
//    parallel transactions.

/** The page, refused as unknown unless it lives in `projectId`. */
async function findInProject(store: PageStore, projectId: string, pageId: string) {
  const row = await store.findPage(pageId);
  if (!row || row.projectId !== projectId) throw new PageNotFoundError(pageId);
  return row;
}

/**
 * The transaction's context, bound to the project the call names. `page` carries
 * a project-narrowing policy (`page_project_narrow`), so a context still bound to
 * a DIFFERENT active project would make an insert there a raw RLS violation
 * rather than a decision this service made. The gate still reads the caller's
 * own `ctx` — a token's project binding is enforced there, not bypassed here.
 */
function scopeTo(ctx: ServiceContext, projectId: string) {
  return { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId };
}

function toSummary(row: PageRow): PageSummaryDto {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    position: row.position,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const pagesService = {
  /** Create an empty page, last at the project's root. `page:edit`. */
  async createPage(ctx: ServiceContext, input: CreatePageInput): Promise<PageSummaryDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanEditPages(input.projectId, ctx, tx);
      const row = await createPageProcedure(pageStoreFor(tx), systemClock, {
        workspaceId: ctx.workspaceId,
        projectId: input.projectId,
        actorId: ctx.userId,
        title: input.title,
      });
      return toSummary(row);
    });
  },

  /**
   * Read one page with its canonical state, and whether the caller may write it.
   * `page:view`. The read takes no row lock, so it never waits on a save.
   */
  async getPage(ctx: ServiceContext, input: GetPageInput): Promise<PageDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      const record = await pageRepository.findWithBodyById(input.pageId, tx);
      if (!record || record.projectId !== input.projectId) {
        throw new PageNotFoundError(input.pageId);
      }
      const { canEditPages } = await projectAccessService.getPageCapabilities(
        input.projectId,
        ctx,
        tx,
      );
      return toPageDto(toLockedPageRow(record), canEditPages);
    });
  },

  /** Rename a page. `page:edit`. */
  async renamePage(ctx: ServiceContext, input: RenamePageInput): Promise<PageSummaryDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanEditPages(input.projectId, ctx, tx);
      const store = pageStoreFor(tx);
      await findInProject(store, input.projectId, input.pageId);
      const row = await renamePageProcedure(store, {
        pageId: input.pageId,
        actorId: ctx.userId,
        title: input.title,
      });
      return toSummary(row);
    });
  },

  /** Merge one Yjs update into a page's state. `page:edit`. Returns the new revision. */
  async savePageUpdate(
    ctx: ServiceContext,
    input: SavePageUpdateInput,
  ): Promise<SavePageResultDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanEditPages(input.projectId, ctx, tx);
      const store = pageStoreFor(tx);
      await findInProject(store, input.projectId, input.pageId);
      const revision = await savePageUpdateProcedure(store, systemClock, {
        pageId: input.pageId,
        actorId: ctx.userId,
        update: input.update,
      });
      return { revision };
    });
  },
};
