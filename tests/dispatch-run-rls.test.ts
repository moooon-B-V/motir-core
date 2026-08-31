import type { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';

// `dispatch_run` / `dispatch_run_card` / `dispatch_run_event` RLS — direct-DB
// tenancy proof (Story MOTIR-1789 · MOTIR-1791).
//
// The companion to `tests/work-item-rls.test.ts` for the three tables the
// dispatch-run migration adds. It proves the property the migration exists to
// give them: a second workspace cannot READ or WRITE the first's runs, legs or
// events, on tables whose policies land in the SAME migration that creates them.
//
// ⚠️ CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as the `prodect`
// superuser, which has BYPASSRLS — RLS is INERT under it regardless of `FORCE
// ROW LEVEL SECURITY`. Every assertion below therefore runs inside a transaction
// that `SET LOCAL ROLE motir_app` (the NOSUPERUSER NOBYPASSRLS role the
// workspace-RLS migration installs). Without the role switch each assertion
// would assert the OPPOSITE of reality and pass. `asAppRole` is a local copy of
// the helper the other RLS suites each carry, for the reason those files give.
//
// ⚠️ AND THE THREE TABLES ARE GATED ON THEIR OWN `workspace_id`, NOT on a join
// through `dispatch_run` — RLS does not traverse foreign keys. The leg and the
// event tests below are therefore not redundant with the run's: a policy written
// as a join would pass the first and fail those two.

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
  workItemId: string;
  runId: string;
  cardId: string;
  eventId: string;
}

/** Seed one tenant with a run, a leg and an event — as the OWNER, so RLS does
 *  not bite during setup and the fixture can build both tenants. */
async function seedTenant(tag: string): Promise<Tenant> {
  const n = seq++;
  const user = await adminDb.user.create({
    data: { name: `User ${tag}`, email: `run-rls-${tag}-${n}@example.com` },
  });
  const org = await adminDb.organization.create({
    data: { name: `Org ${tag}`, slug: `run-rls-org-${tag}-${n}` },
  });
  await adminDb.organizationMembership.create({
    data: { organizationId: org.id, userId: user.id, role: 'owner' },
  });
  const workspace = await adminDb.workspace.create({
    data: { name: `WS ${tag}`, slug: `run-rls-ws-${tag}-${n}`, organizationId: org.id },
  });
  await adminDb.workspaceMembership.create({
    data: { workspaceId: workspace.id, userId: user.id, role: 'owner' },
  });
  const project = await adminDb.project.create({
    data: {
      name: `Project ${tag}`,
      slug: `run-rls-p-${tag}-${n}`,
      identifier: `R${tag}${n}`,
      workspaceId: workspace.id,
    },
  });
  // A story, then the subtask under it — the structural trigger refuses a
  // parentless subtask, and this fixture is not about that rule.
  const story = await adminDb.workItem.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      reporterId: user.id,
      kind: 'story',
      key: 1,
      identifier: `${project.identifier}-1`,
      title: `Story ${tag}`,
      position: `a${n}s`,
    },
  });
  const item = await adminDb.workItem.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      reporterId: user.id,
      parentId: story.id,
      kind: 'subtask',
      key: 2,
      identifier: `${project.identifier}-2`,
      title: `Card ${tag}`,
      position: `a${n}`,
    },
  });
  const run = await adminDb.dispatchRun.create({
    data: {
      workspaceId: workspace.id,
      projectId: project.id,
      command: 'run_scope',
      scopeLabel: `${project.identifier}-1`,
      createdById: user.id,
    },
  });
  const card = await adminDb.dispatchRunCard.create({
    data: {
      workspaceId: workspace.id,
      dispatchRunId: run.id,
      workItemId: item.id,
      workItemKey: `${project.identifier}-2`,
      position: 0,
    },
  });
  const event = await adminDb.dispatchRunEvent.create({
    data: {
      workspaceId: workspace.id,
      dispatchRunId: run.id,
      dispatchRunCardId: card.id,
      seq: 1,
      kind: 'run_opened',
      body: `secret output for ${tag}`,
    },
  });

  return {
    userId: user.id,
    workspaceId: workspace.id,
    projectId: project.id,
    workItemId: item.id,
    runId: run.id,
    cardId: card.id,
    eventId: event.id,
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

describe('dispatch_run RLS', () => {
  it('shows a workspace only its own runs, legs and events', async () => {
    const a = await seedTenant('a');
    const b = await seedTenant('b');

    const seenByA = await asAppRole(
      { userId: a.userId, workspaceId: a.workspaceId },
      async (tx) => ({
        runs: await tx.dispatchRun.findMany(),
        cards: await tx.dispatchRunCard.findMany(),
        events: await tx.dispatchRunEvent.findMany(),
      }),
    );

    expect(seenByA.runs.map((r) => r.id)).toEqual([a.runId]);
    expect(seenByA.cards.map((c) => c.id)).toEqual([a.cardId]);
    expect(seenByA.events.map((e) => e.id)).toEqual([a.eventId]);
    // The one field that would be an actual disclosure: the opt-in log body.
    expect(seenByA.events[0]!.body).toBe('secret output for a');

    const seenByB = await asAppRole(
      { userId: b.userId, workspaceId: b.workspaceId },
      async (tx) => ({
        runs: await tx.dispatchRun.findMany(),
        cards: await tx.dispatchRunCard.findMany(),
        events: await tx.dispatchRunEvent.findMany(),
      }),
    );
    expect(seenByB.runs.map((r) => r.id)).toEqual([b.runId]);
    expect(seenByB.cards.map((c) => c.id)).toEqual([b.cardId]);
    expect(seenByB.events.map((e) => e.id)).toEqual([b.eventId]);
  });

  it('hides the other workspace’s run even when addressed BY ID', async () => {
    const a = await seedTenant('a');
    const b = await seedTenant('b');

    // A keyed read is the shape a route takes from a URL, so it is the one that
    // matters: a policy that filters lists but answers a direct id is not a
    // tenancy gate, it is a sort order.
    const byId = await asAppRole({ userId: a.userId, workspaceId: a.workspaceId }, (tx) =>
      tx.dispatchRun.findUnique({ where: { id: b.runId } }),
    );
    expect(byId).toBeNull();

    const legById = await asAppRole({ userId: a.userId, workspaceId: a.workspaceId }, (tx) =>
      tx.dispatchRunCard.findUnique({ where: { id: b.cardId } }),
    );
    expect(legById).toBeNull();

    const eventById = await asAppRole({ userId: a.userId, workspaceId: a.workspaceId }, (tx) =>
      tx.dispatchRunEvent.findUnique({ where: { id: b.eventId } }),
    );
    expect(eventById).toBeNull();
  });

  it('refuses a WRITE into the other workspace — the `WITH CHECK` half', async () => {
    const a = await seedTenant('a');
    const b = await seedTenant('b');

    await expect(
      asAppRole({ userId: a.userId, workspaceId: a.workspaceId }, (tx) =>
        tx.dispatchRun.create({
          data: {
            workspaceId: b.workspaceId,
            projectId: b.projectId,
            command: 'auto',
          },
        }),
      ),
    ).rejects.toThrow();

    await expect(
      asAppRole({ userId: a.userId, workspaceId: a.workspaceId }, (tx) =>
        tx.dispatchRunEvent.create({
          data: {
            workspaceId: b.workspaceId,
            dispatchRunId: b.runId,
            seq: 99,
            kind: 'log',
            body: 'injected',
          },
        }),
      ),
    ).rejects.toThrow();

    // Nothing landed.
    expect(await adminDb.dispatchRun.count({ where: { workspaceId: b.workspaceId } })).toBe(1);
    expect(await adminDb.dispatchRunEvent.count({ where: { workspaceId: b.workspaceId } })).toBe(1);
  });

  it('cannot UPDATE or DELETE across the boundary — the update matches no row', async () => {
    const a = await seedTenant('a');
    const b = await seedTenant('b');

    const updated = await asAppRole({ userId: a.userId, workspaceId: a.workspaceId }, (tx) =>
      tx.dispatchRun.updateMany({
        where: { id: b.runId },
        data: { status: 'cancelled', stopReason: 'interrupted' },
      }),
    );
    expect(updated.count).toBe(0);

    const deleted = await asAppRole({ userId: a.userId, workspaceId: a.workspaceId }, (tx) =>
      tx.dispatchRunEvent.deleteMany({ where: { id: b.eventId } }),
    );
    expect(deleted.count).toBe(0);

    const stillThere = await adminDb.dispatchRun.findUnique({ where: { id: b.runId } });
    expect(stillThere?.status).toBe('running');
    expect(await adminDb.dispatchRunEvent.count({ where: { id: b.eventId } })).toBe(1);
  });

  it('gates the CHILD tables on their OWN workspace column, not on a join', async () => {
    const a = await seedTenant('a');
    const b = await seedTenant('b');

    // A leg whose `workspace_id` says A but whose RUN belongs to B. Seeded as
    // the owner, because it is precisely the row a policy written as a join
    // through `dispatch_run` would hide from A and show to B — the inverse of
    // what the column says. It is corrupt data by construction; the point is
    // WHICH gate decides, and the answer must be the row's own column.
    const crossed = await adminDb.dispatchRunCard.create({
      data: {
        workspaceId: a.workspaceId,
        dispatchRunId: b.runId,
        position: 1,
        workItemKey: 'CROSSED-1',
      },
    });

    const seenByA = await asAppRole({ userId: a.userId, workspaceId: a.workspaceId }, (tx) =>
      tx.dispatchRunCard.findMany({ where: { id: crossed.id } }),
    );
    const seenByB = await asAppRole({ userId: b.userId, workspaceId: b.workspaceId }, (tx) =>
      tx.dispatchRunCard.findMany({ where: { id: crossed.id } }),
    );

    expect(seenByA).toHaveLength(1);
    expect(seenByB).toHaveLength(0);
  });

  it('shows NOTHING when no workspace is bound — the unbound read is empty, never everything', async () => {
    await seedTenant('a');
    await seedTenant('b');

    // The failure mode this whole `tx`-on-reads convention exists for: a read
    // outside a bound context returns an EMPTY LIST, which is indistinguishable
    // from "this project has never been run". It must never be a read of
    // everything.
    const unbound = await asAppRole({}, async (tx) => ({
      runs: await tx.dispatchRun.findMany(),
      cards: await tx.dispatchRunCard.findMany(),
      events: await tx.dispatchRunEvent.findMany(),
    }));

    expect(unbound.runs).toHaveLength(0);
    expect(unbound.cards).toHaveLength(0);
    expect(unbound.events).toHaveLength(0);
  });
});
