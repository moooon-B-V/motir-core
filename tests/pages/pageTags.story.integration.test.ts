import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { PageMentionCandidateDto } from '@/lib/dto/pages';
import { pageLinksService } from '@/lib/services/pageLinksService';
import { pagesService } from '@/lib/services/pagesService';
import { usersService } from '@/lib/services/usersService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import type { WorkspaceContext } from '@/lib/workspaces';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { projectAccessData } from '@/tests/helpers/projectAccess';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestProject } from '../fixtures/projectFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { createCustomRoleAs, setProjectRoleDefinitionFor } from '../helpers/workspaceRoleFixtures';
import { consentedVisitor } from '../visitor/_consentedVisitor';

// STORY MOTIR-7694's INTEGRATION GATE (MOTIR-7699) — "tag a page in a work
// item's Description and Explanation", assembled on real Postgres through the
// real doors. Each card tested its own layer: the token grammar and the row
// derivation (MOTIR-7696), the page search and chip summaries (MOTIR-7697), the
// picker and the chip (MOTIR-7698). What none of them saw is a body saved
// through `workItemsService` meeting a body saved through `pagesService` on the
// same link table, read back through the Pages read, the search route and the
// item's own reads.
//
// Mocked: the session's workspace context only (`getWorkspaceContext`, which the
// routes read — there are no cookies in a test). The one spy forces a failure
// AFTER the derivation inside the update's transaction, so the rollback case
// proves the rows ride that transaction.

const ctxRef = vi.hoisted(() => ({ current: null as WorkspaceContext | null }));
vi.mock('@/lib/workspaces', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspaces')>();
  return { ...actual, getWorkspaceContext: async () => ctxRef.current };
});

const { GET: SEARCH } = await import('@/app/api/pages/mention-search/route');
const { GET: ITEM_PAGES } = await import('@/app/api/work-items/[id]/pages/route');

let fx: WorkItemFixture;
let seq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture({ name: 'Tags', identifier: `TAG${seq++}` });
  ctxRef.current = { userId: fx.ownerId, workspaceId: fx.workspaceId };
});

// A Visitor resolves only on a cloud build (`resolveVisitor`'s first line).
let previousCloud: string | undefined;
let cloudSet = false;
function asCloud() {
  previousCloud = process.env['MOTIR_CLOUD'];
  cloudSet = true;
  process.env['MOTIR_CLOUD'] = 'true';
}

afterEach(() => {
  vi.restoreAllMocks();
  if (cloudSet) {
    if (previousCloud === undefined) delete process.env['MOTIR_CLOUD'];
    else process.env['MOTIR_CLOUD'] = previousCloud;
    cloudSet = false;
  }
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const tag = (page: { id: string }, label = 'Page') => `[${label}](motir-page:${page.id})`;

const newPage = (title = 'Spec', projectId = fx.projectId) =>
  pagesService.createPage(fx.ctx, { projectId, title });

const createItem = (fields: { descriptionMd?: string; explanationMd?: string }) =>
  workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Tagged item', ...fields },
    fx.ctx,
  );

const update = (id: string, patch: { descriptionMd?: string; explanationMd?: string }) =>
  workItemsService.updateWorkItem(id, patch, fx.ctx);

/** Every link row on the item as `[pageId, source]`, the shape the cases assert. */
const rowsOf = async (workItemId: string) =>
  (
    await adminDb.pageWorkItemLink.findMany({
      where: { workItemId },
      orderBy: [{ source: 'asc' }, { pageId: 'asc' }],
    })
  ).map((r) => [r.pageId, r.source]);

const sorted = (pairs: string[][]) => [...pairs].sort((a, b) => (a.join() < b.join() ? -1 : 1));

/** The Pages read's rows as `[pageId, sources]`. */
const pagesRead = async (workItemId: string, ctx: ServiceContext = fx.ctx) =>
  (await pageLinksService.listPagesForWorkItem(ctx, { workItemId })).rows.map((r) => [
    r.pageId,
    r.sources,
  ]);

/** Write a page's whole body through the markdown door. */
async function writePage(pageId: string, markdown: string) {
  const { revision } = await adminDb.page.findUniqueOrThrow({ where: { id: pageId } });
  return pagesService.savePageMarkdown(fx.ctx, {
    projectId: fx.projectId,
    pageId,
    markdown,
    expectedRevision: revision,
  });
}

/** A `manual` row, written under the tenant's non-bypass role. */
const manualRow = (pageId: string, workItemId: string) =>
  withWorkspaceContext(
    { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
    async (tx) => {
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
    },
  );

/** A workspace member on a custom role that browses the project but lacks `page:view`. */
async function readerWithoutPageView(): Promise<ServiceContext> {
  const role = await createCustomRoleAs({
    ctx: fx.ctx,
    name: 'No pages',
    permissions: ['project:browse', 'work_item:view'],
  });
  const user = await usersService.createUser({
    email: `no-pages-${seq++}@example.com`,
    password: 'hunter2hunter2',
    name: 'No pages',
  });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  await setProjectRoleDefinitionFor(user.id, fx.projectId, {
    roleDefinitionId: role.id,
    role: 'member',
  });
  return { userId: user.id, workspaceId: fx.workspaceId };
}

function search(params: Record<string, string>): Promise<Response> {
  const url = new URL('http://localhost:3000/api/pages/mention-search');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return SEARCH(new Request(url));
}

// ── 1 — create and update derive rows in the save's transaction ─────────────

describe('1 · create and update derive rows inside the save', () => {
  it('a create tags P in the Description; an update tags P and Q in the Explanation', async () => {
    const p = await newPage('P');
    const q = await newPage('Q');
    const item = await createItem({ descriptionMd: `See ${tag(p)}.` });
    expect(await rowsOf(item.id)).toEqual([[p.id, 'description']]);

    await update(item.id, { explanationMd: `Why: ${tag(p)} and ${tag(q)}.` });
    expect(sorted(await rowsOf(item.id))).toEqual(
      sorted([
        [p.id, 'description'],
        [p.id, 'explanation'],
        [q.id, 'explanation'],
      ]),
    );
  });

  it('an update that fails after the derivation leaves no new row', async () => {
    const p = await newPage('P');
    const q = await newPage('Q');
    const item = await createItem({ descriptionMd: tag(p) });
    // The revision write runs after the derivation, in the same transaction.
    vi.spyOn(workItemRevisionsService, 'recordRevision').mockRejectedValueOnce(
      new Error('the save failed'),
    );
    await expect(update(item.id, { explanationMd: tag(q) })).rejects.toThrow('the save failed');
    expect(await rowsOf(item.id)).toEqual([[p.id, 'description']]);
    const stored = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stored.explanationMd).toBeNull();
  });
});

// ── 2 — removal, and isolation from the page side and manual rows ──────────

describe('2 · removal and isolation', () => {
  it('removing a tag drops only its row; a page save and a manual row leave item rows alone', async () => {
    const p = await newPage('P');
    const item = await createItem({ descriptionMd: tag(p), explanationMd: tag(p) });
    await writePage(p.id, `Tracks [${item.identifier}](motir:${item.id}).`);
    const manual = await manualRow(p.id, item.id);
    expect(sorted(await rowsOf(item.id))).toEqual(
      sorted([
        [p.id, 'description'],
        [p.id, 'explanation'],
        [p.id, 'manual'],
        [p.id, 'mention'],
      ]),
    );

    // The Description loses its tag: only `(P, item, description)` goes.
    await update(item.id, { descriptionMd: 'No tag now.' });
    expect(sorted(await rowsOf(item.id))).toEqual(
      sorted([
        [p.id, 'explanation'],
        [p.id, 'manual'],
        [p.id, 'mention'],
      ]),
    );

    // P's own body drops its mention of the item: only the `mention` row goes.
    await writePage(p.id, 'No mention now.');
    expect(sorted(await rowsOf(item.id))).toEqual(
      sorted([
        [p.id, 'explanation'],
        [p.id, 'manual'],
      ]),
    );
    expect(
      await adminDb.pageWorkItemLink.findUniqueOrThrow({ where: { id: manual.id } }),
    ).toMatchObject({ source: 'manual', createdById: fx.ownerId });
  });
});

// ── 3 — foreign and unknown tokens ──────────────────────────────────────────

describe('3 · foreign and unknown tokens', () => {
  it('a page of another project and a random id write no row, and the save succeeds', async () => {
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: `OTH${seq++}`,
    });
    const foreign = await newPage('Foreign', other.id);
    const item = await createItem({
      descriptionMd: `${tag(foreign)} and ${tag({ id: 'cknotapage000000000000000' })}`,
    });
    expect(item.descriptionMd).toContain(`motir-page:${foreign.id}`);
    expect(await rowsOf(item.id)).toEqual([]);
  });
});

// ── 4 — archive and delete ──────────────────────────────────────────────────

describe('4 · archive, restore and delete', () => {
  it('archive keeps the rows and drops the read; restore brings it back; delete cascades', async () => {
    const p = await newPage('Roadmap Q4');
    const item = await createItem({ descriptionMd: tag(p) });
    expect(await pagesRead(item.id)).toEqual([[p.id, ['description']]]);

    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: p.id });
    expect(await rowsOf(item.id)).toEqual([[p.id, 'description']]);
    expect(await pagesRead(item.id)).toEqual([]);

    await pagesService.restorePage(fx.ctx, { projectId: fx.projectId, pageId: p.id });
    expect(await pagesRead(item.id)).toEqual([[p.id, ['description']]]);

    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: p.id });
    await pagesService.deletePage(fx.ctx, { projectId: fx.projectId, pageId: p.id });
    expect(await rowsOf(item.id)).toEqual([]);
    expect(await pagesService.resolvePageRefSummaries([p.id], fx.projectId, fx.ctx)).toEqual({
      [p.id]: { state: 'unavailable', id: p.id },
    });
  });
});

// ── 5 — the search route ────────────────────────────────────────────────────

describe('5 · GET /api/pages/mention-search', () => {
  it('returns same-project live matches only, with LIKE wildcards taken literally', async () => {
    const roadmap = await newPage('Roadmap');
    await newPage('100% done');
    await newPage('1000 done');
    const archived = await newPage('Old roadmap');
    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: archived.id });
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: `OTH${seq++}`,
    });
    await newPage('Roadmap elsewhere', other.id);

    const res = await search({ projectId: fx.projectId, q: 'road' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as PageMentionCandidateDto[]).map((r) => r.id)).toEqual([
      roadmap.id,
    ]);

    const pct = (await (
      await search({ projectId: fx.projectId, q: '0%' })
    ).json()) as PageMentionCandidateDto[];
    expect(pct.map((r) => r.title)).toEqual(['100% done']);
    const underscore = (await (
      await search({ projectId: fx.projectId, q: '0_' })
    ).json()) as PageMentionCandidateDto[];
    expect(underscore).toEqual([]);
  });

  it('400 under two characters; 403 for a member whose role lacks page:view', async () => {
    expect((await search({ projectId: fx.projectId, q: 'r' })).status).toBe(400);
    const reader = await readerWithoutPageView();
    ctxRef.current = { userId: reader.userId, workspaceId: fx.workspaceId };
    expect((await search({ projectId: fx.projectId, q: 'ro' })).status).toBe(403);
  });
});

// ── 6 — chip summaries ──────────────────────────────────────────────────────

describe('6 · chip summaries', () => {
  it('available with the CURRENT title; unavailable with no title for every other cause', async () => {
    const live = await newPage('Draft title');
    await pagesService.renamePage(fx.ctx, {
      projectId: fx.projectId,
      pageId: live.id,
      title: 'Roadmap Q4',
    });
    const archived = await newPage('Archived page');
    await pagesService.archivePage(fx.ctx, { projectId: fx.projectId, pageId: archived.id });
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: `OTH${seq++}`,
    });
    const foreign = await newPage('Foreign page', other.id);
    const unknown = 'cknotapage000000000000000';
    const ids = [live.id, archived.id, foreign.id, unknown];

    const refs = await pagesService.resolvePageRefSummaries(ids, fx.projectId, fx.ctx);
    expect(refs).toEqual({
      [live.id]: { state: 'available', id: live.id, title: 'Roadmap Q4' },
      [archived.id]: { state: 'unavailable', id: archived.id },
      [foreign.id]: { state: 'unavailable', id: foreign.id },
      [unknown]: { state: 'unavailable', id: unknown },
    });
    for (const id of [archived.id, foreign.id, unknown])
      expect(refs[id]).not.toHaveProperty('title');

    const reader = await readerWithoutPageView();
    const blind = await pagesService.resolvePageRefSummaries([live.id], fx.projectId, reader);
    expect(blind).toEqual({ [live.id]: { state: 'unavailable', id: live.id } });
  });

  it('a Visitor gets every id unavailable', async () => {
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: projectAccessData('public'),
    });
    const page = await newPage('Roadmap Q4');
    asCloud();
    const visitor = await consentedVisitor(fx.projectIdentifier);
    expect(await pagesService.resolvePageRefSummaries([page.id], fx.projectId, visitor)).toEqual({
      [page.id]: { state: 'unavailable', id: page.id },
    });
  });
});

// ── 7 — the Pages read's labels ─────────────────────────────────────────────

describe('7 · GET /api/work-items/[id]/pages', () => {
  it('one row per page, with description beside mention', async () => {
    const p = await newPage('Both ways');
    const item = await createItem({ descriptionMd: tag(p) });
    await writePage(p.id, `Tracks [${item.identifier}](motir:${item.id}).`);

    const res = await ITEM_PAGES(
      new Request(`http://localhost:3000/api/work-items/${item.id}/pages`),
      { params: Promise.resolve({ id: item.id }) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ pageId: string; sources: string[] }> };
    // Sources aggregate in name order (`array_agg … ORDER BY source`).
    expect(body.rows.map((r) => [r.pageId, r.sources])).toEqual([
      [p.id, ['description', 'mention']],
    ]);
  });
});

// ── 8 — Visitor redaction ───────────────────────────────────────────────────

describe('8 · a Visitor read carries no page title', () => {
  it('the item detail and the peek name the page by id only', async () => {
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: projectAccessData('public'),
    });
    const page = await newPage('Roadmap Q4');
    const item = await createItem({
      descriptionMd: `See ${tag(page, 'Roadmap Q4')}.`,
      explanationMd: `Because ${tag(page, 'Roadmap Q4')}.`,
    });
    asCloud();
    const visitor = await consentedVisitor(fx.projectIdentifier);

    const detail = await workItemsService.getIssueDetail(fx.projectId, item.identifier, visitor);
    expect(detail.item.descriptionMd).toBe(`See [page](motir-page:${page.id}).`);
    expect(JSON.stringify(detail)).not.toContain('Roadmap Q4');

    const peek = await workItemsService.getVisitorQuickView(item.identifier, visitor, 'en');
    expect(peek.pageRefs).toEqual({ [page.id]: { state: 'unavailable', id: page.id } });
    expect(JSON.stringify(peek)).not.toContain('Roadmap Q4');
  });
});
