import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeSessionDto, PlanSessionRestartResultDto } from '@/lib/dto/planChange';
import { KEEP_PLANNING_MARKER_BODY, NEW_SESSION_CONFIRM_BODY } from '@/lib/planChange/restart';
import { PLANNING_STATUS_KEY } from '@/lib/planChange/targetLock';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../../fixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from '../../helpers/workspaceRoleFixtures';

// PLAN SOMETHING NEW, ASSEMBLED (Story MOTIR-7631 · MOTIR-7652) — the story's
// motir-core integration gate, route-level against a REAL Postgres.
// `docs/decisions/conversation-turn-intent.md` AMENDMENT 3. Only `getSession` /
// `getActiveProject` and the motir-ai client (`submitJob` / `getJob`, the HTTP
// boundary) are mocked; the ask door → the settle → aiAskService → the session
// service → the target locks → the database run for real.
//
// `tests/planning/planSessionRestart.test.ts` pins the service seams one by one.
// This file holds what only the doors together show: the words reaching a
// confirm with no job behind it, the confirm answered over HTTP, the cards coming
// back, the resume read naming the new session, and every refusal as a status.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const submitJobMock = vi.fn();
const getJobMock = vi.fn();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
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

const { POST: ask } = await import('@/app/api/ai/ask/route');
const { POST: settle } = await import('@/app/api/ai/ask/settle/route');
const { POST: restart } = await import('@/app/api/ai/plan-change/session/restart/route');
const { POST: confirm } = await import('@/app/api/ai/plan-change/session/restart/confirm/route');
const { GET: readSession } = await import('@/app/api/ai/plan-change/session/route');

const DB_TEST_TIMEOUT_MS = 30_000;
const BASE = 'http://localhost:3000';
const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Job results by id — `getJob` answers from here. */
const jobs = new Map<string, unknown>();

let fx: WorkItemFixture;

function actAs(f: WorkItemFixture, userId = f.ownerId): void {
  session.current = { user: { id: userId, email: `${userId}@example.com`, name: 'Person' } };
  activeCtx.current = {
    userId,
    workspaceId: f.workspaceId,
    projectId: f.projectId,
    project: f.project,
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  jobs.clear();
  let n = 0;
  submitJobMock.mockReset();
  submitJobMock.mockImplementation(async (kind: unknown) => ({
    jobId: `job-${String(kind)}-${++n}`,
  }));
  getJobMock.mockReset();
  getJobMock.mockImplementation(async (jobId: string) => {
    const view = jobs.get(jobId);
    if (!view) throw new Error(`unknown job ${jobId}`);
    return { jobId, error: null, ...(view as object) };
  });
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'test-service-token');
  fx = await makeWorkItemFixture();
  actAs(fx);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seedCard(f: WorkItemFixture = fx): Promise<{ id: string; key: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: f.projectId, kind: 'task', title: 'The card' },
    f.ctx,
  );
  await adminDb.workItem.update({ where: { id: dto.id }, data: { status: 'todo' } });
  return { id: dto.id, key: dto.identifier };
}

/** The owner's open conversation on `card`, holding it at Planning, with one turn. */
async function sessionOn(card: { key: string }, f: WorkItemFixture = fx): Promise<string> {
  const row = await adminDb.planChangeSession.create({
    data: {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      createdById: f.ownerId,
      scopeKey: card.key,
      targetKeys: [card.key],
      turnCount: 1,
    },
  });
  await adminDb.planChangeTurn.create({
    data: {
      workspaceId: f.workspaceId,
      sessionId: row.id,
      seq: 0,
      role: 'user',
      body: 'Split the export work so CSV ships first.',
      intent: 'plan_change',
      authorId: f.ownerId,
    },
  });
  await planTargetLockService.acquireForScope(row.id, [card.key], {
    ...f.ctx,
    projectId: f.projectId,
  });
  return row.id;
}

/** Say `words` on `sessionId` and settle the `ask_project` job as `new_session`. */
async function sayNewSession(
  sessionId: string,
  words = 'Forget this, I want to plan something new',
) {
  const askRes = await ask(post('/api/ai/ask', { body: words, sessionId }));
  expect(askRes.status).toBe(200);
  const { jobId } = (await askRes.json()) as { jobId: string };
  jobs.set(jobId, {
    status: 'succeeded',
    result: { ask: { intent: 'new_session', answer: null, citations: [] } },
  });
  return settle(post('/api/ai/ask/settle', { jobId, sessionId }));
}

const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const sessionRow = (id: string) => adminDb.planChangeSession.findUniqueOrThrow({ where: { id } });

describe('the words — a new_session turn', () => {
  it(
    'records ONE user turn with the intent and ONE confirm, and runs no job',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const sessionId = await sessionOn(card);

      const res = await sayNewSession(sessionId);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { outcome: string; session: PlanChangeSessionDto };
      expect(body.outcome).toBe('confirming');

      const turns = await adminDb.planChangeTurn.findMany({
        where: { sessionId },
        orderBy: { seq: 'asc' },
      });
      expect(turns.map((t) => [t.role, t.intent, t.confirm, t.question])).toEqual([
        ['user', 'plan_change', null, null],
        ['user', 'new_session', null, null],
        ['assistant', null, 'new_session', null],
      ]);
      expect(turns[2]!.body).toBe(NEW_SESSION_CONFIRM_BODY);
      // The ask_project classification was the ONLY model job.
      expect(submitJobMock).toHaveBeenCalledTimes(1);
      expect(submitJobMock.mock.calls[0]![0]).toBe('ask_project');

      // A replayed settle writes nothing.
      const jobId = submitJobMock.mock.results[0]!.value as Promise<{ jobId: string }>;
      const replay = await settle(
        post('/api/ai/ask/settle', { jobId: (await jobId).jobId, sessionId }),
      );
      expect(replay.status).toBe(200);
      expect(await adminDb.planChangeTurn.count({ where: { sessionId } })).toBe(3);
      // Nothing ended: the confirm is a question, not the act.
      expect((await sessionRow(sessionId)).endedAt).toBeNull();
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
    },
  );
});

describe('Confirm — the session ends once, the cards come back, a new session opens', () => {
  it(
    'ends `restarted`, releases the card, returns a new empty session the resume read names',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const sessionId = await sessionOn(card);
      await sayNewSession(sessionId);

      const res = await restart(
        post('/api/ai/plan-change/session/restart', { sessionId, answer: 'confirm' }),
      );
      expect(res.status).toBe(200);
      const out = (await res.json()) as PlanSessionRestartResultDto;
      expect(out.outcome).toBe('restarted');
      expect(out.endedSessionId).toBe(sessionId);

      expect(await sessionRow(sessionId)).toMatchObject({
        endReason: 'restarted',
        endedById: fx.ownerId,
      });
      expect(await statusOf(card.id)).toBe('todo');
      expect(await adminDb.planTargetLock.count({ where: { sessionId } })).toBe(0);

      expect(out.session.id).not.toBe(sessionId);
      expect(out.session.targetKeys).toEqual([card.key]);
      expect(out.session.turns).toEqual([]);
      expect(await sessionRow(out.session.id)).toMatchObject({
        scopeKey: card.key,
        endedAt: null,
        copiedFromSessionId: null,
        origin: 'conversation',
      });

      const resumed = await readSession(
        new Request(`${BASE}/api/ai/plan-change/session?scope=${card.key}`),
      );
      expect(resumed.status).toBe(200);
      const view = (await resumed.json()) as { session: { id: string } | null };
      expect(view.session?.id).toBe(out.session.id);
    },
  );

  it(
    'twice: the session ends ONCE and both answers name the same new session',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const sessionId = await sessionOn(card);
      const req = () =>
        restart(post('/api/ai/plan-change/session/restart', { sessionId, answer: 'confirm' }));

      const [a, b] = await Promise.all([req(), req()]);
      expect([a.status, b.status]).toEqual([200, 200]);
      const [first, second] = (await Promise.all([a.json(), b.json()])) as [
        PlanSessionRestartResultDto,
        PlanSessionRestartResultDto,
      ];
      expect(second.session.id).toBe(first.session.id);
      expect(await adminDb.planChangeSession.count({ where: { projectId: fx.projectId } })).toBe(2);
      expect(
        await adminDb.planChangeSession.count({
          where: { projectId: fx.projectId, endReason: 'restarted' },
        }),
      ).toBe(1);
    },
  );
});

describe('Keep planning — nothing ends', () => {
  it(
    'the control raises the confirm, Keep planning answers it, the session and card stay',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const sessionId = await sessionOn(card);

      const raised = await confirm(
        post('/api/ai/plan-change/session/restart/confirm', { sessionId }),
      );
      expect(raised.status).toBe(200);
      const withConfirm = (await raised.json()) as PlanChangeSessionDto;
      expect(withConfirm.turns.at(-1)).toMatchObject({ role: 'assistant', confirm: 'new_session' });
      // The control runs no job either.
      expect(submitJobMock).not.toHaveBeenCalled();

      const kept = await restart(
        post('/api/ai/plan-change/session/restart', { sessionId, answer: 'keep' }),
      );
      expect(kept.status).toBe(200);
      const after = (await kept.json()) as PlanChangeSessionDto;
      expect(after.id).toBe(sessionId);
      expect(after.turns.at(-1)).toMatchObject({ role: 'system', body: KEEP_PLANNING_MARKER_BODY });

      expect((await sessionRow(sessionId)).endedAt).toBeNull();
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
      expect(await adminDb.planChangeSession.count({ where: { projectId: fx.projectId } })).toBe(1);
    },
  );

  it('rejects an answer that is neither confirm nor keep', async () => {
    const res = await restart(
      post('/api/ai/plan-change/session/restart', { sessionId: 'x', answer: 'maybe' }),
    );
    expect(res.status).toBe(400);
    const noId = await confirm(post('/api/ai/plan-change/session/restart/confirm', {}));
    expect(noId.status).toBe(400);
  });
});

describe('refusals', () => {
  async function memberWith(permissions: string[]): Promise<string> {
    const user = await createTestUser({ name: 'Member' });
    await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
    const role = await createCustomRoleAs({
      projectId: fx.projectId,
      ctx: fx.ctx,
      name: `Role ${permissions.join(' ')}`,
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
    return user.id;
  }

  it(
    "another member's session is PLAN_SESSION_NOT_FOUND, and nothing ends",
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const sessionId = await sessionOn(card);
      actAs(fx, await memberWith(['project:browse', 'ai:plan']));

      for (const res of [
        await restart(
          post('/api/ai/plan-change/session/restart', { sessionId, answer: 'confirm' }),
        ),
        await confirm(post('/api/ai/plan-change/session/restart/confirm', { sessionId })),
      ]) {
        expect(res.status).toBe(404);
        expect(((await res.json()) as { code: string }).code).toBe('PLAN_SESSION_NOT_FOUND');
      }
      expect((await sessionRow(sessionId)).endedAt).toBeNull();
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
    },
  );

  it('a reader without ai:plan is 403', { timeout: DB_TEST_TIMEOUT_MS }, async () => {
    const sessionId = await sessionOn(await seedCard());
    actAs(fx, await memberWith(['project:browse']));

    const res = await restart(
      post('/api/ai/plan-change/session/restart', { sessionId, answer: 'confirm' }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { permission: string }).permission).toBe('ai:plan');
    expect((await sessionRow(sessionId)).endedAt).toBeNull();
  });

  it(
    'a guide conversation has no restart — PLAN_SESSION_NOT_FOUND',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sessionId = await sessionOn(await seedCard());
      await adminDb.planChangeSession.update({
        where: { id: sessionId },
        data: { origin: 'guide' },
      });

      const res = await restart(
        post('/api/ai/plan-change/session/restart', { sessionId, answer: 'confirm' }),
      );
      expect(res.status).toBe(404);
      expect((await sessionRow(sessionId)).endedAt).toBeNull();
    },
  );

  it(
    'the control on an ended session is PLAN_SESSION_ENDED',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const sessionId = await sessionOn(await seedCard());
      await restart(post('/api/ai/plan-change/session/restart', { sessionId, answer: 'confirm' }));

      const res = await confirm(post('/api/ai/plan-change/session/restart/confirm', { sessionId }));
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('PLAN_SESSION_ENDED');
    },
  );
});

describe('no copy for a restarted session', () => {
  it(
    'the resume read never names a `restarted` session as copyable',
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const sessionId = await sessionOn(card);
      const out = (await (
        await restart(post('/api/ai/plan-change/session/restart', { sessionId, answer: 'confirm' }))
      ).json()) as PlanSessionRestartResultDto;
      // Take the new session away so NOTHING resumes — the read then looks for a copy.
      await adminDb.planChangeSession.delete({ where: { id: out.session.id } });

      const res = await readSession(
        new Request(`${BASE}/api/ai/plan-change/session?scope=${card.key}`),
      );
      expect(res.status).toBe(200);
      const view = (await res.json()) as { session: unknown; copyable?: unknown };
      expect(view.session).toBeNull();
      expect(view.copyable ?? null).toBeNull();
    },
  );
});

describe('workspace isolation', () => {
  it(
    "another workspace's owner cannot restart this workspace's session",
    { timeout: DB_TEST_TIMEOUT_MS },
    async () => {
      const card = await seedCard();
      const sessionId = await sessionOn(card);
      const other = await makeWorkItemFixture();
      actAs(other);

      for (const res of [
        await restart(
          post('/api/ai/plan-change/session/restart', { sessionId, answer: 'confirm' }),
        ),
        await restart(post('/api/ai/plan-change/session/restart', { sessionId, answer: 'keep' })),
        await confirm(post('/api/ai/plan-change/session/restart/confirm', { sessionId })),
      ]) {
        expect(res.status).toBe(404);
      }
      expect((await sessionRow(sessionId)).endedAt).toBeNull();
      expect(await adminDb.planChangeTurn.count({ where: { sessionId } })).toBe(1);
      expect(await statusOf(card.id)).toBe(PLANNING_STATUS_KEY);
    },
  );
});

describe('the doors refuse a malformed or unauthenticated request before any write', () => {
  const rawPost = (path: string, body: string) =>
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

  it('an unauthenticated caller is 401 at both doors', async () => {
    session.current = null;
    const a = await restart(
      post('/api/ai/plan-change/session/restart', { sessionId: 'x', answer: 'keep' }),
    );
    const b = await confirm(
      post('/api/ai/plan-change/session/restart/confirm', { sessionId: 'x' }),
    );
    expect([a.status, b.status]).toEqual([401, 401]);
  });

  it('no active project is refused at both doors', async () => {
    activeCtx.current = null;
    const a = await restart(
      post('/api/ai/plan-change/session/restart', { sessionId: 'x', answer: 'keep' }),
    );
    const b = await confirm(
      post('/api/ai/plan-change/session/restart/confirm', { sessionId: 'x' }),
    );
    expect(a.status).toBeGreaterThanOrEqual(400);
    expect(b.status).toBe(a.status);
  });

  it('a body that is not JSON, or names no session, is 400 at both doors', async () => {
    const a = await restart(rawPost('/api/ai/plan-change/session/restart', '{not json'));
    const b = await confirm(rawPost('/api/ai/plan-change/session/restart/confirm', '{not json'));
    const c = await restart(post('/api/ai/plan-change/session/restart', { answer: 'keep' }));
    expect([a.status, b.status, c.status]).toEqual([400, 400, 400]);
  });
});
