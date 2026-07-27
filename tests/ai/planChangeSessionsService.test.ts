import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { withWorkspaceContext } from '@/lib/workspaces/context';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import {
  EmptyPlanChangeIntentError,
  EmptyPlanChangeTurnError,
  PlanChangeSessionNotFoundError,
  PlanChangeTurnConflictError,
} from '@/lib/planChange/errors';
import { ProjectNotFoundError } from '@/lib/projects/errors';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// planChangeSessionsService — the plan-change CONVERSATION seam (Story 7.30 ·
// MOTIR-1728) against a REAL Postgres (the motir-core convention). Only the
// motir-ai BOUNDARY client is mocked (the same exception every AI service test
// takes); the session/turn rows, the row lock, the `(session_id, seq)` unique,
// the workspace scoping and the access gate all run for real.
//
// What these prove, per the card's acceptance criteria:
//   * a persisted, project-scoped thread with an ORDERED turn list, and that
//     re-opening RESUMES it (same row, same turns) rather than starting over;
//   * appending returns the updated session DTO, and it is the ACCUMULATED turns
//     — not just the latest — that reach the job;
//   * submitting reuses the SHIPPED `augment` job contract: one `submitJob` call,
//     kind `augment`, no new job kind;
//   * cross-tenant access is denied;
//   * the append is transactional under `SELECT … FOR UPDATE` + a re-read, and a
//     lost race surfaces as a TYPED domain error, never a raw Prisma P2002.

const submitJobMock = vi.fn(async () => ({ jobId: 'job-augment-1' }));

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
  streamJob: vi.fn(),
  getJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  refreshCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  indexCodeGraph: vi.fn(),
  getPreplanState: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

const { planChangeSessionsService, buildAccumulatedIntent } =
  await import('@/lib/services/planChangeSessionsService');

/** The ProjectContext the routes hand the service, built from a fixture. */
function projectCtx(fx: WorkItemFixture): ProjectContext {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockClear();
  submitJobMock.mockResolvedValue({ jobId: 'job-augment-1' });
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('buildAccumulatedIntent', () => {
  it('renders a SINGLE-turn thread verbatim — identical to the shipped one-shot prompt', () => {
    // The point: routing a one-shot change through the conversation must not
    // change what the engine receives. No framing, no numbering.
    expect(buildAccumulatedIntent([{ role: 'user', body: '  Add audit logging  ' }])).toBe(
      'Add audit logging',
    );
  });

  it('accumulates EVERY user turn in order, and says later turns refine earlier ones', () => {
    const intent = buildAccumulatedIntent([
      { role: 'user', body: 'Add auth to the billing epic' },
      { role: 'user', body: 'Make the subtasks smaller' },
      { role: 'user', body: 'And drop the SSO one' },
    ]);
    expect(intent).toContain('1. Add auth to the billing epic');
    expect(intent).toContain('2. Make the subtasks smaller');
    expect(intent).toContain('3. And drop the SSO one');
    expect(intent).toContain('REFINE');
    // The whole reason the seam exists: turn 1 is still in the payload at turn 3.
    expect(intent.indexOf('Add auth')).toBeLessThan(intent.indexOf('drop the SSO'));
  });

  it('excludes system markers from the intent (they are thread history, not intent)', () => {
    const intent = buildAccumulatedIntent([
      { role: 'user', body: 'Split the epic' },
      { role: 'system', body: 'Split the epic' },
    ]);
    expect(intent).toBe('Split the epic');
  });

  it('is empty for a thread with no user turns', () => {
    expect(buildAccumulatedIntent([])).toBe('');
    expect(buildAccumulatedIntent([{ role: 'system', body: 'marker' }])).toBe('');
  });
});

describe('planChangeSessionsService — open + resume', () => {
  it('creates the project-scoped thread, then RESUMES the same one with its turns', async () => {
    const ctx = projectCtx(fx);
    const opened = await planChangeSessionsService.getOrCreateForProject(ctx);
    expect(opened.projectId).toBe(fx.projectId);
    expect(opened.turns).toEqual([]);
    expect(opened.turnCount).toBe(0);
    expect(opened.lastJobId).toBeNull();
    expect(opened.lastSubmittedAt).toBeNull();

    await planChangeSessionsService.appendTurn('Add auth to billing', ctx);

    // "Re-opening the workspace" — the same call the rail makes on mount.
    const resumed = await planChangeSessionsService.getOrCreateForProject(ctx);
    expect(resumed.id).toBe(opened.id);
    expect(resumed.turnCount).toBe(1);
    expect(resumed.turns.map((t) => t.body)).toEqual(['Add auth to billing']);
  });

  it('keeps ONE thread per project under a concurrent open (the unique is the guard)', async () => {
    const ctx = projectCtx(fx);
    const [a, b] = await Promise.all([
      planChangeSessionsService.getOrCreateForProject(ctx),
      planChangeSessionsService.getOrCreateForProject(ctx),
    ]);
    // Both callers get the SAME thread — get-or-create is idempotent, so a lost
    // create-race resolves to the winner's row, not an error.
    expect(a.id).toBe(b.id);
    const rows = await db.planChangeSession.findMany({ where: { projectId: fx.projectId } });
    expect(rows).toHaveLength(1);
  });

  it('gives each project its own thread', async () => {
    const other = await makeWorkItemFixture({ name: 'Acme', identifier: 'OTHR' });
    // Same workspace? No — makeWorkItemFixture mints a fresh tenant, so use its
    // own context. The assertion is that the threads are distinct rows.
    const a = await planChangeSessionsService.getOrCreateForProject(projectCtx(fx));
    const b = await planChangeSessionsService.getOrCreateForProject(projectCtx(other));
    expect(a.id).not.toBe(b.id);
    expect(a.projectId).toBe(fx.projectId);
    expect(b.projectId).toBe(other.projectId);
  });
});

describe('planChangeSessionsService — appending turns', () => {
  it('appends in order with gapless 0-based seq and returns the updated session DTO', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);

    await planChangeSessionsService.appendTurn('First', ctx);
    await planChangeSessionsService.appendTurn('Second', ctx);
    const after = await planChangeSessionsService.appendTurn('Third', ctx);

    expect(after.turnCount).toBe(3);
    expect(after.turns.map((t) => t.seq)).toEqual([0, 1, 2]);
    expect(after.turns.map((t) => t.body)).toEqual(['First', 'Second', 'Third']);
    expect(after.turns.every((t) => t.role === 'user')).toBe(true);
    expect(after.turns.every((t) => t.authorId === fx.ownerId)).toBe(true);
    expect(after.turns.every((t) => t.jobId === null)).toBe(true);
  });

  it('trims the body and rejects a blank turn', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);

    const after = await planChangeSessionsService.appendTurn('  padded  ', ctx);
    expect(after.turns[0]!.body).toBe('padded');

    await expect(planChangeSessionsService.appendTurn('   ', ctx)).rejects.toBeInstanceOf(
      EmptyPlanChangeTurnError,
    );
  });

  it('rejects an append when the project has no conversation yet', async () => {
    await expect(
      planChangeSessionsService.appendTurn('anything', projectCtx(fx)),
    ).rejects.toBeInstanceOf(PlanChangeSessionNotFoundError);
  });
});

describe('planChangeSessionsService — append concurrency', () => {
  it('SERIALIZES two concurrent appends into two ordered turns (the row lock)', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);

    // Both appends read the same `turnCount` before either commits — without the
    // `SELECT … FOR UPDATE` + re-read they would both allocate seq 0 and one
    // would be lost (or collide). Every legitimate outcome is accepted: the ORDER
    // of the two bodies is a genuine race, only the ordering invariant is not.
    await Promise.all([
      planChangeSessionsService.appendTurn('A', ctx),
      planChangeSessionsService.appendTurn('B', ctx),
    ]);

    const rows = await planChangeTurnRepository.listBySessionId(
      (await planChangeSessionRepository.findByProjectId(fx.projectId, fx.workspaceId))!.id,
      fx.workspaceId,
    );
    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
    expect(rows.map((r) => r.body).sort()).toEqual(['A', 'B']);

    const session = await planChangeSessionRepository.findByProjectId(fx.projectId, fx.workspaceId);
    expect(session!.turnCount).toBe(2);
  });

  it('surfaces a LOST append race as a typed error, never a raw Prisma P2002', async () => {
    const ctx = projectCtx(fx);
    const opened = await planChangeSessionsService.getOrCreateForProject(ctx);

    // Reproduce the state a lost race leaves behind: a turn already occupies the
    // position the session's `turnCount` still points at. (The lock prevents the
    // service from reaching this itself — this asserts the DB backstop is
    // TRANSLATED rather than leaking, which is what protects the route's 409.)
    await withWorkspaceContext(
      { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: fx.projectId },
      (tx) =>
        planChangeTurnRepository.create(
          {
            workspaceId: fx.workspaceId,
            sessionId: opened.id,
            seq: 0,
            role: 'user',
            body: 'ghost',
          },
          tx,
        ),
    );

    const err = await planChangeSessionsService.appendTurn('mine', ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanChangeTurnConflictError);
    expect((err as PlanChangeTurnConflictError).code).toBe('PLAN_CHANGE_TURN_CONFLICT');
  });
});

describe('planChangeSessionsService — tenant isolation', () => {
  it('denies a context whose workspace does not own the project', async () => {
    const other = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    // Actor + workspace from tenant A, project from tenant B — the cross-tenant
    // shape. It must not resolve (404 posture, never a 403 existence leak).
    const crossCtx: ProjectContext = {
      userId: fx.ownerId,
      workspaceId: fx.workspaceId,
      projectId: other.projectId,
      project: other.project,
    };
    await expect(planChangeSessionsService.getOrCreateForProject(crossCtx)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
    await expect(planChangeSessionsService.appendTurn('x', crossCtx)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
    await expect(planChangeSessionsService.submit(crossCtx)).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });

  it('does not read another tenant’s thread through the workspace-scoped repository', async () => {
    const other = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    await planChangeSessionsService.getOrCreateForProject(projectCtx(other));

    // The row exists — but not for tenant A's workspace scope.
    expect(
      await planChangeSessionRepository.findByProjectId(other.projectId, fx.workspaceId),
    ).toBeNull();
    expect(
      await planChangeSessionRepository.findByProjectId(other.projectId, other.workspaceId),
    ).not.toBeNull();
  });
});

describe('planChangeSessionsService — submitting the accumulated intent', () => {
  it('sends EVERY turn to the SHIPPED augment job and records the submission', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);
    await planChangeSessionsService.appendTurn('Add auth to the billing epic', ctx);
    await planChangeSessionsService.appendTurn('Make the subtasks smaller', ctx);

    const result = await planChangeSessionsService.submit(ctx);

    // ONE job, of the SHIPPED kind — no new job kind, no engine change.
    expect(submitJobMock).toHaveBeenCalledTimes(1);
    const [kind, tenant, payload] = submitJobMock.mock.calls[0] as unknown as [
      string,
      { projectId: string; workspaceId: string },
      { prompt: string },
    ];
    expect(kind).toBe('augment');
    expect(tenant.projectId).toBe(fx.projectId);
    expect(tenant.workspaceId).toBe(fx.workspaceId);
    // The ACCUMULATED intent, not just the latest turn.
    expect(payload.prompt).toContain('Add auth to the billing epic');
    expect(payload.prompt).toContain('Make the subtasks smaller');

    expect(result.jobId).toBe('job-augment-1');
    expect(result.session.lastJobId).toBe('job-augment-1');
    expect(result.session.lastSubmittedAt).not.toBeNull();

    // The submission is recorded ON the thread, so a resumed rail can see what
    // went out and re-attach to its job.
    const marker = result.session.turns.at(-1)!;
    expect(marker.role).toBe('system');
    expect(marker.seq).toBe(2);
    expect(marker.jobId).toBe('job-augment-1');
    expect(marker.body).toBe(payload.prompt);
    expect(result.session.turnCount).toBe(3);
  });

  it('keeps accumulating ACROSS submissions — a second submit still carries turn 1', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);
    await planChangeSessionsService.appendTurn('Add auth to the billing epic', ctx);
    await planChangeSessionsService.submit(ctx);

    submitJobMock.mockResolvedValue({ jobId: 'job-augment-2' });
    await planChangeSessionsService.appendTurn('Actually, make them smaller', ctx);
    const second = await planChangeSessionsService.submit(ctx);

    const payload = (
      submitJobMock.mock.calls[1] as unknown as [string, unknown, { prompt: string }]
    )[2];
    // The refinement reads against the ORIGINAL request — the whole point of a
    // conversation rather than a sequence of unrelated prompts.
    expect(payload.prompt).toContain('Add auth to the billing epic');
    expect(payload.prompt).toContain('Actually, make them smaller');
    expect(second.session.lastJobId).toBe('job-augment-2');
  });

  it('rejects a submit with nothing to send', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);
    await expect(planChangeSessionsService.submit(ctx)).rejects.toBeInstanceOf(
      EmptyPlanChangeIntentError,
    );
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('rejects a submit on a project with no conversation', async () => {
    await expect(planChangeSessionsService.submit(projectCtx(fx))).rejects.toBeInstanceOf(
      PlanChangeSessionNotFoundError,
    );
  });

  it('leaves the thread untouched when the AI submit fails — the turns survive a retry', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);
    await planChangeSessionsService.appendTurn('Split the epic', ctx);

    submitJobMock.mockRejectedValueOnce(new Error('motir-ai unreachable'));
    await expect(planChangeSessionsService.submit(ctx)).rejects.toThrow('motir-ai unreachable');

    const session = await planChangeSessionsService.getOrCreateForProject(ctx);
    expect(session.turnCount).toBe(1);
    expect(session.lastJobId).toBeNull();
    expect(session.turns.map((t) => t.role)).toEqual(['user']);
  });
});
