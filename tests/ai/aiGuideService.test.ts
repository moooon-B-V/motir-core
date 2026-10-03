import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { GuideContext } from '@/lib/ai/guideWorkItem';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../fixtures';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from '../helpers/workspaceRoleFixtures';

// The GUIDE intent's motir-core intake (Story MOTIR-7459 · MOTIR-7464), route-
// level, against a REAL Postgres — `docs/decisions/conversation-turn-intent.md`
// AMENDMENT 2. Only `getSession` / `getActiveProject` and the motir-ai client (the
// HTTP boundary) are mocked, exactly as `askDebugIntent.test.ts` does.
//
// What this file holds:
//   * the DOOR: a new guide conversation sends its opening turn as `guide`,
//     anchored on the card, and submits EXACTLY ONE `guide_work_item` job whose
//     context carries the card and its rows in list order;
//   * re-opening a card WITH rows resumes and sends nothing; a card with NO rows
//     always starts a new conversation;
//   * the next turn, through the guide door or through `POST /api/ai/ask` with the
//     session id, is a guide turn and never an `ask_project` job;
//   * a replayed `turnId` submits nothing new;
//   * every gate refuses before any write or job.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const submitJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: 'job-1' }));
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: vi.fn(),
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

const { POST: guide } = await import('@/app/api/ai/guide/route');
const { POST: ask } = await import('@/app/api/ai/ask/route');
const { MotirAiOutOfCreditsError } = await import('@/lib/ai/errors');

const BASE = 'http://localhost:3000';
const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

interface GuideBody {
  outcome: string;
  jobId: string | null;
  turnId: string | null;
  started: boolean;
  session: PlanChangeSessionDto;
}
async function guideOk(body: unknown): Promise<GuideBody> {
  const res = await guide(post('/api/ai/guide', body));
  expect(res.status).toBe(200);
  return (await res.json()) as GuideBody;
}

const submittedKinds = () => submitJobMock.mock.calls.map((c) => c[0]);
const guideContextOf = (n: number) =>
  (submitJobMock.mock.calls[n]![2] as { guideContext: GuideContext }).guideContext;

let fx: WorkItemFixture;

async function manualCard(title = 'Rotate the signing key') {
  return createTestWorkItem(fx, { kind: 'task', title, type: 'manual', executor: 'human' });
}

/** A member whose project role holds exactly `permissions`. */
async function memberWithRole(permissions: string[]): Promise<ProjectContext> {
  const user = await createTestUser({ name: 'Guided' });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  const role = await createCustomRoleAs({
    projectId: fx.projectId,
    ctx: fx.ctx,
    name: 'Partial',
    permissions,
  });
  const key = fx.projectIdentifier;
  await addToProjectAs({
    key,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: 'member',
  });
  await setProjectRoleAs({
    key,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: user.id,
    role: role.id,
  });
  session.current = { user: { id: user.id, email: user.email, name: user.name } };
  return { ...activeCtx.current!, userId: user.id };
}

/** Every guide session on the card, any member's. */
async function guideSessions(identifier: string) {
  return adminDb.planChangeSession.findMany({
    where: { projectId: fx.projectId, origin: 'guide', targetKeys: { has: identifier } },
    include: { turns: true },
  });
}

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockReset();
  let n = 0;
  submitJobMock.mockImplementation(async (...args: unknown[]) => ({
    jobId: `job-${String(args[0])}-${++n}`,
  }));
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'test-service-token');
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('the Guide me through door', () => {
  it('opens a guide conversation with its opening turn and submits EXACTLY ONE guide job', async () => {
    const card = await manualCard();
    const body = await guideOk({ itemKey: card.identifier.toLowerCase() });

    expect(body).toMatchObject({
      outcome: 'guiding',
      started: true,
      jobId: 'job-guide_work_item-1',
    });
    expect(submittedKinds()).toEqual(['guide_work_item']);
    expect(body.session.origin).toBe('guide');
    expect(body.session.targetKeys).toEqual([card.identifier]);

    const turns = body.session.turns.filter((t) => t.role === 'user');
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: body.turnId,
      body: `Guide me through ${card.identifier}.`,
      intent: 'guide',
      intentCorrected: false,
      anchorKey: card.identifier,
      jobId: 'job-guide_work_item-1',
    });

    const ctx = guideContextOf(0);
    expect(ctx.card).toMatchObject({
      key: card.identifier,
      title: 'Rotate the signing key',
      type: 'manual',
      executor: 'human',
      pullRequests: [],
    });
    expect(ctx.todos).toEqual({ temporary: false, rows: [] });
    expect(ctx.turns).toEqual([{ role: 'user', body: `Guide me through ${card.identifier}.` }]);
    // No target lock: the card is never parked at `planning` (A2.2).
    expect(await adminDb.planTargetLock.count()).toBe(0);
  });

  it('carries the card’s rows IN LIST ORDER with their done state', async () => {
    const card = await manualCard();
    const a = await workItemTodosService.addTodo(card.id, { text: 'Open the console' }, fx.ctx);
    await workItemTodosService.addTodo(
      card.id,
      { text: 'Rotate', commandText: 'motir keys rotate', executor: 'coding_agent' },
      fx.ctx,
    );
    await workItemTodosService.setTodoDone(a.todo.id, true, fx.ctx);

    await guideOk({ itemKey: card.identifier });
    const rows = guideContextOf(0).todos.rows;
    expect(rows.map((r) => [r.text, r.done, r.executor, r.commandText])).toEqual([
      ['Open the console', true, 'human', null],
      ['Rotate', false, 'coding_agent', 'motir keys rotate'],
    ]);
  });

  it('RE-OPENING a card with rows resumes its conversation and sends nothing', async () => {
    const card = await manualCard();
    await workItemTodosService.addTodo(card.id, { text: 'Open the console' }, fx.ctx);
    const first = await guideOk({ itemKey: card.identifier });
    const again = await guideOk({ itemKey: card.identifier });

    expect(again).toMatchObject({ started: false, jobId: null, turnId: null });
    expect(again.session.id).toBe(first.session.id);
    expect(submittedKinds()).toEqual(['guide_work_item']);
    expect(await guideSessions(card.identifier)).toHaveLength(1);
  });

  it('two CONCURRENT opens on a card with rows land on ONE conversation', async () => {
    const card = await manualCard();
    await workItemTodosService.addTodo(card.id, { text: 'Open the console' }, fx.ctx);
    const [x, y] = await Promise.all([
      guideOk({ itemKey: card.identifier }),
      guideOk({ itemKey: card.identifier }),
    ]);
    expect(x.session.id).toBe(y.session.id);
    expect(submittedKinds()).toEqual(['guide_work_item']);
  });

  it('a card with NO rows always starts a NEW conversation', async () => {
    const card = await manualCard();
    const first = await guideOk({ itemKey: card.identifier });
    const second = await guideOk({ itemKey: card.identifier });

    expect(second.started).toBe(true);
    expect(second.session.id).not.toBe(first.session.id);
    expect(submittedKinds()).toEqual(['guide_work_item', 'guide_work_item']);
  });

  it('never resumes a planning conversation scoped at the same card, nor joins one', async () => {
    const card = await manualCard();
    await workItemTodosService.addTodo(card.id, { text: 'Open the console' }, fx.ctx);
    const planning = await planChangeSessionsService.startWithFirstTurn(
      activeCtx.current!,
      { scopeKey: card.identifier, targetKeys: [card.identifier] },
      'Split this card',
    );
    const opened = await guideOk({ itemKey: card.identifier });
    expect(opened.session.id).not.toBe(planning.id);
    expect(opened.started).toBe(true);
    const resumable = await planChangeSessionsService.findResumable(
      activeCtx.current!,
      card.identifier,
    );
    expect(resumable?.id).toBe(planning.id);
  });

  it('is left out of the Plans room', async () => {
    const card = await manualCard();
    const opened = await guideOk({ itemKey: card.identifier });
    const rows = await adminDb.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM plan_change_session WHERE project_id = ${fx.projectId}`;
    expect(rows.map((r) => r.id)).toContain(opened.session.id);
    const { planChangeSessionRepository } =
      await import('@/lib/repositories/planChangeSessionRepository');
    const listed = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${fx.workspaceId}, true)`;
      return planChangeSessionRepository.listPageByProject(
        {
          projectId: fx.projectId,
          workspaceId: fx.workspaceId,
          limit: 50,
          after: null,
          state: null,
        },
        tx,
      );
    });
    expect(listed.map((r) => r.id)).not.toContain(opened.session.id);
  });
});

describe('the next turn', () => {
  it('through the guide door is a guide turn, with the conversation so far', async () => {
    const card = await manualCard();
    const opened = await guideOk({ itemKey: card.identifier });
    const next = await guideOk({ sessionId: opened.session.id, text: 'Done, what next?' });

    expect(next.jobId).toBe('job-guide_work_item-2');
    const last = next.session.turns.at(-1)!;
    expect(last).toMatchObject({
      role: 'user',
      body: 'Done, what next?',
      intent: 'guide',
      anchorKey: card.identifier,
      jobId: 'job-guide_work_item-2',
    });
    expect(guideContextOf(1).turns.map((t) => t.body)).toEqual([
      `Guide me through ${card.identifier}.`,
      'Done, what next?',
    ]);
  });

  it('through POST /api/ai/ask with the session id is a guide turn, never an ask job', async () => {
    const card = await manualCard();
    const opened = await guideOk({ itemKey: card.identifier });
    const res = await ask(post('/api/ai/ask', { body: 'Next', sessionId: opened.session.id }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      outcome: 'guiding',
      jobId: 'job-guide_work_item-2',
    });
    expect(submittedKinds()).toEqual(['guide_work_item', 'guide_work_item']);
  });

  it('a guide conversation never submits a plan', async () => {
    const card = await manualCard();
    const opened = await guideOk({ itemKey: card.identifier });
    await expect(
      planChangeSessionsService.submit(activeCtx.current!, { sessionId: opened.session.id }),
    ).rejects.toMatchObject({ code: 'GUIDE_SESSION_NOT_PLANNABLE' });
  });
});

describe('a replayed turn', () => {
  it('REPLAYING a turn that has a job submits nothing new', async () => {
    const card = await manualCard();
    const opened = await guideOk({ itemKey: card.identifier });
    const replay = await guideOk({ sessionId: opened.session.id, turnId: opened.turnId });
    expect(replay.jobId).toBe(opened.jobId);
    expect(submittedKinds()).toEqual(['guide_work_item']);
  });

  it('a turn whose submit FAILED stays on the thread, and its retry submits once', async () => {
    const card = await manualCard();
    submitJobMock.mockRejectedValueOnce(new MotirAiOutOfCreditsError('out'));
    const failed = await guide(post('/api/ai/guide', { itemKey: card.identifier }));
    expect(failed.status).toBe(402);

    const [stored] = await guideSessions(card.identifier);
    const turn = stored!.turns.find((t) => t.role === 'user')!;
    expect(turn.jobId).toBeNull();
    expect(turn.intent).toBe('guide');

    const retry = await guideOk({ sessionId: stored!.id, turnId: turn.id });
    // The failed submit consumed no job id, so the retry's job is the first.
    expect(retry.jobId).toBe('job-guide_work_item-1');
    await guideOk({ sessionId: stored!.id, turnId: turn.id });
    expect(submittedKinds()).toEqual(['guide_work_item', 'guide_work_item']);
  });
});

describe('the gates, all before any write or job', () => {
  async function expectRefused(itemKey: string, status: number, code: string) {
    const res = await guide(post('/api/ai/guide', { itemKey }));
    expect(res.status).toBe(status);
    await expect(res.json()).resolves.toMatchObject({ code });
    expect(submitJobMock).not.toHaveBeenCalled();
    expect(await adminDb.planChangeSession.count({ where: { origin: 'guide' } })).toBe(0);
  }

  it('refuses a card that is not manual (422)', async () => {
    const card = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'Code it',
      type: 'code',
      executor: 'coding_agent',
    });
    await expectRefused(card.identifier, 422, 'GUIDE_CARD_NOT_MANUAL');
  });

  it('guides a card whose executor alone is human', async () => {
    const card = await createTestWorkItem(fx, {
      kind: 'task',
      title: 'Review it',
      type: 'code',
      executor: 'human',
    });
    await guideOk({ itemKey: card.identifier });
  });

  it('refuses a Done card and an archived card (409)', async () => {
    const done = await manualCard('Finished');
    await adminDb.workItem.update({ where: { id: done.id }, data: { status: 'done' } });
    await expectRefused(done.identifier, 409, 'GUIDE_CARD_CLOSED');

    const archived = await manualCard('Shelved');
    await adminDb.workItem.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
    await expectRefused(archived.identifier, 409, 'GUIDE_CARD_CLOSED');
  });

  it('refuses a caller without work_item:edit (403)', async () => {
    const card = await manualCard();
    activeCtx.current = await memberWithRole(['project:browse', 'ai:plan']);
    await expectRefused(card.identifier, 403, 'PERMISSION_DENIED');
  });

  it('refuses a caller without ai:plan (403)', async () => {
    const card = await manualCard();
    activeCtx.current = await memberWithRole(['project:browse', 'work_item:edit']);
    await expectRefused(card.identifier, 403, 'PERMISSION_DENIED');
  });

  it('answers 404 for an unknown card and for a card in another project', async () => {
    await expectRefused(`${fx.projectIdentifier}-99999`, 404, 'NOT_FOUND');
    const other = await makeWorkItemFixture({ name: 'Elsewhere', identifier: 'ELSE' });
    const foreign = await createTestWorkItem(other, {
      kind: 'task',
      title: 'Theirs',
      type: 'manual',
      executor: 'human',
    });
    await expectRefused(foreign.identifier, 404, 'NOT_FOUND');
  });

  it('refuses when Motir AI is not configured', async () => {
    const card = await manualCard();
    vi.stubEnv('MOTIR_AI_URL', '');
    const res = await guide(post('/api/ai/guide', { itemKey: card.identifier }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(submitJobMock).not.toHaveBeenCalled();
    expect(await adminDb.planChangeSession.count({ where: { origin: 'guide' } })).toBe(0);
  });
});
