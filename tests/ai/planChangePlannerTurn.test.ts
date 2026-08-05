import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { PROJECT_SCOPE_KEY } from '@/lib/planChange/scope';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// The PLANNER'S TURN in the plan-change thread (MOTIR-2226) — the consuming half
// of MOTIR-2222's boundary contract, against a REAL Postgres (the motir-core
// convention). Only the motir-ai boundary client is mocked, which is the same
// exception every AI service test takes; the enum, the row lock, the
// `(session_id, seq)` unique, the workspace scoping and the access gate all run
// for real.
//
// What these prove, criterion by criterion:
//   * the new `assistant` role persists, carrying its producing `jobId` and a
//     NULL `authorId`, and leaves existing `user` / `system` turns untouched;
//   * it rides the SAME row-locked, read-derived `seq` allocation — including
//     under genuine concurrency, so no second allocation route was introduced;
//   * exactly ONE assistant turn per job, however many times the recording is
//     replayed (a reload, a second tab, a re-read);
//   * a job that carries no utterance is NOT an error — the run still happened;
//   * the report's bare work-item keys are rewritten to the canonical chip token
//     and resolved into the session DTO's `workItemRefs`.

const getJobMock = vi.fn();
const submitJobMock = vi.fn(async () => ({ jobId: 'job-augment-1' }));

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
  getJob: (...args: unknown[]) => getJobMock(...(args as [])),
  streamJob: vi.fn(),
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

function projectCtx(fx: WorkItemFixture): ProjectContext {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

/** A settled job whose result carries the planner's utterance. */
function jobWithTurn(turn: unknown) {
  return { jobId: 'job-augment-1', status: 'succeeded', result: { turn }, error: null };
}

/** Open a thread, put a user turn on it, and SUBMIT — the state a real planner
 *  turn always arrives into (the recording is gated on the thread's own job). */
async function submittedThread(ctx: ProjectContext) {
  await planChangeSessionsService.getOrCreateForProject(ctx);
  await planChangeSessionsService.appendTurn('add payments', ctx);
  return planChangeSessionsService.submit(ctx);
}

async function threadRows(fx: WorkItemFixture) {
  const session = await planChangeSessionRepository.findByProjectAndScope(
    fx.projectId,
    PROJECT_SCOPE_KEY,
    fx.workspaceId,
  );
  return planChangeTurnRepository.listBySessionId(session!.id, fx.workspaceId);
}

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockClear();
  submitJobMock.mockResolvedValue({ jobId: 'job-augment-1' });
  getJobMock.mockReset();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
});

describe('recordPlannerTurn — the assistant turn persists', () => {
  it('files the planner’s report as an `assistant` turn with its jobId and a NULL authorId', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    getJobMock.mockResolvedValue(
      jobWithTurn({ action: 'draft', message: 'I searched the plan.', question: null }),
    );

    const dto = await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx);

    const assistant = dto.turns.filter((t) => t.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.body).toBe('I searched the plan.');
    // The producing job rides on the turn — it is provenance AND the idempotency
    // key the replay guard below depends on.
    expect(assistant[0]!.jobId).toBe('job-augment-1');
    // No human wrote it, exactly as for a `system` marker.
    expect(assistant[0]!.authorId).toBeNull();
    expect(assistant[0]!.question).toBeNull();
    expect(assistant[0]!.isAnswer).toBe(false);
  });

  it('carries the ONE Gate-2 question when the turn asked', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    getJobMock.mockResolvedValue(
      jobWithTurn({
        action: 'ask',
        message: 'When you say “add payments” — which direction?',
        question: 'Taking money in, or paying suppliers out?',
      }),
    );

    const dto = await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx);
    const asked = dto.turns.find((t) => t.role === 'assistant');
    // Persisted, not held on the client — this is the whole reason the pending
    // question survives a reload and can still be answered tomorrow.
    expect(asked!.question).toBe('Taking money in, or paying suppliers out?');
  });

  it('leaves the EXISTING `user` and `system` turns untouched', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    const before = await threadRows(fx);
    getJobMock.mockResolvedValue(
      jobWithTurn({ action: 'draft', message: 'a report', question: null }),
    );

    await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx);

    const after = await threadRows(fx);
    // Byte-for-byte identical rows, in the same positions: adding an enum member
    // and two defaulted columns changes nothing that already existed.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(before.map((r) => r.role)).toEqual(['user', 'system']);
    expect(before.every((r) => r.isAnswer === false && r.question === null)).toBe(true);
  });
});

describe('recordPlannerTurn — the SAME locked seq allocation', () => {
  it('appends on the shared row-locked path: gapless seq, bumped turnCount', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    getJobMock.mockResolvedValue(
      jobWithTurn({ action: 'draft', message: 'a report', question: null }),
    );

    await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx);

    const rows = await threadRows(fx);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.role)).toEqual(['user', 'system', 'assistant']);
    const session = await planChangeSessionRepository.findByProjectAndScope(
      fx.projectId,
      PROJECT_SCOPE_KEY,
      fx.workspaceId,
    );
    expect(session!.turnCount).toBe(3);
  });

  it('SERIALIZES an assistant turn racing a user turn — no `(sessionId, seq)` collision', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    getJobMock.mockResolvedValue(
      jobWithTurn({ action: 'draft', message: 'a report', question: null }),
    );

    // The regression this guards: an assistant turn allocated OUTSIDE the lock
    // would read the same `turnCount` as the concurrent user append, and one of
    // the two would be lost to the unique. Both must land, in some order.
    await Promise.all([
      planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx),
      planChangeSessionsService.appendTurn('and make them smaller', ctx),
    ]);

    const rows = await threadRows(fx);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3]);
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(1);
    expect(rows.filter((r) => r.role === 'user').map((r) => r.body)).toEqual([
      'add payments',
      'and make them smaller',
    ]);
  });
});

describe('recordPlannerTurn — exactly ONE turn per job', () => {
  it('a REPLAYED recording of the same job adds nothing', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    getJobMock.mockResolvedValue(
      jobWithTurn({ action: 'draft', message: 'a report', question: null }),
    );

    await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx);
    const dto = await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx);

    // A reload, a second tab and a retried settle all replay this call — each is
    // a no-op that returns the thread as it stands, never a duplicate bubble.
    expect(dto.turns.filter((t) => t.role === 'assistant')).toHaveLength(1);
    expect(dto.turnCount).toBe(3);
  });

  it('holds under CONCURRENT replays — the guard is inside the lock', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    getJobMock.mockResolvedValue(
      jobWithTurn({ action: 'draft', message: 'a report', question: null }),
    );

    // Two tabs settling at once. Checked outside the lock, both would see "not
    // there yet" and both would insert.
    await Promise.all([
      planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx),
      planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx),
    ]);

    const rows = await threadRows(fx);
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(1);
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2]);
  });
});

describe('recordPlannerTurn — a silent job is not a failure', () => {
  it.each([
    ['no result at all', null],
    ['a result with no turn', {}],
    ['a turn with no message', { turn: { action: 'draft', question: null } }],
    ['a turn whose message is blank', { turn: { action: 'draft', message: '   ' } }],
    ['a malformed turn', { turn: 'nonsense' }],
  ])('tolerates %s — the thread is returned unchanged', async (_label, result) => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    getJobMock.mockResolvedValue({
      jobId: 'job-augment-1',
      status: 'succeeded',
      result,
      error: null,
    });

    const dto = await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx);

    // The plan-edit run itself succeeded and its proposals are on the canvas.
    // The worst outcome of an unreadable utterance is a thread with no narration.
    expect(dto.turns.filter((t) => t.role === 'assistant')).toHaveLength(0);
    expect(dto.turnCount).toBe(2);
  });

  it('refuses a job the thread did not submit, without touching motir-ai', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);

    const dto = await planChangeSessionsService.recordPlannerTurn('someone-elses-job', ctx);

    expect(dto.turns.filter((t) => t.role === 'assistant')).toHaveLength(0);
    // Gated BEFORE the read: a job this conversation never ran has no business
    // narrating into it, and is not worth a round-trip to discover.
    expect(getJobMock).not.toHaveBeenCalled();
  });
});

describe('recordPlannerTurn — work-item references', () => {
  it('rewrites a bare key to the chip token and resolves it into `workItemRefs`', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    const target = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'epic', title: 'Billing' },
      fx.ctx,
    );
    getJobMock.mockResolvedValue(
      jobWithTurn({
        action: 'draft',
        message: `I searched the plan. ${target.identifier} already covers it.`,
        question: null,
      }),
    );

    const dto = await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx);

    const report = dto.turns.find((t) => t.role === 'assistant')!;
    // The SHIPPED write-side normalization (MOTIR-1440), reused: a bare key both
    // relates and CHIPS, rather than staying plain text.
    expect(report.body).toContain(`[${target.identifier}](motir:${target.id})`);
    // …and the summary the chip renders from rides on the session, exactly as it
    // does for a description or a comment.
    const ref = dto.workItemRefs[target.id];
    expect(ref?.accessible).toBe(true);
    expect(ref && ref.accessible ? ref.identifier : null).toBe(target.identifier);
  });

  it('leaves a key that resolves to nothing as plain text', async () => {
    const ctx = projectCtx(fx);
    await submittedThread(ctx);
    getJobMock.mockResolvedValue(
      jobWithTurn({
        action: 'draft',
        message: `Nothing matched ${fx.projectIdentifier}-999999.`,
        question: null,
      }),
    );

    const dto = await planChangeSessionsService.recordPlannerTurn('job-augment-1', ctx);

    const report = dto.turns.find((t) => t.role === 'assistant')!;
    expect(report.body).toContain(`${fx.projectIdentifier}-999999`);
    expect(report.body).not.toContain('motir:');
    expect(dto.workItemRefs).toEqual({});
  });
});

describe('appendTurn — the answer flag', () => {
  it('records a reply sent from the answer bar as an ANSWER', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);

    await planChangeSessionsService.appendTurn('taking money from customers', ctx, undefined, {
      isAnswer: true,
    });

    const rows = await threadRows(fx);
    expect(rows[0]!.isAnswer).toBe(true);
  });

  it('defaults to NOT an answer — a turn that changed the subject supersedes', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);

    await planChangeSessionsService.appendTurn('actually, re-sequence Billing first', ctx);

    const rows = await threadRows(fx);
    expect(rows[0]!.isAnswer).toBe(false);
  });
});
