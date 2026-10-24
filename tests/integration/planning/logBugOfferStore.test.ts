import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeTurnDto } from '@/lib/dto/planChange';
import { createTestUser } from '../../fixtures/userFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { BUG_REF, logBugOffer } from '../../fixtures/logBugOfferFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from '../../helpers/workspaceRoleFixtures';

// THE LOG-A-BUG OFFER, STORED ON ITS ANSWER (Story MOTIR-9220 · MOTIR-9322), on REAL
// Postgres. The settle re-checks motir-ai's offer, re-resolves its target as the
// sender, and stores what survives on the answer turn beside where a plan offer
// lives — or stores nothing and lets the answer land. Mocked: only the motir-ai
// boundary (`submitJob` captured, `getJob` from a map), as the plan offer's suites do.

const submitJobMock = vi.fn();
const jobs = new Map<string, unknown>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: async (jobId: string) =>
    jobs.get(jobId) ?? { jobId, status: 'running', result: null, error: null },
  streamJob: vi.fn(),
}));

const { aiAskService } = await import('@/lib/services/aiAskService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planOfferStartService } = await import('@/lib/services/planOfferStartService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { triageService } = await import('@/lib/services/triageService');
const { PlanOfferStartRefusedError } = await import('@/lib/planChange/errors');

const T = { timeout: 120_000 };

let fx: WorkItemFixture;
let jobSeq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  jobs.clear();
  jobSeq = 0;
  submitJobMock.mockReset();
  submitJobMock.mockImplementation(async () => ({ jobId: `job-${++jobSeq}` }));
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'token');
  fx = await makeWorkItemFixture();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

function ctxOf(userId: string): ProjectContext {
  return { userId, workspaceId: fx.workspaceId, projectId: fx.projectId, project: fx.project };
}
const owner = () => ctxOf(fx.ownerId);

/** A member seated in the project; `permissions` gives them a custom role. */
async function member(label: string, permissions: string[]): Promise<ProjectContext> {
  const u = await createTestUser({ name: `Member ${label}` });
  await adminDb.workspaceMembership.create({
    data: { userId: u.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
  });
  await addToProjectAs({
    key: fx.project.identifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: u.id,
    role: 'member',
  });
  const role = await createCustomRoleAs({
    projectId: fx.projectId,
    ctx: fx.ctx,
    name: `Role ${label}`,
    permissions,
  });
  await setProjectRoleAs({
    key: fx.project.identifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: u.id,
    role: role.id,
  });
  return ctxOf(u.id);
}

async function task(title = 'Comments') {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

async function triageBug(title = 'Mentions vanish') {
  return triageService.createSubmission(
    { projectKey: fx.project.identifier, title, kind: 'bug' },
    fx.ctx,
  );
}

const answerWith = (offer?: unknown) => ({
  intent: 'ask',
  answer: `Saving strips the mention in ${BUG_REF}.`,
  citations: [],
  ...(offer ? { offer } : {}),
});

/** Type a turn (optionally anchored), settle its job with `ask`, return the answer. */
async function turn(
  pctx: ProjectContext,
  ask: Record<string, unknown>,
  opts: { sessionId?: string; anchorKey?: string } = {},
) {
  const submitted = await aiAskService.submitTurn('Mentions vanish when I save', pctx, opts);
  if (!('jobId' in submitted) || !submitted.jobId) throw new Error('not an ask');
  const jobId = submitted.jobId;
  jobs.set(jobId, { jobId, status: 'succeeded', result: { ask }, error: null });
  const settled = await aiAskService.settle(jobId, pctx, { sessionId: submitted.session.id });
  return { sessionId: submitted.session.id, answer: lastAnswer(settled.session.turns) };
}

function lastAnswer(turns: readonly PlanChangeTurnDto[]): PlanChangeTurnDto {
  return turns.filter((t) => t.role === 'assistant').at(-1)!;
}

describe('a valid offer is stored on its answer', () => {
  it('returns it on the turn DTO with kind, target label and refs', T, async () => {
    const { answer } = await turn(owner(), answerWith(logBugOffer()));

    expect(answer.body).toContain(BUG_REF);
    expect(answer.offer).toMatchObject({
      kind: 'log_bug',
      requestMd: 'Saving a comment drops the @mention',
      targetKey: null,
      state: 'undecided',
      cannotStart: null,
      bug: {
        title: 'Saving a comment drops the @mention',
        acceptanceCriteria: ['A saved comment keeps its @mention'],
        target: { kind: 'new', key: null, title: null },
        targetUpdatedAt: null,
        contextRefs: [BUG_REF],
      },
    });
    expect(answer.offer?.bug?.draft.grounded).toBe(true);
  });

  it('is returned again when the conversation is reloaded', T, async () => {
    const { sessionId, answer } = await turn(owner(), answerWith(logBugOffer()));
    const reloaded = await planChangeSessionsService.getById(owner(), sessionId);
    expect(reloaded.turns.find((t) => t.id === answer.id)?.offer).toEqual(answer.offer);
  });

  it('an existing target the sender reads keeps its key, title and updatedAt', T, async () => {
    const covering = await task('Comment save path');
    const { answer } = await turn(
      owner(),
      answerWith(logBugOffer({ target: { kind: 'existing', key: covering.identifier } })),
    );
    expect(answer.offer?.bug?.target).toEqual({
      kind: 'existing',
      key: covering.identifier,
      title: 'Comment save path',
    });
    expect(answer.offer?.targetKey).toBe(covering.identifier);
    expect(answer.offer?.bug?.targetUpdatedAt).toBe(covering.updatedAt);
  });

  it(
    'an anchored target that is the turn’s triage anchor is kept, with its updatedAt',
    T,
    async () => {
      const bug = await triageBug();
      const { answer } = await turn(
        owner(),
        answerWith(logBugOffer({ target: { kind: 'anchored', key: bug.identifier } })),
        { anchorKey: bug.identifier },
      );
      expect(answer.offer?.bug?.target).toMatchObject({ kind: 'anchored', key: bug.identifier });
      expect(answer.offer?.bug?.targetUpdatedAt).toEqual(expect.any(String));
    },
  );
});

describe('a claim the sender cannot stand behind degrades', () => {
  it('an unknown existing key degrades to new', T, async () => {
    const { answer } = await turn(
      owner(),
      answerWith(
        logBugOffer({ target: { kind: 'existing', key: `${fx.project.identifier}-999` } }),
      ),
    );
    expect(answer.offer?.bug?.target).toEqual({ kind: 'new', key: null, title: null });
  });

  it('an existing key that is the anchor degrades to anchored', T, async () => {
    const bug = await triageBug();
    const { answer } = await turn(
      owner(),
      answerWith(logBugOffer({ target: { kind: 'existing', key: bug.identifier } })),
      { anchorKey: bug.identifier },
    );
    expect(answer.offer?.bug?.target).toMatchObject({ kind: 'anchored', key: bug.identifier });
  });

  it(
    'an existing key the sender cannot read degrades to anchored when the turn has one',
    T,
    async () => {
      const bug = await triageBug();
      const { answer } = await turn(
        owner(),
        answerWith(logBugOffer({ target: { kind: 'existing', key: 'ZZZ-1' } })),
        { anchorKey: bug.identifier },
      );
      expect(answer.offer?.bug?.target).toMatchObject({ kind: 'anchored', key: bug.identifier });
    },
  );

  it('an anchored key that is not the turn’s anchor degrades to new', T, async () => {
    const other = await triageBug('Another report');
    const { answer } = await turn(
      owner(),
      answerWith(logBugOffer({ target: { kind: 'anchored', key: other.identifier } })),
    );
    expect(answer.offer?.bug?.target).toEqual({ kind: 'new', key: null, title: null });
  });

  it('an anchor that is not a triage bug cannot be anchored onto', T, async () => {
    const plain = await task('Not a triage bug');
    const { answer } = await turn(
      owner(),
      answerWith(logBugOffer({ target: { kind: 'anchored', key: plain.identifier } })),
      { anchorKey: plain.identifier },
    );
    expect(answer.offer?.bug?.target).toEqual({ kind: 'new', key: null, title: null });
  });
});

describe('no offer, and the answer still lands', () => {
  it.each([
    ['a draft failing the authored-bug check', logBugOffer({ draft: { grounded: true } })],
    ['an over-long title', logBugOffer({ title: 'x'.repeat(201) })],
    ['no criteria', logBugOffer({ acceptanceCriteria: [] })],
    ['no code context ref', logBugOffer({ contextRefs: [] })],
  ])('%s', T, async (_label, offer) => {
    const { answer } = await turn(owner(), answerWith(offer));
    expect(answer.body).toContain(BUG_REF);
    expect(answer.offer ?? null).toBeNull();
  });

  it('Motir AI not configured: no offer', T, async () => {
    const pctx = owner();
    const submitted = await aiAskService.submitTurn('Mentions vanish when I save', pctx);
    if (!('jobId' in submitted) || !submitted.jobId) throw new Error('not an ask');
    jobs.set(submitted.jobId, {
      jobId: submitted.jobId,
      status: 'succeeded',
      result: { ask: answerWith(logBugOffer()) },
      error: null,
    });
    vi.stubEnv('MOTIR_AI_URL', '');
    const settled = await aiAskService.settle(submitted.jobId, pctx, {
      sessionId: submitted.session.id,
    });
    expect(lastAnswer(settled.session.turns).offer ?? null).toBeNull();
  });
});

describe('the gate is ai:plan, not work_item:edit', () => {
  it('a member with ai:plan and no edit gets the offer like anyone else', T, async () => {
    const askOnly = await member('ask-only', ['project:browse', 'ai:plan']);
    const { answer } = await turn(askOnly, answerWith(logBugOffer()));
    expect(answer.offer).toMatchObject({ kind: 'log_bug', state: 'undecided', cannotStart: null });
  });
});

describe('one offer at a time', () => {
  it('a newer answer supersedes an older pending bug offer', T, async () => {
    const first = await turn(owner(), answerWith(logBugOffer()));
    const second = await turn(owner(), answerWith(), { sessionId: first.sessionId });
    const thread = await planChangeSessionsService.getById(owner(), second.sessionId);
    expect(thread.turns.find((t) => t.id === first.answer.id)?.offer?.state).toBe('superseded');
  });

  it('a bug offer is never started as a plan', T, async () => {
    const { sessionId, answer } = await turn(owner(), answerWith(logBugOffer()));
    await expect(
      planOfferStartService.confirmPlanOffer(owner(), {
        conversationId: sessionId,
        offerTurnId: answer.id,
      }),
    ).rejects.toBeInstanceOf(PlanOfferStartRefusedError);
    expect(submitJobMock).toHaveBeenCalledTimes(1);
  });

  it('the settle makes no model call beyond reading the job', T, async () => {
    await turn(owner(), answerWith(logBugOffer()));
    // The one submit is the ask itself; landing the offer submits nothing.
    expect(submitJobMock).toHaveBeenCalledTimes(1);
  });
});
