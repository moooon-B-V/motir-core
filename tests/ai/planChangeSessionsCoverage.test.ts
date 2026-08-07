import { Prisma } from '@/generated/prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { toPlanChangeSessionDto } from '@/lib/mappers/planChangeMappers';
import { PROJECT_SCOPE_KEY } from '@/lib/planChange/scope';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// The story-level COVERAGE GATE's residual for the conversation's persistence
// layer (MOTIR-1732). MOTIR-1728 shipped its own comprehensive suite
// (`planChangeSessionsService.test.ts` — open/resume, ordered appends, the row
// lock under real concurrency, tenant isolation, accumulation across submits);
// this file deliberately does NOT restate any of it. It closes only the branches
// that suite cannot reach from the outside, which is exactly what took the two
// files under the per-file gate (≥90% branch/fn/line):
//
//   * the repository reads on their DEFAULT client — every service path passes a
//     `tx`, so the `tx ?? db` arm shipped unexecuted;
//   * the two ERROR-CLASSIFICATION forks: a non-P2002 failure must propagate
//     UNTRANSLATED (only a genuine unique violation becomes a typed conflict),
//     and the create-race recovery must re-read the winner — the shipped
//     "concurrent open" case is served by the pre-read, so the catch never ran;
//   * the mapper's null-bearing fields on a thread that HAS submitted.
//
// Real Postgres, per the motir-core convention; only the motir-ai boundary
// client is mocked (the service imports it transitively through
// `aiPlanEditsService`).

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async () => ({ jobId: 'job-augment-1' })),
  streamJob: vi.fn(),
  getJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  refreshCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  getPreplanState: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { PlanChangeTurnConflictError, PlanChangeSessionNotFoundError } =
  await import('@/lib/planChange/errors');

let fx: WorkItemFixture;

function ctx(f: WorkItemFixture): ProjectContext {
  return {
    userId: f.ownerId,
    workspaceId: f.workspaceId,
    projectId: f.projectId,
    project: f.project,
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  vi.restoreAllMocks();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('planChange repositories — the DEFAULT (no-transaction) client', () => {
  it('reads a session by project and by id without a surrounding transaction', async () => {
    const opened = await planChangeSessionsService.getOrCreateForProject(ctx(fx));

    // Every service path hands the repository a `tx`; these are the `tx ?? db`
    // arms — the shape any future read-only caller (a route, a report) would use.
    const byProject = await planChangeSessionRepository.findByProjectAndScope(
      fx.projectId,
      PROJECT_SCOPE_KEY,
      fx.workspaceId,
    );
    expect(byProject?.id).toBe(opened.id);

    const byId = await planChangeSessionRepository.findById(opened.id, fx.workspaceId);
    expect(byId?.projectId).toBe(fx.projectId);
  });

  it('scopes both default-client reads to the workspace — a foreign tenant sees nothing', async () => {
    // MOTIR-1728's suite proves this for the by-project read; the two reads a
    // caller reaches a thread by its OWN id with — `findById` and the turn list —
    // carry the same scope and are asserted here.
    const c = ctx(fx);
    const opened = await planChangeSessionsService.getOrCreateForProject(c);
    await planChangeSessionsService.appendTurn('a turn', c);
    const other = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });

    expect(await planChangeSessionRepository.findById(opened.id, other.workspaceId)).toBeNull();
    expect(await planChangeTurnRepository.listBySessionId(opened.id, other.workspaceId)).toEqual(
      [],
    );
    // Same ids, the OWNING scope — proof the nulls above are the scope biting,
    // not a bad id.
    expect(await planChangeSessionRepository.findById(opened.id, fx.workspaceId)).not.toBeNull();
    expect(await planChangeTurnRepository.listBySessionId(opened.id, fx.workspaceId)).toHaveLength(
      1,
    );
  });

  it('reports a MISSING session from the row lock instead of throwing', async () => {
    // `lockById` is the append's first step. On a thread deleted between the
    // caller's read and the transaction it must return null so the service can
    // raise its typed not-found — not blow up with a raw index error.
    const locked = await withWorkspaceContext(
      { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
      (tx) => planChangeSessionRepository.lockById('cl000000000000000000000', tx),
    );
    expect(locked).toBeNull();
  });

  it('reads the thread in seq order on the default client', async () => {
    const c = ctx(fx);
    await planChangeSessionsService.getOrCreateForProject(c);
    await planChangeSessionsService.appendTurn('first', c);
    await planChangeSessionsService.appendTurn('second', c);

    const session = (await planChangeSessionRepository.findByProjectAndScope(
      fx.projectId,
      PROJECT_SCOPE_KEY,
      fx.workspaceId,
    ))!;
    const turns = await planChangeTurnRepository.listBySessionId(session.id, fx.workspaceId);
    expect(turns.map((t) => t.body)).toEqual(['first', 'second']);
    expect(turns.map((t) => t.seq)).toEqual([0, 1]);
  });
});

describe('planChangeSessionsService — error classification is not a catch-all', () => {
  it('propagates a NON-unique write failure untranslated', async () => {
    // The P2002 fork must be a fork, not a funnel: a connection drop, a check
    // constraint, a serialization failure must NOT be reported to the user as
    // "someone else claimed your turn". Only a genuine unique violation is a
    // turn conflict.
    const c = ctx(fx);
    await planChangeSessionsService.getOrCreateForProject(c);

    const boom = new Prisma.PrismaClientKnownRequestError('deadlock detected', {
      code: 'P2034',
      clientVersion: 'test',
    });
    vi.spyOn(planChangeTurnRepository, 'create').mockRejectedValue(boom);

    const err = await planChangeSessionsService.appendTurn('a turn', c).catch((e: unknown) => e);
    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(PlanChangeTurnConflictError);
  });

  it('raises the typed not-found when the thread VANISHES before the lock', async () => {
    // The TOCTOU arm the row lock exists for: `requireSession` read the thread,
    // then it was deleted (a project reset, a cascade) before the append's
    // transaction took the lock. `lockById` returns null and the append must
    // raise the domain error, not dereference a missing row.
    const c = ctx(fx);
    await planChangeSessionsService.getOrCreateForProject(c);
    vi.spyOn(planChangeSessionRepository, 'lockById').mockResolvedValueOnce(null);

    await expect(planChangeSessionsService.appendTurn('a turn', c)).rejects.toBeInstanceOf(
      PlanChangeSessionNotFoundError,
    );
  });

  it('raises the typed not-found when the locked re-read comes back empty', async () => {
    // The second half of the same window: the lock succeeded but the scoped
    // re-read (which is what `seq` is derived from) found nothing. Allocating
    // from an absent `turnCount` would be the lost-update bug the lock prevents.
    const c = ctx(fx);
    await planChangeSessionsService.getOrCreateForProject(c);
    vi.spyOn(planChangeSessionRepository, 'findById').mockResolvedValueOnce(null);

    await expect(planChangeSessionsService.appendTurn('a turn', c)).rejects.toBeInstanceOf(
      PlanChangeSessionNotFoundError,
    );
  });

  it('propagates a NON-unique failure from the OPEN path too', async () => {
    // The open path's catch forks on the same P2002 test; a different Prisma
    // error must escape rather than be mistaken for a lost create race.
    const c = ctx(fx);
    const boom = new Prisma.PrismaClientKnownRequestError('connection lost', {
      code: 'P1001',
      clientVersion: 'test',
    });
    vi.spyOn(planChangeSessionRepository, 'create').mockRejectedValueOnce(boom);

    await expect(planChangeSessionsService.getOrCreateForProject(c)).rejects.toBe(boom);
  });

  it('RECOVERS the winner’s thread when the create loses the unique race', async () => {
    // The shipped "concurrent open" case is answered by the pre-read, so the
    // catch never executes. Force the real race: the pre-read finds nothing, and
    // the create then hits the `project_id` unique because a sibling opener
    // committed in between.
    const c = ctx(fx);
    const winner = await withWorkspaceContext(
      { userId: c.userId, workspaceId: c.workspaceId, projectId: c.projectId },
      (tx) =>
        planChangeSessionRepository.create(
          { workspaceId: c.workspaceId, projectId: c.projectId, createdById: c.userId },
          tx,
        ),
    );

    const findByProjectAndScope = planChangeSessionRepository.findByProjectAndScope.bind(
      planChangeSessionRepository,
    );
    const spy = vi.spyOn(planChangeSessionRepository, 'findByProjectAndScope');
    // Only the FIRST read (the pre-read) sees an empty project; the recovery
    // read inside the catch runs for real and must return the winner.
    spy.mockResolvedValueOnce(null);
    spy.mockImplementation(findByProjectAndScope);

    const resolved = await planChangeSessionsService.getOrCreateForProject(c);

    expect(resolved.id).toBe(winner.id);
    // Idempotent by outcome: still exactly ONE thread for the project.
    const rows = await db.planChangeSession.findMany({ where: { projectId: c.projectId } });
    expect(rows).toHaveLength(1);
  });

  it('rethrows the unique violation when the winner cannot be re-read', async () => {
    // The `if (winner)` guard's other arm: a P2002 that is NOT the open race
    // (or a row the caller may not see) must not be swallowed into a silent
    // success — there is no thread to return, so the error escapes.
    const c = ctx(fx);
    const conflict = new Prisma.PrismaClientKnownRequestError('unique violation', {
      code: 'P2002',
      clientVersion: 'test',
    });
    vi.spyOn(planChangeSessionRepository, 'findByProjectAndScope').mockResolvedValue(null);
    vi.spyOn(planChangeSessionRepository, 'create').mockRejectedValueOnce(conflict);

    await expect(planChangeSessionsService.getOrCreateForProject(c)).rejects.toBe(conflict);
  });
});

describe('planChangeMappers — no Prisma row crosses the boundary', () => {
  it('maps a SUBMITTED thread’s dates to ISO strings and keeps the tenant id off the wire', async () => {
    const c = ctx(fx);
    await planChangeSessionsService.getOrCreateForProject(c);
    await planChangeSessionsService.appendTurn('Split the billing epic', c);
    const { session } = await planChangeSessionsService.submit(c);

    // `lastSubmittedAt` is the only nullable Date on the session — the shipped
    // suite asserts the null arm (a never-submitted thread); this is the set arm.
    expect(session.lastSubmittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(session.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(session.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Object.keys(session)).not.toContain('workspaceId');

    const marker = session.turns.at(-1)!;
    expect(marker.role).toBe('system');
    expect(marker.jobId).toBe('job-augment-1');
    // A system marker has no author; a user turn does. Both arms, one thread.
    expect(marker.authorId).toBeNull();
    expect(session.turns[0]!.authorId).toBe(fx.ownerId);
    expect(session.turns[0]!.jobId).toBeNull();
    expect(Object.keys(marker)).not.toContain('workspaceId');
  });

  it('does not re-sort — the ORDER is the repository read’s contract', () => {
    // Stated as an assertion so a future "defensive sort" in the mapper is a
    // failing test rather than a silent second source of truth for ordering.
    const now = new Date('2026-07-27T10:00:00.000Z');
    const row = {
      id: 's1',
      workspaceId: 'w1',
      projectId: 'p1',
      createdById: 'u1',
      turnCount: 2,
      scopeKey: '',
      targetKeys: [],
      lastJobId: null,
      lastSubmittedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const turn = (seq: number) => ({
      id: `t${seq}`,
      workspaceId: 'w1',
      sessionId: 's1',
      seq,
      role: 'user' as const,
      body: `turn ${seq}`,
      jobId: null,
      question: null,
      isAnswer: false,
      authorId: 'u1',
      createdAt: now,
    });

    const dto = toPlanChangeSessionDto(row, [turn(1), turn(0)]);
    expect(dto.turns.map((t) => t.seq)).toEqual([1, 0]);
  });
});
