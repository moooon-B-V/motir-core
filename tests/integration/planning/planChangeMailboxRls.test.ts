import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// Cross-tenant isolation on the BOUNDARY MAILBOX, proven AT THE DATABASE (Story
// MOTIR-4054 · MOTIR-4067). The sibling suite proves the service behaviour —
// every read passes `workspaceId`, so a foreign job resolves to an empty
// mailbox. That is a guarantee written in TypeScript, and it holds only as long
// as every future caller remembers the argument. This file proves the layer
// underneath: the `plan_change_mailbox_entry` RLS policy and the COMPOSITE FK
// the migration installed, which hold when the app-level scope is omitted.
//
// The card asks for exactly this — *"asserted through the RLS path this repo's
// convention requires, not by a service-layer check alone"* — and the two halves
// are not interchangeable: the policy carries READ isolation, and the composite
// FK carries the WRITE half that a policy structurally cannot (MOTIR-1735).
//
// ⚠️ The dev/CI DB connects as a SUPERUSER, which has BYPASSRLS — RLS does
// nothing under it regardless of FORCE ROW LEVEL SECURITY. So every assertion
// runs inside a transaction that `SET LOCAL ROLE motir_app`, exactly as
// `planChangeSessionRls.test.ts` does. Without the role switch each assertion
// below would assert the OPPOSITE of reality.

let a: WorkItemFixture;
let b: WorkItemFixture;
let sessionA: { id: string };
let sessionB: { id: string };

const JOB_A = 'job-a';
const JOB_B = 'job-b';

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

/** One thread per tenant, each mid-run, each with one waiting turn. Seeded as
 *  the superuser: the seeding path is not what is under test, the isolation is. */
async function seedMailboxes(): Promise<void> {
  const make = async (fx: WorkItemFixture, jobId: string, text: string) => {
    const session = await adminDb.planChangeSession.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        createdById: fx.ownerId,
        lastJobId: jobId,
        lastSubmittedAt: new Date(),
      },
    });
    await adminDb.planChangeMailboxEntry.create({
      data: {
        workspaceId: fx.workspaceId,
        sessionId: session.id,
        jobId,
        seq: 0,
        kind: 'turn',
        body: text,
        disposition: 'fold',
        idempotencyKey: 'seed',
        authorId: fx.ownerId,
      },
    });
    return session;
  };
  sessionA = await make(a, JOB_A, 'Tenant A: also add the audit trail');
  sessionB = await make(b, JOB_B, 'Tenant B: drop the reporting story');
}

beforeEach(async () => {
  await truncateAuthTables();
  a = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
  b = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
  await seedMailboxes();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('plan_change_mailbox_entry RLS — reads', () => {
  it('with NO workspace GUC set, the app role sees zero entries', async () => {
    // The safe failure the policy is written for: `current_setting(…, true)`
    // yields NULL when unset, the predicate is NULL, and every row is hidden. A
    // missing context leaks nothing rather than leaking everything — which
    // matters more here than on most tables, because the rows ARE user prose.
    expect(await asAppRole({}, (tx) => tx.planChangeMailboxEntry.findMany())).toEqual([]);
  });

  it('tenant A sees only its OWN mailbox, never tenant B’s', async () => {
    const rows = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.planChangeMailboxEntry.findMany(),
    );
    expect(rows.map((r) => r.body)).toEqual(['Tenant A: also add the audit trail']);
  });

  it('a GUESSED session id reveals nothing — the child carries its own policy', async () => {
    // The load-bearing case for denormalizing `workspace_id` onto the entry: RLS
    // does not traverse foreign keys, so a mailbox leaning on its session's
    // policy would be readable cross-tenant by anyone who guesses a session id.
    const rows = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.planChangeMailboxEntry.findMany({ where: { sessionId: sessionB.id } }),
    );
    expect(rows).toEqual([]);
  });

  it('a GUESSED job id reveals nothing either — the mailbox is not addressable by job alone', async () => {
    // `job_id` is an opaque token that travels in a stream URL, so it is the
    // likeliest thing to leak. It is not a capability.
    const rows = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.planChangeMailboxEntry.findMany({ where: { jobId: JOB_B } }),
    );
    expect(rows).toEqual([]);
  });
});

describe('plan_change_mailbox_entry — the COMPOSITE FK (the write half a policy cannot carry)', () => {
  it('tenant A cannot plant an entry of its OWN tenancy under tenant B’s session', async () => {
    // RLS alone could not stop this: the `WITH CHECK` half validates only the
    // row's own `workspace_id`, and RLS does not traverse foreign keys. So an
    // entry labelled with A's workspace but pointing at B's session would pass
    // every policy — and, because `(session_id, job_id, seq)` is UNIQUE and a
    // unique index is enforced WITHOUT RLS, it would claim a seq slot B can never
    // use. B's next append collides, rolls back, and re-collides for ever: the
    // victim's RUN is wedged, invisibly. That is an availability attack, and the
    // reason the FK references the PAIR.
    await expect(
      asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
        tx.planChangeMailboxEntry.create({
          data: {
            workspaceId: a.workspaceId,
            sessionId: sessionB.id,
            jobId: JOB_B,
            seq: 1,
            kind: 'turn',
            body: 'injected',
            disposition: 'fold',
            idempotencyKey: 'evil',
            authorId: a.ownerId,
          },
        }),
      ),
    ).rejects.toThrow(/[Ff]oreign key/);

    expect(await adminDb.planChangeMailboxEntry.count({ where: { sessionId: sessionB.id } })).toBe(
      1,
    );
  });

  it('tenant A cannot RE-POINT one of its own entries at tenant B’s session', async () => {
    // The UPDATE face of the same hole. A owns this row, so the policy's `USING`
    // half lets A see and update it — only the composite FK stops `session_id`
    // from being rewritten to a foreign session.
    const own = await adminDb.planChangeMailboxEntry.findFirstOrThrow({
      where: { sessionId: sessionA.id },
    });

    await expect(
      asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
        tx.planChangeMailboxEntry.update({
          where: { id: own.id },
          data: { sessionId: sessionB.id },
        }),
      ),
    ).rejects.toThrow(/[Ff]oreign key/);

    const after = await adminDb.planChangeMailboxEntry.findUniqueOrThrow({ where: { id: own.id } });
    expect(after.sessionId).toBe(sessionA.id);
  });

  it('⚠️ and it holds for the SUPERUSER too — the layer beneath the policies', async () => {
    // Unlike a policy, a constraint is not bypassed by BYPASSRLS. This is the
    // whole reason the fix is structural rather than a `WITH CHECK … EXISTS`
    // subquery.
    await expect(
      adminDb.planChangeMailboxEntry.create({
        data: {
          workspaceId: a.workspaceId,
          sessionId: sessionB.id,
          jobId: JOB_B,
          seq: 2,
          kind: 'turn',
          body: 'injected as superuser',
          disposition: 'fold',
          idempotencyKey: 'evil-2',
        },
      }),
    ).rejects.toThrow(/[Ff]oreign key/);
  });
});

describe('plan_change_mailbox_entry — the CONSUMING write is scoped too', () => {
  it('tenant A’s consume of tenant B’s entries claims nothing', async () => {
    // The read door STAMPS what it returns, so a scope hole here would be worse
    // than a leak: it would swallow another tenant's turn, and the run it was
    // meant for would never see it. Reads are the policy's job — B's rows are
    // invisible under A's GUC — so the scoped update matches zero.
    const result = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.planChangeMailboxEntry.updateMany({
        where: { sessionId: sessionB.id, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
    );
    expect(result.count).toBe(0);

    const bs = await adminDb.planChangeMailboxEntry.findFirstOrThrow({
      where: { sessionId: sessionB.id },
    });
    expect(bs.consumedAt).toBeNull();
  });

  it('tenant A’s DELETE of tenant B’s mailbox removes nothing', async () => {
    const result = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.planChangeMailboxEntry.deleteMany({ where: { sessionId: sessionB.id } }),
    );
    expect(result.count).toBe(0);
    expect(await adminDb.planChangeMailboxEntry.count({ where: { sessionId: sessionB.id } })).toBe(
      1,
    );
  });
});
