import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { MonitorConnectionAlreadyExistsError } from '@/lib/monitors/errors';
import { decryptToken, encryptToken } from '@/lib/monitors/tokenCrypto';
import { monitorConnectionRepository } from '@/lib/repositories/monitorConnectionRepository';
import { monitorInstallationRepository } from '@/lib/repositories/monitorInstallationRepository';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The monitor-connection STORE — `monitor_installation` + `monitor_connection`,
// their RLS policies, the crypto re-export and the two repositories over them
// (Story MOTIR-4926 · Subtask MOTIR-5258).
//
// Four properties, and each is the answer to an acceptance criterion that names
// a test rather than an inspection:
//
//   1. TENANCY — a reader in workspace A cannot see workspace B's grants or
//      bindings, on a fixture where the actor's VIEW and the TRUE POPULATION
//      differ. A fixture in which the actor happens to see everything cannot
//      distinguish a scoped read from an unscoped one, so both tenants are
//      seeded and each read is asserted to return exactly one of them.
//   2. THE CREDENTIAL — a round trip through the shared AES-256-GCM seam, and a
//      TAMPERED payload that THROWS rather than returning a usable string.
//   3. NO PLAINTEXT ON A READ PATH — the list and detail reads carry no token at
//      all, and the one method that hands one back is named for it.
//   4. CONCURRENCY — two SIMULTANEOUS binds of the same triple, where exactly one
//      wins and the loser observes a typed `MONITOR_CONNECTION_ALREADY_EXISTS`
//      refusal. Serial, not parallel, is the shape that passes while the bug
//      remains.
//
// ⚠️ CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as the `prodect`
// superuser, which has BYPASSRLS — RLS is INERT under it regardless of `FORCE
// ROW LEVEL SECURITY`. Every tenancy assertion below therefore runs inside a
// transaction that `SET LOCAL ROLE motir_app` (the NOSUPERUSER NOBYPASSRLS role
// the workspace-RLS migration installs). Without the role switch each assertion
// would assert the OPPOSITE of reality and pass. `asAppRole` is a local copy of
// the helper the other RLS suites each carry, for the reason those files give.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

let seq = 0;

interface Tenant {
  userId: string;
  workspaceId: string;
  projectId: string;
  installationRowId: string;
  providerInstallationId: string;
  connectionId: string;
  externalProjectId: string;
  accessToken: string;
}

/** Seed one tenant with a grant and a binding — as the OWNER, so RLS does not
 *  bite during setup and the fixture can build BOTH tenants. That is what makes
 *  the actor's view and the true population differ. */
async function seedTenant(tag: string): Promise<Tenant> {
  const n = seq++;
  const user = await adminDb.user.create({
    data: { name: `User ${tag}`, email: `monitor-${tag}-${n}@example.com` },
  });
  const org = await adminDb.organization.create({
    data: { name: `Org ${tag}`, slug: `monitor-org-${tag}-${n}` },
  });
  await adminDb.organizationMembership.create({
    data: { organizationId: org.id, userId: user.id, role: 'owner' },
  });
  const workspace = await adminDb.workspace.create({
    data: { name: `WS ${tag}`, slug: `monitor-ws-${tag}-${n}`, organizationId: org.id },
  });
  await adminDb.workspaceMembership.create({
    data: { workspaceId: workspace.id, userId: user.id, role: 'owner' },
  });
  const project = await adminDb.project.create({
    data: {
      name: `Project ${tag}`,
      slug: `monitor-p-${tag}-${n}`,
      identifier: `M${tag.toUpperCase()}${n}`,
      workspaceId: workspace.id,
    },
  });
  const accessToken = `access-token-for-${tag}-${n}`;
  const installation = await adminDb.monitorInstallation.create({
    data: {
      provider: 'sentry',
      installationId: `provider-install-${tag}-${n}`,
      workspaceId: workspace.id,
      accessTokenEncrypted: encryptToken(accessToken),
      refreshTokenEncrypted: encryptToken(`refresh-token-for-${tag}-${n}`),
      tokenExpiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
      metadata: { orgSlug: `sentry-org-${tag}` },
    },
  });
  const externalProjectId = `ext-${tag}-${n}`;
  const connection = await adminDb.monitorConnection.create({
    data: {
      installationId: installation.id,
      projectId: project.id,
      workspaceId: workspace.id,
      externalProjectId,
      externalProjectSlug: `sentry-project-${tag}`,
    },
  });

  return {
    userId: user.id,
    workspaceId: workspace.id,
    projectId: project.id,
    installationRowId: installation.id,
    providerInstallationId: installation.installationId,
    connectionId: connection.id,
    externalProjectId,
    accessToken,
  };
}

/**
 * Bind the GUCs `withWorkspaceContext` binds, then DROP to `motir_app` so the
 * policies actually bite. "withWorkspaceContext under the non-bypass role."
 */
async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string; projectId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    await tx.$executeRaw`SELECT set_config('app.project_id', ${ctx.projectId ?? ''}, true)`;
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

describe('monitor_installation / monitor_connection RLS', () => {
  it('shows a workspace only its OWN grants and bindings', async () => {
    const a = await seedTenant('a');
    const b = await seedTenant('b');

    const seenByA = await asAppRole(
      { userId: a.userId, workspaceId: a.workspaceId },
      async (tx) => ({
        installations: await tx.monitorInstallation.findMany(),
        connections: await tx.monitorConnection.findMany(),
      }),
    );

    // The true population is TWO of each; the actor may see exactly one.
    expect(await adminDb.monitorInstallation.count()).toBe(2);
    expect(await adminDb.monitorConnection.count()).toBe(2);
    expect(seenByA.installations.map((i) => i.id)).toEqual([a.installationRowId]);
    expect(seenByA.connections.map((c) => c.id)).toEqual([a.connectionId]);

    const seenByB = await asAppRole(
      { userId: b.userId, workspaceId: b.workspaceId },
      async (tx) => ({
        installations: await tx.monitorInstallation.findMany(),
        connections: await tx.monitorConnection.findMany(),
      }),
    );
    expect(seenByB.installations.map((i) => i.id)).toEqual([b.installationRowId]);
    expect(seenByB.connections.map((c) => c.id)).toEqual([b.connectionId]);
  });

  it('hides the other workspace’s binding even when addressed BY ID', async () => {
    const a = await seedTenant('a');
    const b = await seedTenant('b');

    const found = await asAppRole({ userId: a.userId, workspaceId: a.workspaceId }, (tx) =>
      monitorConnectionRepository.findById(b.connectionId, tx),
    );
    expect(found).toBeNull();

    // And the binding's policy reads its OWN workspace_id — not a join through
    // the grant — so the grant read is a separate proof rather than a corollary.
    const grant = await asAppRole({ userId: a.userId, workspaceId: a.workspaceId }, (tx) =>
      monitorInstallationRepository.findCredentialById(b.installationRowId, tx),
    );
    expect(grant).toBeNull();
  });

  it('refuses a WRITE that would bind another workspace’s row', async () => {
    const a = await seedTenant('a');
    const b = await seedTenant('b');

    await expect(
      asAppRole({ userId: a.userId, workspaceId: a.workspaceId }, (tx) =>
        monitorConnectionRepository.create(
          {
            installationId: a.installationRowId,
            projectId: a.projectId,
            // A row stamped with somebody else's tenancy: the WITH CHECK arm is
            // what refuses it, and it is the half a USING-only policy would miss.
            workspaceId: b.workspaceId,
            externalProjectId: 'ext-forged',
            externalProjectSlug: 'forged',
          },
          tx,
        ),
      ),
    ).rejects.toThrow();
  });
});

describe('monitor credential encryption', () => {
  it('round-trips a token through the shared AES-256-GCM seam', async () => {
    const plaintext = 'sntrys_a-real-looking-token';
    const stored = encryptToken(plaintext);

    expect(stored).not.toContain(plaintext);
    expect(stored.startsWith('v1.')).toBe(true);
    expect(decryptToken(stored)).toBe(plaintext);
  });

  it('encrypts the same token to DIFFERENT bytes each time', () => {
    // A fresh random IV per encryption — so two workspaces storing the same
    // token do not store the same ciphertext, and a ciphertext is not a
    // fingerprint of its plaintext.
    const a = encryptToken('same-token');
    const b = encryptToken('same-token');
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe('same-token');
    expect(decryptToken(b)).toBe('same-token');
  });

  it('THROWS on a tampered payload rather than returning a usable string', () => {
    const stored = encryptToken('sntrys_token');
    const [version, iv, tag, ct] = stored.split('.');
    // Flip the last character of the ciphertext — the auth tag no longer matches.
    const flipped = ct!.slice(0, -1) + (ct!.endsWith('A') ? 'B' : 'A');

    expect(() => decryptToken(`${version}.${iv}.${tag}.${flipped}`)).toThrow();
    expect(() => decryptToken('v9.nope.nope.nope')).toThrow();
    expect(() => decryptToken('not-even-versioned')).toThrow();
  });
});

describe('no read path returns a decrypted — or decryptable — token', () => {
  it('omits both credential columns from the grant SUMMARY read', async () => {
    const a = await seedTenant('a');

    const summaries = await asAppRole({ userId: a.userId, workspaceId: a.workspaceId }, (tx) =>
      monitorInstallationRepository.listSummariesForWorkspace(a.workspaceId, tx),
    );

    expect(summaries).toHaveLength(1);
    const serialized = JSON.stringify(summaries);
    expect(serialized).not.toContain(a.accessToken);
    // Not merely absent-when-decrypted: the ENCRYPTED value is absent too, so
    // nothing downstream can decrypt what it was never handed.
    expect(serialized).not.toContain('v1.');
    expect(Object.keys(summaries[0]!)).not.toContain('accessTokenEncrypted');
    expect(Object.keys(summaries[0]!)).not.toContain('refreshTokenEncrypted');
    // The health triple the settings row draws `degraded` from IS carried.
    expect(summaries[0]!.health).toBe('connected');
  });

  it('omits the credential from the binding list read, grant join included', async () => {
    const a = await seedTenant('a');

    const rows = await asAppRole({ userId: a.userId, workspaceId: a.workspaceId }, (tx) =>
      monitorConnectionRepository.listForProject(a.projectId, tx),
    );

    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(a.accessToken);
    expect(serialized).not.toContain('v1.');
    expect(Object.keys(rows[0]!.installation)).not.toContain('accessTokenEncrypted');
    expect(rows[0]!.installation.health).toBe('connected');
  });

  it('hands a decryptable credential back through the ONE named read', async () => {
    const a = await seedTenant('a');

    const row = await asAppRole({ userId: a.userId, workspaceId: a.workspaceId }, (tx) =>
      monitorInstallationRepository.findCredentialById(a.installationRowId, tx),
    );

    // The single-purpose door: it returns the ENCRYPTED value, and the caller
    // decrypts explicitly. Even here the plaintext is never what the row holds.
    expect(row).not.toBeNull();
    expect(row!.accessTokenEncrypted).not.toContain(a.accessToken);
    expect(decryptToken(row!.accessTokenEncrypted)).toBe(a.accessToken);
  });
});

describe('binding the same monitored project twice', () => {
  it('lets exactly ONE of two SIMULTANEOUS binds win, and refuses the loser by TYPE', async () => {
    const a = await seedTenant('a');
    const externalProjectId = 'ext-contended';

    const bind = () =>
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.workspace_id', ${a.workspaceId}, true)`;
        return monitorConnectionRepository.create(
          {
            installationId: a.installationRowId,
            projectId: a.projectId,
            workspaceId: a.workspaceId,
            externalProjectId,
            externalProjectSlug: 'contended',
          },
          tx,
        );
      });

    // GENUINELY concurrent: both transactions are in flight before either
    // commits, which is the only arrangement in which a check-then-write guard
    // fails. Run serially, this test passes with no constraint at all.
    const results = await Promise.allSettled([bind(), bind()]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // A typed refusal — not a generic 500, and not a silent second row.
    expect(rejected[0]!.reason).toBeInstanceOf(MonitorConnectionAlreadyExistsError);
    expect((rejected[0]!.reason as MonitorConnectionAlreadyExistsError).code).toBe(
      'MONITOR_CONNECTION_ALREADY_EXISTS',
    );
    // ⚠️ AND THE RAW ORM ERROR MUST NOT REACH HERE. This assertion is the one
    // that failed on the first draft: the guard read `meta.target`, which is
    // UNDEFINED under Prisma 7's driver adapter (the constraint name arrives in
    // `meta.driverAdapterError.cause.originalMessage`), so a `P2002` was
    // re-thrown verbatim. Pinning the NEGATIVE as well as the positive is what
    // makes a future client upgrade that moves the field fail here rather than
    // at a customer.
    expect(rejected[0]!.reason).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);

    const rows = await adminDb.monitorConnection.findMany({ where: { externalProjectId } });
    expect(rows).toHaveLength(1);
  });

  it('allows the SAME monitored project on a DIFFERENT Motir project — the set is per project', async () => {
    const a = await seedTenant('a');
    const second = await adminDb.project.create({
      data: {
        name: 'Second project',
        slug: `monitor-p-second-${seq++}`,
        identifier: `MS${seq}`,
        workspaceId: a.workspaceId,
      },
    });

    const created = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${a.workspaceId}, true)`;
      return monitorConnectionRepository.create(
        {
          installationId: a.installationRowId,
          projectId: second.id,
          workspaceId: a.workspaceId,
          externalProjectId: a.externalProjectId,
          externalProjectSlug: 'shared-monitored-project',
        },
        tx,
      );
    });

    expect(created.projectId).toBe(second.id);
    expect(
      await adminDb.monitorConnection.count({ where: { installationId: a.installationRowId } }),
    ).toBe(2);
  });

  it('holds MORE THAN ONE monitored project against ONE Motir project — the SET, not a column', async () => {
    const a = await seedTenant('a');

    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${a.workspaceId}, true)`;
      await monitorConnectionRepository.create(
        {
          installationId: a.installationRowId,
          projectId: a.projectId,
          workspaceId: a.workspaceId,
          externalProjectId: 'ext-worker',
          externalProjectSlug: 'worker',
        },
        tx,
      );
    });

    const rows = await asAppRole({ userId: a.userId, workspaceId: a.workspaceId }, (tx) =>
      monitorConnectionRepository.listForProject(a.projectId, tx),
    );
    expect(rows).toHaveLength(2);
    // Deterministic order by slug, so a render does not reshuffle between reads.
    expect(rows.map((r) => r.externalProjectSlug)).toEqual(['sentry-project-a', 'worker']);
  });
});

describe('disconnecting leaves no orphaned row', () => {
  it('takes the grant’s bindings with it when the grant is removed', async () => {
    const a = await seedTenant('a');

    const removed = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${a.workspaceId}, true)`;
      return monitorInstallationRepository.deleteById(a.installationRowId, tx);
    });

    expect(removed).toBe(1);
    expect(await adminDb.monitorConnection.count()).toBe(0);
    expect(await adminDb.monitorInstallation.count()).toBe(0);
  });

  it('counts a grant’s remaining bindings, so the last one can take it down', async () => {
    const a = await seedTenant('a');

    const { remaining, deleted } = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${a.workspaceId}, true)`;
      const count = await monitorConnectionRepository.deleteById(a.connectionId, tx);
      return {
        deleted: count,
        remaining: await monitorConnectionRepository.countForInstallation(a.installationRowId, tx),
      };
    });

    expect(deleted).toBe(1);
    expect(remaining).toBe(0);

    // A retried disconnect after the row is gone is an idempotent no-op.
    const again = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${a.workspaceId}, true)`;
      return monitorConnectionRepository.deleteById(a.connectionId, tx);
    });
    expect(again).toBe(0);
  });
});

describe('the grant is keyed per provider', () => {
  it('re-authorising the same installation REPLACES its token set in place', async () => {
    const a = await seedTenant('a');

    const refreshed = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${a.workspaceId}, true)`;
      return monitorInstallationRepository.upsertByProviderInstallation(
        {
          provider: 'sentry',
          installationId: a.providerInstallationId,
          workspaceId: a.workspaceId,
          accessTokenEncrypted: encryptToken('rotated-access'),
          refreshTokenEncrypted: encryptToken('rotated-refresh'),
          tokenExpiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000),
        },
        tx,
      );
    });

    // One grant, not two: the credential lives on the grant, so a second row
    // would be a second copy of one secret to rotate.
    expect(await adminDb.monitorInstallation.count()).toBe(1);
    expect(refreshed.id).toBe(a.installationRowId);
    expect(decryptToken(refreshed.accessTokenEncrypted)).toBe('rotated-access');
    // And the binding made on it survives the re-authorisation.
    expect(await adminDb.monitorConnection.count()).toBe(1);
  });
});
