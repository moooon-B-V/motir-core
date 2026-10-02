import { PAGE_DEPTH_LIMIT } from './constants';

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
