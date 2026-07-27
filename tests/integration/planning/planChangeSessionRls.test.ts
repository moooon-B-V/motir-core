import { Prisma } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { truncateAuthTables } from '../../helpers/db';

// Cross-tenant isolation on the conversation tables, proven AT THE DATABASE
// (Story 7.30 · MOTIR-1732). MOTIR-1728's suite proves the APPLICATION scope —
// every repository read passes `workspaceId`, so a foreign project resolves to
// null. That is a guarantee written in TypeScript, and it holds only as long as
// every future caller remembers to pass the argument. This file proves the layer
// underneath it: the `plan_change_session` / `plan_change_turn` RLS policies the
// migration installed, which hold even when the app-level scope is omitted.
//
// ⚠️ The dev/CI DB connects as the `prodect` SUPERUSER, which has BYPASSRLS —
// RLS does nothing under it regardless of FORCE ROW LEVEL SECURITY. So every
// assertion runs inside a transaction that `SET LOCAL ROLE prodect_app` (the
// NOSUPERUSER NOBYPASSRLS role the workspace-RLS migration created), exactly as
// `tests/multi-tenant-rls.test.ts` and `tests/workspace-rls.test.ts` do. Without
// the role switch each assertion below would assert the OPPOSITE of reality.

let a: WorkItemFixture;
let b: WorkItemFixture;
let sessionA: { id: string };
let sessionB: { id: string };

/**
 * Run `fn` under the non-bypass app role, with the workspace GUC the policies
 * read optionally pinned. Mirrors the shared `asAppRole` helper.
 */
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
    await tx.$executeRawUnsafe('SET LOCAL ROLE prodect_app');
    return fn(tx);
  });
}

/** Seed one conversation per tenant, as the superuser (the seeding path is not
 *  what is under test — the READ/WRITE isolation is). */
async function seedConversations(): Promise<void> {
  const make = async (fx: WorkItemFixture, body: string) => {
    const session = await db.planChangeSession.create({
      data: { workspaceId: fx.workspaceId, projectId: fx.projectId, createdById: fx.ownerId },
    });
    await db.planChangeTurn.create({
      data: {
        workspaceId: fx.workspaceId,
        sessionId: session.id,
        seq: 0,
        role: 'user',
        body,
        authorId: fx.ownerId,
      },
    });
    await db.planChangeSession.update({
      where: { id: session.id },
      data: { turnCount: 1 },
    });
    return session;
  };
  sessionA = await make(a, 'Tenant A: split the billing epic');
  sessionB = await make(b, 'Tenant B: add a reporting story');
}

beforeEach(async () => {
  await truncateAuthTables();
  a = await makeWorkItemFixture({ name: 'Acme', identifier: 'PROD' });
  b = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
  await seedConversations();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('plan_change_session RLS — reads', () => {
  it('with NO workspace GUC set, the app role sees zero conversations', async () => {
    // The safe failure the policy is written for: `current_setting(…, true)`
    // yields NULL when unset, the predicate is NULL, and every row is hidden.
    // A missing context leaks nothing rather than leaking everything.
    expect(await asAppRole({}, (tx) => tx.planChangeSession.findMany())).toEqual([]);
    expect(await asAppRole({}, (tx) => tx.planChangeTurn.findMany())).toEqual([]);
  });

  it('tenant A sees only its OWN conversation, never tenant B’s', async () => {
    const rows = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.planChangeSession.findMany(),
    );
    expect(rows.map((r) => r.id)).toEqual([sessionA.id]);
  });

  it('tenant A cannot read tenant B’s conversation even BY ITS ID', async () => {
    // The app-level `workspaceId` argument is deliberately NOT supplied here:
    // this is the DB's own guarantee, the one that survives a caller who forgets.
    const rows = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.planChangeSession.findMany({ where: { id: sessionB.id } }),
    );
    expect(rows).toEqual([]);
  });

  it('the TURN table carries its own policy — a guessed session id reveals nothing', async () => {
    // The load-bearing case for denormalizing `workspace_id` onto the child:
    // RLS does not traverse foreign keys, so a turn table leaning on its
    // session's policy would be readable cross-tenant by anyone who guesses a
    // session id.
    const turns = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.planChangeTurn.findMany({ where: { sessionId: sessionB.id } }),
    );
    expect(turns).toEqual([]);

    const own = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.planChangeTurn.findMany({ where: { sessionId: sessionA.id } }),
    );
    expect(own.map((t) => t.body)).toEqual(['Tenant A: split the billing epic']);
  });
});

describe('plan_change_session RLS — writes', () => {
  it('⚠️ KNOWN GAP (MOTIR-1735): a turn labelled with A’s workspace can point at B’s session', async () => {
    // This test pins SHIPPED REALITY, not the invariant we want — and it is the
    // reason MOTIR-1735 exists.
    //
    // The `WITH CHECK` half of `plan_change_turn_active_workspace` validates only
    // the row's OWN `workspace_id`. Nothing checks that `session_id` belongs to
    // that workspace, and RLS does not traverse foreign keys (the FK check runs
    // as the table owner, RLS bypassed). So tenant A CAN plant a turn of its own
    // tenancy under tenant B's session — and because `(session_id, seq)` is
    // UNIQUE and that index is enforced without RLS, the planted row claims a
    // seq slot B can never use, wedging B's thread (`PlanChangeTurnConflictError`
    // on every retry, since B's `turnCount` never advances).
    //
    // Not reachable through the shipped app — the service always resolves the
    // session by `(projectId, workspaceId)` first and no route accepts a session
    // id — so this is a defence-in-depth gap, fixed by a migration in MOTIR-1735
    // (out of scope for a test card; `notes.html` mistake #27). When that lands,
    // this case becomes a `.rejects.toThrow()`.
    const planted = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.planChangeTurn.create({
        data: {
          workspaceId: a.workspaceId,
          sessionId: sessionB.id,
          seq: 1,
          role: 'user',
          body: 'injected',
          authorId: a.ownerId,
        },
      }),
    );
    expect(planted.workspaceId).toBe(a.workspaceId);

    // What DOES hold, and is the reason this is availability-not-confidentiality:
    // the planted row is invisible to B, and B's own turn is invisible to A.
    const bSees = await asAppRole({ userId: b.ownerId, workspaceId: b.workspaceId }, (tx) =>
      tx.planChangeTurn.findMany({ where: { sessionId: sessionB.id } }),
    );
    expect(bSees.map((t) => t.body)).toEqual(['Tenant B: add a reporting story']);
  });

  it('tenant A cannot INSERT a row labelled with tenant B’s workspace', async () => {
    await expect(
      asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
        tx.planChangeSession.create({
          data: {
            workspaceId: b.workspaceId,
            projectId: b.projectId,
            createdById: a.ownerId,
          },
        }),
      ),
    ).rejects.toThrow();

    expect(await db.planChangeSession.count({ where: { workspaceId: b.workspaceId } })).toBe(1);
  });

  it('tenant A’s UPDATE of tenant B’s conversation touches nothing', async () => {
    // A scoped `updateMany` is the honest probe: the row is invisible under A's
    // GUC, so the statement matches zero rows rather than rewriting B's thread.
    const result = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.planChangeSession.updateMany({
        where: { id: sessionB.id },
        data: { lastJobId: 'job-hijack' },
      }),
    );
    expect(result.count).toBe(0);

    const untouched = await db.planChangeSession.findUnique({ where: { id: sessionB.id } });
    expect(untouched?.lastJobId).toBeNull();
  });

  it('tenant A’s DELETE of tenant B’s conversation removes nothing', async () => {
    const result = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.planChangeSession.deleteMany({ where: { id: sessionB.id } }),
    );
    expect(result.count).toBe(0);
    expect(await db.planChangeSession.count({ where: { id: sessionB.id } })).toBe(1);
  });

  it('tenant A CAN write its own thread — the policy gates, it does not block', async () => {
    // The control: without this, every assertion above would pass on a table
    // nobody can write at all.
    const turn = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.planChangeTurn.create({
        data: {
          workspaceId: a.workspaceId,
          sessionId: sessionA.id,
          seq: 1,
          role: 'user',
          body: 'and make them smaller',
          authorId: a.ownerId,
        },
      }),
    );
    expect(turn.seq).toBe(1);
    expect(await db.planChangeTurn.count({ where: { sessionId: sessionA.id } })).toBe(2);
  });
});
