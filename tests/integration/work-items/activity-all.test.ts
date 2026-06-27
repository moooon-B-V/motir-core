import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { activityService, ACTIVITY_PAGE_SIZE } from '@/lib/services/activityService';
import { commentsService } from '@/lib/services/commentsService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workItemRevisionsService } from '@/lib/services/workItemRevisionsService';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { workItemRevisionRepository } from '@/lib/repositories/workItemRevisionRepository';
import { InvalidActivityCursorError } from '@/lib/activity/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ActivityAllEntryDto } from '@/lib/dto/activity';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { inngest } from '@/lib/jobs/client';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { truncateAuthTables } from '../../helpers/db';

// Subtask 5.5.2 — the All merged stream: the 5.1.2 comment threads and the
// 5.5.1 history entries interleaved by a bounded two-source composite-cursor
// merge. Real Postgres, no mocks: comments and revisions are written through
// the SAME services production runs; tests then pin timestamps directly on
// the rows (the legit test reach) so interleavings, exact-timestamp ties, and
// page-boundary clusters are deterministic rather than racing the clock.

async function truncateAll(): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE TABLE "comment", "work_item_link", "work_item", "sprint" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}

beforeEach(async () => {
  await truncateAll();
  // Block the comment-created job publish at the client edge (the one
  // permitted stub besides getSession — the network has no Inngest here).
  vi.spyOn(inngest, 'send').mockResolvedValue({ ids: [] as string[] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

async function createIssue(fx: WorkItemFixture, title = 'The issue') {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

/** Insert a renderable revision through the service edge (a title change). */
async function injectRevision(workItemId: string, changedById: string, n: number): Promise<void> {
  await db.$transaction(async (tx) => {
    await workItemRevisionsService.recordRevision(
      {
        workItemId,
        changedById,
        changeKind: 'updated',
        diff: { title: { from: `t${n}`, to: `t${n + 1}` } },
      },
      tx,
    );
  });
}

/** Bulk-inject suppressed position-noise revisions (no feed entry). */
async function injectNoise(workItemId: string, changedById: string, count: number): Promise<void> {
  await db.$transaction(async (tx) => {
    for (let i = 0; i < count; i++) {
      await workItemRevisionsService.recordRevision(
        {
          workItemId,
          changedById,
          changeKind: 'updated',
          diff: { position: { from: `p${i}`, to: `p${i + 1}` } },
        },
        tx,
      );
    }
  });
}

/** Pin a comment's createdAt (test-only determinism — never racing now()). */
async function setCommentTime(id: string, at: Date): Promise<void> {
  await db.$executeRaw`UPDATE "comment" SET "created_at" = ${at} WHERE "id" = ${id}`;
}

/** Pin a revision's changedAt. */
async function setRevisionTime(id: string, at: Date): Promise<void> {
  await db.$executeRaw`UPDATE "work_item_revision" SET "changedAt" = ${at} WHERE "id" = ${id}`;
}

/** All revision ids of an issue, oldest first (raw read — test reach). */
async function revisionIdsAsc(workItemId: string): Promise<string[]> {
  const rows = await db.workItemRevision.findMany({
    where: { workItemId },
    orderBy: [{ changedAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Walk the All stream to exhaustion, page by page. */
async function walkAll(
  workItemId: string,
  ctx: ServiceContext,
  order: 'asc' | 'desc',
): Promise<ActivityAllEntryDto[]> {
  const out: ActivityAllEntryDto[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 50; guard++) {
    const page = await activityService.listAll(workItemId, { cursor, order }, ctx);
    expect(page.entries.length).toBeLessThanOrEqual(ACTIVITY_PAGE_SIZE);
    out.push(...page.entries);
    if (page.nextCursor === null) return out;
    cursor = page.nextCursor;
  }
  throw new Error('walkAll did not terminate within 50 pages');
}

/** The entry's merge identity: timestamp + type rank + id. */
function keyOf(entry: ActivityAllEntryDto): readonly [string, number, string] {
  return entry.type === 'comment'
    ? [entry.thread.createdAt, 0, entry.thread.id]
    : [entry.entry.changedAt, 1, entry.entry.id];
}

function idOf(entry: ActivityAllEntryDto): string {
  return entry.type === 'comment' ? `c:${entry.thread.id}` : `h:${entry.entry.id}`;
}

const tok = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');

describe('activityService.listAll — gating + cursor validation', () => {
  it('404s an unknown id and a cross-workspace id (finding #44)', async () => {
    const fx = await makeWorkItemFixture();
    const other = await makeWorkItemFixture({ name: 'Globex', identifier: 'GLO' });
    const theirs = await createIssue(other);

    await expect(activityService.listAll('nope', {}, fx.ctx)).rejects.toThrow(
      WorkItemNotFoundError,
    );
    await expect(activityService.listAll(theirs.id, {}, fx.ctx)).rejects.toThrow(
      WorkItemNotFoundError,
    );
  });

  it('rejects every malformed composite-cursor shape with the typed 400 error', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);

    const bad = [
      '%%%not-a-token%%%', // not decodable JSON
      tok('null'), // null payload
      tok('"x"'), // non-object payload
      tok('{}'), // missing both positions
      tok('{"c":null}'), // missing h
      tok('{"c":5,"h":null}'), // non-string c
      tok('{"c":null,"h":5}'), // non-string h
    ];
    for (const cursor of bad) {
      await expect(activityService.listAll(issue.id, { cursor }, fx.ctx)).rejects.toThrow(
        InvalidActivityCursorError,
      );
    }
  });
});

describe('activityService.listAll — interleaving', () => {
  it('interleaves comment threads and history entries in true timestamp order, both orders', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);

    const commentA = await commentsService.addComment(issue.id, { bodyMd: 'first!' }, fx.ctx);
    const replyA = await commentsService.addComment(
      issue.id,
      { bodyMd: 'late reply', parentCommentId: commentA.id },
      fx.ctx,
    );
    await injectRevision(issue.id, fx.ownerId, 1);
    const commentB = await commentsService.addComment(issue.id, { bodyMd: 'second' }, fx.ctx);
    await injectRevision(issue.id, fx.ownerId, 2);

    const [createdRev, titleRev1, titleRev2] = await revisionIdsAsc(issue.id);
    const base = Date.parse('2026-06-01T10:00:00.000Z');
    const t = (s: number) => new Date(base + s * 1000);
    await setRevisionTime(createdRev as string, t(1));
    await setCommentTime(commentA.id, t(2));
    await setRevisionTime(titleRev1 as string, t(3));
    await setCommentTime(commentB.id, t(4));
    await setRevisionTime(titleRev2 as string, t(5));
    // The reply is NEWER than everything — it must still ride its root at t2.
    await setCommentTime(replyA.id, t(6));

    const desc = await activityService.listAll(issue.id, {}, fx.ctx);
    expect(desc.nextCursor).toBeNull();
    expect(desc.totalComments).toBe(3); // replies included (the 5.1.2 count)
    expect(desc.totalChanges).toBe(3); // created + the two title edits
    expect(desc.entries.map(idOf)).toEqual([
      `h:${titleRev2}`,
      `c:${commentB.id}`,
      `h:${titleRev1}`,
      `c:${commentA.id}`,
      `h:${createdRev}`,
    ]);

    // The thread DTO arrives whole: the root carries its reply, and the
    // reply is NOT a separate stream entry (it interleaves at the root).
    const threadA = desc.entries.find((e) => e.type === 'comment' && e.thread.id === commentA.id);
    expect(threadA?.type).toBe('comment');
    if (threadA?.type === 'comment') {
      expect(threadA.thread.replies.map((r) => r.id)).toEqual([replyA.id]);
    }

    const asc = await activityService.listAll(issue.id, { order: 'asc' }, fx.ctx);
    expect(asc.entries.map(idOf)).toEqual(desc.entries.map(idOf).slice().reverse());
  });

  it('breaks exact-timestamp ties deterministically: comment before history ascending, after it descending', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    const comment = await commentsService.addComment(issue.id, { bodyMd: 'tied' }, fx.ctx);
    await injectRevision(issue.id, fx.ownerId, 1);

    const [createdRev, titleRev] = await revisionIdsAsc(issue.id);
    const at = new Date('2026-06-01T12:00:00.000Z');
    await setRevisionTime(createdRev as string, new Date('2026-06-01T11:00:00.000Z'));
    await setCommentTime(comment.id, at);
    await setRevisionTime(titleRev as string, at);

    const asc = await activityService.listAll(issue.id, { order: 'asc' }, fx.ctx);
    expect(asc.entries.map(idOf)).toEqual([`h:${createdRev}`, `c:${comment.id}`, `h:${titleRev}`]);
    const desc = await activityService.listAll(issue.id, {}, fx.ctx);
    expect(desc.entries.map(idOf)).toEqual([`h:${titleRev}`, `c:${comment.id}`, `h:${createdRev}`]);
  });

  it('shows a deleted comment exactly once — as history — and live comments never duplicate into history', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    const keep = await commentsService.addComment(issue.id, { bodyMd: 'stays' }, fx.ctx);
    const doomed = await commentsService.addComment(issue.id, { bodyMd: 'secret' }, fx.ctx);
    await commentsService.deleteComment(doomed.id, fx.ctx);

    const all = await walkAll(issue.id, fx.ctx, 'desc');
    const commentEntries = all.filter((e) => e.type === 'comment');
    expect(commentEntries.map((e) => (e.type === 'comment' ? e.thread.id : ''))).toEqual([keep.id]);

    const deletions = all.filter(
      (e) => e.type === 'history' && e.entry.parts.some((p) => p.kind === 'commentDeleted'),
    );
    expect(deletions).toHaveLength(1);
    // Never the content (the verified rule) — nothing in the stream carries it.
    expect(JSON.stringify(all)).not.toContain('secret');
  });
});

describe('activityService.listAll — the composite-cursor page walk', () => {
  /**
   * The AC's property case: more entries than a page on BOTH sides, with a
   * same-timestamp cluster of mixed types straddling the first page boundary.
   * The full walk must round-trip without loss or duplication, in both
   * orders, and match the two sources walked independently.
   */
  it('round-trips a page-boundary-splitting same-minute cluster without loss or duplication', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);

    const comments: string[] = [];
    for (let i = 0; i < 23; i++) {
      const c = await commentsService.addComment(issue.id, { bodyMd: `comment ${i}` }, fx.ctx);
      comments.push(c.id);
    }
    for (let i = 0; i < 30; i++) await injectRevision(issue.id, fx.ownerId, i);
    const revisions = await revisionIdsAsc(issue.id); // created + 30 = 31

    // Interleave the two sources second-by-second, then collapse positions
    // 16–24 (mixed comment/history) onto ONE shared timestamp so the first
    // descending page boundary (20) lands inside the tie cluster.
    const sequence: Array<{ kind: 'c' | 'h'; id: string }> = [];
    const ci = comments[Symbol.iterator]();
    const hi = revisions[Symbol.iterator]();
    for (let pos = 0; pos < comments.length + revisions.length; pos++) {
      const pick = pos % 2 === 0 ? hi.next() : ci.next();
      if (!pick.done) {
        sequence.push({ kind: pos % 2 === 0 ? 'h' : 'c', id: pick.value });
        continue;
      }
      const rest = pos % 2 === 0 ? ci.next() : hi.next();
      if (!rest.done) sequence.push({ kind: pos % 2 === 0 ? 'c' : 'h', id: rest.value });
    }
    const base = Date.parse('2026-06-02T08:00:00.000Z');
    for (let pos = 0; pos < sequence.length; pos++) {
      const inCluster = pos >= 16 && pos <= 24;
      const at = new Date(base + (inCluster ? 16 : pos) * 1000);
      const { kind, id } = sequence[pos] as { kind: 'c' | 'h'; id: string };
      if (kind === 'c') await setCommentTime(id, at);
      else await setRevisionTime(id, at);
    }

    const desc = await walkAll(issue.id, fx.ctx, 'desc');
    expect(desc).toHaveLength(comments.length + revisions.length); // 54 — no loss
    expect(new Set(desc.map(idOf)).size).toBe(desc.length); // no duplication
    for (let i = 1; i < desc.length; i++) {
      const [pt, pr, pid] = keyOf(desc[i - 1] as ActivityAllEntryDto);
      const [t, r, id] = keyOf(desc[i] as ActivityAllEntryDto);
      const ordered = pt > t || (pt === t && (pr > r || (pr === r && pid > id)));
      expect(ordered, `descending order broken at position ${i}`).toBe(true);
    }

    // Set-equality with the two sources walked independently.
    expect(new Set(desc.map(idOf))).toEqual(
      new Set([...comments.map((id) => `c:${id}`), ...revisions.map((id) => `h:${id}`)]),
    );

    // Ascending is the exact reverse of descending.
    const asc = await walkAll(issue.id, fx.ctx, 'asc');
    expect(asc.map(idOf)).toEqual(desc.map(idOf).slice().reverse());
  });

  it('issues exactly one bounded read per source per page (never fetch-all)', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    for (let i = 0; i < 25; i++) {
      await commentsService.addComment(issue.id, { bodyMd: `c${i}` }, fx.ctx);
    }
    for (let i = 0; i < 25; i++) await injectRevision(issue.id, fx.ownerId, i);

    const commentReads = vi.spyOn(commentRepository, 'listThreadsByWorkItem');
    const revisionReads = vi.spyOn(workItemRevisionRepository, 'listByWorkItem');

    const page = await activityService.listAll(issue.id, {}, fx.ctx);
    expect(page.entries).toHaveLength(ACTIVITY_PAGE_SIZE);
    expect(page.nextCursor).not.toBeNull();

    expect(commentReads).toHaveBeenCalledTimes(1);
    expect(commentReads.mock.calls[0]?.[1]?.take).toBeLessThanOrEqual(21);
    expect(revisionReads).toHaveBeenCalledTimes(1);
    expect(revisionReads.mock.calls[0]?.[1]?.take).toBeLessThanOrEqual(20);
  });

  it('advances through a suppressed-noise stretch with a short page, losing nothing', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    await injectNoise(issue.id, fx.ownerId, 120); // newer than `created`
    await commentsService.addComment(issue.id, { bodyMd: 'newest' }, fx.ctx);

    // Page 1 (desc): the bounded scan consumes 100 pure-noise rows and finds
    // nothing displayable — the history frontier stops the merge BEFORE the
    // newer comment may be emitted, and the page is legitimately short.
    const first = await activityService.listAll(issue.id, {}, fx.ctx);
    expect(first.entries).toHaveLength(0);
    expect(first.nextCursor).not.toBeNull();

    // Page 2 continues past the stretch: comment (newest) then the anchor.
    const second = await activityService.listAll(
      issue.id,
      { cursor: first.nextCursor as string },
      fx.ctx,
    );
    expect(second.entries.map((e) => e.type)).toEqual(['comment', 'history']);
    expect(second.nextCursor).toBeNull();
    expect(second.totalComments).toBe(1);
    expect(second.totalChanges).toBe(1); // noise is not a change
  });
});

describe('activityService.listAll — work-item reference resolution (5.8.6)', () => {
  it('resolves the comment bodies’ motir: tokens so the All view chips render LIVE, not struck-through', async () => {
    const fx = await makeWorkItemFixture();
    const issue = await createIssue(fx);
    const target = await createIssue(fx, 'Referenced target');

    // A comment on the issue references the target via the durable token the
    // editor emits — exactly what the dedicated Comments tab resolves.
    await commentsService.addComment(
      issue.id,
      { bodyMd: `See [${target.identifier}](motir:${target.id}) for context.` },
      fx.ctx,
    );

    const page = await activityService.listAll(issue.id, {}, fx.ctx);

    // The All page carries the resolved summary keyed by the token id — without
    // it the chip falls into the "deleted" (strikethrough) branch (the bug).
    const summary = page.workItemRefs[target.id];
    expect(summary).toBeDefined();
    expect(summary).toMatchObject({ accessible: true, identifier: target.identifier });
  });
});
