import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { publicFollowService } from '@/lib/services/publicFollowService';
import { hashFollowToken } from '@/lib/publicProjects/followTokens';
import {
  FollowDigestUnavailableError,
  FollowTokenInvalidError,
  InvalidFollowEmailError,
} from '@/lib/publicProjects/followErrors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story 8.9 · Subtask 8.9.5 — the follow loop. Real Postgres, no DB mocks; the
// ONE mock is the job dispatcher, for the reason spelled out below it.
//
// What these cover is deliberately weighted towards the SECURITY properties,
// because those are the ones a later refactor breaks silently:
//   * idempotence on both account verbs (a double click is not a conflict);
//   * the ENUMERATION rule — a subscribe answers identically whatever the truth
//     was, and never re-mails a confirmed address;
//   * a confirmation token that is single-use, expiring, and cleared as spent;
//   * an unsubscribe that always succeeds, including for a token already spent.

// The confirmation mail is ENQUEUED, never sent inline (only the `email.send`
// job imports `@/lib/email`, and eslint enforces it), so the seam a test drives
// is the event — which is also the honest one: what this service is responsible
// for is that the right envelope is emitted, not that a provider accepted it.
const enqueued: Array<{ to: string; template: string; data: { confirmUrl: string } }> = [];

vi.mock('@/lib/jobs/sendEvent', () => ({
  sendEvent: async (
    name: string,
    payload: { to: string; template: string; data: { confirmUrl: string } },
  ) => {
    if (name === 'email.send') enqueued.push(payload);
  },
}));

beforeEach(async () => {
  enqueued.length = 0;
  // A configured provider, so `digestAvailable()` is true here — the self-host
  // path gets its own case at the bottom.
  vi.stubEnv('EMAIL_PROVIDER', 'resend');
  await truncateAuthTables();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function publicFixture(name = 'Acme', identifier = 'ACME'): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture({ name, identifier });
  await adminDb.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'public' } });
  return fx;
}

describe('the account tier', () => {
  it('follows, and following AGAIN is not an error', async () => {
    const fx = await publicFixture();
    const first = await publicFollowService.followAsAccount(fx.projectIdentifier, fx.ownerId);
    expect(first.following).toBe(true);
    expect(first.followerCount).toBe(1);

    // Idempotent: a double-click, a retried request, a re-render that fires the
    // handler twice — all of them must answer the state, not a conflict.
    const again = await publicFollowService.followAsAccount(fx.projectIdentifier, fx.ownerId);
    expect(again.following).toBe(true);
    expect(again.followerCount).toBe(1);
    expect(await adminDb.publicFollow.count()).toBe(1);
  });

  it('is CONFIRMED at creation — an account address is already verified', async () => {
    const fx = await publicFixture();
    await publicFollowService.followAsAccount(fx.projectIdentifier, fx.ownerId);
    const row = await adminDb.publicFollow.findFirstOrThrow();
    expect(row.confirmedAt).not.toBeNull();
    expect(row.confirmTokenHash).toBeNull();
    // Following is not subscribing: the digest is off until it is asked for.
    expect(row.digestOptIn).toBe(false);
  });

  it('does not silently flip a digest preference on a bare re-follow', async () => {
    const fx = await publicFixture();
    await publicFollowService.followAsAccount(fx.projectIdentifier, fx.ownerId, {
      digestOptIn: true,
    });
    const bare = await publicFollowService.followAsAccount(fx.projectIdentifier, fx.ownerId);
    expect(bare.digestOptIn).toBe(true);

    const off = await publicFollowService.followAsAccount(fx.projectIdentifier, fx.ownerId, {
      digestOptIn: false,
    });
    expect(off.digestOptIn).toBe(false);
  });

  it('unfollows, and unfollowing what you do not follow is not an error', async () => {
    const fx = await publicFixture();
    const never = await publicFollowService.unfollowAsAccount(fx.projectIdentifier, fx.ownerId);
    expect(never.following).toBe(false);

    await publicFollowService.followAsAccount(fx.projectIdentifier, fx.ownerId);
    const gone = await publicFollowService.unfollowAsAccount(fx.projectIdentifier, fx.ownerId);
    expect(gone.following).toBe(false);
    expect(gone.followerCount).toBe(0);
    expect(await adminDb.publicFollow.count()).toBe(0);
  });

  it('reports follow state per viewer, and never leaks another account’s', async () => {
    const fx = await publicFixture();
    const other = await createTestUser();
    await publicFollowService.followAsAccount(fx.projectIdentifier, fx.ownerId);

    const mine = await publicFollowService.getFollowState(fx.projectIdentifier, fx.ownerId);
    expect(mine.following).toBe(true);

    const theirs = await publicFollowService.getFollowState(fx.projectIdentifier, other.id);
    expect(theirs.following).toBe(false);
    // The COUNT is public — the identities behind it are not.
    expect(theirs.followerCount).toBe(1);

    const anonymous = await publicFollowService.getFollowState(fx.projectIdentifier, null);
    expect(anonymous.following).toBe(false);
    expect(anonymous.followerCount).toBe(1);
  });

  it('refuses a project that is not public — 404, not 403', async () => {
    const fx = await makeWorkItemFixture({ name: 'Private', identifier: 'PRIV' });
    await expect(
      publicFollowService.followAsAccount(fx.projectIdentifier, fx.ownerId),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });
});

describe('the email-only tier', () => {
  it('writes an UNCONFIRMED row and sends exactly one confirmation', async () => {
    const fx = await publicFixture();
    await publicFollowService.subscribeByEmail(fx.projectIdentifier, 'Reader@Example.com', null);

    const row = await adminDb.publicFollow.findFirstOrThrow();
    // Stored lowercased, so a case variant cannot become a second follow.
    expect(row.email).toBe('reader@example.com');
    expect(row.userId).toBeNull();
    expect(row.confirmedAt).toBeNull();
    expect(row.confirmTokenHash).not.toBeNull();
    expect(row.confirmTokenExpiresAt).not.toBeNull();

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.to).toBe('reader@example.com');
    expect(enqueued[0]?.template).toBe('follow-confirm');
    expect(enqueued[0]?.data.confirmUrl).toContain('/follow/confirm?token=');
  });

  it('never stores the token itself — only its hash', async () => {
    const fx = await publicFixture();
    await publicFollowService.subscribeByEmail(fx.projectIdentifier, 'reader@example.com', null);
    const token = /token=([A-Za-z0-9_-]+)/.exec(enqueued[0]?.data.confirmUrl ?? '')?.[1] ?? '';
    expect(token.length).toBeGreaterThan(20);

    const row = await adminDb.publicFollow.findFirstOrThrow();
    expect(row.confirmTokenHash).not.toBe(token);
    expect(row.confirmTokenHash).toBe(hashFollowToken(token));
  });

  it('RE-SUBSCRIBING an unconfirmed address replaces the token rather than adding a row', async () => {
    const fx = await publicFixture();
    await publicFollowService.subscribeByEmail(fx.projectIdentifier, 'reader@example.com', null);
    const first = await adminDb.publicFollow.findFirstOrThrow();
    await publicFollowService.subscribeByEmail(fx.projectIdentifier, 'reader@example.com', null);

    expect(await adminDb.publicFollow.count()).toBe(1);
    const second = await adminDb.publicFollow.findFirstOrThrow();
    // The newest link is the only live one — the previous token dies at once.
    expect(second.confirmTokenHash).not.toBe(first.confirmTokenHash);
    expect(enqueued).toHaveLength(2);
  });

  it('sends NOTHING when the address is already a confirmed follower', async () => {
    const fx = await publicFixture();
    await publicFollowService.subscribeByEmail(fx.projectIdentifier, 'reader@example.com', null);
    const token = /token=([A-Za-z0-9_-]+)/.exec(enqueued[0]?.data.confirmUrl ?? '')?.[1] ?? '';
    await publicFollowService.confirmEmailFollow(token);
    enqueued.length = 0;

    // The enumeration rule, and an anti-abuse property in the same act: a
    // re-subscribe must not become a way to make us mail an address on demand.
    await expect(
      publicFollowService.subscribeByEmail(fx.projectIdentifier, 'reader@example.com', null),
    ).resolves.toBeUndefined();
    expect(enqueued).toHaveLength(0);
  });

  it('answers the same way — void — whether or not the address was known', async () => {
    const fx = await publicFixture();
    const fresh = await publicFollowService.subscribeByEmail(
      fx.projectIdentifier,
      'new@example.com',
      null,
    );
    const repeat = await publicFollowService.subscribeByEmail(
      fx.projectIdentifier,
      'new@example.com',
      null,
    );
    // Identical return for both — the caller learns nothing about the row.
    expect(fresh).toBeUndefined();
    expect(repeat).toBeUndefined();
  });

  it('rejects something that is not an address, before writing or sending', async () => {
    const fx = await publicFixture();
    await expect(
      publicFollowService.subscribeByEmail(fx.projectIdentifier, 'not-an-address', null),
    ).rejects.toBeInstanceOf(InvalidFollowEmailError);
    expect(await adminDb.publicFollow.count()).toBe(0);
    expect(enqueued).toHaveLength(0);
  });
});

describe('confirmation', () => {
  async function subscribeAndGetToken(fx: WorkItemFixture): Promise<string> {
    await publicFollowService.subscribeByEmail(fx.projectIdentifier, 'reader@example.com', null);
    return (
      /token=([A-Za-z0-9_-]+)/.exec(enqueued[enqueued.length - 1]?.data.confirmUrl ?? '')?.[1] ?? ''
    );
  }

  it('confirms, and CLEARS the token as it is spent', async () => {
    const fx = await publicFixture();
    const token = await subscribeAndGetToken(fx);

    const result = await publicFollowService.confirmEmailFollow(token);
    expect(result.projectIdentifier).toBe(fx.projectIdentifier);

    const row = await adminDb.publicFollow.findFirstOrThrow();
    expect(row.confirmedAt).not.toBeNull();
    expect(row.confirmTokenHash).toBeNull();
    expect(row.confirmTokenExpiresAt).toBeNull();
  });

  it('refuses the SAME token twice — single use, so an inbox is not a replay store', async () => {
    const fx = await publicFixture();
    const token = await subscribeAndGetToken(fx);
    await publicFollowService.confirmEmailFollow(token);
    await expect(publicFollowService.confirmEmailFollow(token)).rejects.toBeInstanceOf(
      FollowTokenInvalidError,
    );
  });

  it('refuses an EXPIRED token, with the same error as an unknown one', async () => {
    const fx = await publicFixture();
    const token = await subscribeAndGetToken(fx);
    await adminDb.publicFollow.updateMany({
      data: { confirmTokenExpiresAt: new Date(Date.now() - 1000) },
    });
    // "Expired" and "never existed" must be indistinguishable to a caller, or
    // the endpoint becomes a way to test tokens for existence.
    await expect(publicFollowService.confirmEmailFollow(token)).rejects.toBeInstanceOf(
      FollowTokenInvalidError,
    );
    await expect(publicFollowService.confirmEmailFollow('never-issued')).rejects.toBeInstanceOf(
      FollowTokenInvalidError,
    );
  });
});

describe('unsubscribe', () => {
  it('removes the follow, and a SECOND click still succeeds', async () => {
    const fx = await publicFixture();
    await publicFollowService.subscribeByEmail(fx.projectIdentifier, 'reader@example.com', null);
    const row = await adminDb.publicFollow.findFirstOrThrow();
    // The service mints the unsubscribe token and stores only its hash, so a
    // test drives it the way an email would: set a known hash, use the token.
    await adminDb.publicFollow.update({
      where: { id: row.id },
      data: { unsubscribeTokenHash: hashFollowToken('KNOWN-TOKEN') },
    });

    await publicFollowService.unsubscribeByToken('KNOWN-TOKEN');
    expect(await adminDb.publicFollow.count()).toBe(0);

    // Idempotent by design: a second click, a mail client's prefetch, or a link
    // found years later must never report that unsubscribing failed — the
    // person has no other lever.
    await expect(publicFollowService.unsubscribeByToken('KNOWN-TOKEN')).resolves.toBeUndefined();
  });

  it('succeeds silently for a token that names nothing', async () => {
    await expect(publicFollowService.unsubscribeByToken('nonsense')).resolves.toBeUndefined();
  });
});

describe('the self-host path — no email backend', () => {
  it('reports the digest unavailable and refuses an email opt-in', async () => {
    const fx = await publicFixture();
    // `console` is the unconfigured default: it reaches no person, so it must
    // not be advertised as an email subscription (ADR §4).
    vi.stubEnv('EMAIL_PROVIDER', 'console');

    const state = await publicFollowService.getFollowState(fx.projectIdentifier, null);
    expect(state.digestAvailable).toBe(false);

    await expect(
      publicFollowService.subscribeByEmail(fx.projectIdentifier, 'reader@example.com', null),
    ).rejects.toBeInstanceOf(FollowDigestUnavailableError);
    expect(enqueued).toHaveLength(0);
  });
});
