import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { toPageLevelRow, type PageLevelRecord, type PageLevelRow } from '@/lib/mappers/pageMappers';
import {
  createPage,
  emptyState,
  markdownToUpdate,
  movePage,
  pageStoreFor,
  type PagePlacement,
  renamePage,
  savePageUpdate,
  stateToMarkdown,
  systemClock,
} from '@/lib/pages';
import { pageRepository, type PageParentRef } from '@/lib/repositories/pageRepository';
import { pageVersionRepository } from '@/lib/repositories/pageVersionRepository';
import { pagesService } from '@/lib/services/pagesService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The `PageStore` ADAPTER on real Postgres (Story MOTIR-5752 · MOTIR-7276):
// `@motir/pages`' procedures running against `pageStoreFor(tx)` inside
// `withWorkspaceContext`, the row lock a save depends on, and the `bytea`
// round-trip through the mapper. And the PLACEMENT half (Story MOTIR-5753 ·
// MOTIR-7369): pages under folders and pages, the one-statement subtree rewrite,
// the keyset level read, folder visibility under RLS, and the project's
// structure lock under real concurrency — two pooled connections, no mocks.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Tenant {
  userId: string;
  workspaceId: string;
  projectId: string;
}

async function makeTenant(tag: string): Promise<Tenant> {
  const user = await usersService.createUser({
    email: `page-adapter-${tag}@example.com`,
    password: 'hunter2hunter2',
    name: `Page Adapter ${tag}`,
  });
  const ws = await workspacesService.createWorkspace({
    name: `Page Adapter ${tag}`,
    ownerUserId: user.id,
  });
  const project = await projectsService.createProject({
    workspaceId: ws.workspace.id,
    actorUserId: user.id,
    name: `Page Adapter ${tag}`,
    identifier: `PA${tag.toUpperCase()}`,
  });
  return { userId: user.id, workspaceId: ws.workspace.id, projectId: project.id };
}

const inTenant = <T>(t: Tenant, fn: Parameters<typeof withWorkspaceContext<T>>[1]) =>
  withWorkspaceContext(
    { userId: t.userId, workspaceId: t.workspaceId, projectId: t.projectId },
    fn,
  );

const create = (t: Tenant, title?: string) =>
  inTenant(t, (tx) =>
    createPage(pageStoreFor(tx), systemClock, {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      actorId: t.userId,
      title,
    }),
  );

const save = (t: Tenant, pageId: string, update: Uint8Array) =>
  inTenant(t, (tx) =>
    savePageUpdate(pageStoreFor(tx), systemClock, { pageId, actorId: t.userId, update }),
  );

describe('pageStoreFor(tx) — the package procedures on real Postgres', () => {
  it('creates, saves and renames a page, reading each back', async () => {
    const t = await makeTenant('one');
    const first = await create(t, ' Plan ');
    const second = await create(t);
    expect(first.position < second.position).toBe(true);

    const created = await adminDb.page.findUniqueOrThrow({ where: { id: first.id } });
    expect(created).toMatchObject({
      title: 'Plan',
      revision: 1,
      bodyMarkdown: '',
      bodyText: '',
      bodyJson: { type: 'doc', content: [{ type: 'paragraph' }] },
      createdById: t.userId,
    });

    const revision = await save(t, first.id, markdownToUpdate(emptyState(), '# Hi\n\n- [x] done'));
    expect(revision).toBe(2);
    const saved = await adminDb.page.findUniqueOrThrow({ where: { id: first.id } });
    expect(saved).toMatchObject({
      revision: 2,
      bodyMarkdown: '# Hi\n\n- [x] done',
      bodyText: 'Hi\ndone',
    });
    expect(stateToMarkdown(new Uint8Array(saved.bodyState))).toBe('# Hi\n\n- [x] done');

    const renamed = await inTenant(t, (tx) =>
      renamePage(pageStoreFor(tx), { pageId: first.id, actorId: t.userId, title: 'Roadmap' }),
    );
    expect(renamed).toMatchObject({ id: first.id, title: 'Roadmap', revision: 2 });
    await expect(
      inTenant(t, (tx) =>
        renamePage(pageStoreFor(tx), { pageId: 'missing', actorId: t.userId, title: 'x' }),
      ),
    ).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' });
    expect(await inTenant(t, (tx) => pageStoreFor(tx).findPage(first.id))).toMatchObject({
      title: 'Roadmap',
    });
  });

  it('serialises two saves on the row lock: the second merges onto the first', async () => {
    const t = await makeTenant('two');
    const page = await create(t);
    await save(t, page.id, markdownToUpdate(emptyState(), 'Alpha\n\nBeta'));
    const base = (await adminDb.page.findUniqueOrThrow({ where: { id: page.id } })).bodyState;
    const a = markdownToUpdate(new Uint8Array(base), 'Alpha one\n\nBeta');
    const b = markdownToUpdate(new Uint8Array(base), 'Alpha\n\nBeta two');

    let locked!: () => void;
    const firstHoldsLock = new Promise<void>((resolve) => (locked = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));

    const first = inTenant(t, async (tx) => {
      const revision = await savePageUpdate(pageStoreFor(tx), systemClock, {
        pageId: page.id,
        actorId: t.userId,
        update: a,
      });
      locked();
      await released;
      return revision;
    });
    await firstHoldsLock;

    let secondDone = false;
    const second = save(t, page.id, b).then((revision) => {
      secondDone = true;
      return revision;
    });
    // The second save is parked on `FOR UPDATE` until the first commits — prove
    // it is waiting on the lock and not merely slow, by reading pg's own view.
    await expect
      .poll(
        async () =>
          (
            await adminDb.$queryRaw<Array<{ n: bigint }>>`
              SELECT count(*) AS n FROM pg_stat_activity
               WHERE wait_event_type = 'Lock' AND query LIKE '%FROM "page"%FOR UPDATE%'
            `
          )[0]!.n,
      )
      .toBe(BigInt(1));
    expect(secondDone).toBe(false);

    release();
    expect(await first).toBe(3);
    expect(await second).toBe(4);
    const merged = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });
    expect(merged.bodyMarkdown).toBe('Alpha one\n\nBeta two');
  });

  it('cannot lock another workspace’s page under the non-bypass role', async () => {
    const mine = await makeTenant('mine');
    const theirs = await makeTenant('theirs');
    const page = await create(theirs);

    const seen = await inTenant(mine, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return pageRepository.lockById(page.id, tx);
    });
    expect(seen).toBeNull();

    const own = await inTenant(theirs, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return pageRepository.lockById(page.id, tx);
    });
    expect(own?.id).toBe(page.id);
  });

  it('writes a 1 MiB body through updateBody and reads it back byte for byte', async () => {
    const t = await makeTenant('big');
    const page = await create(t);
    const body = new Uint8Array(1_048_576);
    for (let i = 0; i < body.length; i += 1) body[i] = (i * 131 + 17) & 0xff;

    await inTenant(t, (tx) =>
      pageStoreFor(tx).updateBody(page.id, {
        state: body,
        json: { type: 'doc', content: [] },
        markdown: '',
        text: '',
        revision: 2,
        updatedById: t.userId,
        updatedAt: new Date(),
      }),
    );
    const locked = await inTenant(t, (tx) => pageStoreFor(tx).lockPage(page.id));
    expect(locked!.bodyState).toBeInstanceOf(Uint8Array);
    expect(locked!.bodyState.byteLength).toBe(1_048_576);
    expect(Buffer.from(locked!.bodyState).equals(Buffer.from(body))).toBe(true);
    expect(locked!.revision).toBe(2);
  });

  it('answers the trivial port calls: no links writer yet, null for a missing page', async () => {
    const t = await makeTenant('trivial');
    await expect(
      inTenant(t, (tx) => pageStoreFor(tx).replaceDerivedLinks('p', [], 'u')),
    ).resolves.toBeUndefined();
    expect(await inTenant(t, (tx) => pageStoreFor(tx).lockPage('missing'))).toBeNull();
    expect(await inTenant(t, (tx) => pageStoreFor(tx).findPage('missing'))).toBeNull();
  });
});

// ── Placement (Story MOTIR-5753 · MOTIR-7369) ─────────────────────────────────

const createUnder = (t: Tenant, parent: PagePlacement, title?: string) =>
  inTenant(t, (tx) =>
    createPage(pageStoreFor(tx), systemClock, {
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      actorId: t.userId,
      title,
      parent,
    }),
  );

const move = (
  t: Tenant,
  pageId: string,
  parent: PagePlacement,
  neighbours: { beforeId?: string; afterId?: string } = {},
) =>
  inTenant(t, (tx) =>
    movePage(pageStoreFor(tx), {
      pageId,
      projectId: t.projectId,
      parent,
      actorId: t.userId,
      ...neighbours,
    }),
  );

async function makeFolder(t: Tenant, name: string, projectId = t.projectId) {
  return adminDb.folder.create({
    data: {
      workspaceId: t.workspaceId,
      projectId,
      name,
      position: 'a0',
      createdById: t.userId,
    },
  });
}

/** The backends of THIS database waiting on an advisory lock. */
async function advisoryWaiters(): Promise<number> {
  const rows = await adminDb.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM pg_stat_activity
     WHERE datname = current_database()
       AND wait_event_type = 'Lock' AND wait_event = 'advisory'
  `;
  return Number(rows[0]!.n);
}

/** A latch: `open()` resolves `opened`. */
function latch(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

describe('pageStoreFor(tx) — placing pages under a folder or a page', () => {
  it('inserts a page in a folder and under a page, each last at its own level', async () => {
    const t = await makeTenant('place');
    const folder = await makeFolder(t, 'Specs');

    const filed = await createUnder(t, { kind: 'folder', folderId: folder.id }, 'Filed');
    const filed2 = await createUnder(t, { kind: 'folder', folderId: folder.id }, 'Filed 2');
    const child = await createUnder(t, { kind: 'page', pageId: filed.id }, 'Child');
    const grandchild = await createUnder(t, { kind: 'page', pageId: child.id }, 'Grandchild');
    const root = await createUnder(t, { kind: 'root' }, 'Root');

    expect(filed2.position > filed.position).toBe(true);
    const rows = await adminDb.page.findMany({
      where: { projectId: t.projectId },
      select: { id: true, parentPageId: true, folderId: true, ancestorPageIds: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(filed.id)).toMatchObject({
      parentPageId: null,
      folderId: folder.id,
      ancestorPageIds: [],
    });
    // A sub-page carries no folder id — its parent's chain plus the parent (ADR §4).
    expect(byId.get(child.id)).toMatchObject({
      parentPageId: filed.id,
      folderId: null,
      ancestorPageIds: [filed.id],
    });
    expect(byId.get(grandchild.id)).toMatchObject({
      parentPageId: child.id,
      folderId: null,
      ancestorPageIds: [filed.id, child.id],
    });
    expect(byId.get(root.id)).toMatchObject({ parentPageId: null, folderId: null });

    const last = await inTenant(t, async (tx) => {
      const store = pageStoreFor(tx);
      return {
        root: await store.lastSiblingPosition(t.projectId, { kind: 'root' }),
        folder: await store.lastSiblingPosition(t.projectId, {
          kind: 'folder',
          folderId: folder.id,
        }),
        page: await store.lastSiblingPosition(t.projectId, { kind: 'page', pageId: filed.id }),
        empty: await store.lastSiblingPosition(t.projectId, {
          kind: 'page',
          pageId: grandchild.id,
        }),
      };
    });
    expect(last).toEqual({
      root: root.position,
      folder: filed2.position,
      page: child.position,
      empty: null,
    });
  });

  it('reads the neighbours to mint between, filling an unnamed side from the level', async () => {
    const t = await makeTenant('nbr');
    const parent = await createUnder(t, { kind: 'root' }, 'Parent');
    const under: PagePlacement = { kind: 'page', pageId: parent.id };
    const a = await createUnder(t, under, 'A');
    const b = await createUnder(t, under, 'B');
    const c = await createUnder(t, under, 'C');

    const read = (beforeId: string | null, afterId: string | null, at: PagePlacement = under) =>
      inTenant(t, (tx) => pageStoreFor(tx).siblingNeighbours(t.projectId, at, beforeId, afterId));

    expect(await read(a.id, b.id)).toEqual({ before: a.position, after: b.position });
    expect(await read(a.id, null)).toEqual({ before: a.position, after: b.position });
    expect(await read(c.id, null)).toEqual({ before: c.position, after: null });
    expect(await read(null, c.id)).toEqual({ before: b.position, after: c.position });
    expect(await read(null, a.id)).toEqual({ before: null, after: a.position });
    expect(await read(null, null)).toEqual({ before: c.position, after: null });
    expect(await read(null, null, { kind: 'page', pageId: a.id })).toEqual({
      before: null,
      after: null,
    });
    // Inserting between two named neighbours lands between them.
    const moved = await move(t, c.id, under, { beforeId: a.id, afterId: b.id });
    expect(moved.moved).toBe(true);
    expect(a.position < moved.page.position && moved.page.position < b.position).toBe(true);
  });

  it('moves a three-level subtree and rewrites every descendant’s chain in ONE statement', async () => {
    const t = await makeTenant('rebase');
    const folder = await makeFolder(t, 'Archive');
    const a = await createUnder(t, { kind: 'root' }, 'A');
    const b = await createUnder(t, { kind: 'page', pageId: a.id }, 'B');
    const c = await createUnder(t, { kind: 'page', pageId: b.id }, 'C');
    const d = await createUnder(t, { kind: 'page', pageId: c.id }, 'D');
    const c2 = await createUnder(t, { kind: 'page', pageId: b.id }, 'C2');
    const x = await createUnder(t, { kind: 'root' }, 'X');
    const bystander = await createUnder(t, { kind: 'page', pageId: x.id }, 'Bystander');

    // The repository's statement on its own: B's descendants (C, C2, D) re-rooted
    // under X — three rows, one UPDATE.
    const rewritten = await inTenant(t, (tx) => pageRepository.rebaseDescendants(b.id, [x.id], tx));
    expect(rewritten).toBe(3);
    const chains = async () =>
      new Map(
        (
          await adminDb.page.findMany({
            where: { projectId: t.projectId },
            select: { id: true, ancestorPageIds: true },
          })
        ).map((r) => [r.id, r.ancestorPageIds]),
      );
    let after = await chains();
    expect(after.get(b.id)).toEqual([a.id]); // the page itself is not its own descendant
    expect(after.get(c.id)).toEqual([x.id, b.id]);
    expect(after.get(c2.id)).toEqual([x.id, b.id]);
    expect(after.get(d.id)).toEqual([x.id, b.id, c.id]);
    expect(after.get(bystander.id)).toEqual([x.id]);

    // The whole move through the package: B (with C, C2, D) into the folder.
    const subtree = await inTenant(t, (tx) => pageStoreFor(tx).findSubtree(b.id));
    expect(subtree.map((r) => r.id).sort()).toEqual([c.id, c2.id, d.id].sort());
    const result = await move(t, b.id, { kind: 'folder', folderId: folder.id });
    expect(result.moved).toBe(true);
    expect(result.page).toMatchObject({ parentPageId: null, folderId: folder.id });
    after = await chains();
    expect(after.get(b.id)).toEqual([]);
    expect(after.get(c.id)).toEqual([b.id]);
    expect(after.get(c2.id)).toEqual([b.id]);
    expect(after.get(d.id)).toEqual([b.id, c.id]);
    expect(after.get(a.id)).toEqual([]);
    expect(after.get(bystander.id)).toEqual([x.id]);

    // And back under a page two levels deep: every chain gains the new prefix.
    await move(t, b.id, { kind: 'page', pageId: bystander.id });
    after = await chains();
    expect(after.get(b.id)).toEqual([x.id, bystander.id]);
    expect(after.get(c.id)).toEqual([x.id, bystander.id, b.id]);
    expect(after.get(d.id)).toEqual([x.id, bystander.id, b.id, c.id]);
  });

  it('pages a 120-page level 50 / 50 / 20 in (position, id) COLLATE "C" order', async () => {
    const t = await makeTenant('keyset');
    const parent = await createUnder(t, { kind: 'root' }, 'Parent');
    const template = await adminDb.page.findUniqueOrThrow({ where: { id: parent.id } });
    // Mixed-case keys, and repeated keys so `id` breaks ties: under a linguistic
    // collation 'B' sorts after 'a'; in code-unit order it sorts before it.
    const alphabet = ['A', 'B', 'Z', 'a', 'b', 'z', '0', '9'];
    const rows = Array.from({ length: 120 }, (_, i) => ({
      id: `kp-${String((i * 37) % 120).padStart(3, '0')}-${i % 2 === 0 ? 'X' : 'x'}`,
      position: `${alphabet[i % alphabet.length]}${alphabet[(i * 5) % alphabet.length]}`,
    }));
    await adminDb.page.createMany({
      data: rows.map((r) => ({
        id: r.id,
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        title: r.id,
        parentPageId: parent.id,
        position: r.position,
        ancestorPageIds: [parent.id],
        bodyState: template.bodyState,
        bodyJson: template.bodyJson as object,
        revision: 1,
        createdById: t.userId,
        updatedById: t.userId,
      })),
    });
    // One of them holds a sub-page, so `hasChildren` has a true to report.
    const withChild = rows[7]!.id;
    await createUnder(t, { kind: 'page', pageId: withChild }, 'Sub');

    const codeUnit = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
    const expected = [...rows]
      .sort((x, y) => codeUnit(x.position, y.position) || codeUnit(x.id, y.id))
      .map((r) => r.id);

    const level: PageParentRef = { kind: 'page', pageId: parent.id };
    const pages: string[][] = [];
    let cursor: { position: string; id: string } | null = null;
    for (;;) {
      const at: { position: string; id: string } | null = cursor;
      const batch: PageLevelRecord[] = await inTenant(t, (tx) =>
        pageRepository.findLevelAfter(t.projectId, level, at, 50, tx),
      );
      if (batch.length === 0) break;
      const mapped: PageLevelRow[] = batch.map(toPageLevelRow);
      pages.push(mapped.map((r) => r.id));
      for (const r of mapped) expect(r.hasChildren).toBe(r.id === withChild);
      const tail = mapped[mapped.length - 1]!;
      cursor = { position: tail.position, id: tail.id };
    }
    expect(pages.map((p) => p.length)).toEqual([50, 50, 20]);
    const all = pages.flat();
    expect(new Set(all).size).toBe(120);
    expect(all).toEqual(expected);
  });

  it('hides another project’s folder from findFolderForPlacement, and refuses a page there', async () => {
    const t = await makeTenant('rls');
    const other = await projectsService.createProject({
      workspaceId: t.workspaceId,
      actorUserId: t.userId,
      name: 'Other project',
      identifier: 'PAOTHER',
    });
    const mine = await makeFolder(t, 'Mine');
    const theirs = await makeFolder(t, 'Theirs', other.id);
    const elsewhere = await makeTenant('elsewhere');
    const foreign = await makeFolder(elsewhere, 'Foreign');

    const look = (projectId: string, folderId: string) =>
      withWorkspaceContext(
        { userId: t.userId, workspaceId: t.workspaceId, projectId },
        async (tx) => {
          await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
          return pageRepository.findFolderForPlacement(folderId, tx);
        },
      );

    expect(await look(t.projectId, mine.id)).toEqual({ id: mine.id, projectId: t.projectId });
    // `folder_project_narrow` narrows SELECT — and so `FOR SHARE` — to the bound project.
    expect(await look(t.projectId, theirs.id)).toBeNull();
    expect(await look(other.id, theirs.id)).toEqual({ id: theirs.id, projectId: other.id });
    // And `folder_active_workspace` hides another workspace's folder outright.
    expect(await look(t.projectId, foreign.id)).toBeNull();

    await expect(
      inTenant(t, async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
        return createPage(pageStoreFor(tx), systemClock, {
          workspaceId: t.workspaceId,
          projectId: t.projectId,
          actorId: t.userId,
          parent: { kind: 'folder', folderId: theirs.id },
        });
      }),
    ).rejects.toMatchObject({ code: 'FOLDER_NOT_FOUND' });
    expect(await adminDb.page.count({ where: { folderId: theirs.id } })).toBe(0);
  });
});

describe('pageRepository — a folder delete’s page writes (MOTIR-7371)', () => {
  it('reads, counts and re-files a folder’s filed pages in level order, leaving sub-pages alone', async () => {
    const t = await makeTenant('refile');
    const from = await makeFolder(t, 'From');
    const to = await makeFolder(t, 'To');
    const a = await createUnder(t, { kind: 'folder', folderId: from.id }, 'A');
    const b = await createUnder(t, { kind: 'folder', folderId: from.id }, 'B');
    const sub = await createUnder(t, { kind: 'page', pageId: a.id }, 'A sub');

    const filed = await inTenant(t, (tx) => pageRepository.findFiledInFolder(from.id, tx));
    expect(filed).toEqual([
      { id: a.id, position: a.position },
      { id: b.id, position: b.position },
    ]);
    expect(await inTenant(t, (tx) => pageRepository.countFiledInFolder(from.id, tx))).toBe(2);
    expect(await inTenant(t, (tx) => pageRepository.moveFiledPages(from.id, to.id, [], tx))).toBe(
      0,
    );

    // Only rows still filed in `from` move: a stale id is skipped, not re-filed.
    const moved = await inTenant(t, (tx) =>
      pageRepository.moveFiledPages(
        from.id,
        to.id,
        [
          { id: a.id, position: 'b0' },
          { id: b.id, position: 'b1' },
          { id: sub.id, position: 'b2' },
        ],
        tx,
      ),
    );
    expect(moved).toBe(2);
    const rows = await adminDb.page.findMany({
      where: { id: { in: [a.id, b.id, sub.id] } },
      select: { id: true, folderId: true, parentPageId: true, position: true },
      orderBy: { title: 'asc' },
    });
    expect(rows).toEqual([
      { id: a.id, folderId: to.id, parentPageId: null, position: 'b0' },
      { id: sub.id, folderId: null, parentPageId: a.id, position: sub.position },
      { id: b.id, folderId: to.id, parentPageId: null, position: 'b1' },
    ]);
    expect(await inTenant(t, (tx) => pageRepository.countFiledInFolder(from.id, tx))).toBe(0);

    // To the project root.
    expect(
      await inTenant(t, (tx) =>
        pageRepository.moveFiledPages(to.id, null, [{ id: b.id, position: 'c0' }], tx),
      ),
    ).toBe(1);
    expect(await adminDb.page.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({
      folderId: null,
      parentPageId: null,
      position: 'c0',
    });
  });
});

describe('pageStoreFor(tx) — placement writes serialise (two connections)', () => {
  it('two lockStructure holders on one project serialise', async () => {
    const t = await makeTenant('lock');
    const held = latch();
    const release = latch();
    const order: string[] = [];

    const first = inTenant(t, async (tx) => {
      await pageRepository.lockStructure(t.projectId, tx);
      order.push('first acquired');
      held.open();
      await release.opened;
      order.push('first releasing');
    });
    await held.opened;
    const second = inTenant(t, async (tx) => {
      await pageRepository.lockStructure(t.projectId, tx);
      order.push('second acquired');
    });
    await expect.poll(advisoryWaiters).toBe(1);
    expect(order).toEqual(['first acquired']);

    // Another project's lock is a different key: it does not wait.
    const other = await makeTenant('lockother');
    await inTenant(other, (tx) => pageRepository.lockStructure(other.projectId, tx));

    release.open();
    await Promise.all([first, second]);
    expect(order).toEqual(['first acquired', 'first releasing', 'second acquired']);
  });

  it('two concurrent creates under one parent mint distinct positions', async () => {
    const t = await makeTenant('race');
    const parent = await createUnder(t, { kind: 'root' }, 'Parent');
    const under: PagePlacement = { kind: 'page', pageId: parent.id };
    const held = latch();
    const release = latch();

    const first = inTenant(t, async (tx) => {
      const page = await createPage(pageStoreFor(tx), systemClock, {
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        actorId: t.userId,
        parent: under,
      });
      held.open();
      await release.opened;
      return page;
    });
    await held.opened;
    const second = createUnder(t, under);
    // The second create is parked on the structure lock, not merely slow.
    await expect.poll(advisoryWaiters).toBe(1);
    release.open();
    const [a, b] = await Promise.all([first, second]);

    expect(a.position).not.toBe(b.position);
    expect(a.position < b.position).toBe(true);
    const level = await adminDb.page.findMany({
      where: { parentPageId: parent.id },
      select: { position: true },
    });
    expect(new Set(level.map((r) => r.position)).size).toBe(2);
  });

  it('two concurrent moves that would close a cycle leave the tree acyclic; the loser gets PAGE_CYCLE', async () => {
    const t = await makeTenant('cycle');
    const a = await createUnder(t, { kind: 'root' }, 'A');
    const b = await createUnder(t, { kind: 'root' }, 'B');
    const bChild = await createUnder(t, { kind: 'page', pageId: b.id }, 'B child');
    const held = latch();
    const release = latch();

    // A under B's child, held open after the write...
    const first = inTenant(t, async (tx) => {
      const result = await movePage(pageStoreFor(tx), {
        pageId: a.id,
        projectId: t.projectId,
        parent: { kind: 'page', pageId: bChild.id },
        actorId: t.userId,
      });
      held.open();
      await release.opened;
      return result;
    });
    await held.opened;
    // ...while B is moved under A. Each is fine alone; together they are a cycle.
    const second = move(t, b.id, { kind: 'page', pageId: a.id });
    const secondSettled = second.then(
      () => 'resolved',
      (err: unknown) => err,
    );
    await expect.poll(advisoryWaiters).toBe(1);
    release.open();

    expect((await first).moved).toBe(true);
    expect(await secondSettled).toMatchObject({ code: 'PAGE_CYCLE' });

    const rows = await adminDb.page.findMany({
      where: { projectId: t.projectId },
      select: { id: true, parentPageId: true, ancestorPageIds: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    // The loser rolled back: B is still at the root, A sits under B's child.
    expect(byId.get(b.id)).toMatchObject({ parentPageId: null, ancestorPageIds: [] });
    expect(byId.get(a.id)).toMatchObject({
      parentPageId: bChild.id,
      ancestorPageIds: [b.id, bChild.id],
    });
    // Walk every chain to the root: none revisits a page.
    for (const row of rows) {
      const seen = new Set<string>([row.id]);
      let cur = row.parentPageId;
      while (cur) {
        expect(seen.has(cur)).toBe(false);
        seen.add(cur);
        cur = byId.get(cur)!.parentPageId;
      }
    }
  });
});

describe('pageStoreFor(tx) — the version methods on real Postgres (MOTIR-7384)', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 2, 12, minute));

  /** Insert version `number` of `pageId` through the adapter. */
  const insertVersion = (t: Tenant, pageId: string, number: number, markdown = `v${number}`) =>
    inTenant(t, (tx) =>
      pageStoreFor(tx).insertVersion({
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        pageId,
        number,
        authorId: t.userId,
        bodyState: markdownToUpdate(emptyState(), markdown),
        bodyMarkdown: markdown,
        startedAt: at(number),
        savedAt: at(number),
        restoredFromVersionId: null,
        restoredFromNumber: null,
      }),
    );

  it('insertVersion then latestVersion returns the inserted row; createPage wrote version 1', async () => {
    const t = await makeTenant('vone');
    const page = await create(t);
    expect(await inTenant(t, (tx) => pageStoreFor(tx).latestVersion(page.id))).toMatchObject({
      number: 1,
      authorId: t.userId,
    });

    const inserted = await insertVersion(t, page.id, 2);
    const latest = await inTenant(t, (tx) => pageStoreFor(tx).latestVersion(page.id));
    expect(latest).toEqual(inserted);
    expect(latest).toEqual({
      id: inserted.id,
      pageId: page.id,
      number: 2,
      authorId: t.userId,
      startedAt: at(2),
      savedAt: at(2),
      restoredFromVersionId: null,
      restoredFromNumber: null,
      sealedAt: null,
      frozenAt: null,
    });
    expect(await inTenant(t, (tx) => pageStoreFor(tx).latestVersion('missing'))).toBeNull();
  });

  it('updateVersion changes only the snapshot and saved_at', async () => {
    const t = await makeTenant('vupd');
    const page = await create(t);
    const v2 = await insertVersion(t, page.id, 2, 'before');
    const before = await adminDb.pageVersion.findUniqueOrThrow({ where: { id: v2.id } });

    const state = markdownToUpdate(emptyState(), 'after');
    await inTenant(t, (tx) =>
      pageStoreFor(tx).updateVersion(v2.id, {
        bodyState: state,
        bodyMarkdown: 'after',
        savedAt: at(30),
      }),
    );

    const after = await adminDb.pageVersion.findUniqueOrThrow({ where: { id: v2.id } });
    expect(after).toEqual({
      ...before,
      bodyState: after.bodyState,
      bodyMarkdown: 'after',
      savedAt: at(30),
    });
    expect(Buffer.from(after.bodyState).equals(Buffer.from(state))).toBe(true);
  });

  it('findVersion returns this page’s version n with its body, and null for another page’s n', async () => {
    const t = await makeTenant('vfind');
    const page = await create(t);
    const other = await create(t);
    await insertVersion(t, other.id, 2, 'other two');

    const found = await inTenant(t, (tx) => pageStoreFor(tx).findVersion(other.id, 2));
    expect(found).toMatchObject({ pageId: other.id, number: 2, bodyMarkdown: 'other two' });
    expect(found!.bodyState).toBeInstanceOf(Uint8Array);
    expect(stateToMarkdown(found!.bodyState)).toBe('other two');

    expect(await inTenant(t, (tx) => pageStoreFor(tx).findVersion(page.id, 2))).toBeNull();
  });

  it('deleteOldestUnmarkedVersions(pageId, 3) on 5 versions leaves 3–5, and only touches that page', async () => {
    const t = await makeTenant('vcap');
    const page = await create(t);
    const other = await create(t);
    for (let n = 2; n <= 5; n += 1) await insertVersion(t, page.id, n);

    await inTenant(t, (tx) => pageStoreFor(tx).deleteOldestUnmarkedVersions(page.id, 3));

    const left = await adminDb.pageVersion.findMany({
      where: { pageId: page.id },
      orderBy: { number: 'asc' },
      select: { number: true },
    });
    expect(left.map((r) => r.number)).toEqual([3, 4, 5]);
    expect(await inTenant(t, (tx) => pageStoreFor(tx).countVersions(page.id))).toBe(3);
    expect(await inTenant(t, (tx) => pageStoreFor(tx).countVersions(other.id))).toBe(1);
  });

  it('pagesService.savePageUpdate on a real page leaves a page_version row', async () => {
    const t = await makeTenant('vsvc');
    const ctx = { userId: t.userId, workspaceId: t.workspaceId };
    const created = await pagesService.createPage(ctx, { projectId: t.projectId });
    await pagesService.savePageUpdate(ctx, {
      projectId: t.projectId,
      pageId: created.id,
      update: markdownToUpdate(emptyState(), 'saved through the service'),
    });

    const versions = await adminDb.pageVersion.findMany({ where: { pageId: created.id } });
    // v1 is the create; the save, by the same author inside the window, extends it.
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      number: 1,
      authorId: t.userId,
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      bodyMarkdown: 'saved through the service',
    });
  });

  it('listByPage pages newest first, `limit` at a time, below `beforeNumber`, without the body', async () => {
    const t = await makeTenant('vlist');
    const page = await create(t);
    for (let n = 2; n <= 5; n += 1) await insertVersion(t, page.id, n);

    const first = await inTenant(t, (tx) =>
      pageVersionRepository.listByPage(page.id, { limit: 2 }, tx),
    );
    expect(first.map((r) => r.number)).toEqual([5, 4]);
    const second = await inTenant(t, (tx) =>
      pageVersionRepository.listByPage(page.id, { beforeNumber: 4, limit: 2 }, tx),
    );
    expect(second.map((r) => r.number)).toEqual([3, 2]);
    const last = await inTenant(t, (tx) =>
      pageVersionRepository.listByPage(page.id, { beforeNumber: 2, limit: 2 }, tx),
    );
    expect(last.map((r) => r.number)).toEqual([1]);
    for (const row of [...first, ...second, ...last]) {
      expect(row).not.toHaveProperty('bodyState');
      expect(row).not.toHaveProperty('bodyMarkdown');
    }
  });
});
