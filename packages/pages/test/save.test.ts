import { beforeEach, describe, expect, it } from 'vitest';
import {
  CrossProjectPageParentError,
  PAGE_DEPTH_LIMIT,
  PageDepthExceededError,
  PageFolderNotFoundError,
  PAGE_BODY_MAX_BYTES,
  PAGE_SAVE_MAX_BYTES,
  PAGE_TITLE_MAX_LENGTH,
  PageBodyTooLargeError,
  PageError,
  PageNotFoundError,
  PageRevisionConflictError,
  PageTitleTooLongError,
  PageUpdateMalformedError,
  applyUpdate,
  createPage,
  emptyState,
  markdownToUpdate,
  renamePage,
  parseMarkdown,
  savePageMarkdown,
  savePageUpdate,
  serializeMarkdown,
  stateToMarkdown,
  type LockedPageRow,
} from '../src';
import { FixedClock, MemoryPageStore } from './fakes/memoryPageStore';

const scope = { workspaceId: 'w1', projectId: 'p1', actorId: 'u1' };

let store: MemoryPageStore;
let clock: FixedClock;

beforeEach(() => {
  store = new MemoryPageStore();
  clock = new FixedClock();
});

/** A page whose body reads as `markdown`, at revision 1. */
async function pageWith(markdown: string) {
  const page = await createPage(store, clock, scope);
  if (markdown) {
    await savePageUpdate(store, clock, {
      pageId: page.id,
      actorId: 'u1',
      update: markdownToUpdate(emptyState(), markdown),
    });
  }
  return store.pages.get(page.id)!;
}

describe('createPage', () => {
  it('creates root pages in creation order, each empty at revision 1 with its formats', async () => {
    const first = await createPage(store, clock, { ...scope, title: '  Plan  ' });
    const second = await createPage(store, clock, scope);

    expect(first.position < second.position).toBe(true);
    for (const page of [first, second]) {
      const stored = store.pages.get(page.id)!;
      expect(stored).toMatchObject({
        revision: 1,
        parentPageId: null,
        folderId: null,
        ancestorPageIds: [],
        bodyMarkdown: '',
        bodyText: '',
        bodyJson: { type: 'doc', content: [{ type: 'paragraph' }] },
        createdById: 'u1',
        updatedById: 'u1',
        createdAt: clock.current,
      });
      expect(stateToMarkdown(stored.bodyState)).toBe('');
    }
    expect(first.title).toBe('Plan');
    expect(second.title).toBe('');
  });

  it('locks the root sibling set before reading its last position', async () => {
    await createPage(store, clock, scope);
    const methods = store.calls.map((call) => call.method);
    expect(methods.slice(0, 3)).toEqual(['lockSiblings', 'lastSiblingPosition', 'insertPage']);
    expect(store.calls[0]!.args).toEqual(['p1', { kind: 'root' }]);
  });

  it('refuses an over-long title before touching the store', async () => {
    await expect(
      createPage(store, clock, { ...scope, title: 'x'.repeat(PAGE_TITLE_MAX_LENGTH + 1) }),
    ).rejects.toBeInstanceOf(PageTitleTooLongError);
    expect(store.calls).toEqual([]);
  });
});

describe('createPage — placement', () => {
  it('files a page in a folder: a folder id, no parent page, a chain of its own', async () => {
    store.addFolder('f1', 'p1');
    await createPage(store, clock, { ...scope, title: 'Root page' });
    const first = await createPage(store, clock, {
      ...scope,
      parent: { kind: 'folder', folderId: 'f1' },
    });
    const second = await createPage(store, clock, {
      ...scope,
      parent: { kind: 'folder', folderId: 'f1' },
    });

    expect(first).toMatchObject({ folderId: 'f1', parentPageId: null, ancestorPageIds: [] });
    expect(first.position < second.position).toBe(true);
    expect(store.calls.filter((c) => c.method === 'lockSiblings').at(-1)!.args).toEqual([
      'p1',
      { kind: 'folder', folderId: 'f1' },
    ]);
  });

  it('creates a sub-page under a page: no folder id, the parent chain plus the parent', async () => {
    store.addFolder('f1', 'p1');
    const top = await createPage(store, clock, {
      ...scope,
      parent: { kind: 'folder', folderId: 'f1' },
    });
    const child = await createPage(store, clock, {
      ...scope,
      parent: { kind: 'page', pageId: top.id },
    });
    const grandchild = await createPage(store, clock, {
      ...scope,
      parent: { kind: 'page', pageId: child.id },
    });

    expect(child).toMatchObject({ parentPageId: top.id, folderId: null });
    expect(child.ancestorPageIds).toEqual([top.id]);
    expect(grandchild.ancestorPageIds).toEqual([top.id, child.id]);
  });

  it('refuses a page at level 11, writing nothing', async () => {
    let parent = await createPage(store, clock, scope);
    for (let level = 2; level <= PAGE_DEPTH_LIMIT; level += 1) {
      parent = await createPage(store, clock, {
        ...scope,
        parent: { kind: 'page', pageId: parent.id },
      });
    }
    const inserts = store.called('insertPage');
    const err = await createPage(store, clock, {
      ...scope,
      parent: { kind: 'page', pageId: parent.id },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PageDepthExceededError);
    expect(err).toMatchObject({ limit: 10, attemptedLevel: 11 });
    expect(store.called('insertPage')).toBe(inserts);
  });

  it('refuses a missing parent and a parent in another project, writing nothing', async () => {
    store.addFolder('fx', 'p2');
    const elsewhere = await createPage(store, clock, { ...scope, projectId: 'p2' });
    const inserts = store.called('insertPage');

    await expect(
      createPage(store, clock, { ...scope, parent: { kind: 'folder', folderId: 'gone' } }),
    ).rejects.toBeInstanceOf(PageFolderNotFoundError);
    await expect(
      createPage(store, clock, { ...scope, parent: { kind: 'page', pageId: 'gone' } }),
    ).rejects.toBeInstanceOf(PageNotFoundError);
    await expect(
      createPage(store, clock, { ...scope, parent: { kind: 'folder', folderId: 'fx' } }),
    ).rejects.toBeInstanceOf(CrossProjectPageParentError);
    await expect(
      createPage(store, clock, { ...scope, parent: { kind: 'page', pageId: elsewhere.id } }),
    ).rejects.toBeInstanceOf(CrossProjectPageParentError);
    expect(store.called('insertPage')).toBe(inserts);
  });
});

describe('renamePage', () => {
  it('trims whitespace and records who renamed', async () => {
    const page = await createPage(store, clock, scope);
    const renamed = await renamePage(store, {
      pageId: page.id,
      actorId: 'u2',
      title: '  Notes \n',
    });
    expect(renamed).toMatchObject({ title: 'Notes', updatedById: 'u2' });
  });

  it('admits a title of exactly the limit and refuses one character more', async () => {
    const page = await createPage(store, clock, scope);
    await expect(
      renamePage(store, { pageId: page.id, actorId: 'u1', title: 'x'.repeat(255) }),
    ).resolves.toMatchObject({ title: 'x'.repeat(255) });

    const refusal = await renamePage(store, {
      pageId: page.id,
      actorId: 'u1',
      title: 'x'.repeat(256),
    }).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(PageTitleTooLongError);
    expect(refusal).toBeInstanceOf(PageError);
    expect(refusal).toMatchObject({
      code: 'PAGE_TITLE_TOO_LONG',
      status: 422,
      limit: 255,
      length: 256,
    });
  });

  it('refuses an empty update as malformed before taking the lock', async () => {
    const page = await createPage(store, clock, scope);
    const refusal = await savePageUpdate(store, clock, {
      pageId: page.id,
      actorId: 'u1',
      update: new Uint8Array(0),
    }).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(PageUpdateMalformedError);
    expect(refusal).toBeInstanceOf(PageError);
    expect(refusal).toMatchObject({ code: 'PAGE_UPDATE_MALFORMED', status: 400, reason: 'empty' });
    expect(store.called('lockPage')).toBe(0);
    expect(store.called('updateBody')).toBe(0);
  });

  it('refuses bytes Yjs cannot decode as malformed, writing nothing', async () => {
    const seeded = await pageWith('Kept.');
    const writesBefore = store.called('updateBody');
    const refusal = await savePageUpdate(store, clock, {
      pageId: seeded.id,
      actorId: 'u1',
      update: new Uint8Array([1, 2, 3]),
    }).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(PageUpdateMalformedError);
    expect(refusal).toMatchObject({ code: 'PAGE_UPDATE_MALFORMED', reason: 'undecodable' });
    expect(store.called('updateBody')).toBe(writesBefore);
    const stored = store.pages.get(seeded.id)!;
    expect(stored.revision).toBe(2);
    expect(stateToMarkdown(stored.bodyState)).toBe('Kept.');
  });

  it('refuses an unknown page', async () => {
    await expect(
      renamePage(store, { pageId: 'nope', actorId: 'u1', title: 'x' }),
    ).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND', status: 404, pageId: 'nope' });
  });
});

describe('savePageUpdate', () => {
  it('writes state, JSON, markdown and text in ONE updateBody, one revision higher', async () => {
    const page = await createPage(store, clock, scope);
    clock.current = new Date('2026-10-01T12:05:00Z');
    const revision = await savePageUpdate(store, clock, {
      pageId: page.id,
      actorId: 'u2',
      update: markdownToUpdate(emptyState(), '# Hello\n\nWorld'),
    });

    expect(revision).toBe(2);
    expect(store.called('updateBody')).toBe(1);
    const stored = store.pages.get(page.id)!;
    expect(stored).toMatchObject({
      revision: 2,
      bodyMarkdown: '# Hello\n\nWorld',
      bodyText: 'Hello\nWorld',
      updatedById: 'u2',
      updatedAt: clock.current,
    });
    expect(stored.bodyMarkdown).toBe(stateToMarkdown(stored.bodyState));
    expect((stored.bodyJson as { content: unknown[] }).content).toHaveLength(2);
    expect(store.calls.at(-1)).toEqual({ method: 'replaceDerivedLinks', args: [page.id, []] });
  });

  it('keeps both of two independent edits, in either order', async () => {
    for (const order of [
      ['a', 'b'],
      ['b', 'a'],
    ] as const) {
      store = new MemoryPageStore();
      const page = await pageWith('Alpha\n\nBeta');
      const updates = {
        a: markdownToUpdate(page.bodyState, 'Alpha one\n\nBeta'),
        b: markdownToUpdate(page.bodyState, 'Alpha\n\nBeta two'),
      };
      for (const which of order) {
        await savePageUpdate(store, clock, {
          pageId: page.id,
          actorId: 'u1',
          update: updates[which],
        });
      }
      expect(store.pages.get(page.id)!.bodyMarkdown).toBe('Alpha one\n\nBeta two');
      expect(store.pages.get(page.id)!.revision).toBe(4);
    }
  });

  it('refuses a request over the save cap before taking the lock', async () => {
    const page = await createPage(store, clock, scope);
    const refusal = await savePageUpdate(store, clock, {
      pageId: page.id,
      actorId: 'u1',
      update: new Uint8Array(PAGE_SAVE_MAX_BYTES + 1),
    }).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(PageBodyTooLargeError);
    expect(refusal).toMatchObject({
      code: 'PAGE_BODY_TOO_LARGE',
      status: 413,
      limit: 1_048_576,
      size: PAGE_SAVE_MAX_BYTES + 1,
    });
    expect(store.called('lockPage')).toBe(0);
    expect(store.called('updateBody')).toBe(0);
  });

  it('refuses a merge that would pass the body cap, writing nothing', async () => {
    // Each request stays under the save cap; the body grows past 1.5 MiB in two.
    const seeded = await pageWith('x'.repeat(900_000));
    await savePageUpdate(store, clock, {
      pageId: seeded.id,
      actorId: 'u1',
      update: markdownToUpdate(seeded.bodyState, `${'x'.repeat(900_000)}${'y'.repeat(700_000)}`),
    });
    const page = store.pages.get(seeded.id)!;
    const writesBefore = store.called('updateBody');
    const update = markdownToUpdate(
      page.bodyState,
      `${'x'.repeat(900_000)}${'y'.repeat(700_000)}${'z'.repeat(700_000)}`,
    );
    expect(update.byteLength).toBeLessThanOrEqual(PAGE_SAVE_MAX_BYTES);
    const reached = applyUpdate(page.bodyState, update).byteLength;

    const refusal = await savePageUpdate(store, clock, {
      pageId: page.id,
      actorId: 'u1',
      update,
    }).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(PageBodyTooLargeError);
    expect(refusal).toMatchObject({ limit: 2_097_152, size: reached });
    expect(reached).toBeGreaterThan(PAGE_BODY_MAX_BYTES);
    expect(store.called('updateBody')).toBe(writesBefore);
    expect(store.pages.get(page.id)!.revision).toBe(3);
  });

  it('refuses an empty update as malformed before taking the lock', async () => {
    const page = await createPage(store, clock, scope);
    const refusal = await savePageUpdate(store, clock, {
      pageId: page.id,
      actorId: 'u1',
      update: new Uint8Array(0),
    }).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(PageUpdateMalformedError);
    expect(refusal).toBeInstanceOf(PageError);
    expect(refusal).toMatchObject({ code: 'PAGE_UPDATE_MALFORMED', status: 400, reason: 'empty' });
    expect(store.called('lockPage')).toBe(0);
    expect(store.called('updateBody')).toBe(0);
  });

  it('refuses bytes Yjs cannot decode as malformed, writing nothing', async () => {
    const seeded = await pageWith('Kept.');
    const writesBefore = store.called('updateBody');
    const refusal = await savePageUpdate(store, clock, {
      pageId: seeded.id,
      actorId: 'u1',
      update: new Uint8Array([1, 2, 3]),
    }).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(PageUpdateMalformedError);
    expect(refusal).toMatchObject({ code: 'PAGE_UPDATE_MALFORMED', reason: 'undecodable' });
    expect(store.called('updateBody')).toBe(writesBefore);
    const stored = store.pages.get(seeded.id)!;
    expect(stored.revision).toBe(2);
    expect(stateToMarkdown(stored.bodyState)).toBe('Kept.');
  });

  it('refuses an unknown page', async () => {
    await expect(
      savePageUpdate(store, clock, { pageId: 'nope', actorId: 'u1', update: new Uint8Array(2) }),
    ).rejects.toBeInstanceOf(PageNotFoundError);
    expect(store.called('updateBody')).toBe(0);
  });
});

/** `n` short paragraphs: tiny as markdown, about ten times that as a Yjs state. */
const paragraphs = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `${tag}${i % 10}`).join('\n\n');

/** Puts `markdown` straight into a page's stored state, past every cap — a fixture, not a save. */
function seedBody(pageId: string, markdown: string) {
  const page = store.pages.get(pageId)!;
  store.pages.set(pageId, {
    ...page,
    bodyState: applyUpdate(page.bodyState, markdownToUpdate(page.bodyState, markdown)),
  });
}

// The two size refusals below build a body near the 1–2 MiB caps, which takes a
// few seconds bare and several times that under the coverage instrumentation CI
// runs this package with — over vitest's 5s default (MOTIR-7413). The time is
// the fixture's, not the code under test's, so it is given room rather than a
// smaller body that would no longer reach the cap.
const HEAVY_BODY_TIMEOUT_MS = 60_000;

describe('savePageMarkdown (§3, §8.2, MOTIR-7408)', () => {
  const markdown = [
    '# Runbook',
    '',
    'Steps:',
    '',
    '- one',
    '- two',
    '',
    '```ts',
    'const x = 1;',
    '```',
  ].join('\n');

  it('replaces the body at the revision the caller read: one revision higher, one version write', async () => {
    const page = await pageWith('Old body.');
    clock.current = new Date('2026-10-01T12:05:00Z');
    const versionWrites = store.called('insertVersion') + store.called('updateVersion');

    const revision = await savePageMarkdown(store, clock, {
      pageId: page.id,
      actorId: 'u2',
      markdown,
      expectedRevision: 2,
    });

    expect(revision).toBe(3);
    const stored = store.pages.get(page.id)!;
    expect(stateToMarkdown(stored.bodyState)).toBe(serializeMarkdown(parseMarkdown(markdown)));
    expect(stored).toMatchObject({
      revision: 3,
      bodyMarkdown: stateToMarkdown(stored.bodyState),
      updatedById: 'u2',
      updatedAt: clock.current,
    });
    expect(store.called('insertVersion') + store.called('updateVersion')).toBe(versionWrites + 1);
    expect(store.calls.at(-1)).toEqual({ method: 'replaceDerivedLinks', args: [page.id, []] });
  });

  it('still saves an identical body: the revision moves, and the version is extended', async () => {
    const page = await pageWith('Same.');
    const before = store.versionsOf(page.id).length;
    const revision = await savePageMarkdown(store, clock, {
      pageId: page.id,
      actorId: 'u1',
      markdown: 'Same.',
      expectedRevision: 2,
    });
    expect(revision).toBe(3);
    expect(store.called('updateBody')).toBe(2);
    expect(store.versionsOf(page.id)).toHaveLength(before);
    expect(stateToMarkdown(store.pages.get(page.id)!.bodyState)).toBe('Same.');
  });

  it('refuses a stale revision by name, writing no body, no version and no links', async () => {
    const page = await pageWith('A person wrote this.');
    const writes = (
      ['updateBody', 'insertVersion', 'updateVersion', 'replaceDerivedLinks'] as const
    ).map((m) => store.called(m));

    const refusal = await savePageMarkdown(store, clock, {
      pageId: page.id,
      actorId: 'agent',
      markdown: 'An agent overwrote it.',
      expectedRevision: 1,
    }).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(PageRevisionConflictError);
    expect(refusal).toBeInstanceOf(PageError);
    expect(refusal).toMatchObject({
      code: 'PAGE_REVISION_CONFLICT',
      status: 409,
      expected: 1,
      actual: 2,
    });
    expect((refusal as Error).message).toContain('revision 2');
    expect((refusal as Error).message).toContain('revision 1');
    expect(
      (['updateBody', 'insertVersion', 'updateVersion', 'replaceDerivedLinks'] as const).map((m) =>
        store.called(m),
      ),
    ).toEqual(writes);
    expect(stateToMarkdown(store.pages.get(page.id)!.bodyState)).toBe('A person wrote this.');
  });

  it('decides the conflict UNDER the lock: a save landing between the read and the lock is not overwritten', async () => {
    const page = await pageWith('Read by the agent.');
    // The caller read revision 2. An editor save lands before `lockPage` returns.
    const editorUpdate = markdownToUpdate(page.bodyState, 'Edited by a person.');
    class RacingStore extends MemoryPageStore {
      override async lockPage(pageId: string): Promise<LockedPageRow | null> {
        const current = this.pages.get(pageId)!;
        this.pages.set(pageId, {
          ...current,
          bodyState: applyUpdate(current.bodyState, editorUpdate),
          revision: current.revision + 1,
        });
        return super.lockPage(pageId);
      }
    }
    const racing = new RacingStore();
    racing.pages.set(page.id, page);

    const refusal = await savePageMarkdown(racing, clock, {
      pageId: page.id,
      actorId: 'agent',
      markdown: 'The agent replaced it.',
      expectedRevision: 2,
    }).catch((err: unknown) => err);

    expect(refusal).toMatchObject({ code: 'PAGE_REVISION_CONFLICT', expected: 2, actual: 3 });
    expect(racing.called('updateBody')).toBe(0);
    expect(stateToMarkdown(racing.pages.get(page.id)!.bodyState)).toBe('Edited by a person.');
  });

  it('refuses markdown over the save cap before taking the lock', async () => {
    const page = await createPage(store, clock, scope);
    // Multi-byte characters: the cap is UTF-8 bytes, not string length.
    const big = 'é'.repeat(PAGE_SAVE_MAX_BYTES / 2 + 1);
    expect(big.length).toBeLessThan(PAGE_SAVE_MAX_BYTES);

    const refusal = await savePageMarkdown(store, clock, {
      pageId: page.id,
      actorId: 'u1',
      markdown: big,
      expectedRevision: 1,
    }).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(PageBodyTooLargeError);
    expect(refusal).toMatchObject({
      code: 'PAGE_BODY_TOO_LARGE',
      limit: PAGE_SAVE_MAX_BYTES,
      size: PAGE_SAVE_MAX_BYTES + 2,
    });
    expect(store.called('lockPage')).toBe(0);
    expect(store.called('updateBody')).toBe(0);
  });

  it(
    'refuses an update over the save cap after the lock, writing nothing',
    async () => {
      const page = await createPage(store, clock, scope);
      const markdownIn = paragraphs(40_000, 'p');
      expect(new TextEncoder().encode(markdownIn).byteLength).toBeLessThan(PAGE_SAVE_MAX_BYTES);

      const refusal = await savePageMarkdown(store, clock, {
        pageId: page.id,
        actorId: 'u1',
        markdown: markdownIn,
        expectedRevision: 1,
      }).catch((err: unknown) => err);

      expect(refusal).toMatchObject({ code: 'PAGE_BODY_TOO_LARGE', limit: PAGE_SAVE_MAX_BYTES });
      expect((refusal as PageBodyTooLargeError).size).toBeGreaterThan(PAGE_SAVE_MAX_BYTES);
      expect(store.called('lockPage')).toBe(1);
      expect(store.called('updateBody')).toBe(0);
      expect(store.called('insertVersion')).toBe(1);
    },
    HEAVY_BODY_TIMEOUT_MS,
  );

  it(
    'refuses a merged state over the body cap after the lock, writing nothing',
    async () => {
      const page = await createPage(store, clock, scope);
      const kept = paragraphs(32_000, 'a');
      seedBody(page.id, kept);
      const seeded = store.pages.get(page.id)!;
      const next = `${kept}\n\n${paragraphs(22_000, 'b')}`;
      const update = markdownToUpdate(seeded.bodyState, next);
      expect(update.byteLength).toBeLessThanOrEqual(PAGE_SAVE_MAX_BYTES);
      const reached = applyUpdate(seeded.bodyState, update).byteLength;
      expect(reached).toBeGreaterThan(PAGE_BODY_MAX_BYTES);

      const refusal = await savePageMarkdown(store, clock, {
        pageId: page.id,
        actorId: 'u1',
        markdown: next,
        expectedRevision: 1,
      }).catch((err: unknown) => err);

      expect(refusal).toBeInstanceOf(PageBodyTooLargeError);
      expect(refusal).toMatchObject({ limit: PAGE_BODY_MAX_BYTES, size: reached });
      expect(store.called('lockPage')).toBe(1);
      expect(store.called('updateBody')).toBe(0);
      expect(store.called('replaceDerivedLinks')).toBe(0);
      expect(store.pages.get(page.id)!.revision).toBe(1);
    },
    HEAVY_BODY_TIMEOUT_MS,
  );

  it('refuses an unknown page', async () => {
    await expect(
      savePageMarkdown(store, clock, {
        pageId: 'nope',
        actorId: 'u1',
        markdown: 'x',
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(PageNotFoundError);
    expect(store.called('updateBody')).toBe(0);
  });
});

describe('every write leaves a version (§6, MOTIR-5754)', () => {
  it('createPage leaves exactly one version, number 1, by the creator, holding the empty state', async () => {
    const page = await createPage(store, clock, scope);
    const versions = store.versions.filter((v) => v.pageId === page.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      number: 1,
      authorId: 'u1',
      bodyMarkdown: '',
      startedAt: clock.current,
      savedAt: clock.current,
      restoredFromVersionId: null,
      restoredFromNumber: null,
    });
    expect(stateToMarkdown(versions[0]!.bodyState)).toBe('');
  });

  // The guard against Plane's silently broken version task: a save that writes
  // a body and no version FAILS here, whichever branch the policy took.
  it('a save writes either a new version or an extension, every time', async () => {
    const page = await createPage(store, clock, scope);
    for (const [actorId, gapMs] of [
      ['u1', 60_000],
      ['u1', 60_000],
      ['u2', 60_000],
      ['u2', 11 * 60_000],
    ] as const) {
      clock.current = new Date(clock.current.getTime() + gapMs);
      const before = store.called('insertVersion') + store.called('updateVersion');
      await savePageUpdate(store, clock, {
        pageId: page.id,
        actorId,
        update: markdownToUpdate(store.pages.get(page.id)!.bodyState, `by ${actorId} ${gapMs}`),
      });
      expect(store.called('insertVersion') + store.called('updateVersion')).toBe(before + 1);
    }
  });
});
