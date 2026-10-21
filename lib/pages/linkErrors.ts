// The page ↔ work-item hand link's refusals (Story MOTIR-7567 · MOTIR-9197).
// The row is the app's table, not the page document's, so these live here and
// not in `packages/pages`. Shaped like that package's `PageError`s — `code` +
// `status` + message — so `pageErrorResponse` reads them the same way.

/** The pair already has its `manual` row. */
export class PageLinkAlreadyExistsError extends Error {
  readonly code = 'PAGE_LINK_ALREADY_LINKED' as const;
  readonly status = 409 as const;
  constructor(
    readonly pageId: string,
    readonly workItemId: string,
  ) {
    super('This page is already linked to the work item.');
    this.name = 'PageLinkAlreadyExistsError';
  }
}

/** Unlink of a pair that has no `manual` row (a mention or embed is not one). */
export class PageLinkNotFoundError extends Error {
  readonly code = 'PAGE_LINK_NOT_FOUND' as const;
  readonly status = 404 as const;
  constructor(
    readonly pageId: string,
    readonly workItemId: string,
  ) {
    super('This page is not linked to the work item by hand.');
    this.name = 'PageLinkNotFoundError';
  }
}
