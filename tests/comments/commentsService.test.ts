import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User, WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { commentsService, COMMENT_PAGE_SIZE } from '@/lib/services/commentsService';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { commentMentionRepository } from '@/lib/repositories/commentMentionRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { toCommentDto } from '@/lib/mappers/commentMappers';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import {
  CommentForbiddenError,
  CommentNotFoundError,
  EmptyCommentBodyError,
  InvalidParentCommentError,
  ReplyDepthExceededError,
} from '@/lib/comments/errors';
import type { WorkItemCommentCreatedData } from '@/lib/jobs/types';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { truncateAuthTables } from '../helpers/db';

// Service-layer tests for commentsService (Story 5.1 · Subtask 5.1.2). Real
// Postgres, no DB mocks (CLAUDE.md); the one external seam stubbed is the
// Inngest client's `send()` (no dev server / cloud in tests — the
// tests/helpers/jobs.ts pattern), which doubles as the assertion surface for
// the post-commit `work-item/comment.created` events.

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

/** Capture every `work-item/comment.created` publish (and block the network). */
function captureCommentEvents(): WorkItemCommentCreatedData[] {
  const events: WorkItemCommentCreatedData[] = [];
  vi.spyOn(inngest, 'send').mockImplementation((async (payload: unknown) => {
    const list = Array.isArray(payload) ? payload : [payload];
    for (const entry of list) {
      const evt = entry as { name?: string; data?: WorkItemCommentCreatedData };
      if (evt?.name === 'work-item/comment.created' && evt.data) events.push(evt.data);
    }
    return { ids: [] as string[] };
  }) as typeof inngest.send);
  return events;
}

const mentionToken = (u: User) => `[@${u.name}](mention:${u.id})`;

interface CommentsScenario {
  fx: WorkItemFixture;
  issue: WorkItem;
  ownerCtx: ServiceContext;
  /** Plain workspace member — NO project role. */
  member: User;
  memberCtx: ServiceContext;
  /** Workspace member with the read-only project `viewer` role. */
  viewer: User;
  viewerCtx: ServiceContext;
  /** Workspace member with the project `admin` role. */
  projAdmin: User;
  projAdminCtx: ServiceContext;
  /** Plain workspace member used as a mention target. */
  mentionee: User;
}

/**
 * The standard substrate: an OPEN project (makeWorkItemFixture's default)
 * with one issue, plus one actor per comment-relevant role. Tests that need a
 * `limited`/`private` level flip it via projectMembersService.setAccessLevel
 * AFTER this builds (going private auto-enrolls the then-current workspace
 * members as project members — add late actors after the flip to keep them
 * out).
 */
async function buildScenario(): Promise<CommentsScenario> {
  const fx = await makeWorkItemFixture();
  const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Commented task' });
  const ownerCtx = fx.ctx;

  async function wsMember(
    email: string,
    name: string,
  ): Promise<{ user: User; ctx: ServiceContext }> {
    const user = await usersService.createUser({ email, password: 'hunter2hunter2', name });
    await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
    return { user, ctx: { userId: user.id, workspaceId: fx.workspaceId } };
  }

  const { user: member, ctx: memberCtx } = await wsMember('member@ex.com', 'Plain Member');
  const { user: viewer, ctx: viewerCtx } = await wsMember('viewer@ex.com', 'Read Only');
  const { user: projAdmin, ctx: projAdminCtx } = await wsMember('padmin@ex.com', 'Proj Admin');
  const { user: mentionee } = await wsMember('mentionee@ex.com', 'Mention Target');

  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: ownerCtx,
    targetUserId: viewer.id,
    role: 'viewer',
  });
  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: ownerCtx,
    targetUserId: projAdmin.id,
    role: 'admin',
  });

  return {
    fx,
    issue,
    ownerCtx,
    member,
    memberCtx,
    viewer,
    viewerCtx,
    projAdmin,
    projAdminCtx,
    mentionee,
  };
}

describe('commentsService.addComment', () => {
  it('creates a root comment, returns the DTO, and emits the post-commit event', async () => {
    const s = await buildScenario();
    const events = captureCommentEvents();

    const dto = await commentsService.addComment(s.issue.id, { bodyMd: 'First!' }, s.memberCtx);

    expect(dto.workItemId).toBe(s.issue.id);
    expect(dto.parentCommentId).toBeNull();
    expect(dto.bodyMd).toBe('First!');
    expect(dto.editedAt).toBeNull();
    expect(dto.mentionedUserIds).toEqual([]);
    expect(dto.author).toEqual({ id: s.member.id, name: s.member.name, image: null });

    const row = await commentRepository.findById(dto.id);
    expect(row?.workspaceId).toBe(s.fx.workspaceId);
    expect(row?.authorId).toBe(s.member.id);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      workspaceId: s.fx.workspaceId,
      workItemId: s.issue.id,
      commentId: dto.id,
      authorId: s.member.id,
      mentionedUserIds: [],
    });
  });

  it('persists deduped, member-validated mentions and carries them on the event', async () => {
    const s = await buildScenario();
    const events = captureCommentEvents();

    const body =
      `Ping ${mentionToken(s.mentionee)} and again ${mentionToken(s.mentionee)} ` +
      `plus ${mentionToken(s.fx.owner)} and a ghost [@Ghost](mention:nosuchuser123)`;
    const dto = await commentsService.addComment(s.issue.id, { bodyMd: body }, s.memberCtx);

    expect(dto.mentionedUserIds).toEqual([s.mentionee.id, s.fx.ownerId]);
    const rows = await commentMentionRepository.findByCommentIds([dto.id]);
    expect(rows.map((r) => r.mentionedUserId).sort()).toEqual(
      [s.mentionee.id, s.fx.ownerId].sort(),
    );
    expect(events[0]?.mentionedUserIds).toEqual([s.mentionee.id, s.fx.ownerId]);
  });

  it('rejects the read-only project viewer with CommentForbiddenError (nothing written, no event)', async () => {
    const s = await buildScenario();
    const events = captureCommentEvents();

    await expect(
      commentsService.addComment(s.issue.id, { bodyMd: 'nope' }, s.viewerCtx),
    ).rejects.toBeInstanceOf(CommentForbiddenError);

    expect(await commentRepository.countByWorkItem(s.issue.id)).toBe(0);
    expect(events).toHaveLength(0);
  });

  it('allows a plain workspace member to comment on a LIMITED project (view + comment, no edit)', async () => {
    const s = await buildScenario();
    captureCommentEvents();
    await projectMembersService.setAccessLevel({
      key: s.fx.projectIdentifier,
      actorUserId: s.fx.ownerId,
      ctx: s.ownerCtx,
      level: 'limited',
    });

    const dto = await commentsService.addComment(s.issue.id, { bodyMd: 'limited ok' }, s.memberCtx);
    expect(dto.bodyMd).toBe('limited ok');
  });

  it('hides a PRIVATE project from a non-member (404) and scopes mentions to project members', async () => {
    const s = await buildScenario();
    captureCommentEvents();
    // Flip private: the then-current members (owner, member, viewer, projAdmin,
    // mentionee) are auto-enrolled. The late joiner stays out.
    await projectMembersService.setAccessLevel({
      key: s.fx.projectIdentifier,
      actorUserId: s.fx.ownerId,
      ctx: s.ownerCtx,
      level: 'private',
    });
    const outsider = await usersService.createUser({
      email: 'late@ex.com',
      password: 'hunter2hunter2',
      name: 'Late Joiner',
    });
    await workspacesService.addMember({ userId: outsider.id, workspaceId: s.fx.workspaceId });
    const outsiderCtx = { userId: outsider.id, workspaceId: s.fx.workspaceId };

    await expect(
      commentsService.addComment(s.issue.id, { bodyMd: 'hi' }, outsiderCtx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);

    // A mention of the non-project workspace member silently drops; the
    // project member sticks (the Jira rule — no view permission, no mention).
    const body = `cc [@Late](mention:${outsider.id}) and ${mentionToken(s.mentionee)}`;
    const dto = await commentsService.addComment(s.issue.id, { bodyMd: body }, s.projAdminCtx);
    expect(dto.mentionedUserIds).toEqual([s.mentionee.id]);
  });

  it('reads a cross-workspace or unknown work item as WorkItemNotFoundError', async () => {
    const s = await buildScenario();
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    const foreignIssue = await createTestWorkItem(other, { kind: 'task', title: 'Foreign' });

    await expect(
      commentsService.addComment(foreignIssue.id, { bodyMd: 'x' }, s.memberCtx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    await expect(
      commentsService.addComment('nosuchitem', { bodyMd: 'x' }, s.memberCtx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('rejects an empty / whitespace-only body', async () => {
    const s = await buildScenario();
    await expect(
      commentsService.addComment(s.issue.id, { bodyMd: '   \n ' }, s.memberCtx),
    ).rejects.toBeInstanceOf(EmptyCommentBodyError);
  });
});

describe('commentsService.addComment — single-level threading', () => {
  it('attaches a reply to a root', async () => {
    const s = await buildScenario();
    captureCommentEvents();
    const root = await commentsService.addComment(s.issue.id, { bodyMd: 'root' }, s.memberCtx);
    const reply = await commentsService.addComment(
      s.issue.id,
      { bodyMd: 'reply', parentCommentId: root.id },
      s.ownerCtx,
    );
    expect(reply.parentCommentId).toBe(root.id);
  });

  it('rejects a reply to a reply (depth > 1)', async () => {
    const s = await buildScenario();
    captureCommentEvents();
    const root = await commentsService.addComment(s.issue.id, { bodyMd: 'root' }, s.memberCtx);
    const reply = await commentsService.addComment(
      s.issue.id,
      { bodyMd: 'reply', parentCommentId: root.id },
      s.memberCtx,
    );
    await expect(
      commentsService.addComment(
        s.issue.id,
        { bodyMd: 'deeper', parentCommentId: reply.id },
        s.memberCtx,
      ),
    ).rejects.toBeInstanceOf(ReplyDepthExceededError);
  });

  it('rejects a parent on a DIFFERENT issue, and an unknown parent as not-found', async () => {
    const s = await buildScenario();
    captureCommentEvents();
    const otherIssue = await createTestWorkItem(s.fx, { kind: 'task', title: 'Other task' });
    const root = await commentsService.addComment(s.issue.id, { bodyMd: 'root' }, s.memberCtx);

    await expect(
      commentsService.addComment(
        otherIssue.id,
        { bodyMd: 'cross', parentCommentId: root.id },
        s.memberCtx,
      ),
    ).rejects.toBeInstanceOf(InvalidParentCommentError);
    await expect(
      commentsService.addComment(
        s.issue.id,
        { bodyMd: 'orphan', parentCommentId: 'nosuchcomment' },
        s.memberCtx,
      ),
    ).rejects.toBeInstanceOf(CommentNotFoundError);
  });
});

describe('commentsService.editComment', () => {
  it('lets the author edit their own comment, setting editedAt (no event without new mentions)', async () => {
    const s = await buildScenario();
    const events = captureCommentEvents();
    const created = await commentsService.addComment(s.issue.id, { bodyMd: 'v1' }, s.memberCtx);

    const edited = await commentsService.editComment(created.id, { bodyMd: 'v2' }, s.memberCtx);

    expect(edited.bodyMd).toBe('v2');
    expect(edited.editedAt).not.toBeNull();
    expect(events).toHaveLength(1); // only the add fired
  });

  it('diffs mentions on edit: rewrites rows and notifies ONLY newly-added ids', async () => {
    const s = await buildScenario();
    const events = captureCommentEvents();
    const created = await commentsService.addComment(
      s.issue.id,
      { bodyMd: `hello ${mentionToken(s.mentionee)}` },
      s.memberCtx,
    );
    expect(events[0]?.mentionedUserIds).toEqual([s.mentionee.id]);

    // Drop the mentionee, add the owner: rows become {owner}; the follow-up
    // event carries ONLY the new id.
    const edited = await commentsService.editComment(
      created.id,
      { bodyMd: `hello ${mentionToken(s.fx.owner)}` },
      s.memberCtx,
    );

    expect(edited.mentionedUserIds).toEqual([s.fx.ownerId]);
    const rows = await commentMentionRepository.findByCommentIds([created.id]);
    expect(rows.map((r) => r.mentionedUserId)).toEqual([s.fx.ownerId]);
    expect(events).toHaveLength(2);
    expect(events[1]?.mentionedUserIds).toEqual([s.fx.ownerId]);
    expect(events[1]?.authorId).toBe(s.member.id);
  });

  it('treats an identical body as a no-op: no editedAt, no event, mentions untouched', async () => {
    const s = await buildScenario();
    const events = captureCommentEvents();
    const created = await commentsService.addComment(
      s.issue.id,
      { bodyMd: `same ${mentionToken(s.mentionee)}` },
      s.memberCtx,
    );

    const result = await commentsService.editComment(
      created.id,
      { bodyMd: `same ${mentionToken(s.mentionee)}` },
      s.memberCtx,
    );

    expect(result.editedAt).toBeNull();
    expect(result.mentionedUserIds).toEqual([s.mentionee.id]);
    expect(events).toHaveLength(1);
  });

  it('enforces the edit matrix: non-author member 403; project admin + workspace owner pass', async () => {
    const s = await buildScenario();
    captureCommentEvents();
    const created = await commentsService.addComment(s.issue.id, { bodyMd: 'mine' }, s.memberCtx);

    await expect(
      commentsService.editComment(created.id, { bodyMd: 'hijack' }, s.viewerCtx),
    ).rejects.toBeInstanceOf(CommentForbiddenError);

    const byAdmin = await commentsService.editComment(
      created.id,
      { bodyMd: 'moderated' },
      s.projAdminCtx,
    );
    expect(byAdmin.bodyMd).toBe('moderated');

    const byOwner = await commentsService.editComment(
      created.id,
      { bodyMd: 'owner pass' },
      s.ownerCtx,
    );
    expect(byOwner.bodyMd).toBe('owner pass');
  });

  it('rejects empty bodies and unknown / cross-workspace comment ids', async () => {
    const s = await buildScenario();
    captureCommentEvents();
    const created = await commentsService.addComment(s.issue.id, { bodyMd: 'v1' }, s.memberCtx);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });

    await expect(
      commentsService.editComment(created.id, { bodyMd: ' ' }, s.memberCtx),
    ).rejects.toBeInstanceOf(EmptyCommentBodyError);
    await expect(
      commentsService.editComment('nosuchcomment', { bodyMd: 'x' }, s.memberCtx),
    ).rejects.toBeInstanceOf(CommentNotFoundError);
    await expect(
      commentsService.editComment(created.id, { bodyMd: 'x' }, other.ctx),
    ).rejects.toBeInstanceOf(CommentNotFoundError);
  });
});

describe('commentsService.deleteComment', () => {
  it('hard-deletes a root with its thread and writes the comment_deleted revision trace', async () => {
    const s = await buildScenario();
    captureCommentEvents();
    const root = await commentsService.addComment(
      s.issue.id,
      { bodyMd: `root ${mentionToken(s.mentionee)}` },
      s.memberCtx,
    );
    await commentsService.addComment(
      s.issue.id,
      { bodyMd: 'r1', parentCommentId: root.id },
      s.ownerCtx,
    );
    await commentsService.addComment(
      s.issue.id,
      { bodyMd: 'r2', parentCommentId: root.id },
      s.projAdminCtx,
    );

    // Moderation path: the project admin deletes another author's thread.
    await commentsService.deleteComment(root.id, s.projAdminCtx);

    expect(await commentRepository.countByWorkItem(s.issue.id)).toBe(0);
    expect(await commentMentionRepository.findByCommentIds([root.id])).toEqual([]);

    const revisions = await db.workItemRevision.findMany({
      where: { workItemId: s.issue.id, changeKind: 'comment_deleted' },
    });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.changedById).toBe(s.projAdmin.id);
    expect(revisions[0]?.diff).toEqual({
      comment: {
        from: { commentId: root.id, authorId: s.member.id, replyCount: 2 },
        to: null,
      },
    });
  });

  it('records replyCount 0 when the author deletes their own reply', async () => {
    const s = await buildScenario();
    captureCommentEvents();
    const root = await commentsService.addComment(s.issue.id, { bodyMd: 'root' }, s.ownerCtx);
    const reply = await commentsService.addComment(
      s.issue.id,
      { bodyMd: 'reply', parentCommentId: root.id },
      s.memberCtx,
    );

    await commentsService.deleteComment(reply.id, s.memberCtx);

    expect(await commentRepository.countByWorkItem(s.issue.id)).toBe(1);
    const revisions = await db.workItemRevision.findMany({
      where: { workItemId: s.issue.id, changeKind: 'comment_deleted' },
    });
    expect(revisions[0]?.diff).toEqual({
      comment: {
        from: { commentId: reply.id, authorId: s.member.id, replyCount: 0 },
        to: null,
      },
    });
  });

  it('rejects a non-author without the moderation tier, and unknown ids as not-found', async () => {
    const s = await buildScenario();
    captureCommentEvents();
    const created = await commentsService.addComment(s.issue.id, { bodyMd: 'keep' }, s.ownerCtx);

    await expect(commentsService.deleteComment(created.id, s.memberCtx)).rejects.toBeInstanceOf(
      CommentForbiddenError,
    );
    await expect(commentsService.deleteComment('nosuch', s.memberCtx)).rejects.toBeInstanceOf(
      CommentNotFoundError,
    );
    expect(await commentRepository.countByWorkItem(s.issue.id)).toBe(1);
  });
});

describe('commentsService.listComments', () => {
  it('pages roots by the cursor (take 20), counts every comment, and threads ride whole', async () => {
    const s = await buildScenario();
    captureCommentEvents();

    let firstRootId = '';
    for (let i = 0; i < COMMENT_PAGE_SIZE + 5; i++) {
      const root = await commentsService.addComment(
        s.issue.id,
        { bodyMd: `root ${i}` },
        s.memberCtx,
      );
      if (i === 0) firstRootId = root.id;
    }
    await commentsService.addComment(
      s.issue.id,
      { bodyMd: `re ${mentionToken(s.mentionee)}`, parentCommentId: firstRootId },
      s.ownerCtx,
    );
    await commentsService.addComment(
      s.issue.id,
      { bodyMd: 're 2', parentCommentId: firstRootId },
      s.memberCtx,
    );

    const page1 = await commentsService.listComments(s.issue.id, {}, s.memberCtx);
    expect(page1.order).toBe('asc'); // the Jira default sort
    expect(page1.threads).toHaveLength(COMMENT_PAGE_SIZE);
    expect(page1.totalCount).toBe(COMMENT_PAGE_SIZE + 5 + 2);
    expect(page1.nextCursor).toBe(page1.threads[COMMENT_PAGE_SIZE - 1]?.id);
    expect(page1.threads[0]?.bodyMd).toBe('root 0');

    // The first root carries its whole thread, replies oldest-first, with
    // author + mention metadata resolved.
    const thread = page1.threads[0];
    expect(thread?.replies.map((r) => r.bodyMd)).toEqual([
      `re ${mentionToken(s.mentionee)}`,
      're 2',
    ]);
    expect(thread?.replies[0]?.author.name).toBe(s.fx.owner.name);
    expect(thread?.replies[0]?.mentionedUserIds).toEqual([s.mentionee.id]);

    const page2 = await commentsService.listComments(
      s.issue.id,
      { cursor: page1.nextCursor ?? undefined },
      s.memberCtx,
    );
    expect(page2.threads).toHaveLength(5);
    expect(page2.nextCursor).toBeNull();
  });

  it('flips the walk direction with order=desc', async () => {
    const s = await buildScenario();
    captureCommentEvents();
    await commentsService.addComment(s.issue.id, { bodyMd: 'older' }, s.memberCtx);
    await commentsService.addComment(s.issue.id, { bodyMd: 'newer' }, s.memberCtx);

    const page = await commentsService.listComments(s.issue.id, { order: 'desc' }, s.memberCtx);
    expect(page.order).toBe('desc');
    expect(page.threads.map((t) => t.bodyMd)).toEqual(['newer', 'older']);
  });

  it('returns an empty window for an uncommented issue', async () => {
    const s = await buildScenario();
    const page = await commentsService.listComments(s.issue.id, {}, s.memberCtx);
    expect(page.threads).toEqual([]);
    expect(page.totalCount).toBe(0);
    expect(page.nextCursor).toBeNull();
  });

  it('lets the read-only viewer list, but hides hidden / cross-workspace issues', async () => {
    const s = await buildScenario();
    captureCommentEvents();
    await commentsService.addComment(s.issue.id, { bodyMd: 'visible' }, s.memberCtx);

    const asViewer = await commentsService.listComments(s.issue.id, {}, s.viewerCtx);
    expect(asViewer.threads).toHaveLength(1);

    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    await expect(commentsService.listComments(s.issue.id, {}, other.ctx)).rejects.toBeInstanceOf(
      WorkItemNotFoundError,
    );
  });
});

describe('commentMappers', () => {
  it('fails loudly when the author is missing from the batched read', async () => {
    const s = await buildScenario();
    captureCommentEvents();
    const dto = await commentsService.addComment(s.issue.id, { bodyMd: 'x' }, s.memberCtx);
    const row = await commentRepository.findById(dto.id);

    expect(() => toCommentDto(row!, new Map(), new Map())).toThrow(/missing from the batched/);
  });
});
