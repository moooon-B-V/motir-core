import { beforeEach, describe, expect, it } from 'vitest';
import {
  PageHoldsFrozenVersionError,
  archivePage,
  assertPageDeletable,
  createPage,
  deletePage,
} from '../src';
import { FixedClock, MemoryPageStore } from './fakes/memoryPageStore';

// The DELETE GUARD (Story MOTIR-5761 · MOTIR-7431), `docs/decisions/pages.md`
// AMENDMENT 3: a page holding a FROZEN version — the text a person approved for
// a decision — is never deleted.

const scope = { workspaceId: 'w1', projectId: 'p1', actorId: 'u1' };

let store: MemoryPageStore;
let clock: FixedClock;

beforeEach(() => {
  store = new MemoryPageStore();
  clock = new FixedClock();
});

const refused = (p: Promise<unknown>) => p.then(() => undefined).catch((err: unknown) => err);

async function pageWithVersion(marks: { sealedAt?: Date; frozenAt?: Date } = {}) {
  const page = await createPage(store, clock, { ...scope, title: 'Decision' });
  const [v1] = store.versionsOf(page.id);
  store.markVersion(v1!.id, marks);
  return page.id;
}

describe('assertPageDeletable', () => {
  it('returns for a page with no frozen version, sealed or not', async () => {
    const plain = await pageWithVersion();
    const sealed = await pageWithVersion({ sealedAt: clock.current });
    await expect(assertPageDeletable(store, plain)).resolves.toBeUndefined();
    await expect(assertPageDeletable(store, [plain, sealed])).resolves.toBeUndefined();
  });

  it('refuses PAGE_HOLDS_FROZEN_VERSION (409) for a page with a frozen version, naming it', async () => {
    const plain = await pageWithVersion();
    const frozen = await pageWithVersion({ sealedAt: clock.current, frozenAt: clock.current });
    const err = await refused(assertPageDeletable(store, [plain, frozen]));
    expect(err).toBeInstanceOf(PageHoldsFrozenVersionError);
    expect(err).toMatchObject({ code: 'PAGE_HOLDS_FROZEN_VERSION', status: 409, pageId: frozen });
  });
});

describe('deletePage under the guard', () => {
  it('refuses an archive set whose SUB-PAGE holds a frozen version, deleting nothing', async () => {
    const root = (await createPage(store, clock, { ...scope, title: 'Root' })).id;
    const child = (
      await createPage(store, clock, {
        ...scope,
        title: 'Child',
        parent: { kind: 'page', pageId: root },
      })
    ).id;
    const [cv] = store.versionsOf(child);
    store.markVersion(cv!.id, { sealedAt: clock.current, frozenAt: clock.current });
    await archivePage(store, clock, { pageId: root, projectId: 'p1', actorId: 'u1' });
    store.calls.length = 0;

    const err = await refused(deletePage(store, { pageId: root, projectId: 'p1', actorId: 'u1' }));

    expect(err).toBeInstanceOf(PageHoldsFrozenVersionError);
    expect(err).toMatchObject({ pageId: child });
    expect(store.called('deletePages')).toBe(0);
    expect(store.pages.has(root)).toBe(true);
  });
});
