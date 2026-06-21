import { afterEach, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { inngest } from '@/lib/jobs/client';
import { usersService } from '@/lib/services/usersService';
import { emailChangeRequestRepository } from '@/lib/repositories/emailChangeRequestRepository';
import {
  EmailChangeRateLimitedError,
  EmailTakenError,
  InvalidEmailChangeTokenError,
  InvalidEmailError,
  SameEmailError,
} from '@/lib/users/errors';
import { truncateAuthTables } from './helpers/db';
import { captureEmailEvents } from './helpers/jobs';

// Subtask 8.8.22 — verified email-change flow + the uniqueness race.
//
// `usersService.requestEmailChange` records a pending request (guarded by the
// `email_change_request.new_email` unique index) and enqueues a confirm email;
// `confirmEmailChange` validates the single-use token and swaps `User.email`.
// Real Postgres; truncate between tests (CLAUDE.md: never mock the DB). We spy
// on `inngest.send` (via captureEmailEvents) so the post-commit enqueue is
// observable and never reaches the network.

let emailEvents: ReturnType<typeof captureEmailEvents>;

beforeEach(async () => {
  await truncateAuthTables();
  emailEvents = captureEmailEvents();
});

afterEach(() => {
  emailEvents.restore();
});

afterAll(async () => {
  await db.$disconnect();
});

async function makeUser(email: string, name = 'User') {
  return usersService.createUser({ email, password: 'hunter2hunter2', name });
}

describe('requestEmailChange', () => {
  it('records a pending request and enqueues a confirm email to the NEW address', async () => {
    const user = await makeUser('old@example.com', 'Ada');

    const { token } = await usersService.requestEmailChange(user.id, 'New@Example.com');

    // A pending row exists, normalised, with a future expiry.
    const row = await emailChangeRequestRepository.findByTokenUnsafe(token);
    expect(row).not.toBeNull();
    expect(row!.newEmail).toBe('new@example.com');
    expect(row!.userId).toBe(user.id);
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // The user's live email is unchanged until they confirm.
    const stillOld = await db.user.findUnique({ where: { id: user.id } });
    expect(stillOld!.email).toBe('old@example.com');

    // Exactly one cross-workspace email.send was enqueued, keyed by the token,
    // with the email-change template + a confirm URL carrying the token.
    expect(emailEvents.events).toHaveLength(1);
    const event = emailEvents.events[0]!;
    expect(event.data.template).toBe('email-change');
    expect(event.data.workspaceId).toBeNull();
    expect(event.data.idempotencyKey).toBe(token);
    expect(event.data.to).toBe('new@example.com');
    // The template props (recipientName / newEmail / confirmUrl) nest under
    // `data.data` — the email.send envelope wraps the TransactionalEmail.
    const props = event.data.data as { newEmail: string; confirmUrl: string };
    expect(props.newEmail).toBe('new@example.com');
    expect(props.confirmUrl).toContain(`token=${token}`);
  });

  it('rejects an address already owned by another user (the common, non-racy case)', async () => {
    const me = await makeUser('me@example.com');
    await makeUser('taken@example.com');

    await expect(
      usersService.requestEmailChange(me.id, 'taken@example.com'),
    ).rejects.toBeInstanceOf(EmailTakenError);
    expect(emailEvents.events).toHaveLength(0);
  });

  it('rejects changing to the account’s current email', async () => {
    const me = await makeUser('me@example.com');
    await expect(usersService.requestEmailChange(me.id, 'ME@example.com')).rejects.toBeInstanceOf(
      SameEmailError,
    );
  });

  it('rejects a syntactically invalid email', async () => {
    const me = await makeUser('me@example.com');
    await expect(usersService.requestEmailChange(me.id, 'not-an-email')).rejects.toBeInstanceOf(
      InvalidEmailError,
    );
  });

  it('re-requesting the same new address is idempotent (no self-collision)', async () => {
    const me = await makeUser('me@example.com');
    const first = await usersService.requestEmailChange(me.id, 'next@example.com');
    const second = await usersService.requestEmailChange(me.id, 'next@example.com');
    expect(second.token).not.toBe(first.token);
    // Only the latest token survives.
    expect(await emailChangeRequestRepository.findByTokenUnsafe(first.token)).toBeNull();
    expect(await emailChangeRequestRepository.findByTokenUnsafe(second.token)).not.toBeNull();
  });

  it('rate-limits at 3 requests per user per window', async () => {
    const me = await makeUser('me@example.com');
    await usersService.requestEmailChange(me.id, 'a@example.com');
    await usersService.requestEmailChange(me.id, 'b@example.com');
    await usersService.requestEmailChange(me.id, 'c@example.com');
    await expect(usersService.requestEmailChange(me.id, 'd@example.com')).rejects.toBeInstanceOf(
      EmailChangeRateLimitedError,
    );
  });

  it('still succeeds when the email enqueue fails (side-effect outside the tx)', async () => {
    const me = await makeUser('me@example.com');
    // Make the post-commit enqueue throw. sendEvent swallows transport errors,
    // so the already-committed request must still resolve and persist its row.
    const spy = vi
      .spyOn(inngest, 'send')
      .mockRejectedValueOnce(new Error('inngest unreachable') as never);

    const { token } = await usersService.requestEmailChange(me.id, 'new@example.com');
    expect(await emailChangeRequestRepository.findByTokenUnsafe(token)).not.toBeNull();
    spy.mockRestore();
  });
});

describe('requestEmailChange — concurrency (the uniqueness race)', () => {
  it('two concurrent requests for the same new email: exactly one wins, the other gets EmailTakenError', async () => {
    const a = await makeUser('a@example.com', 'A');
    const b = await makeUser('b@example.com', 'B');

    // Both race for the same free address under the warm connection pool. The
    // new_email unique index serialises them: one inserts, the other gets P2002
    // → EmailTakenError. (CLAUDE.md: a concurrency test accepts every legitimate
    // race outcome — here either user may be the winner.)
    const [ra, rb] = await Promise.allSettled([
      usersService.requestEmailChange(a.id, 'contested@example.com'),
      usersService.requestEmailChange(b.id, 'contested@example.com'),
    ]);

    const fulfilled = [ra, rb].filter((r) => r.status === 'fulfilled');
    const rejected = [ra, rb].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(EmailTakenError);

    // Exactly one pending row for the contested address.
    const rows = await db.emailChangeRequest.findMany({
      where: { newEmail: 'contested@example.com' },
    });
    expect(rows).toHaveLength(1);
  });
});

describe('confirmEmailChange', () => {
  it('swaps the email, verifies it, re-keys the credential account, and consumes the token', async () => {
    const user = await makeUser('old@example.com');
    const { token } = await usersService.requestEmailChange(user.id, 'new@example.com');

    const result = await usersService.confirmEmailChange(token);
    expect(result).toEqual({ userId: user.id, newEmail: 'new@example.com' });

    const updated = await db.user.findUnique({ where: { id: user.id } });
    expect(updated!.email).toBe('new@example.com');
    expect(updated!.emailVerified).toBe(true);

    // The credential account's accountId tracks the new email, so the freed old
    // address can be reused at signup without a (providerId, accountId) clash.
    const credential = await db.account.findFirst({
      where: { userId: user.id, providerId: 'credential' },
    });
    expect(credential!.accountId).toBe('new@example.com');

    // Single-use: the token is gone, and a replay is rejected.
    expect(await emailChangeRequestRepository.findByTokenUnsafe(token)).toBeNull();
    await expect(usersService.confirmEmailChange(token)).rejects.toBeInstanceOf(
      InvalidEmailChangeTokenError,
    );
  });

  it('lets the user sign in with the new email after confirming', async () => {
    const user = await makeUser('old@example.com');
    const { token } = await usersService.requestEmailChange(user.id, 'new@example.com');
    await usersService.confirmEmailChange(token);

    expect(await usersService.verifyPassword('new@example.com', 'hunter2hunter2')).toBe(true);
    expect(await usersService.verifyPassword('old@example.com', 'hunter2hunter2')).toBe(false);
  });

  it('rejects (and consumes) an expired token', async () => {
    const user = await makeUser('old@example.com');
    const { token } = await usersService.requestEmailChange(user.id, 'new@example.com');
    // Force the row past its expiry.
    await db.emailChangeRequest.update({
      where: { token },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(usersService.confirmEmailChange(token)).rejects.toBeInstanceOf(
      InvalidEmailChangeTokenError,
    );
    // Consumed even though it was expired — no replay.
    expect(await emailChangeRequestRepository.findByTokenUnsafe(token)).toBeNull();
    const unchanged = await db.user.findUnique({ where: { id: user.id } });
    expect(unchanged!.email).toBe('old@example.com');
  });

  it('rejects an unknown token', async () => {
    await expect(usersService.confirmEmailChange('nope')).rejects.toBeInstanceOf(
      InvalidEmailChangeTokenError,
    );
  });

  it('throws EmailTakenError if the address was claimed between request and confirm', async () => {
    const user = await makeUser('old@example.com');
    const { token } = await usersService.requestEmailChange(user.id, 'new@example.com');
    // A fresh signup grabs the address before confirmation.
    await makeUser('new@example.com');

    await expect(usersService.confirmEmailChange(token)).rejects.toBeInstanceOf(EmailTakenError);
    const unchanged = await db.user.findUnique({ where: { id: user.id } });
    expect(unchanged!.email).toBe('old@example.com');
  });
});
