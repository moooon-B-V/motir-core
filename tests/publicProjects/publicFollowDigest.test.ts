import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { publicFollowDigestService } from '@/lib/services/publicFollowDigestService';
import { verifyUnsubscribeToken } from '@/lib/publicProjects/followTokens';
import {
  makeWorkItemFixture,
  createTestWorkItem,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story 8.9 · Subtask 8.9.7 — the weekly follower digest. Real Postgres; the
// one mock is the job dispatcher, because what this service is responsible for
// is the ENVELOPE it emits, not a provider accepting it.
//
// The two properties worth protecting from a future refactor are both about
// what is NOT sent:
//   * an empty week sends NOTHING — silence is information, and "0 items
//     shipped" is what trains people to filter you;
//   * the privacy exclusion is re-run AT SEND TIME, so an epic made private
//     after an item shipped does not appear in the next mail.

type Enqueued = {
  name: string;
  to?: string;
  template?: string;
  idempotencyKey?: string;
  data?: { entries?: Array<{ identifier: string }>; unsubscribeUrl?: string };
  followId?: string;
  occurrenceKey?: string;
};
const enqueued: Enqueued[] = [];

vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (name: string, payload: Record<string, unknown>) => {
    enqueued.push({ name, ...payload } as Enqueued);
  },
}));

beforeEach(async () => {
  enqueued.length = 0;
  vi.stubEnv('EMAIL_PROVIDER', 'resend');
  vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret-for-unsubscribe-tokens');
  await truncateAuthTables();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
  await adminDb.$disconnect();
});

const MONDAY = new Date('2026-08-24T09:00:00.000Z');

async function publicFixture(): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture({ name: 'Acme' });
  await adminDb.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'public' } });
  return fx;
}

async function ship(fx: WorkItemFixture, id: string, at: string) {
  await adminDb.workItemRevision.create({
    data: {
      workItemId: id,
      changedById: fx.ownerId,
      changedAt: new Date(at),
      changeKind: 'updated',
      diff: { status: { from: 'in_progress', to: 'done' } },
    },
  });
  await adminDb.workItem.update({ where: { id }, data: { status: 'done' } });
}

async function follower(fx: WorkItemFixture, over: Record<string, unknown> = {}) {
  return adminDb.publicFollow.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      email: 'reader@example.com',
      digestOptIn: true,
      confirmedAt: new Date('2026-08-01T00:00:00.000Z'),
      ...over,
    },
  });
}

const emails = () => enqueued.filter((e) => e.name === 'email.send');
const digests = () => enqueued.filter((e) => e.name === 'public-follow/digest');

describe('the tick', () => {
  it('enqueues one digest per due follower, keyed per follower per week', async () => {
    const fx = await publicFixture();
    const row = await follower(fx);

    const result = await publicFollowDigestService.enqueueDueDigests(MONDAY);
    expect(result.enqueued).toBe(1);
    expect(digests()[0]?.followId).toBe(row.id);
    expect(digests()[0]?.occurrenceKey).toBe(`${row.id}:2026-W35`);
  });

  it('skips a follower who already had a digest THIS week', async () => {
    const fx = await publicFixture();
    await follower(fx, { lastDigestAt: new Date('2026-08-24T09:00:00.000Z') });
    const result = await publicFollowDigestService.enqueueDueDigests(MONDAY);
    expect(result.enqueued).toBe(0);
  });

  it('skips an unconfirmed follower, and one who never opted in', async () => {
    const fx = await publicFixture();
    await follower(fx, { email: 'unconfirmed@example.com', confirmedAt: null });
    await follower(fx, { email: 'no-digest@example.com', digestOptIn: false });
    const result = await publicFollowDigestService.enqueueDueDigests(MONDAY);
    // Following is not subscribing, and an address that never confirmed is not
    // an audience — both are enforced by the audience READ, not by the mailer.
    expect(result.enqueued).toBe(0);
  });
});

describe('the delivery', () => {
  it('sends the window’s shipped items, with a working unsubscribe link', async () => {
    const fx = await publicFixture();
    const row = await follower(fx, { lastDigestAt: new Date('2026-08-17T09:00:00.000Z') });
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Shipped this week' });
    await ship(fx, item.id, '2026-08-20T10:00:00.000Z');

    const result = await publicFollowDigestService.deliverDigest({
      workspaceId: fx.workspaceId,
      followId: row.id,
      occurrenceKey: `${row.id}:2026-W35`,
      now: MONDAY,
    });

    expect(result).toEqual({ sent: true, itemCount: 1 });
    const mail = emails()[0];
    expect(mail?.to).toBe('reader@example.com');
    expect(mail?.template).toBe('follow-digest');
    // One mail per follower per week, at the runtime AND at the provider.
    expect(mail?.idempotencyKey).toBe(`${row.id}:2026-W35`);
    expect(mail?.data?.entries).toHaveLength(1);

    // The unsubscribe link resolves back to THIS follow — derived, so the same
    // link still works years later.
    const token = decodeURIComponent(
      /token=([^&]+)/.exec(mail?.data?.unsubscribeUrl ?? '')?.[1] ?? '',
    );
    expect(verifyUnsubscribeToken(token)).toBe(row.id);

    const after = await adminDb.publicFollow.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.lastDigestAt).toEqual(MONDAY);
  });

  it('sends NOTHING for a week with nothing shipped — and still moves the window', async () => {
    const fx = await publicFixture();
    const row = await follower(fx, { lastDigestAt: new Date('2026-08-17T09:00:00.000Z') });

    const result = await publicFollowDigestService.deliverDigest({
      workspaceId: fx.workspaceId,
      followId: row.id,
      occurrenceKey: `${row.id}:2026-W35`,
      now: MONDAY,
    });

    expect(result).toEqual({ sent: false, itemCount: 0 });
    expect(emails()).toHaveLength(0);
    // The window still advances, so next week does not re-scan this one.
    const after = await adminDb.publicFollow.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.lastDigestAt).toEqual(MONDAY);
  });

  it('excludes an item shipped BEFORE the follower’s window', async () => {
    const fx = await publicFixture();
    const row = await follower(fx, { lastDigestAt: new Date('2026-08-17T09:00:00.000Z') });
    const old = await createTestWorkItem(fx, { kind: 'task', title: 'Shipped last week' });
    await ship(fx, old.id, '2026-08-10T10:00:00.000Z');

    const result = await publicFollowDigestService.deliverDigest({
      workspaceId: fx.workspaceId,
      followId: row.id,
      occurrenceKey: `${row.id}:2026-W35`,
      now: MONDAY,
    });
    expect(result.sent).toBe(false);
  });

  it('⚠️ RE-RUNS THE PRIVACY EXCLUSION AT SEND TIME', async () => {
    const fx = await publicFixture();
    const row = await follower(fx, { lastDigestAt: new Date('2026-08-17T09:00:00.000Z') });
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'A programme' });
    const child = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'Was public when it shipped',
      parentId: epic.id,
    });
    const open = await createTestWorkItem(fx, { kind: 'task', title: 'Still public' });
    await ship(fx, child.id, '2026-08-20T10:00:00.000Z');
    await ship(fx, open.id, '2026-08-21T10:00:00.000Z');

    // The epic becomes private AFTER both items shipped. A digest composed from
    // a set captured at tick time would still carry the child; this one must not.
    await adminDb.workItem.update({
      where: { id: epic.id },
      data: { publicChildrenHidden: true },
    });

    const result = await publicFollowDigestService.deliverDigest({
      workspaceId: fx.workspaceId,
      followId: row.id,
      occurrenceKey: `${row.id}:2026-W35`,
      now: MONDAY,
    });

    expect(result.itemCount).toBe(1);
    expect(emails()[0]?.data?.entries?.map((e) => e.identifier)).toEqual([open.identifier]);
  });

  it('is a no-op when the follow was deleted between the tick and the send', async () => {
    const fx = await publicFixture();
    const row = await follower(fx);
    await adminDb.publicFollow.delete({ where: { id: row.id } });

    // Not an error: the person unsubscribed, which is exactly what should stop
    // this mail.
    const result = await publicFollowDigestService.deliverDigest({
      workspaceId: fx.workspaceId,
      followId: row.id,
      occurrenceKey: 'x',
      now: MONDAY,
    });
    expect(result).toEqual({ sent: false, itemCount: 0 });
    expect(emails()).toHaveLength(0);
  });
});

describe('the unconfirmed sweep', () => {
  it('deletes a stale unconfirmed follow and keeps a fresh one', async () => {
    const fx = await publicFixture();
    await follower(fx, {
      email: 'stale@example.com',
      confirmedAt: null,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    await follower(fx, { email: 'fresh@example.com', confirmedAt: null });
    await follower(fx, { email: 'confirmed@example.com' });

    const { deleted } = await publicFollowDigestService.sweepUnconfirmed(MONDAY);
    expect(deleted).toBe(1);
    const left = await adminDb.publicFollow.findMany({ orderBy: { email: 'asc' } });
    expect(left.map((f) => f.email)).toEqual(['confirmed@example.com', 'fresh@example.com']);
  });
});
