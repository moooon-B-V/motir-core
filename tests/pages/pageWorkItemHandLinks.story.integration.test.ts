import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { PAGE_FRAGMENT, PageLevelCursorInvalidError } from '@/lib/pages';
import { PageLinkAlreadyExistsError, PageLinkNotFoundError } from '@/lib/pages/linkErrors';
import { VISITOR_PERMISSIONS } from '@/lib/permissions/builtinRoles';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import { pageLinksService } from '@/lib/services/pageLinksService';
import { pagesService } from '@/lib/services/pagesService';
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

// STORY MOTIR-7567's INTEGRATION GATE (MOTIR-9201) — "link a page and a work item
// by hand, and unlink it", assembled on real Postgres through the real service
// doors. Each building card tested its own layer (the write path over mocked
// repositories, the page-side read, the two UI surfaces over stubbed fetches);
// none of them wrote through one door and read out of both. This file does, and
// it is what replaces the mention story's `manualRow` stand-in (a raw insert in a
// tenant transaction): every hand link here is made through
// `pageLinksService.linkPageForWorkItem`, so the permission gate, the same-project
// refusal, the revision row and the tenant stamping are all in the path.
//
// Mocked: nothing. No `vi.mock`, and no raw insert of a `manual` row. Each case
// reads the table through `adminDb` for row-level truth.
//
// Calls the SERVICE doors, not the route handlers (each route has its own suite on
// the card that ships it), so a Viewer seeing no Unlink button is a component
// assertion and not one made here — this file asserts the refusals BEHIND the
// controls.
//
// THE READ'S ORDERING CONTRACT, recorded so no sibling asserts a different one:
// the work item's Pages section orders by the PAGE'S `updated_at`, newest first —
// NOT by when the link was made. A newly linked page is therefore not guaranteed
// to be first (see "ordering" below).
//
// Two deliberate non-gates in `vitest.coverage.pages.config.ts`'s STORY_FILES:
//   · `lib/services/projectAccessService.ts` — the read card adds one method to a
//     shared service, and this lane runs only the page-reaching suites, so a
//     whole-file floor would pin lines belonging to other stories (the config's
//     SHARED_FILES list is reported, not gated, for the same reason);
//   · `lib/dto/pageLinks.ts` — declaration-only; if the merged file ever exports a
//     runtime value it is added in the same pull request, and
//     `tests/pages/pageLinksLaneEntries.test.ts` is what would notice.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ name: 'Hand', identifier: 'HND' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── The editor's update shape (copied from the mention story's gate) ─────────

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

async function writeMarkdown(pageId: string, markdown: string, ctx: ServiceContext = fx.ctx) {
  const { revision } = await pageRow(pageId);
  return pagesService.savePageMarkdown(ctx, {
    projectId: fx.projectId,
    pageId,
    markdown,
    expectedRevision: revision,
  });
}

const link = (workItemId: string, pageId: string, ctx: ServiceContext = fx.ctx) =>
  pageLinksService.linkPageForWorkItem(ctx, { workItemId, pageId });
const unlink = (workItemId: string, pageId: string, ctx: ServiceContext = fx.ctx) =>
  pageLinksService.unlinkPageForWorkItem(ctx, { workItemId, pageId });

const pagesFor = (workItemId: string, ctx: ServiceContext = fx.ctx) =>
  pageLinksService.listPagesForWorkItem(ctx, { workItemId });
const itemsFor = (pageId: string, ctx: ServiceContext = fx.ctx, limit?: number, cursor?: string) =>
  pageLinksService.listWorkItemsForPage(ctx, {
    projectId: fx.projectId,
    pageId,
    limit,
    cursor,
  });

const linked = async (workItemId: string, ctx: ServiceContext = fx.ctx) =>
  (await pagesFor(workItemId, ctx)).rows.map((r) => [r.pageId, r.sources]);

const rowsOf = (pageId: string) =>
  adminDb.pageWorkItemLink.findMany({
    where: { pageId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
const rowCount = () => adminDb.pageWorkItemLink.count();
const revisionsOf = (workItemId: string) =>
  adminDb.workItemRevision.findMany({ where: { workItemId }, orderBy: { changedAt: 'asc' } });
const pageLinkRevisions = async (workItemId: string) =>
  (await revisionsOf(workItemId)).filter((r) => 'pageLinks' in (r.diff as object));

async function member(email: string): Promise<ServiceContext> {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name: email });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

/** A member whose project role is a custom role holding exactly `permissions`. */
async function memberWith(email: string, permissions: string[]): Promise<ServiceContext> {
  const ctx = await member(email);
  const role = await createCustomRoleAs({
    ctx: fx.ctx,
    name: `Role ${email}`,
    permissions: permissions as never,
  });
  await setProjectRoleDefinitionFor(ctx.userId, fx.projectId, {
    roleDefinitionId: role.id,
    role: 'member',
  });
  return ctx;
}

const inTenant = <T>(fn: Parameters<typeof withWorkspaceContext<T>>[1]) =>
  withWorkspaceContext(
    { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
    fn,
  );

/** Every refusal leaves the table and the revisions exactly as it found them. */
async function expectUntouched(workItemId: string, run: () => Promise<unknown>) {
  const rows = await rowCount();
  const revisions = (await revisionsOf(workItemId)).length;
  const error = await run().then(
    () => {
      throw new Error('expected a refusal');
    },
    (e: unknown) => e,
  );
  expect(await rowCount()).toBe(rows);
  expect((await revisionsOf(workItemId)).length).toBe(revisions);
  return error;
}

// ── 1 — a link made through the door reads back from both sides ─────────────

describe('linking through the write door', () => {
  it('the owner’s link is one manual row, read by the work item and by the page', async () => {
    const w = await item('Wired');
    const p = await newPage('Runbook');
    await link(w.id, p.id);

    const rows = await rowsOf(p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pageId: p.id,
      workItemId: w.id,
      source: 'manual',
      createdById: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });

    const section = await pagesFor(w.id);
    expect(section.rows).toHaveLength(1);
    expect(section.rows[0]).toMatchObject({
      pageId: p.id,
      sources: ['manual'],
      state: 'live',
      title: 'Runbook',
      place: { folderPath: [], parentPageTitle: null },
    });
    const strip = await itemsFor(p.id);
    expect(strip.rows).toHaveLength(1);
    expect(strip.rows[0]).toMatchObject({
      workItemId: w.id,
      summary: { accessible: true, identifier: w.identifier, title: 'Wired' },
    });
    expect(strip.canLink).toBe(true);
  });

  it('linking the same shape of pair as a second member writes their own row, once', async () => {
    const w = await item('Wired');
    const p = await newPage();
    const other = await member('second@example.com');
    await link(w.id, p.id, other);
    expect(await rowsOf(p.id)).toHaveLength(1);
    expect((await rowsOf(p.id))[0]!.createdById).toBe(other.userId);
    expect(await linked(w.id)).toEqual([[p.id, ['manual']]]);
    expect((await itemsFor(p.id)).rows.map((r) => r.workItemId)).toEqual([w.id]);
  });

  it('linking an already hand-linked pair is refused by either door and writes nothing', async () => {
    const w = await item('Wired');
    const p = await newPage();
    await link(w.id, p.id);
    const refused = await expectUntouched(w.id, () => link(w.id, p.id));
    expect(refused).toBeInstanceOf(PageLinkAlreadyExistsError);
    const byOther = await expectUntouched(w.id, async () =>
      link(w.id, p.id, await member('late@example.com')),
    );
    expect(byOther).toBeInstanceOf(PageLinkAlreadyExistsError);
  });
});

// ── 2 — unlinking ───────────────────────────────────────────────────────────

describe('unlinking', () => {
  it('removes the manual row and writes exactly one revision, whichever side the person was on', async () => {
    const a = await item('A');
    const b = await item('B');
    const p = await newPage('Runbook');
    const q = await newPage('Playbook');
    await link(a.id, p.id);
    await link(b.id, q.id);

    await unlink(a.id, p.id);
    await unlink(b.id, q.id);

    for (const [w, page] of [
      [a, p],
      [b, q],
    ] as const) {
      expect(await rowsOf(page.id)).toEqual([]);
      expect(await linked(w.id)).toEqual([]);
      expect((await itemsFor(page.id)).rows).toEqual([]);
      const revisions = await pageLinkRevisions(w.id);
      expect(revisions.map((r) => r.diff)).toEqual([
        { pageLinks: { added: [{ pageId: page.id, title: page.title }] } },
        { pageLinks: { removed: [{ pageId: page.id, title: page.title }] } },
      ]);
    }
  });

  it('refuses a pair whose only row is a derived mention, and deletes nothing', async () => {
    const w = await item('Mentioned');
    const p = await newPage();
    await writeMarkdown(p.id, `Names ${mention(w)}.`);
    const refused = await expectUntouched(w.id, () => unlink(w.id, p.id));
    expect(refused).toBeInstanceOf(PageLinkNotFoundError);
    expect(await linked(w.id)).toEqual([[p.id, ['mention']]]);
  });

  it('deletes only the manual row of a pair that also has a mention', async () => {
    const w = await item('Both');
    const p = await newPage();
    await link(w.id, p.id);
    await writeMarkdown(p.id, `Names ${mention(w)}.`);
    expect(await linked(w.id)).toEqual([[p.id, ['manual', 'mention']]]);

    await unlink(w.id, p.id);
    expect(await linked(w.id)).toEqual([[p.id, ['mention']]]);
    expect((await itemsFor(p.id)).rows).toEqual([]);
  });

  it('refuses a pair already unlinked or never linked, with no row and no revision', async () => {
    const w = await item('Gone');
    const p = await newPage();
    const never = await expectUntouched(w.id, () => unlink(w.id, p.id));
    expect(never).toBeInstanceOf(PageLinkNotFoundError);
    await link(w.id, p.id);
    await unlink(w.id, p.id);
    const again = await expectUntouched(w.id, () => unlink(w.id, p.id));
    expect(again).toBeInstanceOf(PageLinkNotFoundError);
  });
});

// ── 3 — the manual row survives every body-write door ───────────────────────

describe('a hand link survives every body write', () => {
  it('a markdown save adding then removing the mention, and a restore either way', async () => {
    const w = await item('Kept');
    const p = await newPage();
    await link(w.id, p.id);
    const manual = (await rowsOf(p.id))[0]!;

    await writeMarkdown(p.id, `Now ${mention(w)}.`);
    expect(await linked(w.id)).toEqual([[p.id, ['manual', 'mention']]]);
    expect(await rowsOf(p.id)).toHaveLength(2);

    const editor = await member('editor@example.com');
    await writeMarkdown(p.id, 'Removed.', editor);
    expect(await linked(w.id)).toEqual([[p.id, ['manual']]]);
    await writeMarkdown(p.id, 'Nothing named at all.', editor);
    expect(await linked(w.id)).toEqual([[p.id, ['manual']]]);
    expect(await rowsOf(p.id)).toEqual([manual]);

    const versions = await adminDb.pageVersion.findMany({
      where: { pageId: p.id },
      orderBy: { number: 'asc' },
    });
    const withMention = versions.find((v) => v.bodyMarkdown.includes(`motir:${w.id}`))!;
    const without = versions.find((v) => !v.bodyMarkdown.includes('motir:'))!;
    await pagesService.restorePageVersion(fx.ctx, {
      projectId: fx.projectId,
      pageId: p.id,
      number: withMention.number,
    });
    expect(await linked(w.id)).toEqual([[p.id, ['manual', 'mention']]]);
    await pagesService.restorePageVersion(editor, {
      projectId: fx.projectId,
      pageId: p.id,
      number: without.number,
    });
    expect(await linked(w.id)).toEqual([[p.id, ['manual']]]);
    expect((await rowsOf(p.id)).map((r) => [r.id, r.createdById, r.source])).toEqual([
      [manual.id, manual.createdById, 'manual'],
    ]);
  });

  it('an editor-shaped Yjs update mentioning a second item leaves the hand link untouched', async () => {
    const w = await item('Hand');
    const second = await item('Mentioned');
    const p = await newPage();
    await link(w.id, p.id);
    const manual = (await rowsOf(p.id))[0]!;

    const update = editorMentionUpdate(
      new Uint8Array((await pageRow(p.id)).bodyState),
      second.id,
      second.identifier,
    );
    await pagesService.savePageUpdate(fx.ctx, { projectId: fx.projectId, pageId: p.id, update });

    expect(await linked(second.id)).toEqual([[p.id, ['mention']]]);
    expect(await linked(w.id)).toEqual([[p.id, ['manual']]]);
    const rows = await rowsOf(p.id);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.source === 'manual')).toEqual(manual);
  });

  it('a create with an initial body does not disturb a later hand link', async () => {
    const w = await item('Born');
    const created = await pagesService.createPageFromMarkdown(fx.ctx, {
      projectId: fx.projectId,
      title: 'Born linked',
      markdown: `Builds ${mention(w)}.`,
    });
    await link(w.id, created.id);
    expect(await linked(w.id)).toEqual([[created.id, ['manual', 'mention']]]);
  });
});

// ── 4 — access ──────────────────────────────────────────────────────────────

describe('access', () => {
  it('work_item:edit without page:view is the project-access refusal of kind edit, naming no page', async () => {
    const w = await item('A');
    const p = await newPage('Confidential page title');
    const r = await memberWith('edit-only@example.com', [
      'project:browse',
      'work_item:view',
      'work_item:edit',
    ]);
    const refused = await expectUntouched(w.id, () => link(w.id, p.id, r));
    expect(refused).toBeInstanceOf(ProjectAccessDeniedError);
    expect(refused).toMatchObject({ kind: 'edit' });
    expect(JSON.stringify(refused)).not.toContain('Confidential page title');
    expect(String((refused as Error).message)).not.toContain('Confidential page title');
  });

  it('page:view without work_item:edit is refused by the work-item edit gate', async () => {
    const w = await item('A');
    const p = await newPage();
    const r = await memberWith('view-only@example.com', [
      'project:browse',
      'work_item:view',
      'page:view',
    ]);
    const refused = await expectUntouched(w.id, () => link(w.id, p.id, r));
    expect(refused).toBeInstanceOf(ProjectAccessDeniedError);
    // …and it may still READ both sides, with no capability to link.
    expect((await itemsFor(p.id, r)).canLink).toBe(false);
  });

  it('a Visitor is refused by the write door and by both reads, naming no title or id', async () => {
    const w = await item('Visitor-hidden item title');
    const p = await newPage('Members-only page title');
    await link(w.id, p.id);
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
    for (const run of [
      () => link(w.id, p.id, visitor as never),
      () => unlink(w.id, p.id, visitor as never),
      () => pagesFor(w.id, visitor as never),
      () => itemsFor(p.id, visitor as never),
    ]) {
      const refused = await run().then(
        () => {
          throw new Error('expected a refusal');
        },
        (e: unknown) => e,
      );
      const text = JSON.stringify(refused) + String((refused as Error).message);
      expect(text).not.toContain('Members-only page title');
      expect(text).not.toContain('Visitor-hidden item title');
      expect(text).not.toContain(p.id);
    }
    expect(await rowCount()).toBe(1);
  });

  it('a page of another project in the same workspace is refused before the cotenancy trigger', async () => {
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTH',
    });
    const foreignItem = await item('Elsewhere', {
      ...fx,
      projectId: other.id,
      projectIdentifier: 'OTH',
    });
    const page = await newPage();
    const refused = await expectUntouched(foreignItem.id, () => link(foreignItem.id, page.id));
    // The service’s own typed not-found — never the raw trigger violation.
    expect(String((refused as Error).message)).not.toMatch(/PAGE_LINK_.*_CROSS_PROJECT/);
    expect((refused as { code?: string }).code).toBe('PAGE_NOT_FOUND');
  });

  it('a work item of another workspace gets the same not-found an unknown id gets', async () => {
    const theirs = await makeWorkItemFixture({ name: 'Theirs', identifier: 'THR' });
    const theirItem = await item('Theirs', theirs);
    const page = await newPage();
    const cross = await expectUntouched(theirItem.id, () => link(theirItem.id, page.id));
    const unknown = await link('ckunknownworkitem0000000', page.id).catch((e: unknown) => e);
    expect(cross).toBeInstanceOf(WorkItemNotFoundError);
    expect(unknown).toBeInstanceOf(WorkItemNotFoundError);
    expect((cross as WorkItemNotFoundError).code).toBe((unknown as WorkItemNotFoundError).code);
    expect(await rowCount()).toBe(0);
  });
});

// ── 5 — tenancy ─────────────────────────────────────────────────────────────

describe('tenancy', () => {
  it('a hand link is visible under motir_app in its own workspace and invisible from another', async () => {
    const w = await item('Tenant');
    const p = await newPage();
    await link(w.id, p.id);

    const own = await inTenant(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
      return tx.pageWorkItemLink.count();
    });
    expect(own).toBe(1);
    expect((await pagesFor(w.id)).rows).toHaveLength(1);
    expect((await itemsFor(p.id)).rows).toHaveLength(1);

    const theirs = await makeWorkItemFixture({ name: 'Theirs', identifier: 'THR' });
    const foreign = await withWorkspaceContext(
      { userId: theirs.ownerId, workspaceId: theirs.workspaceId, projectId: theirs.projectId },
      async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
        return tx.pageWorkItemLink.count();
      },
    );
    expect(foreign).toBe(0);
    await expect(pagesFor(w.id, theirs.ctx)).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});

// ── 6 — the page-side read ──────────────────────────────────────────────────

describe('the page-side read', () => {
  it('keeps a hand link to an archived work item on the strip, marked archived', async () => {
    const w = await item('Retired item');
    const p = await newPage();
    await link(w.id, p.id);
    await workItemsService.archiveWorkItem(w.id, fx.ctx);
    const read = await itemsFor(p.id);
    expect(read.rows).toHaveLength(1);
    expect(read.rows[0]!.summary).toMatchObject({ accessible: true, archived: true });
    await unlink(w.id, p.id);
    expect((await itemsFor(p.id)).rows).toEqual([]);
  });

  it('walks three hand links with a small limit: each once, ending in a null cursor', async () => {
    const p = await newPage();
    const ws = [await item('One'), await item('Two'), await item('Three')];
    for (const w of ws) await link(w.id, p.id);

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const page = await itemsFor(p.id, fx.ctx, 2, cursor);
      seen.push(...page.rows.map((r) => r.workItemId));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect([...seen].sort()).toEqual(ws.map((w) => w.id).sort());
    expect(new Set(seen).size).toBe(3);
    await expect(itemsFor(p.id, fx.ctx, 2, 'not-a-cursor')).rejects.toBeInstanceOf(
      PageLevelCursorInvalidError,
    );
  });

  it('walks three hand-linked pages on the work item side with limit 2, none displaced by derived rows', async () => {
    const w = await item('Hub');
    const pages = [await newPage('P1'), await newPage('P2'), await newPage('P3')];
    for (const p of pages) await link(w.id, p.id);
    await writeMarkdown(pages[0]!.id, `Names ${mention(w)}.`);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const read: Awaited<ReturnType<typeof pagesFor>> =
        await pageLinksService.listPagesForWorkItem(fx.ctx, {
          workItemId: w.id,
          limit: 2,
          cursor,
        });
      seen.push(...read.rows.map((r) => r.pageId));
      cursor = read.nextCursor;
      if (cursor === null) break;
    }
    expect([...seen].sort()).toEqual(pages.map((p) => p.id).sort());
    expect(new Set(seen).size).toBe(3);
  });

  it('orders the section by the page’s edit time, so a newly linked page is not first', async () => {
    const w = await item('Order');
    const stale = await newPage('Edited long ago');
    const fresh = await newPage('Edited recently');
    await adminDb.page.update({
      where: { id: stale.id },
      data: { updatedAt: new Date('2026-01-01T00:00:00Z') },
    });
    await adminDb.page.update({
      where: { id: fresh.id },
      data: { updatedAt: new Date('2026-10-01T00:00:00Z') },
    });
    await link(w.id, fresh.id);
    await link(w.id, stale.id); // linked LAST
    expect((await pagesFor(w.id)).rows.map((r) => r.pageId)).toEqual([fresh.id, stale.id]);
  });
});

// ── 7 — archive, delete ─────────────────────────────────────────────────────

describe('archive and delete', () => {
  it('archiving serves the pair as unavailable on the item and empty on the page; restoring returns it live', async () => {
    const w = await item('A');
    const p = await newPage();
    await link(w.id, p.id);
    const before = await rowsOf(p.id);

    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: p.id });
    expect((await pagesFor(w.id)).rows.map((r) => [r.pageId, r.sources, r.state])).toEqual([
      [p.id, ['manual'], 'unavailable'],
    ]);
    expect(await itemsFor(p.id)).toEqual({ rows: [], nextCursor: null, canLink: false });
    expect(await rowsOf(p.id)).toEqual(before);
    // A link to an archived page cannot be CREATED, but it can still be removed.
    const other = await item('B');
    await expect(link(other.id, p.id)).rejects.toMatchObject({ code: 'PAGE_ARCHIVED' });

    await pagesService.restorePage(fx.ctx, { projectId: fx.projectId, pageId: p.id });
    expect((await pagesFor(w.id)).rows.map((r) => [r.pageId, r.sources, r.state])).toEqual([
      [p.id, ['manual'], 'live'],
    ]);
    expect(await rowsOf(p.id)).toEqual(before);
  });

  it('an archived hand link can still be unlinked', async () => {
    const w = await item('A');
    const p = await newPage();
    await link(w.id, p.id);
    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: p.id });
    await unlink(w.id, p.id);
    expect(await rowsOf(p.id)).toEqual([]);
    expect(await linked(w.id)).toEqual([]);
  });

  it('deleting the page, and separately the work item, removes that side’s manual rows only', async () => {
    const a = await item('A');
    const b = await item('B');
    const doomed = await newPage('Doomed');
    const kept = await newPage('Kept');
    await link(a.id, doomed.id);
    await link(a.id, kept.id);
    await link(b.id, kept.id);

    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: doomed.id });
    await pagesService.deletePage(fx.ctx, { projectId: fx.projectId, pageId: doomed.id });
    expect(await rowsOf(doomed.id)).toEqual([]);
    expect(await linked(a.id)).toEqual([[kept.id, ['manual']]]);

    await workItemsService.deleteWorkItem(a.id, fx.ctx);
    expect((await rowsOf(kept.id)).map((r) => r.workItemId)).toEqual([b.id]);
    expect((await itemsFor(kept.id)).rows.map((r) => r.workItemId)).toEqual([b.id]);
  });
});

// ── 8 — the revision trail ──────────────────────────────────────────────────

describe('the revision trail', () => {
  it('a link and an unlink are two updated revisions naming the page, and touch no page history', async () => {
    const w = await item('Trail');
    const p = await newPage('Named page');
    const pageBefore = await pageRow(p.id);
    const versionsBefore = await adminDb.pageVersion.count({ where: { pageId: p.id } });

    await link(w.id, p.id);
    await unlink(w.id, p.id);

    const revisions = await pageLinkRevisions(w.id);
    expect(revisions.map((r) => r.changeKind)).toEqual(['updated', 'updated']);
    expect(JSON.stringify(revisions[0]!.diff)).toContain('Named page');
    expect(JSON.stringify(revisions[1]!.diff)).toContain('Named page');
    const pageAfter = await pageRow(p.id);
    expect(pageAfter.revision).toBe(pageBefore.revision);
    expect(await adminDb.pageVersion.count({ where: { pageId: p.id } })).toBe(versionsBefore);
  });

  it('a body write after a hand link adds a page version and no link revision', async () => {
    const w = await item('Trail');
    const p = await newPage();
    await link(w.id, p.id);
    const before = (await pageLinkRevisions(w.id)).length;
    await writeMarkdown(p.id, 'Edited body.');
    expect((await pageLinkRevisions(w.id)).length).toBe(before);
    expect(await adminDb.pageVersion.count({ where: { pageId: p.id } })).toBeGreaterThan(0);
  });
});
