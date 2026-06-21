import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@prisma/client';
import { InngestTestEngine } from '@inngest/test';
import { db } from '@/lib/db';
import {
  mentionNotifyOnCommentCreated,
  mentionNotifyOnWorkItemMentioned,
} from '@/lib/jobs/definitions/mentionNotify';
import { jobFunctions } from '@/lib/jobs/registry';
import { mentionNotificationsService } from '@/lib/services/mentionNotificationsService';
import { mentionNotificationEmail } from '@/lib/emailTemplates/mentionNotification';
import { mentionExcerpt } from '@/lib/mentions/excerpt';
import { commentsService } from '@/lib/services/commentsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { resolveBaseUrlTrimmed } from '@/lib/baseUrl';
import type { WorkItemCommentCreatedData } from '@/lib/jobs/types';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { captureEmailEvents } from '../helpers/jobs';

// Mention → email fan-out (Story 5.1 · Subtask 5.1.6). Real Postgres, no DB
// mocks; the one external seam stubbed is the Inngest client's `send()` (the
// tests/helpers/jobs.ts pattern), which doubles as the assertion surface for
// the enqueued `email.send` events. Covers:
//   1. the fan-out service's send-time rules (skip author, re-validate view
//      access, vanish-tolerant on deleted comment/issue, dedup, idempotency
//      keys per source × user);
//   2. the two registered jobs driving the fan-out in-process via
//      @inngest/test (job_run bookkeeping included);
//   3. the mentionNotification template contract (pure render, unredacted
//      link, excerpt with @Name not raw tokens, locale arms).

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

const mentionToken = (u: User) => `[@${u.name}](mention:${u.id})`;

interface Scenario {
  fx: WorkItemFixture;
  issueId: string;
  issueIdentifier: string;
  /** Plain workspace member — viewable mention target on the open project. */
  member: User;
}

async function buildScenario(): Promise<Scenario> {
  const fx = await makeWorkItemFixture();
  const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Mentioned task' });
  const member = await usersService.createUser({
    email: 'mentionee@example.com',
    password: 'hunter2hunter2',
    name: 'Mention Target',
  });
  await workspacesService.addMember({ userId: member.id, workspaceId: fx.workspaceId });
  return { fx, issueId: issue.id, issueIdentifier: issue.identifier, member };
}

/** A real comment by the owner mentioning `mentioned`, via the real service. */
async function addMentioningComment(s: Scenario, mentioned: User) {
  return commentsService.addComment(
    s.issueId,
    { bodyMd: `Heads up ${mentionToken(mentioned)} — **please** review.` },
    s.fx.ctx,
  );
}

describe('mentionNotificationsService.fanOut — comment mentions', () => {
  it('enqueues one mention email per viewable mentioned user, with the source-scoped idempotency key', async () => {
    const s = await buildScenario();
    const capture = captureEmailEvents();
    const comment = await addMentioningComment(s, s.member);
    capture.events.length = 0; // drop anything the write path enqueued

    const result = await mentionNotificationsService.fanOut({
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      authorId: s.fx.ownerId,
      mentionedUserIds: [s.member.id],
      source: { kind: 'comment', commentId: comment.id },
    });

    expect(result.notifiedUserIds).toEqual([s.member.id]);
    expect(capture.events).toHaveLength(1);
    const evt = capture.events[0]!.data;
    expect(evt.to).toBe('mentionee@example.com');
    expect(evt.workspaceId).toBe(s.fx.workspaceId);
    expect(evt.idempotencyKey).toBe(`mention:${comment.id}:${s.member.id}`);
    expect(evt.template).toBe('mention-notification');
    if (evt.template !== 'mention-notification') throw new Error('unreachable');
    expect(evt.data.recipientName).toBe('Mention Target');
    expect(evt.data.workItemIdentifier).toBe(s.issueIdentifier);
    expect(evt.data.workItemTitle).toBe('Mentioned task');
    expect(evt.data.source).toBe('comment');
    expect(evt.data.issueUrl).toBe(`${resolveBaseUrlTrimmed()}/items/${s.issueIdentifier}`);
    // The excerpt is plain text: the mention token reads @Name, Markdown is
    // stripped, and the raw `mention:` scheme never leaks.
    expect(evt.data.excerpt).toBe('Heads up @Mention Target — please review.');
  });

  it('never notifies the author about their own mention, and dedupes repeated ids', async () => {
    const s = await buildScenario();
    const capture = captureEmailEvents();
    const comment = await addMentioningComment(s, s.member);
    capture.events.length = 0;

    const result = await mentionNotificationsService.fanOut({
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      authorId: s.fx.ownerId,
      mentionedUserIds: [s.fx.ownerId, s.member.id, s.member.id],
      source: { kind: 'comment', commentId: comment.id },
    });

    expect(result.notifiedUserIds).toEqual([s.member.id]);
    expect(capture.events).toHaveLength(1);
  });

  it('re-validates view access at send time: a user who can no longer view the issue is skipped', async () => {
    const s = await buildScenario();
    const capture = captureEmailEvents();
    const comment = await addMentioningComment(s, s.member);

    // Going private auto-enrolls the then-current workspace members; a user
    // added AFTER the flip is a workspace member with no project membership —
    // exactly "lost view access between write and send" for this issue.
    await projectMembersService.setAccessLevel({
      key: s.fx.projectIdentifier,
      actorUserId: s.fx.ownerId,
      ctx: s.fx.ctx,
      level: 'private',
    });
    const lateMember = await usersService.createUser({
      email: 'late@example.com',
      password: 'hunter2hunter2',
      name: 'Late Member',
    });
    await workspacesService.addMember({ userId: lateMember.id, workspaceId: s.fx.workspaceId });
    capture.events.length = 0;

    const result = await mentionNotificationsService.fanOut({
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      authorId: s.fx.ownerId,
      mentionedUserIds: [lateMember.id, s.member.id],
      source: { kind: 'comment', commentId: comment.id },
    });

    // The auto-enrolled member still sees the private project; the late one
    // does not — only the former is mailed.
    expect(result.notifiedUserIds).toEqual([s.member.id]);
    expect(capture.events).toHaveLength(1);
    expect(capture.events[0]!.data.to).toBe('mentionee@example.com');
  });

  it('resolves to zero sends when the comment was hard-deleted since the write', async () => {
    const s = await buildScenario();
    const capture = captureEmailEvents();
    const comment = await addMentioningComment(s, s.member);
    await commentsService.deleteComment(comment.id, s.fx.ctx);
    capture.events.length = 0;

    const result = await mentionNotificationsService.fanOut({
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      authorId: s.fx.ownerId,
      mentionedUserIds: [s.member.id],
      source: { kind: 'comment', commentId: comment.id },
    });

    expect(result.notifiedUserIds).toEqual([]);
    expect(capture.events).toHaveLength(0);
  });

  it('resolves to zero sends when the work item is gone or belongs to another workspace', async () => {
    const s = await buildScenario();
    const capture = captureEmailEvents();
    const comment = await addMentioningComment(s, s.member);
    capture.events.length = 0;

    const missingItem = await mentionNotificationsService.fanOut({
      workspaceId: s.fx.workspaceId,
      workItemId: 'no-such-item',
      authorId: s.fx.ownerId,
      mentionedUserIds: [s.member.id],
      source: { kind: 'comment', commentId: comment.id },
    });
    expect(missingItem.notifiedUserIds).toEqual([]);

    const crossWorkspace = await mentionNotificationsService.fanOut({
      workspaceId: 'some-other-workspace',
      workItemId: s.issueId,
      authorId: s.fx.ownerId,
      mentionedUserIds: [s.member.id],
      source: { kind: 'comment', commentId: comment.id },
    });
    expect(crossWorkspace.notifiedUserIds).toEqual([]);
    expect(capture.events).toHaveLength(0);
  });
});

describe('mentionNotificationsService.fanOut — description mentions', () => {
  it('excerpts the current description and scopes idempotency to the revision', async () => {
    const s = await buildScenario();
    const capture = captureEmailEvents();
    await db.$transaction((tx) =>
      workItemRepository.update(
        s.issueId,
        { descriptionMd: `Owned by ${mentionToken(s.member)}.` },
        tx,
      ),
    );

    const result = await mentionNotificationsService.fanOut({
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      authorId: s.fx.ownerId,
      mentionedUserIds: [s.member.id],
      source: { kind: 'description', revisionId: 'rev-123' },
    });

    expect(result.notifiedUserIds).toEqual([s.member.id]);
    expect(capture.events).toHaveLength(1);
    const evt = capture.events[0]!.data;
    expect(evt.idempotencyKey).toBe(`mention:rev-123:${s.member.id}`);
    if (evt.template !== 'mention-notification') throw new Error('unreachable');
    expect(evt.data.source).toBe('description');
    expect(evt.data.excerpt).toBe('Owned by @Mention Target.');
  });
});

describe('mentionNotify jobs — in-process runs', () => {
  it('registers both consumers in the job registry', () => {
    expect(jobFunctions).toContain(mentionNotifyOnCommentCreated);
    expect(jobFunctions).toContain(mentionNotifyOnWorkItemMentioned);
  });

  it('drives the comment-created event end-to-end: fan-out runs, email.send enqueued, run recorded', async () => {
    const s = await buildScenario();
    const capture = captureEmailEvents();
    const comment = await addMentioningComment(s, s.member);
    capture.events.length = 0;

    const data: WorkItemCommentCreatedData = {
      workspaceId: s.fx.workspaceId,
      workItemId: s.issueId,
      commentId: comment.id,
      authorId: s.fx.ownerId,
      mentionedUserIds: [s.member.id],
    };
    const engine = new InngestTestEngine({
      function: mentionNotifyOnCommentCreated,
      events: [{ name: 'work-item/comment.created', data }],
    });
    const { result } = await engine.execute();

    expect(result).toEqual({ notifiedUserIds: [s.member.id] });
    expect(capture.events).toHaveLength(1);
    expect(capture.events[0]!.data.idempotencyKey).toBe(`mention:${comment.id}:${s.member.id}`);

    const runs = await db.jobRun.findMany({
      where: { functionId: 'work-item/comment.created' },
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.workspaceId).toBe(s.fx.workspaceId);
  });

  it('no-ops fast on a mention-free comment event (every comment fires the event)', async () => {
    const s = await buildScenario();
    const capture = captureEmailEvents();
    const comment = await commentsService.addComment(s.issueId, { bodyMd: 'No tags.' }, s.fx.ctx);
    capture.events.length = 0;

    const engine = new InngestTestEngine({
      function: mentionNotifyOnCommentCreated,
      events: [
        {
          name: 'work-item/comment.created',
          data: {
            workspaceId: s.fx.workspaceId,
            workItemId: s.issueId,
            commentId: comment.id,
            authorId: s.fx.ownerId,
            mentionedUserIds: [],
          } satisfies WorkItemCommentCreatedData,
        },
      ],
    });
    const { result } = await engine.execute();

    expect(result).toEqual({ notifiedUserIds: [] });
    expect(capture.events).toHaveLength(0);
  });
});

describe('mentionNotification template', () => {
  const props = {
    recipientName: 'Mention Target',
    authorName: 'Yue Zhu',
    workItemIdentifier: 'PROD-7',
    workItemTitle: 'Ship comments',
    source: 'comment' as const,
    excerpt: 'Heads up @Mention Target — please review.',
    issueUrl: 'http://localhost:3000/items/PROD-7',
  };

  it('renders subject, lede, excerpt, and the UNREDACTED deep link in plain text', async () => {
    const rendered = await mentionNotificationEmail(props);
    expect(rendered.subject).toBe('Yue Zhu mentioned you on PROD-7: Ship comments');
    expect(rendered.text).toContain('Hi Mention Target,');
    expect(rendered.text).toContain('mentioned you in a comment on PROD-7: Ship comments.');
    expect(rendered.text).toContain(props.excerpt);
    // The dev-console grep contract: the URL appears verbatim, never `label (url)`.
    expect(rendered.text).toContain(`View work item: ${props.issueUrl}`);
    expect(rendered.html).toContain(props.issueUrl);
  });

  it('switches the lede for description mentions and omits a null excerpt', async () => {
    const rendered = await mentionNotificationEmail({
      ...props,
      source: 'description',
      excerpt: null,
    });
    expect(rendered.text).toContain('mentioned you in the description of PROD-7');
    expect(rendered.text).not.toContain('Heads up');
  });

  it('renders the zh locale', async () => {
    const rendered = await mentionNotificationEmail({ ...props, locale: 'zh' });
    expect(rendered.subject).toBe('Yue Zhu在PROD-7中提到了你：Ship comments');
    expect(rendered.text).toContain('查看工作项');
    expect(rendered.text).toContain(props.issueUrl);
  });
});

describe('mentionExcerpt', () => {
  it('renders mention tokens as @Name, strips Markdown, and truncates on a word boundary', () => {
    expect(mentionExcerpt('Hi [@Bo Philips](mention:abc123), see `code` **now**')).toBe(
      'Hi @Bo Philips, see code now',
    );
    const long = `[@A B](mention:x) ${'word '.repeat(60)}`;
    const out = mentionExcerpt(long);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(161);
    expect(out!.endsWith('…')).toBe(true);
  });

  it('returns null for empty bodies', () => {
    expect(mentionExcerpt(null)).toBeNull();
    expect(mentionExcerpt('')).toBeNull();
    expect(mentionExcerpt('   ')).toBeNull();
  });
});
