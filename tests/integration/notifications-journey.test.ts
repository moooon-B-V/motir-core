import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, type User } from '@prisma/client';
import { db } from '@/lib/db';
import {
  notificationFanInService,
  NOTIFICATION_FAN_IN_REGISTRY,
  type NotificationData,
  type NotificationFanInRegistry,
} from '@/lib/services/notificationFanInService';
import { notificationsService } from '@/lib/services/notificationsService';
import { notificationPreferencesService } from '@/lib/services/notificationPreferencesService';
import { mentionNotificationsService } from '@/lib/services/mentionNotificationsService';
import { notificationRepository } from '@/lib/repositories/notificationRepository';
import { commentsService } from '@/lib/services/commentsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { projectMembersService } from '@/lib/services/projectMembersService';
import type { WorkItemCommentCreatedData } from '@/lib/jobs/types';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import { captureEmailEvents } from '../helpers/jobs';

// Story 5.7 (in-app notifications) — the cross-cutting Vitest verification
// (Subtask 5.7.7). The integration companion to the per-subtask unit suites
// (`tests/jobs/notification-fan-in.test.ts` 5.7.3, `tests/notifications/
// notificationsService.test.ts` 5.7.4, `tests/notifications/notification-
// preferences.test.ts` 5.7.6). Real Postgres, no DB mocks (CLAUDE.md); the only
// stubbed seam is the Inngest client's send() (captureEmailEvents) for the
// email-channel assertions — every other call hits the real path.
//
// It deliberately does NOT re-test what an owning subtask already proves in
// isolation. It asserts the SEAMS BETWEEN the subtasks — the places the unit
// suites stub or stop short — end to end, on one issue, in one flow:
//
//   * FAN-IN → FEED (5.7.3 → 5.7.2 → 5.7.4): a real comment mention fanned in
//     by the job service, read BACK through notificationsService — the DTO
//     shape (actor, deep-link key, rendered excerpt), the seen/read counts, and
//     the author's own empty feed. The 5.7.3 unit reads raw `db.notification`
//     rows; the 5.7.4 unit SEEDS rows via the repo. Neither ties the writer to
//     the reader — this does.
//   * ONE RESOLVER, TWO CHANNELS (5.7.6 ↔ 5.7.3 in-app & 5.1.6 email): on ONE
//     mention, the SAME `notificationPreferencesService` resolver gates both the
//     in-app fan-in AND the email fan-out, INDEPENDENTLY and via the REAL path —
//     the 5.7.3 unit STUBS the gate, the 5.7.6 unit wires only email. This is
//     the story's headline invariant ("one emit path, many channels"), proven
//     with both consumers live.
//   * MODEL ↔ READ (5.7.2 ↔ 5.7.4): the FK cascades (recipient / work-item
//     delete remove rows; actor delete SetNulls) and the idempotency `@@unique`,
//     observed through the read API and the raw row — the model assertions
//     5.7.2 shipped without a dedicated test file.
//   * EXTENSIBILITY → FEED (the 5.4/6.6 seam): a SYNTHETIC `watching` event
//     fans in through the same core and surfaces under the Watching tab of the
//     real feed read — WITHOUT importing Story 5.4 / 6.6 code (the seam carries
//     no forward dep).
//
// Where the unit suites leave a fan-in / repository branch uncovered (the
// post-exclusion-empty and all-view-lost no-ops; the repositories' no-`tx`
// read paths), the seams below exercise it — 5.7.7 adds these service/repo/job
// files to the CI coverage gate, so those branches must be hit.

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

interface Journey {
  fx: WorkItemFixture;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  /** The actor / comment author — the fixture owner. Never a recipient. */
  ownerCtx: ServiceContext;
  /** A workspace member with view access — the mention recipient. */
  bo: User;
  boCtx: ServiceContext;
}

const ISSUE_TITLE = 'Notified task';

async function makeJourney(): Promise<Journey> {
  const fx = await makeWorkItemFixture();
  const issue = await createTestWorkItem(fx, { kind: 'task', title: ISSUE_TITLE });
  const bo = await usersService.createUser({
    email: 'bo@example.com',
    password: 'hunter2hunter2',
    name: 'Bo Philips',
  });
  await workspacesService.addMember({ userId: bo.id, workspaceId: fx.workspaceId });
  return {
    fx,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
    issueTitle: ISSUE_TITLE,
    ownerCtx: { userId: fx.ownerId, workspaceId: fx.workspaceId },
    bo,
    boCtx: { userId: bo.id, workspaceId: fx.workspaceId },
  };
}

/** A real owner comment mentioning `mentioned`, through the real service. */
async function mentionComment(j: Journey, mentioned: User) {
  return commentsService.addComment(
    j.issueId,
    { bodyMd: `Heads up ${mentionToken(mentioned)} — **please** review.` },
    j.fx.ctx,
  );
}

/** The in-app consumer (5.7.3) of the comment-created event. */
function fanInComment(j: Journey, commentId: string, mentionedUserIds: string[]) {
  return notificationFanInService.fanIn('work-item/comment.created', {
    workspaceId: j.fx.workspaceId,
    workItemId: j.issueId,
    commentId,
    authorId: j.fx.ownerId,
    mentionedUserIds,
  } satisfies WorkItemCommentCreatedData);
}

/** The email consumer (5.1.6) of the SAME comment-created event. */
function fanOutEmail(j: Journey, commentId: string, mentionedUserIds: string[]) {
  return mentionNotificationsService.fanOut({
    workspaceId: j.fx.workspaceId,
    workItemId: j.issueId,
    authorId: j.fx.ownerId,
    mentionedUserIds,
    source: { kind: 'comment', commentId },
  });
}

// ── FAN-IN → FEED ────────────────────────────────────────────────────────────

describe('a real comment mention is fanned in and read back through the feed (5.7.3 → 5.7.4)', () => {
  it('surfaces in the recipient feed with the rendered DTO; the author is excluded end to end', async () => {
    const j = await makeJourney();
    const comment = await mentionComment(j, j.bo);

    const result = await fanInComment(j, comment.id, [j.bo.id]);
    expect(result.writtenUserIds).toEqual([j.bo.id]);

    // The recipient reads it through the SERVICE, not raw rows.
    const page = await notificationsService.listNotifications({}, j.boCtx);
    expect(page.totalCount).toBe(1);
    expect(page.unreadCount).toBe(1);
    expect(page.nextCursor).toBeNull();

    const row = page.notifications[0]!;
    expect(row.category).toBe('direct');
    expect(row.readAt).toBeNull();
    expect(row.workItemId).toBe(j.issueId);
    // The actor renders from the batched user read.
    expect(row.actor).toEqual({ id: j.fx.ownerId, name: 'Owner', image: null });

    // The denormalized payload the fan-in (5.7.3) stored — asserted on the raw
    // row (the producer truth) so the writer→reader tie is exact.
    const raw = await db.notification.findFirstOrThrow({ where: { recipientUserId: j.bo.id } });
    const stored = raw.data as unknown as NotificationData;
    expect(stored.kind).toBe('mentioned');
    expect(stored.source).toBe('comment');
    expect(stored.workItemKey).toBe(j.issueIdentifier);
    expect(stored.workItemTitle).toBe(j.issueTitle);
    expect(stored.excerpt).toBe('Heads up @Bo Philips — please review.');

    // ⚠️ FINDING (pre-existing 5.7.3↔5.7.4 contract mismatch — logged as a bug,
    // surfaced in the PR body, NOT fixed in this test subtask): the fan-in
    // writes the payload under `kind` / `source` / `workItemKey` / `workItemTitle`,
    // but the read API's `NotificationData` DTO (lib/dto/notifications) declares
    // `issueKey` / `title`, and `toNotificationDto` passes `data` through
    // UNMAPPED. So a fanned-in row read via the service exposes the producer keys
    // verbatim — the typed `issueKey` / `title` the future 5.7.5 drawer would
    // read are `undefined`. This seam test is what surfaces it; the excerpt
    // (the one field both shapes share) does survive the round-trip.
    expect(row.data.issueKey).toBeUndefined();
    expect(row.data.title).toBeUndefined();
    expect(row.data.excerpt).toBe('Heads up @Bo Philips — please review.');

    // The author never has a row about their own mention — self-exclusion, all
    // the way through to their feed read.
    const ownerFeed = await notificationsService.listNotifications({}, j.ownerCtx);
    expect(ownerFeed.totalCount).toBe(0);
    expect(ownerFeed.unreadCount).toBe(0);
  });

  it('mentioning only the author writes nothing (post-exclusion empty is a clean no-op)', async () => {
    const j = await makeJourney();
    // A comment that @-mentions the author themselves — the plan is built, then
    // the only candidate is excluded, leaving an empty set.
    const comment = await commentsService.addComment(
      j.issueId,
      { bodyMd: `Note to self ${mentionToken({ id: j.fx.ownerId, name: 'Owner' } as User)}.` },
      j.fx.ctx,
    );
    const result = await fanInComment(j, comment.id, [j.fx.ownerId]);
    expect(result.writtenUserIds).toEqual([]);
    expect(await notificationsService.listNotifications({}, j.ownerCtx)).toMatchObject({
      totalCount: 0,
    });
  });

  it('a recipient who has lost view access gets nothing — all-excluded fans in no rows', async () => {
    const j = await makeJourney();
    const comment = await mentionComment(j, j.bo);
    // Take the project private AFTER the comment: it auto-enrolls the current
    // members, but a member added now has no project access — "lost view access
    // between the write and the fan-in".
    await projectMembersService.setAccessLevel({
      key: j.fx.projectIdentifier,
      actorUserId: j.fx.ownerId,
      ctx: j.fx.ctx,
      level: 'private',
    });
    const late = await usersService.createUser({
      email: 'late@example.com',
      password: 'hunter2hunter2',
      name: 'Late Member',
    });
    await workspacesService.addMember({ userId: late.id, workspaceId: j.fx.workspaceId });

    // `late` is the ONLY mentioned user, and cannot browse → the whole fan-in
    // resolves to zero rows (the all-view-lost no-op branch).
    const result = await fanInComment(j, comment.id, [late.id]);
    expect(result.writtenUserIds).toEqual([]);
    const lateCtx: ServiceContext = { userId: late.id, workspaceId: j.fx.workspaceId };
    expect(await notificationsService.listNotifications({}, lateCtx)).toMatchObject({
      totalCount: 0,
    });
  });

  it('marking a fanned-in row read decrements the count from the response; mark-all clears the rest, read rows persist', async () => {
    const j = await makeJourney();
    // Three distinct comment mentions → three distinct dedupe keys → three rows.
    for (const body of ['one', 'two', 'three']) {
      const c = await commentsService.addComment(
        j.issueId,
        { bodyMd: `${body} ${mentionToken(j.bo)}` },
        j.fx.ctx,
      );
      await fanInComment(j, c.id, [j.bo.id]);
    }
    expect(await notificationsService.getUnreadCount(j.boCtx)).toEqual({ unreadCount: 3 });

    const before = await notificationsService.listNotifications({}, j.boCtx);
    const target = before.notifications[0]!;
    const marked = await notificationsService.markRead(target.id, j.boCtx);
    expect(marked.notification.readAt).not.toBeNull();
    // The badge count comes from the mutation RESPONSE (the inline-edit contract).
    expect(marked.unreadCount).toBe(2);

    // Read rows persist in the feed (greyed, not removed); only the dot clears.
    const afterMark = await notificationsService.listNotifications({}, j.boCtx);
    expect(afterMark.totalCount).toBe(3);
    expect(afterMark.unreadCount).toBe(2);
    expect(afterMark.notifications.filter((n) => n.readAt !== null)).toHaveLength(1);

    // "Mark all as read" — one bulk op, returns zero; rows stay in the feed.
    const all = await notificationsService.markAllRead(j.boCtx);
    expect(all.unreadCount).toBe(0);
    const afterAll = await notificationsService.listNotifications({}, j.boCtx);
    expect(afterAll.totalCount).toBe(3);
    expect(afterAll.unreadCount).toBe(0);
  });
});

// ── ONE RESOLVER, TWO CHANNELS ───────────────────────────────────────────────

describe('the single notification-preference resolver gates BOTH channels independently (5.7.6 ↔ 5.7.3 + 5.1.6)', () => {
  it('default preferences: one mention writes the in-app row AND enqueues the email', async () => {
    const j = await makeJourney();
    const comment = await mentionComment(j, j.bo);

    const cap = captureEmailEvents();
    const inApp = await fanInComment(j, comment.id, [j.bo.id]);
    const email = await fanOutEmail(j, comment.id, [j.bo.id]);

    expect(inApp.writtenUserIds).toEqual([j.bo.id]);
    expect(await notificationsService.getUnreadCount(j.boCtx)).toEqual({ unreadCount: 1 });
    expect(email.notifiedUserIds).toEqual([j.bo.id]);
    expect(cap.events.some((e) => e.data.to === 'bo@example.com')).toBe(true);
    cap.restore();
  });

  it('in-app OFF suppresses the bell row but leaves the email untouched', async () => {
    const j = await makeJourney();
    await notificationPreferencesService.setPreference(j.bo.id, {
      eventType: 'mentioned',
      channel: 'in_app',
      enabled: false,
    });
    const comment = await mentionComment(j, j.bo);

    const cap = captureEmailEvents();
    const inApp = await fanInComment(j, comment.id, [j.bo.id]);
    const email = await fanOutEmail(j, comment.id, [j.bo.id]);

    // In-app gated out at the REAL resolver (not a stub) — no row, no count.
    expect(inApp.writtenUserIds).toEqual([]);
    expect(await notificationsService.getUnreadCount(j.boCtx)).toEqual({ unreadCount: 0 });
    // Email is the OTHER channel of the same resolver — still sends.
    expect(email.notifiedUserIds).toEqual([j.bo.id]);
    expect(cap.events.some((e) => e.data.to === 'bo@example.com')).toBe(true);
    cap.restore();
  });

  it('email OFF suppresses the mail but the bell row still writes', async () => {
    const j = await makeJourney();
    await notificationPreferencesService.setPreference(j.bo.id, {
      eventType: 'mentioned',
      channel: 'email',
      enabled: false,
    });
    const comment = await mentionComment(j, j.bo);

    const cap = captureEmailEvents();
    const inApp = await fanInComment(j, comment.id, [j.bo.id]);
    const email = await fanOutEmail(j, comment.id, [j.bo.id]);

    // The in-app channel is untouched (still default ON) — the row writes.
    expect(inApp.writtenUserIds).toEqual([j.bo.id]);
    expect(await notificationsService.getUnreadCount(j.boCtx)).toEqual({ unreadCount: 1 });
    // Email gated out at its send decision — no mail.
    expect(email.notifiedUserIds).toEqual([]);
    expect(cap.events.some((e) => e.data.to === 'bo@example.com')).toBe(false);
    cap.restore();
  });
});

// ── MODEL ↔ READ ─────────────────────────────────────────────────────────────

/** Seed one row through the repo's required-`tx` write path (the 5.7.3 shape). */
async function seedRow(
  j: Journey,
  recipientUserId: string,
  opts: {
    dedupeKey: string;
    actorId?: string | null;
    readAt?: Date | null;
    category?: 'direct' | 'watching';
  },
): Promise<void> {
  await db.$transaction((tx) =>
    notificationRepository.createMany(
      [
        {
          workspaceId: j.fx.workspaceId,
          recipientUserId,
          type: 'mentioned',
          category: opts.category ?? 'direct',
          workItemId: j.issueId,
          actorId: opts.actorId ?? null,
          data: {
            kind: 'mentioned',
            source: 'comment',
            workItemKey: j.issueIdentifier,
            workItemTitle: j.issueTitle,
            excerpt: null,
          } as Prisma.InputJsonValue,
          dedupeKey: opts.dedupeKey,
          readAt: opts.readAt ?? null,
        },
      ],
      tx,
    ),
  );
}

describe('the Notification model cascades + idempotency, observed through the read paths (5.7.2 ↔ 5.7.4)', () => {
  it('deleting the recipient removes their notifications (Cascade)', async () => {
    const j = await makeJourney();
    await seedRow(j, j.bo.id, { dedupeKey: 'r1' });
    expect(await notificationRepository.countUnreadByRecipient(j.bo.id)).toBe(1);

    await db.user.delete({ where: { id: j.bo.id } });
    expect(await db.notification.count({ where: { recipientUserId: j.bo.id } })).toBe(0);
  });

  it('deleting the work item removes its notifications (Cascade)', async () => {
    const j = await makeJourney();
    await seedRow(j, j.bo.id, { dedupeKey: 'wi1' });
    expect(await notificationRepository.countByRecipient(j.bo.id)).toBe(1);

    await db.workItem.delete({ where: { id: j.issueId } });
    expect(await db.notification.count({ where: { recipientUserId: j.bo.id } })).toBe(0);
  });

  it('deleting the actor SetNulls actorId; the feed then renders a null actor', async () => {
    const j = await makeJourney();
    // A distinct, deletable actor (NOT the fixture owner, whose deletion would
    // cascade the whole workspace).
    const actor = await usersService.createUser({
      email: 'actor@example.com',
      password: 'hunter2hunter2',
      name: 'Acting Member',
    });
    await workspacesService.addMember({ userId: actor.id, workspaceId: j.fx.workspaceId });
    await seedRow(j, j.bo.id, { dedupeKey: 'a1', actorId: actor.id });

    await db.user.delete({ where: { id: actor.id } });

    // DB-level SetNull: the row survives, actorId is now null.
    const raw = await db.notification.findFirstOrThrow({ where: { recipientUserId: j.bo.id } });
    expect(raw.actorId).toBeNull();
    // Read path: the feed renders the missing actor as null, never throwing.
    const page = await notificationsService.listNotifications({}, j.boCtx);
    expect(page.notifications[0]!.actor).toBeNull();
  });

  it('the unread count ignores read rows (the partial-index aggregate)', async () => {
    const j = await makeJourney();
    await seedRow(j, j.bo.id, { dedupeKey: 'u1' });
    await seedRow(j, j.bo.id, { dedupeKey: 'u2' });
    await seedRow(j, j.bo.id, { dedupeKey: 'rd', readAt: new Date() });
    // Repository read via the `db` singleton (no `tx`) — the read-path the
    // routes hit and the badge poll uses.
    expect(await notificationRepository.countUnreadByRecipient(j.bo.id)).toBe(2);
    expect(await notificationRepository.countByRecipient(j.bo.id)).toBe(3);
  });

  it('the (dedupeKey, recipientUserId) @@unique rejects a duplicate row', async () => {
    const j = await makeJourney();
    await seedRow(j, j.bo.id, { dedupeKey: 'dup' });
    const existing = await db.notification.findFirstOrThrow({
      where: { recipientUserId: j.bo.id },
    });

    // A second row with the SAME (dedupeKey, recipient) violates the unique —
    // the constraint behind createMany(skipDuplicates)'s replay idempotency.
    await expect(
      db.notification.create({
        data: {
          workspaceId: existing.workspaceId,
          recipientUserId: existing.recipientUserId,
          type: existing.type,
          category: existing.category,
          workItemId: existing.workItemId,
          actorId: existing.actorId,
          data: existing.data as Prisma.InputJsonValue,
          dedupeKey: existing.dedupeKey,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    // Still exactly one row — the replay never doubled it.
    expect(await db.notification.count({ where: { dedupeKey: 'dup' } })).toBe(1);
  });

  it('a replayed fan-in writes no second row; the feed still shows one (skipDuplicates idempotency)', async () => {
    const j = await makeJourney();
    const comment = await mentionComment(j, j.bo);
    await fanInComment(j, comment.id, [j.bo.id]);
    const replay = await fanInComment(j, comment.id, [j.bo.id]);
    // Validation still passes (recipient reported), but the row is not doubled.
    expect(replay.writtenUserIds).toEqual([j.bo.id]);
    expect(await notificationsService.listNotifications({}, j.boCtx)).toMatchObject({
      totalCount: 1,
    });
  });

  it('repository reads via the db singleton: cursor past the end is an empty page; empty createMany is a no-op', async () => {
    const j = await makeJourney();
    await seedRow(j, j.bo.id, { dedupeKey: 'p1' });
    const [only] = await notificationRepository.listByRecipient(j.bo.id, { category: 'direct' });
    expect(only).toBeDefined();
    // Resuming after the last row yields nothing (cursor edge).
    const past = await notificationRepository.listByRecipient(j.bo.id, { cursor: only!.id });
    expect(past).toEqual([]);
    // findById via the singleton resolves the row; a missing id is null.
    expect((await notificationRepository.findById(only!.id))?.id).toBe(only!.id);
    expect(await notificationRepository.findById('no-such-id')).toBeNull();
    // The empty-input guard short-circuits with no DB round-trip.
    expect(await db.$transaction((tx) => notificationRepository.createMany([], tx))).toBe(0);
  });
});

// ── EXTENSIBILITY → FEED (the 5.4 / 6.6 seam, no forward dep) ─────────────────

describe('a synthetic watching-category event fans in and surfaces under the Watching tab (the 5.4/6.6 seam)', () => {
  it('reaches the feed through the same core + read API, with no Story 5.4 / 6.6 import', async () => {
    const j = await makeJourney();
    // The shape Story 5.4 (`transitioned` / `watching`) and 6.6 add LATER — a
    // registry entry only, no change to the fan-in core. No import of 5.4/6.6
    // code: the seam carries no forward dep.
    const syntheticRegistry: NotificationFanInRegistry = {
      ...NOTIFICATION_FAN_IN_REGISTRY,
      'synthetic/watched.thing': {
        notificationType: 'transitioned',
        category: 'watching',
        async buildPlan() {
          return {
            actorId: j.fx.ownerId,
            candidateUserIds: [j.bo.id],
            dedupeSourceId: 'syn-1',
            data: {
              kind: 'mentioned',
              source: 'description',
              workItemKey: j.issueIdentifier,
              workItemTitle: j.issueTitle,
              excerpt: null,
            } satisfies NotificationData,
          };
        },
      },
    };

    const result = await notificationFanInService.fanIn(
      'synthetic/watched.thing',
      { workspaceId: j.fx.workspaceId, workItemId: j.issueId },
      syntheticRegistry,
    );
    expect(result.writtenUserIds).toEqual([j.bo.id]);

    // It lands under the Watching tab of the REAL feed read, not Direct.
    const watching = await notificationsService.listNotifications(
      { category: 'watching' },
      j.boCtx,
    );
    expect(watching.totalCount).toBe(1);
    expect(watching.notifications[0]!.category).toBe('watching');
    const direct = await notificationsService.listNotifications({ category: 'direct' }, j.boCtx);
    expect(direct.totalCount).toBe(0);
  });
});
