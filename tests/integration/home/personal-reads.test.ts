import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { homeService } from '@/lib/services/homeService';
import { watcherRepository } from '@/lib/repositories/watcherRepository';
import { workspacesService } from '@/lib/services/workspacesService';
import { workflowsService } from '@/lib/services/workflowsService';
import { decodeHomeCursor, encodeHomeCursor } from '@/lib/home/cursor';
import { truncateAuthTables } from '../../helpers/db';
import {
  createTestProject,
  createTestUser,
  createTestWorkItem as createWorkItem,
  makeWorkItemFixture as makeFixture,
  type WorkItemFixture,
} from '../../fixtures';

// The Home personal reads (Story MOTIR-2649 · Subtask MOTIR-2651) against a REAL
// Postgres (the motir-core no-mocks rule). These are the SUBTASK-level tests —
// the reads' own behaviour. The story-level matrix (the full access matrix with
// its positive controls, the page-boundary dedupe, the active-project
// coverage of every branch) is MOTIR-2655.
//
// Two properties get most of the attention here because they are the two the
// card exists for, and both are invisible in a small fixture:
//   * the DEDUPE holds ACROSS A PAGE BOUNDARY, not merely within one page;
//   * the access filter is a QUERY INPUT, so a filtered-out row shortens
//     nothing — request N, get N.
//
// ⚠️ THE READS TAKE AN ACTIVE PROJECT (MOTIR-2761). They were workspace-scoped
// until 2026-08-17; `hctx()` below is the context they now take, and the access
// cases point the reader AT the project under test rather than beside it —
// otherwise the project axis alone excludes the row and the browsable-set filter
// could be deleted with every assertion still green.

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "watcher", "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await db.$disconnect();
});

const keys = (rows: { identifier: string }[]) => rows.map((r) => r.identifier).sort();

/**
 * The reader's context AS HOME NOW TAKES IT — the workspace pair plus the ACTIVE
 * project (MOTIR-2761). Required rather than optional, so there is no call shape
 * that quietly reverts to the workspace scope this card removed.
 */
const hctx = (fx: WorkItemFixture, projectId: string = fx.projectId) => ({
  ...fx.ctx,
  projectId,
});

/** Force a row's `updatedAt` so the (updatedAt, id) order is deterministic. */
async function touch(id: string, iso: string): Promise<void> {
  await adminDb.workItem.update({ where: { id }, data: { updatedAt: new Date(iso) } });
}

/** Point an item at a reader: assignee, reporter, or both. */
async function own(
  id: string,
  who: { assignee?: string | null; reporter?: string },
): Promise<void> {
  await adminDb.workItem.update({
    where: { id },
    data: {
      ...(who.assignee !== undefined ? { assigneeId: who.assignee } : {}),
      ...(who.reporter !== undefined ? { reporterId: who.reporter } : {}),
    },
  });
}

/** A second workspace member who is NOT on any private project. */
async function enrolMember(fx: WorkItemFixture, slug: string) {
  const user = await createTestUser({ email: `${slug}-${Date.now()}@example.com`, name: slug });
  await workspacesService.addMember({
    userId: user.id,
    workspaceId: fx.workspaceId,
    role: 'member',
  });
  return user;
}

describe('homeService.listMyWork — the assigned-OR-reported read', () => {
  it('returns assigned-only, reported-only and BOTH — and nothing the reader has no relation to', async () => {
    const fx = await makeFixture({ identifier: 'HOM' });
    const other = await enrolMember(fx, 'other');

    const assigned = await createWorkItem(fx, { kind: 'task', title: 'Assigned to me' });
    const reported = await createWorkItem(fx, { kind: 'task', title: 'I filed it' });
    const both = await createWorkItem(fx, { kind: 'task', title: 'Mine twice over' });
    const neither = await createWorkItem(fx, { kind: 'task', title: 'Not mine at all' });

    // The fixture reports every item as the owner, so hand three of them away.
    await own(assigned.id, { assignee: fx.ownerId, reporter: other.id });
    await own(reported.id, { assignee: other.id, reporter: fx.ownerId });
    await own(both.id, { assignee: fx.ownerId, reporter: fx.ownerId });
    await own(neither.id, { assignee: other.id, reporter: other.id });

    const page = await homeService.listMyWork(hctx(fx));

    expect(keys(page.items)).toEqual(['HOM-1', 'HOM-2', 'HOM-3']);
    expect(page.items.map((r) => r.identifier)).not.toContain(neither.identifier);
  });

  it('DEDUPES: an item the reader both owns and filed comes back exactly once, carrying both facts', async () => {
    const fx = await makeFixture({ identifier: 'DED' });
    const both = await createWorkItem(fx, { kind: 'task', title: 'Assigned AND reported' });
    await own(both.id, { assignee: fx.ownerId, reporter: fx.ownerId });

    const page = await homeService.listMyWork(hctx(fx));

    // A count assertion, not a visibility one — visibility passes with duplicates.
    expect(page.items.filter((r) => r.id === both.id)).toHaveLength(1);
    const row = page.items[0]!;
    expect(row.viewerIsAssignee).toBe(true);
    expect(row.viewerIsReporter).toBe(true);
  });

  it('distinguishes the three relations on the row itself', async () => {
    const fx = await makeFixture({ identifier: 'REL' });
    const other = await enrolMember(fx, 'rel');
    const assigned = await createWorkItem(fx, { kind: 'task', title: 'A' });
    const reported = await createWorkItem(fx, { kind: 'task', title: 'R' });
    await own(assigned.id, { assignee: fx.ownerId, reporter: other.id });
    await own(reported.id, { assignee: other.id, reporter: fx.ownerId });

    const page = await homeService.listMyWork(hctx(fx));
    const byId = new Map(page.items.map((r) => [r.id, r]));

    expect(byId.get(assigned.id)).toMatchObject({
      viewerIsAssignee: true,
      viewerIsReporter: false,
    });
    expect(byId.get(reported.id)).toMatchObject({
      viewerIsAssignee: false,
      viewerIsReporter: true,
    });
  });

  it('reads ONE project — the ACTIVE one — and switching it changes the answer (MOTIR-2761)', async () => {
    const fx = await makeFixture({ identifier: 'PRJA' });
    const second = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Atlas',
      identifier: 'PRJB',
    });
    const here = await createWorkItem(fx, { kind: 'task', title: 'In project A' });
    // A second project needs its own fixture handle for the create dance.
    const fxB: WorkItemFixture = {
      ...fx,
      project: second,
      projectId: second.id,
      projectIdentifier: second.identifier,
    };
    const there = await createWorkItem(fxB, { kind: 'task', title: 'In project B' });

    // The INVERSION of what this asserted until MOTIR-2761 ("spans EVERY project
    // in the workspace from one call, with no projectId"). The reader owns BOTH
    // items — the only thing separating them is which project is active, which
    // is what makes the pair of reads below evidence rather than a tautology.
    const inA = await homeService.listMyWork(hctx(fx, fx.projectId));
    const inB = await homeService.listMyWork(hctx(fx, second.id));

    expect(keys(inA.items)).toEqual(['PRJA-1']);
    expect(keys(inB.items)).toEqual(['PRJB-1']);
    expect(inA.items.map((r) => r.id)).not.toContain(there.id);
    // The row still knows its project — the DTO is unchanged; what went is the
    // CELL that rendered it (a column repeating the page's own scope).
    expect(inA.items[0]).toMatchObject({ id: here.id });
    expect(inA.items[0]?.project).toMatchObject({ identifier: 'PRJA', name: 'Motir' });
    expect(inB.items[0]?.project).toMatchObject({ identifier: 'PRJB', name: 'Atlas' });
  });

  it('never returns an item from a project the reader may not BROWSE — and the page is not merely shortened', async () => {
    const fx = await makeFixture({ identifier: 'OPEN' });
    const secret = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Secret',
      identifier: 'SEC',
    });
    await adminDb.project.update({ where: { id: secret.id }, data: { accessLevel: 'private' } });
    const fxSecret: WorkItemFixture = {
      ...fx,
      project: secret,
      projectId: secret.id,
      projectIdentifier: secret.identifier,
    };

    const visible = await createWorkItem(fx, { kind: 'task', title: 'Visible' });
    const hidden = await createWorkItem(fxSecret, { kind: 'task', title: 'Hidden' });

    // A plain workspace MEMBER — not a manager, not on the private project.
    const member = await enrolMember(fx, 'nonmember');
    await own(visible.id, { assignee: member.id, reporter: fx.ownerId });
    await own(hidden.id, { assignee: member.id, reporter: fx.ownerId });

    // ⚠️ THE PRIVATE PROJECT IS THE ACTIVE ONE. Since MOTIR-2761 narrowed the
    // scope, an access test that leaves the readable project active proves
    // nothing — the private rows are out on the project axis alone and the
    // browsable filter could be deleted with every assertion still green. So the
    // reader is pointed AT the project they may not browse, which is a real
    // state: the active-project pointer is a stored preference and project
    // membership can be revoked under it.
    const ctx = { userId: member.id, workspaceId: fx.workspaceId, projectId: secret.id };
    const page = await homeService.listMyWork(ctx);

    // Empty, not an error, and not the OTHER project's rows either.
    expect(page).toEqual({ items: [], nextCursor: null });
    expect(page.items.map((r) => r.id)).not.toContain(hidden.id);

    // THE CONTROL: the reader IS the assignee of the hidden item, and the same
    // read against the project they MAY browse returns theirs — so the empty
    // above is the access filter, not an empty fixture.
    const allowed = await homeService.listMyWork({ ...ctx, projectId: fx.projectId });
    expect(keys(allowed.items)).toEqual(['OPEN-1']);

    // ⚠️ And the filter is a QUERY INPUT, not a post-read drop: asking for one
    // row returns a FULL page of one, with a cursor, rather than a short page.
    const first = await homeService.listMyWork({ ...ctx, projectId: fx.projectId }, { limit: 1 });
    expect(first.items).toHaveLength(1);
  });

  it('returns nothing for a reader who is not a member of the workspace at all', async () => {
    const fx = await makeFixture({ identifier: 'STR' });
    const item = await createWorkItem(fx, { kind: 'task', title: 'Someone else s' });
    const stranger = await createTestUser({ email: `stranger-${Date.now()}@example.com` });
    await own(item.id, { assignee: stranger.id, reporter: stranger.id });

    const page = await homeService.listMyWork({
      userId: stranger.id,
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
    });

    // Empty, not an error — the no-existence-leak convention every project gate follows.
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it('does not reach across workspaces', async () => {
    const fx = await makeFixture({ identifier: 'WSA' });
    const otherWs = await makeFixture({ identifier: 'WSB' });
    // The SAME person owns an item in each workspace.
    const there = await createWorkItem(otherWs, { kind: 'task', title: 'Other workspace' });
    await own(there.id, { assignee: fx.ownerId, reporter: fx.ownerId });
    const here = await createWorkItem(fx, { kind: 'task', title: 'This workspace' });

    const page = await homeService.listMyWork(hctx(fx));

    expect(page.items.map((r) => r.id)).toEqual([here.id]);
  });

  it('returns an agent-executed item like any other, carrying its executor', async () => {
    const fx = await makeFixture({ identifier: 'AGT' });
    await createWorkItem(fx, {
      kind: 'task',
      title: 'An agent is on it',
      type: 'code',
      executor: 'coding_agent',
    });
    await createWorkItem(fx, {
      kind: 'task',
      title: 'A person is on it',
      type: 'manual',
      executor: 'human',
    });

    const page = await homeService.listMyWork(hctx(fx));

    expect(keys(page.items)).toEqual(['AGT-1', 'AGT-2']);
    expect(page.items.map((r) => r.executor).sort()).toEqual(['coding_agent', 'human']);
  });

  it('carries the estimate columns through, story points included', async () => {
    const fx = await makeFixture({ identifier: 'EST' });
    const sized = await createWorkItem(fx, { kind: 'task', title: 'Sized' });
    const unsized = await createWorkItem(fx, { kind: 'task', title: 'Unsized' });
    await adminDb.workItem.update({
      where: { id: sized.id },
      data: { storyPoints: 2.5, estimateMinutes: 45 },
    });

    const page = await homeService.listMyWork(hctx(fx));
    const byId = new Map(page.items.map((r) => [r.id, r]));

    // `storyPoints` is a Prisma Decimal on the row — the mapper narrows it to a
    // plain number for the wire, and leaves an unestimated item null.
    expect(byId.get(sized.id)).toMatchObject({ storyPoints: 2.5, estimateMinutes: 45 });
    expect(byId.get(unsized.id)).toMatchObject({ storyPoints: null, estimateMinutes: null });
  });

  it('clamps a nonsense page size instead of trusting it', async () => {
    const fx = await makeFixture({ identifier: 'CLP' });
    for (let i = 0; i < 3; i += 1) {
      await createWorkItem(fx, { kind: 'task', title: `C${i}` });
    }

    // Zero / negative / non-finite fall back to the default; a huge one is capped.
    expect((await homeService.listMyWork(hctx(fx), { limit: 0 })).items).toHaveLength(3);
    expect((await homeService.listMyWork(hctx(fx), { limit: -5 })).items).toHaveLength(3);
    expect((await homeService.listMyWork(hctx(fx), { limit: Number.NaN })).items).toHaveLength(3);
    expect((await homeService.listMyWork(hctx(fx), { limit: 10_000 })).items).toHaveLength(3);
    expect((await homeService.listMyWork(hctx(fx), { limit: 2 })).items).toHaveLength(2);
  });

  it('orders by updatedAt DESC and pages by a keyset — the union of two pages repeats and drops nothing', async () => {
    const fx = await makeFixture({ identifier: 'PAG' });
    const made: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const item = await createWorkItem(fx, { kind: 'task', title: `Item ${i}` });
      made.push(item.identifier);
      // Descending stamps: Item 0 is newest.
      await touch(item.id, `2026-08-1${i}T00:00:00.000Z`);
    }

    const first = await homeService.listMyWork(hctx(fx), { limit: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    // Newest first: Item 6 (2026-08-16) down to Item 4.
    expect(first.items.map((r) => r.title)).toEqual(['Item 6', 'Item 5', 'Item 4']);

    const second = await homeService.listMyWork(hctx(fx), { limit: 3, cursor: first.nextCursor });
    const third = await homeService.listMyWork(hctx(fx), { limit: 3, cursor: second.nextCursor });

    const seen = [...first.items, ...second.items, ...third.items].map((r) => r.identifier);
    expect(new Set(seen).size).toBe(seen.length); // no repeat across pages
    expect(seen.sort()).toEqual(made.sort()); // no drop across pages
    expect(third.nextCursor).toBeNull(); // the last page mints no cursor
  });

  it('mints no cursor when the last page is exactly full', async () => {
    const fx = await makeFixture({ identifier: 'EXA' });
    for (let i = 0; i < 2; i += 1) {
      await createWorkItem(fx, { kind: 'task', title: `Item ${i}` });
    }
    const page = await homeService.listMyWork(hctx(fx), { limit: 2 });
    expect(page.items).toHaveLength(2);
    // The has-more PROBE row is what makes this exact — a "the page came back
    // full, so mint a cursor" rule would hand out a cursor to an empty page.
    expect(page.nextCursor).toBeNull();
  });
});

describe('watcherRepository.listByUser / homeService.listWatching', () => {
  it('returns what the reader watches, and an owned-AND-watched item is in BOTH tabs', async () => {
    const fx = await makeFixture({ identifier: 'WAT' });
    const other = await enrolMember(fx, 'author');

    const watchedOnly = await createWorkItem(fx, { kind: 'task', title: 'Watched, not mine' });
    const ownedAndWatched = await createWorkItem(fx, { kind: 'task', title: 'Mine and watched' });
    const ownedOnly = await createWorkItem(fx, { kind: 'task', title: 'Mine, not watched' });
    await own(watchedOnly.id, { assignee: other.id, reporter: other.id });

    await adminDb.$transaction(async (tx) => {
      await watcherRepository.add(watchedOnly.id, fx.ownerId, tx);
      await watcherRepository.add(ownedAndWatched.id, fx.ownerId, tx);
    });

    const watching = await homeService.listWatching(hctx(fx));
    const myWork = await homeService.listMyWork(hctx(fx));

    expect(keys(watching.items)).toEqual(['WAT-1', 'WAT-2']);
    expect(keys(myWork.items)).toEqual(['WAT-2', 'WAT-3']);
    // The overlap is deliberate: two different questions, not a partition.
    expect(watching.items.map((r) => r.id)).toContain(ownedAndWatched.id);
    expect(myWork.items.map((r) => r.id)).toContain(ownedAndWatched.id);
    expect(myWork.items.map((r) => r.id)).not.toContain(watchedOnly.id);
    expect(ownedOnly.id).toBeTruthy();
  });

  it('resolves the reader s relation on a watched row too', async () => {
    const fx = await makeFixture({ identifier: 'WREL' });
    const other = await enrolMember(fx, 'wrel');
    const item = await createWorkItem(fx, { kind: 'task', title: 'Watched only' });
    await own(item.id, { assignee: other.id, reporter: other.id });
    await adminDb.$transaction((tx) => watcherRepository.add(item.id, fx.ownerId, tx));

    const page = await homeService.listWatching(hctx(fx));

    expect(page.items[0]).toMatchObject({ viewerIsAssignee: false, viewerIsReporter: false });
  });

  it('never returns a watched item from a project the reader may not browse', async () => {
    const fx = await makeFixture({ identifier: 'WSEC' });
    const secret = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Secret',
      identifier: 'WSEK',
    });
    await adminDb.project.update({ where: { id: secret.id }, data: { accessLevel: 'private' } });
    const hidden = await createWorkItem(
      { ...fx, project: secret, projectId: secret.id, projectIdentifier: secret.identifier },
      { kind: 'task', title: 'Hidden but watched' },
    );

    const member = await enrolMember(fx, 'watcher');
    await adminDb.$transaction((tx) => watcherRepository.add(hidden.id, member.id, tx));

    // Pointed AT the private project — the only arrangement in which the
    // browsable filter is what excludes the row, rather than the project axis.
    const page = await homeService.listWatching({
      userId: member.id,
      workspaceId: fx.workspaceId,
      projectId: secret.id,
    });

    // THE CONTROL: the watch row exists, so only the access filter is keeping it out.
    expect(await adminDb.watcher.count({ where: { userId: member.id } })).toBe(1);
    expect(page.items).toEqual([]);
  });

  it('returns nothing for a reader with no browsable projects, without querying', async () => {
    const fx = await makeFixture({ identifier: 'WSTR' });
    const item = await createWorkItem(fx, { kind: 'task', title: 'Watched by a stranger' });
    const stranger = await createTestUser({ email: `wstr-${Date.now()}@example.com` });
    await adminDb.$transaction((tx) => watcherRepository.add(item.id, stranger.id, tx));

    // The watch row EXISTS — only the empty browsable set keeps it out, and the
    // read short-circuits before issuing a degenerate `IN ()` rather than
    // asking the database a question with no possible answer.
    expect(await adminDb.watcher.count({ where: { userId: stranger.id } })).toBe(1);
    expect(
      await homeService.listWatching({
        userId: stranger.id,
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
      }),
    ).toEqual({ items: [], nextCursor: null });
  });

  it('pages the watching read by the same keyset', async () => {
    const fx = await makeFixture({ identifier: 'WPAG' });
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const item = await createWorkItem(fx, { kind: 'task', title: `W${i}` });
      made.push(item.identifier);
      await touch(item.id, `2026-08-1${i}T00:00:00.000Z`);
      await adminDb.$transaction((tx) => watcherRepository.add(item.id, fx.ownerId, tx));
    }

    const first = await homeService.listWatching(hctx(fx), { limit: 2 });
    const second = await homeService.listWatching(hctx(fx), { limit: 2, cursor: first.nextCursor });
    const third = await homeService.listWatching(hctx(fx), { limit: 2, cursor: second.nextCursor });

    const seen = [...first.items, ...second.items, ...third.items].map((r) => r.identifier);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.sort()).toEqual(made.sort());
    expect(third.nextCursor).toBeNull();
  });
});

describe('the Home page cursor', () => {
  it('round-trips a keyset', () => {
    const cursor = { updatedAt: new Date('2026-08-11T10:20:30.000Z'), id: 'wi_abc' };
    const decoded = decodeHomeCursor(encodeHomeCursor(cursor));
    expect(decoded?.id).toBe('wi_abc');
    expect(decoded?.updatedAt.toISOString()).toBe('2026-08-11T10:20:30.000Z');
  });

  it('degrades an unusable token to page one rather than throwing', () => {
    // Each of these can only arrive from a hand-edited URL or a stale bookmark.
    expect(decodeHomeCursor(null)).toBeNull();
    expect(decodeHomeCursor('')).toBeNull();
    expect(decodeHomeCursor('not-base64-!!')).toBeNull();
    expect(decodeHomeCursor(Buffer.from('no-separator').toString('base64url'))).toBeNull();
    expect(decodeHomeCursor(Buffer.from('|wi_1').toString('base64url'))).toBeNull();
    expect(decodeHomeCursor(Buffer.from('2026-08-11T00:00:00Z|').toString('base64url'))).toBeNull();
    expect(decodeHomeCursor(Buffer.from('not-a-date|wi_1').toString('base64url'))).toBeNull();
  });

  it('serves page one when the caller hands back a broken cursor', async () => {
    const fx = await makeFixture({ identifier: 'BAD' });
    await createWorkItem(fx, { kind: 'task', title: 'Only item' });

    const page = await homeService.listMyWork(hctx(fx), { cursor: 'garbage' });

    expect(page.items).toHaveLength(1);
  });
});

describe('homeService.tabCounts — the tab badges', () => {
  it('counts each SET, not the current page, and applies the same access rule', async () => {
    const fx = await makeFixture({ identifier: 'CNT' });
    const secret = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Secret',
      identifier: 'CNS',
    });
    await adminDb.project.update({ where: { id: secret.id }, data: { accessLevel: 'private' } });

    for (let i = 0; i < 4; i += 1) {
      await createWorkItem(fx, { kind: 'task', title: `Mine ${i}` });
    }
    const hidden = await createWorkItem(
      { ...fx, project: secret, projectId: secret.id, projectIdentifier: secret.identifier },
      { kind: 'task', title: 'Hidden' },
    );
    const watched = await createWorkItem(fx, { kind: 'task', title: 'Watched' });
    await adminDb.$transaction(async (tx) => {
      await watcherRepository.add(watched.id, fx.ownerId, tx);
      await watcherRepository.add(hidden.id, fx.ownerId, tx);
    });

    const member = await enrolMember(fx, 'counts');
    await own(hidden.id, { assignee: member.id, reporter: member.id });

    // The badges count the ACTIVE PROJECT's sets (MOTIR-2761): 5 owned there
    // (4 + the watched one they reported) and 1 watched — the private project's
    // item and its watch are on the other side of the project axis, so the
    // owner's watching count drops from the workspace-wide 2 to 1.
    expect(await homeService.tabCounts(hctx(fx))).toEqual({ myWork: 5, watching: 1 });

    // …and the owner IS a workspace manager, so they may browse the private
    // project: pointed at it, they see its one row. This is the positive control
    // that keeps the line above from passing on the access rule by accident.
    expect(await homeService.tabCounts(hctx(fx, secret.id))).toEqual({ myWork: 0, watching: 1 });

    // The plain member owns only the hidden one, which they cannot browse — so
    // both counts are 0 with that project active, and the number beside the tab
    // agrees with what the tab will actually show.
    const memberCtx = { userId: member.id, workspaceId: fx.workspaceId, projectId: secret.id };
    expect(await homeService.tabCounts(memberCtx)).toEqual({ myWork: 0, watching: 0 });
    expect((await homeService.listMyWork(memberCtx)).items).toEqual([]);
  });

  it('counts the whole set even when a page shows less of it', async () => {
    const fx = await makeFixture({ identifier: 'CNP' });
    for (let i = 0; i < 6; i += 1) {
      await createWorkItem(fx, { kind: 'task', title: `Item ${i}` });
    }

    // The badge is the SIZE OF THE SET — a reader deciding whether to switch
    // tabs is not asking how big the current page is.
    expect((await homeService.listMyWork(hctx(fx), { limit: 2 })).items).toHaveLength(2);
    expect((await homeService.tabCounts(hctx(fx))).myWork).toBe(6);
  });

  it('is zero for a reader with no browsable projects, without issuing a degenerate query', async () => {
    const fx = await makeFixture({ identifier: 'CNZ' });
    const stranger = await createTestUser({ email: `cnz-${Date.now()}@example.com` });
    expect(
      await homeService.tabCounts({
        userId: stranger.id,
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
      }),
    ).toEqual({ myWork: 0, watching: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The lifecycle axis (MOTIR-2758). Home's two reads carried a PERSON predicate
// and a PROJECT predicate and no third one, so the surface whose own subtitle
// says "waiting on you" listed finished work — 87% of it for the reader who uses
// the product most, and the newest rows by construction, since the last thing to
// touch an item is usually its merge.
//
// Every case below carries a POSITIVE CONTROL — an open row that must still
// appear — so none of these assertions can pass by the fixture being empty.

/** Put a row in a status directly; the reads under test don't care how it got there. */
async function setStatus(id: string, status: string): Promise<void> {
  await adminDb.workItem.update({ where: { id }, data: { status } });
}

describe('Home excludes the done CATEGORY (MOTIR-2758)', () => {
  it('drops an item the reader both assigned and reported once it is done — list AND badge', async () => {
    const fx = await makeFixture({ identifier: 'DON' });
    const open = await createWorkItem(fx, { kind: 'task', title: 'Still waiting on me' });
    const finished = await createWorkItem(fx, { kind: 'task', title: 'Shipped last week' });
    await own(open.id, { assignee: fx.ownerId, reporter: fx.ownerId });
    await own(finished.id, { assignee: fx.ownerId, reporter: fx.ownerId });
    await setStatus(finished.id, 'done');

    expect(keys((await homeService.listMyWork(hctx(fx))).items)).toEqual(['DON-1']);
    // The badge moves with the list, in the same commit — a count that disagrees
    // with its tab is the shape this card was filed about.
    expect((await homeService.tabCounts(hctx(fx))).myWork).toBe(1);
  });

  it('excludes by CATEGORY, not by the literal key `done` — a cancelled item is out too', async () => {
    const fx = await makeFixture({ identifier: 'CAN' });
    const open = await createWorkItem(fx, { kind: 'task', title: 'Open' });
    const done = await createWorkItem(fx, { kind: 'task', title: 'Done' });
    const cancelled = await createWorkItem(fx, { kind: 'task', title: 'Cancelled' });
    await setStatus(done.id, 'done');
    await setStatus(cancelled.id, 'cancelled');

    // `cancelled` is `category: 'done'` in the default workflow, so a filter
    // written against the KEY would let this one through. CAN-1 is the positive
    // control — the open row, which must survive.
    expect(open.identifier).toBe('CAN-1');
    expect(keys((await homeService.listMyWork(hctx(fx))).items)).toEqual(['CAN-1']);
    expect((await homeService.tabCounts(hctx(fx))).myWork).toBe(1);
  });

  it('drops a finished item from WATCHING too, and from its badge', async () => {
    const fx = await makeFixture({ identifier: 'WDN' });
    const other = await enrolMember(fx, 'wdn');
    const open = await createWorkItem(fx, { kind: 'task', title: 'Watched, still open' });
    const finished = await createWorkItem(fx, { kind: 'task', title: 'Watched, shipped' });
    // Owned by someone else, so ONLY the watch relation can put them in the tab.
    await own(open.id, { assignee: other.id, reporter: other.id });
    await own(finished.id, { assignee: other.id, reporter: other.id });
    await setStatus(finished.id, 'done');
    await adminDb.$transaction(async (tx) => {
      await watcherRepository.add(open.id, fx.ownerId, tx);
      await watcherRepository.add(finished.id, fx.ownerId, tx);
    });

    // An item you watch that has shipped is not waiting on you either, and its
    // notification already fired through the bell.
    expect(keys((await homeService.listWatching(hctx(fx))).items)).toEqual(['WDN-1']);
    expect((await homeService.tabCounts(hctx(fx))).watching).toBe(1);
  });

  it('resolves the exclusion from THE ACTIVE project s OWN workflow — the axis survives the narrowing', async () => {
    const fx = await makeFixture({ identifier: 'PRA' });
    const other = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Second',
      identifier: 'PRB',
    });
    const fxB = { ...fx, project: other, projectId: other.id, projectIdentifier: other.identifier };

    // The SAME status key, terminal in one project and open in the other —
    // statuses are project-defined open vocabulary, so "what counts as finished"
    // is a per-project answer even when only one project is read at a time.
    for (const [projectId, category] of [
      [fx.projectId, 'done'],
      [other.id, 'in_progress'],
    ] as const) {
      await workflowsService.createStatus({
        userId: fx.ownerId,
        workspaceId: fx.workspaceId,
        projectId,
        key: 'released',
        label: 'Released',
        category,
      });
    }

    const terminalInA = await createWorkItem(fx, { kind: 'task', title: 'Released in A' });
    const openInA = await createWorkItem(fx, { kind: 'task', title: 'Open in A' });
    const openInB = await createWorkItem(fxB, { kind: 'task', title: 'Released in B, still open' });
    await setStatus(terminalInA.id, 'released');
    await setStatus(openInB.id, 'released');

    // ⚠️ THE LIFECYCLE AXIS MUST SURVIVE THE PROJECT NARROWING (MOTIR-2761 AC5).
    // The single `HomeProjectScope` still carries ITS project's done keys, so
    // `released` excludes in A and admits in B — read from the SAME status key,
    // which is what makes this evidence rather than a restatement. Narrowing to
    // a bare `projectId` would drop the exclusion silently and pass nothing here.
    expect(keys((await homeService.listMyWork(hctx(fx))).items)).toEqual(['PRA-2']);
    expect((await homeService.tabCounts(hctx(fx))).myWork).toBe(1);
    expect(openInA.identifier).toBe('PRA-2');

    expect(keys((await homeService.listMyWork(hctx(fx, other.id))).items)).toEqual(['PRB-1']);
    expect((await homeService.tabCounts(hctx(fx, other.id))).myWork).toBe(1);
    expect(openInB.identifier).toBe('PRB-1');
  });

  it('is a query PREDICATE — a full page still returns `limit` rows, and the cursor holds', async () => {
    const fx = await makeFixture({ identifier: 'PRD' });
    const open: string[] = [];
    // Interleaved, so a post-read filter would shorten page one to two rows.
    for (let i = 0; i < 8; i += 1) {
      const item = await createWorkItem(fx, { kind: 'task', title: `Item ${i}` });
      await touch(item.id, `2026-08-0${i + 1}T00:00:00.000Z`);
      if (i % 2 === 0) await setStatus(item.id, i % 4 === 0 ? 'done' : 'cancelled');
      else open.push(item.identifier);
    }

    const first = await homeService.listMyWork(hctx(fx), { limit: 2 });
    const second = await homeService.listMyWork(hctx(fx), { limit: 2, cursor: first.nextCursor });

    expect(first.items).toHaveLength(2); // asked for 2, got 2 — nothing dropped afterwards
    const seen = [...first.items, ...second.items].map((r) => r.identifier);
    expect(new Set(seen).size).toBe(seen.length); // no repeats across the boundary
    expect(seen.sort()).toEqual(open.sort()); // and no drops: exactly the open set
    expect(second.nextCursor).toBeNull();
    expect((await homeService.tabCounts(hctx(fx))).myWork).toBe(4);
  });

  it('lets a reader whose work is ALL finished reach the empty state', async () => {
    const fx = await makeFixture({ identifier: 'EMP' });
    for (let i = 0; i < 3; i += 1) {
      const item = await createWorkItem(fx, { kind: 'task', title: `Closed ${i}` });
      await adminDb.$transaction((tx) => watcherRepository.add(item.id, fx.ownerId, tx));
      await setStatus(item.id, 'done');
    }

    // Before this card the empty state was unreachable for anyone with history:
    // a reader with 2 000 closed items and none open saw a full page of them.
    expect(await homeService.listMyWork(hctx(fx))).toEqual({ items: [], nextCursor: null });
    expect(await homeService.listWatching(hctx(fx))).toEqual({ items: [], nextCursor: null });
    expect(await homeService.tabCounts(hctx(fx))).toEqual({ myWork: 0, watching: 0 });
  });
});
