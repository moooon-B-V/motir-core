import { withWorkspaceContext } from '@/lib/workspaces/context';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { pageVersionRepository } from '@/lib/repositories/pageVersionRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import {
  toBase64,
  toLockedPageRow,
  toPageDto,
  toPageListItemDto,
  toPageVersionDto,
  toPageVersionListItemDto,
  toPageVersionRow,
} from '@/lib/mappers/pageMappers';
import {
  PAGE_LEVEL_PAGE_SIZE,
  PAGE_LEVEL_PAGE_SIZE_MAX,
  PageNotFoundError,
  PageVersionNotFoundError,
  createPage as createPageProcedure,
  pageStoreFor,
  renamePage as renamePageProcedure,
  restorePageVersion as restorePageVersionProcedure,
  savePageUpdate as savePageUpdateProcedure,
  systemClock,
  type PageRow,
  type PageStore,
} from '@/lib/pages';
import type {
  CreatePageInput,
  GetPageInput,
  GetPageVersionInput,
  ListPageVersionsInput,
  ListPagesInput,
  PageDto,
  PageListItemDto,
  PageSummaryDto,
  PageVersionDto,
  PageVersionListDto,
  RenamePageInput,
  RestorePageVersionInput,
  RestorePageVersionResultDto,
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
//    parallel transactions. A RESTORE (MOTIR-5754) is the third: it reads the
//    version and the current state under the same `lockPage`, so it serialises
//    with a save — `tests/services/pagesService.history.integration.test.ts`.
//
// 4. HISTORY IS READ UNDER `page:view` AND RESTORED UNDER `page:edit` (§5).

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

  /**
   * The project's pages, most recently edited first, each with its last editor's
   * display name — the `/pages` index (MOTIR-7300). `page:view`. Flat: the tree
   * is MOTIR-5753's. Two reads in the one transaction: the pages (no body
   * columns), then the editors' names in one batch, never one per row.
   */
  async listPages(ctx: ServiceContext, input: ListPagesInput): Promise<PageListItemDto[]> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      const records = await pageRepository.listByProject(input.projectId, tx);
      const editorIds = [...new Set(records.map((r) => r.updatedById))];
      const editors = await userRepository.findByIds(editorIds, tx);
      const nameById = new Map(editors.map((u) => [u.id, u.name]));
      return records.map((r) => toPageListItemDto(r, nameById.get(r.updatedById)));
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

  /**
   * One page of a page's history, newest first, each with its author's display
   * name — `page:view`. Keyset-paged on the version number (`before`), 50 by
   * default and 100 at most. Three reads in one transaction: the newest number
   * (for `isCurrent`), the rows (no snapshots), then the authors in ONE batch.
   */
  async listPageVersions(
    ctx: ServiceContext,
    input: ListPageVersionsInput,
  ): Promise<PageVersionListDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      await findInProject(pageStoreFor(tx), input.projectId, input.pageId);
      const limit = Math.min(
        Math.max(1, Math.trunc(input.limit ?? PAGE_LEVEL_PAGE_SIZE)),
        PAGE_LEVEL_PAGE_SIZE_MAX,
      );
      const latest = await pageVersionRepository.findLatest(input.pageId, tx);
      // One extra row says whether another page follows, without a count.
      const records = await pageVersionRepository.listByPage(
        input.pageId,
        { beforeNumber: input.before, limit: limit + 1 },
        tx,
      );
      const rows = records.slice(0, limit).map(toPageVersionRow);
      const authors = await userRepository.findByIds([...new Set(rows.map((r) => r.authorId))], tx);
      const nameById = new Map(authors.map((u) => [u.id, u.name]));
      return {
        items: rows.map((r) =>
          toPageVersionListItemDto(r, nameById.get(r.authorId), r.number === latest?.number),
        ),
        nextBefore: records.length > limit ? rows.at(-1)!.number : null,
      };
    });
  },

  /** One version with its snapshot — `page:view`. An unknown number is `PageVersionNotFoundError`. */
  async getPageVersion(ctx: ServiceContext, input: GetPageVersionInput): Promise<PageVersionDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      const store = pageStoreFor(tx);
      await findInProject(store, input.projectId, input.pageId);
      const version = await store.findVersion(input.pageId, input.number);
      if (!version) throw new PageVersionNotFoundError(input.pageId, input.number);
      const latest = await store.latestVersion(input.pageId);
      const [author] = await userRepository.findByIds([version.authorId], tx);
      return toPageVersionDto(version, author?.name, version.number === latest?.number);
    });
  },

  /**
   * Make version `number` the page's current content as a NEW version —
   * `page:edit`. Runs the package's procedure under the page's lock, and returns
   * the new state so an open editor re-seeds from it without a second read.
   */
  async restorePageVersion(
    ctx: ServiceContext,
    input: RestorePageVersionInput,
  ): Promise<RestorePageVersionResultDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanEditPages(input.projectId, ctx, tx);
      const store = pageStoreFor(tx);
      await findInProject(store, input.projectId, input.pageId);
      const result = await restorePageVersionProcedure(store, systemClock, {
        pageId: input.pageId,
        number: input.number,
        actorId: ctx.userId,
      });
      const page = await store.lockPage(input.pageId);
      const [author] = await userRepository.findByIds([ctx.userId], tx);
      return {
        revision: result.revision,
        version: toPageVersionListItemDto(result.version, author?.name, true),
        bodyState: toBase64(page!.bodyState),
      };
    });
  },
};
