import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Comment, Prisma, WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { commentMentionRepository } from '@/lib/repositories/commentMentionRepository';
import { createTestUser, createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Repository-layer tests for the comment data-access leaves (Story 5.1 ·
// Subtask 5.1.1): commentRepository / commentMentionRepository, plus the
// schema-level guarantees the migration carries — the delete cascades (work
// item → comments; root → replies + mention rows) and the one-row-per-mention
// unique constraint. Real Postgres (no mocks), per CLAUDE.md. They run as the
// dev/CI superuser via the `db` singleton (RLS is inert under BYPASSRLS — the
// policies are exercised separately under the motir_app role, the
// multi-tenant-rls suite's pattern); what's proven here is the repository
// contract and the migration-built constraints. Writes run inside a real
// `db.$transaction` to exercise the required-`tx` path.
//
// ⚠️ THIS FILE'S WRITES RUN THROUGH `adminDb` ON PURPOSE (MOTIR-2751).
// The header above states the subject: the repository CONTRACT and the
// migration-built CONSTRAINTS, with RLS deliberately inert. Under the non-bypass
// role a cross-workspace read returns [] because the POLICY hid the row — the same
// observation for a different reason, which would make every gate assertion here
// vacuous, and a constraint test that fails with a policy error proves nothing about
// the constraint. So the admin client is what PRESERVES these claims rather than
// weakening them. The policies' own behaviour is proved separately, under the role,
// in the *-rls suites this header already points at.
//
// ⚠️ AND SO DO THIS FILE'S READS (MOTIR-2881). MOTIR-2751 migrated the WRITES and
// left the assertion-side READS on the `@/lib/db` singleton — which under the role
// is `motir_app`, binds no workspace GUC, and returns NOTHING. A refused write says
// so (`42501`); a refused read just returns `undefined` / `[]`, so nine assertions
// here failed with `expected undefined to be 'untouched'` and the ones asserting
// emptiness passed for the wrong reason. `readAsOwner` routes them through the SAME
// owner client the writes use, which is the only choice consistent with the
// paragraph above: binding a workspace context instead would make the
// cross-workspace and cascade assertions vacuous, which is precisely what the
// adjudication in `tests/rls/testCallSiteScan.ts` records for this file.

beforeEach(async () => {
  // truncateAuthTables truncates `workspace` RESTART IDENTITY CASCADE, which
  // cascades workspace → work_item → comment → comment_mention (all FK chains
  // with onDelete: Cascade), so no dedicated truncate is needed.
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
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

/**
 * Run a repository READ through the OWNER client, exactly as this file's writes
 * run. The repository method under test is still what is exercised — only the
 * connection changes, which is the point: RLS stays inert (see the header) and the
 * assertion observes the ROW rather than the policy.
 */
function readAsOwner<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return adminDb.$transaction(fn);
}

/** Insert one comment through the repository's required-`tx` write path. */
async function addComment(
  c: CommentFixture,
  input: { bodyMd?: string; parentCommentId?: string; authorId?: string } = {},
): Promise<Comment> {
  return adminDb.$transaction(async (tx) =>
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
    const updated = await adminDb.$transaction(async (tx) =>
      commentRepository.update(a.id, { bodyMd: 'edited', editedAt }, tx),
    );
    expect(updated.bodyMd).toBe('edited');
    expect(updated.editedAt).toEqual(editedAt);

    const other = await readAsOwner((tx) => commentRepository.findById(b.id, tx));
    expect(other?.bodyMd).toBe('untouched');
    expect(other?.editedAt).toBeNull();
  });

  it('findById returns the row, and null for an unknown id', async () => {
    const c = await makeCommentFixture();
    const row = await addComment(c);
    expect((await readAsOwner((tx) => commentRepository.findById(row.id, tx)))?.id).toBe(row.id);
    expect(await readAsOwner((tx) => commentRepository.findById('nope', tx))).toBeNull();
  });

  it('delete hard-deletes a root and cascades its replies + mention rows', async () => {
    const c = await makeCommentFixture();
    const mentioned = await createTestUser({ name: 'Bo' });
    const root = await addComment(c, { bodyMd: 'root' });
    const reply = await addComment(c, { bodyMd: 'reply', parentCommentId: root.id });
    await adminDb.$transaction(async (tx) =>
      commentMentionRepository.createMany(
        [
          { commentId: root.id, mentionedUserId: mentioned.id },
          { commentId: reply.id, mentionedUserId: mentioned.id },
        ],
        tx,
      ),
    );

    await adminDb.$transaction(async (tx) => commentRepository.delete(root.id, tx));

    // Owner-side: a `null` here is the CASCADE having removed the row, not a policy
    // hiding it — the distinction the singleton read could not make.
    expect(await readAsOwner((tx) => commentRepository.findById(root.id, tx))).toBeNull();
    expect(await readAsOwner((tx) => commentRepository.findById(reply.id, tx))).toBeNull();
    const commentMentionCount = await adminDb.commentMention.count();
    expect(commentMentionCount).toBe(0);
  });

  it('deleting a work item cascades its whole comment thread', async () => {
    const c = await makeCommentFixture();
    const root = await addComment(c);
    await addComment(c, { parentCommentId: root.id });
    expect(await readAsOwner((tx) => commentRepository.countByWorkItem(c.issue.id, tx))).toBe(2);

    await adminDb.workItem.delete({ where: { id: c.issue.id } });
    const commentCount = await adminDb.comment.count();
    expect(commentCount).toBe(0);
  });

  describe('listThreadsByWorkItem', () => {
    it('returns roots only, each with its replies oldest-first', async () => {
      const c = await makeCommentFixture();
      const root = await addComment(c, { bodyMd: 'root' });
      const r1 = await addComment(c, { bodyMd: 'reply 1', parentCommentId: root.id });
      const r2 = await addComment(c, { bodyMd: 'reply 2', parentCommentId: root.id });

      const page = await readAsOwner((tx) =>
        commentRepository.listThreadsByWorkItem(c.issue.id, { order: 'asc' }, tx),
      );
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
        const page = await readAsOwner((tx) =>
          commentRepository.listThreadsByWorkItem(
            c.issue.id,
            {
              take: 2,
              order: 'desc',
              ...(cursor ? { cursor } : {}),
            },
            tx,
          ),
        );
        if (page.length === 0) break;
        walk.push(...page.map((r) => r.id));
        cursor = page[page.length - 1]?.id;
      }
      expect(walk).toEqual([...roots].reverse().map((r) => r.id));

      // asc (the Jira default): same walk, oldest-first.
      const ascPage = await readAsOwner((tx) =>
        commentRepository.listThreadsByWorkItem(c.issue.id, { take: 3, order: 'asc' }, tx),
      );
      expect(ascPage.map((r) => r.id)).toEqual(roots.slice(0, 3).map((r) => r.id));
    });

    it('scopes to the work item and defaults to a bounded take', async () => {
      const c = await makeCommentFixture();
      const otherIssue = await createTestWorkItem(c.fx, { kind: 'task', title: 'Other' });
      await addComment(c);
      // Owner-side, so the empty page is the work-item SCOPE at work rather than a
      // policy that could not see either issue.
      const listed = await readAsOwner((tx) =>
        commentRepository.listThreadsByWorkItem(otherIssue.id, {}, tx),
      );
      expect(listed).toEqual([]);
    });
  });

  it('countByWorkItem counts replies in; countRootsByWorkItem counts threads', async () => {
    const c = await makeCommentFixture();
    expect(await readAsOwner((tx) => commentRepository.countByWorkItem(c.issue.id, tx))).toBe(0);
    expect(await readAsOwner((tx) => commentRepository.countRootsByWorkItem(c.issue.id, tx))).toBe(
      0,
    );

    const root = await addComment(c);
    await addComment(c, { parentCommentId: root.id });
    await addComment(c);

    expect(await readAsOwner((tx) => commentRepository.countByWorkItem(c.issue.id, tx))).toBe(3);
    expect(await readAsOwner((tx) => commentRepository.countRootsByWorkItem(c.issue.id, tx))).toBe(
      2,
    );
  });

  it('countByParent counts a root’s replies (0 for a childless comment), inside and outside a tx', async () => {
    const c = await makeCommentFixture();
    const root = await addComment(c, { bodyMd: 'root' });
    const lone = await addComment(c, { bodyMd: 'lone' });
    await addComment(c, { bodyMd: 'r1', parentCommentId: root.id });
    await addComment(c, { bodyMd: 'r2', parentCommentId: root.id });

    expect(await readAsOwner((tx) => commentRepository.countByParent(root.id, tx))).toBe(2);
    expect(await readAsOwner((tx) => commentRepository.countByParent(lone.id, tx))).toBe(0);
    expect(
      await adminDb.$transaction(async (tx) => commentRepository.countByParent(root.id, tx)),
    ).toBe(2);
  });
});

describe('commentMentionRepository', () => {
  it('createMany persists rows and returns the count', async () => {
    const c = await makeCommentFixture();
    const bo = await createTestUser({ name: 'Bo' });
    const odie = await createTestUser({ name: 'Odie' });
    const comment = await addComment(c);

    const count = await adminDb.$transaction(async (tx) =>
      commentMentionRepository.createMany(
        [
          { commentId: comment.id, mentionedUserId: bo.id },
          { commentId: comment.id, mentionedUserId: odie.id },
        ],
        tx,
      ),
    );
    expect(count).toBe(2);
    const rows = await readAsOwner((tx) =>
      commentMentionRepository.findByCommentIds([comment.id], tx),
    );
    expect(rows.map((r) => r.mentionedUserId).sort()).toEqual([bo.id, odie.id].sort());
  });

  it('createMany short-circuits on empty input (the empty-input guard)', async () => {
    const count = await adminDb.$transaction(async (tx) =>
      commentMentionRepository.createMany([], tx),
    );
    expect(count).toBe(0);
  });

  it('the unique (commentId, mentionedUserId) constraint rejects a duplicate', async () => {
    const c = await makeCommentFixture();
    const bo = await createTestUser({ name: 'Bo' });
    const comment = await addComment(c);

    await adminDb.$transaction(async (tx) =>
      commentMentionRepository.createMany([{ commentId: comment.id, mentionedUserId: bo.id }], tx),
    );
    await expect(
      adminDb.$transaction(async (tx) =>
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
    await adminDb.$transaction(async (tx) =>
      commentMentionRepository.createMany(
        [
          { commentId: a.id, mentionedUserId: bo.id },
          { commentId: b.id, mentionedUserId: bo.id },
        ],
        tx,
      ),
    );

    const removed = await adminDb.$transaction(async (tx) =>
      commentMentionRepository.deleteByCommentId(a.id, tx),
    );
    expect(removed).toBe(1);
    expect(
      await readAsOwner((tx) => commentMentionRepository.findByCommentIds([a.id], tx)),
    ).toEqual([]);
    expect(
      await readAsOwner((tx) => commentMentionRepository.findByCommentIds([b.id], tx)),
    ).toHaveLength(1);
  });

  it('findByCommentIds short-circuits on empty input (the empty-input guard)', async () => {
    expect(await commentMentionRepository.findByCommentIds([])).toEqual([]);
  });
});
