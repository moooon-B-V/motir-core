import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { ImportSource, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { usersService } from '@/lib/services/usersService';
import { workspacesService } from '@/lib/services/workspacesService';
import { importSourceIdentityService } from '@/lib/services/importSourceIdentityService';
import { importSourceIdentityRepository } from '@/lib/repositories/importSourceIdentityRepository';
import { createTokenCrypto } from '@/lib/crypto/tokenCrypto';
import { withSystemContext } from '@/lib/workspaces/context';
import { truncateAuthTables } from '../helpers/db';

// Story 7.16 · MOTIR-1653 — the per-user import-source OAuth identity store,
// against a real Postgres (the motir-core convention). Mirrors the GitHub
// identity suite: tokens are stored ENCRYPTED (never plaintext) and recovered
// via the fetch-and-decrypt read, the `[userId, source, workspaceId]` unique
// keys one identity per source per workspace, and the migration's RLS policy
// isolates a member's identities from another member under the app role.

const PASSWORD = 'hunter2hunter2';

// Decrypt exactly as the service does (same env-key resolution) to prove the
// stored ciphertext is recoverable and not plaintext.
const { decryptToken } = createTokenCrypto([
  'IMPORT_TOKEN_ENCRYPTION_KEY',
  'GITHUB_TOKEN_ENCRYPTION_KEY',
]);

interface Member {
  userId: string;
  workspaceId: string;
}

async function makeMember(email: string): Promise<Member> {
  const user = await usersService.createUser({ email, password: PASSWORD, name: 'Member' });
  const { workspace } = await workspacesService.createWorkspace({
    name: `Workspace ${email}`,
    ownerUserId: user.id,
  });
  return { userId: user.id, workspaceId: workspace.id };
}

/** Count rows bypassing RLS (system context) — the app role would hide them. */
function countRows(): Promise<number> {
  return withSystemContext((tx) => tx.importSourceIdentity.count());
}

/** Read one row bypassing RLS, for asserting the stored (encrypted) columns. */
function readRaw(m: Member, source: ImportSource) {
  return withSystemContext((tx) =>
    importSourceIdentityRepository.findByUserSource(m.userId, source, m.workspaceId, tx),
  );
}

/**
 * Run `fn` under the `app.user_id` GUC + the non-bypass `prodect_app` role —
 * the role switch is what makes the RLS policy bite (the test superuser bypasses
 * even FORCE). Mirrors the helper in tests/github/githubIdentityService.test.ts.
 */
async function asAppRole<T>(
  userId: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, true)`;
    await tx.$executeRawUnsafe('SET LOCAL ROLE prodect_app');
    return fn(tx);
  });
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('importSourceIdentityService.upsertIdentity', () => {
  it('stores both tokens ENCRYPTED and returns a token-free DTO', async () => {
    const m = await makeMember('member@example.com');
    const expiresAt = new Date('2030-01-01T00:00:00.000Z');

    const dto = await importSourceIdentityService.upsertIdentity({
      userId: m.userId,
      workspaceId: m.workspaceId,
      source: 'jira',
      accessToken: 'jira_access',
      refreshToken: 'jira_refresh',
      expiresAt,
      metadata: { cloudId: 'cid-1', siteUrl: 'https://acme.atlassian.net' },
    });

    expect(dto).toMatchObject({
      source: 'jira',
      metadata: { cloudId: 'cid-1', siteUrl: 'https://acme.atlassian.net' },
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    // No secret crosses the DTO boundary, in any form.
    expect(dto).not.toHaveProperty('accessToken');
    expect(dto).not.toHaveProperty('accessTokenEncrypted');
    expect(dto).not.toHaveProperty('refreshToken');
    expect(dto).not.toHaveProperty('refreshTokenEncrypted');

    const row = await readRaw(m, 'jira');
    expect(row).not.toBeNull();
    expect(row!.accessTokenEncrypted).not.toBe('jira_access'); // stored encrypted
    expect(decryptToken(row!.accessTokenEncrypted)).toBe('jira_access'); // recoverable
    expect(decryptToken(row!.refreshTokenEncrypted!)).toBe('jira_refresh');
  });

  it('leaves refresh / expiry / metadata null for a token-only source', async () => {
    const m = await makeMember('linear@example.com');

    await importSourceIdentityService.upsertIdentity({
      userId: m.userId,
      workspaceId: m.workspaceId,
      source: 'linear',
      accessToken: 'linear_access',
    });

    const row = await readRaw(m, 'linear');
    expect(row!.refreshTokenEncrypted).toBeNull();
    expect(row!.expiresAt).toBeNull();
    expect(row!.metadata).toBeNull();
    expect(decryptToken(row!.accessTokenEncrypted)).toBe('linear_access');
  });

  it('refreshes the identity IN PLACE on re-connect (one row per source)', async () => {
    const m = await makeMember('reconnect@example.com');

    await importSourceIdentityService.upsertIdentity({
      userId: m.userId,
      workspaceId: m.workspaceId,
      source: 'jira',
      accessToken: 'v1',
      metadata: { cloudId: 'old' },
    });
    const first = await readRaw(m, 'jira');

    await importSourceIdentityService.upsertIdentity({
      userId: m.userId,
      workspaceId: m.workspaceId,
      source: 'jira',
      accessToken: 'v2',
      metadata: { cloudId: 'new' },
    });

    expect(await countRows()).toBe(1);
    const row = await readRaw(m, 'jira');
    expect(row!.id).toBe(first!.id); // same row, refreshed
    expect(decryptToken(row!.accessTokenEncrypted)).toBe('v2');

    const live = await importSourceIdentityService.getLiveToken({
      userId: m.userId,
      workspaceId: m.workspaceId,
      source: 'jira',
    });
    expect(live!.metadata).toEqual({ cloudId: 'new' });
  });

  it('keys uniqueness on the (user, source, workspace) triple — distinct source or workspace is a distinct row', async () => {
    const user = await usersService.createUser({
      email: 'multi@example.com',
      password: PASSWORD,
      name: 'Multi',
    });
    const { workspace: ws1 } = await workspacesService.createWorkspace({
      name: 'WS One',
      ownerUserId: user.id,
    });
    const { workspace: ws2 } = await workspacesService.createWorkspace({
      name: 'WS Two',
      ownerUserId: user.id,
    });

    // Same user: jira@ws1, linear@ws1 (different source), jira@ws2 (different ws).
    await importSourceIdentityService.upsertIdentity({
      userId: user.id,
      workspaceId: ws1.id,
      source: 'jira',
      accessToken: 'a',
    });
    await importSourceIdentityService.upsertIdentity({
      userId: user.id,
      workspaceId: ws1.id,
      source: 'linear',
      accessToken: 'b',
    });
    await importSourceIdentityService.upsertIdentity({
      userId: user.id,
      workspaceId: ws2.id,
      source: 'jira',
      accessToken: 'c',
    });

    expect(await countRows()).toBe(3);
  });

  it('the DB enforces the unique constraint (a duplicate triple is rejected)', async () => {
    const m = await makeMember('dup@example.com');
    await importSourceIdentityService.upsertIdentity({
      userId: m.userId,
      workspaceId: m.workspaceId,
      source: 'jira',
      accessToken: 'first',
    });

    await expect(
      withSystemContext((tx) =>
        tx.importSourceIdentity.create({
          data: {
            userId: m.userId,
            workspaceId: m.workspaceId,
            source: 'jira',
            accessTokenEncrypted: 'enc',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('importSourceIdentityService.getLiveToken', () => {
  it('fetch-and-decrypts the full bundle', async () => {
    const m = await makeMember('live@example.com');
    const expiresAt = new Date('2031-06-15T12:00:00.000Z');
    await importSourceIdentityService.upsertIdentity({
      userId: m.userId,
      workspaceId: m.workspaceId,
      source: 'plane',
      accessToken: 'plane_access',
      refreshToken: 'plane_refresh',
      expiresAt,
      metadata: { baseUrl: 'https://plane.acme.dev', workspaceSlug: 'acme' },
    });

    const live = await importSourceIdentityService.getLiveToken({
      userId: m.userId,
      workspaceId: m.workspaceId,
      source: 'plane',
    });

    expect(live).toEqual({
      accessToken: 'plane_access',
      refreshToken: 'plane_refresh',
      expiresAt,
      metadata: { baseUrl: 'https://plane.acme.dev', workspaceSlug: 'acme' },
    });
  });

  it('returns null when the member has not connected the source', async () => {
    const m = await makeMember('unbound@example.com');
    expect(
      await importSourceIdentityService.getLiveToken({
        userId: m.userId,
        workspaceId: m.workspaceId,
        source: 'jira',
      }),
    ).toBeNull();
  });

  it('normalises a non-object metadata to null on read', async () => {
    const m = await makeMember('badmeta@example.com');
    // Insert a row whose metadata is a JSON array (not the object shape) —
    // the mapper's defensive guard must normalise it to null, not crash.
    await withSystemContext((tx) =>
      tx.importSourceIdentity.create({
        data: {
          userId: m.userId,
          workspaceId: m.workspaceId,
          source: 'jira',
          accessTokenEncrypted: createTokenCrypto([
            'IMPORT_TOKEN_ENCRYPTION_KEY',
            'GITHUB_TOKEN_ENCRYPTION_KEY',
          ]).encryptToken('at'),
          metadata: ['not', 'an', 'object'],
        },
      }),
    );

    const live = await importSourceIdentityService.getLiveToken({
      userId: m.userId,
      workspaceId: m.workspaceId,
      source: 'jira',
    });
    expect(live!.metadata).toBeNull();

    const dto = await importSourceIdentityService.getIdentity({
      userId: m.userId,
      workspaceId: m.workspaceId,
      source: 'jira',
    });
    expect(dto!.metadata).toBeNull();
  });
});

describe('importSourceIdentityService — RLS isolation', () => {
  it("the migration policy hides another member's identity under the app role", async () => {
    const alice = await makeMember('alice@example.com');
    const bob = await makeMember('bob@example.com');
    await importSourceIdentityService.upsertIdentity({
      userId: alice.userId,
      workspaceId: alice.workspaceId,
      source: 'jira',
      accessToken: 'a',
    });

    const underBob = await asAppRole(bob.userId, (tx) =>
      importSourceIdentityRepository.findByUserSource(alice.userId, 'jira', alice.workspaceId, tx),
    );
    expect(underBob).toBeNull();

    const underAlice = await asAppRole(alice.userId, (tx) =>
      importSourceIdentityRepository.findByUserSource(alice.userId, 'jira', alice.workspaceId, tx),
    );
    expect(underAlice).not.toBeNull();
  });
});

describe('importSourceIdentityService.getIdentity / disconnect', () => {
  it('getIdentity returns null when unbound, the token-free DTO once bound', async () => {
    const m = await makeMember('presence@example.com');
    expect(
      await importSourceIdentityService.getIdentity({
        userId: m.userId,
        workspaceId: m.workspaceId,
        source: 'jira',
      }),
    ).toBeNull();

    await importSourceIdentityService.upsertIdentity({
      userId: m.userId,
      workspaceId: m.workspaceId,
      source: 'jira',
      accessToken: 'at',
      metadata: { cloudId: 'c' },
    });

    const dto = await importSourceIdentityService.getIdentity({
      userId: m.userId,
      workspaceId: m.workspaceId,
      source: 'jira',
    });
    expect(dto).toMatchObject({ source: 'jira', metadata: { cloudId: 'c' } });
    expect(dto).not.toHaveProperty('accessTokenEncrypted');
  });

  it('disconnect removes only the acting source, and is idempotent', async () => {
    const m = await makeMember('disc@example.com');
    await importSourceIdentityService.upsertIdentity({
      userId: m.userId,
      workspaceId: m.workspaceId,
      source: 'jira',
      accessToken: 'j',
    });
    await importSourceIdentityService.upsertIdentity({
      userId: m.userId,
      workspaceId: m.workspaceId,
      source: 'linear',
      accessToken: 'l',
    });
    expect(await countRows()).toBe(2);

    await importSourceIdentityService.disconnect({
      userId: m.userId,
      workspaceId: m.workspaceId,
      source: 'jira',
    });

    expect(await countRows()).toBe(1);
    expect(await readRaw(m, 'jira')).toBeNull();
    expect(await readRaw(m, 'linear')).not.toBeNull();

    // Idempotent — disconnecting an already-unbound source is a no-op.
    await expect(
      importSourceIdentityService.disconnect({
        userId: m.userId,
        workspaceId: m.workspaceId,
        source: 'jira',
      }),
    ).resolves.toBeUndefined();
    expect(await countRows()).toBe(1);
  });
});
