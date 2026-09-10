import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { makeWorkItemFixture } from './fixtures';
import { adminDb } from './helpers/adminDb';
import { truncateAuthTables } from './helpers/db';
import { armedTables } from './rls/policyArms';

// `plan_revision` RLS — direct-DB tenancy proof (Story MOTIR-3532 · MOTIR-3535).
//
// The table has NO `workspace_id` column of its own, deliberately: denormalizing
// tenancy onto a revision row would let it lie about which workspace it belongs
// to (the decision `work_item_revision` made first). Its policy therefore JOINS
// to the parent `plan`, which makes it the one shape a column-shaped RLS test
// cannot check by inspection — hence this file.
//
// CRITICAL (PRODECT_FINDINGS #5): the dev/CI DB connects as a superuser, which
// has BYPASSRLS — RLS is inert under it regardless of FORCE ROW LEVEL SECURITY.
// Every assertion below therefore runs inside a transaction that
// `SET LOCAL ROLE motir_app`. Without the role switch each one would assert the
// OPPOSITE of reality. `asAppRole` is a local copy of the helper in
// `tests/work-item-rls.test.ts` / `tests/project-rls.test.ts` — the RLS suites
// each carry their own; see those files for why it is not hoisted yet.

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function asAppRole<T>(
  ctx: { userId?: string; workspaceId?: string; projectId?: string; systemAdmin?: boolean },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(async (tx) => {
    if (ctx.userId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${ctx.userId}, true)`;
    }
    if (ctx.workspaceId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ctx.workspaceId}, true)`;
    }
    if (ctx.projectId !== undefined) {
      await tx.$executeRaw`SELECT set_config('app.project_id', ${ctx.projectId}, true)`;
    }
    // `withSystemContext`'s binding, and it is a CONSTANT there — never user
    // input (lib/workspaces/context.ts), which is what keeps a tenant from
    // elevating itself into the arm the second describe block covers.
    if (ctx.systemAdmin === true) {
      await tx.$executeRaw`SELECT set_config('app.system_admin', 'true', true)`;
    }
    await tx.$executeRawUnsafe('SET LOCAL ROLE motir_app');
    return fn(tx);
  });
}

/** Two independent tenants, each with a plan that has already written its trail. */
async function twoTenants() {
  const a = await makeWorkItemFixture({ name: 'Acme', identifier: 'ACME' });
  const b = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
  const planA = await plansService.createPlan(a.projectId, { title: "Acme's plan" }, a.ctx);
  const planB = await plansService.createPlan(b.projectId, { title: "Other's plan" }, b.ctx);
  return { a, b, planA, planB };
}

describe('plan_revision RLS — the gate is the parent plan, not a column on the row', () => {
  it('a workspace sees ONLY its own plans’ revisions', async () => {
    const { a, planA } = await twoTenants();

    // Both tenants have exactly one revision row (their `created`), so a leak
    // would be visible as a count of two rather than as an empty result.
    expect(await adminDb.planRevision.count()).toBe(2);

    const rows = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.planRevision.findMany(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.planId).toBe(planA.id);
  });

  it('with NO workspace GUC bound, nothing is visible — no context, nothing to see', async () => {
    await twoTenants();

    const rows = await asAppRole({}, (tx) => tx.planRevision.findMany());
    expect(rows).toEqual([]);
  });

  it('INSERTing a revision against ANOTHER workspace’s plan is rejected by WITH CHECK', async () => {
    const { a, planB } = await twoTenants();

    // The write names a plan that exists and is perfectly valid — it just lives
    // in somebody else's workspace. This is the hole a `workspace_id` column on
    // the revision row could not close, because the row would simply claim the
    // writer's own workspace and pass.
    await expect(
      asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
        tx.planRevision.create({
          data: { planId: planB.id, changeKind: 'appended', diff: { proposalCount: 1 } },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });

    // …and nothing landed.
    expect(await adminDb.planRevision.count({ where: { planId: planB.id } })).toBe(1);
  });

  it('UPDATE and DELETE of a foreign revision reach no row', async () => {
    const { a, planB } = await twoTenants();

    const updated = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.planRevision.updateMany({
        where: { planId: planB.id },
        data: { changeKind: 'tampered' },
      }),
    );
    expect(updated.count).toBe(0);

    const deleted = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.planRevision.deleteMany({ where: { planId: planB.id } }),
    );
    expect(deleted.count).toBe(0);

    const survivor = await adminDb.planRevision.findFirstOrThrow({ where: { planId: planB.id } });
    expect(survivor.changeKind).toBe('created');
  });
});

// ── The OUT-OF-BAND reader (MOTIR-5034) ────────────────────────────────────
//
// Everything above is the TENANT axis and it was right. This block is the other
// reader: `plan` and `plan_item` have carried a `FOR SELECT` `app.system_admin`
// arm since `20260819010000_plan_system_read_and_abandoned_scan`, and
// `plan_revision` — created NINE DAYS later — inherited nothing from that sweep.
//
// ⚠️ THE FAILURE IS A SILENT ZERO, NOT AN ERROR. With `app.system_admin` bound
// and no workspace GUC, the workspace policy compares the parent plan's
// `workspace_id` against an unset GUC, which is NULL, which hides every row. The
// answer is an empty result set that reads exactly like *"this plan has no
// history"* — and on production it produced three consistent, entirely false
// zeroes (0 rows for one plan, 0 across all 248, 0 for the 171 created since the
// trail shipped) against a table holding 2189 correctly-attributed rows.
//
// No scanner models this reader, which is why `systemContextScan` (MOTIR-2959)
// is silent about it: that instrument asks whether a PRODUCT code path reading
// under a system context touches an unarmed table, and no product path reads
// this table under one. The trail is written and read under the workspace
// binding on both sides, correctly. The affected reader is a person doing
// forensics or support.
describe('plan_revision RLS — the out-of-band reader (MOTIR-5034)', () => {
  it('a system-admin context with NO workspace bound reads the trail — every plan, not zero', async () => {
    const { planA, planB } = await twoTenants();

    // The control: the rows are really there, under a role that is subject to
    // nothing. This is the reading `pg_class.reltuples` gave on production, and
    // the one that broke the illusion.
    expect(await adminDb.planRevision.count()).toBe(2);

    const rows = await asAppRole({ systemAdmin: true }, (tx) => tx.planRevision.findMany());

    // Cross-workspace BY DESIGN: an out-of-band read has no single tenant to
    // bind, which is the whole reason this arm exists rather than a binding.
    expect(rows.map((r) => r.planId).sort()).toEqual([planA.id, planB.id].sort());
    // And it is the TRAIL that came back, attributed — not merely a row count.
    expect(rows.map((r) => r.changeKind)).toEqual(['created', 'created']);
  });

  it('the arm reads the GUC and nothing else — an unbound context still sees nothing', async () => {
    // The mirror of the assertion above, and the one that keeps the arm honest:
    // `current_setting('app.system_admin', true)` is missing_ok, so an unset GUC
    // is NULL and the predicate is NULL, not TRUE. A read with no context at all
    // is unchanged by this migration — the pre-existing case one describe block
    // up asserts the same thing and must keep passing.
    await twoTenants();
    expect(await asAppRole({}, (tx) => tx.planRevision.findMany())).toEqual([]);
  });

  it('it is a READ arm — a system context still cannot INSERT a revision', async () => {
    // MOTIR-2865's tenant-root WRITE refusal, applied here: arming a read fixed
    // a silent blindness, and arming a write would trade a visible bug for an
    // invisible hole. `FOR SELECT` contributes no `WITH CHECK`, so the only
    // `WITH CHECK` on this table is still the workspace policy's — and with no
    // workspace bound it refuses.
    const { planA } = await twoTenants();

    await expect(
      asAppRole({ systemAdmin: true }, (tx) =>
        tx.planRevision.create({
          data: { planId: planA.id, changeKind: 'forged', diff: { proposalCount: 1 } },
        }),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });

    expect(await adminDb.planRevision.count({ where: { planId: planA.id } })).toBe(1);
  });

  it('it is a READ arm — a system context still cannot UPDATE a revision', async () => {
    // A `FOR SELECT` policy does not apply to the UPDATE command, so the row is
    // now VISIBLE to a system context and still not writable by one: the
    // update's own `USING` comes from the workspace policy alone and matches
    // nothing. The trail is append-only, and this is the assertion that says so
    // at the layer that enforces it.
    const { planA } = await twoTenants();

    const updated = await asAppRole({ systemAdmin: true }, (tx) =>
      tx.planRevision.updateMany({ where: { planId: planA.id }, data: { changeKind: 'tampered' } }),
    );
    expect(updated.count).toBe(0);

    const survivor = await adminDb.planRevision.findFirstOrThrow({ where: { planId: planA.id } });
    expect(survivor.changeKind).toBe('created');
  });

  it('a workspace-bound read is UNCHANGED — the arm widens nothing for a tenant', async () => {
    // AC 4. Permissive policies combine with OR, so a new arm can only ever
    // ADMIT — but "can only ever" is the kind of sentence that is worth one
    // measurement. Two workspaces, one test, as it was before the migration.
    const { a, b, planA, planB } = await twoTenants();

    const seenByA = await asAppRole({ userId: a.ownerId, workspaceId: a.workspaceId }, (tx) =>
      tx.planRevision.findMany(),
    );
    expect(seenByA.map((r) => r.planId)).toEqual([planA.id]);

    const seenByB = await asAppRole({ userId: b.ownerId, workspaceId: b.workspaceId }, (tx) =>
      tx.planRevision.findMany(),
    );
    expect(seenByB.map((r) => r.planId)).toEqual([planB.id]);
  });
});

// ⚠️ THE EVIDENCE IS THE CATALOGUE, NOT THE MIGRATION TEXT (MOTIR-4842 is the
// planning bug filed when someone enumerated a table's arms from migration files
// and missed one). `pg_policies` is the readable view over `pg_policy`, and it is
// read here on the TEST DATABASE, after `migrate deploy` has run — so the
// assertion is produced in CI on every run rather than by a person reading a
// deployed cluster after a release. The post-RELEASE read is a different act on a
// different timeline and belongs to MOTIR-4686.
describe('plan_revision policy set, read back from the catalogue', () => {
  interface PolicyRow {
    policyname: string;
    cmd: string;
    permissive: string;
    qual: string | null;
    with_check: string | null;
  }

  const policiesFor = (table: string) =>
    adminDb.$queryRaw<PolicyRow[]>`
      SELECT policyname, cmd, permissive, qual, with_check
        FROM pg_policies
       WHERE schemaname = 'public' AND tablename = ${table}
       ORDER BY policyname
    `;

  it('carries BOTH arms — the workspace gate and the system read', async () => {
    const rows = await policiesFor('plan_revision');
    expect(rows.map((r) => `${r.policyname} (${r.cmd}/${r.permissive})`)).toEqual([
      'plan_revision_active_workspace (ALL/PERMISSIVE)',
      'plan_revision_system_read (SELECT/PERMISSIVE)',
    ]);
  });

  it("the system arm's expression is `plan_system_read`'s, and it carries no WITH CHECK", async () => {
    // AC 2 and AC 3, from the catalogue. Matching the sibling's expression is
    // not cosmetic: an arm that reads a DIFFERENT GUC, or reads this one
    // differently, is a second dialect for one fact — and `armedTables` matches
    // on the `current_setting('<guc>'` reference, so a paraphrase would leave
    // the table reading UNARMED to every instrument built on it.
    const [planArm] = (await policiesFor('plan')).filter(
      (r) => r.policyname === 'plan_system_read',
    );
    const [revisionArm] = (await policiesFor('plan_revision')).filter(
      (r) => r.policyname === 'plan_revision_system_read',
    );

    expect(planArm?.qual).toBeTruthy();
    expect(revisionArm?.qual).toBe(planArm?.qual);
    expect(revisionArm?.with_check, 'a READ arm owes no WITH CHECK — MOTIR-2865').toBeNull();
  });

  it('the workspace policy is untouched — it still joins to the parent plan', async () => {
    const [gate] = (await policiesFor('plan_revision')).filter(
      (r) => r.policyname === 'plan_revision_active_workspace',
    );
    // The row has no `workspace_id` of its own, so both halves resolve tenancy
    // through the parent. Pinned because the cheap way to "fix" this card would
    // have been to rewrite this policy, and rewriting it is exactly what AC 2
    // forbids.
    expect(gate?.qual).toContain('app.workspace_id');
    expect(gate?.with_check).toContain('app.workspace_id');
  });

  it('the shipped arm INVENTORY now reports the table as armed', async () => {
    // `tests/rls/policyArms.ts` is the instrument MOTIR-2880 built and MOTIR-2959
    // generalised; asserting through it, rather than only through a bespoke
    // query, is what makes this fix visible to the guard suite rather than only
    // to this file.
    expect(await armedTables('app.system_admin')).toContain('plan_revision');
  });
});
