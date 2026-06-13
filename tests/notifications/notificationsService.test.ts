import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Notification, User, WorkItem } from '@prisma/client';
import { db } from '@/lib/db';
import { notificationsService, NOTIFICATION_PAGE_SIZE } from '@/lib/services/notificationsService';
import { notificationRepository } from '@/lib/repositories/notificationRepository';
import { toNotificationDto } from '@/lib/mappers/notificationMappers';
import { NotificationNotFoundError } from '@/lib/notifications/errors';
import { createTestUser, createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { truncateAuthTables } from '../helpers/db';

// Service-layer tests for notificationsService (Story 5.7 · Subtask 5.7.4) —
// the READ + mark-state API the bell/drawer (5.7.5) calls. Real Postgres, no DB
// mocks (CLAUDE.md). They run as the dev/CI superuser via the `db` singleton, so
// RLS is inert (BYPASSRLS) — the workspace gate the service binds via
// withWorkspaceContext is exercised under the prodect_app role in the
// multi-tenant-rls suite's pattern; what's proven HERE is the application-layer
// contract: per-recipient scoping, the finding-#44 404 (a row owned by another
// user / in another workspace is indistinguishable from a missing one), cursor
// paging (finding #57 — never a load-all), the badge-poll vs feed-read split,
// mark-read idempotency + the returned fresh count (the inline-edit contract),
// and the single-bulk mark-all.

beforeEach(async () => {
  // truncateAuthTables truncates `workspace` + `user` RESTART IDENTITY CASCADE,
  // which cascades to `notification` (both FK chains have onDelete actions).
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

interface Scenario {
  fx: WorkItemFixture;
  issue: WorkItem;
  recipient: User;
  actor: User;
  /** The recipient's request context — the service scopes every call to it. */
  ctx: ServiceContext;
}

async function makeScenario(): Promise<Scenario> {
  const fx = await makeWorkItemFixture();
  const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Notified task' });
  const recipient = await createTestUser({ name: 'Recipient' });
  const actor = await createTestUser({ name: 'Actor' });
  return {
    fx,
    issue,
    recipient,
    actor,
    ctx: { userId: recipient.id, workspaceId: fx.workspaceId },
  };
}

/**
 * Insert notifications for a recipient through the repository's required-`tx`
 * write path (the 5.7.3 job's createMany shape). Rows are inserted oldest-first
 * with a monotonically increasing `createdAt` so the feed's newest-first walk
 * is deterministic (no same-millisecond ties to fight the cursor tie-break).
 */
async function seed(
  s: Scenario,
  recipientUserId: string,
  rows: Array<{
    dedupeKey: string;
    type?: string;
    category?: 'direct' | 'watching';
    readAt?: Date | null;
    actorId?: string | null;
    createdAt?: Date;
  }>,
): Promise<number> {
  return db.$transaction(async (tx) =>
    notificationRepository.createMany(
      rows.map((r, i) => ({
        workspaceId: s.fx.workspaceId,
        recipientUserId,
        type: r.type ?? 'mentioned',
        category: r.category ?? 'direct',
        workItemId: s.issue.id,
        actorId: r.actorId === undefined ? s.actor.id : r.actorId,
        data: { issueKey: s.issue.identifier, title: s.issue.title },
        dedupeKey: r.dedupeKey,
        readAt: r.readAt ?? null,
        createdAt: r.createdAt ?? new Date(Date.now() + i * 1000),
      })),
      tx,
    ),
  );
}

describe('notificationsService.listNotifications', () => {
  it('returns the recipient feed newest-first with total + unread counts', async () => {
    const s = await makeScenario();
    await seed(s, s.recipient.id, [
      { dedupeKey: 'n1', readAt: new Date() },
      { dedupeKey: 'n2' },
      { dedupeKey: 'n3' },
    ]);

    const page = await notificationsService.listNotifications({}, s.ctx);

    expect(page.totalCount).toBe(3);
    expect(page.unreadCount).toBe(2);
    expect(page.nextCursor).toBeNull();
    // Newest first (n3 inserted last).
    expect(page.notifications.map((n) => n.data.issueKey)).toEqual([
      s.issue.identifier,
      s.issue.identifier,
      s.issue.identifier,
    ]);
    expect(page.notifications[0]?.readAt).toBeNull();
    expect(page.notifications[0]?.actor).toEqual({
      id: s.actor.id,
      name: s.actor.name,
      image: s.actor.image ?? null,
    });
  });

  it('scopes strictly to the session user — never another recipient’s rows', async () => {
    const s = await makeScenario();
    const other = await createTestUser({ name: 'Other' });
    await seed(s, s.recipient.id, [{ dedupeKey: 'mine' }]);
    await seed(s, other.id, [{ dedupeKey: 'theirs1' }, { dedupeKey: 'theirs2' }]);

    const page = await notificationsService.listNotifications({}, s.ctx);
    expect(page.totalCount).toBe(1);
    expect(page.notifications).toHaveLength(1);
  });

  it('cursor-pages (take 20 + Show more), never a load-all (finding #57)', async () => {
    const s = await makeScenario();
    const rows = Array.from({ length: NOTIFICATION_PAGE_SIZE + 5 }, (_, i) => ({
      dedupeKey: `p${i}`,
    }));
    await seed(s, s.recipient.id, rows);

    const first = await notificationsService.listNotifications({}, s.ctx);
    expect(first.notifications).toHaveLength(NOTIFICATION_PAGE_SIZE);
    expect(first.totalCount).toBe(NOTIFICATION_PAGE_SIZE + 5);
    expect(first.nextCursor).not.toBeNull();

    const second = await notificationsService.listNotifications(
      { cursor: first.nextCursor ?? undefined },
      s.ctx,
    );
    expect(second.notifications).toHaveLength(5);
    expect(second.nextCursor).toBeNull();

    // No row repeats across the page boundary (the cursor tie-break holds).
    const ids = new Set([
      ...first.notifications.map((n) => n.id),
      ...second.notifications.map((n) => n.id),
    ]);
    expect(ids.size).toBe(NOTIFICATION_PAGE_SIZE + 5);
  });

  it('narrows to one drawer tab via category, counting only that tab', async () => {
    const s = await makeScenario();
    await seed(s, s.recipient.id, [
      { dedupeKey: 'd1', category: 'direct' },
      { dedupeKey: 'd2', category: 'direct' },
      { dedupeKey: 'w1', category: 'watching' },
    ]);

    const direct = await notificationsService.listNotifications({ category: 'direct' }, s.ctx);
    expect(direct.totalCount).toBe(2);
    expect(direct.notifications.every((n) => n.category === 'direct')).toBe(true);

    const watching = await notificationsService.listNotifications({ category: 'watching' }, s.ctx);
    expect(watching.totalCount).toBe(1);
    expect(watching.notifications[0]?.category).toBe('watching');
  });

  it('returns an empty page (counts zero, no cursor) when there are none', async () => {
    const s = await makeScenario();
    const page = await notificationsService.listNotifications({}, s.ctx);
    expect(page.notifications).toEqual([]);
    expect(page.totalCount).toBe(0);
    expect(page.unreadCount).toBe(0);
    expect(page.nextCursor).toBeNull();
  });

  it('renders a system notification (null actor) without throwing', async () => {
    const s = await makeScenario();
    await seed(s, s.recipient.id, [{ dedupeKey: 'sys', actorId: null }]);
    const page = await notificationsService.listNotifications({}, s.ctx);
    expect(page.notifications[0]?.actor).toBeNull();
  });
});

describe('notificationsService.getUnreadCount', () => {
  it('counts only the caller’s unread rows', async () => {
    const s = await makeScenario();
    const other = await createTestUser({ name: 'Other' });
    await seed(s, s.recipient.id, [
      { dedupeKey: 'u1' },
      { dedupeKey: 'u2' },
      { dedupeKey: 'r1', readAt: new Date() },
    ]);
    await seed(s, other.id, [{ dedupeKey: 'other-unread' }]);

    expect(await notificationsService.getUnreadCount(s.ctx)).toEqual({ unreadCount: 2 });
  });
});

describe('notificationsService.markRead', () => {
  it('marks one row read and returns the fresh unread count', async () => {
    const s = await makeScenario();
    await seed(s, s.recipient.id, [{ dedupeKey: 'a' }, { dedupeKey: 'b' }]);
    const target = (await notificationsService.listNotifications({}, s.ctx)).notifications[0]!;

    const result = await notificationsService.markRead(target.id, s.ctx);
    expect(result.notification.readAt).not.toBeNull();
    expect(result.unreadCount).toBe(1);
  });

  it('is idempotent — re-marking an already-read row is a no-op', async () => {
    const s = await makeScenario();
    await seed(s, s.recipient.id, [{ dedupeKey: 'a' }]);
    const target = (await notificationsService.listNotifications({}, s.ctx)).notifications[0]!;

    const first = await notificationsService.markRead(target.id, s.ctx);
    const firstReadAt = first.notification.readAt;
    const second = await notificationsService.markRead(target.id, s.ctx);

    expect(second.notification.readAt).toBe(firstReadAt); // unchanged
    expect(second.unreadCount).toBe(0);
  });

  it('reads as 404 for a non-existent id', async () => {
    const s = await makeScenario();
    await expect(notificationsService.markRead('does-not-exist', s.ctx)).rejects.toBeInstanceOf(
      NotificationNotFoundError,
    );
  });

  it('reads as 404 for another user’s notification (finding #44, no existence leak)', async () => {
    const s = await makeScenario();
    const other = await createTestUser({ name: 'Other' });
    await seed(s, other.id, [{ dedupeKey: 'theirs' }]);
    const theirRow = await db.notification.findFirstOrThrow({
      where: { recipientUserId: other.id },
    });

    await expect(notificationsService.markRead(theirRow.id, s.ctx)).rejects.toBeInstanceOf(
      NotificationNotFoundError,
    );
    // Untouched — the cross-user mark didn't leak through.
    const after = await db.notification.findUniqueOrThrow({ where: { id: theirRow.id } });
    expect(after.readAt).toBeNull();
  });

  it('reads as 404 for a notification in another workspace', async () => {
    const s = await makeScenario();
    await seed(s, s.recipient.id, [{ dedupeKey: 'mine' }]);
    const row = await db.notification.findFirstOrThrow({
      where: { recipientUserId: s.recipient.id },
    });
    const otherWorkspaceCtx: ServiceContext = {
      userId: s.recipient.id,
      workspaceId: 'some-other-workspace-id',
    };

    await expect(notificationsService.markRead(row.id, otherWorkspaceCtx)).rejects.toBeInstanceOf(
      NotificationNotFoundError,
    );
  });
});

describe('notificationsService.markAllRead', () => {
  it('clears all of the caller’s unread rows in one bulk op, returning zero', async () => {
    const s = await makeScenario();
    await seed(s, s.recipient.id, [
      { dedupeKey: 'a' },
      { dedupeKey: 'b' },
      { dedupeKey: 'c', readAt: new Date() },
    ]);

    const result = await notificationsService.markAllRead(s.ctx);
    expect(result.unreadCount).toBe(0);
    expect(await notificationsService.getUnreadCount(s.ctx)).toEqual({ unreadCount: 0 });
  });

  it('leaves other recipients’ unread rows untouched', async () => {
    const s = await makeScenario();
    const other = await createTestUser({ name: 'Other' });
    await seed(s, s.recipient.id, [{ dedupeKey: 'mine' }]);
    await seed(s, other.id, [{ dedupeKey: 'theirs' }]);

    await notificationsService.markAllRead(s.ctx);

    const otherCtx: ServiceContext = { userId: other.id, workspaceId: s.fx.workspaceId };
    expect(await notificationsService.getUnreadCount(otherCtx)).toEqual({ unreadCount: 1 });
  });
});

describe('toNotificationDto (mapper)', () => {
  // Direct mapper unit tests — the actor-resolution branches a real FK can't
  // produce (the `actor` relation is SetNull, so a row never holds a dangling
  // actorId), plus the data/readAt shaping. Pure-function, no DB.
  const baseRow: Notification = {
    id: 'notif-1',
    workspaceId: 'ws-1',
    recipientUserId: 'user-1',
    type: 'mentioned',
    category: 'direct',
    workItemId: 'wi-1',
    actorId: 'actor-1',
    data: { issueKey: 'PROD-42', title: 'A task' },
    dedupeKey: 'mention:c1',
    readAt: null,
    createdAt: new Date('2026-06-13T00:00:00.000Z'),
  };
  const actor: User = {
    id: 'actor-1',
    name: 'Zhu Yue',
    image: 'https://example.com/a.png',
  } as User;

  it('resolves the actor from the batched read', () => {
    const dto = toNotificationDto(baseRow, new Map([[actor.id, actor]]));
    expect(dto.actor).toEqual({
      id: 'actor-1',
      name: 'Zhu Yue',
      image: 'https://example.com/a.png',
    });
    expect(dto.data).toEqual({ issueKey: 'PROD-42', title: 'A task' });
    expect(dto.readAt).toBeNull();
    expect(dto.createdAt).toBe('2026-06-13T00:00:00.000Z');
  });

  it('renders null actor when actorId is null (system notification)', () => {
    const dto = toNotificationDto({ ...baseRow, actorId: null }, new Map());
    expect(dto.actor).toBeNull();
  });

  it('renders null actor when the actor is absent from the batch (deleted)', () => {
    const dto = toNotificationDto(baseRow, new Map()); // actorId set, not in map
    expect(dto.actor).toBeNull();
  });

  it('surfaces an absent data payload as the empty object and serialises readAt', () => {
    const dto = toNotificationDto(
      { ...baseRow, data: {}, readAt: new Date('2026-06-13T01:00:00.000Z') },
      new Map(),
    );
    expect(dto.data).toEqual({});
    expect(dto.readAt).toBe('2026-06-13T01:00:00.000Z');
  });
});
