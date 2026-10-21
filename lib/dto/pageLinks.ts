// The work item's Pages read (Story MOTIR-7565 · MOTIR-7573) — what crosses the
// service boundary for "which pages link to this work item?" One row per linking
// page, live or unavailable, however many link rows it has
// (`docs/decisions/pages.md` §8.1).

/**
 * How a page links to the work item: a chip in its body, an embed, by hand, or
 * a tag in the work item's own Description / Explanation (MOTIR-7696).
 */
export type PageLinkSourceDto = 'mention' | 'embed' | 'manual' | 'description' | 'explanation';

/** Where the page sits, in the page breadcrumb's vocabulary. */
export interface WorkItemPageLinkPlaceDto {
  /** The folder chain its topmost page is filed in, root first; `[]` at the root. */
  folderPath: string[];
  /** Its direct parent page's title; `null` for a top-level page. */
  parentPageTitle: string | null;
}

/**
 * `unavailable`: the page can no longer be opened as a live page (it is
 * archived); its title, place and sources are still what it had (MOTIR-9203). A
 * deleted page has no row at all — the FK cascade takes its link rows.
 */
export type WorkItemPageLinkStateDto = 'live' | 'unavailable';

/** One page linking to the work item. */
export interface WorkItemPageLinkRowDto {
  pageId: string;
  title: string;
  state: WorkItemPageLinkStateDto;
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

/** The pair a hand-link write answers with (MOTIR-9197); the section's row is the read's to compose. */
export interface PageLinkPairDto {
  pageId: string;
  workItemId: string;
  source: 'manual';
}
