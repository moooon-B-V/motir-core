import { PAGE_DEPTH_LIMIT, PAGE_TITLE_MAX_LENGTH } from './constants';

// The typed refusals the pure tree rules raise. Each carries the stable `code`
// and HTTP `status` `docs/decisions/pages.md` §4 names, so the app's route layer
// maps them without a table of its own.

/** Base class, so a route can catch every tree refusal in one branch. */
export abstract class PageTreeError extends Error {
  abstract readonly code: string;
  readonly status = 422 as const;
}

/** A placement named something that is not a page, a folder or the root. */
export class PageParentNotAllowedError extends PageTreeError {
  readonly code = 'PAGE_PARENT_NOT_ALLOWED' as const;
  constructor(readonly parentKind: string) {
    super(
      parentKind === 'work_item'
        ? 'A page cannot be placed under a work item. Place it under a page, a folder or the project root.'
        : `A page cannot be placed under a "${parentKind}". Place it under a page, a folder or the project root.`,
    );
    this.name = 'PageParentNotAllowedError';
  }
}

/** A page placed under itself or one of its own descendants. */
export class PageCycleError extends PageTreeError {
  readonly code = 'PAGE_CYCLE' as const;
  constructor(
    readonly pageId: string,
    readonly parentPageId: string,
  ) {
    super('A page cannot be placed under itself or one of its own sub-pages.');
    this.name = 'PageCycleError';
  }
}

/** A placement that would put a page deeper than the depth limit. */
export class PageDepthExceededError extends PageTreeError {
  readonly code = 'PAGE_DEPTH_EXCEEDED' as const;
  readonly limit = PAGE_DEPTH_LIMIT;
  constructor(readonly attemptedLevel: number) {
    super(
      `Pages can be nested at most ${PAGE_DEPTH_LIMIT} levels deep; this would place one at level ${attemptedLevel}.`,
    );
    this.name = 'PageDepthExceededError';
  }
}

/** A placement whose parent page or folder belongs to another project. */
export class CrossProjectPageParentError extends PageTreeError {
  readonly code = 'CROSS_PROJECT_PAGE_PARENT' as const;
  constructor(
    readonly parentKind: 'page' | 'folder',
    readonly parentId: string,
  ) {
    super(`A page can only be placed under a ${parentKind} in its own project.`);
    this.name = 'CrossProjectPageParentError';
  }
}

/**
 * A move's `beforeId` / `afterId` that does not name a sibling at the target:
 * a page that is not a child of the target parent (`not_sibling`), the moving
 * page itself (`self`), or two neighbours named in the wrong order (`order`).
 */
export class PageNeighbourInvalidError extends PageTreeError {
  readonly code = 'PAGE_NEIGHBOUR_INVALID' as const;
  constructor(
    readonly side: 'before' | 'after',
    readonly neighbourId: string,
    readonly reason: 'not_sibling' | 'self' | 'order',
  ) {
    super(
      reason === 'order'
        ? 'The page to place after must come before the page to place before.'
        : reason === 'self'
          ? 'A page cannot be placed next to itself.'
          : `The ${side} neighbour is not a page at the destination.`,
    );
    this.name = 'PageNeighbourInvalidError';
  }
}

/** Base class for the save procedures' refusals, each carrying its HTTP status. */
export abstract class PageError extends Error {
  abstract readonly code: string;
  abstract readonly status: number;
}

/**
 * A body over a size limit (§3) — a save REQUEST over `PAGE_SAVE_MAX_BYTES`, or a
 * merged body over `PAGE_BODY_MAX_BYTES`. Either way nothing is written.
 */
export class PageBodyTooLargeError extends PageError {
  readonly code = 'PAGE_BODY_TOO_LARGE' as const;
  readonly status = 413 as const;
  constructor(
    readonly limit: number,
    readonly size: number,
  ) {
    super(`This page body is ${size} bytes; the limit is ${limit} bytes.`);
    this.name = 'PageBodyTooLargeError';
  }
}

/**
 * A whole-body write (the markdown save, §3 / §8.2) that stated a revision the
 * page has since moved past. A Yjs update merges and is never refused for
 * staleness; a whole-body replace would erase whatever landed in between, so it
 * is refused and nothing is written. Re-read the page and write again.
 */
export class PageRevisionConflictError extends PageError {
  readonly code = 'PAGE_REVISION_CONFLICT' as const;
  readonly status = 409 as const;
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `This page is at revision ${actual}, not the revision ${expected} the write was based on. Re-read the page and write again.`,
    );
    this.name = 'PageRevisionConflictError';
  }
}

/** A page that does not exist, or is outside the caller's scope. */
export class PageNotFoundError extends PageError {
  readonly code = 'PAGE_NOT_FOUND' as const;
  readonly status = 404 as const;
  constructor(readonly pageId: string) {
    super('Page not found.');
    this.name = 'PageNotFoundError';
  }
}

/** A title longer than `PAGE_TITLE_MAX_LENGTH` characters. */
export class PageTitleTooLongError extends PageError {
  readonly code = 'PAGE_TITLE_TOO_LONG' as const;
  readonly status = 422 as const;
  readonly limit = PAGE_TITLE_MAX_LENGTH;
  constructor(readonly length: number) {
    super(
      `A page title can be at most ${PAGE_TITLE_MAX_LENGTH} characters; this one is ${length}.`,
    );
    this.name = 'PageTitleTooLongError';
  }
}

/**
 * A save whose update is not a Yjs update this document can apply — empty, or
 * bytes the decoder refuses. Our own editor never sends one, so it is a client
 * defect or a hand-made request; it is refused before anything is written.
 */
export class PageUpdateMalformedError extends PageError {
  readonly code = 'PAGE_UPDATE_MALFORMED' as const;
  readonly status = 400 as const;
  constructor(readonly reason: 'empty' | 'undecodable') {
    super(
      reason === 'empty'
        ? 'The page update is empty.'
        : 'The page update could not be decoded as a Yjs update.',
    );
    this.name = 'PageUpdateMalformedError';
  }
}

/**
 * A folder placement naming a folder that does not exist or is outside the
 * caller's scope. The wire code is the folder domain's own `FOLDER_NOT_FOUND`
 * (404), so a client reads one refusal for a missing folder whichever door it
 * came through.
 */
export class PageFolderNotFoundError extends PageError {
  readonly code = 'FOLDER_NOT_FOUND' as const;
  readonly status = 404 as const;
  constructor(readonly folderId: string) {
    super('Folder not found.');
    this.name = 'PageFolderNotFoundError';
  }
}

/**
 * A tree-level read's cursor that is not one this service issued — not decodable,
 * or naming a band the level does not have. Cursors are opaque: a client passes
 * back the `nextCursor` it was handed, verbatim.
 */
export class PageLevelCursorInvalidError extends PageError {
  readonly code = 'PAGE_CURSOR_INVALID' as const;
  readonly status = 400 as const;
  constructor() {
    super('The tree-level cursor is not valid. Pass back the nextCursor you were given.');
    this.name = 'PageLevelCursorInvalidError';
  }
}

/** A version a page does not have — never existed, pruned, or another page's (§6). */
export class PageVersionNotFoundError extends PageError {
  readonly code = 'PAGE_VERSION_NOT_FOUND' as const;
  readonly status = 404 as const;
  constructor(
    readonly pageId: string,
    readonly number: number,
  ) {
    super(`This page has no version ${number}.`);
    this.name = 'PageVersionNotFoundError';
  }
}
