import { withWorkspaceContext } from '@/lib/workspaces/context';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { folderRepository } from '@/lib/repositories/folderRepository';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { pageVersionRepository } from '@/lib/repositories/pageVersionRepository';
import { userRepository } from '@/lib/repositories/userRepository';
import {
  toBase64,
  toLockedPageRow,
  toPageDto,
  toPageLevelRow,
  toPageListItemDto,
  toPageMarkdownDto,
  toPageMoveResultDto,
  toPageTrailDto,
  toPageTreeFolderRowDto,
  toPageTreePageRowDto,
  toPageVersionDto,
  toPageVersionListItemDto,
  toPageVersionRow,
} from '@/lib/mappers/pageMappers';
import {
  PAGE_LEVEL_PAGE_SIZE,
  PAGE_LEVEL_PAGE_SIZE_MAX,
  PageFolderNotFoundError,
  PageLevelCursorInvalidError,
  PageNotFoundError,
  PageVersionNotFoundError,
  createPage as createPageProcedure,
  movePage as movePageProcedure,
  pageStoreFor,
  parsePlacement,
  renamePage as renamePageProcedure,
  restorePageVersion as restorePageVersionProcedure,
  savePageMarkdown as savePageMarkdownProcedure,
  savePageUpdate as savePageUpdateProcedure,
  systemClock,
  type PagePlacement,
  type PageRow,
  type PageStore,
} from '@/lib/pages';
import type {
  CreatePageFromMarkdownInput,
  CreatePageInput,
  GetPageInput,
  GetPageMarkdownInput,
  GetPageTrailInput,
  ListPageTreeLevelInput,
  GetPageVersionInput,
  ListPageVersionsInput,
  ListPagesInput,
  MovePageInput,
  PageDto,
  PageListItemDto,
  PageMarkdownDto,
  PageMoveResultDto,
  PageSummaryDto,
  PageTrailDto,
  PageTreeLevelDto,
  PageTreeRowDto,
  PageVersionDto,
  PageVersionListDto,
  RenamePageInput,
  RestorePageVersionInput,
  RestorePageVersionResultDto,
  SavePageMarkdownInput,
  SavePageResultDto,
  SavePageUpdateInput,
} from '@/lib/dto/pages';
import type { Prisma } from '@/generated/prisma/client';
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
//    parallel transactions. A MOVE takes the same project structure lock first
//    (`movePage` in the package), so a move, a create and another move
//    serialise, and a refusal anywhere rolls the whole move back. A RESTORE
//    (MOTIR-5754) reads the version and the current state under the same
//    `lockPage`, so it serialises with a save —
//    `tests/services/pagesService.history.integration.test.ts`.
//
// 4. A TREE LEVEL IS READ ONE PARENT AT A TIME, NEVER AS A PROJECT WALK
//    (`listTreeLevel`, MOTIR-7370). At the root or in a folder the level is two
//    BANDS — its child folders, then its pages — each ordered by
//    `(position, id) COLLATE "C"`; under a page it is the page band alone. ONE
//    opaque keyset cursor spans both: it names the band and the last
//    `(position, id)` served, so a page boundary never shifts when a row is
//    created or moved between two reads, and walking the level visits each row
//    exactly once.
//
// 5. HISTORY IS READ UNDER `page:view` AND RESTORED UNDER `page:edit` (§5).
//
// 6. AN AGENT READS AND WRITES MARKDOWN (§8.2, MOTIR-7409). `getPageMarkdown`
//    serves the derived `body_markdown` column and never the Yjs bytes; the
//    markdown writes run the package's `savePageMarkdown`, which decides
//    staleness under the page lock — the `PAGE_REVISION_CONFLICT` refusal passes
//    through this file untouched, like every other content refusal.

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

/** The level-read cursor's decoded form: which band, and the last row served in it. */
interface LevelCursor {
  band: 'folder' | 'page';
  position: string;
  id: string;
}

/** Encode a level cursor — opaque base64url of the band and the `(position, id)` seek key. */
function encodeLevelCursor(cursor: LevelCursor): string {
  return Buffer.from(JSON.stringify([cursor.band, cursor.position, cursor.id])).toString(
    'base64url',
  );
}

/** Decode a level cursor, refusing anything this service did not issue. */
function decodeLevelCursor(raw: string): LevelCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new PageLevelCursorInvalidError();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    (parsed[0] !== 'folder' && parsed[0] !== 'page') ||
    typeof parsed[1] !== 'string' ||
    typeof parsed[2] !== 'string' ||
    parsed[1] === '' ||
    parsed[2] === ''
  ) {
    throw new PageLevelCursorInvalidError();
  }
  return { band: parsed[0], position: parsed[1], id: parsed[2] };
}

/** Rows per level read: the default when unset, held to `[1, PAGE_LEVEL_PAGE_SIZE_MAX]`. */
function clampLevelLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return PAGE_LEVEL_PAGE_SIZE;
  return Math.min(Math.max(1, Math.floor(limit)), PAGE_LEVEL_PAGE_SIZE_MAX);
}

/**
 * Refuse a level parent that is not in `projectId` — a folder as the package's
 * `PageFolderNotFoundError`, a page as `PageNotFoundError` — so reading a level
 * cannot confirm that a folder or page exists in another project.
 */
async function assertLevelParent(
  projectId: string,
  parent: PagePlacement,
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (parent.kind === 'folder') {
    const folder = await folderRepository.findById(parent.folderId, tx);
    if (!folder || folder.projectId !== projectId) {
      throw new PageFolderNotFoundError(parent.folderId);
    }
  } else if (parent.kind === 'page') {
    const page = await pageRepository.findById(parent.pageId, tx);
    if (!page || page.projectId !== projectId) throw new PageNotFoundError(parent.pageId);
  }
}

/**
 * The page as an agent reads it, inside the caller's transaction: the markdown
 * row, its newest version, and that version's author named in ONE batch read.
 * `null` when the page is absent, invisible or in another project.
 */
async function readPageMarkdown(
  projectId: string,
  pageId: string,
  tx: Prisma.TransactionClient,
): Promise<PageMarkdownDto | null> {
  const record = await pageRepository.findWithMarkdownById(pageId, tx);
  if (!record || record.projectId !== projectId) return null;
  const latest = await pageVersionRepository.findLatest(pageId, tx);
  const authors = latest ? await userRepository.findByIds([latest.authorId], tx) : [];
  return toPageMarkdownDto(record, latest, authors[0]?.name);
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
  /**
   * Create an empty page, LAST under its parent — the project root (the
   * default), a folder or a page. `page:edit`. The parent is parsed by the
   * package (`parsePlacement`), so a work item or any other kind is refused as
   * `PAGE_PARENT_NOT_ALLOWED`; a parent missing, in another project or too deep
   * is refused by the package's create before anything is written.
   */
  async createPage(ctx: ServiceContext, input: CreatePageInput): Promise<PageSummaryDto> {
    const parent = parsePlacement(input.parent ?? { kind: 'root' });
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanEditPages(input.projectId, ctx, tx);
      const row = await createPageProcedure(pageStoreFor(tx), systemClock, {
        workspaceId: ctx.workspaceId,
        projectId: input.projectId,
        actorId: ctx.userId,
        title: input.title,
        parent,
      });
      return toSummary(row);
    });
  },

  /**
   * Move a page — re-parent it, reorder it among its siblings, or both — with
   * its whole subtree, in ONE transaction. `page:edit`. The package's `movePage`
   * takes the project's structure lock, checks the cycle, depth, cross-project
   * and neighbour rules, writes the page and rewrites every descendant's
   * ancestors; any refusal rolls all of it back. Returns where the page now sits.
   */
  async movePage(ctx: ServiceContext, input: MovePageInput): Promise<PageMoveResultDto> {
    const parent = parsePlacement(input.parent);
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanEditPages(input.projectId, ctx, tx);
      const { page, moved } = await movePageProcedure(pageStoreFor(tx), {
        pageId: input.pageId,
        projectId: input.projectId,
        parent,
        beforeId: input.beforeId ?? null,
        afterId: input.afterId ?? null,
        actorId: ctx.userId,
      });
      return toPageMoveResultDto(page, moved);
    });
  },

  /**
   * One read of a `/pages` tree level. `page:view`. At the root or in a folder:
   * the level's child FOLDERS, then its PAGES; under a page: its sub-pages only.
   * Keyset-paged across both bands by one opaque cursor (contract 4 above);
   * `limit` defaults to `PAGE_LEVEL_PAGE_SIZE` and is capped at
   * `PAGE_LEVEL_PAGE_SIZE_MAX`. A folder or page parent outside the project is
   * refused as not found.
   */
  async listTreeLevel(
    ctx: ServiceContext,
    input: ListPageTreeLevelInput,
  ): Promise<PageTreeLevelDto> {
    const parent = parsePlacement(input.parent);
    const limit = clampLevelLimit(input.limit);
    const cursor = input.cursor ? decodeLevelCursor(input.cursor) : null;
    const hasFolderBand = parent.kind !== 'page';
    if (cursor?.band === 'folder' && !hasFolderBand) throw new PageLevelCursorInvalidError();

    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      await assertLevelParent(input.projectId, parent, tx);

      const rows: PageTreeRowDto[] = [];
      let lastFolder: LevelCursor | null = null;

      // Band 1 — the folders. Skipped under a page, and once the cursor is past it.
      if (hasFolderBand && (cursor === null || cursor.band === 'folder')) {
        const folders = await folderRepository.findLevelForPages(
          input.projectId,
          parent.kind === 'folder' ? parent.folderId : null,
          cursor,
          limit + 1,
          tx,
        );
        const served = folders.slice(0, limit);
        rows.push(...served.map(toPageTreeFolderRowDto));
        const last = served[served.length - 1];
        if (last) lastFolder = { band: 'folder', position: last.position, id: last.id };
        if (folders.length > limit) {
          return { rows, nextCursor: encodeLevelCursor(lastFolder!) };
        }
      }

      // Band 2 — the pages, from the start or after the cursor's page. Read one
      // more than the room left, to learn whether anything follows.
      const room = limit - rows.length;
      const pages = (
        await pageRepository.findLevelAfter(
          input.projectId,
          parent,
          cursor?.band === 'page' ? cursor : null,
          room + 1,
          tx,
        )
      ).map(toPageLevelRow);
      const served = pages.slice(0, room);
      rows.push(...served.map(toPageTreePageRowDto));
      if (pages.length <= room) return { rows, nextCursor: null };
      const last = served[served.length - 1];
      // A full folder band with pages still to come: the next read resumes after
      // the last folder, finds the folder band spent, and starts the pages.
      const next: LevelCursor = last
        ? { band: 'page', position: last.position, id: last.id }
        : lastFolder!;
      return { rows, nextCursor: encodeLevelCursor(next) };
    });
  },

  /**
   * A page's breadcrumb trail, root-first, the page itself excluded. `page:view`.
   * The folders are the chain its TOPMOST page is filed in (a sub-page carries no
   * folder — it follows its top page), read as `foldersService.getFolderTrail`
   * reads it; the pages are its `ancestorPageIds`, named in one batch read.
   */
  async getPageTrail(ctx: ServiceContext, input: GetPageTrailInput): Promise<PageTrailDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      const page = await pageRepository.findById(input.pageId, tx);
      if (!page || page.projectId !== input.projectId) throw new PageNotFoundError(input.pageId);

      const ancestorIds = page.ancestorPageIds;
      const named = await pageRepository.findTrailByIds(ancestorIds, tx);
      const byId = new Map(named.map((p) => [p.id, p]));
      const pages = ancestorIds.flatMap((id) => {
        const row = byId.get(id);
        return row ? [{ id: row.id, title: row.title }] : [];
      });

      const topFolderId =
        ancestorIds.length === 0 ? page.folderId : (byId.get(ancestorIds[0]!)?.folderId ?? null);
      const folders: Array<{ id: string; name: string }> = [];
      if (topFolderId !== null) {
        const ids = await folderRepository.findAncestorIds(topFolderId, tx);
        const folderById = new Map(
          (await folderRepository.findByIds(ids, tx)).map((f) => [f.id, f]),
        );
        let at: string | null = topFolderId;
        while (at !== null && folders.length <= ids.length) {
          const row = folderById.get(at);
          if (!row) break;
          folders.push({ id: row.id, name: row.name });
          at = row.parentFolderId;
        }
        folders.reverse();
      }
      return toPageTrailDto(folders, pages);
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
   * display name — the `/pages` index (MOTIR-7300). `page:view`. Flat, and KEPT
   * beside {@link listTreeLevel} for its callers (the `/pages` index page) until
   * the tree replaces it there. Two reads in the one transaction: the pages (no body
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

  /**
   * A page as an AGENT reads it — title, placement, revision, newest version and
   * body as markdown (§8.2). `page:view`. No row lock, so it never waits on a save.
   */
  async getPageMarkdown(
    ctx: ServiceContext,
    input: GetPageMarkdownInput,
  ): Promise<PageMarkdownDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanViewPages(input.projectId, ctx, tx);
      const page = await readPageMarkdown(input.projectId, input.pageId, tx);
      if (!page) throw new PageNotFoundError(input.pageId);
      return page;
    });
  },

  /**
   * Replace a page's body with markdown, stating the revision the caller read —
   * `page:edit`. The package refuses a stale revision with
   * `PageRevisionConflictError` (409) and writes nothing; otherwise the page is
   * read back in the same transaction.
   */
  async savePageMarkdown(
    ctx: ServiceContext,
    input: SavePageMarkdownInput,
  ): Promise<PageMarkdownDto> {
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanEditPages(input.projectId, ctx, tx);
      const store = pageStoreFor(tx);
      await findInProject(store, input.projectId, input.pageId);
      await savePageMarkdownProcedure(store, systemClock, {
        pageId: input.pageId,
        actorId: ctx.userId,
        markdown: input.markdown,
        expectedRevision: input.expectedRevision,
      });
      return (await readPageMarkdown(input.projectId, input.pageId, tx))!;
    });
  },

  /**
   * Create a page under a parent and, when `markdown` is given, write its body —
   * in ONE transaction, so the page never exists without the body it was created
   * with. `page:edit`. The body save states the new row's revision, and being the
   * same author inside the coalescing window it extends version 1 rather than
   * starting version 2 (§6). A refused parent or body rolls the page back.
   */
  async createPageFromMarkdown(
    ctx: ServiceContext,
    input: CreatePageFromMarkdownInput,
  ): Promise<PageMarkdownDto> {
    const parent = parsePlacement(input.parent ?? { kind: 'root' });
    return withWorkspaceContext(scopeTo(ctx, input.projectId), async (tx) => {
      await projectAccessService.assertCanEditPages(input.projectId, ctx, tx);
      const store = pageStoreFor(tx);
      const row = await createPageProcedure(store, systemClock, {
        workspaceId: ctx.workspaceId,
        projectId: input.projectId,
        actorId: ctx.userId,
        title: input.title,
        parent,
      });
      if (input.markdown) {
        await savePageMarkdownProcedure(store, systemClock, {
          pageId: row.id,
          actorId: ctx.userId,
          markdown: input.markdown,
          expectedRevision: row.revision,
        });
      }
      return (await readPageMarkdown(input.projectId, row.id, tx))!;
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
