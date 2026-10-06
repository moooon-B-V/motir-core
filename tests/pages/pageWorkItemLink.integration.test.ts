import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { diffDerivedLinks } from '@/lib/pages/derivedLinks';
import {
  createPage,
  extractLinks,
  markdownToUpdate,
  pageStoreFor,
  restorePageVersion,
  savePageMarkdown,
  savePageUpdate,
  systemClock,
} from '@/lib/pages';
import { pageWorkItemLinkRepository } from '@/lib/repositories/pageWorkItemLinkRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { usersService } from '@/lib/services/usersService';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The `page_work_item_link` TABLE and the adapter's real `replaceDerivedLinks`
// on real Postgres (Story MOTIR-7565 · MOTIR-7571, `docs/decisions/pages.md`
// §8.1): the derived rows every body write leaves, the same-project filter, a
// `manual` row surviving every rewrite, the cotenancy trigger, RLS, the
// cascades, and two concurrent saves on two pooled connections.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const inTenant = <T>(
  fn: Parameters<typeof withWorkspaceContext<T>>[1],
  userId = fx.ownerId,
  projectId = fx.projectId,
) => withWorkspaceContext({ userId, workspaceId: fx.workspaceId, projectId }, fn);

const newPage = (projectId = fx.projectId) =>
  inTenant(
    (tx) =>
      createPage(pageStoreFor(tx), systemClock, {
        workspaceId: fx.workspaceId,
        projectId,
        actorId: fx.ownerId,
      }),
    fx.ownerId,
    projectId,
  );

const item = (title: string) => createTestWorkItem(fx, { kind: 'task', title });

const mention = (w: { id: string }, label = 'K') => `[${label}](motir:${w.id})`;

const writeMarkdown = async (pageId: string, markdown: string, actorId = fx.ownerId) => {
  const { revision } = await adminDb.page.findUniqueOrThrow({ where: { id: pageId } });
  return inTenant(
    (tx) =>
      savePageMarkdown(pageStoreFor(tx), systemClock, {
        pageId,
        actorId,
        markdown,
        expectedRevision: revision,
      }),
    actorId,
  );
};

const rowsOf = (pageId: string) =>
  adminDb.pageWorkItemLink.findMany({ where: { pageId }, orderBy: { createdAt: 'asc' } });

/** A second user to save as — the package path checks no permission, only the row's FKs. */
async function addMember(email: string): Promise<string> {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: email });
  return user.id;
}

const manualRow = (pageId: string, workItemId: string) =>
  adminDb.pageWorkItemLink.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      pageId,
      workItemId,
      source: 'manual',
      createdById: fx.ownerId,
    },
  });

describe('replaceDerivedLinks through the real adapter', () => {
  it('writes one mention row per item, keeps a kept row as it was, and drops a removed one', async () => {
    const a = await item('A');
    const b = await item('B');
    const page = await newPage();

    await writeMarkdown(page.id, `See ${mention(a)}, ${mention(b)} and ${mention(a)} again.`);
    const first = await rowsOf(page.id);
    expect(first.map((r) => [r.workItemId, r.source, r.createdById])).toEqual([
      [a.id, 'mention', fx.ownerId],
      [b.id, 'mention', fx.ownerId],
    ]);
    expect(first.every((r) => r.projectId === fx.projectId)).toBe(true);
    expect(first.every((r) => r.workspaceId === fx.workspaceId)).toBe(true);

    const second = await addMember('second-saver@example.com');
    await writeMarkdown(page.id, `Only ${mention(a)} now.`, second);
    const after = await rowsOf(page.id);
    expect(after).toEqual([first[0]]);
  });

  it('drops a work item of another project and an unknown id, and keeps an archived item', async () => {
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const foreign = await createTestWorkItem(
      { ...fx, projectId: other.id },
      {
        kind: 'task',
        title: 'Elsewhere',
      },
    );
    const archived = await item('Archived');
    await adminDb.workItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
    const page = await newPage();

    await writeMarkdown(
      page.id,
      `${mention(foreign)} ${mention({ id: 'ckunknown0000000000000000' })} ${mention(archived)}`,
    );
    expect((await rowsOf(page.id)).map((r) => r.workItemId)).toEqual([archived.id]);
  });

  it('never reads or writes a manual row, even when every mention is dropped', async () => {
    const a = await item('A');
    const page = await newPage();
    const manual = await manualRow(page.id, a.id);

    await writeMarkdown(page.id, `Mentions ${mention(a)}.`);
    expect((await rowsOf(page.id)).map((r) => r.source).sort()).toEqual(['manual', 'mention']);
    await writeMarkdown(page.id, 'No mention left.');
    expect(await rowsOf(page.id)).toEqual([manual]);
    expect(
      await inTenant((tx) => pageWorkItemLinkRepository.findDerivedByPage(page.id, tx)),
    ).toEqual([]);
    expect(
      await inTenant((tx) =>
        pageWorkItemLinkRepository.deleteDerivedByIds(page.id, [manual.id], tx),
      ),
    ).toBe(0);
    expect(await rowsOf(page.id)).toEqual([manual]);
  });

  it('a version restore re-derives the restored body’s links', async () => {
    const a = await item('A');
    const page = await newPage();
    await writeMarkdown(page.id, `Spec for ${mention(a)}.`);
    const second = await addMember('restorer@example.com');
    await writeMarkdown(page.id, 'Removed.', second);
    expect(await rowsOf(page.id)).toEqual([]);

    const withMention = await adminDb.pageVersion.findFirstOrThrow({
      where: { pageId: page.id, bodyMarkdown: { contains: 'motir:' } },
    });
    await inTenant((tx) =>
      restorePageVersion(pageStoreFor(tx), systemClock, {
        pageId: page.id,
        number: withMention.number,
        actorId: fx.ownerId,
      }),
    );
    expect((await rowsOf(page.id)).map((r) => r.workItemId)).toEqual([a.id]);
  });

  it('two concurrent saves of one page end with exactly the committed body’s rows', async () => {
    const a = await item('A');
    const b = await item('B');
    const page = await newPage();
    await writeMarkdown(page.id, 'Alpha\n\nBeta');
    const base = new Uint8Array(
      (await adminDb.page.findUniqueOrThrow({ where: { id: page.id } })).bodyState,
    );
    const first = markdownToUpdate(base, `Alpha ${mention(a)}\n\nBeta`);

    let locked!: () => void;
    const firstHoldsLock = new Promise<void>((resolve) => (locked = resolve));
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const one = inTenant(async (tx) => {
      await savePageUpdate(pageStoreFor(tx), systemClock, {
        pageId: page.id,
        actorId: fx.ownerId,
        update: first,
      });
      locked();
      await released;
    });
    await firstHoldsLock;
    const two = inTenant((tx) =>
      savePageMarkdown(pageStoreFor(tx), systemClock, {
        pageId: page.id,
        actorId: fx.ownerId,
        markdown: `Alpha\n\nBeta ${mention(b)}`,
        expectedRevision: 3,
      }),
    );
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
    release();
    await one;
    await two;

    const stored = await adminDb.page.findUniqueOrThrow({ where: { id: page.id } });
    expect(stored.bodyMarkdown).toBe(`Alpha\n\nBeta ${mention(b)}`);
    expect((await rowsOf(page.id)).map((r) => r.workItemId)).toEqual(
      extractLinks(stored.bodyJson as never).map((l) => l.workItemId),
    );
    expect((await rowsOf(page.id)).map((r) => r.workItemId)).toEqual([b.id]);
  });
});

describe('the table', () => {
  it('refuses a row whose page or work item lies in another project', async () => {
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const page = await newPage();
    const otherPage = await newPage(other.id);
    const a = await item('A');

    await expect(manualRow(otherPage.id, a.id)).rejects.toThrow(/PAGE_LINK_PAGE_CROSS_PROJECT/);
    await expect(
      adminDb.pageWorkItemLink.create({
        data: {
          workspaceId: fx.workspaceId,
          projectId: other.id,
          pageId: otherPage.id,
          workItemId: a.id,
          source: 'manual',
        },
      }),
    ).rejects.toThrow(/PAGE_LINK_ITEM_CROSS_PROJECT/);
    await expect(manualRow(page.id, a.id)).resolves.toMatchObject({ source: 'manual' });
    await expect(manualRow(page.id, a.id)).rejects.toThrow(/Unique constraint/);
  });

  it('is invisible under another workspace’s RLS context', async () => {
    const a = await item('A');
    const page = await newPage();
    await manualRow(page.id, a.id);
    const theirs = await makeWorkItemFixture({ name: 'Theirs', identifier: 'THRS' });

    const seen = await withWorkspaceContext(
      { userId: theirs.ownerId, workspaceId: theirs.workspaceId, projectId: theirs.projectId },
      async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
        return tx.pageWorkItemLink.count();
      },
    );
    expect(seen).toBe(0);
    const own = await inTenant(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return tx.pageWorkItemLink.count();
    });
    expect(own).toBe(1);
  });

  it('goes with a deleted page or a hard-deleted work item, and survives archiving either', async () => {
    const a = await item('A');
    const b = await item('B');
    const page = await newPage();
    const kept = await newPage();
    await writeMarkdown(page.id, `${mention(a)} ${mention(b)}`);
    await writeMarkdown(kept.id, `${mention(a)}`);

    const now = new Date();
    await adminDb.page.update({
      where: { id: page.id },
      data: { archivedAt: now, archiveRootId: page.id },
    });
    await adminDb.workItem.update({ where: { id: a.id }, data: { archivedAt: now } });
    expect(await adminDb.pageWorkItemLink.count()).toBe(3);

    await adminDb.workItem.delete({ where: { id: b.id } });
    expect((await rowsOf(page.id)).map((r) => r.workItemId)).toEqual([a.id]);
    await adminDb.page.delete({ where: { id: page.id } });
    expect(await rowsOf(page.id)).toEqual([]);
    expect(await rowsOf(kept.id)).toHaveLength(1);
  });

  it('createDerived and findIdsInProject short-circuit on an empty input', async () => {
    expect(await inTenant((tx) => pageWorkItemLinkRepository.createDerived([], tx))).toBe(0);
    expect(
      await inTenant((tx) => workItemRepository.findIdsInProject(fx.projectId, [], tx)),
    ).toEqual([]);
  });
});

describe('diffDerivedLinks', () => {
  const row = (id: string, workItemId: string, source: 'mention' | 'embed' = 'mention') => ({
    id,
    workItemId,
    source,
    createdById: null,
    createdAt: new Date(0),
  });

  it('keeps named rows, deletes the rest, and inserts each new link once in body order', () => {
    expect(
      diffDerivedLinks(
        [row('r1', 'a'), row('r2', 'b'), row('r3', 'a', 'embed')],
        [
          { workItemId: 'c', source: 'mention' },
          { workItemId: 'a', source: 'mention' },
          { workItemId: 'c', source: 'mention' },
          { workItemId: 'b', source: 'embed' },
        ],
      ),
    ).toEqual({
      deleteIds: ['r2', 'r3'],
      insert: [
        { workItemId: 'c', source: 'mention' },
        { workItemId: 'b', source: 'embed' },
      ],
    });
  });
});
