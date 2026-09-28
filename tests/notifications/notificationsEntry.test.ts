import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { dashboardsService } from '@/lib/services/dashboardsService';
import { notificationsService } from '@/lib/services/notificationsService';
import { projectsService } from '@/lib/services/projectsService';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { DashboardWidgetSourceNotFoundError } from '@/lib/dashboards/errors';
import { createTestWorkItem, makeWorkItemFixture } from '../fixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { projectAccessData } from '@/tests/helpers/projectAccess';

// Reads across projects honour ENTRY at read time (Story MOTIR-6169 · MOTIR-6549):
// the notification feed and its counts drop rows about a project the reader can
// no longer enter — filtered in SQL, so pages stay full — and a dashboard widget
// cannot be pointed at a project its author cannot enter.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

async function setup() {
  const fx = await makeWorkItemFixture({ name: `NE ${seq}`, identifier: `NEO${seq++}` });
  // A second project, Members only, in the same workspace.
  const created = await projectsService.createProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ownerId,
    name: 'Secret',
    identifier: `NES${seq++}`,
  });
  const secret = await adminDb.project.update({
    where: { id: created.id },
    data: projectAccessData('members'),
  });
  const reader = await usersService.createUser({
    email: `ne-reader-${seq++}@example.com`,
    password: 'hunter2hunter2',
    name: 'Reader',
  });
  await workspacesService.addMember({ userId: reader.id, workspaceId: fx.workspaceId });
  const openItem = await createTestWorkItem(fx, { kind: 'task', title: 'Open item' });
  const secretItem = await createTestWorkItem(
    { ...fx, projectId: secret.id, projectIdentifier: secret.identifier },
    { kind: 'task', title: 'Secret item' },
  );
  return { fx, secret, reader, openItem, secretItem };
}

let noteSeq = 0;
async function notify(
  s: { fx: { workspaceId: string } },
  recipientUserId: string,
  workItemId: string | null,
  createdAt = new Date(Date.now() - 1000 * (1000 - noteSeq)),
) {
  const n = noteSeq++;
  return adminDb.notification.create({
    data: {
      workspaceId: s.fx.workspaceId,
      recipientUserId,
      type: 'work_item.assigned',
      category: 'direct',
      workItemId,
      data: {},
      dedupeKey: `ne-${n}`,
      createdAt,
    },
  });
}

describe('the notification feed honours entry at read time', () => {
  it('drops a Members-only project’s rows from the list and the unread count, and restores them when the reader is added', async () => {
    const s = await setup();
    const ctx = { userId: s.reader.id, workspaceId: s.fx.workspaceId };
    const onOpen = await notify(s, s.reader.id, s.openItem.id);
    const onSecret = await notify(s, s.reader.id, s.secretItem.id);
    const workspaceLevel = await notify(s, s.reader.id, null);

    const page = await notificationsService.listNotifications({}, ctx);
    expect(page.notifications.map((n) => n.id).sort()).toEqual(
      [onOpen.id, workspaceLevel.id].sort(),
    );
    expect(page.totalCount).toBe(2);
    expect(page.unreadCount).toBe(2);
    expect((await notificationsService.getUnreadCount(ctx)).unreadCount).toBe(2);

    await adminDb.projectMembership.create({
      data: {
        workspaceId: s.fx.workspaceId,
        projectId: s.secret.id,
        userId: s.reader.id,
        role: 'member',
      },
    });
    const after = await notificationsService.listNotifications({}, ctx);
    expect(after.notifications.map((n) => n.id)).toContain(onSecret.id);
    expect(after.totalCount).toBe(3);
    expect((await notificationsService.getUnreadCount(ctx)).unreadCount).toBe(3);
  });

  it('keeps a workspace-level notification (no work item) whatever the reader’s project access', async () => {
    const s = await setup();
    const ctx = { userId: s.reader.id, workspaceId: s.fx.workspaceId };
    const workspaceLevel = await notify(s, s.reader.id, null);
    const page = await notificationsService.listNotifications({}, ctx);
    expect(page.notifications.map((n) => n.id)).toEqual([workspaceLevel.id]);
  });

  it('keeps pages full across a filtered gap: 30 rows, 10 hidden → one page of the 20 visible, then no cursor', async () => {
    const s = await setup();
    const ctx = { userId: s.reader.id, workspaceId: s.fx.workspaceId };
    const visible: string[] = [];
    for (let i = 0; i < 30; i++) {
      // Interleave: every third row sits in the hidden project.
      const hidden = i % 3 === 0;
      const row = await notify(s, s.reader.id, hidden ? s.secretItem.id : s.openItem.id);
      if (!hidden) visible.push(row.id);
    }
    const page = await notificationsService.listNotifications({}, ctx);
    expect(page.notifications).toHaveLength(20);
    expect(page.notifications.map((n) => n.id).sort()).toEqual([...visible].sort());
    expect(page.nextCursor).toBeNull();
    expect(page.totalCount).toBe(20);
  });
});

describe('a dashboard widget honours entry at configure time', () => {
  it('refuses a project source the author cannot enter with the not-found error a missing project gets', async () => {
    const s = await setup();
    const ctx = { userId: s.reader.id, workspaceId: s.fx.workspaceId };
    const dash = await dashboardsService.create({ name: 'Mine' }, ctx);
    const refused = await dashboardsService
      .addWidget(
        dash.id,
        { type: 'distribution', projectId: s.secret.id, config: { statisticType: 'status' } },
        ctx,
      )
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DashboardWidgetSourceNotFoundError);
    const missing = await dashboardsService
      .addWidget(
        dash.id,
        { type: 'distribution', projectId: 'nope', config: { statisticType: 'status' } },
        ctx,
      )
      .catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(DashboardWidgetSourceNotFoundError);
    expect((refused as Error).message.replace(s.secret.id, 'X')).toBe(
      (missing as Error).message.replace('nope', 'X'),
    );
    // …while the project they can enter is accepted.
    await expect(
      dashboardsService.addWidget(
        dash.id,
        { type: 'distribution', projectId: s.fx.projectId, config: { statisticType: 'status' } },
        ctx,
      ),
    ).resolves.toBeDefined();
  });
});
