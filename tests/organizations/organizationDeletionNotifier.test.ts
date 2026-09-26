import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminDb } from '../helpers/adminDb';

// The organization-deletion EMAILS (Story MOTIR-6306 · MOTIR-6395). Real Postgres
// for the request, the roster and the notice ledger — the exactly-once promise is
// a unique index, so a mocked repository would assert nothing. One seam is
// stubbed, the conventional one: `sendEvent`, the durable email queue, so the test
// can see what was enqueued and force it to fail.
const sendEventImpl = vi.hoisted(() => ({
  current: vi.fn(async (_name: string, _data: Record<string, unknown>) => undefined),
}));
vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: (name: string, data: Record<string, unknown>) => sendEventImpl.current(name, data),
}));

const { db } = await import('@/lib/db');
const { truncateAuthTables } = await import('../helpers/db');
const { organizationDeletionNotifier } =
  await import('@/lib/services/organizationDeletionNotifier');
const { organizationDeletionScheduledEmail } =
  await import('@/lib/emailTemplates/organizationDeletionScheduled');
const { organizationDeletionCancelledEmail } =
  await import('@/lib/emailTemplates/organizationDeletionCancelled');
const { organizationDeletionReminderEmail } =
  await import('@/lib/emailTemplates/organizationDeletionReminder');
const { organizationErasedEmail } = await import('@/lib/emailTemplates/organizationErased');
const { EMAIL_TEMPLATE_CLASS } = await import('@/lib/services/emailService');

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-20T09:00:00.000Z');

type Sent = { to: string; template: string; idempotencyKey: string; data: Record<string, unknown> };

function sent(): Sent[] {
  return sendEventImpl.current.mock.calls
    .filter(([name]) => name === 'email.send')
    .map(([, data]) => data as unknown as Sent);
}

async function makeUser(email: string) {
  return adminDb.user.create({ data: { email, name: email.split('@')[0]!, emailVerified: true } });
}

/** An org with an Owner, an Admin and a Member, and one `scheduled` request. */
async function makeClosingOrg(
  slug: string,
  dueAt: Date,
  status: 'scheduled' | 'cancelled' = 'scheduled',
) {
  const organization = await adminDb.organization.create({ data: { name: `Org ${slug}`, slug } });
  const owner = await makeUser(`owner-${slug}@example.com`);
  const admin = await makeUser(`admin-${slug}@example.com`);
  const member = await makeUser(`member-${slug}@example.com`);
  for (const [user, role] of [
    [owner, 'owner'],
    [admin, 'admin'],
    [member, 'member'],
  ] as const) {
    await adminDb.organizationMembership.create({
      data: { organizationId: organization.id, userId: user.id, role },
    });
  }
  const request = await adminDb.organizationDeletionRequest.create({
    data: {
      organizationId: organization.id,
      requestedByUserId: owner.id,
      requestedAt: new Date(dueAt.getTime() - 30 * DAY_MS),
      erasureDueAt: dueAt,
      status,
      ...(status === 'cancelled' ? { cancelledAt: NOW, cancelledByUserId: admin.id } : {}),
    },
  });
  return { organization, owner, admin, member, request };
}

beforeEach(async () => {
  await truncateAuthTables();
  sendEventImpl.current = vi.fn(async () => undefined);
});

afterAll(async () => {
  await db.$disconnect();
});

describe('the four templates', () => {
  it('are all essential — a deletion notice is never budgeted away', () => {
    expect(EMAIL_TEMPLATE_CLASS['organization-deletion-scheduled']).toBe('essential');
    expect(EMAIL_TEMPLATE_CLASS['organization-deletion-cancelled']).toBe('essential');
    expect(EMAIL_TEMPLATE_CLASS['organization-deletion-reminder']).toBe('essential');
    expect(EMAIL_TEMPLATE_CLASS['organization-erased']).toBe('essential');
  });

  it('scheduled: names the date and the links, and speaks to the Owner as the actor', async () => {
    const base = {
      recipientName: 'Ada',
      organizationName: 'Acme',
      scheduledByName: 'Grace',
      dueDate: 'Oct 26, 2026',
      settingsUrl: 'https://motir.test/settings/organization',
      exportUrl: 'https://motir.test/settings/account/data',
    };
    const member = await organizationDeletionScheduledEmail({ ...base, audience: 'member' });
    expect(member.subject).toBe('Acme is scheduled for deletion on Oct 26, 2026');
    expect(member.text).toContain('Grace scheduled Acme for deletion');
    expect(member.text).toContain('https://motir.test/settings/account/data');
    const owner = await organizationDeletionScheduledEmail({ ...base, audience: 'owner' });
    expect(owner.text).toContain('You scheduled Acme for deletion');
    expect(owner.text).toContain('https://motir.test/settings/organization');
    expect(owner.html).toContain('Acme');
  });

  it('cancelled, reminder and erased render their copy', async () => {
    const cancelled = await organizationDeletionCancelledEmail({
      recipientName: 'Ada',
      organizationName: 'Acme',
      cancelledByName: 'Grace',
      appUrl: 'https://motir.test',
    });
    expect(cancelled.subject).toBe('The deletion of Acme was cancelled');
    expect(cancelled.text).toContain('Grace cancelled the deletion of Acme.');

    const reminder = await organizationDeletionReminderEmail({
      audience: 'admin',
      recipientName: 'Ada',
      organizationName: 'Acme',
      ownerName: 'Grace',
      dueDate: 'Oct 26, 2026',
      daysLeft: 1,
      settingsUrl: 'https://motir.test/settings/organization',
    });
    expect(reminder.subject).toBe('Acme will be deleted in 1 day');
    expect(reminder.text).toContain('Only Grace');

    const erased = await organizationErasedEmail({
      recipientName: 'Ada',
      organizationName: 'Acme',
      retentionUntilYear: 2033,
    });
    expect(erased.subject).toBe('Acme has been deleted');
    expect(erased.text).toContain('2033');
  });

  it('renders the Chinese copy for a zh recipient', async () => {
    const zh = await organizationErasedEmail({
      recipientName: 'Ada',
      organizationName: 'Acme',
      retentionUntilYear: 2033,
      locale: 'zh',
    });
    expect(zh.subject).not.toBe('Acme has been deleted');
    expect(zh.subject).toContain('Acme');
  });
});

describe('notifyScheduled', () => {
  it('mails every member once, the Owner as the actor, with per-recipient keys', async () => {
    const { request, owner, admin, member } = await makeClosingOrg(
      'a',
      new Date(NOW.getTime() + 30 * DAY_MS),
    );

    await organizationDeletionNotifier.notifyScheduled(request.id);

    const mails = sent();
    expect(mails.map((m) => m.to).sort()).toEqual([admin.email, member.email, owner.email].sort());
    expect(new Set(mails.map((m) => m.idempotencyKey)).size).toBe(3);
    expect(mails.every((m) => m.template === 'organization-deletion-scheduled')).toBe(true);
    const toOwner = mails.find((m) => m.to === owner.email)!;
    expect(toOwner.data.audience).toBe('owner');
    expect(mails.find((m) => m.to === member.email)!.data).toMatchObject({
      audience: 'member',
      organizationName: 'Org a',
      scheduledByName: owner.name,
    });
    expect(String(toOwner.data.exportUrl)).toMatch(/\/settings\/account\/data$/);
  });

  it('is exactly once: a second call sends nothing', async () => {
    const { request } = await makeClosingOrg('b', new Date(NOW.getTime() + 30 * DAY_MS));
    await organizationDeletionNotifier.notifyScheduled(request.id);
    await organizationDeletionNotifier.notifyScheduled(request.id);
    expect(sent()).toHaveLength(3);
    expect(
      await adminDb.organizationDeletionNotice.count({ where: { requestId: request.id } }),
    ).toBe(1);
  });

  it('never throws when the queue fails — the deletion stands', async () => {
    const { request } = await makeClosingOrg('c', new Date(NOW.getTime() + 30 * DAY_MS));
    sendEventImpl.current = vi.fn(async () => {
      throw new Error('queue down');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(organizationDeletionNotifier.notifyScheduled(request.id)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('does nothing for an unknown request', async () => {
    await organizationDeletionNotifier.notifyScheduled('no-such-request');
    expect(sent()).toHaveLength(0);
  });
});

describe('notifyCancelled', () => {
  it('mails every member, naming who cancelled', async () => {
    const { request, admin } = await makeClosingOrg(
      'd',
      new Date(NOW.getTime() + 20 * DAY_MS),
      'cancelled',
    );
    await organizationDeletionNotifier.notifyCancelled(request.id);
    await organizationDeletionNotifier.notifyCancelled(request.id);
    const mails = sent();
    expect(mails).toHaveLength(3);
    expect(mails.every((m) => m.template === 'organization-deletion-cancelled')).toBe(true);
    expect(mails[0]!.data.cancelledByName).toBe(admin.name);
  });
});

describe('notifyErased', () => {
  it('mails the Owner and Admins it is GIVEN — never a Member — with the retention year', async () => {
    const { request, owner, admin, member } = await makeClosingOrg('e', NOW);
    const recipients = [
      { userId: owner.id, name: owner.name, email: owner.email, role: 'owner' as const },
      { userId: admin.id, name: admin.name, email: admin.email, role: 'admin' as const },
      { userId: member.id, name: member.name, email: member.email, role: 'member' as const },
    ];
    const erasedAt = new Date('2026-10-26T12:00:00.000Z');
    // The roster is gone by now: the sweep captured it before the tombstone.
    await adminDb.organizationMembership.deleteMany({
      where: { organizationId: request.organizationId },
    });

    const input = {
      requestId: request.id,
      organizationName: 'Acme (pre-scrub)',
      erasedAt,
      recipients,
    };
    await organizationDeletionNotifier.notifyErased(input);
    await organizationDeletionNotifier.notifyErased(input);

    const mails = sent();
    expect(mails.map((m) => m.to).sort()).toEqual([admin.email, owner.email].sort());
    expect(mails[0]!.data).toMatchObject({
      organizationName: 'Acme (pre-scrub)',
      retentionUntilYear: 2033,
    });
  });
});

describe('sendDueReminders', () => {
  it('sends the seven-day reminder to the Owner and Admins only, once', async () => {
    const { owner, admin } = await makeClosingOrg('f', new Date(NOW.getTime() + 6 * DAY_MS));

    expect(await organizationDeletionNotifier.sendDueReminders(NOW)).toEqual({ remindersSent: 1 });
    expect(await organizationDeletionNotifier.sendDueReminders(NOW)).toEqual({ remindersSent: 0 });

    const mails = sent();
    expect(mails.map((m) => m.to).sort()).toEqual([admin.email, owner.email].sort());
    expect(mails.every((m) => m.template === 'organization-deletion-reminder')).toBe(true);
    expect(mails.find((m) => m.to === owner.email)!.data).toMatchObject({
      audience: 'owner',
      daysLeft: 6,
    });
    expect(mails.find((m) => m.to === admin.email)!.data).toMatchObject({
      audience: 'admin',
      ownerName: owner.name,
    });
  });

  it('then sends the one-day reminder, and only the smallest threshold reached', async () => {
    const { request } = await makeClosingOrg('g', new Date(NOW.getTime() + 6 * DAY_MS));
    await organizationDeletionNotifier.sendDueReminders(NOW);
    const later = new Date(NOW.getTime() + 5.5 * DAY_MS);
    expect(await organizationDeletionNotifier.sendDueReminders(later)).toEqual({
      remindersSent: 1,
    });
    const notices = await adminDb.organizationDeletionNotice.findMany({
      where: { requestId: request.id },
      orderBy: { daysLeft: 'desc' },
    });
    expect(notices.map((n) => [n.kind, n.daysLeft])).toEqual([
      ['reminder', 7],
      ['reminder', 1],
    ]);

    // A request first seen with hours left gets the one-day reminder only.
    const late = await makeClosingOrg('h', new Date(NOW.getTime() + 12 * 60 * 60 * 1000));
    sendEventImpl.current.mockClear();
    await organizationDeletionNotifier.sendDueReminders(NOW);
    const lateNotices = await adminDb.organizationDeletionNotice.findMany({
      where: { requestId: late.request.id },
    });
    expect(lateNotices.map((n) => n.daysLeft)).toEqual([1]);
  });

  it('skips a request further than seven days out, a due one, and a cancelled one', async () => {
    await makeClosingOrg('i', new Date(NOW.getTime() + 10 * DAY_MS));
    await makeClosingOrg('j', new Date(NOW.getTime() - DAY_MS));
    await makeClosingOrg('k', new Date(NOW.getTime() + 3 * DAY_MS), 'cancelled');
    expect(await organizationDeletionNotifier.sendDueReminders(NOW)).toEqual({ remindersSent: 0 });
    expect(sent()).toHaveLength(0);
  });
});
