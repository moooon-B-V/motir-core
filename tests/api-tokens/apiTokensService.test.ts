import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { apiTokensService } from '@/lib/services/apiTokensService';
import { apiTokenRepository } from '@/lib/repositories/apiTokenRepository';
import { hashToken, TOKEN_PREFIX, DISPLAY_PREFIX_LENGTH } from '@/lib/apiTokens/token';
import {
  ApiTokenExpiredError,
  ApiTokenNotFoundError,
  ApiTokenRevokedError,
  InvalidApiTokenError,
  InvalidApiTokenLabelError,
} from '@/lib/apiTokens/errors';
import { truncateAuthTables } from '../helpers/db';

// Service-layer lifecycle tests for the PAT substrate (Story 7.8 · Subtask
// 7.8.1), real Postgres (no mocks — the repo testing contract). RLS is inert
// under the BYPASSRLS test role, so the `db` singleton reads rows directly for
// the "did it land / what's stored" assertions; the service binds its
// owner/system GUCs as it would in production. The `api_token` rows are
// reached by `truncateAuthTables`'s `user` CASCADE (FK onDelete: Cascade).

async function makeUser(email: string) {
  return usersService.createUser({ email, password: 'hunter2hunter2', name: email.split('@')[0] });
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('create', () => {
  it('returns the plaintext ONCE and persists only the hash + prefix', async () => {
    const user = await makeUser('alice@example.com');
    const { token, dto } = await apiTokensService.create(user.id, { label: 'claude-code' });

    // Plaintext shape: the greppable prefix + a body.
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(token.length).toBeGreaterThan(TOKEN_PREFIX.length + 20);

    // The DTO never carries the secret or the hash.
    expect(dto.label).toBe('claude-code');
    expect(dto.tokenPrefix).toBe(token.slice(0, DISPLAY_PREFIX_LENGTH));
    expect(dto.expiresAt).toBeNull();
    expect(dto.lastUsedAt).toBeNull();
    expect(dto.revokedAt).toBeNull();
    expect(JSON.stringify(dto)).not.toContain(token);

    // The row stores the HASH, never the plaintext.
    const row = await db.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    expect(row.tokenHash).toBe(hashToken(token));
    expect(row.tokenHash).not.toBe(token);
    expect(row.tokenPrefix).toBe(token.slice(0, DISPLAY_PREFIX_LENGTH));
  });

  it('persists the provided expiry', async () => {
    const user = await makeUser('alice@example.com');
    const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
    const { dto } = await apiTokensService.create(user.id, { label: 'ci', expiresAt });
    expect(dto.expiresAt).toBe(expiresAt.toISOString());
  });

  it('mints distinct secrets across calls', async () => {
    const user = await makeUser('alice@example.com');
    const a = await apiTokensService.create(user.id, { label: 'a' });
    const b = await apiTokensService.create(user.id, { label: 'b' });
    expect(a.token).not.toBe(b.token);
  });

  it('rejects a blank label', async () => {
    const user = await makeUser('alice@example.com');
    await expect(apiTokensService.create(user.id, { label: '   ' })).rejects.toBeInstanceOf(
      InvalidApiTokenLabelError,
    );
  });

  it('rejects an over-length label', async () => {
    const user = await makeUser('alice@example.com');
    await expect(
      apiTokensService.create(user.id, { label: 'x'.repeat(101) }),
    ).rejects.toBeInstanceOf(InvalidApiTokenLabelError);
  });

  it('trims the label', async () => {
    const user = await makeUser('alice@example.com');
    const { dto } = await apiTokensService.create(user.id, { label: '  claude-code  ' });
    expect(dto.label).toBe('claude-code');
  });
});

describe('listForUser', () => {
  it('returns the user own tokens newest-first, no hash, scoped to the owner', async () => {
    const alice = await makeUser('alice@example.com');
    const bob = await makeUser('bob@example.com');
    const first = await apiTokensService.create(alice.id, { label: 'first' });
    const second = await apiTokensService.create(alice.id, { label: 'second' });
    await apiTokensService.create(bob.id, { label: 'bob-token' });

    const list = await apiTokensService.listForUser(alice.id);
    expect(list.map((t) => t.label)).toEqual(['second', 'first']);
    expect(list.map((t) => t.id)).toEqual([second.dto.id, first.dto.id]);
    // No secret material crosses the boundary.
    expect(JSON.stringify(list)).not.toContain('tokenHash');
  });

  it('returns an empty list for a user with no tokens', async () => {
    const user = await makeUser('alice@example.com');
    expect(await apiTokensService.listForUser(user.id)).toEqual([]);
  });
});

describe('revoke', () => {
  it('soft-revokes a token (row stays, revokedAt set)', async () => {
    const user = await makeUser('alice@example.com');
    const { dto } = await apiTokensService.create(user.id, { label: 'claude-code' });

    const revoked = await apiTokensService.revoke(user.id, dto.id);
    expect(revoked.revokedAt).not.toBeNull();

    const row = await db.apiToken.findUnique({ where: { id: dto.id } });
    expect(row).not.toBeNull();
    expect(row!.revokedAt).not.toBeNull();
  });

  it('is idempotent — re-revoking keeps the original timestamp', async () => {
    const user = await makeUser('alice@example.com');
    const { dto } = await apiTokensService.create(user.id, { label: 'claude-code' });
    const first = await apiTokensService.revoke(user.id, dto.id);
    const second = await apiTokensService.revoke(user.id, dto.id);
    expect(second.revokedAt).toBe(first.revokedAt);
  });

  it('treats another user token as not-found (404-not-403, no leak)', async () => {
    const alice = await makeUser('alice@example.com');
    const bob = await makeUser('bob@example.com');
    const { dto } = await apiTokensService.create(bob.id, { label: 'bob-token' });
    await expect(apiTokensService.revoke(alice.id, dto.id)).rejects.toBeInstanceOf(
      ApiTokenNotFoundError,
    );
    // Bob's token is untouched.
    const row = await db.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    expect(row.revokedAt).toBeNull();
  });

  it('throws not-found for a missing id', async () => {
    const user = await makeUser('alice@example.com');
    await expect(apiTokensService.revoke(user.id, 'nope')).rejects.toBeInstanceOf(
      ApiTokenNotFoundError,
    );
  });
});

describe('verify', () => {
  it('accepts a live token and returns the owning user', async () => {
    const user = await makeUser('alice@example.com');
    const { token } = await apiTokensService.create(user.id, { label: 'claude-code' });
    const resolved = await apiTokensService.verify(token);
    expect(resolved.id).toBe(user.id);
    expect(resolved.email).toBe('alice@example.com');
  });

  it('rejects an unknown token', async () => {
    await makeUser('alice@example.com');
    await expect(apiTokensService.verify('motir_pat_doesnotexist')).rejects.toBeInstanceOf(
      InvalidApiTokenError,
    );
  });

  it('rejects a revoked token', async () => {
    const user = await makeUser('alice@example.com');
    const { token, dto } = await apiTokensService.create(user.id, { label: 'claude-code' });
    await apiTokensService.revoke(user.id, dto.id);
    await expect(apiTokensService.verify(token)).rejects.toBeInstanceOf(ApiTokenRevokedError);
  });

  it('rejects an expired token (boundary: expiry <= now is expired)', async () => {
    const user = await makeUser('alice@example.com');
    const { token } = await apiTokensService.create(user.id, {
      label: 'expired',
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(apiTokensService.verify(token)).rejects.toBeInstanceOf(ApiTokenExpiredError);
  });

  it('accepts a token expiring in the future', async () => {
    const user = await makeUser('alice@example.com');
    const { token } = await apiTokensService.create(user.id, {
      label: 'future',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const resolved = await apiTokensService.verify(token);
    expect(resolved.id).toBe(user.id);
  });

  it('touches lastUsedAt on first use, then throttles within the 5-minute window', async () => {
    const user = await makeUser('alice@example.com');
    const { token, dto } = await apiTokensService.create(user.id, { label: 'claude-code' });

    await apiTokensService.verify(token);
    const afterFirst = await db.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    expect(afterFirst.lastUsedAt).not.toBeNull();

    // A second verify inside the window must NOT re-write lastUsedAt.
    await apiTokensService.verify(token);
    const afterSecond = await db.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    expect(afterSecond.lastUsedAt!.getTime()).toBe(afterFirst.lastUsedAt!.getTime());
  });

  it('re-touches lastUsedAt once the throttle window has passed', async () => {
    const user = await makeUser('alice@example.com');
    const { token, dto } = await apiTokensService.create(user.id, { label: 'claude-code' });
    await apiTokensService.verify(token);

    // Simulate the previous use being > 5 minutes ago.
    const stale = new Date(Date.now() - 6 * 60 * 1000);
    await db.apiToken.update({ where: { id: dto.id }, data: { lastUsedAt: stale } });

    await apiTokensService.verify(token);
    const after = await db.apiToken.findUniqueOrThrow({ where: { id: dto.id } });
    expect(after.lastUsedAt!.getTime()).toBeGreaterThan(stale.getTime());
  });
});

describe('repository guards', () => {
  it('findByTokenHash returns null for an unknown hash', async () => {
    const result = await db.$transaction((tx) =>
      apiTokenRepository.findByTokenHash(hashToken('nope'), tx),
    );
    expect(result).toBeNull();
  });
});
