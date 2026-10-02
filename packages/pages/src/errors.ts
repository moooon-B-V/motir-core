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
