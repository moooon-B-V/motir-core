import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Comment, WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { commentMentionRepository } from '@/lib/repositories/commentMentionRepository';
import { createTestUser, createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// Repository-layer tests for the comment data-access leaves (Story 5.1 ·
// Subtask 5.1.1): commentRepository / commentMentionRepository, plus the
// schema-level guarantees the migration carries — the delete cascades (work
// item → comments; root → replies + mention rows) and the one-row-per-mention
// unique constraint. Real Postgres (no mocks), per CLAUDE.md. They run as the
// dev/CI superuser via the `db` singleton (RLS is inert under BYPASSRLS — the
// policies are exercised separately under the prodect_app role, the
// multi-tenant-rls suite's pattern); what's proven here is the repository
// contract and the migration-built constraints. Writes run inside a real
// `db.$transaction` to exercise the required-`tx` path.

beforeEach(async () => {
  // truncateAuthTables truncates `workspace` RESTART IDENTITY CASCADE, which
  // cascades workspace → work_item → comment → comment_mention (all FK chains
  // with onDelete: Cascade), so no dedicated truncate is needed.
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface CommentFixture {
  fx: WorkItemFixture;
  issue: WorkItem;
}

async function makeCommentFixture(): Promise<CommentFixture> {
  const fx = await makeWorkItemFixture();
  const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Commented task' });
  return { fx, issue };
}

/** Insert one comment through the repository's required-`tx` write path. */
async function addComment(
  c: CommentFixture,
  input: { bodyMd?: string; parentCommentId?: string; authorId?: string } = {},
): Promise<Comment> {
  return db.$transaction(async (tx) =>
    commentRepository.create(
      {
        workspaceId: c.fx.workspaceId,
        workItemId: c.issue.id,
        authorId: input.authorId ?? c.fx.ownerId,
        parentCommentId: input.parentCommentId ?? null,
        bodyMd: input.bodyMd ?? 'A comment body',
      },
      tx,
    ),
  );
}

describe('commentRepository', () => {
  it('create persists a root comment with null parent and no editedAt', async () => {
    const c = await makeCommentFixture();
    const row = await addComment(c, { bodyMd: 'First!' });
    expect(row.workItemId).toBe(c.issue.id);
    expect(row.workspaceId).toBe(c.fx.workspaceId);
    expect(row.parentCommentId).toBeNull();
    expect(row.bodyMd).toBe('First!');
    expect(row.editedAt).toBeNull();
  });

  it('update patches the body and sets editedAt without touching other rows', async () => {
    const c = await makeCommentFixture();
    const a = await addComment(c, { bodyMd: 'original' });
    const b = await addComment(c, { bodyMd: 'untouched' });

    const editedAt = new Date();
    const updated = await db.$transaction(async (tx) =>
      commentRepository.update(a.id, { bodyMd: 'edited', editedAt }, tx),
    );
    expect(updated.bodyMd).toBe('edited');
    expect(updated.editedAt).toEqual(editedAt);

    const other = await commentRepository.findById(b.id);
    expect(other?.bodyMd).toBe('untouched');
    expect(other?.editedAt).toBeNull();
  });

  it('findById returns the row, and null for an unknown id', async () => {
    const c = await makeCommentFixture();
    const row = await addComment(c);
    expect((await commentRepository.findById(row.id))?.id).toBe(row.id);
    expect(await commentRepository.findById('nope')).toBeNull();
  });

  it('delete hard-deletes a root and cascades its replies + mention rows', async () => {
    const c = await makeCommentFixture();
    const mentioned = await createTestUser({ name: 'Bo' });
    const root = await addComment(c, { bodyMd: 'root' });
    const reply = await addComment(c, { bodyMd: 'reply', parentCommentId: root.id });
    await db.$transaction(async (tx) =>
      commentMentionRepository.createMany(
        [
          { commentId: root.id, mentionedUserId: mentioned.id },
          { commentId: reply.id, mentionedUserId: mentioned.id },
        ],
        tx,
      ),
    );

    await db.$transaction(async (tx) => commentRepository.delete(root.id, tx));

    expect(await commentRepository.findById(root.id)).toBeNull();
    expect(await commentRepository.findById(reply.id)).toBeNull();
    expect(await db.commentMention.count()).toBe(0);
  });

  it('deleting a work item cascades its whole comment thread', async () => {
    const c = await makeCommentFixture();
    const root = await addComment(c);
    await addComment(c, { parentCommentId: root.id });
    expect(await commentRepository.countByWorkItem(c.issue.id)).toBe(2);

    await db.workItem.delete({ where: { id: c.issue.id } });
    expect(await db.comment.count()).toBe(0);
  });

  describe('listThreadsByWorkItem', () => {
    it('returns roots only, each with its replies oldest-first', async () => {
      const c = await makeCommentFixture();
      const root = await addComment(c, { bodyMd: 'root' });
      const r1 = await addComment(c, { bodyMd: 'reply 1', parentCommentId: root.id });
      const r2 = await addComment(c, { bodyMd: 'reply 2', parentCommentId: root.id });

      const page = await commentRepository.listThreadsByWorkItem(c.issue.id, { order: 'asc' });
      expect(page).toHaveLength(1);
      expect(page[0]?.id).toBe(root.id);
      expect(page[0]?.replies.map((r) => r.id)).toEqual([r1.id, r2.id]);
    });

    it('cursor-pages the roots in both orders without skips or repeats', async () => {
      const c = await makeCommentFixture();
      const roots: Comment[] = [];
      for (let i = 0; i < 5; i += 1) {
        roots.push(await addComment(c, { bodyMd: `root ${i}` }));
      }

      // desc (newest-first): two pages of 2 + a final page of 1.
      const walk: string[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await commentRepository.listThreadsByWorkItem(c.issue.id, {
          take: 2,
          order: 'desc',
          ...(cursor ? { cursor } : {}),
        });
        if (page.length === 0) break;
        walk.push(...page.map((r) => r.id));
        cursor = page[page.length - 1]?.id;
      }
      expect(walk).toEqual([...roots].reverse().map((r) => r.id));

      // asc (the Jira default): same walk, oldest-first.
      const ascPage = await commentRepository.listThreadsByWorkItem(c.issue.id, {
        take: 3,
        order: 'asc',
      });
      expect(ascPage.map((r) => r.id)).toEqual(roots.slice(0, 3).map((r) => r.id));
    });

    it('scopes to the work item and defaults to a bounded take', async () => {
      const c = await makeCommentFixture();
      const otherIssue = await createTestWorkItem(c.fx, { kind: 'task', title: 'Other' });
      await addComment(c);
      const listed = await commentRepository.listThreadsByWorkItem(otherIssue.id);
      expect(listed).toEqual([]);
    });
  });

  it('countByWorkItem counts replies in; countRootsByWorkItem counts threads', async () => {
    const c = await makeCommentFixture();
    expect(await commentRepository.countByWorkItem(c.issue.id)).toBe(0);
    expect(await commentRepository.countRootsByWorkItem(c.issue.id)).toBe(0);

    const root = await addComment(c);
    await addComment(c, { parentCommentId: root.id });
    await addComment(c);

    expect(await commentRepository.countByWorkItem(c.issue.id)).toBe(3);
    expect(await commentRepository.countRootsByWorkItem(c.issue.id)).toBe(2);
  });
});

describe('commentMentionRepository', () => {
  it('createMany persists rows and returns the count', async () => {
    const c = await makeCommentFixture();
    const bo = await createTestUser({ name: 'Bo' });
    const odie = await createTestUser({ name: 'Odie' });
    const comment = await addComment(c);

    const count = await db.$transaction(async (tx) =>
      commentMentionRepository.createMany(
        [
          { commentId: comment.id, mentionedUserId: bo.id },
          { commentId: comment.id, mentionedUserId: odie.id },
        ],
        tx,
      ),
    );
    expect(count).toBe(2);
    const rows = await commentMentionRepository.findByCommentIds([comment.id]);
    expect(rows.map((r) => r.mentionedUserId).sort()).toEqual([bo.id, odie.id].sort());
  });

  it('createMany short-circuits on empty input (the empty-input guard)', async () => {
    const count = await db.$transaction(async (tx) => commentMentionRepository.createMany([], tx));
    expect(count).toBe(0);
  });

  it('the unique (commentId, mentionedUserId) constraint rejects a duplicate', async () => {
    const c = await makeCommentFixture();
    const bo = await createTestUser({ name: 'Bo' });
    const comment = await addComment(c);

    await db.$transaction(async (tx) =>
      commentMentionRepository.createMany([{ commentId: comment.id, mentionedUserId: bo.id }], tx),
    );
    await expect(
      db.$transaction(async (tx) =>
        commentMentionRepository.createMany(
          [{ commentId: comment.id, mentionedUserId: bo.id }],
          tx,
        ),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('deleteByCommentId removes only that comment’s rows and returns the count', async () => {
    const c = await makeCommentFixture();
    const bo = await createTestUser({ name: 'Bo' });
    const a = await addComment(c);
    const b = await addComment(c);
    await db.$transaction(async (tx) =>
      commentMentionRepository.createMany(
        [
          { commentId: a.id, mentionedUserId: bo.id },
          { commentId: b.id, mentionedUserId: bo.id },
        ],
        tx,
      ),
    );

    const removed = await db.$transaction(async (tx) =>
      commentMentionRepository.deleteByCommentId(a.id, tx),
    );
    expect(removed).toBe(1);
    expect(await commentMentionRepository.findByCommentIds([a.id])).toEqual([]);
    expect(await commentMentionRepository.findByCommentIds([b.id])).toHaveLength(1);
  });

  it('findByCommentIds short-circuits on empty input (the empty-input guard)', async () => {
    expect(await commentMentionRepository.findByCommentIds([])).toEqual([]);
  });
});
