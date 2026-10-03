import { beforeEach, describe, expect, it } from 'vitest';
import {
  PAGE_DEPTH_LIMIT,
  CrossProjectPageParentError,
  PageCycleError,
  PageDepthExceededError,
  PageFolderNotFoundError,
  PageNeighbourInvalidError,
  PageNotFoundError,
  PageTreeError,
  createPage,
  movePage,
  subtreeHeight,
  type PagePlacement,
} from '../src';
import { FixedClock, MemoryPageStore } from './fakes/memoryPageStore';

const scope = { workspaceId: 'w1', projectId: 'p1', actorId: 'u1' };
const ROOT: PagePlacement = { kind: 'root' };
const inFolder = (folderId: string): PagePlacement => ({ kind: 'folder', folderId });
const under = (pageId: string): PagePlacement => ({ kind: 'page', pageId });

let store: MemoryPageStore;
let clock: FixedClock;

beforeEach(() => {
  store = new MemoryPageStore();
  clock = new FixedClock();
  store.addFolder('f1', 'p1');
  store.addFolder('f2', 'p1');
  store.addFolder('fx', 'p2');
});

const create = async (title: string, parent: PagePlacement = ROOT) =>
  (await createPage(store, clock, { ...scope, title, parent })).id;

const read = (id: string) => store.pages.get(id)!;
const titles = (parent: PagePlacement) => store.level('p1', parent).map((page) => page.title);
const writes = () => store.called('updatePlacement') + store.called('rebaseDescendants');

/** A chain of `n` nested pages under `parent`, outermost first. */
async function chain(n: number, parent: PagePlacement = ROOT): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    ids.push(await create(`c${i + 1}`, i === 0 ? parent : under(ids[i - 1]!)));
  }
  return ids;
}

const move = (pageId: string, parent: PagePlacement, extra: object = {}) =>
  movePage(store, { pageId, projectId: 'p1', parent, actorId: 'u2', ...extra });

describe('movePage — placements', () => {
  it('moves a page from the root into a folder, last at its new level', async () => {
    await create('Existing', inFolder('f1'));
    const page = await create('Plan');
    const [child] = [await create('Child', under(page))];

    const result = await move(page, inFolder('f1'));

    expect(result.moved).toBe(true);
    expect(read(page)).toMatchObject({
      folderId: 'f1',
      parentPageId: null,
      ancestorPageIds: [],
      updatedById: 'u2',
    });
    expect(titles(inFolder('f1'))).toEqual(['Existing', 'Plan']);
    // A folder-filed page starts its own chain, so its sub-page's is unchanged.
    expect(read(child!).ancestorPageIds).toEqual([page]);
    expect(store.called('rebaseDescendants')).toBe(0);
  });

  it('moves a page from a folder under a page, rewriting every descendant', async () => {
    const target = await create('Target');
    const [a, b, c] = await chain(3, inFolder('f1'));

    await move(a!, under(target));

    expect(read(a!)).toMatchObject({ folderId: null, parentPageId: target });
    expect(read(a!).ancestorPageIds).toEqual([target]);
    expect(read(b!).ancestorPageIds).toEqual([target, a]);
    expect(read(c!).ancestorPageIds).toEqual([target, a, b]);
    expect(store.called('rebaseDescendants')).toBe(1);
  });

  it('moves a sub-page to the root, its subtree following', async () => {
    const [a, b, c] = await chain(3);

    await move(b!, ROOT);

    expect(read(b!)).toMatchObject({ parentPageId: null, folderId: null, ancestorPageIds: [] });
    expect(read(c!).ancestorPageIds).toEqual([b]);
    expect(titles(ROOT)).toEqual(['c1', 'c2']);
    expect(read(a!).ancestorPageIds).toEqual([]);
  });

  it('moves a sub-page across to another parent at the same depth, rewriting its subtree', async () => {
    const left = await create('Left');
    const right = await create('Right');
    const [mid, leaf] = await chain(2, under(left));

    await move(mid!, under(right));

    expect(read(mid!).ancestorPageIds).toEqual([right]);
    expect(read(leaf!).ancestorPageIds).toEqual([right, mid]);
    expect(store.called('rebaseDescendants')).toBe(1);
  });

  it('reorders between two named siblings without touching any chain', async () => {
    const one = await create('One');
    const two = await create('Two');
    const three = await create('Three');
    await create('Sub', under(three));

    await move(three, ROOT, { beforeId: one, afterId: two });

    expect(titles(ROOT)).toEqual(['One', 'Three', 'Two']);
    expect(store.called('updatePlacement')).toBe(1);
    expect(store.called('rebaseDescendants')).toBe(0);
  });

  it('moves to the start before a named page, and to the end after one', async () => {
    const one = await create('One');
    const two = await create('Two');
    const three = await create('Three');

    await move(three, ROOT, { afterId: one });
    expect(titles(ROOT)).toEqual(['Three', 'One', 'Two']);

    await move(three, ROOT, { beforeId: two });
    expect(titles(ROOT)).toEqual(['One', 'Two', 'Three']);
  });

  it('moves into a level between a named page and the one after it', async () => {
    const a = await create('A', inFolder('f1'));
    await create('B', inFolder('f1'));
    const page = await create('Moved');

    await move(page, inFolder('f1'), { beforeId: a });

    expect(titles(inFolder('f1'))).toEqual(['A', 'Moved', 'B']);
  });

  it('takes the placement lock before reading the page, the parent and the subtree', async () => {
    const target = await create('Target', inFolder('f1'));
    const page = await create('Page');
    store.calls.length = 0;

    await move(page, under(target));

    expect(store.calls.map((call) => call.method)).toEqual([
      'lockSiblings',
      'lockPage',
      'findPage',
      'findSubtree',
      'siblingNeighbours',
      'updatePlacement',
    ]);
    expect(store.calls[0]!.args).toEqual(['p1', under(target)]);
  });
});

describe('movePage — no-op moves write nothing', () => {
  it('a page moved to its own parent with no neighbour named', async () => {
    const page = await create('Page', inFolder('f1'));
    const result = await move(page, inFolder('f1'));
    expect(result).toMatchObject({ moved: false, page: { id: page } });
    expect(writes()).toBe(0);
  });

  it('a page already between its named neighbours', async () => {
    const one = await create('One');
    const two = await create('Two');
    const three = await create('Three');

    for (const extra of [
      { beforeId: one, afterId: three },
      { beforeId: one },
      { afterId: three },
    ]) {
      expect((await move(two, ROOT, extra)).moved).toBe(false);
    }
    expect(writes()).toBe(0);
    expect(titles(ROOT)).toEqual(['One', 'Two', 'Three']);
  });
});

describe('movePage — refusals write nothing', () => {
  async function refused(promise: Promise<unknown>) {
    const err = await promise.catch((e: unknown) => e);
    expect(writes()).toBe(0);
    return err;
  }

  it('refuses a move under the page itself', async () => {
    const page = await create('Page');
    const err = await refused(move(page, under(page)));
    expect(err).toBeInstanceOf(PageCycleError);
    expect(err).toBeInstanceOf(PageTreeError);
    expect(err).toMatchObject({ code: 'PAGE_CYCLE', status: 422 });
  });

  it('refuses a move under one of its own descendants', async () => {
    const [a, , c] = await chain(3);
    const err = await refused(move(a!, under(c!)));
    expect(err).toBeInstanceOf(PageCycleError);
    expect(err).toMatchObject({ pageId: a, parentPageId: c });
  });

  it('reports a move that is both a cycle and too deep as the cycle', async () => {
    const ids = await chain(PAGE_DEPTH_LIMIT);
    const err = await refused(move(ids[0]!, under(ids.at(-1)!)));
    expect(err).toBeInstanceOf(PageCycleError);
  });

  it('refuses a subtree whose deepest page would reach level 11, carrying the limit', async () => {
    const deep = await chain(8);
    const [top] = await chain(3, inFolder('f1'));

    const err = await refused(move(top!, under(deep.at(-1)!)));

    expect(err).toBeInstanceOf(PageDepthExceededError);
    expect(err).toMatchObject({ code: 'PAGE_DEPTH_EXCEEDED', limit: 10, attemptedLevel: 11 });
  });

  it('admits the same subtree when its deepest page lands at level 10', async () => {
    const deep = await chain(7);
    const [top, , bottom] = await chain(3, inFolder('f1'));

    await move(top!, under(deep.at(-1)!));

    expect(read(bottom!).ancestorPageIds).toHaveLength(9);
  });

  it('refuses a parent page in another project', async () => {
    const page = await create('Page');
    const elsewhere = await createPage(store, clock, { ...scope, projectId: 'p2' });
    const err = await refused(move(page, under(elsewhere.id)));
    expect(err).toBeInstanceOf(CrossProjectPageParentError);
    expect(err).toMatchObject({
      code: 'CROSS_PROJECT_PAGE_PARENT',
      status: 422,
      parentKind: 'page',
      parentId: elsewhere.id,
    });
  });

  it('refuses a folder in another project', async () => {
    const page = await create('Page');
    const err = await refused(move(page, inFolder('fx')));
    expect(err).toBeInstanceOf(CrossProjectPageParentError);
    expect(err).toMatchObject({ parentKind: 'folder', parentId: 'fx' });
  });

  it('refuses a missing parent page and a missing folder', async () => {
    const page = await create('Page');
    expect(await refused(move(page, under('nope')))).toBeInstanceOf(PageNotFoundError);
    const err = await refused(move(page, inFolder('gone')));
    expect(err).toBeInstanceOf(PageFolderNotFoundError);
    expect(err).toMatchObject({ code: 'FOLDER_NOT_FOUND', status: 404, folderId: 'gone' });
  });

  it('refuses a page that does not exist, or is in another project', async () => {
    expect(await refused(move('nope', ROOT))).toBeInstanceOf(PageNotFoundError);
    const elsewhere = await createPage(store, clock, { ...scope, projectId: 'p2' });
    expect(await refused(move(elsewhere.id, ROOT))).toBeInstanceOf(PageNotFoundError);
  });

  it('refuses a neighbour that is not a child of the target parent', async () => {
    const page = await create('Page');
    const rootSibling = await create('Root sibling');
    await create('In folder', inFolder('f1'));

    const err = await refused(move(page, inFolder('f1'), { beforeId: rootSibling }));
    expect(err).toBeInstanceOf(PageNeighbourInvalidError);
    expect(err).toMatchObject({
      code: 'PAGE_NEIGHBOUR_INVALID',
      status: 422,
      side: 'before',
      neighbourId: rootSibling,
      reason: 'not_sibling',
    });

    const missing = await refused(move(page, inFolder('f1'), { afterId: 'nope' }));
    expect(missing).toMatchObject({ side: 'after', reason: 'not_sibling' });
  });

  it('refuses a neighbour in another project', async () => {
    const page = await create('Page');
    const elsewhere = await createPage(store, clock, { ...scope, projectId: 'p2' });
    const err = await refused(move(page, ROOT, { afterId: elsewhere.id }));
    expect(err).toMatchObject({ reason: 'not_sibling' });
  });

  it('refuses the page named as its own neighbour', async () => {
    const page = await create('Page');
    const err = await refused(move(page, ROOT, { afterId: page }));
    expect(err).toMatchObject({ side: 'after', reason: 'self' });
  });

  it('refuses two neighbours named in the wrong order', async () => {
    const one = await create('One');
    const two = await create('Two');
    const page = await create('Page', inFolder('f1'));
    const err = await refused(move(page, ROOT, { beforeId: two, afterId: one }));
    expect(err).toMatchObject({ side: 'after', neighbourId: one, reason: 'order' });
  });
});

describe('subtreeHeight', () => {
  it('counts the page as one level and adds the deepest descendant', () => {
    const page = { id: 'a', ancestorPageIds: ['x'] };
    expect(subtreeHeight(page, [])).toBe(1);
    expect(
      subtreeHeight(page, [
        { id: 'b', ancestorPageIds: ['x', 'a'] },
        { id: 'c', ancestorPageIds: ['x', 'a', 'b'] },
        { id: 'd', ancestorPageIds: ['x', 'a'] },
      ]),
    ).toBe(3);
  });
});
