import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';
import { InngestTestEngine } from '@inngest/test';
import { db } from '@/lib/db';
import {
  watcherNotifyOnCommentCreated,
  watcherNotifyOnTransitioned,
} from '@/lib/jobs/definitions/watcherNotify';
import { EMAIL_SEND_IDEMPOTENCY } from '@/lib/jobs/definitions/emailSend';
import { jobFunctions } from '@/lib/jobs/registry';
import { watcherNotificationsService } from '@/lib/services/watcherNotificationsService';
import { watcherCommentNotificationEmail } from '@/lib/emailTemplates/watcherCommentNotification';
import { watcherTransitionNotificationEmail } from '@/lib/emailTemplates/watcherTransitionNotification';
import { watchersService } from '@/lib/services/watchersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { boardsService } from '@/lib/services/boardsService';
import { workflowsService } from '@/lib/services/workflowsService';
import { commentsService } from '@/lib/services/commentsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { watcherRepository } from '@/lib/repositories/watcherRepository';
import { IllegalTransitionError } from '@/lib/workItems/errors';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import type { WorkItemCommentCreatedData, WorkItemTransitionedData } from '@/lib/jobs/types';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { captureEmailEvents, captureJobEvents } from '../helpers/jobs';

// Watcher → email fan-out (Story 5.4 · Subtask 5.4.5). Real Postgres, no DB
// mocks; the one external seam stubbed is the Inngest client's `send()` (the
// tests/helpers/jobs.ts pattern), which doubles as the assertion surface for
// both the enqueued `email.send` events AND the new `work-item/transitioned`
// emit. Covers:
//   1. the fan-out service's send-time rules (actor excluded, mention-dedupe
//      on comments, view re-validation per watcher, vanish-tolerant, paged
//      roster walk, idempotency keys per source × user);
//   2. the `work-item/transitioned` emit seam — post-commit from BOTH
//      `updateStatus` and the board move, nothing on no-op / rollback;
//   3. the two registered jobs driving the fan-out in-process via
//      @inngest/test (job_run bookkeeping included);
//   4. the two template contracts (pure render, unredacted link, locale arms).

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

interface Scenario {
  fx: WorkItemFixture;
  issueId: string;
  issueIdentifier: string;
  /** Plain workspace member, watching the issue. */
  watcher: User;
  watcherCtx: ServiceContext;
}

async function addWsMember(fx: WorkItemFixture, email: string, name: string) {
  const user = await usersService.createUser({ email, password: 'hunter2hunter2', name });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  const ctx: ServiceContext = { userId: user.id, workspaceId: fx.workspaceId };
  return { user, ctx };
}

/** Open project + one issue + one watching member (the owner does NOT watch). */
async function buildScenario(): Promise<Scenario> {
  const fx = await makeWorkItemFixture();
  const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Watched task' });
  // The repo fixture leaves the DB-default status ('open', outside the default
  // workflow); the transition tests need the workflow's initial 'todo'.
  await db.workItem.update({ where: { id: issue.id }, data: { status: 'todo' } });
  const { user: watcher, ctx: watcherCtx } = await addWsMember(
    fx,
    'watcher@example.com',
    'Wanda Watcher',
  );
  await watchersService.watch(issue.id, watcherCtx);
  return { fx, issueId: issue.id, issueIdentifier: issue.identifier, watcher, watcherCtx };
}

const transitionedEvents = (events: { name: string; data: unknown }[]) =>
  events
    .filter((e) => e.name === 'work-item/transitioned')
    .map((e) => e.data as WorkItemTransitionedData);

describe('watcherNotificationsService.fanOut — comment events', () => {
  it('mails every watcher except the actor, with the source-scoped idempotency key', async () => {
    const s = await buildScenario();
    const capture = captureEmailEvents();
    // The actor watches too (the realistic shape — commenting auto-watches);
    // the exclusion below is what keeps them un-mailed.
    const comment = await commentsService.addComment(
      s.issueId,
      { bodyMd: 'A **note**.' },
      s.fx.ctx,
    );
    capture.events.length = 0; // drop what the write path enqueued

    const result = await watcherNotificationsService.fanOut({
      kind: 'comment',
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      actorId: s.fx.ownerId,
      commentId: comment.id,
      mentionedUserIds: [],
    });

    expect(result.notifiedUserIds).toEqual([s.watcher.id]);
    expect(capture.events).toHaveLength(1);
    const evt = capture.events[0]!.data;
    expect(evt.to).toBe('watcher@example.com');
    expect(evt.workspaceId).toBe(s.fx.workspaceId);
    expect(evt.idempotencyKey).toBe(`watcher-comment:${comment.id}:${s.watcher.id}`);
    expect(evt.template).toBe('watcher-comment-notification');
    if (evt.template !== 'watcher-comment-notification') throw new Error('unreachable');
    expect(evt.data.recipientName).toBe('Wanda Watcher');
    expect(evt.data.workItemIdentifier).toBe(s.issueIdentifier);
    expect(evt.data.workItemTitle).toBe('Watched task');
    expect(evt.data.excerpt).toBe('A note.');
    expect(evt.data.issueUrl).toBe(`${resolveBaseUrlTrimmed()}/issues/${s.issueIdentifier}`);
  });

  it('skips the mentioned users — they get the mention email instead (one email per person)', async () => {
    const s = await buildScenario();
    const { user: second, ctx: secondCtx } = await addWsMember(
      s.fx,
      'second@example.com',
      'Second Watcher',
    );
    await watchersService.watch(s.issueId, secondCtx);
    const capture = captureEmailEvents();
    const comment = await commentsService.addComment(s.issueId, { bodyMd: 'Hi.' }, s.fx.ctx);
    capture.events.length = 0;

    const result = await watcherNotificationsService.fanOut({
      kind: 'comment',
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      actorId: s.fx.ownerId,
      commentId: comment.id,
      // Wanda was @mentioned — the 5.1.6 mention job owns her email.
      mentionedUserIds: [s.watcher.id],
    });

    expect(result.notifiedUserIds).toEqual([second.id]);
    expect(capture.events).toHaveLength(1);
    expect(capture.events[0]!.data.to).toBe('second@example.com');
  });

  it('re-validates view access at send time: a watcher who lost access is skipped', async () => {
    const s = await buildScenario();
    const capture = captureEmailEvents();
    const comment = await commentsService.addComment(s.issueId, { bodyMd: 'Hi.' }, s.fx.ctx);

    // Going private auto-enrolls the then-current workspace members; a user
    // added AFTER the flip is a workspace member with no project membership.
    // Their watcher row is inserted directly — exactly "was watching, lost
    // view access between write and send".
    await projectMembersService.setAccessLevel({
      key: s.fx.projectIdentifier,
      actorUserId: s.fx.ownerId,
      ctx: s.fx.ctx,
      level: 'private',
    });
    const { user: late } = await addWsMember(s.fx, 'late@example.com', 'Late Member');
    await db.$transaction((tx) => watcherRepository.add(s.issueId, late.id, tx));
    capture.events.length = 0;

    const result = await watcherNotificationsService.fanOut({
      kind: 'comment',
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      actorId: s.fx.ownerId,
      commentId: comment.id,
      mentionedUserIds: [],
    });

    // The auto-enrolled watcher still sees the private project; the late one
    // does not — only the former is mailed.
    expect(result.notifiedUserIds).toEqual([s.watcher.id]);
    expect(capture.events).toHaveLength(1);
    expect(capture.events[0]!.data.to).toBe('watcher@example.com');
  });

  it('resolves to zero sends when the comment / issue vanished or the workspace mismatches', async () => {
    const s = await buildScenario();
    const capture = captureEmailEvents();
    const comment = await commentsService.addComment(s.issueId, { bodyMd: 'Gone.' }, s.fx.ctx);
    await commentsService.deleteComment(comment.id, s.fx.ctx);
    capture.events.length = 0;

    const deletedComment = await watcherNotificationsService.fanOut({
      kind: 'comment',
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      actorId: s.fx.ownerId,
      commentId: comment.id,
      mentionedUserIds: [],
    });
    expect(deletedComment.notifiedUserIds).toEqual([]);

    const missingItem = await watcherNotificationsService.fanOut({
      kind: 'comment',
      workspaceId: s.fx.workspaceId,
      workItemId: 'no-such-item',
      actorId: s.fx.ownerId,
      commentId: comment.id,
      mentionedUserIds: [],
    });
    expect(missingItem.notifiedUserIds).toEqual([]);

    const crossWorkspace = await watcherNotificationsService.fanOut({
      kind: 'transition',
      workspaceId: 'some-other-workspace',
      workItemId: s.issueId,
      actorId: s.fx.ownerId,
      revisionId: 'rev-x',
      fromStatusKey: 'todo',
      toStatusKey: 'in_progress',
    });
    expect(crossWorkspace.notifiedUserIds).toEqual([]);
    expect(capture.events).toHaveLength(0);
  });

  it('walks the watcher roster in pages — every watcher mailed exactly once across pages', async () => {
    const s = await buildScenario();
    // 4 more watchers (5 total) walked with pageSize 2 → 3 pages.
    for (let i = 0; i < 4; i++) {
      const { ctx } = await addWsMember(s.fx, `pager${i}@example.com`, `Pager ${i}`);
      await watchersService.watch(s.issueId, ctx);
    }
    const capture = captureEmailEvents();
    const comment = await commentsService.addComment(s.issueId, { bodyMd: 'Page me.' }, s.fx.ctx);
    capture.events.length = 0;

    const result = await watcherNotificationsService.fanOut(
      {
        kind: 'comment',
        workspaceId: s.fx.workspaceId,
        workItemId: s.issueId,
        actorId: s.fx.ownerId,
        commentId: comment.id,
        mentionedUserIds: [],
      },
      { pageSize: 2 },
    );

    expect(result.notifiedUserIds).toHaveLength(5);
    expect(new Set(result.notifiedUserIds).size).toBe(5);
    expect(capture.events).toHaveLength(5);
  });
});

describe('watcherNotificationsService.fanOut — transition events', () => {
  it('mails watchers with the resolved status label and the revision-scoped idempotency key', async () => {
    const s = await buildScenario();
    const capture = captureEmailEvents();

    const result = await watcherNotificationsService.fanOut({
      kind: 'transition',
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      actorId: s.fx.ownerId,
      revisionId: 'rev-42',
      fromStatusKey: 'todo',
      toStatusKey: 'in_progress',
    });

    expect(result.notifiedUserIds).toEqual([s.watcher.id]);
    expect(capture.events).toHaveLength(1);
    const evt = capture.events[0]!.data;
    expect(evt.idempotencyKey).toBe(`watcher-transition:rev-42:${s.watcher.id}`);
    expect(evt.template).toBe('watcher-transition-notification');
    if (evt.template !== 'watcher-transition-notification') throw new Error('unreachable');
    // The DEFAULT workflow's display label for `in_progress`.
    const status = await workflowsService.getStatusByKey(
      s.fx.projectId,
      'in_progress',
      s.fx.workspaceId,
    );
    expect(evt.data.statusName).toBe(status!.label);
    expect(evt.data.actorName).toBe(s.fx.owner.name);
  });

  it('falls back to the status key when the status no longer exists at send time', async () => {
    const s = await buildScenario();
    const capture = captureEmailEvents();

    await watcherNotificationsService.fanOut({
      kind: 'transition',
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      actorId: s.fx.ownerId,
      revisionId: 'rev-43',
      fromStatusKey: 'todo',
      toStatusKey: 'vanished_status',
    });

    expect(capture.events).toHaveLength(1);
    const evt = capture.events[0]!.data;
    if (evt.template !== 'watcher-transition-notification') throw new Error('unreachable');
    expect(evt.data.statusName).toBe('vanished_status');
  });
});

describe('work-item/transitioned emit seam', () => {
  it('updateStatus emits post-commit with actor, keys, and the written revision id', async () => {
    const s = await buildScenario();
    const capture = captureJobEvents();

    await workItemsService.updateStatus(s.issueId, 'in_progress', s.fx.ctx);

    const emitted = transitionedEvents(capture.events);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      actorId: s.fx.ownerId,
      fromStatusKey: 'todo',
      toStatusKey: 'in_progress',
    });
    // The revisionId is the revision row the transition wrote.
    const revision = await db.workItemRevision.findFirst({
      where: { workItemId: s.issueId },
      orderBy: { changedAt: 'desc' },
    });
    expect(emitted[0]!.revisionId).toBe(revision!.id);
    capture.restore();
  });

  it('emits nothing on a no-op move, and nothing when the transition rolls back', async () => {
    const s = await buildScenario();
    const capture = captureJobEvents();

    await workItemsService.updateStatus(s.issueId, 'todo', s.fx.ctx); // no-op
    await expect(
      workItemsService.updateStatus(s.issueId, 'done', s.fx.ctx), // illegal under the default restricted workflow
    ).rejects.toThrow(IllegalTransitionError);

    expect(transitionedEvents(capture.events)).toHaveLength(0);
    capture.restore();
  });

  it('the board cross-column move emits the same event; a within-column re-rank does not', async () => {
    const s = await buildScenario();
    // A minimal per-status board (the move-card fixture shape, one column per
    // default status).
    const statuses = await workflowsService.listStatusesByProject(s.fx.projectId, s.fx.workspaceId);
    const board = await db.board.create({
      data: {
        workspaceId: s.fx.workspaceId,
        projectId: s.fx.projectId,
        name: 'Board',
        type: 'kanban',
        position: 'a0',
      },
    });
    const columns: Record<string, string> = {};
    let pos = 0;
    for (const st of statuses) {
      const col = await db.boardColumn.create({
        data: {
          workspaceId: s.fx.workspaceId,
          projectId: s.fx.projectId,
          boardId: board.id,
          name: st.label,
          position: `c${(pos++).toString(36)}`,
        },
      });
      columns[st.key] = col.id;
      await db.boardColumnStatus.create({
        data: {
          workspaceId: s.fx.workspaceId,
          projectId: s.fx.projectId,
          boardId: board.id,
          columnId: col.id,
          statusId: st.id,
        },
      });
    }
    const capture = captureJobEvents();

    // Cross-column: todo → in_progress. One transitioned event.
    await boardsService.moveCard(
      board.id,
      s.issueId,
      { toColumnId: columns['in_progress']! },
      s.fx.ctx,
    );
    let emitted = transitionedEvents(capture.events);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      actorId: s.fx.ownerId,
      fromStatusKey: 'todo',
      toStatusKey: 'in_progress',
    });

    // Within-column re-rank: no transition attempted, no event.
    capture.events.length = 0;
    await boardsService.moveCard(
      board.id,
      s.issueId,
      { toColumnId: columns['in_progress']! },
      s.fx.ctx,
    );
    emitted = transitionedEvents(capture.events);
    expect(emitted).toHaveLength(0);
    capture.restore();
  });
});

describe('watcherNotify jobs — in-process runs', () => {
  it('registers both consumers in the job registry', () => {
    expect(jobFunctions).toContain(watcherNotifyOnCommentCreated);
    expect(jobFunctions).toContain(watcherNotifyOnTransitioned);
  });

  it('drives the comment event end-to-end: watcher mailed, mentioned user skipped, run recorded', async () => {
    const s = await buildScenario();
    const { user: mentioned, ctx: mentionedCtx } = await addWsMember(
      s.fx,
      'tagged@example.com',
      'Tagged',
    );
    await watchersService.watch(s.issueId, mentionedCtx);
    const capture = captureEmailEvents();
    const comment = await commentsService.addComment(
      s.issueId,
      { bodyMd: 'Hello both.' },
      s.fx.ctx,
    );
    capture.events.length = 0;

    const data: WorkItemCommentCreatedData = {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      commentId: comment.id,
      authorId: s.fx.ownerId,
      mentionedUserIds: [mentioned.id],
    };
    const engine = new InngestTestEngine({
      function: watcherNotifyOnCommentCreated,
      events: [{ name: 'work-item/comment.created', data }],
    });
    const { result } = await engine.execute();

    expect(result).toEqual({ notifiedUserIds: [s.watcher.id] });
    expect(capture.events).toHaveLength(1);
    expect(capture.events[0]!.data.idempotencyKey).toBe(
      `watcher-comment:${comment.id}:${s.watcher.id}`,
    );

    const runs = await db.jobRun.findMany({
      where: { functionId: 'watcher-notify/comment.created' },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.workspaceId).toBe(s.fx.workspaceId);
  });

  it('drives the transitioned event end-to-end: watcher mailed, run recorded', async () => {
    const s = await buildScenario();
    const capture = captureEmailEvents();

    const data: WorkItemTransitionedData = {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      actorId: s.fx.ownerId,
      fromStatusKey: 'todo',
      toStatusKey: 'in_progress',
      revisionId: 'rev-e2e',
    };
    const engine = new InngestTestEngine({
      function: watcherNotifyOnTransitioned,
      events: [{ name: 'work-item/transitioned', data }],
    });
    const { result } = await engine.execute();

    expect(result).toEqual({ notifiedUserIds: [s.watcher.id] });
    expect(capture.events).toHaveLength(1);
    expect(capture.events[0]!.data.idempotencyKey).toBe(
      `watcher-transition:rev-e2e:${s.watcher.id}`,
    );

    const runs = await db.jobRun.findMany({
      where: { functionId: 'watcher-notify/transitioned' },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
  });
});

// The replay cell of the Story-5.4 matrix (Subtask 5.4.11). A replayed /
// retried fan-out event re-runs the whole job — the dedupe lives one hop
// DOWNSTREAM: the re-emitted `email.send` events carry byte-identical
// idempotency keys, and the email.send job's event-level idempotency
// (`event.data.idempotencyKey` — the finding-#40-proven mechanism) drops the
// duplicates. So the contract under test is key STABILITY across runs, plus
// the seam binding: the fan-out writes its key at the exact path email.send
// dedups on.
describe('replay idempotency — a re-run fan-out re-emits identical keys', () => {
  it('binds the seam: the fan-out keys land at the path email.send dedups on', () => {
    expect(EMAIL_SEND_IDEMPOTENCY).toBe('event.data.idempotencyKey');
  });

  it('replaying the comment event emits the same recipients and the same keys', async () => {
    const s = await buildScenario();
    const capture = captureEmailEvents();
    const comment = await commentsService.addComment(s.issueId, { bodyMd: 'Replay me.' }, s.fx.ctx);
    capture.events.length = 0;

    const data: WorkItemCommentCreatedData = {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      commentId: comment.id,
      authorId: s.fx.ownerId,
      mentionedUserIds: [],
    };
    const run = async () => {
      const engine = new InngestTestEngine({
        function: watcherNotifyOnCommentCreated,
        events: [{ name: 'work-item/comment.created', data }],
      });
      const { result } = await engine.execute();
      const keys = capture.events.map((e) => e.data.idempotencyKey);
      capture.events.length = 0;
      return { result, keys };
    };

    const first = await run();
    const second = await run();

    expect(first.keys).toEqual([`watcher-comment:${comment.id}:${s.watcher.id}`]);
    expect(second.keys).toEqual(first.keys);
    expect(second.result).toEqual(first.result);
  });

  it('replaying the transitioned event emits the same keys', async () => {
    const s = await buildScenario();
    const capture = captureEmailEvents();

    const data: WorkItemTransitionedData = {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      actorId: s.fx.ownerId,
      fromStatusKey: 'todo',
      toStatusKey: 'in_progress',
      revisionId: 'rev-replay',
    };
    const run = async () => {
      const engine = new InngestTestEngine({
        function: watcherNotifyOnTransitioned,
        events: [{ name: 'work-item/transitioned', data }],
      });
      await engine.execute();
      const keys = capture.events.map((e) => e.data.idempotencyKey);
      capture.events.length = 0;
      return keys;
    };

    expect(await run()).toEqual([`watcher-transition:rev-replay:${s.watcher.id}`]);
    expect(await run()).toEqual([`watcher-transition:rev-replay:${s.watcher.id}`]);
  });
});

describe('watcherCommentNotification template', () => {
  const props = {
    recipientName: 'Wanda Watcher',
    authorName: 'Yue Zhu',
    workItemIdentifier: 'PROD-7',
    workItemTitle: 'Ship watchers',
    excerpt: 'A note.',
    issueUrl: 'http://localhost:3000/issues/PROD-7',
  };

  it('renders subject, lede, excerpt, the UNREDACTED deep link, and the watch reason', async () => {
    const rendered = await watcherCommentNotificationEmail(props);
    expect(rendered.subject).toBe('Yue Zhu commented on PROD-7: Ship watchers');
    expect(rendered.text).toContain('Hi Wanda Watcher,');
    expect(rendered.text).toContain('Yue Zhu commented on PROD-7: Ship watchers.');
    expect(rendered.text).toContain('A note.');
    // The dev-console grep contract: the URL appears verbatim, never `label (url)`.
    expect(rendered.text).toContain(`View work item: ${props.issueUrl}`);
    expect(rendered.text).toContain("You're receiving this because you watch PROD-7.");
    expect(rendered.html).toContain(props.issueUrl);
  });

  it('omits a null excerpt and renders the zh locale', async () => {
    const noExcerpt = await watcherCommentNotificationEmail({ ...props, excerpt: null });
    expect(noExcerpt.text).not.toContain('A note.');

    const zh = await watcherCommentNotificationEmail({ ...props, locale: 'zh' });
    expect(zh.subject).toBe('Yue Zhu在PROD-7中发表了评论：Ship watchers');
    expect(zh.text).toContain('查看工作项');
    expect(zh.text).toContain(props.issueUrl);
  });
});

describe('watcherTransitionNotification template', () => {
  const props = {
    recipientName: 'Wanda Watcher',
    actorName: 'Yue Zhu',
    workItemIdentifier: 'PROD-7',
    workItemTitle: 'Ship watchers',
    statusName: 'In progress',
    issueUrl: 'http://localhost:3000/issues/PROD-7',
  };

  it('renders subject, lede, the UNREDACTED deep link, and the watch reason', async () => {
    const rendered = await watcherTransitionNotificationEmail(props);
    expect(rendered.subject).toBe('Yue Zhu moved PROD-7 to In progress');
    expect(rendered.text).toContain('Hi Wanda Watcher,');
    expect(rendered.text).toContain('Yue Zhu moved PROD-7: Ship watchers to In progress.');
    expect(rendered.text).toContain(`View work item: ${props.issueUrl}`);
    expect(rendered.text).toContain("You're receiving this because you watch PROD-7.");
    expect(rendered.html).toContain(props.issueUrl);
  });

  it('renders the zh locale', async () => {
    const rendered = await watcherTransitionNotificationEmail({ ...props, locale: 'zh' });
    expect(rendered.subject).toBe('Yue Zhu将PROD-7移至In progress');
    expect(rendered.text).toContain('查看工作项');
    expect(rendered.text).toContain(props.issueUrl);
  });
});
