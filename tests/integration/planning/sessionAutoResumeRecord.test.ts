import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { AUTO_RESUMES_PER_SESSION } from '@/lib/planChange/sessionWaitingState';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// THE AUTO-RESUME RECORD, against a REAL Postgres (Story MOTIR-8301 · MOTIR-8305).
// The bound is enforced inside the one UPDATE that moves the count, so the claim
// that two racing callers cannot both pass it is a claim about row locks, and the
// non-negative count is the database's CHECK. Neither is provable with a mock.

const T = { timeout: 60_000 };

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const wctx = () => ({ userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId });

async function openSession(autoResumeCount = 0): Promise<string> {
  const session = await adminDb.planChangeSession.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      createdById: fx.ownerId,
      scopeKey: `scope-${Math.random().toString(36).slice(2)}`,
      targetKeys: [],
      origin: 'conversation',
      autoResumeCount,
    },
  });
  return session.id;
}

const record = (id: string, at = new Date()) =>
  withWorkspaceContext(wctx(), (tx) =>
    planChangeSessionRepository.recordAutoResume(id, { at, max: AUTO_RESUMES_PER_SESSION }, tx),
  );
const rowOf = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });

describe('the bound', () => {
  it('is two resumes per conversation', () => {
    expect(AUTO_RESUMES_PER_SESSION).toBe(2);
  });

  it('counts 1, then 2, then refuses with null and writes nothing', T, async () => {
    const id = await openSession();
    const first = new Date('2026-10-12T10:00:00.000Z');
    const second = new Date('2026-10-12T10:05:00.000Z');

    expect(await record(id, first)).toBe(1);
    expect((await rowOf(id)).lastAutoResumedAt).toEqual(first);
    expect(await record(id, second)).toBe(2);

    expect(await record(id, new Date('2026-10-12T10:10:00.000Z'))).toBeNull();
    const row = await rowOf(id);
    expect(row.autoResumeCount).toBe(2);
    expect(row.lastAutoResumedAt).toEqual(second);
  });

  it('an ENDED session is refused with null and its count does not move', T, async () => {
    const id = await openSession();
    await adminDb.planChangeSession.update({
      where: { id },
      data: { endedAt: new Date(), endReason: 'idle' },
    });

    expect(await record(id)).toBeNull();
    const row = await rowOf(id);
    expect(row.autoResumeCount).toBe(0);
    expect(row.lastAutoResumedAt).toBeNull();
  });

  it('an unknown session is null', T, async () => {
    expect(await record('no-such-session')).toBeNull();
  });
});

describe('the CHECK', () => {
  it('refuses a negative count', T, async () => {
    const id = await openSession();
    const err = await adminDb
      .$executeRawUnsafe(
        `UPDATE "plan_change_session" SET "auto_resume_count" = -1 WHERE "id" = $1`,
        id,
      )
      .then(() => null)
      .catch((e: unknown) => e as Error);
    expect(String(err?.message ?? 'NOT REFUSED')).toContain(
      'plan_change_session_auto_resume_count_nonneg',
    );
  });
});

describe('concurrent callers cannot both pass the bound', () => {
  it('two callers from one under the bound: exactly one passes', T, async () => {
    for (let i = 0; i < 20; i++) {
      const id = await openSession(AUTO_RESUMES_PER_SESSION - 1);
      const out = await Promise.all([record(id), record(id)]);
      expect(out.filter((n) => n !== null)).toEqual([AUTO_RESUMES_PER_SESSION]);
      expect((await rowOf(id)).autoResumeCount).toBe(AUTO_RESUMES_PER_SESSION);
    }
  });

  it('three callers from zero: two pass, with distinct counts, and one is refused', T, async () => {
    for (let i = 0; i < 20; i++) {
      const id = await openSession(0);
      const out = await Promise.all([record(id), record(id), record(id)]);
      expect(out.filter((n) => n !== null).sort()).toEqual([1, 2]);
      expect(out.filter((n) => n === null)).toHaveLength(1);
      expect((await rowOf(id)).autoResumeCount).toBe(2);
    }
  });
});

describe('the record is kept and read', () => {
  it('ending the session keeps both fields', T, async () => {
    const id = await openSession();
    const at = new Date('2026-10-12T11:00:00.000Z');
    await record(id, at);

    await withWorkspaceContext(wctx(), (tx) =>
      planSessionEndService.endSessionWithin(tx, id, fx.workspaceId, 'idle', {
        endedById: null,
        actor: fx.ctx,
      }),
    );

    const row = await rowOf(id);
    expect(row.endedAt).not.toBeNull();
    expect(row.autoResumeCount).toBe(1);
    expect(row.lastAutoResumedAt).toEqual(at);
  });

  it('findWaitingState returns both fields', T, async () => {
    const id = await openSession();
    const at = new Date('2026-10-12T12:00:00.000Z');
    await record(id, at);

    const state = await withWorkspaceContext(wctx(), (tx) =>
      planChangeSessionRepository.findWaitingState(id, fx.workspaceId, tx),
    );
    expect(state).toMatchObject({ autoResumeCount: 1, lastAutoResumedAt: at });
  });
});
