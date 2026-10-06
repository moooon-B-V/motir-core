import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { PlanDecisionReason, PlanSessionOrigin, PlanStatus } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { PLAN_SESSION_STATE_VALUES } from '@/lib/dto/planSessions';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-7636 — a planning session ENDS (story MOTIR-7630;
// `docs/decisions/agent-authored-plans.md` AMENDMENT 23 §1). Against a REAL
// Postgres:
//
//   * the migration's BACKFILL classifies every existing session from its
//     history, in the order the decision fixes — and a second run changes
//     nothing;
//   * the Plans list's state and the filter's counts read the SAME derivation,
//     so a `closed` count and its filtered list can never disagree.
//
// ⚠️ The backfill statements are READ FROM THE MIGRATION and executed verbatim.
// A test that retyped them would pass while the shipped SQL drifted away.

const DB_TEST_TIMEOUT_MS = 30_000;
const MIGRATION = path.join(
  process.cwd(),
  'prisma/migrations/20261005220000_plan_change_session_end/migration.sql',
);

/** The migration's backfill UPDATEs, comments stripped, in file order. */
function backfillStatements(): string[] {
  const statements = readFileSync(MIGRATION, 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => /^UPDATE\b/i.test(s));
  expect(statements, 'the four backfill steps, in order').toHaveLength(4);
  return statements;
}

async function runBackfill(): Promise<void> {
  for (const sql of backfillStatements()) await adminDb.$executeRawUnsafe(sql);
}

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const HOUR = 60 * 60 * 1000;

async function seedSession(
  opts: { idleMs?: number; origin?: PlanSessionOrigin } = {},
): Promise<string> {
  const s = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ctx.userId,
      origin: opts.origin ?? 'conversation',
      lastActivityAt: new Date(Date.now() - (opts.idleMs ?? 2 * HOUR)),
    },
  });
  return s.id;
}

async function seedPlan(
  sessionId: string,
  status: PlanStatus,
  opts: {
    decidedById?: string | null;
    decisionReason?: PlanDecisionReason | null;
    createdAt?: Date;
    decidedAt?: Date | null;
  } = {},
): Promise<void> {
  await adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      sessionId,
      status,
      decidedById: opts.decidedById ?? null,
      decisionReason: opts.decisionReason ?? null,
      decidedAt: opts.decidedAt ?? null,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
}

async function endOf(id: string) {
  const s = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });
  return { endedAt: s.endedAt, endReason: s.endReason, endedById: s.endedById };
}

describe('the backfill classifies every existing session (AMENDMENT 23 §1)', () => {
  it(
    'ends approved, declined, failed and idle sessions and leaves the rest open',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const decidedAt = new Date(Date.now() - 3 * HOUR);
      const approved = await seedSession();
      await seedPlan(approved, 'approved', { decidedById: fx.ctx.userId, decidedAt });

      const declined = await seedSession();
      await seedPlan(declined, 'declined', {
        decidedById: fx.ctx.userId,
        decisionReason: 'reviewed',
        decidedAt,
      });

      const abandoned = await seedSession();
      await seedPlan(abandoned, 'declined', { decisionReason: 'abandoned', decidedAt });

      const closedEmpty = await seedSession();
      await seedPlan(closedEmpty, 'declined', { decisionReason: 'discarded' });

      const idle = await seedSession({ idleMs: 2 * HOUR });
      const recent = await seedSession({ idleMs: 5 * 60 * 1000 });
      const waiting = await seedSession({ idleMs: 48 * HOUR });
      await seedPlan(waiting, 'planned');
      const guide = await seedSession({ origin: 'guide', idleMs: 48 * HOUR });

      // The LATEST plan decides: an older approval under a newer open plan stays open.
      const reopened = await seedSession();
      await seedPlan(reopened, 'approved', {
        decidedById: fx.ctx.userId,
        createdAt: new Date(Date.now() - 5 * HOUR),
      });
      await seedPlan(reopened, 'stale', { createdAt: new Date(Date.now() - HOUR) });

      await runBackfill();

      expect(await endOf(approved)).toEqual({
        endedAt: decidedAt,
        endReason: 'approved',
        endedById: fx.ctx.userId,
      });
      expect(await endOf(declined)).toEqual({
        endedAt: decidedAt,
        endReason: 'declined',
        endedById: fx.ctx.userId,
      });
      expect(await endOf(abandoned)).toEqual({
        endedAt: decidedAt,
        endReason: 'failed',
        endedById: null,
      });
      expect((await endOf(closedEmpty)).endReason).toBe('failed');

      const idleEnd = await endOf(idle);
      expect(idleEnd.endReason).toBe('idle');
      expect(idleEnd.endedById).toBeNull();
      const idleRow = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: idle } });
      // Ended at the moment the 30-minute lease ran out, not at the deploy.
      expect(idleEnd.endedAt!.getTime() - idleRow.lastActivityAt.getTime()).toBe(30 * 60 * 1000);

      for (const open of [recent, waiting, guide, reopened]) {
        expect(await endOf(open)).toEqual({ endedAt: null, endReason: null, endedById: null });
      }
    },
  );

  it('is idempotent — a second run changes nothing', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const approved = await seedSession();
    await seedPlan(approved, 'approved', { decidedById: fx.ctx.userId });
    const idle = await seedSession();
    await seedSession({ idleMs: 60_000 });

    await runBackfill();
    const first = await adminDb.planChangeSession.findMany({ orderBy: { id: 'asc' } });
    await runBackfill();
    const second = await adminDb.planChangeSession.findMany({ orderBy: { id: 'asc' } });

    expect(second).toEqual(first);
    expect(first.find((s) => s.id === idle)!.endReason).toBe('idle');
  });
});

describe('the list and the counts read ONE state derivation', () => {
  it(
    'an ended session reads `closed` unless it ended by a decision, and every count matches its list',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const failed = await seedSession();
      await seedPlan(failed, 'declined', { decisionReason: 'abandoned' });
      const approved = await seedSession();
      await seedPlan(approved, 'approved', { decidedById: fx.ctx.userId });
      await seedSession(); // idle
      const open = await seedSession({ idleMs: 60_000 });
      await runBackfill();

      const scope = { projectId: fx.projectId, workspaceId: fx.workspaceId };
      const counts = await adminDb.$transaction((tx) =>
        planChangeSessionRepository.countByLatestPlanState(scope.projectId, scope.workspaceId, tx),
      );
      const byState = Object.fromEntries(counts.map((c) => [c.state, c.count]));
      expect(byState).toEqual({ closed: 2, approved: 1, none: 1 });

      for (const state of PLAN_SESSION_STATE_VALUES) {
        const rows = await adminDb.$transaction((tx) =>
          planChangeSessionRepository.listPageByProject(
            { ...scope, limit: 50, after: null, state },
            tx,
          ),
        );
        expect(rows.length, `the ${state} list`).toBe(byState[state] ?? 0);
        for (const row of rows) expect(row.state).toBe(state);
      }

      const all = await adminDb.$transaction((tx) =>
        planChangeSessionRepository.listPageByProject(
          { ...scope, limit: 50, after: null, state: null },
          tx,
        ),
      );
      const failedRow = all.find((r) => r.id === failed)!;
      expect(failedRow.state).toBe('closed');
      expect(failedRow.endReason).toBe('failed');
      expect(failedRow.endedAt).not.toBeNull();
      expect(all.find((r) => r.id === approved)!.endedById).toBe(fx.ctx.userId);
      expect(all.find((r) => r.id === open)!.endedAt).toBeNull();
    },
  );
});
