import { beforeEach, describe, expect, it } from 'vitest';
import {
  PAGE_BODY_MAX_BYTES,
  PAGE_SAVE_MAX_BYTES,
  PAGE_TITLE_MAX_LENGTH,
  PageBodyTooLargeError,
  PageError,
  PageNotFoundError,
  PageTitleTooLongError,
  PageUpdateMalformedError,
  applyUpdate,
  createPage,
  emptyState,
  markdownToUpdate,
  renamePage,
  savePageUpdate,
  stateToMarkdown,
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
