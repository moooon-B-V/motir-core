import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { publicFollowRepository } from '@/lib/repositories/publicFollowRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// Story 8.9 · Subtask 8.9.3 — `public_follow`'s two database-level guarantees
// (`docs/decisions/public-follow-and-changelog.md` §1 AMENDMENT 1 and §7).
// Real Postgres, no mocks.
//
// Both guarantees are things a SERVICE could also enforce, and both are here
// because the service is not the last line:
//
//   1. EXACTLY ONE IDENTITY — a row is an account follow or an email-only
//      follow, never both and never neither. The "neither" row is the dangerous
//      one: no digest sweep and no unsubscribe path can address it.
//   2. NO ANONYMOUS READ — the table holds email addresses belonging to people
//      with no account, so an unbound connection must see nothing at all.
//      `public_request_vote`, the other public-write table, deliberately DOES
//      have an unbound arm; copying it here would have made the follower list
//      enumerable, which is what AMENDMENT 1 records.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB may connect as a superuser,
// which has BYPASSRLS — RLS is inert under it regardless of FORCE ROW LEVEL
// SECURITY. The RLS assertions therefore run inside a transaction that
// `SET LOCAL ROLE motir_app`, the same local `asAppRole` helper the other RLS
// suites in this repo each carry.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

async function makePublicProjectFixture(
  name: string,
  identifier: string,
): Promise<WorkItemFixture> {
  const fx = await makeWorkItemFixture({ name, identifier });
  await adminDb.project.update({ where: { id: fx.projectId }, data: { accessLevel: 'public' } });
  return fx;
}

/** Seed one follow row directly, bypassing the service (which 8.9.5 owns). */
async function seedFollow(
  fx: WorkItemFixture,
  data: { userId?: string | null; email?: string | null; digestOptIn?: boolean },
) {
  return adminDb.publicFollow.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      userId: data.userId ?? null,
      email: data.email ?? null,
      digestOptIn: data.digestOptIn ?? false,
      confirmedAt: data.userId ? new Date() : null,
    },
  });
}

describe('the identity CHECK constraint', () => {
  it('rejects a row carrying BOTH an account and an address', async () => {
    const fx = await makePublicProjectFixture('Acme', 'ACME');
    await expect(
      seedFollow(fx, { userId: fx.ownerId, email: 'someone@example.com' }),
    ).rejects.toThrow();
  });

  it('rejects a row carrying NEITHER — the unreachable row', async () => {
    const fx = await makePublicProjectFixture('Acme', 'ACME');
    // This is the case the constraint exists for: no digest sweep and no
    // unsubscribe path can ever address such a row, so it is not merely wrong,
    // it is undeletable through any product surface.
    await expect(seedFollow(fx, {})).rejects.toThrow();
  });

  it('accepts each tier on its own', async () => {
    const fx = await makePublicProjectFixture('Acme', 'ACME');
    const account = await seedFollow(fx, { userId: fx.ownerId });
    const emailOnly = await seedFollow(fx, { email: 'reader@example.com' });

    expect(account.email).toBeNull();
    expect(emailOnly.userId).toBeNull();
    // An email-only follow starts UNCONFIRMED — it is not an audience until the
    // confirmation link is followed.
    expect(emailOnly.confirmedAt).toBeNull();
  });

  it('allows the same address to follow two different projects', async () => {
    const a = await makePublicProjectFixture('Acme', 'ACME');
    const b = await makePublicProjectFixture('Other', 'OTHR');
    await seedFollow(a, { email: 'reader@example.com' });
    await expect(seedFollow(b, { email: 'reader@example.com' })).resolves.toBeTruthy();
  });

  it('refuses a SECOND follow of one project by the same address', async () => {
    const fx = await makePublicProjectFixture('Acme', 'ACME');
    await seedFollow(fx, { email: 'reader@example.com' });
    await expect(seedFollow(fx, { email: 'reader@example.com' })).rejects.toThrow();
  });

  it('does NOT let one tier constrain the other — many NULLs coexist', async () => {
    const fx = await makePublicProjectFixture('Acme', 'ACME');
    const second = await createTestUser();
    // Two account rows both have `email = NULL` under `@@unique([projectId, email])`.
    // Postgres treats NULLs as distinct in a unique index, which is what makes
    // one table with two nullable identity columns workable at all.
    await seedFollow(fx, { userId: fx.ownerId });
    await expect(seedFollow(fx, { userId: second.id })).resolves.toBeTruthy();
  });
});

describe('public_follow RLS — a workspace gate, and deliberately no anonymous arm', () => {
  it('an UNBOUND connection sees NOTHING — the follower list is not enumerable', async () => {
    const fx = await makePublicProjectFixture('Acme', 'ACME');
    await seedFollow(fx, { email: 'reader@example.com' });
    await seedFollow(fx, { userId: fx.ownerId });
    expect(await adminDb.publicFollow.count()).toBe(2);

    // The project IS public and the connection has no workspace bound — exactly
    // the state an anonymous public request arrives in, and exactly the state
    // `public_request_vote`'s public arm fires on. This table has no such arm,
    // so the answer is empty rather than the whole list.
    const rows = await asAppRole({}, (tx) => tx.publicFollow.findMany());
    expect(rows).toEqual([]);
  });

  it('a BOUND workspace sees its own rows and no other tenant’s', async () => {
    const a = await makePublicProjectFixture('Acme', 'ACME');
    const b = await makePublicProjectFixture('Other', 'OTHR');
    await seedFollow(a, { email: 'a-reader@example.com' });
    await seedFollow(b, { email: 'b-reader@example.com' });
    expect(await adminDb.publicFollow.count()).toBe(2);

    const rows = await asAppRole({ workspaceId: a.workspaceId }, (tx) =>
      tx.publicFollow.findMany(),
    );
    expect(rows.map((r) => r.email)).toEqual(['a-reader@example.com']);
  });

  it('refuses a write that would land the row in ANOTHER workspace', async () => {
    const a = await makePublicProjectFixture('Acme', 'ACME');
    const b = await makePublicProjectFixture('Other', 'OTHR');

    // `WITH CHECK` governs the post-image, so binding tenant A and writing a row
    // stamped with tenant B's workspace is refused rather than silently landing.
    await expect(
      asAppRole({ workspaceId: a.workspaceId }, (tx) =>
        tx.publicFollow.create({
          data: {
            workspaceId: b.workspaceId,
            projectId: b.projectId,
            email: 'smuggled@example.com',
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('publicFollowRepository', () => {
  it('finds a follow by account, by address, and by either token hash', async () => {
    const fx = await makePublicProjectFixture('Acme', 'ACME');
    const account = await seedFollow(fx, { userId: fx.ownerId });
    const emailOnly = await adminDb.publicFollow.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        email: 'reader@example.com',
        confirmTokenHash: 'confirm-hash',
        confirmTokenExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    await withWorkspaceServiceContext(fx.workspaceId, async (tx) => {
      expect(
        (await publicFollowRepository.findByProjectAndUser(fx.projectId, fx.ownerId, tx))?.id,
      ).toBe(account.id);
      expect(
        (await publicFollowRepository.findByProjectAndEmail(fx.projectId, 'reader@example.com', tx))
          ?.id,
      ).toBe(emailOnly.id);
      expect((await publicFollowRepository.findByConfirmTokenHash('confirm-hash', tx))?.id).toBe(
        emailOnly.id,
      );
      expect((await publicFollowRepository.findById(emailOnly.id, tx))?.id).toBe(emailOnly.id);
      expect(await publicFollowRepository.countByProject(fx.projectId, tx)).toBe(2);
    });
  });

  it('counts as the digest audience ONLY confirmed opt-ins', async () => {
    const fx = await makePublicProjectFixture('Acme', 'ACME');
    // Opted in and confirmed — the audience.
    await adminDb.publicFollow.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        email: 'yes@example.com',
        digestOptIn: true,
        confirmedAt: new Date(),
      },
    });
    // Opted in but NEVER confirmed the address — must not be mailed. This is
    // the check that keeps a mistyped address from receiving a digest, and it
    // lives in the read rather than in the mailer.
    await adminDb.publicFollow.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        email: 'unconfirmed@example.com',
        digestOptIn: true,
        confirmedAt: null,
      },
    });
    // Following, but not subscribed: following is not subscribing.
    await seedFollow(fx, { userId: fx.ownerId, digestOptIn: false });

    const audience = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      publicFollowRepository.findDigestAudience(fx.projectId, { take: 50 }, tx),
    );
    expect(audience.map((f) => f.email)).toEqual(['yes@example.com']);
  });

  it('sweeps unconfirmed rows older than the cutoff, and leaves fresh ones', async () => {
    const fx = await makePublicProjectFixture('Acme', 'ACME');
    const old = new Date('2026-08-01T00:00:00.000Z');
    await adminDb.publicFollow.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        email: 'stale@example.com',
        confirmedAt: null,
        createdAt: old,
      },
    });
    await adminDb.publicFollow.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        email: 'fresh@example.com',
        confirmedAt: null,
      },
    });
    // Confirmed and old — must survive, or the sweep would delete real followers.
    await adminDb.publicFollow.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        email: 'confirmed@example.com',
        confirmedAt: old,
        createdAt: old,
      },
    });

    const deleted = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.system_admin', 'true', true)`;
      return publicFollowRepository.deleteUnconfirmedBefore(
        new Date('2026-08-10T00:00:00.000Z'),
        tx,
      );
    });

    expect(deleted).toBe(1);
    const left = await adminDb.publicFollow.findMany({ orderBy: { email: 'asc' } });
    expect(left.map((f) => f.email)).toEqual(['confirmed@example.com', 'fresh@example.com']);
  });
});
