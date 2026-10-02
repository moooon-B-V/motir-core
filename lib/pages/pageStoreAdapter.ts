import type { Prisma } from '@/generated/prisma/client';
import type { PagePlacement, PageStore } from '@motir/pages';
import {
  toLockedPageRow,
  toPageRow,
  toPageVersionRow,
  toPageVersionWithBody,
} from '@/lib/mappers/pageMappers';
import { pageRepository } from '@/lib/repositories/pageRepository';
import { pageVersionRepository } from '@/lib/repositories/pageVersionRepository';

// The `PageStore` ADAPTER (Story MOTIR-5752 · MOTIR-7276), `docs/decisions/pages.md`
// §2: the package's port bound to ONE open transaction over `pageRepository`.
// It maps and nothing else — every query is the repository's, every rule is the
// package's, and the transaction is the page service's.

/** This story creates pages at the project root only; the tree story places them. */
function requireRoot(parent: PagePlacement): void {
  if (parent.kind !== 'root') {
    throw new Error(
      `PageStore: placing a page under a ${parent.kind} arrives with the page tree (MOTIR-5753)`,
    );
  }
}

/** A `PageStore` whose every call runs inside `tx`. */
export function createPageStore(tx: Prisma.TransactionClient): PageStore {
  return {
    async lockPage(pageId) {
      const record = await pageRepository.lockById(pageId, tx);
      return record ? toLockedPageRow(record) : null;
    },

    async findPage(pageId) {
      const record = await pageRepository.findById(pageId, tx);
      return record ? toPageRow(record) : null;
    },

    async lockSiblings(projectId, parent) {
      requireRoot(parent);
      await pageRepository.lockRootSiblings(projectId, tx);
    },

    async lastSiblingPosition(projectId, parent) {
      requireRoot(parent);
      return pageRepository.lastRootPosition(projectId, tx);
    },

    async insertPage(row) {
      const record = await pageRepository.insert(
        {
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          title: row.title,
          parentPageId: row.parentPageId,
          folderId: row.folderId,
          position: row.position,
          ancestorPageIds: [...row.ancestorPageIds],
          bodyState: new Uint8Array(row.body.state),
          bodyJson: row.body.json as Prisma.InputJsonValue,
          bodyMarkdown: row.body.markdown,
          bodyText: row.body.text,
          revision: row.body.revision,
          createdById: row.createdById,
          updatedById: row.body.updatedById,
          createdAt: row.createdAt,
          updatedAt: row.body.updatedAt,
        },
        tx,
      );
      return toPageRow(record);
    },

    async updateBody(pageId, body) {
      await pageRepository.updateBody(
        pageId,
        {
          bodyState: new Uint8Array(body.state),
          bodyJson: body.json as Prisma.InputJsonValue,
          bodyMarkdown: body.markdown,
          bodyText: body.text,
          revision: body.revision,
          updatedById: body.updatedById,
          updatedAt: body.updatedAt,
        },
        tx,
      );
    },

    async updateTitle(pageId, title, updatedById) {
      const record = await pageRepository.updateTitle(pageId, title, updatedById, tx);
      return record ? toPageRow(record) : null;
    },

    // ── Versions (Story MOTIR-5754 · MOTIR-7384) — `page_version`, same `tx`. ──

    async latestVersion(pageId) {
      const record = await pageVersionRepository.findLatest(pageId, tx);
      return record ? toPageVersionRow(record) : null;
    },

    async insertVersion(row) {
      const record = await pageVersionRepository.insert(
        {
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          pageId: row.pageId,
          number: row.number,
          authorId: row.authorId,
          bodyState: new Uint8Array(row.bodyState),
          bodyMarkdown: row.bodyMarkdown,
          startedAt: row.startedAt,
          savedAt: row.savedAt,
          restoredFromVersionId: row.restoredFromVersionId,
          restoredFromNumber: row.restoredFromNumber,
        },
        tx,
      );
      return toPageVersionRow(record);
    },

    async updateVersion(versionId, row) {
      await pageVersionRepository.update(
        versionId,
        {
          bodyState: new Uint8Array(row.bodyState),
          bodyMarkdown: row.bodyMarkdown,
          savedAt: row.savedAt,
        },
        tx,
      );
    },

    async findVersion(pageId, number) {
      const record = await pageVersionRepository.findByPageAndNumber(pageId, number, tx);
      return record ? toPageVersionWithBody(record) : null;
    },

    async countVersions(pageId) {
      return pageVersionRepository.countByPage(pageId, tx);
    },

    async deleteOldestVersions(pageId, keep) {
      await pageVersionRepository.deleteOldest(pageId, keep, tx);
    },

    // ADR §2: "a no-op adapter until then" — the derived link rows are the
    // linking epic's (MOTIR-5747), which replaces this body with its writer.
    async replaceDerivedLinks() {},
  };
}
