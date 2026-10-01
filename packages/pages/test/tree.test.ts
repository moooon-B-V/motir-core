import { describe, expect, it } from 'vitest';
import {
  PAGE_DEPTH_LIMIT,
  PageCycleError,
  PageDepthExceededError,
  PageParentNotAllowedError,
  PageTreeError,
  ancestorIdsFor,
  assertNoCycle,
  assertWithinDepth,
  pageLevel,
  parsePlacement,
  planPlacement,
  rebaseAncestorIds,
} from '../src';

/** A chain of `n` page ids, p1…pn, root-first. */
const chain = (n: number) => Array.from({ length: n }, (_, i) => `p${i + 1}`);

describe('parsePlacement', () => {
  it('accepts the root, a folder and a page', () => {
    expect(parsePlacement({ kind: 'root' })).toEqual({ kind: 'root' });
    expect(parsePlacement({ kind: 'folder', id: 'f1' })).toEqual({
      kind: 'folder',
      folderId: 'f1',
    });
    expect(parsePlacement({ kind: 'page', id: 'p1' })).toEqual({ kind: 'page', pageId: 'p1' });
  });

  it('refuses a work-item parent with PAGE_PARENT_NOT_ALLOWED', () => {
    const err = (() => {
      try {
        parsePlacement({ kind: 'work_item', id: 'w1' });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(PageParentNotAllowedError);
    expect(err).toBeInstanceOf(PageTreeError);
    expect(err).toMatchObject({
      code: 'PAGE_PARENT_NOT_ALLOWED',
      status: 422,
      parentKind: 'work_item',
    });
    expect((err as Error).message).toMatch(/work item/);
  });

  it('refuses any other kind', () => {
    expect(() => parsePlacement({ kind: 'sprint', id: 's1' })).toThrow(/"sprint"/);
  });

  it('needs an id for a folder or a page', () => {
    expect(() => parsePlacement({ kind: 'folder' })).toThrow(TypeError);
    expect(() => parsePlacement({ kind: 'page', id: null })).toThrow(TypeError);
  });
});

describe('ancestorIdsFor and pageLevel', () => {
  it('puts a root page and a folder-filed page at level 1', () => {
    expect(ancestorIdsFor({ kind: 'root' })).toEqual([]);
    expect(ancestorIdsFor({ kind: 'folder', folderId: 'f1' })).toEqual([]);
    expect(pageLevel([])).toBe(1);
  });

  it("extends the parent's chain under a page", () => {
    const ids = ancestorIdsFor(
      { kind: 'page', pageId: 'p2' },
      { id: 'p2', ancestorPageIds: ['p1'] },
    );
    expect(ids).toEqual(['p1', 'p2']);
    expect(pageLevel(ids)).toBe(3);
  });

  it('needs the named parent page', () => {
    expect(() => ancestorIdsFor({ kind: 'page', pageId: 'p2' })).toThrow(TypeError);
    expect(() =>
      ancestorIdsFor({ kind: 'page', pageId: 'p2' }, { id: 'p9', ancestorPageIds: [] }),
    ).toThrow(TypeError);
  });
});

describe('assertNoCycle', () => {
  it('allows a placement whose ancestors exclude the page', () => {
    expect(() => assertNoCycle('p9', ['p1', 'p2'])).not.toThrow();
  });

  it('refuses a page placed under its own descendant with PAGE_CYCLE', () => {
    expect(() => assertNoCycle('p1', ['p1', 'p2'])).toThrow(PageCycleError);
    try {
      assertNoCycle('p1', ['p1', 'p2']);
    } catch (e) {
      expect(e).toMatchObject({
        code: 'PAGE_CYCLE',
        status: 422,
        pageId: 'p1',
        parentPageId: 'p2',
      });
    }
  });

  it('refuses a page placed under itself', () => {
    const { ancestorPageIds } = {
      ancestorPageIds: ancestorIdsFor(
        { kind: 'page', pageId: 'p1' },
        { id: 'p1', ancestorPageIds: [] },
      ),
    };
    expect(() => assertNoCycle('p1', ancestorPageIds)).toThrow(PageCycleError);
  });
});

describe('assertWithinDepth', () => {
  it(`allows a page at level ${PAGE_DEPTH_LIMIT}`, () => {
    expect(() => assertWithinDepth(chain(PAGE_DEPTH_LIMIT - 1))).not.toThrow();
  });

  it(`refuses a page at level ${PAGE_DEPTH_LIMIT + 1} with PAGE_DEPTH_EXCEEDED`, () => {
    try {
      assertWithinDepth(chain(PAGE_DEPTH_LIMIT));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(PageDepthExceededError);
      expect(e).toMatchObject({
        code: 'PAGE_DEPTH_EXCEEDED',
        status: 422,
        limit: PAGE_DEPTH_LIMIT,
        attemptedLevel: PAGE_DEPTH_LIMIT + 1,
      });
    }
  });

  it('checks a move against the deepest page of the moving subtree', () => {
    expect(() => assertWithinDepth(chain(7), 3)).not.toThrow();
    expect(() => assertWithinDepth(chain(7), 4)).toThrow(PageDepthExceededError);
  });

  it('refuses a subtree height below 1', () => {
    expect(() => assertWithinDepth([], 0)).toThrow(RangeError);
    expect(() => assertWithinDepth([], 1.5)).toThrow(RangeError);
  });
});

describe('planPlacement', () => {
  it('returns the new ancestors for a create', () => {
    expect(
      planPlacement({
        placement: { kind: 'page', pageId: 'p1' },
        parent: { id: 'p1', ancestorPageIds: [] },
      }),
    ).toEqual({ ancestorPageIds: ['p1'] });
    expect(planPlacement({ placement: { kind: 'folder', folderId: 'f1' } })).toEqual({
      ancestorPageIds: [],
    });
  });

  it('refuses a cycle on a move', () => {
    expect(() =>
      planPlacement({
        pageId: 'p1',
        placement: { kind: 'page', pageId: 'p3' },
        parent: { id: 'p3', ancestorPageIds: ['p1', 'p2'] },
      }),
    ).toThrow(PageCycleError);
  });

  it('refuses a move that is too deep', () => {
    const parentChain = chain(8);
    expect(() =>
      planPlacement({
        pageId: 'x',
        placement: { kind: 'page', pageId: 'p9' },
        parent: { id: 'p9', ancestorPageIds: parentChain },
        subtreeHeight: 2,
      }),
    ).toThrow(PageDepthExceededError);
  });
});

describe('rebaseAncestorIds', () => {
  it("replaces the part of a descendant's chain above the moved page", () => {
    expect(rebaseAncestorIds(['a', 'b', 'm', 'c'], 'm', ['x'])).toEqual(['x', 'm', 'c']);
    expect(rebaseAncestorIds(['m'], 'm', [])).toEqual(['m']);
  });

  it('refuses a page outside the moved subtree', () => {
    expect(() => rebaseAncestorIds(['a'], 'm', [])).toThrow(RangeError);
  });
});
