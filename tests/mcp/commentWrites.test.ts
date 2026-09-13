import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { User, WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { commentsService } from '@/lib/services/commentsService';
import { commentRepository } from '@/lib/repositories/commentRepository';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { projectRoleDefinitionService } from '@/lib/services/projectRoleDefinitionService';
import { runEditComment } from '@/lib/mcp/tools/editComment';
import { runDeleteComment } from '@/lib/mcp/tools/deleteComment';
import { CLI_TOKEN_GRANT, toolPermission } from '@/lib/mcp/toolPermissions';
import type { WorkItemCommentCreatedData } from '@/lib/jobs/types';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { captureEventPayloads } from '../helpers/jobs';

// MOTIR-5295 — `edit_comment` and `delete_comment`, the author's correction
// doors onto a comment.
//
// EVERY CASE ENTERS AT THE TOOL ADAPTER (`runEditComment` / `runDeleteComment`),
// never at the service: the author-only narrowing and the error mapping are
// what an agent meets, and a service-level call would skip both.
//
// The cases are chosen because the obvious way to write each one passes under a
// broken implementation:
//
//   1. THE MODERATOR IS REFUSED, on a built-in project admin AND on a custom
//      role that carries `comment:moderate` — and each is PROVEN able to
//      moderate through the service first. Without that control a refusal would
//      also pass against a fixture whose role simply could not moderate, and the
//      test would say nothing about `ownOnly`.
//   2. THE ITEM PAGE'S DOOR IS UNCHANGED — the same moderator still edits through
//      the service with no options, so the narrowing is scoped to the MCP.
//   3. A root's delete reports the thread it took, against a root WITH a reply —
//      a `replyCount` of 0 would pass against a hard-coded zero.
//   4. THE PERMISSION is asserted off `add_comment`'s own entry rather than by
//      restating the string, and against the CLI grant — a correction door a
//      CLI token cannot reach while it CAN reach the add is worse than none.

beforeEach(async () => {
  await truncateAuthTables();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

interface Scenario {
  fx: WorkItemFixture;
  issue: WorkItem;
  author: User;
  authorCtx: ServiceContext;
  /** A plain workspace member with no project role. */
  peerCtx: ServiceContext;
  /** A built-in project `admin` — can moderate comments on the item page. */
  projAdminCtx: ServiceContext;
  /** A member holding a CUSTOM role that carries `comment:moderate`. */
  customModCtx: ServiceContext;
  mentionee: User;
}

async function build(): Promise<Scenario> {
  const fx = await makeWorkItemFixture();
  const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Commented task' });

  async function wsMember(email: string, name: string): Promise<User> {
    const user = await usersService.createUser({ email, password: 'hunter2hunter2', name });
    await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
    return user;
  }
  const ctxOf = (u: User): ServiceContext => ({ userId: u.id, workspaceId: fx.workspaceId });

  const author = await wsMember('author@ex.com', 'Agent Owner');
  const peer = await wsMember('peer@ex.com', 'Peer');
  const projAdmin = await wsMember('padmin@ex.com', 'Proj Admin');
  const customMod = await wsMember('custom@ex.com', 'Custom Moderator');
  const mentionee = await wsMember('mentionee@ex.com', 'Mention Target');

  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: projAdmin.id,
    role: 'admin',
  });
  const moderatorRole = await projectRoleDefinitionService.create({
    projectId: fx.projectId,
    ctx: fx.ctx,
    name: 'Comment moderator',
    permissions: ['project:browse', 'comment:add', 'comment:moderate'],
  });
  // A custom role is assigned onto an existing membership — `addMember` takes
  // only a built-in, and `setRole` resolves a role definition id.
  await projectMembersService.addMember({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: customMod.id,
    role: 'member',
  });
  await projectMembersService.setRole({
    key: fx.projectIdentifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: customMod.id,
    role: moderatorRole.id,
  });

  return {
    fx,
    issue,
    author,
    authorCtx: ctxOf(author),
    peerCtx: ctxOf(peer),
    projAdminCtx: ctxOf(projAdmin),
    customModCtx: ctxOf(customMod),
    mentionee,
  };
}

function errorText(res: CallToolResult): string {
  expect(res.isError).toBe(true);
  const first = res.content[0];
  return first && first.type === 'text' ? first.text : '';
}

async function bodyOf(s: Scenario, commentId: string): Promise<string | undefined> {
  const row = await withWorkspaceServiceContext(s.fx.workspaceId, (tx) =>
    commentRepository.findById(commentId, tx),
  );
  return row?.bodyMd;
}

describe('edit_comment', () => {
  it('lets the author replace the body, marks it edited, and returns the comment', async () => {
    const s = await build();
    captureEventPayloads<WorkItemCommentCreatedData>('work-item/comment.created');
    const created = await commentsService.addComment(s.issue.id, { bodyMd: 'v1' }, s.authorCtx);

    const res = await runEditComment({ commentId: created.id, body: 'v2' }, s.authorCtx);

    expect(res.isError).toBeFalsy();
    const payload = res.structuredContent as {
      id: string;
      bodyMd: string;
      editedAt: string | null;
    };
    expect(payload.id).toBe(created.id);
    expect(payload.bodyMd).toBe('v2');
    expect(payload.editedAt).not.toBeNull();
    expect(await bodyOf(s, created.id)).toBe('v2');
  });

  it('treats an identical body as a no-op and notifies only a mention the edit ADDS', async () => {
    const s = await build();
    const { events } = captureEventPayloads<WorkItemCommentCreatedData>(
      'work-item/comment.created',
    );
    const created = await commentsService.addComment(s.issue.id, { bodyMd: 'same' }, s.authorCtx);
    const before = events.length;

    const noop = await runEditComment({ commentId: created.id, body: 'same' }, s.authorCtx);
    expect(noop.isError).toBeFalsy();
    expect((noop.structuredContent as { editedAt: string | null }).editedAt).toBeNull();
    expect(events.length).toBe(before);

    const token = `[@${s.mentionee.name}](mention:${s.mentionee.id})`;
    const res = await runEditComment(
      { commentId: created.id, body: `same, cc ${token}` },
      s.authorCtx,
    );
    expect(res.isError).toBeFalsy();
    expect(events.length).toBe(before + 1);
    expect(events.at(-1)?.mentionedUserIds).toEqual([s.mentionee.id]);
  });

  it('refuses a plain member editing someone else’s comment, leaving it untouched', async () => {
    const s = await build();
    captureEventPayloads<WorkItemCommentCreatedData>('work-item/comment.created');
    const created = await commentsService.addComment(s.issue.id, { bodyMd: 'mine' }, s.authorCtx);

    const res = await runEditComment({ commentId: created.id, body: 'hijack' }, s.peerCtx);

    expect(errorText(res)).toMatch(/^COMMENT_FORBIDDEN:/);
    expect(await bodyOf(s, created.id)).toBe('mine');
  });

  it('refuses a MODERATOR — built-in admin and custom role alike — while the item page’s door still lets them', async () => {
    const s = await build();
    captureEventPayloads<WorkItemCommentCreatedData>('work-item/comment.created');
    const created = await commentsService.addComment(s.issue.id, { bodyMd: 'mine' }, s.authorCtx);

    for (const [label, moderatorCtx] of [
      ['project admin', s.projAdminCtx],
      ['custom moderator role', s.customModCtx],
    ] as const) {
      const res = await runEditComment({ commentId: created.id, body: 'moderated' }, moderatorCtx);
      expect(errorText(res), label).toMatch(/^COMMENT_FORBIDDEN:/);
      expect(await bodyOf(s, created.id), label).toBe('mine');

      // The control: this role CAN moderate, through the unnarrowed service call
      // the item page makes. Without it the refusal above proves nothing.
      const viaPage = await commentsService.editComment(
        created.id,
        { bodyMd: `moderated by ${label}` },
        moderatorCtx,
      );
      expect(viaPage.bodyMd, label).toBe(`moderated by ${label}`);
      await commentsService.editComment(created.id, { bodyMd: 'mine' }, s.authorCtx);
    }
  });

  it('reads an unknown id, and a comment in another workspace, as not-found', async () => {
    const s = await build();
    captureEventPayloads<WorkItemCommentCreatedData>('work-item/comment.created');
    const created = await commentsService.addComment(s.issue.id, { bodyMd: 'v1' }, s.authorCtx);
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });

    expect(
      errorText(await runEditComment({ commentId: 'nosuchcomment', body: 'x' }, s.authorCtx)),
    ).toMatch(/^COMMENT_NOT_FOUND:/);
    expect(
      errorText(await runEditComment({ commentId: created.id, body: 'x' }, other.ctx)),
    ).toMatch(/^COMMENT_NOT_FOUND:/);
    expect(await bodyOf(s, created.id)).toBe('v1');
  });
});

describe('delete_comment', () => {
  it('lets the author delete a root, reporting the replies it took and recording the revision', async () => {
    const s = await build();
    captureEventPayloads<WorkItemCommentCreatedData>('work-item/comment.created');
    const root = await commentsService.addComment(s.issue.id, { bodyMd: 'root' }, s.authorCtx);
    await commentsService.addComment(
      s.issue.id,
      { bodyMd: 'reply', parentCommentId: root.id },
      s.peerCtx,
    );

    const res = await runDeleteComment({ commentId: root.id }, s.authorCtx);

    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({
      commentId: root.id,
      workItemKey: s.issue.identifier,
      parentCommentId: null,
      replyCount: 1,
    });
    expect(
      await withWorkspaceServiceContext(s.fx.workspaceId, (tx) =>
        commentRepository.countByWorkItem(s.issue.id, tx),
      ),
    ).toBe(0);
    const revisions = await adminDb.workItemRevision.findMany({
      where: { workItemId: s.issue.id, changeKind: 'comment_deleted' },
    });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.changedById).toBe(s.author.id);
  });

  it('refuses a plain member and a moderator alike, deleting nothing', async () => {
    const s = await build();
    captureEventPayloads<WorkItemCommentCreatedData>('work-item/comment.created');
    const created = await commentsService.addComment(s.issue.id, { bodyMd: 'keep' }, s.authorCtx);

    for (const ctx of [s.peerCtx, s.projAdminCtx, s.customModCtx]) {
      expect(errorText(await runDeleteComment({ commentId: created.id }, ctx))).toMatch(
        /^COMMENT_FORBIDDEN:/,
      );
    }
    expect(await bodyOf(s, created.id)).toBe('keep');
  });

  it('reads an unknown id as not-found', async () => {
    const s = await build();
    expect(errorText(await runDeleteComment({ commentId: 'nosuch' }, s.authorCtx))).toMatch(
      /^COMMENT_NOT_FOUND:/,
    );
  });
});

describe('the permission both doors are gated on', () => {
  it('is the key add_comment takes, and the CLI token holds it', () => {
    for (const name of ['edit_comment', 'delete_comment'] as const) {
      expect(toolPermission(name)).toBe(toolPermission('add_comment'));
      expect(CLI_TOKEN_GRANT).toContain(toolPermission(name));
    }
  });
});
