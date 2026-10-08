// The work item's Pages read (Story MOTIR-7565 · MOTIR-7573) — what crosses the
// service boundary for "which pages link to this work item?" One row per live
// page, however many link rows it has (`docs/decisions/pages.md` §8.1).

/** How a page links to the work item: a chip in its body, an embed, or by hand. */
export type PageLinkSourceDto = 'mention' | 'embed' | 'manual';

/** Where the page sits, in the page breadcrumb's vocabulary. */
export interface WorkItemPageLinkPlaceDto {
  /** The folder chain its topmost page is filed in, root first; `[]` at the root. */
  folderPath: string[];
  /** Its direct parent page's title; `null` for a top-level page. */
  parentPageTitle: string | null;
}

/** One page linking to the work item. */
export interface WorkItemPageLinkRowDto {
  pageId: string;
  title: string;
  /** Every way it links, sorted. */
  sources: PageLinkSourceDto[];
  /** ISO-8601, the page's last edit. */
  updatedAt: string;
  place: WorkItemPageLinkPlaceDto;
}

/** One page of the read, newest edit first; `nextCursor` is `null` on the last. */
export interface WorkItemPagesDto {
  rows: WorkItemPageLinkRowDto[];
  nextCursor: string | null;
}
