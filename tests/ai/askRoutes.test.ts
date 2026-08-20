import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// The ASK seam, route-level (Story MOTIR-1343 · MOTIR-1819) — `POST /api/ai/ask`
// and `POST /api/ai/ask/settle`, against a REAL Postgres. Only `getSession` /
// `getActiveProject` (no cookies in the test env) and the motir-ai boundary are
// mocked; the service → repository → database chain runs for real.
//
// The contract is `docs/decisions/conversation-turn-intent.md` (MOTIR-1816). The
// two claims worth stating up front, because they are what the route exists to
// hold and what a later edit would most easily break:
//
//   * `/api/ai/ask` is the composer's ONE DOOR, not an ask-only endpoint. A turn
//     that turns out to be a plan change is RE-DISPATCHED to the SHIPPED submit,
//     which is untouched.
//   * The client never supplies an intent. An `intent` in the request body is
//     IGNORED — asserted directly, because "we just don't read it" is a property
//     that survives only as long as somebody is checking.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));

const submitJobMock = vi.fn(async () => ({ jobId: 'job-ask-1' }));
const getJobMock = vi.fn();
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

const { POST: ask } = await import('@/app/api/ai/ask/route');
const { POST: settle } = await import('@/app/api/ai/ask/settle/route');
const { MotirAiUnavailableError } = await import('@/lib/ai/errors');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');

const BASE = 'http://localhost:3000';

function req(path: string, body: unknown, raw?: string): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}
const askReq = (body: unknown, raw?: string) => req('/api/ai/ask', body, raw);
const settleReq = (body: unknown, raw?: string) => req('/api/ai/ask/settle', body, raw);

/** A settled `ask_project` job that ANSWERED. */
function answered(answer: string, citations: string[] = []) {
  return { status: 'succeeded', result: { ask: { intent: 'ask', answer, citations } } };
}
/** A settled `ask_project` job that handed the turn back to the plan engine. */
const redirected = {
  status: 'succeeded',
  result: { ask: { intent: 'plan_change', answer: null, citations: [] } },
};

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockClear();
  submitJobMock.mockResolvedValue({ jobId: 'job-ask-1' });
  getJobMock.mockReset();
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('POST /api/ai/ask — the gates and the body', () => {
  it('401s with no session', async () => {
    session.current = null;
    expect((await ask(askReq({ body: 'why?' }))).status).toBe(401);
  });

  it('404s with no active project', async () => {
    activeCtx.current = null;
    expect((await ask(askReq({ body: 'why?' }))).status).toBe(404);
  });

  it('400s on invalid JSON, and on a body that names neither a turn nor text', async () => {
    expect((await ask(askReq(null, '{not json'))).status).toBe(400);
    expect((await ask(askReq({}))).status).toBe(400);
    expect((await ask(askReq({ body: 42 }))).status).toBe(400);
  });

  it('400s on an empty turn — the typed EMPTY_TURN error, not a 500', async () => {
    const res = await ask(askReq({ body: '   ' }));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'PLAN_CHANGE_EMPTY_TURN' });
  });

  it('404s when a re-run names a turn that is not on this thread', async () => {
    await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    const res = await ask(askReq({ turnId: 'no-such-turn' }));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ code: 'PLAN_CHANGE_TURN_NOT_FOUND' });
  });

  it('502s when motir-ai is unreachable — and the turn SURVIVES on the thread', async () => {
    submitJobMock.mockRejectedValueOnce(new MotirAiUnavailableError('down'));
    const res = await ask(askReq({ body: 'which stories are blocked?' }));
    expect(res.status).toBe(502);

    // The failure posture (ADR §4): a failed submit is recoverable IN PLACE. The
    // person's words are on the thread, so a retry re-runs the same turn rather
    // than asking them to type it again.
    const thread = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    expect(thread.turns.map((t) => t.body)).toEqual(['which stories are blocked?']);
    expect(thread.turns[0]!.jobId).toBeNull();
  });
});

describe('POST /api/ai/ask — the ONE door', () => {
  it('submits an ask_project job for the ACTIVE project, never one from the body', async () => {
    const res = await ask(
      askReq({ body: 'which stories are blocked?', projectId: 'someone-elses-project' }),
    );
    expect(res.status).toBe(200);

    expect(submitJobMock).toHaveBeenCalledTimes(1);
    const [kind, tenant, context] = submitJobMock.mock.calls[0] as unknown as [
      string,
      { projectId: string },
      { prompt: string },
    ];
    expect(kind).toBe('ask_project');
    expect(tenant.projectId).toBe(fx.projectId);
    expect(context.prompt).toBe('which stories are blocked?');
  });

  it('binds the turn to its job and records the intent it is RUNNING as', async () => {
    const res = await ask(askReq({ body: 'why is it blocked?' }));
    const dto = (await res.json()) as { jobId: string; turnId: string };
    expect(dto.jobId).toBe('job-ask-1');

    const thread = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    expect(thread.turns.at(-1)).toMatchObject({
      id: dto.turnId,
      role: 'user',
      intent: 'ask',
      intentCorrected: false,
      jobId: 'job-ask-1',
    });
  });

  it('IGNORES an intent supplied by the client — the mode has no back door', async () => {
    await ask(askReq({ body: 'split the billing epic', intent: 'plan_change' }));

    // The turn ran as an ask because the SERVER decided so; the job that was
    // submitted is the ask job, not a plan-edit one.
    expect((submitJobMock.mock.calls[0] as unknown as [string])[0]).toBe('ask_project');
    const thread = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    expect(thread.turns.at(-1)!.intent).toBe('ask');
  });
});

describe('POST /api/ai/ask/settle — filing what the job produced', () => {
  it('persists the answer as an assistant turn with its citations', async () => {
    const cited = await createTestWorkItem(fx, { kind: 'story', title: 'Billing' });
    const asked = (await (await ask(askReq({ body: 'what is blocked?' }))).json()) as {
      jobId: string;
    };
    getJobMock.mockResolvedValue(answered('One story is blocked.', [cited.identifier]));

    const res = await settle(settleReq({ jobId: asked.jobId }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string };
    expect(body.outcome).toBe('answered');

    const thread = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    expect(thread.turns.at(-1)).toMatchObject({
      role: 'assistant',
      body: 'One story is blocked.',
      citations: [cited.identifier],
      jobId: asked.jobId,
    });
  });

  it('is REPLAYABLE — a second settle of the same job appends nothing', async () => {
    const asked = (await (await ask(askReq({ body: 'what is blocked?' }))).json()) as {
      jobId: string;
    };
    getJobMock.mockResolvedValue(answered('One story is blocked.'));

    await settle(settleReq({ jobId: asked.jobId }));
    await settle(settleReq({ jobId: asked.jobId }));

    const thread = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    expect(thread.turns.filter((t) => t.role === 'assistant')).toHaveLength(1);
  });

  it('files NOTHING when the job said nothing at all — core does not write the assistant’s words', async () => {
    const asked = (await (await ask(askReq({ body: 'what colour is the database?' }))).json()) as {
      jobId: string;
    };
    getJobMock.mockResolvedValue({
      status: 'succeeded',
      result: { ask: { intent: 'ask', answer: null, citations: [] } },
    });

    const body = (await (await settle(settleReq({ jobId: asked.jobId }))).json()) as {
      outcome: string;
    };
    expect(body.outcome).toBe('silent');
    const thread = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    expect(thread.turns.filter((t) => t.role === 'assistant')).toHaveLength(0);
  });

  it('files an honest NO-ANSWER as an ordinary answer with no citations', async () => {
    const asked = (await (await ask(askReq({ body: 'what colour is the database?' }))).json()) as {
      jobId: string;
    };
    // The grounding discipline makes the handler SAY it could not answer; that
    // prose is the answer, and it lands with zero citations.
    getJobMock.mockResolvedValue(answered('The plan and the code graph do not answer that.'));

    await settle(settleReq({ jobId: asked.jobId }));
    const thread = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    expect(thread.turns.at(-1)).toMatchObject({
      role: 'assistant',
      citations: [],
    });
  });

  it('yields `silent` for a job this thread never submitted — a stale replay is not an error', async () => {
    await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    const body = (await (await settle(settleReq({ jobId: 'job-from-another-life' }))).json()) as {
      outcome: string;
    };
    expect(body.outcome).toBe('silent');
    expect(getJobMock).not.toHaveBeenCalled();
  });

  it('400s on invalid JSON and on a missing jobId', async () => {
    expect((await settle(settleReq(null, '{not json'))).status).toBe(400);
    expect((await settle(settleReq({}))).status).toBe(400);
  });
});

describe('the REDIRECT — a turn the handler hands back', () => {
  it('moves the turn to plan_change and dispatches the SHIPPED plan-change submit', async () => {
    const asked = (await (await ask(askReq({ body: 'split the billing epic' }))).json()) as {
      jobId: string;
      turnId: string;
    };
    getJobMock.mockResolvedValue(redirected);
    submitJobMock.mockResolvedValue({ jobId: 'job-augment-9' });

    const body = (await (await settle(settleReq({ jobId: asked.jobId }))).json()) as {
      outcome: string;
      jobId: string;
      planId: string;
    };

    expect(body.outcome).toBe('redirected');
    // The SECOND submit is the shipped plan-edit kind — the plan-change path is
    // called, not re-implemented.
    const kinds = submitJobMock.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(kinds).toEqual(['ask_project', 'augment']);
    expect(body.jobId).toBe('job-augment-9');
    expect(body.planId).toBeTruthy();

    const thread = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    const userTurn = thread.turns.find((t) => t.id === asked.turnId)!;
    // The disposition moved. Nothing was CORRECTED — nobody was ever shown a
    // wrong answer — and the two are different facts.
    expect(userTurn.intent).toBe('plan_change');
    expect(userTurn.intentCorrected).toBe(false);
  });

  it('does not dispatch a SECOND plan-edit job when the redirect is settled twice', async () => {
    const asked = (await (await ask(askReq({ body: 'split the billing epic' }))).json()) as {
      jobId: string;
    };
    getJobMock.mockResolvedValue(redirected);
    submitJobMock.mockResolvedValue({ jobId: 'job-augment-9' });

    await settle(settleReq({ jobId: asked.jobId }));
    const second = (await (await settle(settleReq({ jobId: asked.jobId }))).json()) as {
      outcome: string;
    };

    expect(second.outcome).toBe('silent');
    const kinds = submitJobMock.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(kinds).toEqual(['ask_project', 'augment']);
  });
});

describe('the CORRECTION — re-running one turn the other way', () => {
  it('flips an answered turn to plan_change, latches the flag, and appends no second user turn', async () => {
    const asked = (await (await ask(askReq({ body: 'split the billing epic' }))).json()) as {
      turnId: string;
    };
    submitJobMock.mockResolvedValue({ jobId: 'job-augment-9' });

    const body = (await (await ask(askReq({ turnId: asked.turnId, flip: true }))).json()) as {
      outcome: string;
    };
    expect(body.outcome).toBe('redirected');

    const thread = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    expect(thread.turns.filter((t) => t.role === 'user')).toHaveLength(1);
    expect(thread.turns.find((t) => t.id === asked.turnId)).toMatchObject({
      intent: 'plan_change',
      intentCorrected: true,
    });
  });

  it('flips a plan-change turn back to ask, re-running the SAME text', async () => {
    const asked = (await (await ask(askReq({ body: 'why is this blocked?' }))).json()) as {
      jobId: string;
      turnId: string;
    };
    getJobMock.mockResolvedValue(redirected);
    submitJobMock.mockResolvedValue({ jobId: 'job-augment-9' });
    await settle(settleReq({ jobId: asked.jobId }));

    submitJobMock.mockClear();
    submitJobMock.mockResolvedValue({ jobId: 'job-ask-2' });
    await ask(askReq({ turnId: asked.turnId, flip: true }));

    const [kind, , context] = submitJobMock.mock.calls[0] as unknown as [
      string,
      unknown,
      { prompt: string },
    ];
    expect(kind).toBe('ask_project');
    expect(context.prompt).toBe('why is this blocked?');

    const thread = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    expect(thread.turns.find((t) => t.id === asked.turnId)).toMatchObject({
      intent: 'ask',
      intentCorrected: true,
      jobId: 'job-ask-2',
    });
  });

  it('404s when the named turn is not a USER turn — an answer cannot be re-run', async () => {
    const asked = (await (await ask(askReq({ body: 'what is blocked?' }))).json()) as {
      jobId: string;
    };
    getJobMock.mockResolvedValue(answered('Nothing is blocked.'));
    await settle(settleReq({ jobId: asked.jobId }));
    const thread = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    const assistantTurn = thread.turns.find((t) => t.role === 'assistant')!;

    const res = await ask(askReq({ turnId: assistantTurn.id }));
    expect(res.status).toBe(404);
  });

  it('re-runs a turn that carries NO intent as an ask — the shipped path left it null', async () => {
    // A turn appended through the shipped plan-change door has a null intent
    // (nothing classified it). Re-running it through the ask door must not read
    // that absence as anything but "not yet decided", and the default is `ask`.
    const { POST: openSession } = await import('@/app/api/ai/plan-change/session/route');
    const { POST: appendTurnRoute } = await import('@/app/api/ai/plan-change/session/turns/route');
    await openSession();
    await appendTurnRoute(req('/api/ai/plan-change/session/turns', { body: 'legacy turn' }));
    const before = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    const legacy = before.turns.at(-1)!;
    expect(legacy.intent).toBeNull();

    submitJobMock.mockResolvedValue({ jobId: 'job-ask-3' });
    const res = await ask(askReq({ turnId: legacy.id }));
    expect(res.status).toBe(200);
    expect((submitJobMock.mock.calls.at(-1) as unknown as [string])[0]).toBe('ask_project');

    const after = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    expect(after.turns.find((t) => t.id === legacy.id)).toMatchObject({
      intent: 'ask',
      intentCorrected: false,
    });
  });

  it('a RETRY (no flip) re-runs the same turn under the same intent, uncorrected', async () => {
    submitJobMock.mockRejectedValueOnce(new MotirAiUnavailableError('down'));
    await ask(askReq({ body: 'which stories are blocked?' }));

    const thread = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    const turnId = thread.turns[0]!.id;
    submitJobMock.mockResolvedValue({ jobId: 'job-ask-2' });

    const res = await ask(askReq({ turnId }));
    expect(res.status).toBe(200);

    const after = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    expect(after.turns.filter((t) => t.role === 'user')).toHaveLength(1);
    expect(after.turns[0]).toMatchObject({
      intent: 'ask',
      intentCorrected: false,
      jobId: 'job-ask-2',
    });
  });
});

describe('an ask WRITES NO WORK ITEM', () => {
  it('leaves the project’s items untouched across submit, settle and correction', async () => {
    const before = await adminDb.workItem.count({ where: { projectId: fx.projectId } });

    const asked = (await (await ask(askReq({ body: 'what is blocked?' }))).json()) as {
      jobId: string;
      turnId: string;
    };
    getJobMock.mockResolvedValue(answered('Nothing is blocked.'));
    await settle(settleReq({ jobId: asked.jobId }));
    await ask(askReq({ turnId: asked.turnId }));

    const after = await adminDb.workItem.count({ where: { projectId: fx.projectId } });
    expect(after).toBe(before);
  });
});

describe('the shipped plan-change path is untouched', () => {
  it('its submit still opens an `augment` job over the accumulated turns', async () => {
    const { POST: openSession } = await import('@/app/api/ai/plan-change/session/route');
    const { POST: appendTurnRoute } = await import('@/app/api/ai/plan-change/session/turns/route');
    const { POST: submitRoute } = await import('@/app/api/ai/plan-change/session/submit/route');

    await openSession();
    await appendTurnRoute(req('/api/ai/plan-change/session/turns', { body: 'add payments' }));
    submitJobMock.mockResolvedValue({ jobId: 'job-augment-1' });
    const res = await submitRoute();
    expect(res.status).toBe(200);

    expect((submitJobMock.mock.calls.at(-1) as unknown as [string])[0]).toBe('augment');
    const thread = await planChangeSessionsService.getOrCreateForProject(activeCtx.current!);
    // Its turns carry no intent — the shipped path decides none, and nothing
    // back-filled one onto them.
    expect(thread.turns.filter((t) => t.role === 'user').every((t) => t.intent === null)).toBe(
      true,
    );
  });
});
