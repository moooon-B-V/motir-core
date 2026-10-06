import * as Y from 'yjs';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PAGE_BODY_MAX_BYTES,
  PAGE_FRAGMENT,
  PAGE_VERSION_CAP,
  PAGE_VERSION_WINDOW_MS,
  PageBodyTooLargeError,
  PageNotFoundError,
  PageVersionNotFoundError,
  applyUpdate,
  createPage,
  decideVersionWrite,
  emptyState,
  markdownToUpdate,
  restorePageVersion,
  savePageUpdate,
  stateToMarkdown,
  stateToUpdate,
  type PageVersionRow,
} from '../src';
import { FixedClock, MemoryPageStore } from './fakes/memoryPageStore';

// A page's VERSIONS (Story MOTIR-5754 · MOTIR-7383), `docs/decisions/pages.md`
// §6: coalescing per author over the window, the cap, and restore as a new
// version — every rule against an injected clock.

const scope = { workspaceId: 'w1', projectId: 'p1', actorId: 'A' };
const MINUTE = 60_000;

let store: MemoryPageStore;
let clock: FixedClock;

beforeEach(() => {
  store = new MemoryPageStore();
  clock = new FixedClock();
});

function advance(ms: number): void {
  clock.current = new Date(clock.current.getTime() + ms);
}

/** Save `markdown` as the page's whole body, by `actorId`. */
async function write(pageId: string, actorId: string, markdown: string): Promise<number> {
  const current = store.pages.get(pageId)!.bodyState;
  return savePageUpdate(store, clock, {
    pageId,
    actorId,
    update: markdownToUpdate(current, markdown),
  });
}

describe('decideVersionWrite', () => {
  const base: PageVersionRow = {
    id: 'v',
    pageId: 'p',
    number: 4,
    authorId: 'A',
    startedAt: new Date(0),
    savedAt: new Date(0),
    restoredFromVersionId: null,
    restoredFromNumber: null,
    sealedAt: null,
    frozenAt: null,
  };

  it('starts version 1 on an empty history', () => {
    expect(decideVersionWrite(null, 'A', new Date(0))).toEqual({ kind: 'new', number: 1 });
  });

  it('extends at exactly the window and starts a new version one millisecond past it', () => {
    expect(decideVersionWrite(base, 'A', new Date(PAGE_VERSION_WINDOW_MS))).toEqual({
      kind: 'extend',
      versionId: 'v',
    });
    expect(decideVersionWrite(base, 'A', new Date(PAGE_VERSION_WINDOW_MS + 1))).toEqual({
      kind: 'new',
      number: 5,
    });
  });

  it('never extends another author’s version or a restore', () => {
    expect(decideVersionWrite(base, 'B', new Date(1))).toEqual({ kind: 'new', number: 5 });
    expect(
      decideVersionWrite(
        { ...base, restoredFromNumber: 2, restoredFromVersionId: 'x' },
        'A',
        new Date(1),
      ),
    ).toEqual({ kind: 'new', number: 5 });
    // A restore whose source was pruned is still a restore.
    expect(decideVersionWrite({ ...base, restoredFromNumber: 2 }, 'A', new Date(1))).toEqual({
      kind: 'new',
      number: 5,
    });
  });

  it('never extends a SEALED version, whatever the author and the window (MOTIR-7431)', () => {
    expect(decideVersionWrite({ ...base, sealedAt: new Date(0) }, 'A', new Date(1))).toEqual({
      kind: 'new',
      number: 5,
    });
  });
});

describe('coalescing', () => {
  it('folds two saves by one author 5 minutes apart into ONE version holding the second', async () => {
    const page = await createPage(store, clock, scope);
    advance(MINUTE);
    await write(page.id, 'A', 'first');
    advance(5 * MINUTE);
    await write(page.id, 'A', 'second');

    const versions = store.versionsOf(page.id);
    // v1 is the creation; it is by A and within the window, so the saves extend it.
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ number: 1, authorId: 'A', savedAt: clock.current });
    expect(versions[0]!.bodyMarkdown).toBe('second');
    expect(stateToMarkdown(versions[0]!.bodyState)).toBe('second');
  });

  it('leaves two versions, 1 and 2, for two saves 11 minutes apart after a create', async () => {
    const page = await createPage(store, clock, scope);
    advance(11 * MINUTE);
    await write(page.id, 'A', 'first');
    advance(11 * MINUTE);
    await write(page.id, 'A', 'second');

    expect(store.versionsOf(page.id).map((v) => [v.number, v.bodyMarkdown])).toEqual([
      [1, ''],
      [2, 'first'],
      [3, 'second'],
    ]);
    const [, v2, v3] = store.versionsOf(page.id);
    expect(v2!.startedAt).toEqual(v2!.savedAt);
    expect(v3!.startedAt).toEqual(clock.current);
  });

  it('gives two authors within the window two versions', async () => {
    const page = await createPage(store, clock, scope);
    advance(MINUTE);
    await write(page.id, 'A', 'by A');
    advance(MINUTE);
    await write(page.id, 'B', 'by B');

    expect(store.versionsOf(page.id).map((v) => [v.number, v.authorId, v.bodyMarkdown])).toEqual([
      [1, 'A', 'by A'],
      [2, 'B', 'by B'],
    ]);
  });
});

describe('the cap', () => {
  it('holds a page at the cap: the oldest goes, the newest is the one just written', async () => {
    const page = await createPage(store, clock, scope);
    // Seed versions 2..CAP directly, so the page holds exactly the cap.
    for (let n = 2; n <= PAGE_VERSION_CAP; n += 1) {
      await store.insertVersion({
        workspaceId: 'w1',
        projectId: 'p1',
        pageId: page.id,
        number: n,
        authorId: 'seed',
        bodyState: emptyState(),
        bodyMarkdown: `seed ${n}`,
        startedAt: clock.current,
        savedAt: clock.current,
        restoredFromVersionId: null,
        restoredFromNumber: null,
      });
    }
    expect(store.versionsOf(page.id)).toHaveLength(PAGE_VERSION_CAP);

    advance(MINUTE);
    await write(page.id, 'A', 'newest');

    const versions = store.versionsOf(page.id);
    expect(versions).toHaveLength(PAGE_VERSION_CAP);
    expect(versions[0]!.number).toBe(2);
    expect(versions.at(-1)).toMatchObject({
      number: PAGE_VERSION_CAP + 1,
      authorId: 'A',
      bodyMarkdown: 'newest',
    });
  });

  it('does not prune when a save only extends', async () => {
    const page = await createPage(store, clock, scope);
    await write(page.id, 'A', 'x');
    expect(store.called('deleteOldestUnmarkedVersions')).toBe(0);
  });
});

describe('the marks (MOTIR-7431)', () => {
  it('a same-author save in the window after a SEAL starts N+1 and leaves N untouched', async () => {
    const page = await createPage(store, clock, scope);
    advance(MINUTE);
    await write(page.id, 'A', 'published text');
    const [v1] = store.versionsOf(page.id);
    store.markVersion(v1!.id, { sealedAt: clock.current });

    advance(2 * MINUTE);
    await write(page.id, 'A', 'a typo fixed after publishing');

    const versions = store.versionsOf(page.id);
    expect(versions.map((v) => [v.number, v.bodyMarkdown])).toEqual([
      [1, 'published text'],
      [2, 'a typo fixed after publishing'],
    ]);
    expect(stateToMarkdown(versions[0]!.bodyState)).toBe('published text');
  });

  it('105 saves keep sealed versions 2 and 3 and a frozen one; the page holds the cap of UNMARKED + the marked', async () => {
    const page = await createPage(store, clock, scope);
    for (let n = 1; n <= 3; n += 1) {
      advance(11 * MINUTE);
      await write(page.id, 'A', `early ${n}`);
    }
    const [, v2, v3, v4] = store.versionsOf(page.id);
    store.markVersion(v2!.id, { sealedAt: clock.current });
    store.markVersion(v3!.id, { sealedAt: clock.current });
    store.markVersion(v4!.id, { sealedAt: clock.current, frozenAt: clock.current });

    for (let n = 1; n <= 105; n += 1) {
      advance(11 * MINUTE);
      await write(page.id, 'A', `save ${n}`);
    }

    const versions = store.versionsOf(page.id);
    const numbers = versions.map((v) => v.number);
    expect(numbers).toContain(v2!.number);
    expect(numbers).toContain(v3!.number);
    expect(numbers).toContain(v4!.number);
    // Three marked rows are never counted away, so the page keeps the cap + 3
    // only while the unmarked pass the cap — here the cap is what remains.
    expect(versions).toHaveLength(PAGE_VERSION_CAP);
    expect(versions.at(-1)!.bodyMarkdown).toBe('save 105');
  });

  it('a page whose marked versions alone pass the cap keeps more than the cap', async () => {
    const page = await createPage(store, clock, scope);
    for (let n = 2; n <= PAGE_VERSION_CAP + 2; n += 1) {
      const v = await store.insertVersion({
        workspaceId: 'w1',
        projectId: 'p1',
        pageId: page.id,
        number: n,
        authorId: 'seed',
        bodyState: emptyState(),
        bodyMarkdown: `sealed ${n}`,
        startedAt: clock.current,
        savedAt: clock.current,
        restoredFromVersionId: null,
        restoredFromNumber: null,
      });
      store.markVersion(v.id, { sealedAt: clock.current });
    }
    advance(MINUTE);
    await write(page.id, 'A', 'newest');

    const versions = store.versionsOf(page.id);
    // v1 (unmarked) is pruned; every sealed one stays; the newest is written.
    expect(versions.map((v) => v.number)).not.toContain(1);
    expect(versions).toHaveLength(PAGE_VERSION_CAP + 2);
    expect(versions.at(-1)!.bodyMarkdown).toBe('newest');
  });

  it('restoring a FROZEN version writes an unmarked new version and leaves the frozen one as it was', async () => {
    const page = await createPage(store, clock, scope);
    advance(MINUTE);
    await write(page.id, 'A', 'approved');
    const [v1] = store.versionsOf(page.id);
    store.markVersion(v1!.id, { sealedAt: clock.current, frozenAt: clock.current });
    advance(11 * MINUTE);
    await write(page.id, 'A', 'edited after approval');

    advance(MINUTE);
    const { version } = await restorePageVersion(store, clock, {
      pageId: page.id,
      number: 1,
      actorId: 'A',
    });

    expect(version).toMatchObject({ number: 3, sealedAt: null, frozenAt: null });
    expect(version.restoredFromNumber).toBe(1);
    const frozen = store.versionsOf(page.id)[0]!;
    expect(frozen).toMatchObject({ id: v1!.id, bodyMarkdown: 'approved' });
    expect(frozen.frozenAt).not.toBeNull();
  });
});

describe('restorePageVersion', () => {
  async function pageWithHistory() {
    const page = await createPage(store, clock, scope);
    advance(MINUTE);
    await write(page.id, 'A', '# One\n\nfirst body'); // extends v1
    advance(11 * MINUTE);
    await write(page.id, 'A', '# Two\n\nsecond body'); // v2
    return page;
  }

  it('makes version 1 current as a NEW version naming its source, keeping every earlier one', async () => {
    const page = await pageWithHistory();
    const v1 = store.versionsOf(page.id)[0]!;
    const revisionBefore = store.pages.get(page.id)!.revision;
    advance(MINUTE);

    const result = await restorePageVersion(store, clock, {
      pageId: page.id,
      number: 1,
      actorId: 'B',
    });

    const stored = store.pages.get(page.id)!;
    expect(stateToMarkdown(stored.bodyState)).toBe(v1.bodyMarkdown);
    expect(stored.bodyMarkdown).toBe('# One\n\nfirst body');
    expect(result.revision).toBe(revisionBefore + 1);
    expect(stored.revision).toBe(revisionBefore + 1);
    expect(result.version).toMatchObject({
      number: 3,
      authorId: 'B',
      restoredFromVersionId: v1.id,
      restoredFromNumber: 1,
    });
    expect(store.versionsOf(page.id).map((v) => v.number)).toEqual([1, 2, 3]);
    expect(store.versionsOf(page.id)[2]!.bodyMarkdown).toBe('# One\n\nfirst body');
  });

  it('closes a restore to coalescing: the next same-author save in the window starts a new version', async () => {
    const page = await pageWithHistory();
    await restorePageVersion(store, clock, { pageId: page.id, number: 1, actorId: 'A' });
    advance(MINUTE);
    await write(page.id, 'A', 'after the restore');

    const versions = store.versionsOf(page.id);
    expect(versions.map((v) => v.number)).toEqual([1, 2, 3, 4]);
    expect(versions[2]!.bodyMarkdown).toBe('# One\n\nfirst body');
    expect(versions[3]!.bodyMarkdown).toBe('after the restore');
  });

  it('refuses an unknown number, or another page’s version, and writes nothing', async () => {
    const page = await pageWithHistory();
    const other = await createPage(store, clock, scope);
    advance(11 * MINUTE);
    await write(other.id, 'A', 'other');
    advance(11 * MINUTE);
    await write(other.id, 'A', 'other again');
    // `page` has versions 1–2; `other` has 1–3, so 3 exists only on `other`.
    const before = JSON.stringify([...store.pages.values(), store.versions]);
    const writes = () =>
      ['updateBody', 'insertVersion', 'updateVersion', 'deleteOldestUnmarkedVersions'].map((m) =>
        store.called(m as never),
      );
    const writesBefore = writes();

    for (const number of [3, 99]) {
      await expect(
        restorePageVersion(store, clock, { pageId: page.id, number, actorId: 'A' }),
      ).rejects.toBeInstanceOf(PageVersionNotFoundError);
    }
    expect(writes()).toEqual(writesBefore);
    expect(JSON.stringify([...store.pages.values(), store.versions])).toBe(before);
  });

  it('refuses a missing page before reading any version', async () => {
    await expect(
      restorePageVersion(store, clock, { pageId: 'nope', number: 1, actorId: 'A' }),
    ).rejects.toBeInstanceOf(PageNotFoundError);
    expect(store.called('findVersion')).toBe(0);
  });

  it('refuses a restore past the body limit, writing no body and no version', async () => {
    const page = await createPage(store, clock, scope);
    // A version whose content alone is past the limit (incompressible text).
    let big = '';
    let seed = 7;
    while (big.length < PAGE_BODY_MAX_BYTES + 1024) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      big += seed.toString(36);
    }
    const bigState = applyUpdate(emptyState(), markdownToUpdate(emptyState(), big));
    expect(bigState.byteLength).toBeGreaterThan(PAGE_BODY_MAX_BYTES);
    await store.insertVersion({
      workspaceId: 'w1',
      projectId: 'p1',
      pageId: page.id,
      number: 2,
      authorId: 'A',
      bodyState: bigState,
      bodyMarkdown: big,
      startedAt: clock.current,
      savedAt: clock.current,
      restoredFromVersionId: null,
      restoredFromNumber: null,
    });
    const bodyWrites = store.called('updateBody');
    const versionWrites = store.called('insertVersion');

    await expect(
      restorePageVersion(store, clock, { pageId: page.id, number: 2, actorId: 'A' }),
    ).rejects.toBeInstanceOf(PageBodyTooLargeError);
    expect(store.called('updateBody')).toBe(bodyWrites);
    expect(store.called('insertVersion')).toBe(versionWrites);
    expect(store.pages.get(page.id)!.revision).toBe(1);
  });

  it('keeps the restore row and its number when the cap prunes its source', async () => {
    const page = await createPage(store, clock, scope);
    for (let n = 2; n <= PAGE_VERSION_CAP; n += 1) {
      await store.insertVersion({
        workspaceId: 'w1',
        projectId: 'p1',
        pageId: page.id,
        number: n,
        authorId: 'seed',
        bodyState: emptyState(),
        bodyMarkdown: '',
        startedAt: clock.current,
        savedAt: clock.current,
        restoredFromVersionId: null,
        restoredFromNumber: null,
      });
    }
    const result = await restorePageVersion(store, clock, {
      pageId: page.id,
      number: 1,
      actorId: 'A',
    });
    const restored = store.versionsOf(page.id).at(-1)!;
    expect(restored.id).toBe(result.version.id);
    expect(restored).toMatchObject({ restoredFromVersionId: null, restoredFromNumber: 1 });
    expect(store.versionsOf(page.id)).toHaveLength(PAGE_VERSION_CAP);
  });
});

describe('stateToUpdate', () => {
  it('converges with an editor holding an OLDER copy and a pending edit, in either order', async () => {
    const page = await createPage(store, clock, scope);
    await write(page.id, 'A', 'alpha\n\nbeta');
    const v1Markdown = 'alpha\n\nbeta';
    advance(11 * MINUTE);
    // The editor opened the page here and holds this older state.
    const older = store.pages.get(page.id)!.bodyState;
    await write(page.id, 'A', 'alpha\n\nbeta\n\ngamma');
    const current = store.pages.get(page.id)!.bodyState;
    expect(stateToMarkdown(current)).toBe('alpha\n\nbeta\n\ngamma');

    const restore = stateToUpdate(current, store.versionsOf(page.id)[0]!.bodyState);
    expect(stateToMarkdown(applyUpdate(current, restore))).toBe(v1Markdown);

    // The editor's own pending edit, made against its older copy.
    const pending = markdownToUpdate(older, 'alpha\n\nbeta\n\ndelta');
    const catchUp = Y.encodeStateAsUpdate(
      (() => {
        const d = new Y.Doc();
        Y.applyUpdate(d, current);
        return d;
      })(),
    );

    // Order 1: server state ← restore ← pending.
    const a = applyUpdate(applyUpdate(current, restore), pending);
    // Order 2: editor's older copy ← pending ← catch-up ← restore.
    const b = applyUpdate(applyUpdate(applyUpdate(older, pending), catchUp), restore);

    const docOf = (s: Uint8Array) => {
      const d = new Y.Doc();
      Y.applyUpdate(d, s);
      return d.getXmlFragment(PAGE_FRAGMENT).toString();
    };
    expect(docOf(a)).toBe(docOf(b));
    expect(stateToMarkdown(a)).toBe(stateToMarkdown(b));
  });
});

describe('restore derives the RESTORED body’s links (MOTIR-7570)', () => {
  it('passes the restored version’s mentions and the restoring actor, not the pre-restore ones', async () => {
    const page = await createPage(store, clock, scope);
    advance(MINUTE);
    await write(page.id, 'A', 'Spec for [MOTIR-9](motir:ckrestored000000000000009).');
    advance(11 * MINUTE);
    await write(page.id, 'A', 'Mention removed.');
    expect(store.calls.at(-1)).toEqual({ method: 'replaceDerivedLinks', args: [page.id, [], 'A'] });
    advance(MINUTE);

    await restorePageVersion(store, clock, { pageId: page.id, number: 1, actorId: 'B' });

    expect(store.calls.at(-1)).toEqual({
      method: 'replaceDerivedLinks',
      args: [page.id, [{ workItemId: 'ckrestored000000000000009', source: 'mention' }], 'B'],
    });
  });

  it('a refused restore writes no links', async () => {
    const page = await createPage(store, clock, scope);
    const before = store.called('replaceDerivedLinks');
    await expect(
      restorePageVersion(store, clock, { pageId: page.id, number: 99, actorId: 'B' }),
    ).rejects.toBeInstanceOf(PageVersionNotFoundError);
    expect(store.called('replaceDerivedLinks')).toBe(before);
  });
});
