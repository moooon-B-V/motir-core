import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { workspacesService } from '@/lib/services/workspacesService';
import { createTestUser } from '../fixtures';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { openTestSession } from '../helpers/planSession';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from '../helpers/workspaceRoleFixtures';

// The DEBUG intent's motir-core plumbing (Story MOTIR-7042 · MOTIR-7047), route-
// level, against a REAL Postgres — `docs/decisions/conversation-turn-intent.md`
// AMENDMENT 1. Only `getSession` / `getActiveProject` and the motir-ai client (the
// HTTP boundary) are mocked, exactly as `askRoutes.test.ts` does; the service →
// repository → database chain runs for real under the app role.
//
// What this file holds:
//   * a turn `ask_project` reads as `debug` is stored as `debug` and submits
//     EXACTLY ONE `debug_bug` job — replayed and raced, still one, and a settle
//     that loses the claim submits none;
//   * the ask door carries an optional `anchorKey`, resolved and gated on the way
//     in, forwarded to `ask_project`, and RE-resolved when the echo comes back;
//   * the gates at the debug dispatch: `work_item:edit` (typed 403, no job, and a
//     plain ask keeps working for that member), Motir AI configured, out of credits.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const submitJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: 'job-ask-1' }));
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
const { MotirAiOutOfCreditsError } = await import('@/lib/ai/errors');

const BASE = 'http://localhost:3000';
const post = (path: string, body: unknown) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const askReq = (body: unknown) => post('/api/ai/ask', body);
const settleReq = (body: unknown) => post('/api/ai/ask/settle', body);

/** A settled `ask_project` job the classifier read as a REPORT OF BROKEN BEHAVIOUR. */
const debugVerdict = (anchorKey?: string) => ({
  status: 'succeeded',
  result: {
    ask: { intent: 'debug', answer: null, citations: [], ...(anchorKey ? { anchorKey } : {}) },
  },
});
const answered = (answer: string) => ({
  status: 'succeeded',
  result: { ask: { intent: 'ask', answer, citations: [] } },
});

/** The job kinds submitted so far, in order. */
const submittedKinds = () => submitJobMock.mock.calls.map((c) => c[0]);
/** The context bag of the n-th submit. */
const contextOf = (n: number) => submitJobMock.mock.calls[n]![2] as Record<string, unknown>;

/** Submit jobs with distinct ids per kind, so the debug job is tellable apart. */
function distinctJobIds() {
  let n = 0;
  submitJobMock.mockImplementation(async (...args: unknown[]) => ({
    jobId: `job-${String(args[0])}-${++n}`,
  }));
}

/** A member whose workspace role is a custom one holding exactly `permissions`. */
async function memberWithRole(permissions: string[]): Promise<ProjectContext> {
  const user = await createTestUser({ name: 'Asker' });
  await workspacesService.addMember({ userId: user.id, workspaceId: fx.workspaceId });
  const role = await createCustomRoleAs({
    projectId: fx.projectId,
    ctx: fx.ctx,
    name: 'Ask only',
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

/** The one `user` turn on the thread. */
async function userTurn() {
  const thread = await openTestSession(activeCtx.current!);
  const turns = thread.turns.filter((t) => t.role === 'user');
  expect(turns).toHaveLength(1);
  return turns[0]!;
}

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockReset();
  distinctJobIds();
  getJobMock.mockReset();
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

describe('a turn the classifier reads as `debug`', () => {
  it('is stored as `debug` and submits EXACTLY ONE `debug_bug` job, with the turn text', async () => {
    const text = 'Saving a comment drops the @mention';
    const submitted = (await (await ask(askReq({ body: text }))).json()) as { jobId: string };
    expect(submittedKinds()).toEqual(['ask_project']);

    getJobMock.mockResolvedValue(debugVerdict());
    const res = await settle(settleReq({ jobId: submitted.jobId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string; jobId: string };
    expect(body).toMatchObject({ outcome: 'debugging', jobId: 'job-debug_bug-2' });

    expect(submittedKinds()).toEqual(['ask_project', 'debug_bug']);
    // The turn text, and NO anchor — this turn had none.
    expect(contextOf(1)).toEqual({ prompt: text });

    const turn = await userTurn();
    expect(turn.intent).toBe('debug');
    expect(turn.intentCorrected).toBe(false);
    // Rebound to the job that actually ran for it, so a reload finds it.
    expect(turn.jobId).toBe('job-debug_bug-2');
    // Nothing is LANDED here (MOTIR-7049): no assistant turn, no new card.
    const thread = await openTestSession(activeCtx.current!);
    expect(thread.turns.filter((t) => t.role === 'assistant')).toHaveLength(0);
  });

  it('a REPLAYED settle of the same job submits no second `debug_bug`', async () => {
    const submitted = (await (await ask(askReq({ body: 'Export hangs' }))).json()) as {
      jobId: string;
    };
    getJobMock.mockResolvedValue(debugVerdict());
    await settle(settleReq({ jobId: submitted.jobId }));
    const replay = await settle(settleReq({ jobId: submitted.jobId }));

    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ outcome: 'silent' });
    expect(submittedKinds().filter((k) => k === 'debug_bug')).toHaveLength(1);
  });

  it('two CONCURRENT settles of the same job still submit exactly one `debug_bug`', async () => {
    const submitted = (await (await ask(askReq({ body: 'Export hangs' }))).json()) as {
      jobId: string;
    };
    getJobMock.mockResolvedValue(debugVerdict());
    const results = await Promise.all([
      settle(settleReq({ jobId: submitted.jobId })),
      settle(settleReq({ jobId: submitted.jobId })),
    ]);
    const outcomes = await Promise.all(results.map(async (r) => (await r.json()).outcome));

    expect(outcomes.sort()).toEqual(['debugging', 'silent']);
    expect(submittedKinds().filter((k) => k === 'debug_bug')).toHaveLength(1);
    expect((await userTurn()).intent).toBe('debug');
  });

  // The race above decides WHICH early return its loser takes: one that reads
  // the thread after the winner's claim leaves at the replay guards, and only
  // one that reads it before reaches the claim and loses it there. So that test
  // reaches the lost-claim return on some runs and not others (MOTIR-7202).
  // This one puts the winner's claim between the read and the claim on purpose.
  it('a settle that LOSES the claim to a concurrent one submits nothing', async () => {
    const submitted = (await (await ask(askReq({ body: 'Export hangs' }))).json()) as {
      jobId: string;
    };
    getJobMock.mockResolvedValue(debugVerdict());
    const claim = planChangeSessionsService.claimTurnIntent.bind(planChangeSessionsService);
    const spy = vi
      .spyOn(planChangeSessionsService, 'claimTurnIntent')
      .mockImplementationOnce(async (...args) => {
        // The concurrent settle claims first, then this one asks.
        expect(await claim(...args)).not.toBeNull();
        return claim(...args);
      });
    try {
      const res = await settle(settleReq({ jobId: submitted.jobId }));
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ outcome: 'silent' });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
    expect(submittedKinds()).toEqual(['ask_project']);
    expect((await userTurn()).intent).toBe('debug');
  });
});

describe('the anchor — `anchorKey` on the ask door', () => {
  it('is resolved, forwarded to `ask_project`, and its ECHO forwarded to `debug_bug`', async () => {
    const bug = await createTestWorkItem(fx, { kind: 'bug', title: 'Mentions vanish' });
    const submitted = (await (
      await ask(askReq({ body: 'This drops the mention', anchorKey: bug.identifier }))
    ).json()) as { jobId: string };
    expect(contextOf(0)).toEqual({ prompt: 'This drops the mention', anchorKey: bug.identifier });

    getJobMock.mockResolvedValue(debugVerdict(bug.identifier));
    await settle(settleReq({ jobId: submitted.jobId }));
    expect(submittedKinds()).toEqual(['ask_project', 'debug_bug']);
    expect(contextOf(1)).toEqual({ prompt: 'This drops the mention', anchorKey: bug.identifier });
  });

  it('the turn still lands on the PROJECT-WIDE thread', async () => {
    const bug = await createTestWorkItem(fx, { kind: 'bug', title: 'Mentions vanish' });
    const res = (await (await ask(askReq({ body: 'why?', anchorKey: bug.identifier }))).json()) as {
      session: { id: string; targetKeys: string[] };
    };
    // The anchor is DATA the job reads, not a thread: the project conversation,
    // with no anchor set of its own.
    expect(res.session.targetKeys).toEqual([]);
    expect((await openTestSession(activeCtx.current!)).id).toBe(res.session.id);
  });

  it('an unknown or FOREIGN key is the no-existence-leak 404 — no turn, no job', async () => {
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const foreign = await createTestWorkItem(other, { kind: 'bug', title: 'Not yours' });

    for (const anchorKey of ['PROD-9999', foreign.identifier, 'not a key']) {
      const res = await ask(askReq({ body: 'why?', anchorKey }));
      expect(res.status, anchorKey).toBe(404);
      await expect(res.json()).resolves.toEqual({
        code: 'NOT_FOUND',
        error: 'Work item not available.',
      });
    }
    expect(submitJobMock).not.toHaveBeenCalled();
    expect(await adminDb.planChangeTurn.count()).toBe(0);
  });

  it('a non-string `anchorKey` is a 400', async () => {
    const res = await ask(askReq({ body: 'why?', anchorKey: 42 }));
    expect(res.status).toBe(400);
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('the ECHO is re-resolved at dispatch, never trusted — a foreign echo submits nothing', async () => {
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const foreign = await createTestWorkItem(other, { kind: 'bug', title: 'Not yours' });
    const submitted = (await (await ask(askReq({ body: 'Export hangs' }))).json()) as {
      jobId: string;
    };
    getJobMock.mockResolvedValue(debugVerdict(foreign.identifier));

    const res = await settle(settleReq({ jobId: submitted.jobId }));
    expect(res.status).toBe(404);
    expect(submittedKinds()).toEqual(['ask_project']);
    expect((await userTurn()).intent).toBe('ask');
  });
});

describe('the gates at the debug dispatch', () => {
  it('a member without `work_item:edit` gets a typed 403 and NO job — and can still ask', async () => {
    activeCtx.current = await memberWithRole(['project:browse', 'ai:plan']);

    // A plain ask needs only `ai:plan`, so the door lets this member in…
    const submitted = (await (await ask(askReq({ body: 'Export hangs' }))).json()) as {
      jobId: string;
    };
    expect(submittedKinds()).toEqual(['ask_project']);

    // …and the DEBUG dispatch, which writes a card as them, refuses.
    getJobMock.mockResolvedValue(debugVerdict());
    const res = await settle(settleReq({ jobId: submitted.jobId }));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: 'PERMISSION_DENIED',
      permission: 'work_item:edit',
    });
    expect(submittedKinds()).toEqual(['ask_project']);
    expect((await userTurn()).intent).toBe('ask');

    // The same member's QUESTION is still answered.
    const second = (await (await ask(askReq({ body: 'What is PROD-1?' }))).json()) as {
      jobId: string;
    };
    getJobMock.mockResolvedValue(answered('It is the export story.'));
    const answeredRes = await settle(settleReq({ jobId: second.jobId }));
    await expect(answeredRes.json()).resolves.toMatchObject({ outcome: 'answered' });
  });

  it('Motir AI not configured refuses BEFORE the turn moves — no job, the turn stays `ask`', async () => {
    const submitted = (await (await ask(askReq({ body: 'Export hangs' }))).json()) as {
      jobId: string;
    };
    vi.stubEnv('MOTIR_AI_URL', '');
    getJobMock.mockResolvedValue(debugVerdict());

    const res = await settle(settleReq({ jobId: submitted.jobId }));
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ code: 'MOTIR_AI_CONFIG' });
    expect(submittedKinds()).toEqual(['ask_project']);
    expect((await userTurn()).intent).toBe('ask');
  });

  it('out of credits is the typed 402; the RETRY re-runs the diagnosis, not the classifier', async () => {
    const submitted = (await (await ask(askReq({ body: 'Export hangs' }))).json()) as {
      jobId: string;
    };
    getJobMock.mockResolvedValue(debugVerdict());
    submitJobMock.mockRejectedValueOnce(new MotirAiOutOfCreditsError('no credits'));

    const res = await settle(settleReq({ jobId: submitted.jobId }));
    expect(res.status).toBe(402);
    await expect(res.json()).resolves.toMatchObject({ code: 'MOTIR_AI_OUT_OF_CREDITS' });
    const turn = await userTurn();
    // The turn keeps what Motir decided; no debug job exists for it yet.
    expect(turn.intent).toBe('debug');

    submitJobMock.mockResolvedValueOnce({ jobId: 'job-debug-retry' });
    const retry = await ask(askReq({ turnId: turn.id }));
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      outcome: 'debugging',
      jobId: 'job-debug-retry',
    });
    expect(submittedKinds()).toEqual(['ask_project', 'debug_bug', 'debug_bug']);
    expect((await userTurn()).jobId).toBe('job-debug-retry');
  });

  it('the retry of a debug turn is gated by `work_item:edit` too', async () => {
    const submitted = (await (await ask(askReq({ body: 'Export hangs' }))).json()) as {
      jobId: string;
    };
    getJobMock.mockResolvedValue(debugVerdict());
    await settle(settleReq({ jobId: submitted.jobId }));
    const turn = await userTurn();
    const thread = await openTestSession(activeCtx.current!);

    // The retry names the conversation by id — it is not this member's own.
    activeCtx.current = await memberWithRole(['project:browse', 'ai:plan']);
    const before = submitJobMock.mock.calls.length;
    const res = await ask(askReq({ turnId: turn.id, sessionId: thread.id }));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ permission: 'work_item:edit' });
    expect(submitJobMock.mock.calls.length).toBe(before);
  });
});

describe('the correction (§3 / A1.5)', () => {
  it('flipping a debug turn re-runs it as an ASK and latches `intentCorrected`', async () => {
    const submitted = (await (await ask(askReq({ body: 'Export hangs' }))).json()) as {
      jobId: string;
    };
    getJobMock.mockResolvedValue(debugVerdict());
    await settle(settleReq({ jobId: submitted.jobId }));
    const turn = await userTurn();

    const res = await ask(askReq({ turnId: turn.id, flip: true }));
    expect(res.status).toBe(200);
    expect(submittedKinds()).toEqual(['ask_project', 'debug_bug', 'ask_project']);
    const after = await userTurn();
    expect(after.intent).toBe('ask');
    expect(after.intentCorrected).toBe(true);
  });
});
