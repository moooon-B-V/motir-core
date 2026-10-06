import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import {
  PAGE_FRAGMENT,
  PageLevelCursorInvalidError,
  extractLinks,
  pageStoreFor,
  savePageUpdate,
  systemClock,
} from '@/lib/pages';
import {
  decodeWorkItemPagesCursor,
  encodeWorkItemPagesCursor,
  workItemPagesLimit,
} from '@/lib/pages/workItemPagesCursor';
import { VISITOR_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { pageWorkItemLinkRepository } from '@/lib/repositories/pageWorkItemLinkRepository';
import { pageLinksService } from '@/lib/services/pageLinksService';
import { pagesService } from '@/lib/services/pagesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { VisitorReadContext } from '@/lib/visitor/context';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { createCustomRoleAs, setProjectRoleDefinitionFor } from '../helpers/workspaceRoleFixtures';

// STORY MOTIR-7565's INTEGRATION GATE (MOTIR-7576) — "a page names a work item,
// and the work item knows it", assembled on real Postgres through the real
// service doors. Each card tested its own layer: the package's `extractLinks`
// and save order over an in-memory store (MOTIR-7570), the table and the
// adapter's diff (MOTIR-7571), the page read's chip data (MOTIR-7572), the work
// item's Pages read (MOTIR-7573). What none of them saw is a body written
// through a `pagesService` door coming back out of
// `pageLinksService.listPagesForWorkItem` — so every case here starts at a door
// and ends at the read.
//
// The work item page's Pages SECTION (MOTIR-7575) is not built yet and is not
// covered here.
//
// Mocked: nothing. Every context is a plain `ServiceContext` (the services take
// no session), and the two connections of the concurrency case are two pooled
// Prisma transactions.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ name: 'Links', identifier: 'LNK' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── The editor's update shape ────────────────────────────────────────────────
//
// `<PageEditor>` ships ONE `Y.mergeUpdates` of the doc's `update` events
// (`tests/integration/pagesStoryGate.test.ts` builds the same thing). A chip is
// the `workItemMention` node, which y-prosemirror stores as an `XmlElement` of
// that name carrying the node's attrs. Yjs is reached through the package's own
// resolution, as the app never names it.

interface YText {
  insert(index: number, text: string): void;
}
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
  XmlText: new () => YText;
  applyUpdate(doc: YDoc, update: Uint8Array): void;
  mergeUpdates(updates: Uint8Array[]): Uint8Array;
}
const Y = createRequire(join(process.cwd(), 'packages', 'pages', 'package.json'))('yjs') as Yjs;

/** The update the editor sends after the writer appends "See <chip>." for `workItemId`. */
function editorMentionUpdate(state: Uint8Array, workItemId: string, label: string): Uint8Array {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const batch: Uint8Array[] = [];
  doc.on('update', (update) => batch.push(update));
  doc.transact(() => {
    const fragment = doc.getXmlFragment(PAGE_FRAGMENT);
    const paragraph = new Y.XmlElement('paragraph');
    const before = new Y.XmlText();
    before.insert(0, 'See ');
    const chip = new Y.XmlElement('workItemMention');
    chip.setAttribute('id', workItemId);
    chip.setAttribute('label', label);
    const after = new Y.XmlText();
    after.insert(0, '.');
    paragraph.insert(0, [before, chip, after]);
    fragment.insert(fragment.length, [paragraph]);
  });
  return Y.mergeUpdates(batch);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const item = (title: string, where: WorkItemFixture = fx) =>
  createTestWorkItem(where, { kind: 'task', title });

const mention = (w: { id: string; identifier?: string }) =>
  `[${w.identifier ?? 'K'}](motir:${w.id})`;

const newPage = (title = 'Spec', ctx: ServiceContext = fx.ctx) =>
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

const pagesFor = (workItemId: string, ctx: ServiceContext = fx.ctx) =>
  pageLinksService.listPagesForWorkItem(ctx, { workItemId });

/** The read's rows as `[pageId, sources]`, the shape every case asserts. */
const linked = async (workItemId: string, ctx: ServiceContext = fx.ctx) =>
  (await pagesFor(workItemId, ctx)).rows.map((r) => [r.pageId, r.sources]);

const rowsOf = (pageId: string) =>
  adminDb.pageWorkItemLink.findMany({
    where: { pageId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

/** A workspace member — the Member role, so `page:edit` on an open project. */
async function member(email: string): Promise<ServiceContext> {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: email });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

const inTenant = <T>(fn: Parameters<typeof withWorkspaceContext<T>>[1]) =>
  withWorkspaceContext(
    { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
    fn,
  );

/**
 * A `manual` row, written through the tenant's own RLS-bound transaction under
 * the non-bypass role. No repository method writes one yet (an explicit-link
 * action is the next epic's), so this is the closest a test gets to the path
 * that will.
 */
const manualRow = (pageId: string, workItemId: string) =>
  inTenant(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return tx.pageWorkItemLink.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        pageId,
        workItemId,
        source: 'manual',
        createdById: fx.ownerId,
      },
    });
  });

// ── 1 — every body-write door derives the rows the read returns ─────────────

describe('every body-write door derives rows the work item reads back', () => {
  it('an editor save (a Yjs update inserting a workItemMention chip)', async () => {
    const a = await item('A');
    const page = await newPage('Editor page');
    expect(await linked(a.id)).toEqual([]);

    const update = editorMentionUpdate(
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

    expect((await pageRow(page.id)).bodyMarkdown).toBe(`See [${a.identifier}](motir:${a.id}).`);
    expect(await linked(a.id)).toEqual([[page.id, ['mention']]]);
    const [row] = (await pagesFor(a.id)).rows;
    expect(row).toMatchObject({
      title: 'Editor page',
      place: { folderPath: [], parentPageTitle: null },
    });
  });

  it('a markdown write naming [KEY](motir:<id>)', async () => {
    const a = await item('A');
    const page = await newPage();
    await writeMarkdown(page.id, `Tracks ${mention(a)}.`);
    expect(await linked(a.id)).toEqual([[page.id, ['mention']]]);
  });

  it('a create with an initial body', async () => {
    const a = await item('A');
    const created = await pagesService.createPageFromMarkdown(fx.ctx, {
      projectId: fx.projectId,
      title: 'Born linked',
      markdown: `# Plan\n\nBuilds ${mention(a)}.`,
    });
    expect(await linked(a.id)).toEqual([[created.id, ['mention']]]);
    expect((await rowsOf(created.id)).map((r) => r.createdById)).toEqual([fx.ownerId]);
  });

  it('a version restore to a body holding the mention, after a save that removed it', async () => {
    const a = await item('A');
    const page = await newPage();
    await writeMarkdown(page.id, `Spec for ${mention(a)}.`);
    // A second author, so the removal starts a version of its own rather than
    // coalescing into the owner's (§6).
    const editor = await member('editor@example.com');
    await writeMarkdown(page.id, 'Removed.', editor);
    expect(await linked(a.id)).toEqual([]);

    const { items } = await pagesService.listPageVersions(fx.ctx, {
      projectId: fx.projectId,
      pageId: page.id,
    });
    const withMention = await adminDb.pageVersion.findFirstOrThrow({
      where: { pageId: page.id, bodyMarkdown: { contains: `motir:${a.id}` } },
    });
    expect(items.map((v) => v.number)).toContain(withMention.number);

    await pagesService.restorePageVersion(editor, {
      projectId: fx.projectId,
      pageId: page.id,
      number: withMention.number,
    });
    expect(await linked(a.id)).toEqual([[page.id, ['mention']]]);
    // The restore re-derived the row, so it records who linked it this time.
    expect((await rowsOf(page.id)).map((r) => r.createdById)).toEqual([editor.userId]);
  });
});

// ── 2 — removal ─────────────────────────────────────────────────────────────

describe('removal', () => {
  it('a save dropping the last mention takes the page out of the read', async () => {
    const a = await item('A');
    const b = await item('B');
    const page = await newPage();
    await writeMarkdown(page.id, `${mention(a)} and ${mention(b)}`);
    expect(await linked(a.id)).toEqual([[page.id, ['mention']]]);
    expect(await linked(b.id)).toEqual([[page.id, ['mention']]]);

    await writeMarkdown(page.id, `Only ${mention(b)}.`);
    expect(await linked(a.id)).toEqual([]);
    expect(await linked(b.id)).toEqual([[page.id, ['mention']]]);

    await writeMarkdown(page.id, 'Nothing named.');
    expect(await linked(b.id)).toEqual([]);
    expect(await rowsOf(page.id)).toEqual([]);
  });
});

// ── 3 — a manual row survives every body write ──────────────────────────────

describe('a manual row', () => {
  it('survives a save adding a mention, one removing it, and a restore', async () => {
    const a = await item('A');
    const page = await newPage();
    const manual = await manualRow(page.id, a.id);
    expect(await linked(a.id)).toEqual([[page.id, ['manual']]]);

    await writeMarkdown(page.id, `Now mentions ${mention(a)}.`);
    expect(await linked(a.id)).toEqual([[page.id, ['manual', 'mention']]]);

    const editor = await member('remover@example.com');
    await writeMarkdown(page.id, 'Mention removed.', editor);
    expect(await linked(a.id)).toEqual([[page.id, ['manual']]]);

    // The owner's save coalesced into version 1 (same author, inside the
    // window — §6); the editor's removal started the next one.
    const versions = await adminDb.pageVersion.findMany({
      where: { pageId: page.id },
      orderBy: { number: 'asc' },
    });
    const withMention = versions.find((v) => v.bodyMarkdown.includes(`motir:${a.id}`))!;
    const without = versions.find((v) => !v.bodyMarkdown.includes('motir:'))!;
    expect(withMention).toBeDefined();
    expect(without).toBeDefined();

    // A restore to the body WITH the mention adds the derived row beside it…
    await pagesService.restorePageVersion(fx.ctx, {
      projectId: fx.projectId,
      pageId: page.id,
      number: withMention.number,
    });
    expect(await linked(a.id)).toEqual([[page.id, ['manual', 'mention']]]);

    // …and one to the body WITHOUT it drops that row and never the manual one.
    await pagesService.restorePageVersion(editor, {
      projectId: fx.projectId,
      pageId: page.id,
      number: without.number,
    });
    expect(await linked(a.id)).toEqual([[page.id, ['manual']]]);
    expect(await rowsOf(page.id)).toEqual([manual]);

    await writeMarkdown(page.id, `Back: ${mention(a)}.`);
    expect(await linked(a.id)).toEqual([[page.id, ['manual', 'mention']]]);
    await writeMarkdown(page.id, 'Gone again.');
    expect(await linked(a.id)).toEqual([[page.id, ['manual']]]);
    expect(await rowsOf(page.id)).toEqual([manual]);
  });
});

// ── 4 — same project only ───────────────────────────────────────────────────

describe('same-project only', () => {
  it('markdown naming a work item of another project in the same workspace writes no row', async () => {
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

    const saved = await writeMarkdown(page.id, `${mention(foreign)} and ${mention(local)}`);
    // The body keeps the chip — only the ROW is refused.
    expect(saved.markdown).toContain(`motir:${foreign.id}`);
    expect((await rowsOf(page.id)).map((r) => r.workItemId)).toEqual([local.id]);
    expect(await linked(foreign.id)).toEqual([]);
    expect(await linked(local.id)).toEqual([[page.id, ['mention']]]);
  });
});

// ── 5 — tenancy ─────────────────────────────────────────────────────────────

describe('tenancy', () => {
  it('a row for a page in W1 is invisible under W2’s RLS context', async () => {
    const a = await item('A');
    const page = await newPage();
    await writeMarkdown(page.id, mention(a));
    const theirs = await makeWorkItemFixture({ name: 'Theirs', identifier: 'THR' });

    const underW2 = await withWorkspaceContext(
      { userId: theirs.ownerId, workspaceId: theirs.workspaceId, projectId: theirs.projectId },
      async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
        return {
          count: await tx.pageWorkItemLink.count(),
          derived: await pageWorkItemLinkRepository.findDerivedByPage(page.id, tx),
          pages: await pageWorkItemLinkRepository.listPagesForWorkItem(a.id, null, 10, tx),
        };
      },
    );
    expect(underW2).toEqual({ count: 0, derived: [], pages: [] });

    const underW1 = await inTenant(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return pageWorkItemLinkRepository.listPagesForWorkItem(a.id, null, 10, tx);
    });
    expect(underW1.map((r) => r.pageId)).toEqual([page.id]);

    // And W2's owner reading W1's work item is the not-found, not an empty list.
    await expect(pagesFor(a.id, theirs.ctx)).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('the cotenancy trigger refuses a row whose page and work item disagree on project', async () => {
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
    const page = await newPage();

    const write = (projectId: string) =>
      inTenant((tx) =>
        pageWorkItemLinkRepository.createDerived(
          [
            {
              workspaceId: fx.workspaceId,
              projectId,
              pageId: page.id,
              workItemId: foreign.id,
              source: 'mention',
              createdById: fx.ownerId,
            },
          ],
          tx,
        ),
      );
    // Stamped with the page's project, the work item disagrees; with the work
    // item's, the page does. Either way nothing is written.
    await expect(write(fx.projectId)).rejects.toThrow(/PAGE_LINK_ITEM_CROSS_PROJECT/);
    await expect(write(other.id)).rejects.toThrow(/PAGE_LINK_PAGE_CROSS_PROJECT/);
    expect(await rowsOf(page.id)).toEqual([]);
  });
});

// ── 6 — access ──────────────────────────────────────────────────────────────

describe('access', () => {
  it('getPage reports a mention of an item the reader cannot browse as no-access', async () => {
    const priv = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'PRV',
    });
    await projectMembersService.setAccessMode({
      key: priv.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      mode: 'members',
    });
    const hidden = await item('Secret item title', {
      ...fx,
      projectId: priv.id,
      projectIdentifier: 'PRV',
    });
    const visible = await item('Visible');
    const page = await newPage();
    await writeMarkdown(page.id, `${mention(hidden)} ${mention(visible)}`);

    const reader = await member('reader@example.com');
    const read = await pagesService.getPage(reader, { projectId: fx.projectId, pageId: page.id });
    expect(read.workItemRefs[hidden.id]).toEqual({ accessible: false, id: hidden.id });
    expect(read.workItemRefs[visible.id]).toMatchObject({ accessible: true, id: visible.id });
    expect(JSON.stringify(read.workItemRefs)).not.toContain('Secret item title');
    // The owner, who browses the private project, sees the same chip resolved.
    const owners = await pagesService.getPage(fx.ctx, { projectId: fx.projectId, pageId: page.id });
    expect(owners.workItemRefs[hidden.id]).toMatchObject({ accessible: true });
  });

  it('the Pages read refuses a reader without page:view, naming no page', async () => {
    const a = await item('A');
    const page = await newPage('Confidential page title');
    await writeMarkdown(page.id, mention(a));
    const browseOnly = await createCustomRoleAs({
      ctx: fx.ctx,
      name: 'Browse only',
      permissions: ['project:browse', 'work_item:view'],
    });
    const r = await member('browse-only@example.com');
    await setProjectRoleDefinitionFor(r.userId, fx.projectId, {
      roleDefinitionId: browseOnly.id,
      role: 'member',
    });

    const refused = await pagesFor(a.id, r).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ProjectAccessDeniedError);
    expect(refused).toMatchObject({ kind: 'edit' });
    expect(JSON.stringify(refused)).not.toContain('Confidential page title');
    expect(String((refused as Error).message)).not.toContain('Confidential page title');
  });

  it('a Visitor gets the unknown-work-item refusal, with no page title in it', async () => {
    const a = await item('A');
    const page = await newPage('Members-only page title');
    await writeMarkdown(page.id, mention(a));
    const stranger = await usersService.createUser({
      email: 'visitor@example.com',
      password: 'hunter2hunter2',
      name: 'Visitor',
    });
    const visitor: VisitorReadContext = {
      kind: 'visitor',
      project: await adminDb.project.findUniqueOrThrow({ where: { id: fx.projectId } }),
      actorUserId: stranger.id,
      permissions: VISITOR_PERMISSIONS,
      hiddenIds: new Set(),
    };

    const refused = await pageLinksService
      .listPagesForWorkItem(visitor, { workItemId: a.id })
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(WorkItemNotFoundError);
    // The same refusal an unknown id gets.
    const unknown = await pagesFor('ckunknownworkitem0000000').catch((e: unknown) => e);
    expect(unknown).toBeInstanceOf(WorkItemNotFoundError);
    expect((refused as WorkItemNotFoundError).code).toBe((unknown as WorkItemNotFoundError).code);
    expect(JSON.stringify(refused)).not.toContain('Members-only page title');
    expect(String((refused as Error).message)).not.toContain('Members-only page title');
    expect(String((refused as Error).message)).not.toContain(page.id);
  });
});

// ── 7 — archive, delete, and the work item's own deletion ───────────────────

describe('archive and delete', () => {
  it('archiving drops the page from the read; restoring brings it back with its rows untouched', async () => {
    const a = await item('A');
    const page = await newPage();
    await writeMarkdown(page.id, mention(a));
    await manualRow(page.id, a.id);
    const before = await rowsOf(page.id);
    expect(before).toHaveLength(2);

    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: page.id });
    expect(await linked(a.id)).toEqual([]);
    expect(await rowsOf(page.id)).toEqual(before);

    await pagesService.restorePage(fx.ctx, { projectId: fx.projectId, pageId: page.id });
    expect(await linked(a.id)).toEqual([[page.id, ['manual', 'mention']]]);
    expect(await rowsOf(page.id)).toEqual(before);
  });

  it('a permanent delete removes the page’s rows', async () => {
    const a = await item('A');
    const page = await newPage();
    const kept = await newPage('Kept');
    await writeMarkdown(page.id, mention(a));
    await writeMarkdown(kept.id, mention(a));

    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: page.id });
    await pagesService.deletePage(fx.ctx, { projectId: fx.projectId, pageId: page.id });
    expect(await rowsOf(page.id)).toEqual([]);
    expect(await linked(a.id)).toEqual([[kept.id, ['mention']]]);
  });

  it('hard-deleting the work item removes its rows and leaves the others', async () => {
    const a = await item('A');
    const b = await item('B');
    const page = await newPage();
    await writeMarkdown(page.id, `${mention(a)} ${mention(b)}`);

    await workItemsService.deleteWorkItem(a.id, fx.ctx);
    expect((await rowsOf(page.id)).map((r) => r.workItemId)).toEqual([b.id]);
    await expect(pagesFor(a.id)).rejects.toBeInstanceOf(WorkItemNotFoundError);
    expect(await linked(b.id)).toEqual([[page.id, ['mention']]]);
  });
});

// ── 8 — concurrency ─────────────────────────────────────────────────────────

describe('concurrency', () => {
  it('two concurrent editor saves on two connections end with rows matching the body that committed last', async () => {
    const a = await item('A');
    const b = await item('B');
    const page = await newPage();
    await writeMarkdown(page.id, 'Intro');
    // Both writers loaded the SAME state, as two open tabs do.
    const base = new Uint8Array((await pageRow(page.id)).bodyState);
    const first = editorMentionUpdate(base, a.id, a.identifier);
    const second = editorMentionUpdate(base, b.id, b.identifier);

    // Connection one saves and holds its transaction open.
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

    // Connection two saves through the service door while one is open.
    const editor = await member('second-tab@example.com');
    let twoDone = false;
    const two = pagesService
      .savePageUpdate(editor, { projectId: fx.projectId, pageId: page.id, update: second })
      .then((r) => {
        twoDone = true;
        return r;
      });
    // It is parked on the page lock — pg's own view says so — not merely slow.
    // `finally`: a failed wait must still let connection one commit, so neither
    // backend outlives the test.
    try {
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
      expect(twoDone).toBe(false);
    } finally {
      release();
      await Promise.allSettled([one, two]);
    }
    await one;
    expect(await two).toEqual({ revision: 4 });

    // The body that committed last merged onto the first, so it names BOTH —
    // and the rows are exactly what it names, no more and no fewer.
    const stored = await pageRow(page.id);
    const named = extractLinks(stored.bodyJson as never).map((l) => l.workItemId);
    expect([...named].sort()).toEqual([a.id, b.id].sort());
    expect((await rowsOf(page.id)).map((r) => r.workItemId).sort()).toEqual([...named].sort());
    expect(await linked(a.id)).toEqual([[page.id, ['mention']]]);
    expect(await linked(b.id)).toEqual([[page.id, ['mention']]]);
  });
});

// ── 9 — the read's cursor refuses what it did not issue ─────────────────────

describe('the Pages read cursor', () => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

  it('round-trips the seek key it issued', () => {
    const seek = { updatedAt: new Date('2026-10-01T12:00:00.000Z'), id: 'page-1' };
    expect(decodeWorkItemPagesCursor(encodeWorkItemPagesCursor(seek))).toEqual(seek);
  });

  it.each([
    ['not JSON', Buffer.from('{nope').toString('base64url')],
    ['not an array', encode({ updatedAt: '2026-10-01T12:00:00.000Z', id: 'x' })],
    ['the wrong length', encode(['2026-10-01T12:00:00.000Z'])],
    ['a non-string instant', encode([42, 'x'])],
    ['a non-string id', encode(['2026-10-01T12:00:00.000Z', 7])],
    ['an empty id', encode(['2026-10-01T12:00:00.000Z', ''])],
    ['an unparseable instant', encode(['yesterday-ish', 'x'])],
  ])('refuses %s as PAGE_CURSOR_INVALID', (_label, raw) => {
    expect(() => decodeWorkItemPagesCursor(raw)).toThrow(PageLevelCursorInvalidError);
  });

  it('pages at the tree level’s size: 50 by default, 100 at most', () => {
    expect(workItemPagesLimit()).toBe(50);
    expect(workItemPagesLimit(null)).toBe(50);
    expect(workItemPagesLimit(7)).toBe(7);
    expect(workItemPagesLimit(500)).toBe(100);
  });
});
