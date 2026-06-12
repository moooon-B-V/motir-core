import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';
import { db } from '@/lib/db';
import { commentsService } from '@/lib/services/commentsService';
import { mentionNotificationsService } from '@/lib/services/mentionNotificationsService';
import { watcherNotificationsService } from '@/lib/services/watcherNotificationsService';
import { watchersService } from '@/lib/services/watchersService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { captureEmailEvents, captureJobEvents } from '../helpers/jobs';

// The combined collaboration journey — Vitest companion (Story 5.6 · Subtask
// 5.6.2). The E2E (`tests/e2e/collab-journey.spec.ts`) drives the same chain
// through the real UI + Inngest dev server; THIS spec asserts the two places
// E2E assertion is weak — DB state inside the comment-delete transaction, and
// the exact recipient SETS the cross-story dedupe contract promises — at the
// service layer where they are checkable directly.
//
// It deliberately does NOT re-test what an owning story already covers in
// isolation (each seam maps to its owner below); it proves only the SEAMS that
// exist BETWEEN stories, on ONE issue, in one flow:
//
//   * the comment-embed link-on-write (5.2.3) running INSIDE the comment write
//     transaction (5.1.2) — an editor-sourced upload the comment body
//     references links to the issue; deleting the comment unlinks it;
//   * the mention/watcher recipient split (5.4.5) on a single comment that BOTH
//     @mentions a watcher AND has other watchers — the mentioned watcher is
//     mailed by the mention job, NEVER also by the watcher job (one email per
//     person); the author is mailed by neither;
//   * the comment-delete cascade (5.1.2) leaving NO orphan mention rows, NO
//     stranded attachment link, and a `comment_deleted` revision — and no
//     stale notification firing for the vanished comment.
//
// Real Postgres, no DB mocks (CLAUDE.md). The one external seam stubbed is the
// Inngest client's `send()` (the tests/helpers/jobs.ts pattern), so a
// service write's post-commit event doesn't reach a (absent) dev server.

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
});

interface Journey {
  fx: WorkItemFixture;
  issueId: string;
  issueIdentifier: string;
  /** Watching the issue AND @mentioned by the comment — mention email only. */
  bo: User;
  /** Watching the issue, NOT mentioned — watcher email only. */
  odie: User;
}

const mentionToken = (u: User) => `[@${u.name}](mention:${u.id})`;

/**
 * A workspace-scoped blob URL the referenced-URL extractor accepts (the public
 * Vercel-Blob host suffix + the `/attachments/<workspaceId>/` prefix the
 * uploader writes). An UNLINKED editor row carrying this URL is the embed the
 * comment body points at — link-on-write attaches it on the comment write.
 */
function embedBlobUrl(workspaceId: string): string {
  return `https://teststore.public.blob.vercel-storage.com/attachments/${workspaceId}/embed-collab.png`;
}

/** PM owns the issue; Bo + Odie both watch; one UNLINKED editor upload waits. */
async function buildJourney(): Promise<Journey> {
  const fx = await makeWorkItemFixture();
  const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Combined journey issue' });
  await db.workItem.update({ where: { id: issue.id }, data: { status: 'todo' } });

  const bo = await usersService.createUser({
    email: 'collab-bo@example.com',
    password: 'hunter2hunter2',
    name: 'Bo Philips',
  });
  const odie = await usersService.createUser({
    email: 'collab-odie@example.com',
    password: 'hunter2hunter2',
    name: 'Odie Walker',
  });
  for (const u of [bo, odie]) {
    await workspacesService.addMember({ userId: u.id, workspaceId: fx.workspaceId });
    await watchersService.watch(issue.id, { userId: u.id, workspaceId: fx.workspaceId });
  }

  // The waiting editor upload — UNLINKED (workItemId null), referenced by no
  // body yet. The same shape attachmentsService.uploadAttachment writes for a
  // create-modal/editor upload before linkage resolves at body-write time.
  await db.attachment.create({
    data: {
      workspaceId: fx.workspaceId,
      uploaderUserId: fx.ownerId,
      workItemId: null,
      source: 'editor',
      blobUrl: embedBlobUrl(fx.workspaceId),
      mimeType: 'image/png',
      sizeBytes: 128,
      originalFilename: 'embed-collab.png',
    },
  });

  return { fx, issueId: issue.id, issueIdentifier: issue.identifier, bo, odie };
}

/** The comment that ties the whole journey together: embeds the upload AND
 *  @mentions Bo (a watcher). Authored by the PM. */
async function postEmbeddingMentioningComment(j: Journey) {
  const bodyMd =
    `Heads up ${mentionToken(j.bo)} — see the shot ` +
    `![embed](${embedBlobUrl(j.fx.workspaceId)}) and **review**.`;
  return commentsService.addComment(j.issueId, { bodyMd }, j.fx.ctx);
}

describe('the combined comment write — embed link + mention persist in one transaction', () => {
  it('links the referenced editor upload to the issue and records the mention, in the comment write tx', async () => {
    const j = await buildJourney();
    const capture = captureJobEvents(); // stub inngest.send + collect the post-commit event

    const comment = await postEmbeddingMentioningComment(j);

    // Seam 5.2.3 × 5.1.2: the body's referenced upload linked to THIS issue as
    // editor-sourced, inside the comment write tx.
    const attachment = await db.attachment.findFirstOrThrow({
      where: { blobUrl: embedBlobUrl(j.fx.workspaceId) },
    });
    expect(attachment.workItemId).toBe(j.issueId);
    expect(attachment.source).toBe('editor');

    // …and that link landed an `attachments.added` revision (the uniform
    // History trail — Story 5.2's fill of Jira's editor-add changelog gap).
    const linkRevisions = await db.workItemRevision.findMany({
      where: { workItemId: j.issueId, changeKind: 'updated' },
    });
    const addedNames = linkRevisions.flatMap(
      (r) =>
        (r.diff as { attachments?: { added?: { name: string }[] } }).attachments?.added?.map(
          (a) => a.name,
        ) ?? [],
    );
    expect(addedNames).toContain('embed-collab.png');

    // Seam 5.1.2: the mention row persisted for Bo (the viewable mentioned
    // member), and the post-commit event carried exactly that id.
    const mentionRows = await db.commentMention.findMany({ where: { commentId: comment.id } });
    expect(mentionRows.map((m) => m.mentionedUserId)).toEqual([j.bo.id]);
    const created = capture.events.filter((e) => e.name === 'work-item/comment.created');
    expect(created).toHaveLength(1);
    expect((created[0]!.data as { mentionedUserIds: string[] }).mentionedUserIds).toEqual([
      j.bo.id,
    ]);
  });
});

describe('the notification recipient sets — the one-email-per-person dedupe (5.4.5)', () => {
  it('mails Bo via the mention job, Odie via the watcher job, the author via neither', async () => {
    const j = await buildJourney();
    const capture = captureEmailEvents();
    const comment = await postEmbeddingMentioningComment(j);
    capture.events.length = 0; // drop what the write path enqueued

    // The mention job owns the mentioned user's email — author excluded.
    const mention = await mentionNotificationsService.fanOut({
      workspaceId: j.fx.workspaceId,
      workItemId: j.issueId,
      authorId: j.fx.ownerId,
      mentionedUserIds: [j.bo.id],
      source: { kind: 'comment', commentId: comment.id },
    });
    expect(mention.notifiedUserIds).toEqual([j.bo.id]);

    // The watcher job excludes BOTH the actor (PM) AND the mentioned watcher
    // (Bo — the mention job has her) → only Odie. This is the cross-story seam:
    // each story proves its own exclusion; THIS asserts the combined set.
    const watcher = await watcherNotificationsService.fanOut({
      kind: 'comment',
      workspaceId: j.fx.workspaceId,
      workItemId: j.issueId,
      actorId: j.fx.ownerId,
      commentId: comment.id,
      mentionedUserIds: [j.bo.id],
    });
    expect(watcher.notifiedUserIds).toEqual([j.odie.id]);

    // No address received two emails; the author received none.
    const recipients = capture.events.map((e) => (e.data as { to: string }).to);
    expect(recipients).toHaveLength(new Set(recipients).size);
    expect(recipients).toContain(j.bo.email);
    expect(recipients).toContain(j.odie.email);
    expect(recipients).not.toContain(j.fx.owner.email);
  });

  it('a transition mails BOTH watchers and excludes only the actor', async () => {
    const j = await buildJourney();
    const capture = captureEmailEvents();
    // The PM comments first (auto-watch makes them a watcher too); the actor
    // exclusion below is what keeps them un-mailed on their own transition.
    await postEmbeddingMentioningComment(j);
    capture.events.length = 0; // drop the comment write's enqueues

    const transition = await watcherNotificationsService.fanOut({
      kind: 'transition',
      workspaceId: j.fx.workspaceId,
      workItemId: j.issueId,
      actorId: j.fx.ownerId,
      revisionId: 'rev-collab-transition',
      fromStatusKey: 'todo',
      toStatusKey: 'in_progress',
    });

    expect([...transition.notifiedUserIds].sort()).toEqual([j.bo.id, j.odie.id].sort());
    expect(capture.events.map((e) => (e.data as { to: string }).to)).not.toContain(
      j.fx.owner.email,
    );
  });
});

describe('the unwind — deleting the comment leaves no orphan and fires no stale notification', () => {
  it('cascades the thread, unlinks the embed, records comment_deleted, and clears every dependent row', async () => {
    const j = await buildJourney();
    const setup = captureEmailEvents();
    const root = await postEmbeddingMentioningComment(j);
    // A reply so the cascade has something to take (and the deletion trace a
    // non-zero replyCount). Odie replies — the reply auto-mentions the root
    // author (PM), so a second mention row exists to prove the cascade clears.
    await commentsService.addComment(
      j.issueId,
      { bodyMd: `On it ${mentionToken(j.fx.owner)}.`, parentCommentId: root.id },
      { userId: j.odie.id, workspaceId: j.fx.workspaceId },
    );
    setup.events.length = 0;

    // Pre-state: 2 comments (root + reply), 2 mention rows, the embed linked.
    expect(await db.comment.count({ where: { workItemId: j.issueId } })).toBe(2);
    expect(await db.commentMention.count({ where: { comment: { workItemId: j.issueId } } })).toBe(
      2,
    );

    await commentsService.deleteComment(root.id, j.fx.ctx);

    // The thread is gone — root + reply hard-deleted (the Jira semantics).
    expect(await db.comment.count({ where: { workItemId: j.issueId } })).toBe(0);
    // NO orphan mention rows survive the cascade (FK onDelete: Cascade, proven
    // through the service, not assumed).
    expect(await db.commentMention.count({ where: { comment: { workItemId: j.issueId } } })).toBe(
      0,
    );

    // The embed UNLINKED — the row survives (GC removes it later) but no longer
    // belongs to the issue (workItemId null), so the panel census drops it.
    const attachment = await db.attachment.findFirstOrThrow({
      where: { blobUrl: embedBlobUrl(j.fx.workspaceId) },
    });
    expect(attachment.workItemId).toBeNull();
    expect(await db.attachment.count({ where: { workItemId: j.issueId, source: 'editor' } })).toBe(
      0,
    );

    // The surviving History trace: who deleted it + the reply count, never the
    // content (Story 5.5 renders this).
    const deletion = await db.workItemRevision.findMany({
      where: { workItemId: j.issueId, changeKind: 'comment_deleted' },
    });
    expect(deletion).toHaveLength(1);
    expect(deletion[0]!.changedById).toBe(j.fx.ownerId);
    expect(
      (deletion[0]!.diff as { comment: { from: { replyCount: number } } }).comment.from.replyCount,
    ).toBe(1);

    // No stale notification: a fan-out for the now-vanished comment sends
    // nothing (the mention/watcher jobs are vanish-tolerant — 5.4.5).
    const staleMention = await mentionNotificationsService.fanOut({
      workspaceId: j.fx.workspaceId,
      workItemId: j.issueId,
      authorId: j.fx.ownerId,
      mentionedUserIds: [j.bo.id],
      source: { kind: 'comment', commentId: root.id },
    });
    const staleWatcher = await watcherNotificationsService.fanOut({
      kind: 'comment',
      workspaceId: j.fx.workspaceId,
      workItemId: j.issueId,
      actorId: j.fx.ownerId,
      commentId: root.id,
      mentionedUserIds: [j.bo.id],
    });
    expect(staleMention.notifiedUserIds).toEqual([]);
    expect(staleWatcher.notifiedUserIds).toEqual([]);
    expect(setup.events).toHaveLength(0);
  });
});
