import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeTurnDto } from '@/lib/dto/planChange';
import { createTestUser } from '../../fixtures/userFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { BUG_REF, bugDraft, logBugOffer } from '../../fixtures/logBugOfferFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../../helpers/db';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from '../../helpers/workspaceRoleFixtures';

// THE LOG-A-BUG OFFER, ASSEMBLED (Story MOTIR-9220 · MOTIR-9327) — the core half of
// the story gate, on REAL Postgres. Each card proves its own piece; this suite drives
// the whole path — settle → store → Confirm / typed yes / Decline → landing — through
// the services the routes call, and reads the database back, so the story's two
// promises are proven together: a yes writes ONCE however it arrives, and a no, a
// dead offer or a stale card writes NOTHING.
//
// Mocked: the motir-ai boundary only (`submitJob` captured, `getJob` from a map — the
// settle reads the scripted result through it) and, as a pass-through spy, the code
// context the ask submit resolves, so a confirm that read code would be seen.

const submitJobMock = vi.fn();
const getJobMock = vi.fn();
const jobs = new Map<string, unknown>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: (jobId: string) => getJobMock(jobId),
  streamJob: vi.fn(),
}));

const codeContextSpy = vi.fn();
vi.mock('@/lib/ai/codeContext', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/ai/codeContext')>();
  return {
    ...real,
    resolvePlanningCodeContext: (...args: Parameters<typeof real.resolvePlanningCodeContext>) => {
      codeContextSpy(...args);
      return real.resolvePlanningCodeContext(...args);
    },
  };
});

const { aiAskService } = await import('@/lib/services/aiAskService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planOfferService, bugLoggingAvailable } = await import('@/lib/services/planOfferService');
const { planOfferStartService } = await import('@/lib/services/planOfferStartService');
const { DEBUG_DIAGNOSIS_DIVIDER, debugLandingService } =
  await import('@/lib/services/debugLandingService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { triageService } = await import('@/lib/services/triageService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { seedSystemPrincipal } = await import('@/scripts/plan-seed/systemPrincipal');
const { mapPlanChangeError } = await import('@/app/api/ai/plan-change/_errors');
const { MotirAiOutOfCreditsError } = await import('@/lib/ai/errors');
const {
  DebugAnchorNotTriageBugError,
  DebugTargetChangedError,
  DebugTargetNotAvailableError,
  PlanOfferStartRefusedError,
} = await import('@/lib/planChange/errors');
const { PermissionDeniedError } = await import('@/lib/projects/errors');

const T = { timeout: 120_000 };

let fx: WorkItemFixture;
let motirId: string;
let jobSeq = 0;

beforeEach(async () => {
  await truncateAuthTables();
  await truncateJobRuns();
  jobs.clear();
  jobSeq = 0;
  submitJobMock.mockReset();
  submitJobMock.mockImplementation(async () => ({ jobId: `job-${++jobSeq}` }));
  getJobMock.mockReset();
  getJobMock.mockImplementation(
    async (jobId: string) =>
      jobs.get(jobId) ?? { jobId, status: 'running', result: null, error: null },
  );
  codeContextSpy.mockClear();
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'token');
  fx = await makeWorkItemFixture();
  // The Motir account lives in its OWN meta tenant, as the seed provisions it.
  const metaOwner = await createTestUser({ name: 'Meta owner' });
  const { workspace: metaWs } = await workspacesService.createWorkspace({
    name: 'moooon',
    ownerUserId: metaOwner.id,
  });
  const metaProject = await projectsService.createProject({
    name: 'motir',
    identifier: 'MOTIR',
    workspaceId: metaWs.id,
    actorUserId: metaOwner.id,
  });
  ({ userId: motirId } = await seedSystemPrincipal({
    workspaceId: metaWs.id,
    projectId: metaProject.id,
  }));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await truncateJobRuns();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

function ctxOf(userId: string): ProjectContext {
  return { userId, workspaceId: fx.workspaceId, projectId: fx.projectId, project: fx.project };
}
const owner = () => ctxOf(fx.ownerId);

/** A member seated in the project with a custom role of `permissions`. */
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

/** The asker the story names: may ask Motir AI, may NOT edit a work item. */
const askOnly = (label = 'asker') => member(label, ['project:browse', 'ai:plan']);

async function task(title = 'Comment save path') {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

/** The triage bug the report widget files; the person wrote its text. */
async function triageBug(descriptionMd = 'Type @someone, save — the mention is gone.') {
  return triageService.createSubmission(
    { projectKey: fx.project.identifier, title: 'Mention disappears', kind: 'bug', descriptionMd },
    fx.ctx,
  );
}

const answerWith = (offer?: unknown, extra: Record<string, unknown> = {}) => ({
  intent: 'ask',
  answer: `Saving strips the mention in ${BUG_REF}.`,
  citations: [],
  ...(offer ? { offer } : {}),
  ...extra,
});

/** Type a turn and settle its job with the scripted `ask`; the last answer comes back. */
async function turn(
  pctx: ProjectContext,
  ask: Record<string, unknown>,
  opts: { sessionId?: string; anchorKey?: string; body?: string } = {},
) {
  const submitted = await aiAskService.submitTurn(
    opts.body ?? 'Mentions vanish when I save',
    pctx,
    opts,
  );
  if (!('jobId' in submitted) || !submitted.jobId) throw new Error('not an ask');
  const jobId = submitted.jobId;
  jobs.set(jobId, { jobId, status: 'succeeded', result: { ask }, error: null });
  const settled = await aiAskService.settle(jobId, pctx, { sessionId: submitted.session.id });
  const answers = settled.session.turns.filter((t) => t.role === 'assistant');
  return { sessionId: submitted.session.id, answer: answers.at(-1)!, session: settled.session };
}

type Shape = 'new' | 'anchored' | 'existing';

/** The cards one shape needs, and the answer offering it. */
async function offeredShape(pctx: ProjectContext, shape: Shape, sessionId?: string) {
  const anchor = shape === 'new' ? null : await triageBug();
  const covering = shape === 'existing' ? await task() : null;
  const target =
    shape === 'new'
      ? { kind: 'new', key: null }
      : shape === 'anchored'
        ? { kind: 'anchored', key: anchor!.identifier }
        : { kind: 'existing', key: covering!.identifier };
  const { answer, sessionId: sid } = await turn(pctx, answerWith(logBugOffer({ target })), {
    ...(sessionId ? { sessionId } : {}),
    ...(anchor ? { anchorKey: anchor.identifier } : {}),
  });
  expect(answer.offer?.kind).toBe('log_bug');
  expect(answer.offer?.state).toBe('undecided');
  return { sessionId: sid, offerTurnId: answer.id, seq: answer.seq, anchor, covering };
}

/** Press Confirm, answered with the route's own error mapping. */
async function press(pctx: ProjectContext, sessionId: string, offerTurnId: string) {
  try {
    const body = await planOfferStartService.confirmOffer(pctx, {
      conversationId: sessionId,
      offerTurnId,
    });
    return { status: 200, body: body as unknown as Record<string, unknown> };
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (!mapped) throw err;
    return { status: mapped.status, body: (await mapped.json()) as Record<string, unknown> };
  }
}

/** A typed agreement to the offer at `seq`. */
function typedYes(pctx: ProjectContext, sessionId: string, seq: number) {
  return turn(
    pctx,
    {
      intent: 'ask',
      answer: 'Done — I logged it.',
      citations: [],
      offerReply: { seq, kind: 'log_bug', decision: 'agree' },
    },
    { sessionId, body: 'yes, log it' },
  );
}

async function offerTurn(pctx: ProjectContext, sessionId: string, id: string) {
  const thread = await planChangeSessionsService.getById(pctx, sessionId);
  return thread.turns.find((t) => t.id === id)!;
}

const claimOf = async (id: string) =>
  (await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id } })).debugLandingClaimedAt;

/** Every observable the landing may write: cards, comments, revisions, edges. */
async function writes() {
  const [items, comments, revisions, links] = await Promise.all([
    adminDb.workItem.findMany({
      where: { projectId: fx.projectId },
      select: { id: true, updatedAt: true, descriptionMd: true, reporterId: true },
      orderBy: { id: 'asc' },
    }),
    adminDb.comment.findMany({
      where: { workItem: { projectId: fx.projectId } },
      select: { id: true, workItemId: true, authorId: true },
    }),
    adminDb.workItemRevision.count({ where: { workItem: { projectId: fx.projectId } } }),
    adminDb.workItemLink.count(),
  ]);
  return { items, comments, revisions, links };
}

/** What a shape's one write leaves in the database, read back. */
async function expectLanded(
  shape: Shape,
  setup: Awaited<ReturnType<typeof offeredShape>>,
  before: Awaited<ReturnType<typeof writes>>,
) {
  const after = await writes();
  if (shape === 'new') {
    const created = after.items.filter((i) => !before.items.some((b) => b.id === i.id));
    expect(created).toHaveLength(1);
    const bug = await adminDb.workItem.findUniqueOrThrow({ where: { id: created[0]!.id } });
    expect(bug.kind).toBe('bug');
    expect(bug.triagedAt).toBeNull();
    expect(bug.submittedByUserId).toBeNull();
    expect(bug.descriptionMd).toContain(`\`${BUG_REF}\``);
    expect(after.comments).toHaveLength(before.comments.length);
    return bug.identifier;
  }
  if (shape === 'anchored') {
    expect(after.items).toHaveLength(before.items.length);
    const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: setup.anchor!.id } });
    expect(
      row.descriptionMd!.startsWith('Type @someone, save — the mention is gone.\n\n---\n\n'),
    ).toBe(true);
    expect(row.descriptionMd).toContain(DEBUG_DIAGNOSIS_DIVIDER);
    expect(row.title).toBe('Mention disappears');
    expect(after.comments).toHaveLength(before.comments.length);
    return setup.anchor!.identifier;
  }
  expect(after.items).toHaveLength(before.items.length);
  const added = after.comments.filter((c) => !before.comments.some((b) => b.id === c.id));
  expect(added).toHaveLength(1);
  expect(added[0]!.workItemId).toBe(setup.covering!.id);
  const related = await adminDb.workItemLink.count({
    where: { kind: 'relates_to', fromId: setup.covering!.id, toId: setup.anchor!.id },
  });
  expect(related).toBe(1);
  return setup.covering!.identifier;
}

const OUTCOME: Record<Shape, string> = {
  new: 'diagnose',
  anchored: 'diagnose',
  existing: 'enrich_existing',
};

// ── Each write shape, once, through either door ───────────────────────────────

describe.each<Shape>(['new', 'anchored', 'existing'])('the %s write shape', (shape) => {
  it('Confirm lands it once and records the outcome on the offer’s turn', T, async () => {
    const setup = await offeredShape(owner(), shape);
    const before = await writes();

    const res = await press(owner(), setup.sessionId, setup.offerTurnId);
    expect(res.status).toBe(200);
    const key = await expectLanded(shape, setup, before);
    const landed = await offerTurn(owner(), setup.sessionId, setup.offerTurnId);
    expect(landed.debugLanding).toMatchObject({ outcome: OUTCOME[shape], workItemKey: key });
    expect(landed.debugLanding?.createdInTriage).toBe(false);
    expect(landed.offer?.state).toBe('confirmed');
    expect((res.body as { landing: unknown }).landing).toEqual(landed.debugLanding);
  });

  it(
    'a typed yes lands the identical write, with no model call or code read of its own',
    T,
    async () => {
      const setup = await offeredShape(owner(), shape);
      const before = await writes();
      submitJobMock.mockClear();
      getJobMock.mockClear();
      codeContextSpy.mockClear();

      await typedYes(owner(), setup.sessionId, setup.seq);

      // The yes is one ask: its own submit, its own code context, its own result.
      // Landing the offer adds none of the three.
      expect(submitJobMock).toHaveBeenCalledTimes(1);
      expect(codeContextSpy).toHaveBeenCalledTimes(1);
      expect(new Set(getJobMock.mock.calls.map((c) => c[0]))).toEqual(new Set(['job-2']));
      const key = await expectLanded(shape, setup, before);
      const landed = await offerTurn(owner(), setup.sessionId, setup.offerTurnId);
      expect(landed.debugLanding).toMatchObject({ outcome: OUTCOME[shape], workItemKey: key });
      expect(landed.offer?.state).toBe('confirmed');
    },
  );
});

describe('the confirm reads no code and calls no model', () => {
  it('Confirm submits no job, reads no job and resolves no code context', T, async () => {
    const { sessionId, offerTurnId } = await offeredShape(owner(), 'existing');
    submitJobMock.mockClear();
    getJobMock.mockClear();
    codeContextSpy.mockClear();
    expect((await press(owner(), sessionId, offerTurnId)).status).toBe(200);
    expect(submitJobMock).not.toHaveBeenCalled();
    expect(getJobMock).not.toHaveBeenCalled();
    expect(codeContextSpy).not.toHaveBeenCalled();
  });
});

// ── Exactly once ──────────────────────────────────────────────────────────────

describe('a yes that arrives twice writes once', () => {
  it('Confirm pressed twice in parallel: one write, one outcome', T, async () => {
    const setup = await offeredShape(owner(), 'new');
    const before = await writes();
    const results = await Promise.all([
      press(owner(), setup.sessionId, setup.offerTurnId),
      press(owner(), setup.sessionId, setup.offerTurnId),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results[0]!.body['landing']).toEqual(results[1]!.body['landing']);
    await expectLanded('new', setup, before);
  });

  it('Confirm and a typed yes in parallel: one write, one outcome', T, async () => {
    const setup = await offeredShape(owner(), 'existing');
    const before = await writes();
    const [pressed] = await Promise.all([
      press(owner(), setup.sessionId, setup.offerTurnId),
      typedYes(owner(), setup.sessionId, setup.seq),
    ]);
    expect(pressed.status).toBe(200);
    await expectLanded('existing', setup, before);
    const landed = await offerTurn(owner(), setup.sessionId, setup.offerTurnId);
    expect(pressed.body['landing']).toEqual(landed.debugLanding);
  });

  it(
    'Confirm from two tabs of the same sender: one write; the second sees it consumed',
    T,
    async () => {
      const setup = await offeredShape(owner(), 'anchored');
      const before = await writes();
      // Two tabs are two requests carrying their own context, racing the same claim.
      const [a, b] = await Promise.all([
        press({ ...owner() }, setup.sessionId, setup.offerTurnId),
        press({ ...owner() }, setup.sessionId, setup.offerTurnId),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(a.body['landing']).toEqual(b.body['landing']);
      await expectLanded('anchored', setup, before);
      // The second tab reloads: the offer is decided, and pressing again writes nothing.
      const reloaded = await offerTurn(owner(), setup.sessionId, setup.offerTurnId);
      expect(reloaded.offer?.state).toBe('confirmed');
      const again = await writes();
      expect((await press(owner(), setup.sessionId, setup.offerTurnId)).status).toBe(200);
      expect(await writes()).toEqual(again);
    },
  );
});

// ── Nothing written ───────────────────────────────────────────────────────────

describe('a no, or a dead offer, writes nothing at any step', () => {
  it('Decline on the rail, then Confirm, then a typed yes', T, async () => {
    const setup = await offeredShape(owner(), 'existing');
    const before = await writes();
    await planOfferService.declinePlanOffer(setup.offerTurnId, owner(), {
      sessionId: setup.sessionId,
    });
    expect(await writes()).toEqual(before);
    expect((await press(owner(), setup.sessionId, setup.offerTurnId)).status).toBe(409);
    await typedYes(owner(), setup.sessionId, setup.seq);
    expect(await writes()).toEqual(before);
    const turn0 = await offerTurn(owner(), setup.sessionId, setup.offerTurnId);
    expect(turn0.debugLanding ?? null).toBeNull();
  });

  it('a new question, then Confirm, then a typed yes', T, async () => {
    const setup = await offeredShape(owner(), 'new');
    const before = await writes();
    await turn(
      owner(),
      { intent: 'ask', answer: 'The sprint ends Friday.', citations: [] },
      { sessionId: setup.sessionId, body: 'when does the sprint end?' },
    );
    expect(await writes()).toEqual(before);
    expect((await press(owner(), setup.sessionId, setup.offerTurnId)).status).toBe(409);
    await typedYes(owner(), setup.sessionId, setup.seq);
    expect(await writes()).toEqual(before);
  });

  it('a non-agreeing reply, then Confirm, then a typed yes', T, async () => {
    const setup = await offeredShape(owner(), 'anchored');
    const before = await writes();
    await turn(
      owner(),
      {
        intent: 'ask',
        answer: 'Understood — I will leave it.',
        citations: [],
        offerReply: { seq: setup.seq, kind: 'log_bug', decision: 'decline' },
      },
      { sessionId: setup.sessionId, body: 'no, leave it' },
    );
    expect(await writes()).toEqual(before);
    expect((await offerTurn(owner(), setup.sessionId, setup.offerTurnId)).offer?.state).toBe(
      'declined',
    );
    expect((await press(owner(), setup.sessionId, setup.offerTurnId)).status).toBe(409);
    await typedYes(owner(), setup.sessionId, setup.seq);
    expect(await writes()).toEqual(before);
  });

  it('a replaced offer writes nothing; the newer one writes once', T, async () => {
    const older = await offeredShape(owner(), 'new');
    const newer = await offeredShape(owner(), 'new', older.sessionId);
    expect((await offerTurn(owner(), older.sessionId, older.offerTurnId)).offer?.state).toBe(
      'superseded',
    );
    const before = await writes();
    expect((await press(owner(), older.sessionId, older.offerTurnId)).status).toBe(409);
    expect(await writes()).toEqual(before);

    expect((await press(owner(), newer.sessionId, newer.offerTurnId)).status).toBe(200);
    await expectLanded('new', newer, before);
  });
});

// ── Refusals release the claim ────────────────────────────────────────────────

describe('a target that changed is refused, untouched, and the claim released', () => {
  it(
    'an anchored bug edited after the offer: refused, and a fresh offer still lands',
    T,
    async () => {
      const setup = await offeredShape(owner(), 'anchored');
      await workItemsService.updateWorkItem(
        setup.anchor!.id,
        { descriptionMd: 'Edited by the reporter.' },
        fx.ctx,
      );
      const before = await writes();

      const res = await press(owner(), setup.sessionId, setup.offerTurnId);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'DEBUG_TARGET_CHANGED' });
      expect(await writes()).toEqual(before);
      expect(await claimOf(setup.offerTurnId)).toBeNull();

      // The refused claim blocks nothing: a fresh offer on the same bug lands once.
      const { answer } = await turn(
        owner(),
        answerWith(logBugOffer({ target: { kind: 'anchored', key: setup.anchor!.identifier } })),
        { sessionId: setup.sessionId, anchorKey: setup.anchor!.identifier },
      );
      expect((await press(owner(), setup.sessionId, answer.id)).status).toBe(200);
      const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: setup.anchor!.id } });
      expect(row.descriptionMd!.startsWith('Edited by the reporter.')).toBe(true);
      expect(row.descriptionMd).toContain(DEBUG_DIAGNOSIS_DIVIDER);
    },
  );

  it('a covering card the sender can no longer read: refused, nothing written', T, async () => {
    const asker = await askOnly();
    const setup = await offeredShape(asker, 'existing');
    // The sender's access is removed between the offer and the press: out of the
    // project, and out of the workspace whose members an open project admits.
    await adminDb.projectMembership.deleteMany({
      where: { projectId: fx.projectId, userId: asker.userId },
    });
    await adminDb.workspaceMembership.deleteMany({
      where: { workspaceId: fx.workspaceId, userId: asker.userId },
    });
    const before = await writes();

    const res = await press(asker, setup.sessionId, setup.offerTurnId);
    expect([403, 404]).toContain(res.status);
    expect(await writes()).toEqual(before);
    expect(await claimOf(setup.offerTurnId)).toBeNull();
  });

  it('an anchor that stopped being a triage bug: refused, nothing written', T, async () => {
    const setup = await offeredShape(owner(), 'anchored');
    await adminDb.workItem.update({ where: { id: setup.anchor!.id }, data: { triagedAt: null } });
    const before = await writes();

    const res = await press(owner(), setup.sessionId, setup.offerTurnId);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'DEBUG_ANCHOR_NOT_TRIAGE_BUG' });
    expect(await writes()).toEqual(before);
    expect(await claimOf(setup.offerTurnId)).toBeNull();
  });

  it(
    'a typed yes to a stale target: refused, the answer still lands, nothing written',
    T,
    async () => {
      const setup = await offeredShape(owner(), 'anchored');
      await workItemsService.updateWorkItem(
        setup.anchor!.id,
        { descriptionMd: 'Edited by the reporter.' },
        fx.ctx,
      );
      const before = await writes();

      const { answer } = await typedYes(owner(), setup.sessionId, setup.seq);
      expect(answer.body).toBe('Done — I logged it.');
      expect(await writes()).toEqual(before);
      expect(await claimOf(setup.offerTurnId)).toBeNull();
      // Still confirmable on the rail: the refusal left the offer as it found it.
      const offer = await offerTurn(owner(), setup.sessionId, setup.offerTurnId);
      expect(offer.debugLanding ?? null).toBeNull();
    },
  );

  // Every refusal the landing can raise is swallowed on the typed-yes path, so the
  // answer always lands; anything else is a real failure and reaches the settle.
  it.each([
    ['target changed', () => new DebugTargetChangedError('MOTIR-1')],
    ['target not available', () => new DebugTargetNotAvailableError()],
    ['anchor not a triage bug', () => new DebugAnchorNotTriageBugError('MOTIR-1')],
    ['offer not open', () => new PlanOfferStartRefusedError('offer_not_open')],
    ['permission denied', () => new PermissionDeniedError(fx.projectId, 'ai:plan')],
  ])('a typed yes the landing refuses (%s): the answer lands', T, async (_label, refusal) => {
    const setup = await offeredShape(owner(), 'new');
    const spy = vi
      .spyOn(debugLandingService, 'confirmLogBugOffer')
      .mockRejectedValueOnce(refusal());
    try {
      const { answer } = await typedYes(owner(), setup.sessionId, setup.seq);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(answer.body).toBe('Done — I logged it.');
    } finally {
      spy.mockRestore();
    }
  });

  it('a typed yes whose landing fails for any other reason fails the settle', T, async () => {
    const setup = await offeredShape(owner(), 'new');
    const spy = vi
      .spyOn(debugLandingService, 'confirmLogBugOffer')
      .mockRejectedValueOnce(new Error('database down'));
    try {
      await expect(typedYes(owner(), setup.sessionId, setup.seq)).rejects.toThrow('database down');
    } finally {
      spy.mockRestore();
    }
  });
});

// ── Who writes, and who is offered ────────────────────────────────────────────

describe('every write is Motir’s; a sender without work_item:edit still lands it', () => {
  it.each<Shape>(['new', 'anchored', 'existing'])('the %s shape', T, async (shape) => {
    const asker = await askOnly();
    const setup = await offeredShape(asker, shape);
    expect((await press(asker, setup.sessionId, setup.offerTurnId)).status).toBe(200);

    if (shape === 'new') {
      const bug = await adminDb.workItem.findFirstOrThrow({
        where: { projectId: fx.projectId, kind: 'bug', triagedAt: null },
      });
      expect(bug.reporterId).toBe(motirId);
      expect(bug.submittedByUserId).toBeNull();
    }
    if (shape === 'anchored') {
      const revs = await adminDb.workItemRevision.findMany({
        where: { workItemId: setup.anchor!.id, changedById: motirId },
      });
      expect(revs.length).toBeGreaterThan(0);
    }
    if (shape === 'existing') {
      const comment = await adminDb.comment.findFirstOrThrow({
        where: { workItemId: setup.covering!.id },
      });
      expect(comment.authorId).toBe(motirId);
    }
    // The sender is recorded on none of it.
    expect(
      await adminDb.workItem.count({
        where: { projectId: fx.projectId, reporterId: asker.userId },
      }),
    ).toBe(0);
    expect(await adminDb.workItemRevision.count({ where: { changedById: asker.userId } })).toBe(0);
    expect(await adminDb.comment.count({ where: { authorId: asker.userId } })).toBe(0);
  });
});

describe('suppression at submit and settle', () => {
  it('bug logging is available on ai:plan alone, and never to a stranger', T, async () => {
    expect(await bugLoggingAvailable(await askOnly())).toBe(true);
    expect(await bugLoggingAvailable(await member('browser', ['project:browse']))).toBe(false);
    expect(await bugLoggingAvailable({ ...owner(), projectId: 'no-such-project' })).toBe(false);
    vi.stubEnv('MOTIR_AI_URL', '');
    expect(await bugLoggingAvailable(owner())).toBe(false);
  });

  it('out of credits: the submit is refused, so no answer and no offer exist', T, async () => {
    submitJobMock.mockRejectedValueOnce(new MotirAiOutOfCreditsError('No credits left'));
    await expect(
      aiAskService.submitTurn('Mentions vanish when I save', owner()),
    ).rejects.toBeInstanceOf(MotirAiOutOfCreditsError);
    expect(await adminDb.planChangeTurn.count({ where: { role: 'assistant' } })).toBe(0);
  });

  it('Motir AI not configured at settle: the answer lands with no offer', T, async () => {
    const submitted = await aiAskService.submitTurn('Mentions vanish when I save', owner());
    if (!('jobId' in submitted) || !submitted.jobId) throw new Error('not an ask');
    jobs.set(submitted.jobId, {
      jobId: submitted.jobId,
      status: 'succeeded',
      result: { ask: answerWith(logBugOffer()) },
      error: null,
    });
    vi.stubEnv('MOTIR_AI_URL', '');
    const settled = await aiAskService.settle(submitted.jobId, owner(), {
      sessionId: submitted.session.id,
    });
    const answer = settled.session.turns.filter((t) => t.role === 'assistant').at(-1)!;
    expect(answer.body).toContain(BUG_REF);
    expect(answer.offer ?? null).toBeNull();
  });

  it('a plan offer carrying bug fields is stored as the plan only', T, async () => {
    // The envelope holds ONE offer: a `plan` offer with a stray bug draft beside it
    // is read as the plan, and confirming it never reaches the bug landing.
    const { sessionId, answer } = await turn(
      owner(),
      answerWith({
        kind: 'plan',
        requestText: 'Plan the mention fix',
        targetKey: null,
        draft: bugDraft(),
        target: { kind: 'new', key: null },
      }),
    );
    expect(answer.offer?.kind).toBe('plan');
    expect(answer.offer?.bug ?? null).toBeNull();
    const before = await writes();
    await press(owner(), sessionId, answer.id);
    expect(await claimOf(answer.id)).toBeNull();
    const after = await writes();
    expect(after.comments).toEqual(before.comments);
    expect(after.items.filter((i) => i.reporterId === motirId)).toEqual([]);
  });

  it('a malformed draft stores the answer with no offer and does not throw', T, async () => {
    const { answer } = await turn(
      owner(),
      answerWith(logBugOffer({ draft: { grounded: true }, contextRefs: [] })),
    );
    expect(answer.body).toContain(BUG_REF);
    expect(answer.offer ?? null).toBeNull();
  });
});

describe('a reloaded conversation', () => {
  it(
    'returns the stored offer with its target label and refs, and Confirm lands once',
    T,
    async () => {
      const setup = await offeredShape(owner(), 'existing');
      const reloaded: PlanChangeTurnDto = await offerTurn(
        owner(),
        setup.sessionId,
        setup.offerTurnId,
      );
      expect(reloaded.offer).toMatchObject({
        kind: 'log_bug',
        state: 'undecided',
        targetKey: setup.covering!.identifier,
        bug: {
          target: {
            kind: 'existing',
            key: setup.covering!.identifier,
            title: 'Comment save path',
          },
          contextRefs: [BUG_REF],
        },
      });
      const before = await writes();
      expect((await press(owner(), setup.sessionId, setup.offerTurnId)).status).toBe(200);
      await expectLanded('existing', setup, before);
    },
  );
});
