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
  data?: {
    entries?: Array<{ identifier: string }>;
    unsubscribeUrl?: string;
    changelogUrl?: string;
  };
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

  // ── MOTIR-3881 — the two origins, asserted on the RENDERED mail ───────────
  //
  // This one email carries links to BOTH hosts, and it is the only place in the
  // product that does. `changelogUrl` points a reader at the PUBLIC SITE;
  // `unsubscribeUrl` points at the APPLICATION, because unsubscribing is an act
  // against this service and its token must keep resolving "if somebody finds
  // this mail in two years" (`followTokens.ts`).
  //
  // While the two origins are equal — which is every environment today, since
  // MOTIR_PUBLIC_SITE_URL is unset until motir.co renders these pages — the
  // distinction is invisible and nothing would catch it being wrong. So the
  // assertion configures them DIFFERENTLY, which is the only state in which the
  // split can be observed at all.
  //
  // ⚠️ A link in an inbox is the one URL this application cannot take back: a
  // wrong canonical is a bad day for a crawler, a wrong link in delivered mail
  // is wrong for as long as the mail exists, read by a person who will not
  // retry.
  it('points the changelog link at the PUBLIC site and the unsubscribe link at the APPLICATION', async () => {
    vi.stubEnv('MOTIR_BASE_URL', 'https://app.motir.co');
    vi.stubEnv('MOTIR_PUBLIC_SITE_URL', 'https://motir.co');

    const fx = await publicFixture();
    const row = await follower(fx, { lastDigestAt: new Date('2026-08-17T09:00:00.000Z') });
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Shipped this week' });
    await ship(fx, item.id, '2026-08-20T10:00:00.000Z');

    await publicFollowDigestService.deliverDigest({
      workspaceId: fx.workspaceId,
      followId: row.id,
      occurrenceKey: `${row.id}:2026-W35`,
      now: MONDAY,
    });

    const mail = emails()[0];
    expect(new URL(mail?.data?.changelogUrl ?? '').origin).toBe('https://motir.co');
    expect(new URL(mail?.data?.unsubscribeUrl ?? '').origin).toBe('https://app.motir.co');
    // The unsubscribe token still resolves — the split moved an origin, not a
    // contract.
    const token = decodeURIComponent(
      /token=([^&]+)/.exec(mail?.data?.unsubscribeUrl ?? '')?.[1] ?? '',
    );
    expect(verifyUnsubscribeToken(token)).toBe(row.id);
  });

  it('sends BOTH links to the application host while the public origin is unset — the deployed state today', async () => {
    vi.stubEnv('MOTIR_BASE_URL', 'https://app.motir.co');
    vi.stubEnv('MOTIR_PUBLIC_SITE_URL', undefined);

    const fx = await publicFixture();
    const row = await follower(fx, { lastDigestAt: new Date('2026-08-17T09:00:00.000Z') });
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Shipped this week' });
    await ship(fx, item.id, '2026-08-20T10:00:00.000Z');

    await publicFollowDigestService.deliverDigest({
      workspaceId: fx.workspaceId,
      followId: row.id,
      occurrenceKey: `${row.id}:2026-W35`,
      now: MONDAY,
    });

    const mail = emails()[0];
    // Not a degraded mode: this application still SERVES /p/* until MOTIR-3951
    // deletes it, so the application host is the correct answer, and it stays
    // correct afterwards because the redirects outlive the pages.
    expect(new URL(mail?.data?.changelogUrl ?? '').origin).toBe('https://app.motir.co');
    expect(new URL(mail?.data?.unsubscribeUrl ?? '').origin).toBe('https://app.motir.co');
  });

  // MOTIR-3885 — the property the two cases above imply and neither states.
  it('puts NO localhost anywhere in a delivered mail, with the public origin unset', async () => {
    // The failure this exists to prevent is specific: `resolveBaseUrlTrimmed()`
    // falls back to `http://localhost:3000` when `MOTIR_BASE_URL` is unset, and
    // a link in an inbox is the one URL this application cannot take back. A
    // deployed environment always sets it — so what is asserted here is that
    // with it SET and the public origin unset (exactly the deployed state
    // today), nothing localhost-shaped survives into the payload, including
    // anywhere the two cases above do not look.
    vi.stubEnv('MOTIR_BASE_URL', 'https://app.motir.co');
    vi.stubEnv('MOTIR_PUBLIC_SITE_URL', undefined);

    const fx = await publicFixture();
    const row = await follower(fx, { lastDigestAt: new Date('2026-08-17T09:00:00.000Z') });
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Shipped this week' });
    await ship(fx, item.id, '2026-08-20T10:00:00.000Z');

    await publicFollowDigestService.deliverDigest({
      workspaceId: fx.workspaceId,
      followId: row.id,
      occurrenceKey: `${row.id}:2026-W35`,
      now: MONDAY,
    });

    const serialized = JSON.stringify(emails()[0] ?? {});
    expect(serialized).not.toContain('localhost');
    expect(serialized).not.toContain('127.0.0.1');
    expect(serialized).toContain('https://app.motir.co');
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

  it('is a no-op when the PROJECT was deleted between the tick and the send', async () => {
    const fx = await publicFixture();
    const row = await follower(fx);
    await adminDb.project.delete({ where: { id: fx.projectId } });

    const result = await publicFollowDigestService.deliverDigest({
      workspaceId: fx.workspaceId,
      followId: row.id,
      occurrenceKey: 'x',
      now: MONDAY,
    });
    expect(result).toEqual({ sent: false, itemCount: 0 });
    expect(emails()).toHaveLength(0);
  });

  it('is a no-op when the follower opted OUT between the tick and the send', async () => {
    const fx = await publicFixture();
    const row = await follower(fx, { digestOptIn: false });
    const result = await publicFollowDigestService.deliverDigest({
      workspaceId: fx.workspaceId,
      followId: row.id,
      occurrenceKey: 'x',
      now: MONDAY,
    });
    // The tick's audience read already filters these out; this is the second
    // check, at the moment it actually matters — somebody can untick the box
    // between Monday's scan and Monday's send.
    expect(result.sent).toBe(false);
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

describe('the account tier’s digest', () => {
  it('mails the ACCOUNT’s own address, which no follow row stores', async () => {
    const fx = await publicFixture();
    // An account follow carries `userId` and no `email`, so the recipient is
    // resolved from the user at send time rather than copied onto the row —
    // which is also what makes a changed account address take effect.
    const row = await follower(fx, {
      email: null,
      userId: fx.ownerId,
      lastDigestAt: new Date('2026-08-17T09:00:00.000Z'),
    });
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Shipped' });
    await ship(fx, item.id, '2026-08-20T10:00:00.000Z');

    const result = await publicFollowDigestService.deliverDigest({
      workspaceId: fx.workspaceId,
      followId: row.id,
      occurrenceKey: `${row.id}:2026-W35`,
      now: MONDAY,
    });

    expect(result.sent).toBe(true);
    const user = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ownerId } });
    expect(emails()[0]?.to).toBe(user.email);
  });

  it('pages an audience larger than one read', async () => {
    const fx = await publicFixture();
    // 3 followers is enough to prove the loop advances its cursor rather than
    // re-reading page one for ever; the page size itself is an implementation
    // constant, not a contract.
    for (let i = 0; i < 3; i += 1) {
      await follower(fx, { email: `reader${i}@example.com` });
    }
    const result = await publicFollowDigestService.enqueueDueDigests(MONDAY);
    expect(result.enqueued).toBe(3);
    expect(new Set(digests().map((d) => d.followId)).size).toBe(3);
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
