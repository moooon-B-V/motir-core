import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from '../../helpers/adminDb';
import { homeService } from '@/lib/services/homeService';
import { watcherRepository } from '@/lib/repositories/watcherRepository';
import { workspacesService } from '@/lib/services/workspacesService';
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

    const page = await homeService.listMyWork(fx.ctx);

    expect(keys(page.items)).toEqual(['HOM-1', 'HOM-2', 'HOM-3']);
    expect(page.items.map((r) => r.identifier)).not.toContain(neither.identifier);
  });

  it('DEDUPES: an item the reader both owns and filed comes back exactly once, carrying both facts', async () => {
    const fx = await makeFixture({ identifier: 'DED' });
    const both = await createWorkItem(fx, { kind: 'task', title: 'Assigned AND reported' });
    await own(both.id, { assignee: fx.ownerId, reporter: fx.ownerId });

    const page = await homeService.listMyWork(fx.ctx);

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

    const page = await homeService.listMyWork(fx.ctx);
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

  it('spans EVERY project in the workspace from one call, with no projectId, and identifies each row s project', async () => {
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

    const page = await homeService.listMyWork(fx.ctx);

    expect(keys(page.items)).toEqual(['PRJA-1', 'PRJB-1']);
    const byId = new Map(page.items.map((r) => [r.id, r]));
    expect(byId.get(here.id)?.project).toMatchObject({ identifier: 'PRJA', name: 'Motir' });
    expect(byId.get(there.id)?.project).toMatchObject({ identifier: 'PRJB', name: 'Atlas' });
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

    const ctx = { userId: member.id, workspaceId: fx.workspaceId };
    const page = await homeService.listMyWork(ctx);

    expect(keys(page.items)).toEqual(['OPEN-1']);
    // The reader IS the assignee of the hidden item — the only thing keeping it
    // out is the browsable-set filter. If that filter is deleted this fails.
    expect(page.items.map((r) => r.id)).not.toContain(hidden.id);

    // ⚠️ And the filter is a QUERY INPUT, not a post-read drop: asking for one
    // row returns a FULL page of one, with a cursor, rather than a short page.
    const first = await homeService.listMyWork(ctx, { limit: 1 });
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

    const page = await homeService.listMyWork(fx.ctx);

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

    const page = await homeService.listMyWork(fx.ctx);

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

    const page = await homeService.listMyWork(fx.ctx);
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
    expect((await homeService.listMyWork(fx.ctx, { limit: 0 })).items).toHaveLength(3);
    expect((await homeService.listMyWork(fx.ctx, { limit: -5 })).items).toHaveLength(3);
    expect((await homeService.listMyWork(fx.ctx, { limit: Number.NaN })).items).toHaveLength(3);
    expect((await homeService.listMyWork(fx.ctx, { limit: 10_000 })).items).toHaveLength(3);
    expect((await homeService.listMyWork(fx.ctx, { limit: 2 })).items).toHaveLength(2);
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

    const first = await homeService.listMyWork(fx.ctx, { limit: 3 });
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).not.toBeNull();
    // Newest first: Item 6 (2026-08-16) down to Item 4.
    expect(first.items.map((r) => r.title)).toEqual(['Item 6', 'Item 5', 'Item 4']);

    const second = await homeService.listMyWork(fx.ctx, { limit: 3, cursor: first.nextCursor });
    const third = await homeService.listMyWork(fx.ctx, { limit: 3, cursor: second.nextCursor });

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
    const page = await homeService.listMyWork(fx.ctx, { limit: 2 });
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

    await db.$transaction(async (tx) => {
      await watcherRepository.add(watchedOnly.id, fx.ownerId, tx);
      await watcherRepository.add(ownedAndWatched.id, fx.ownerId, tx);
    });

    const watching = await homeService.listWatching(fx.ctx);
    const myWork = await homeService.listMyWork(fx.ctx);

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
    await db.$transaction((tx) => watcherRepository.add(item.id, fx.ownerId, tx));

    const page = await homeService.listWatching(fx.ctx);

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
    await db.$transaction((tx) => watcherRepository.add(hidden.id, member.id, tx));

    const page = await homeService.listWatching({ userId: member.id, workspaceId: fx.workspaceId });

    expect(page.items).toEqual([]);
  });

  it('pages the watching read by the same keyset', async () => {
    const fx = await makeFixture({ identifier: 'WPAG' });
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const item = await createWorkItem(fx, { kind: 'task', title: `W${i}` });
      made.push(item.identifier);
      await touch(item.id, `2026-08-1${i}T00:00:00.000Z`);
      await db.$transaction((tx) => watcherRepository.add(item.id, fx.ownerId, tx));
    }

    const first = await homeService.listWatching(fx.ctx, { limit: 2 });
    const second = await homeService.listWatching(fx.ctx, { limit: 2, cursor: first.nextCursor });
    const third = await homeService.listWatching(fx.ctx, { limit: 2, cursor: second.nextCursor });

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

    const page = await homeService.listMyWork(fx.ctx, { cursor: 'garbage' });

    expect(page.items).toHaveLength(1);
  });
});
