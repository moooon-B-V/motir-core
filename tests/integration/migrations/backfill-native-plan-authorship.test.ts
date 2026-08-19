import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-2996 — the `backfill_native_plan_authorship` forward data migration.
//
// `plan.author_source` / `author_harness` shipped nullable with NO backfill
// (MOTIR-2986), because at that moment the `create_plan` MCP tool was their only
// writer: every existing plan genuinely had no recorded author, and NULL was the
// *unattributed* state the Plans surface draws rather than a gap. This card
// changes the premise — `aiGenerationService` / `aiPlanEditsService` now record
// `native · Motir` — which would leave the rows written BEFORE it as the only
// Motir generations in the table reading as unattributed, on the very surfaces
// that stop inferring in the same change.
//
// This suite runs the migration's real SQL against real Postgres and pins the
// predicate from BOTH sides: it stamps exactly the rows the surface used to
// infer over, and leaves every other row alone. Rows-affected is asserted rather
// than assumed, so the blast radius is a number.

const MIGRATION_SQL = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260819160000_backfill_native_plan_authorship/migration.sql',
  ),
  'utf8',
);

/** Apply the migration exactly as `migrate deploy` would — as the OWNER, which
 *  is the role that connects on the DDL URL. `plan` is ENABLE + FORCE RLS with a
 *  pure `app.workspace_id` gate, so a cross-tenant UPDATE is possible only from
 *  that side; the runtime role sees no rows at all without a bound context. */
async function runMigration(): Promise<number> {
  return adminDb.$executeRawUnsafe(MIGRATION_SQL);
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

/** A `plan` row in a pre-migration state, written through the OWNER so the
 *  fixture is not itself the thing under test. */
async function seedPlan(
  fx: WorkItemFixture,
  over: {
    title: string;
    sourceJobId?: string | null;
    authorSource?: 'native' | 'mcp' | 'manual' | 'api' | null;
    authorHarness?: string | null;
    authorModel?: string | null;
  },
) {
  return adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      status: 'planned',
      title: over.title,
      sourceJobId: over.sourceJobId ?? null,
      authorSource: over.authorSource ?? null,
      authorHarness: over.authorHarness ?? null,
      authorModel: over.authorModel ?? null,
    },
  });
}

const rowOf = async (id: string) => adminDb.plan.findUniqueOrThrow({ where: { id } });

describe('backfill_native_plan_authorship — stamps exactly the rows the surface inferred over', () => {
  it('stamps `native · Motir` on a job-sourced row that carries no author', async () => {
    const fx = await makeWorkItemFixture();
    const generated = await seedPlan(fx, { title: 'A Motir generation', sourceJobId: 'job_1' });

    await runMigration();

    const row = await rowOf(generated.id);
    expect(row.authorSource).toBe('native');
    expect(row.authorHarness).toBe('Motir');
    // The MODEL is deliberately untouched and NOT invented: motir-core does not
    // know the planning LLM (`PlanningRun.model` lives in motir-ai), and
    // `work-item-provenance.md` Decision 6 strips a native model at the read
    // boundary — so there is no value to write and nothing that could spend one.
    expect(row.authorModel).toBeNull();
    // Only the authorship moved. The job that identified the row is still there,
    // and it keeps answering the question it actually answers (WHICH JOB).
    expect(row.sourceJobId).toBe('job_1');
    expect(row.status).toBe('planned');
  });

  it('leaves a JOB-LESS row null — that row is genuinely unattributed', async () => {
    const fx = await makeWorkItemFixture();
    const legacy = await seedPlan(fx, { title: 'Nobody knows who wrote this' });

    await runMigration();

    const row = await rowOf(legacy.id);
    // The state the surface renders as NOTHING. Inventing an author for history
    // is the one outcome worse than showing none — and after this migration the
    // null finally means only that, instead of doubling as *Motir generated it*.
    expect(row.authorSource).toBeNull();
    expect(row.authorHarness).toBeNull();
  });

  it('leaves an MCP-authored row alone — a non-null stamp means HANDS OFF', async () => {
    const fx = await makeWorkItemFixture();
    const agent = await seedPlan(fx, {
      title: 'Authored over the MCP',
      authorSource: 'mcp',
      authorHarness: 'Claude Code',
      authorModel: 'claude-opus-5',
    });
    // …including the shape that would otherwise look like a generation: an
    // agent-authored plan never carries a `sourceJobId` today, but the predicate
    // must not depend on that staying true.
    const agentWithJob = await seedPlan(fx, {
      title: 'Authored over the MCP, with a job somehow',
      sourceJobId: 'job_2',
      authorSource: 'mcp',
      authorHarness: 'Codex',
    });

    await runMigration();

    const a = await rowOf(agent.id);
    expect(a.authorSource).toBe('mcp');
    expect(a.authorHarness).toBe('Claude Code');
    expect(a.authorModel).toBe('claude-opus-5');
    const b = await rowOf(agentWithJob.id);
    expect(b.authorSource).toBe('mcp');
    expect(b.authorHarness).toBe('Codex');
  });

  it('reports the blast radius: rows-affected is the count of matching rows, not a guess', async () => {
    const fx = await makeWorkItemFixture();
    for (let i = 0; i < 3; i += 1) {
      await seedPlan(fx, { title: `Generation ${i}`, sourceJobId: `job_${i}` });
    }
    await seedPlan(fx, { title: 'Unattributed' });
    await seedPlan(fx, { title: 'Agent', authorSource: 'mcp', authorHarness: 'Claude Code' });

    expect(await runMigration()).toBe(3);

    expect(await adminDb.plan.count({ where: { authorSource: 'native' } })).toBe(3);
    expect(await adminDb.plan.count({ where: { authorSource: 'mcp' } })).toBe(1);
    expect(await adminDb.plan.count({ where: { authorSource: null } })).toBe(1);
  });

  it('writes ZERO on a second apply — the stamp falls out of its own predicate', async () => {
    const fx = await makeWorkItemFixture();
    await seedPlan(fx, { title: 'A Motir generation', sourceJobId: 'job_1' });

    expect(await runMigration()).toBe(1);
    expect(await runMigration()).toBe(0);
  });

  it('no-ops on a database with no generated plans at all (fresh / CI / preview)', async () => {
    const fx = await makeWorkItemFixture();
    await seedPlan(fx, { title: 'Unattributed' });

    expect(await runMigration()).toBe(0);
    expect(await adminDb.plan.count({ where: { authorSource: { not: null } } })).toBe(0);
  });

  it("changes no WORK ITEM provenance — the plan's author and its items' authors are separate facts", async () => {
    const fx = await makeWorkItemFixture();
    await seedPlan(fx, { title: 'A Motir generation', sourceJobId: 'job_1' });
    const item = await createTestWorkItem(fx, { kind: 'task', title: 'Already materialized' });
    const before = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });

    await runMigration();

    // `materialize` stamps a work item from the PROPOSAL's `planningProvenance`
    // (`work-item-provenance.md` Decision 5, as amended by
    // `agent-authored-plans.md` Q4), never from the plan row — so repairing the
    // plan's own author cannot move an item's, and this migration names one table.
    const after = await adminDb.workItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.planningSource).toBe(before.planningSource);
    expect(after.planningHarness).toBe(before.planningHarness);
    expect(after.planningModel).toBe(before.planningModel);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  it('is NOT tenant-guarded — it repairs every workspace, as a self-hosted deployment needs', async () => {
    const one = await makeWorkItemFixture();
    const two = await makeWorkItemFixture();
    const a = await seedPlan(one, { title: 'Tenant one', sourceJobId: 'job_a' });
    const b = await seedPlan(two, { title: 'Tenant two', sourceJobId: 'job_b' });

    expect(await runMigration()).toBe(2);

    expect((await rowOf(a.id)).authorSource).toBe('native');
    expect((await rowOf(b.id)).authorSource).toBe('native');
    // Two genuinely different tenants, so this is not one workspace counted twice.
    expect(one.workspaceId).not.toBe(two.workspaceId);
  });
});
