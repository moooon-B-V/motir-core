import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { commentsService } from '@/lib/services/commentsService';
import { triageService } from '@/lib/services/triageService';
import { usersService } from '@/lib/services/usersService';
import { publicRequestsService } from '@/lib/services/publicRequestsService';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { PublicRequestNotFoundError } from '@/lib/publicRequests/errors';
import { EmptyCommentBodyError } from '@/lib/comments/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// Public-request UPVOTE + COMMENT (Story 6.12 · Subtask 6.12.6) — the two
// remaining public-viewer writes, over the 6.12.3 `PublicRequestVote` model +
// the 6.11.3 triage queue. Real Postgres (the standing rule). The gate is the
// 6.12.3 grants (`canUpvotePublicRequest` / `canCommentPublicRequest`), true for
// ANY signed-in account on a `public` project (cross-org included) — NOT a
// `canEdit` relaxation; a non-public project is 404 (no existence leak).

let counter = 0;
async function makeUser(name: string) {
  counter += 1;
  return usersService.createUser({
    email: `pr-${counter}@ex.com`,
    password: 'hunter2hunter2',
    name,
  });
}

/** A fresh PUBLIC project + a triage request on it. The owner is a member; the
 *  voters/commenters below are fresh cross-org accounts (no membership). */
async function publicRequestFixture(): Promise<{ fx: WorkItemFixture; requestId: string }> {
  const fx = await makeWorkItemFixture();
  await db.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'public' } });
  const item = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'Dark mode please' },
    fx.ctx,
  );
  await db.workItem.update({ where: { id: item.id }, data: { triagedAt: new Date() } });
  return { fx, requestId: item.id };
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('publicRequestsService.toggleUpvote (6.12.6)', () => {
  it('a cross-org account toggles its vote on (count 1) then off (count 0)', async () => {
    const { requestId } = await publicRequestFixture();
    const voter = await makeUser('Voter');

    const on = await publicRequestsService.toggleUpvote(requestId, { userId: voter.id });
    expect(on).toEqual({ voted: true, voteCount: 1 });

    const off = await publicRequestsService.toggleUpvote(requestId, { userId: voter.id });
    expect(off).toEqual({ voted: false, voteCount: 0 });
  });

  it('is one-vote-per-account: a repeated upvote never double-counts; distinct accounts sum', async () => {
    const { requestId } = await publicRequestFixture();
    const a = await makeUser('A');
    const b = await makeUser('B');

    await publicRequestsService.toggleUpvote(requestId, { userId: a.id }); // on → 1
    const second = await publicRequestsService.toggleUpvote(requestId, { userId: b.id }); // on → 2
    expect(second.voteCount).toBe(2);

    // The unique (workItemId, userId) holds — exactly two rows, one per account.
    const rows = await db.publicRequestVote.count({ where: { workItemId: requestId } });
    expect(rows).toBe(2);
  });

  it('404s a non-public project (no existence leak) and a missing request', async () => {
    // A NON-public project: the access service hides it (404-not-403).
    const fx = await makeWorkItemFixture(); // stays `open` (the default)
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Internal item' },
      fx.ctx,
    );
    const outsider = await makeUser('Outsider');
    await expect(
      publicRequestsService.toggleUpvote(item.id, { userId: outsider.id }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    await expect(
      publicRequestsService.toggleUpvote('wi_does_not_exist', { userId: outsider.id }),
    ).rejects.toBeInstanceOf(PublicRequestNotFoundError);
  });
});

describe('publicRequestsService.addComment (6.12.6)', () => {
  it('writes a PUBLIC-visible comment attributed to the cross-org account', async () => {
    const { requestId } = await publicRequestFixture();
    const commenter = await makeUser('Commenter');

    const dto = await publicRequestsService.addComment(
      requestId,
      { bodyMd: 'Would love this too!' },
      { userId: commenter.id },
    );
    expect(dto.workItemId).toBe(requestId);
    expect(dto.author.id).toBe(commenter.id);
    expect(dto.bodyMd).toBe('Would love this too!');

    const row = await db.comment.findUnique({ where: { id: dto.id } });
    expect(row?.isPublic).toBe(true);
  });

  it('keeps the work item INTERNAL discussion private (the 6.12.2 §4 split): a member comment is isPublic=false', async () => {
    const { fx, requestId } = await publicRequestFixture();
    // The owner (a member) comments through the INTERNAL path (5.1.2).
    const internal = await commentsService.addComment(requestId, { bodyMd: 'triage note' }, fx.ctx);
    const row = await db.comment.findUnique({ where: { id: internal.id } });
    expect(row?.isPublic).toBe(false);
  });

  it('rejects a non-public project (404) and an empty body (422)', async () => {
    const fx = await makeWorkItemFixture(); // `open`, not public
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'task', title: 'Internal item' },
      fx.ctx,
    );
    const outsider = await makeUser('Outsider');
    await expect(
      publicRequestsService.addComment(item.id, { bodyMd: 'hi' }, { userId: outsider.id }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);

    const { requestId } = await publicRequestFixture();
    const commenter = await makeUser('Blank');
    await expect(
      publicRequestsService.addComment(requestId, { bodyMd: '   ' }, { userId: commenter.id }),
    ).rejects.toBeInstanceOf(EmptyCommentBodyError);
  });
});

describe('triage queue — vote count is the leading sort key (6.12.6)', () => {
  it('an upvoted request floats above newer-but-unvoted ones; voteCount rides the DTO; a zero-vote queue stays newest-first', async () => {
    const fx = await makeWorkItemFixture();
    await db.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'public' } });

    // Three triage requests, oldest → newest by triagedAt.
    const mk = async (title: string, triagedAt: Date) => {
      const it = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'task', title },
        fx.ctx,
      );
      await db.workItem.update({ where: { id: it.id }, data: { triagedAt } });
      return it.id;
    };
    const a = await mk('oldest', new Date('2026-06-10T00:00:00.000Z'));
    const b = await mk('middle', new Date('2026-06-11T00:00:00.000Z'));
    const c = await mk('newest', new Date('2026-06-12T00:00:00.000Z'));

    // No votes yet → newest-first (the original 6.11.3 order is preserved).
    const before = await triageService.getTriageQueue(fx.projectId, {}, fx.ctx);
    expect(before.items.map((i) => i.id)).toEqual([c, b, a]);
    expect(before.items.every((i) => i.voteCount === 0)).toBe(true);

    // Two cross-org accounts upvote the OLDEST request.
    const u1 = await makeUser('U1');
    const u2 = await makeUser('U2');
    await publicRequestsService.toggleUpvote(a, { userId: u1.id });
    await publicRequestsService.toggleUpvote(a, { userId: u2.id });

    // Demand wins: `a` (2 votes) floats to the top; the rest stay newest-first.
    const after = await triageService.getTriageQueue(fx.projectId, {}, fx.ctx);
    expect(after.items.map((i) => i.id)).toEqual([a, c, b]);
    expect(after.items.find((i) => i.id === a)?.voteCount).toBe(2);
    expect(after.items.find((i) => i.id === c)?.voteCount).toBe(0);
  });
});
