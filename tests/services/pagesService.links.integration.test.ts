import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { PAGE_FRAGMENT } from '@/lib/pages';
import { pageWorkItemLinkRepository } from '@/lib/repositories/pageWorkItemLinkRepository';
import { pagesService } from '@/lib/services/pagesService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { createTestProject } from '../fixtures/projectFixtures';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// STORY MOTIR-7566's DERIVATION GATE (MOTIR-9183), on real Postgres through the
// real service doors: a page that EMBEDS a work item as a card (`![KEY](motir:<id>)`
// on a line of its own, or the `workItemEmbed` node an editor save carries)
// writes exactly one `embed` row, keeps it across a re-save, drops it when the
// card leaves the body, never touches a `manual` row, and re-derives on a
// version restore.
//
// Every row assertion reads `adminDb` directly, not the port under test; the one
// scoped read (the work item's grouped Pages read) IS its own subject. No fake
// `PageStore` is imported — the row is the evidence.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ name: 'Embeds', identifier: 'EMB' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── The editor's update shape ────────────────────────────────────────────────
//
// `<PageEditor>` ships ONE `Y.mergeUpdates` of the doc's `update` events. A card
// is the block `workItemEmbed` node, which y-prosemirror stores as an
// `XmlElement` of that name carrying the node's attrs (`tests/pages/
// pageWorkItemLinks.story.integration.test.ts` builds the chip's the same way).

interface YElement {
  insert(index: number, content: unknown[]): void;
  setAttribute(name: string, value: string): void;
}
interface YFragment {
  length: number;
  insert(index: number, content: unknown[]): void;
}
interface YDoc {
  on(event: 'update', handler: (update: Uint8Array) => void): void;
  transact(fn: () => void): void;
  getXmlFragment(name: string): YFragment;
}
interface Yjs {
  Doc: new () => YDoc;
  XmlElement: new (name: string) => YElement;
  applyUpdate(doc: YDoc, update: Uint8Array): void;
  mergeUpdates(updates: Uint8Array[]): Uint8Array;
}
const Y = createRequire(join(process.cwd(), 'packages', 'pages', 'package.json'))('yjs') as Yjs;

/** The update the editor sends after the writer inserts a card for `workItemId`. */
function editorEmbedUpdate(state: Uint8Array, workItemId: string, label: string): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const batch: Uint8Array[] = [];
  doc.on('update', (update) => batch.push(update));
  doc.transact(() => {
    const fragment = doc.getXmlFragment(PAGE_FRAGMENT);
    const card = new Y.XmlElement('workItemEmbed');
    card.setAttribute('id', workItemId);
    card.setAttribute('label', label);
    fragment.insert(fragment.length, [card]);
  });
  return Y.mergeUpdates(batch);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const item = (title: string, where: WorkItemFixture = fx) =>
  createTestWorkItem(where, { kind: 'task', title });

/** A card on a line of its own, and a chip. */
const card = (w: { id: string; identifier: string }) => `![${w.identifier}](motir:${w.id})`;
const chip = (w: { id: string; identifier: string }) => `[${w.identifier}](motir:${w.id})`;

const newPage = (title = 'Runbook', ctx: ServiceContext = fx.ctx) =>
  pagesService.createPage(ctx, { projectId: fx.projectId, title });

const pageRow = (pageId: string) => adminDb.page.findUniqueOrThrow({ where: { id: pageId } });

/** Write a whole body through the markdown door, stating the revision just read. */
async function writeMarkdown(pageId: string, markdown: string, ctx: ServiceContext = fx.ctx) {
  const { revision } = await pageRow(pageId);
  return pagesService.savePageMarkdown(ctx, {
    projectId: fx.projectId,
    pageId,
    markdown,
    expectedRevision: revision,
  });
}

const rowsOf = (pageId: string) =>
  adminDb.pageWorkItemLink.findMany({
    where: { pageId },
    orderBy: [{ source: 'asc' }, { workItemId: 'asc' }],
  });

/** The rows as `[source, workItemId]`, the shape most cases assert. */
const sourcesOf = async (pageId: string) =>
  (await rowsOf(pageId))
    .map((r) => [r.source, r.workItemId] as [string, string])
    .sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]));

async function member(email: string): Promise<ServiceContext> {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: email });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

// ── 1 — each write door derives one embed row ───────────────────────────────

describe('an embedded card derives one `embed` row on each body-write door', () => {
  it('a markdown write, and the markdown read back returns the same line', async () => {
    const a = await item('A');
    const page = await newPage();

    const saved = await writeMarkdown(page.id, `Intro.\n\n${card(a)}\n\nOutro.`);

    const rows = await rowsOf(page.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pageId: page.id,
      workItemId: a.id,
      source: 'embed',
      createdById: fx.ownerId,
    });
    expect(saved.markdown).toContain(`\n${card(a)}\n`);
    expect((await pageRow(page.id)).bodyMarkdown).toBe(`Intro.\n\n${card(a)}\n\nOutro.`);
  });

  it('an editor save (a Yjs update inserting a workItemEmbed node)', async () => {
    const a = await item('A');
    const page = await newPage();

    const update = editorEmbedUpdate(
      new Uint8Array((await pageRow(page.id)).bodyState),
      a.id,
      a.identifier,
    );
    const { revision } = await pagesService.savePageUpdate(fx.ctx, {
      projectId: fx.projectId,
      pageId: page.id,
      update,
    });
    expect(revision).toBe(2);

    expect(await sourcesOf(page.id)).toEqual([['embed', a.id]]);
    expect((await rowsOf(page.id))[0]!.createdById).toBe(fx.ownerId);
    expect((await pageRow(page.id)).bodyMarkdown).toBe(card(a));
  });
});

// ── 2 — a re-save keeps the very same row ───────────────────────────────────

describe('a re-save with the card still present', () => {
  it('leaves one embed row, with the same id, author and creation time', async () => {
    const a = await item('A');
    const page = await newPage();
    await writeMarkdown(page.id, `First.\n\n${card(a)}`);
    const [first] = await rowsOf(page.id);

    const other = await member('second-author@example.com');
    await writeMarkdown(page.id, `Edited.\n\n${card(a)}`, other);

    const rows = await rowsOf(page.id);
    expect(rows).toHaveLength(1);
    // `diffDerivedLinks` keys a row by `source:workItemId`, so a name the body
    // still carries is neither deleted nor re-inserted.
    expect(rows[0]).toEqual(first);
    expect(rows[0]!.createdById).toBe(fx.ownerId);
  });
});

// ── 3 — removing the card removes only its row ──────────────────────────────

describe('a save that removes the card', () => {
  it('drops the embed row and keeps the chip’s mention row', async () => {
    const a = await item('A');
    const b = await item('B');
    const page = await newPage();
    await writeMarkdown(page.id, `See ${chip(a)}.\n\n${card(a)}\n\n${card(b)}`);
    expect(await sourcesOf(page.id)).toEqual(
      [
        ['embed', a.id],
        ['embed', b.id],
        ['mention', a.id],
      ].sort(
        (x, y) =>
          String(x[0]).localeCompare(String(y[0])) || String(x[1]).localeCompare(String(y[1])),
      ),
    );
    const mentionBefore = (await rowsOf(page.id)).find((r) => r.source === 'mention')!;

    await writeMarkdown(page.id, `See ${chip(a)}.\n\n${card(b)}`);

    expect(await sourcesOf(page.id)).toEqual([
      ['embed', b.id],
      ['mention', a.id],
    ]);
    // Nothing else of the page changed.
    expect((await rowsOf(page.id)).find((r) => r.source === 'mention')).toEqual(mentionBefore);
  });
});

// ── 4 — a chip and a card for one item read back as ONE page ────────────────

describe('a chip and a card for the same item', () => {
  it('store two rows by source, and the work item’s Pages read returns the page once with both', async () => {
    const a = await item('A');
    const page = await newPage();
    await writeMarkdown(page.id, `See ${chip(a)}.\n\n${card(a)}`);

    expect(await sourcesOf(page.id)).toEqual([
      ['embed', a.id],
      ['mention', a.id],
    ]);

    const read = await withWorkspaceContext(
      { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
      async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
        return pageWorkItemLinkRepository.listPagesForWorkItem(a.id, null, 10, tx);
      },
    );
    expect(read).toHaveLength(1);
    expect(read[0]!.pageId).toBe(page.id);
    expect([...read[0]!.sources].sort()).toEqual(['embed', 'mention']);
  });
});

// ── 5 — a manual row survives every write ───────────────────────────────────

describe('a manual row', () => {
  it('is untouched by a card save, a card removal and a version restore', async () => {
    const a = await item('A');
    const page = await newPage();
    const manual = await adminDb.pageWorkItemLink.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        pageId: page.id,
        workItemId: a.id,
        source: 'manual',
        createdById: fx.ownerId,
      },
    });
    const untouched = async () =>
      expect((await rowsOf(page.id)).find((r) => r.source === 'manual')).toEqual(manual);

    await writeMarkdown(page.id, `Has a card.\n\n${card(a)}`);
    expect(await sourcesOf(page.id)).toEqual([
      ['embed', a.id],
      ['manual', a.id],
    ]);
    await untouched();

    // A second author, so the removal starts a version of its own.
    const editor = await member('remover@example.com');
    await writeMarkdown(page.id, 'No card now.', editor);
    expect(await sourcesOf(page.id)).toEqual([['manual', a.id]]);
    await untouched();

    const withCard = await adminDb.pageVersion.findFirstOrThrow({
      where: { pageId: page.id, bodyMarkdown: { contains: `motir:${a.id}` } },
    });
    await pagesService.restorePageVersion(editor, {
      projectId: fx.projectId,
      pageId: page.id,
      number: withCard.number,
    });
    expect(await sourcesOf(page.id)).toEqual([
      ['embed', a.id],
      ['manual', a.id],
    ]);
    await untouched();
  });
});

// ── 6 — an archived item is still named ─────────────────────────────────────

describe('an archived work item', () => {
  it('keeps its embed row through a read and a re-save', async () => {
    const a = await item('A');
    const page = await newPage();
    await writeMarkdown(page.id, card(a));
    expect(await sourcesOf(page.id)).toEqual([['embed', a.id]]);

    await workItemsService.archiveWorkItem(a.id, fx.ctx);

    const read = await pagesService.getPage(fx.ctx, { projectId: fx.projectId, pageId: page.id });
    expect(read.workItemRefs[a.id]).toMatchObject({
      accessible: true,
      archived: true,
      identifier: a.identifier,
      title: 'A',
    });

    await writeMarkdown(page.id, `Edited.\n\n${card(a)}`);
    expect(await sourcesOf(page.id)).toEqual([['embed', a.id]]);
  });
});

// ── 7 — an id that cannot be linked is dropped, never raised ────────────────

describe('a card naming an item of another project, or one that does not exist', () => {
  it('saves without raising and writes no row for either', async () => {
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTH',
    });
    const foreign = await item('Elsewhere', {
      ...fx,
      projectId: other.id,
      projectIdentifier: 'OTH',
    });
    const local = await item('Here');
    const page = await newPage();
    const nothing = { id: 'ckdoesnotexist0000000000', identifier: 'EMB-9999' };

    const saved = await writeMarkdown(
      page.id,
      `${card(foreign)}\n\n${card(nothing)}\n\n${card(local)}`,
    );

    // The body keeps all three cards — only the ROWS are refused. The deleted /
    // unknown id is dropped by the adapter's project filter BEFORE the diff, so
    // it can never reach the foreign key.
    expect(saved.markdown).toContain(`motir:${foreign.id}`);
    expect(saved.markdown).toContain(`motir:${nothing.id}`);
    expect(await sourcesOf(page.id)).toEqual([['embed', local.id]]);
  });
});

// ── 8 — a version restore re-derives ────────────────────────────────────────

describe('a version restore', () => {
  it('re-derives the embed row from the restored body, recording the restorer', async () => {
    const a = await item('A');
    const page = await newPage();
    await writeMarkdown(page.id, `Spec.\n\n${card(a)}`);
    const editor = await member('restorer@example.com');
    await writeMarkdown(page.id, 'Card removed.', editor);
    expect(await sourcesOf(page.id)).toEqual([]);

    const withCard = await adminDb.pageVersion.findFirstOrThrow({
      where: { pageId: page.id, bodyMarkdown: { contains: `motir:${a.id}` } },
    });
    await pagesService.restorePageVersion(editor, {
      projectId: fx.projectId,
      pageId: page.id,
      number: withCard.number,
    });

    const rows = await rowsOf(page.id);
    expect(rows.map((r) => [r.source, r.workItemId])).toEqual([['embed', a.id]]);
    // The restore re-derives from the restored body rather than replaying the
    // row's history, so it names who restored.
    expect(rows[0]!.createdById).toBe(editor.userId);
  });
});
