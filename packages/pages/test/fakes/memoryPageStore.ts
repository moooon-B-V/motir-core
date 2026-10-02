import type {
  Clock,
  DerivedPageLink,
  LockedPageRow,
  PageBodyWrite,
  PageInsert,
  PagePlacement,
  PageRow,
  PageStore,
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
