import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/lib/db';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { makeWorkItemFixture } from '../../fixtures';
import type { WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// MOTIR-6020 — the planning-session record (story MOTIR-6011,
// `agent-authored-plans.md` AMENDMENT 17 §2/§4/§5). The DDL is applied by the
// suite's own `migrate deploy`; this file runs the migration's BACKFILL section
// against a seeded fixture — the pre-migration shape: one conversation per
// scope, plans linked to it only through `sourceJobId == lastJobId` — and
// asserts each case the card names, twice (the backfill is idempotent).

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'prisma/migrations/20260922210000_planning_session_record/migration.sql'),
  'utf8',
);

/** The statements after the `BACKFILL` banner — the data half, re-runnable. */
function backfillStatements(sql: string): string[] {
  const start = sql.indexOf('-- BACKFILL');
  expect(start).toBeGreaterThan(0);
  return sql
    .slice(start)
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runBackfill(): Promise<void> {
  const statements = backfillStatements(MIGRATION_SQL);
  expect(statements).toHaveLength(4);
  for (const stmt of statements) await adminDb.$executeRawUnsafe(stmt);
}

async function session(fx: WorkItemFixture, scopeKey: string, lastJobId: string | null) {
  return adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ownerId,
      scopeKey,
      targetKeys: scopeKey ? scopeKey.split(',') : [],
      lastJobId,
      lastSubmittedAt: lastJobId ? new Date('2026-09-10T10:00:00.000Z') : null,
    },
  });
}

async function plan(
  fx: WorkItemFixture,
  data: {
    sourceJobId?: string;
    authorSource?: 'mcp' | 'native';
    origin?: 'user' | 'cadence';
    createdAt?: Date;
    decidedAt?: Date;
  },
) {
  return adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: data.origin === 'cadence' ? null : fx.ownerId,
      status: data.decidedAt ? 'approved' : 'planned',
      sourceJobId: data.sourceJobId ?? null,
      authorSource: data.authorSource ?? null,
      origin: data.origin ?? 'user',
      createdAt: data.createdAt ?? new Date('2026-09-01T00:00:00.000Z'),
      decidedAt: data.decidedAt ?? null,
    },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the planning-session backfill links every plan to exactly one session', () => {
  it('joins a matched plan to its conversation and gives MCP, cadence and unmatched plans a session of their own origin — and a second run changes nothing', async () => {
    const fx = await makeWorkItemFixture({ name: 'Sessions', identifier: 'SESS' });
    const convo = await session(fx, 'SESS-1', 'job-latest');

    const matched = await plan(fx, { sourceJobId: 'job-latest' });
    // An EARLIER submit of the same conversation: its job is no longer the
    // session's `lastJobId`, so nothing can prove where it came from.
    const earlier = await plan(fx, { sourceJobId: 'job-earlier' });
    const mcp = await plan(fx, {
      authorSource: 'mcp',
      decidedAt: new Date('2026-09-05T00:00:00.000Z'),
    });
    const cadence = await plan(fx, { sourceJobId: 'job-cadence', origin: 'cadence' });

    await runBackfill();

    expect(await adminDb.plan.count({ where: { sessionId: null } })).toBe(0);
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: matched.id } })).sessionId).toBe(
      convo.id,
    );

    const originOf = async (planId: string) => {
      const p = await adminDb.plan.findUniqueOrThrow({
        where: { id: planId },
        select: { session: { select: { id: true, origin: true, lastActivityAt: true } } },
      });
      return p.session!;
    };
    const mcpSession = await originOf(mcp.id);
    expect(mcpSession.origin).toBe('mcp');
    expect(mcpSession.id).not.toBe(convo.id);
    // A synthetic session is dated from its plan: decided, else created.
    expect(mcpSession.lastActivityAt.toISOString()).toBe('2026-09-05T00:00:00.000Z');
    expect((await originOf(cadence.id)).origin).toBe('cadence');
    const legacy = await originOf(earlier.id);
    expect(legacy.origin).toBe('legacy');
    expect(legacy.lastActivityAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');

    const sessionsAfterFirst = await adminDb.planChangeSession.count();
    expect(sessionsAfterFirst).toBe(4);

    // IDEMPOTENT.
    await runBackfill();
    expect(await adminDb.planChangeSession.count()).toBe(sessionsAfterFirst);
    expect((await originOf(mcp.id)).lastActivityAt.toISOString()).toBe('2026-09-05T00:00:00.000Z');
  });

  it('dates a conversation by its newest turn when that is later than its last write or submit', async () => {
    const fx = await makeWorkItemFixture({ name: 'Activity', identifier: 'ACTV' });
    const convo = await session(fx, '', 'job-1');
    await adminDb.planChangeTurn.create({
      data: {
        workspaceId: fx.workspaceId,
        sessionId: convo.id,
        seq: 0,
        role: 'user',
        body: 'plan the billing epic',
        createdAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    });

    await runBackfill();

    const after = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: convo.id } });
    expect(after.lastActivityAt.toISOString()).toBe('2099-01-01T00:00:00.000Z');
  });

  it('leaves a plan unmatched when two sessions of its project claim the same job, and gives it its own session', async () => {
    const fx = await makeWorkItemFixture({ name: 'Ambiguous', identifier: 'AMBI' });
    await session(fx, 'AMBI-1', 'job-dup');
    await session(fx, 'AMBI-2', 'job-dup');
    const p = await plan(fx, { sourceJobId: 'job-dup' });

    await runBackfill();

    const linked = await adminDb.plan.findUniqueOrThrow({
      where: { id: p.id },
      select: { session: { select: { origin: true } } },
    });
    expect(linked.session?.origin).toBe('legacy');
  });
});

describe('the relaxed session shape', () => {
  it('admits a second session for one scope, and the scope read returns the most recently active', async () => {
    const fx = await makeWorkItemFixture({ name: 'Two', identifier: 'TWOS' });
    const older = await session(fx, 'TWOS-1', null);
    const newer = await session(fx, 'TWOS-1', null);
    await adminDb.planChangeSession.update({
      where: { id: older.id },
      data: { lastActivityAt: new Date('2026-09-01T00:00:00.000Z') },
    });
    await adminDb.planChangeSession.update({
      where: { id: newer.id },
      data: { lastActivityAt: new Date('2026-09-02T00:00:00.000Z') },
    });

    const read = await adminDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.workspace_id', '${fx.workspaceId}', true)`,
      );
      return planChangeSessionRepository.findByProjectAndScope(
        fx.projectId,
        'TWOS-1',
        fx.workspaceId,
        tx,
      );
    });
    expect(read?.id).toBe(newer.id);

    // Swap the recency and the read follows it — the order, not the insert.
    await adminDb.planChangeSession.update({
      where: { id: older.id },
      data: { lastActivityAt: new Date('2026-09-03T00:00:00.000Z') },
    });
    const reread = await adminDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT set_config('app.workspace_id', '${fx.workspaceId}', true)`,
      );
      return planChangeSessionRepository.findByProjectAndScope(
        fx.projectId,
        'TWOS-1',
        fx.workspaceId,
        tx,
      );
    });
    expect(reread?.id).toBe(older.id);
  });

  it('lets the project cascade remove a session together with the plans that point at it', async () => {
    const fx = await makeWorkItemFixture({ name: 'Cascade', identifier: 'CASC' });
    const convo = await session(fx, '', 'job-c');
    await adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        status: 'planned',
        sessionId: convo.id,
      },
    });

    await adminDb.project.delete({ where: { id: fx.projectId } });

    expect(await adminDb.planChangeSession.count({ where: { id: convo.id } })).toBe(0);
    expect(await adminDb.plan.count({ where: { projectId: fx.projectId } })).toBe(0);
  });

  it('refuses deleting a session a surviving plan still points at', async () => {
    const fx = await makeWorkItemFixture({ name: 'Guard', identifier: 'GARD' });
    const convo = await session(fx, '', null);
    await adminDb.plan.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        status: 'planned',
        sessionId: convo.id,
      },
    });

    await expect(adminDb.planChangeSession.delete({ where: { id: convo.id } })).rejects.toThrow();
  });
});
