import {
  rebaseAncestorIds,
  type Clock,
  type DerivedPageLink,
  type FolderRef,
  type NeighbourPositions,
  type PagePlacementWrite,
  type SubtreePage,
  type LockedPageRow,
  type PageBodyWrite,
  type PageInsert,
  type PagePlacement,
  type PageRow,
  type PageStore,
  type PageVersionInsert,
  type PageVersionRow,
  type PageVersionUpdate,
  type PageVersionWithBody,
} from '../../src';

/** A stored page in the fake: the row plus its body columns. */
export interface MemoryPage extends LockedPageRow {
  readonly bodyJson: unknown;
  readonly bodyMarkdown: string;
  readonly bodyText: string;
}

const sameParent = (page: PageRow, parent: PagePlacement): boolean =>
  parent.kind === 'root'
    ? page.parentPageId === null && page.folderId === null
    : parent.kind === 'folder'
      ? page.folderId === parent.folderId
      : page.parentPageId === parent.pageId;

/**
 * An in-memory `PageStore` that records every call, so a test can assert what a
 * procedure did NOT reach as well as what it wrote.
 */
export class MemoryPageStore implements PageStore {
  readonly pages = new Map<string, MemoryPage>();
  readonly folders = new Map<string, FolderRef>();
  /** Every stored version, in insertion order, across pages. */
  versions: PageVersionWithBody[] = [];
  readonly calls: { method: keyof PageStore; args: unknown[] }[] = [];
  private nextId = 0;

  called(method: keyof PageStore): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  private record(method: keyof PageStore, ...args: unknown[]): void {
    this.calls.push({ method, args });
  }

  async lockPage(pageId: string): Promise<LockedPageRow | null> {
    this.record('lockPage', pageId);
    return this.pages.get(pageId) ?? null;
  }

  async findPage(pageId: string): Promise<PageRow | null> {
    this.record('findPage', pageId);
    return this.pages.get(pageId) ?? null;
  }

  async lockSiblings(projectId: string, parent: PagePlacement): Promise<void> {
    this.record('lockSiblings', projectId, parent);
  }

  async lastSiblingPosition(projectId: string, parent: PagePlacement): Promise<string | null> {
    this.record('lastSiblingPosition', projectId, parent);
    const positions = [...this.pages.values()]
      .filter((page) => page.projectId === projectId && sameParent(page, parent))
      .map((page) => page.position)
      .sort();
    return positions.at(-1) ?? null;
  }

  /** Adds a folder a placement can name. */
  addFolder(id: string, projectId: string): FolderRef {
    const folder = { id, projectId };
    this.folders.set(id, folder);
    return folder;
  }

  /** One level's pages in `(position, id)` order. */
  level(projectId: string, parent: PagePlacement): MemoryPage[] {
    return [...this.pages.values()]
      .filter((page) => page.projectId === projectId && sameParent(page, parent))
      .sort((a, b) =>
        a.position !== b.position ? (a.position < b.position ? -1 : 1) : a.id < b.id ? -1 : 1,
      );
  }

  async findFolder(folderId: string): Promise<FolderRef | null> {
    this.record('findFolder', folderId);
    return this.folders.get(folderId) ?? null;
  }

  async findSubtree(pageId: string): Promise<SubtreePage[]> {
    this.record('findSubtree', pageId);
    return [...this.pages.values()]
      .filter((page) => page.ancestorPageIds.includes(pageId))
      .map((page) => ({ id: page.id, ancestorPageIds: page.ancestorPageIds }));
  }

  async siblingNeighbours(
    projectId: string,
    parent: PagePlacement,
    beforeId: string | null,
    afterId: string | null,
  ): Promise<NeighbourPositions> {
    this.record('siblingNeighbours', projectId, parent, beforeId, afterId);
    const level = this.level(projectId, parent);
    const at = (id: string) => level.findIndex((page) => page.id === id);
    if (beforeId !== null && afterId !== null) {
      return { before: level[at(beforeId)]!.position, after: level[at(afterId)]!.position };
    }
    if (beforeId !== null) {
      const i = at(beforeId);
      return { before: level[i]!.position, after: level[i + 1]?.position ?? null };
    }
    if (afterId !== null) {
      const i = at(afterId);
      return { before: level[i - 1]?.position ?? null, after: level[i]!.position };
    }
    return { before: level.at(-1)?.position ?? null, after: null };
  }

  async updatePlacement(
    pageId: string,
    placement: PagePlacementWrite,
    updatedById: string,
  ): Promise<PageRow> {
    this.record('updatePlacement', pageId, placement, updatedById);
    const page = this.pages.get(pageId)!;
    const moved = { ...page, ...placement, updatedById };
    this.pages.set(pageId, moved);
    return moved;
  }

  async rebaseDescendants(pageId: string, newAncestorPageIds: readonly string[]): Promise<void> {
    this.record('rebaseDescendants', pageId, newAncestorPageIds);
    for (const page of [...this.pages.values()]) {
      if (!page.ancestorPageIds.includes(pageId)) continue;
      this.pages.set(page.id, {
        ...page,
        ancestorPageIds: rebaseAncestorIds(page.ancestorPageIds, pageId, newAncestorPageIds),
      });
    }
  }

  async insertPage(row: PageInsert): Promise<PageRow> {
    this.record('insertPage', row);
    this.nextId += 1;
    const page: MemoryPage = {
      id: `page-${this.nextId}`,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      title: row.title,
      parentPageId: row.parentPageId,
      folderId: row.folderId,
      position: row.position,
      ancestorPageIds: row.ancestorPageIds,
      revision: row.body.revision,
      createdById: row.createdById,
      updatedById: row.body.updatedById,
      createdAt: row.createdAt,
      updatedAt: row.body.updatedAt,
      bodyState: row.body.state,
      bodyJson: row.body.json,
      bodyMarkdown: row.body.markdown,
      bodyText: row.body.text,
    };
    this.pages.set(page.id, page);
    return page;
  }

  async updateBody(pageId: string, body: PageBodyWrite): Promise<void> {
    this.record('updateBody', pageId, body);
    const page = this.pages.get(pageId)!;
    this.pages.set(pageId, {
      ...page,
      bodyState: body.state,
      bodyJson: body.json,
      bodyMarkdown: body.markdown,
      bodyText: body.text,
      revision: body.revision,
      updatedById: body.updatedById,
      updatedAt: body.updatedAt,
    });
  }

  async updateTitle(pageId: string, title: string, updatedById: string): Promise<PageRow | null> {
    this.record('updateTitle', pageId, title, updatedById);
    const page = this.pages.get(pageId);
    if (!page) return null;
    const renamed = { ...page, title, updatedById };
    this.pages.set(pageId, renamed);
    return renamed;
  }

  /** A page's versions, oldest first. */
  versionsOf(pageId: string): PageVersionWithBody[] {
    return this.versions.filter((v) => v.pageId === pageId).sort((a, b) => a.number - b.number);
  }

  async latestVersion(pageId: string): Promise<PageVersionRow | null> {
    this.record('latestVersion', pageId);
    return this.versionsOf(pageId).at(-1) ?? null;
  }

  async insertVersion(row: PageVersionInsert): Promise<PageVersionRow> {
    this.record('insertVersion', row);
    if (this.versions.some((v) => v.pageId === row.pageId && v.number === row.number)) {
      throw new Error(`unique (page_id, number) violated: ${row.pageId} v${row.number}`);
    }
    this.nextId += 1;
    const version: PageVersionWithBody = { id: `version-${this.nextId}`, ...row };
    this.versions.push(version);
    return version;
  }

  async updateVersion(versionId: string, row: PageVersionUpdate): Promise<void> {
    this.record('updateVersion', versionId, row);
    this.versions = this.versions.map((v) => (v.id === versionId ? { ...v, ...row } : v));
  }

  async findVersion(pageId: string, number: number): Promise<PageVersionWithBody | null> {
    this.record('findVersion', pageId, number);
    return this.versions.find((v) => v.pageId === pageId && v.number === number) ?? null;
  }

  async countVersions(pageId: string): Promise<number> {
    this.record('countVersions', pageId);
    return this.versionsOf(pageId).length;
  }

  async deleteOldestVersions(pageId: string, keep: number): Promise<void> {
    this.record('deleteOldestVersions', pageId, keep);
    const own = this.versionsOf(pageId);
    const doomed = new Set(own.slice(0, Math.max(0, own.length - keep)).map((v) => v.id));
    // ON DELETE SET NULL on `restored_from_version_id`, as the table does.
    this.versions = this.versions
      .filter((v) => !doomed.has(v.id))
      .map((v) =>
        v.restoredFromVersionId !== null && doomed.has(v.restoredFromVersionId)
          ? { ...v, restoredFromVersionId: null }
          : v,
      );
  }

  async replaceDerivedLinks(pageId: string, links: readonly DerivedPageLink[]): Promise<void> {
    this.record('replaceDerivedLinks', pageId, links);
  }
}

/** A clock that returns a fixed instant, advanced by hand. */
export class FixedClock implements Clock {
  constructor(public current = new Date('2026-10-01T12:00:00Z')) {}
  now(): Date {
    return this.current;
  }
}
