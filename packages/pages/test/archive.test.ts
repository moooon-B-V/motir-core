import { beforeEach, describe, expect, it } from 'vitest';
import {
  PAGE_DEPTH_LIMIT,
  PageArchiveRootRequiredError,
  PageArchivedError,
  PageError,
  PageNeighbourInvalidError,
  PageNotArchivedError,
  PageNotFoundError,
  PageParentArchivedError,
  PageTreeError,
  archivePage,
  createPage,
  deletePage,
  movePage,
  renamePage,
  restoreLanding,
  restorePage,
  restorePageVersion,
  savePageMarkdown,
  savePageUpdate,
  type LandingAncestor,
  type PagePlacement,
  type RestoreLandingInput,
} from '../src';
import { FixedClock, MemoryPageStore } from './fakes/memoryPageStore';

// ARCHIVE, RESTORE and DELETE (Story MOTIR-5755 · MOTIR-7418), against the
// in-memory store: which pages each operation takes, where a restore lands, the
// order a delete must write in, and every refusal an archived page brings.

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
});

const create = async (title: string, parent: PagePlacement = ROOT) =>
  (await createPage(store, clock, { ...scope, title, parent })).id;
const read = (id: string) => store.pages.get(id)!;
const op = (pageId: string, actorId = 'u2') => ({ pageId, projectId: 'p1', actorId });
const archive = (pageId: string) => archivePage(store, clock, op(pageId));
const restore = (pageId: string) => restorePage(store, op(pageId));
const remove = (pageId: string) => deletePage(store, op(pageId));
const refused = (p: Promise<unknown>) => p.then(() => undefined).catch((err: unknown) => err);
const titles = (parent: PagePlacement) => store.level('p1', parent).map((page) => page.title);

/** A chain of `n` nested pages under `parent`, outermost first. */
async function chain(n: number, parent: PagePlacement = ROOT, prefix = 'c'): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    ids.push(await create(`${prefix}${i + 1}`, i === 0 ? parent : under(ids[i - 1]!)));
  }
  return ids;
}

describe('archivePage', () => {
  it('takes the page and its LIVE sub-pages, and leaves one archived earlier in its own archive', async () => {
    const page = await create('Plan');
    const a = await create('A', under(page));
    const b = await create('B', under(page));
    const earlier = await create('Earlier', under(page));
    const earlierChild = await create('Earlier child', under(earlier));
    clock.current = new Date('2026-10-02T09:00:00Z');
    await archive(earlier);

    clock.current = new Date('2026-10-03T09:00:00Z');
    const result = await archive(page);

    expect(result.rootId).toBe(page);
    expect([...result.archivedIds].sort()).toEqual([page, a, b].sort());
    expect(result.archivedIds[0]).toBe(page);
    for (const id of [page, a, b]) {
      expect(read(id)).toMatchObject({
        archiveRootId: page,
        archivedById: 'u2',
        archivedAt: new Date('2026-10-03T09:00:00Z'),
      });
    }
    for (const id of [earlier, earlierChild]) {
      expect(read(id)).toMatchObject({
        archiveRootId: earlier,
        archivedAt: new Date('2026-10-02T09:00:00Z'),
      });
    }
    // Its place is kept on the row — that IS where a restore returns it.
    expect(read(page)).toMatchObject({ parentPageId: null, folderId: null });
    expect(titles(ROOT)).toEqual([]);
  });

  it('locks the project, then the page, before reading the subtree', async () => {
    const page = await create('Plan');
    store.calls.length = 0;
    await archive(page);
    expect(store.calls.map((c) => c.method)).toEqual([
      'findPage',
      'lockSiblings',
      'lockPage',
      'findSubtree',
      'setArchived',
    ]);
  });

  it('refuses an archived page, a missing one and one from another project', async () => {
    const page = await create('Plan');
    await archive(page);
    const writes = store.called('setArchived');

    const again = await refused(archive(page));
    expect(again).toBeInstanceOf(PageArchivedError);
    expect(again).toBeInstanceOf(PageError);
    expect(again).toMatchObject({ code: 'PAGE_ARCHIVED', status: 409, pageId: page });
    await expect(archive('nope')).rejects.toBeInstanceOf(PageNotFoundError);
    await expect(
      archivePage(store, clock, { pageId: page, projectId: 'p2', actorId: 'u1' }),
    ).rejects.toBeInstanceOf(PageNotFoundError);
    expect(store.called('setArchived')).toBe(writes);
  });

  it('reads a page that vanished between the read and the lock as missing', async () => {
    const page = await create('Plan');
    const lock = store.lockPage.bind(store);
    store.lockPage = async (id) => {
      await lock(id);
      return null;
    };
    await expect(archive(page)).rejects.toBeInstanceOf(PageNotFoundError);
  });
});

describe('restorePage — the set', () => {
  it('brings back exactly its archive; a sub-page archived earlier stays archived', async () => {
    const page = await create('Plan');
    const a = await create('A', under(page));
    const earlier = await create('Earlier', under(page));
    await archive(earlier);
    await archive(page);

    const result = await restore(page);

    expect([...result.restoredIds].sort()).toEqual([page, a].sort());
    for (const id of [page, a]) {
      expect(read(id)).toMatchObject({ archivedAt: null, archiveRootId: null, archivedById: null });
    }
    expect(read(earlier)).toMatchObject({ archiveRootId: earlier });
    expect(read(earlier).archivedAt).not.toBeNull();
  });

  it('refuses a live page, and a sub-page that left with its parent (naming the root)', async () => {
    const page = await create('Plan');
    const child = await create('Child', under(page));

    const live = await refused(restore(page));
    expect(live).toBeInstanceOf(PageNotArchivedError);
    expect(live).toMatchObject({ code: 'PAGE_NOT_ARCHIVED', status: 409 });

    await archive(page);
    const sub = await refused(restore(child));
    expect(sub).toBeInstanceOf(PageArchiveRootRequiredError);
    expect(sub).toMatchObject({
      code: 'PAGE_ARCHIVE_ROOT_REQUIRED',
      status: 409,
      pageId: child,
      rootId: page,
    });
    expect(store.called('setArchived')).toBe(1);
  });
});

describe('restorePage — the landing ladder', () => {
  it('rung 1: the original parent is live — lands there and KEEPS its position', async () => {
    const parent = await create('Parent');
    await create('Before', under(parent));
    const page = await create('Plan', under(parent));
    await create('After', under(parent));
    const position = read(page).position;
    await archive(page);
    const placements = store.called('updatePlacement');

    const result = await restore(page);

    expect(result.landing).toEqual({ kind: 'original', parentPageId: parent, folderId: null });
    expect(read(page).position).toBe(position);
    expect(titles(under(parent))).toEqual(['Before', 'Plan', 'After']);
    expect(store.called('updatePlacement')).toBe(placements);
  });

  it('rung 1: APPENDS when a live sibling now holds its position', async () => {
    await create('First');
    const page = await create('Plan');
    const position = read(page).position;
    await archive(page);
    // The next page created mints the same key the archived page still holds.
    const taker = await create('Taker');
    expect(read(taker).position).toBe(position);

    const result = await restore(page);

    expect(result.landing.kind).toBe('original');
    expect(read(page).position > position).toBe(true);
    expect(titles(ROOT)).toEqual(['First', 'Taker', 'Plan']);
  });

  it('rung 1: a folder-filed page returns to its folder, a root page to the root', async () => {
    const filed = await create('Filed', inFolder('f1'));
    const top = await create('Top');
    await archive(filed);
    await archive(top);

    expect((await restore(filed)).landing).toEqual({
      kind: 'original',
      parentPageId: null,
      folderId: 'f1',
    });
    expect((await restore(top)).landing).toEqual({
      kind: 'original',
      parentPageId: null,
      folderId: null,
    });
  });

  it('rung 2: the parent is archived — lands under the nearest live ancestor, last, rebasing the set', async () => {
    const [g, p, r, c] = await chain(4);
    await create('Sibling', under(g!));
    await archive(r!);
    await archive(p!);

    const result = await restore(r!);

    expect(result.landing).toEqual({ kind: 'ancestorPage', parentPageId: g, folderId: null });
    expect(titles(under(g!))).toEqual(['Sibling', 'c3']);
    expect(read(r!)).toMatchObject({ parentPageId: g, ancestorPageIds: [g], archivedAt: null });
    expect(read(c!)).toMatchObject({ ancestorPageIds: [g, r], archivedAt: null });
    // The parent's own archive is untouched.
    expect(read(p!).archiveRootId).toBe(p);
  });

  it('rung 2: the parent was deleted — lands under the nearest ancestor that still exists', async () => {
    const [g, p, r] = await chain(3);
    await archive(r!);
    // The parent is gone from under it (a stored row the procedures never left).
    store.pages.delete(p!);

    const result = await restore(r!);

    expect(result.landing).toEqual({ kind: 'ancestorPage', parentPageId: g, folderId: null });
  });

  it('rung 3: no live ancestor — lands in the topmost ancestor’s folder', async () => {
    const [g, , r] = await chain(3, inFolder('f2'));
    await create('Already here', inFolder('f2'));
    await archive(r!);
    await archive(g!);

    const result = await restore(r!);

    expect(result.landing).toEqual({ kind: 'folder', parentPageId: null, folderId: 'f2' });
    expect(read(r!)).toMatchObject({ folderId: 'f2', parentPageId: null, ancestorPageIds: [] });
    expect(titles(inFolder('f2'))).toEqual(['Already here', 'c3']);
  });

  it('rung 4: no live ancestor and no folder — the project root', async () => {
    const [g, , r, c] = await chain(4);
    await archive(r!);
    await archive(g!);

    const result = await restore(r!);

    expect(result.landing).toEqual({ kind: 'root', parentPageId: null, folderId: null });
    expect(read(c!).ancestorPageIds).toEqual([r]);
  });

  it('rung 4: a folder that no longer exists is skipped, never assumed', async () => {
    const filed = await create('Filed', inFolder('f1'));
    await archive(filed);
    store.folders.delete('f1');

    expect((await restore(filed)).landing.kind).toBe('root');
  });

  it(`skips a rung that would put the set past level ${PAGE_DEPTH_LIMIT}`, async () => {
    // A set of height 3 (r › c › d) under p, under a.
    const a = await create('A');
    const p = await create('P', under(a));
    const [r] = await chain(3, under(p), 's');
    await archive(r!);
    // p now sits at level 8 — under a chain of seven.
    const deep = await chain(7, ROOT, 'k');
    const moved = { ...read(p), parentPageId: deep[6]!, ancestorPageIds: deep };
    store.pages.set(p, moved);

    const result = await restore(r!);

    // Under p, r would be at 9 and its deepest page at 11.
    expect(result.landing).toEqual({ kind: 'ancestorPage', parentPageId: a, folderId: null });
    expect(read(r!).ancestorPageIds).toEqual([a]);
  });
});

describe('deletePage', () => {
  it('refuses a live page ("archive it first") and writes nothing', async () => {
    const page = await create('Plan');
    store.calls.length = 0;
    const err = await refused(remove(page));
    expect(err).toBeInstanceOf(PageNotArchivedError);
    expect(err).toMatchObject({ code: 'PAGE_NOT_ARCHIVED', status: 409 });
    expect(store.called('deletePages')).toBe(0);
    expect(store.called('updatePlacement')).toBe(0);
  });

  it('refuses a non-root, naming the root', async () => {
    const page = await create('Plan');
    const child = await create('Child', under(page));
    await archive(page);
    const err = await refused(remove(child));
    expect(err).toBeInstanceOf(PageArchiveRootRequiredError);
    expect(err).toMatchObject({ rootId: page });
    expect(store.called('deletePages')).toBe(0);
  });

  it('deletes exactly the set, versions included', async () => {
    const page = await create('Plan');
    const child = await create('Child', under(page));
    const other = await create('Other');
    await archive(page);

    const result = await remove(page);

    expect(result.deletedIds).toEqual([page, child]);
    expect(store.pages.has(page)).toBe(false);
    expect(store.pages.has(child)).toBe(false);
    expect(store.versions.some((v) => v.pageId === page || v.pageId === child)).toBe(false);
    expect(store.versionsOf(other)).toHaveLength(1);
  });

  it('re-homes a separately-archived descendant to the deleted root’s place, still archived', async () => {
    const [g, p, r, c] = await chain(4);
    await archive(r!);
    await archive(p!);
    const pPosition = read(p!).position;

    const result = await remove(p!);

    expect(result.deletedIds).toEqual([p]);
    expect(store.pages.has(p!)).toBe(false);
    expect(read(r!)).toMatchObject({
      parentPageId: g,
      ancestorPageIds: [g],
      position: pPosition,
      archiveRootId: r,
    });
    expect(read(r!).archivedAt).not.toBeNull();
    expect(read(c!)).toMatchObject({ ancestorPageIds: [g, r], archiveRootId: r });

    // Its own restore now starts at the deleted page's place.
    expect((await restore(r!)).landing).toEqual({
      kind: 'original',
      parentPageId: g,
      folderId: null,
    });
    expect(read(r!).position).toBe(pPosition);
  });

  it('re-homes into a folder when the deleted root was filed in one', async () => {
    const [p, r] = await chain(2, inFolder('f1'));
    await archive(r!);
    await archive(p!);

    await remove(p!);

    expect(read(r!)).toMatchObject({ folderId: 'f1', parentPageId: null, ancestorPageIds: [] });
  });

  it('the store refuses a delete that would strand a child — the reason re-homing exists', async () => {
    const [p, r] = await chain(2);
    await archive(r!);
    await archive(p!);
    await expect(store.deletePages([p!])).rejects.toThrow(/page_parent_page_id_fkey/);
  });
});

describe('the archived-page refusals in the other procedures', () => {
  it('savePageUpdate, savePageMarkdown, renamePage and the version restore refuse an archived page', async () => {
    const page = await create('Plan');
    await archive(page);

    const save = await refused(
      savePageUpdate(store, clock, { pageId: page, actorId: 'u1', update: new Uint8Array([1]) }),
    );
    expect(save).toMatchObject({ code: 'PAGE_ARCHIVED', status: 409 });
    expect(store.called('updateBody')).toBe(0);

    // The agent's markdown save (MOTIR-5760) refuses it too, before staleness.
    const markdown = await refused(
      savePageMarkdown(store, clock, {
        pageId: page,
        actorId: 'u1',
        markdown: 'x',
        expectedRevision: -1,
      }),
    );
    expect(markdown).toMatchObject({ code: 'PAGE_ARCHIVED', status: 409 });
    expect(store.called('updateBody')).toBe(0);

    const rename = await refused(renamePage(store, { pageId: page, actorId: 'u1', title: 'x' }));
    expect(rename).toMatchObject({ code: 'PAGE_ARCHIVED' });
    expect(store.called('updateTitle')).toBe(0);

    const version = await refused(
      restorePageVersion(store, clock, { pageId: page, number: 1, actorId: 'u1' }),
    );
    expect(version).toMatchObject({ code: 'PAGE_ARCHIVED' });
    expect(store.called('findVersion')).toBe(0);
  });

  it('movePage refuses moving an archived page', async () => {
    const page = await create('Plan');
    await archive(page);
    await expect(
      movePage(store, { pageId: page, projectId: 'p1', parent: inFolder('f1'), actorId: 'u1' }),
    ).rejects.toMatchObject({ code: 'PAGE_ARCHIVED' });
    expect(store.called('updatePlacement')).toBe(0);
  });

  it('createPage and movePage refuse an archived parent page (422)', async () => {
    const parent = await create('Parent');
    const page = await create('Plan');
    await archive(parent);

    const created = await refused(createPage(store, clock, { ...scope, parent: under(parent) }));
    expect(created).toBeInstanceOf(PageParentArchivedError);
    expect(created).toBeInstanceOf(PageTreeError);
    expect(created).toMatchObject({
      code: 'PAGE_PARENT_ARCHIVED',
      status: 422,
      parentPageId: parent,
    });

    const moved = await refused(
      movePage(store, { pageId: page, projectId: 'p1', parent: under(parent), actorId: 'u1' }),
    );
    expect(moved).toBeInstanceOf(PageParentArchivedError);
  });

  it('movePage refuses an archived page as a neighbour — it has left the level', async () => {
    const a = await create('A');
    const b = await create('B');
    const page = await create('Plan', inFolder('f1'));
    await archive(a);
    const err = await refused(
      movePage(store, { pageId: page, projectId: 'p1', parent: ROOT, beforeId: a, actorId: 'u1' }),
    );
    expect(err).toBeInstanceOf(PageNeighbourInvalidError);
    expect(err).toMatchObject({ reason: 'not_sibling' });
    expect(read(b).archivedAt).toBeNull();
  });
});

describe('restoreLanding — the pure ladder', () => {
  const live = (ancestorPageIds: string[], folderId: string | null = null): LandingAncestor => ({
    ancestorPageIds,
    folderId,
    live: true,
  });
  const gone = (ancestorPageIds: string[], folderId: string | null = null): LandingAncestor => ({
    ancestorPageIds,
    folderId,
    live: false,
  });
  const base = (over: Partial<RestoreLandingInput> = {}): RestoreLandingInput => ({
    root: { id: 'r', parentPageId: 'p', folderId: null, ancestorPageIds: ['g', 'p'] },
    subtreeHeight: 1,
    ancestors: new Map([
      ['g', live([], 'f')],
      ['p', live(['g'])],
    ]),
    folderExists: () => true,
    ...over,
  });

  it('takes the original parent first', () => {
    expect(restoreLanding(base())).toEqual({
      kind: 'original',
      parent: { kind: 'page', pageId: 'p' },
      ancestorPageIds: ['g', 'p'],
    });
  });

  it('uses the parent’s CURRENT chain, not the one the root stored', () => {
    const ancestors = new Map([
      ['g', live([], 'f')],
      ['p', live(['x', 'y'])],
    ]);
    expect(restoreLanding(base({ ancestors })).ancestorPageIds).toEqual(['x', 'y', 'p']);
  });

  it('walks up past an archived or missing parent, nearest first', () => {
    const archivedParent = new Map([
      ['g', live([], 'f')],
      ['p', gone(['g'])],
    ]);
    expect(restoreLanding(base({ ancestors: archivedParent }))).toMatchObject({
      kind: 'ancestorPage',
      parent: { kind: 'page', pageId: 'g' },
      ancestorPageIds: ['g'],
    });
    const missingParent = new Map([['g', live([], 'f')]]);
    expect(restoreLanding(base({ ancestors: missingParent })).kind).toBe('ancestorPage');
  });

  it('falls to the topmost ancestor’s folder, even when that ancestor is archived', () => {
    const ancestors = new Map([
      ['g', gone([], 'f')],
      ['p', gone(['g'])],
    ]);
    expect(restoreLanding(base({ ancestors }))).toEqual({
      kind: 'folder',
      parent: { kind: 'folder', folderId: 'f' },
      ancestorPageIds: [],
    });
    // …and to the root when that folder is gone, or the topmost ancestor is.
    expect(restoreLanding(base({ ancestors, folderExists: () => false })).kind).toBe('root');
    expect(restoreLanding(base({ ancestors: new Map() })).kind).toBe('root');
  });

  it('a folder-filed root whose folder is gone, with no ancestors, lands at the root', () => {
    const root = { id: 'r', parentPageId: null, folderId: 'f', ancestorPageIds: [] };
    expect(
      restoreLanding(base({ root, ancestors: new Map(), folderExists: () => false })).kind,
    ).toBe('root');
  });

  it('skips every page rung that would pass the depth limit, never the root', () => {
    const nine = Array.from({ length: 8 }, (_, i) => `k${i}`);
    const ancestors = new Map([
      ['g', live(nine, null)],
      ['p', live([...nine, 'g'])],
    ]);
    // Under p the root would sit at level 11; under g at 10 with height 2 → 11.
    expect(restoreLanding(base({ ancestors, subtreeHeight: 2 })).kind).toBe('root');
    // Height 1 still fits under g (level 10), not under p (level 11).
    expect(restoreLanding(base({ ancestors, subtreeHeight: 1 }))).toMatchObject({
      kind: 'ancestorPage',
      parent: { kind: 'page', pageId: 'g' },
    });
  });
});
