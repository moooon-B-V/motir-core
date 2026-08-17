import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Notification, Prisma, User, WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { notificationRepository } from '@/lib/repositories/notificationRepository';
import { createTestUser, createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import type { WorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Repository-layer tests for the in-app notification data-access leaf (Story
// 5.7 · Subtask 5.7.2): notificationRepository, plus the schema-level
// guarantees the migration carries — the delete cascades (recipient / work item
// → notifications), the actor SET NULL, the (dedupe_key, recipient_user_id)
// idempotency unique, and the unread-count partial-index semantics. Real
// Postgres (no mocks), per CLAUDE.md. They run as the dev/CI superuser via the
// `db` singleton (RLS is inert under BYPASSRLS — the policies are exercised
// separately under the motir_app role, the multi-tenant-rls suite's pattern);
// what's proven here is the repository contract and the migration-built
// constraints. Writes run inside a real `db.$transaction` to exercise the
// required-`tx` path.
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
// so (`42501`); a refused read just returns `null` / `[]` / `0`, so seven assertions
// here went red while `countUnreadByRecipient` → 0 and `findById('does-not-exist')`
// → null passed for the wrong reason. `readAsOwner` routes them through the SAME
// owner client the writes use, keeping RLS inert as the header says.

beforeEach(async () => {
  // truncateAuthTables truncates `workspace` + `user` RESTART IDENTITY CASCADE,
  // which cascades workspace → notification and user → notification (both FK
  // chains have onDelete actions), so no dedicated truncate is needed.
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/**
 * Run a repository READ through the OWNER client, exactly as this file's writes run.
 * The repository method under test is still what is exercised — only the connection
 * changes, so RLS stays inert (see the header) and an empty answer is the query's own
 * recipient/category scoping rather than a policy.
 */
function readAsOwner<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return adminDb.$transaction(fn);
}

interface NotificationFixture {
  fx: WorkItemFixture;
  issue: WorkItem;
  recipient: User;
  actor: User;
}

async function makeNotificationFixture(): Promise<NotificationFixture> {
  const fx = await makeWorkItemFixture();
  const issue = await createTestWorkItem(fx, { kind: 'task', title: 'Notified task' });
  // Recipient + actor are users DISTINCT from the workspace owner: the owner is
  // the issue's reporter (a Restrict FK), so it can't be deleted while the
  // issue exists — and the recipient-cascade test below needs to delete the
  // recipient. The notification FKs only require the users to exist (RLS is
  // inert under the superuser these repo tests run as).
  const recipient = await createTestUser({ name: 'Recipient' });
  const actor = await createTestUser({ name: 'Actor' });
  return { fx, issue, recipient, actor };
}

/** Insert notifications through the repository's required-`tx` write path. */
async function addNotifications(
  c: NotificationFixture,
  rows: Array<{
    dedupeKey: string;
    type?: string;
    category?: 'direct' | 'watching';
    readAt?: Date | null;
    workItemId?: string | null;
    actorId?: string | null;
  }>,
): Promise<number> {
  return adminDb.$transaction(async (tx) =>
    notificationRepository.createMany(
      rows.map((r) => ({
        workspaceId: c.fx.workspaceId,
        recipientUserId: c.recipient.id,
        type: r.type ?? 'mentioned',
        category: r.category ?? 'direct',
        workItemId: r.workItemId === undefined ? c.issue.id : r.workItemId,
        actorId: r.actorId === undefined ? c.actor.id : r.actorId,
        data: { issueKey: c.issue.identifier, title: c.issue.title },
        dedupeKey: r.dedupeKey,
        readAt: r.readAt ?? null,
      })),
      tx,
    ),
  );
}

async function allRows(recipientUserId: string): Promise<Notification[]> {
  return adminDb.notification.findMany({
    where: { recipientUserId },
    orderBy: { dedupeKey: 'asc' },
  });
}

describe('notificationRepository.createMany', () => {
  it('inserts one row per recipient with the denormalized payload', async () => {
    const c = await makeNotificationFixture();
    const count = await addNotifications(c, [
      { dedupeKey: 'comment:c1' },
      { dedupeKey: 'comment:c2', category: 'watching', type: 'transitioned' },
    ]);
    expect(count).toBe(2);

    const rows = await allRows(c.recipient.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.workspaceId).toBe(c.fx.workspaceId);
    expect(rows[0]!.recipientUserId).toBe(c.recipient.id);
    expect(rows[0]!.actorId).toBe(c.actor.id);
    expect(rows[0]!.workItemId).toBe(c.issue.id);
    expect(rows[0]!.readAt).toBeNull();
    expect(rows[0]!.data).toEqual({ issueKey: c.issue.identifier, title: c.issue.title });
    expect(rows[1]!.category).toBe('watching');
    expect(rows[1]!.type).toBe('transitioned');
  });

  it('returns 0 and writes nothing for an empty batch (the empty-input guard)', async () => {
    const c = await makeNotificationFixture();
    const count = await adminDb.$transaction((tx) => notificationRepository.createMany([], tx));
    expect(count).toBe(0);
    expect(await allRows(c.recipient.id)).toHaveLength(0);
  });

  it('is idempotent on (dedupeKey, recipientUserId): a replay no-ops the duplicate', async () => {
    const c = await makeNotificationFixture();
    expect(await addNotifications(c, [{ dedupeKey: 'comment:c1' }])).toBe(1);
    // Replaying the SAME source event for the SAME recipient writes nothing
    // (skipDuplicates against the unique) — the 5.7.3 retry-safety contract.
    expect(await addNotifications(c, [{ dedupeKey: 'comment:c1' }])).toBe(0);
    expect(await allRows(c.recipient.id)).toHaveLength(1);
  });

  it('allows the same dedupeKey for a DIFFERENT recipient (unique is composite)', async () => {
    const c = await makeNotificationFixture();
    const other = await createTestUser({ name: 'Other recipient' });
    await addNotifications(c, [{ dedupeKey: 'comment:c1' }]);
    const count = await adminDb.$transaction((tx) =>
      notificationRepository.createMany(
        [
          {
            workspaceId: c.fx.workspaceId,
            recipientUserId: other.id,
            type: 'mentioned',
            category: 'direct',
            workItemId: c.issue.id,
            actorId: c.actor.id,
            data: {},
            dedupeKey: 'comment:c1',
          },
        ],
        tx,
      ),
    );
    expect(count).toBe(1);
  });
});

describe('notificationRepository — schema delete semantics', () => {
  it('cascades when the recipient user is deleted', async () => {
    const c = await makeNotificationFixture();
    await addNotifications(c, [{ dedupeKey: 'comment:c1' }, { dedupeKey: 'comment:c2' }]);
    await adminDb.$transaction((tx) => tx.user.delete({ where: { id: c.recipient.id } }));
    const notificationCount = await adminDb.notification.count({
      where: { recipientUserId: c.recipient.id },
    });
    expect(notificationCount).toBe(0);
  });

  it('cascades when the work item is deleted', async () => {
    const c = await makeNotificationFixture();
    await addNotifications(c, [{ dedupeKey: 'comment:c1' }]);
    await adminDb.$transaction((tx) => tx.workItem.delete({ where: { id: c.issue.id } }));
    expect(await allRows(c.recipient.id)).toHaveLength(0);
  });

  it('sets actorId NULL when the actor user is deleted (row survives)', async () => {
    const c = await makeNotificationFixture();
    await addNotifications(c, [{ dedupeKey: 'comment:c1' }]);
    await adminDb.$transaction((tx) => tx.user.delete({ where: { id: c.actor.id } }));
    const rows = await allRows(c.recipient.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorId).toBeNull();
  });

  it('keeps a row whose workItemId is null (non-item notifications stay modellable)', async () => {
    const c = await makeNotificationFixture();
    await addNotifications(c, [{ dedupeKey: 'sys:1', workItemId: null }]);
    const rows = await allRows(c.recipient.id);
    expect(rows[0]!.workItemId).toBeNull();
  });
});

describe('notificationRepository.countUnreadByRecipient', () => {
  it('counts only unread rows and ignores read ones', async () => {
    const c = await makeNotificationFixture();
    await addNotifications(c, [
      { dedupeKey: 'comment:c1' },
      { dedupeKey: 'comment:c2' },
      { dedupeKey: 'comment:c3', readAt: new Date() },
    ]);
    expect(
      await readAsOwner((tx) =>
        notificationRepository.countUnreadByRecipient(c.recipient.id, {}, tx),
      ),
    ).toBe(2);
  });

  it('returns 0 for a recipient with no notifications', async () => {
    const c = await makeNotificationFixture();
    expect(
      await readAsOwner((tx) =>
        notificationRepository.countUnreadByRecipient(c.recipient.id, {}, tx),
      ),
    ).toBe(0);
  });
});

describe('notificationRepository.listByRecipient', () => {
  it('pages newest-first, walks via cursor, and never repeats a row', async () => {
    const c = await makeNotificationFixture();
    // Insert sequentially so created_at strictly increases (newest = comment:c5).
    for (let i = 1; i <= 5; i++) {
      await addNotifications(c, [{ dedupeKey: `comment:c${i}` }]);
    }
    const page1 = await readAsOwner((tx) =>
      notificationRepository.listByRecipient(c.recipient.id, { take: 2 }, tx),
    );
    expect(page1.map((r) => r.dedupeKey)).toEqual(['comment:c5', 'comment:c4']);

    const page2 = await readAsOwner((tx) =>
      notificationRepository.listByRecipient(
        c.recipient.id,
        { take: 2, cursor: page1[page1.length - 1]!.id },
        tx,
      ),
    );
    expect(page2.map((r) => r.dedupeKey)).toEqual(['comment:c3', 'comment:c2']);

    const page3 = await readAsOwner((tx) =>
      notificationRepository.listByRecipient(
        c.recipient.id,
        { take: 2, cursor: page2[page2.length - 1]!.id },
        tx,
      ),
    );
    expect(page3.map((r) => r.dedupeKey)).toEqual(['comment:c1']);
  });

  it('filters to one drawer tab (category)', async () => {
    const c = await makeNotificationFixture();
    await addNotifications(c, [
      { dedupeKey: 'comment:c1', category: 'direct' },
      { dedupeKey: 'tr:1', category: 'watching', type: 'transitioned' },
    ]);
    const direct = await readAsOwner((tx) =>
      notificationRepository.listByRecipient(c.recipient.id, { category: 'direct' }, tx),
    );
    expect(direct.map((r) => r.dedupeKey)).toEqual(['comment:c1']);

    const watching = await readAsOwner((tx) =>
      notificationRepository.listByRecipient(c.recipient.id, { category: 'watching' }, tx),
    );
    expect(watching.map((r) => r.dedupeKey)).toEqual(['tr:1']);
  });

  it('walks oldest-first when order is asc', async () => {
    const c = await makeNotificationFixture();
    for (let i = 1; i <= 3; i++) await addNotifications(c, [{ dedupeKey: `comment:c${i}` }]);
    const rows = await readAsOwner((tx) =>
      notificationRepository.listByRecipient(c.recipient.id, { order: 'asc' }, tx),
    );
    expect(rows.map((r) => r.dedupeKey)).toEqual(['comment:c1', 'comment:c2', 'comment:c3']);
  });
});

describe('notificationRepository.findById', () => {
  it('returns the row, and null for an unknown id', async () => {
    const c = await makeNotificationFixture();
    await addNotifications(c, [{ dedupeKey: 'comment:c1' }]);
    const [row] = await allRows(c.recipient.id);
    expect((await readAsOwner((tx) => notificationRepository.findById(row!.id, tx)))?.id).toBe(
      row!.id,
    );
    expect(
      await readAsOwner((tx) => notificationRepository.findById('does-not-exist', tx)),
    ).toBeNull();
  });
});

describe('notificationRepository.markRead / markAllReadByRecipient', () => {
  it('markRead stamps read_at on exactly one row', async () => {
    const c = await makeNotificationFixture();
    await addNotifications(c, [{ dedupeKey: 'comment:c1' }, { dedupeKey: 'comment:c2' }]);
    const [a, b] = await allRows(c.recipient.id);

    const readAt = new Date();
    const updated = await adminDb.$transaction((tx) =>
      notificationRepository.markRead(a!.id, readAt, tx),
    );
    expect(updated.readAt).toEqual(readAt);
    expect(
      (await readAsOwner((tx) => notificationRepository.findById(b!.id, tx)))?.readAt,
    ).toBeNull();
    expect(
      await readAsOwner((tx) =>
        notificationRepository.countUnreadByRecipient(c.recipient.id, {}, tx),
      ),
    ).toBe(1);
  });

  it('markAllReadByRecipient flips only the unread rows and returns the count', async () => {
    const c = await makeNotificationFixture();
    const already = new Date('2026-01-01T00:00:00.000Z');
    await addNotifications(c, [
      { dedupeKey: 'comment:c1' },
      { dedupeKey: 'comment:c2' },
      { dedupeKey: 'comment:c3', readAt: already },
    ]);

    const flipped = await adminDb.$transaction((tx) =>
      notificationRepository.markAllReadByRecipient(c.recipient.id, new Date(), tx),
    );
    // Only the two UNREAD rows were touched — not the already-read one.
    expect(flipped).toBe(2);
    expect(
      await readAsOwner((tx) =>
        notificationRepository.countUnreadByRecipient(c.recipient.id, {}, tx),
      ),
    ).toBe(0);

    // The already-read row keeps its ORIGINAL timestamp (not re-stamped).
    const rows = await allRows(c.recipient.id);
    const c3 = rows.find((r) => r.dedupeKey === 'comment:c3');
    expect(c3?.readAt).toEqual(already);
  });

  it('markAllReadByRecipient returns 0 when nothing is unread', async () => {
    const c = await makeNotificationFixture();
    await addNotifications(c, [{ dedupeKey: 'comment:c1', readAt: new Date() }]);
    const flipped = await adminDb.$transaction((tx) =>
      notificationRepository.markAllReadByRecipient(c.recipient.id, new Date(), tx),
    );
    expect(flipped).toBe(0);
  });

  it("scopes mark-all to the recipient — another user's rows are untouched", async () => {
    const c = await makeNotificationFixture();
    await addNotifications(c, [{ dedupeKey: 'comment:c1' }]);

    // A second recipient in the same workspace with their own unread row.
    const other = await createTestUser({ name: 'Bo' });
    await adminDb.$transaction((tx) =>
      notificationRepository.createMany(
        [
          {
            workspaceId: c.fx.workspaceId,
            recipientUserId: other.id,
            type: 'mentioned',
            category: 'direct',
            workItemId: c.issue.id,
            actorId: c.actor.id,
            data: {},
            dedupeKey: 'comment:c1',
          },
        ],
        tx,
      ),
    );

    await adminDb.$transaction((tx) =>
      notificationRepository.markAllReadByRecipient(c.recipient.id, new Date(), tx),
    );
    // The other recipient's notification is still unread.
    expect(
      await readAsOwner((tx) => notificationRepository.countUnreadByRecipient(other.id, {}, tx)),
    ).toBe(1);
  });
});
