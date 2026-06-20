import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import {
  NoCredentialPasswordError,
  WeakPasswordError,
  WrongCurrentPasswordError,
} from '@/lib/users/errors';
import { truncateAuthTables } from './helpers/db';

// Service-layer tests for the in-app password change (Subtask 8.8.23), against
// a real Postgres per CLAUDE.md. We drive usersService.* directly and reach
// into db.account to assert the stored hash actually changed / stayed put.

const { createUser, changePassword, getPasswordCapability, verifyPassword, findOrCreateOAuthUser } =
  usersService;

const CURRENT = 'current-password-1';
const NEW = 'a-new-password-2';

async function credentialUser(email = 'cred@example.com') {
  return createUser({ email, password: CURRENT, name: 'Cred' });
}

async function oauthUser(email = 'oauth@example.com') {
  return findOrCreateOAuthUser({
    provider: 'google',
    providerAccountId: 'google-123',
    email,
    name: 'Oauth',
  });
}

async function credentialHash(userId: string): Promise<string | null> {
  const row = await db.account.findFirst({ where: { userId, providerId: 'credential' } });
  return row?.password ?? null;
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('getPasswordCapability', () => {
  it('is true for a credential user', async () => {
    const user = await credentialUser();
    expect(await getPasswordCapability(user.id)).toEqual({ hasPassword: true });
  });

  it('is false for an OAuth-only user', async () => {
    const user = await oauthUser();
    expect(await getPasswordCapability(user.id)).toEqual({ hasPassword: false });
  });
});

describe('changePassword', () => {
  it('changes the password when the current one is correct', async () => {
    const user = await credentialUser();
    const before = await credentialHash(user.id);

    const result = await changePassword({
      userId: user.id,
      currentPassword: CURRENT,
      newPassword: NEW,
    });
    expect(result).toEqual({ revokedSessions: 0 });

    const after = await credentialHash(user.id);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before); // a fresh argon2id hash
    expect(after).toMatch(/^\$argon2id\$/);

    // The new password verifies; the old no longer does.
    expect(await verifyPassword(user.email, NEW)).toBe(true);
    expect(await verifyPassword(user.email, CURRENT)).toBe(false);
  });

  it('rejects a wrong current password without changing the hash', async () => {
    const user = await credentialUser();
    const before = await credentialHash(user.id);

    await expect(
      changePassword({ userId: user.id, currentPassword: 'wrong-password', newPassword: NEW }),
    ).rejects.toBeInstanceOf(WrongCurrentPasswordError);

    expect(await credentialHash(user.id)).toBe(before);
    expect(await verifyPassword(user.email, CURRENT)).toBe(true);
  });

  it('rejects a too-short new password without changing the hash', async () => {
    const user = await credentialUser();
    const before = await credentialHash(user.id);

    await expect(
      changePassword({ userId: user.id, currentPassword: CURRENT, newPassword: 'short' }),
    ).rejects.toBeInstanceOf(WeakPasswordError);

    expect(await credentialHash(user.id)).toBe(before);
  });

  it('rejects an OAuth-only user with NoCredentialPasswordError', async () => {
    const user = await oauthUser();
    await expect(
      changePassword({ userId: user.id, currentPassword: 'anything!', newPassword: NEW }),
    ).rejects.toBeInstanceOf(NoCredentialPasswordError);
  });

  it('revokes other sessions but keeps the current one when asked', async () => {
    const user = await credentialUser();
    const now = new Date(Date.now() + 60 * 60 * 1000);
    await db.session.createMany({
      data: [
        { userId: user.id, token: 'current', expiresAt: now },
        { userId: user.id, token: 'other-1', expiresAt: now },
        { userId: user.id, token: 'other-2', expiresAt: now },
      ],
    });

    const result = await changePassword({
      userId: user.id,
      currentPassword: CURRENT,
      newPassword: NEW,
      currentSessionToken: 'current',
      revokeOtherSessions: true,
    });
    expect(result).toEqual({ revokedSessions: 2 });

    const remaining = await db.session.findMany({ where: { userId: user.id } });
    expect(remaining.map((s) => s.token)).toEqual(['current']);
  });

  it('leaves sessions untouched when revokeOtherSessions is not set', async () => {
    const user = await credentialUser();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await db.session.createMany({
      data: [
        { userId: user.id, token: 'current', expiresAt },
        { userId: user.id, token: 'other-1', expiresAt },
      ],
    });

    const result = await changePassword({
      userId: user.id,
      currentPassword: CURRENT,
      newPassword: NEW,
      currentSessionToken: 'current',
    });
    expect(result).toEqual({ revokedSessions: 0 });
    expect(await db.session.count({ where: { userId: user.id } })).toBe(2);
  });
});
