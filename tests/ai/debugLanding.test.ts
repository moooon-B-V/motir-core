import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeTurnDto } from '@/lib/dto/planChange';
import { createTestUser } from '../fixtures/userFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { BUG_REF, logBugOffer } from '../fixtures/logBugOfferFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables, truncateJobRuns } from '../helpers/db';
import {
  addToProjectAs,
  createCustomRoleAs,
  setProjectRoleAs,
} from '../helpers/workspaceRoleFixtures';

// LANDING a confirmed `log_bug` offer (Story MOTIR-9220 · MOTIR-9323), against a REAL
// Postgres. The kept debug landing (MOTIR-7049) is fed by the stored offer instead of
// a `debug_bug` job result: the Confirm press and a typed yes reach ONE claimed write,
// made BY Motir, and record it as `debugLanding` on the offer's own answer turn.
// Mocked: only the motir-ai boundary (`submitJob` captured, `getJob` from a map) — the
// settle, the confirm seam, the comment / update / create authorities and the database
// run for real. Each case reads the database to check that exactly the one card the
// offer names changed, and nothing else did.

const submitJobMock = vi.fn();
const getJobMock = vi.fn();
const jobs = new Map<string, unknown>();
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
  getJob: (jobId: string) => getJobMock(jobId),
  streamJob: vi.fn(),
}));

const { aiAskService } = await import('@/lib/services/aiAskService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { planOfferService } = await import('@/lib/services/planOfferService');
const { planOfferStartService } = await import('@/lib/services/planOfferStartService');
const { DEBUG_DIAGNOSIS_DIVIDER } = await import('@/lib/services/debugLandingService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { triageService } = await import('@/lib/services/triageService');
const { workspacesService } = await import('@/lib/services/workspacesService');
const { projectsService } = await import('@/lib/services/projectsService');
const { seedSystemPrincipal } = await import('@/scripts/plan-seed/systemPrincipal');
const { mapPlanChangeError } = await import('@/app/api/ai/plan-change/_errors');

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
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'token');
  fx = await makeWorkItemFixture();
  // The Motir account, provisioned into its OWN meta tenant the way the seed does:
  // it is no member of the fixture's workspace.
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

async function task(title = 'Comment save path') {
  return workItemsService.createWorkItem({ projectId: fx.projectId, kind: 'task', title }, fx.ctx);
}

/** The triage bug the report widget files — the anchored path's card. */
async function triageBug(descriptionMd = 'Type @someone, save — the mention is gone.') {
  return triageService.createSubmission(
    { projectKey: fx.project.identifier, title: 'Mention disappears', kind: 'bug', descriptionMd },
    fx.ctx,
  );
}

/** Type a turn and settle its job with `ask`; the thread's last answer comes back. */
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

/** An answer offering to log the bug at `target`. */
async function offered(
  pctx: ProjectContext,
  target: Record<string, unknown> = { kind: 'new', key: null },
  anchorKey?: string,
) {
  const { sessionId, answer } = await turn(
    pctx,
    {
      intent: 'ask',
      answer: `Saving strips the mention in ${BUG_REF}.`,
      citations: [],
      offer: logBugOffer({ target }),
    },
    anchorKey ? { anchorKey } : {},
  );
  expect(answer.offer?.kind).toBe('log_bug');
  return { sessionId, offerTurnId: answer.id, answer };
}

/** Press Confirm, answered with the route's own error mapping. */
async function press(pctx: ProjectContext, sessionId: string, offerTurnId: string) {
  try {
    const body = await planOfferStartService.confirmOffer(pctx, {
      conversationId: sessionId,
      offerTurnId,
    });
    return { status: 200, body };
  } catch (err) {
    const mapped = mapPlanChangeError(err);
    if (!mapped) throw err;
    return { status: mapped.status, body: (await mapped.json()) as Record<string, unknown> };
  }
}

async function offerTurn(sessionId: string, offerTurnId: string): Promise<PlanChangeTurnDto> {
  const thread = await planChangeSessionsService.getById(owner(), sessionId);
  return thread.turns.find((t) => t.id === offerTurnId)!;
}

const claimOf = async (id: string) =>
  (await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id } })).debugLandingClaimedAt;

/** Everything a landing may NEVER move — status, kind, parent, sprint, the triage
 *  marker — for every card in the project, plus every edge. */
async function frozenFacts() {
  const items = await adminDb.workItem.findMany({
    where: { projectId: fx.projectId },
    select: {
      id: true,
      status: true,
      kind: true,
      parentId: true,
      sprintId: true,
      triagedAt: true,
      archivedAt: true,
    },
    orderBy: { id: 'asc' },
  });
  const edges = await adminDb.workItemLink.findMany({
    where: { kind: { not: 'relates_to' } },
    select: { fromId: true, toId: true, kind: true },
  });
  return { items, edges };
}

const itemCount = () => adminDb.workItem.count({ where: { projectId: fx.projectId } });
const commentCount = () =>
  adminDb.comment.count({ where: { workItem: { projectId: fx.projectId } } });

// ── The three write shapes ────────────────────────────────────────────────────

describe('a new bug', () => {
  it(
    'is created ONCE by Motir in the bug destination, born with the diagnosis — not in Triage',
    T,
    async () => {
      const other = await task('Unrelated');
      const { sessionId, offerTurnId } = await offered(owner());
      const before = await frozenFacts();
      const turnsBefore = (await planChangeSessionsService.getById(owner(), sessionId)).turns
        .length;

      const res = await press(owner(), sessionId, offerTurnId);
      expect(res.status).toBe(200);
      const body = res.body as { kind: string; landing: Record<string, unknown> };
      expect(body.kind).toBe('log_bug');

      const created = await adminDb.workItem.findMany({
        where: { projectId: fx.projectId, id: { not: other.id } },
      });
      expect(created).toHaveLength(1);
      const bug = created[0]!;
      expect(body.landing).toEqual({
        outcome: 'diagnose',
        workItemKey: bug.identifier,
        title: 'Saving a comment drops the @mention',
        createdInTriage: false,
      });
      expect(bug.kind).toBe('bug');
      expect(bug.parentId).toBeNull();
      expect(bug.triagedAt).toBeNull();
      expect(bug.submittedByUserId).toBeNull();
      expect(bug.reporterId).toBe(motirId);
      expect(bug.title).toBe('Saving a comment drops the @mention');
      expect(bug.descriptionMd).toContain(`\`${BUG_REF}\``);
      expect(bug.explanationMd).toBe('Mentioned people are never notified.');
      expect(bug.explanationSource).toBe('ai_draft');
      expect(bug.type).toBe('code');
      expect(bug.estimateMinutes).toBe(45);
      expect(bug.difficulty).toBe('low');

      // Nothing else moved; the landing rides the offer's own turn, which is confirmed;
      // no turn was appended.
      const after = await frozenFacts();
      expect(after.items.filter((i) => i.id !== bug.id)).toEqual(before.items);
      expect(after.edges).toEqual(before.edges);
      const landed = await offerTurn(sessionId, offerTurnId);
      expect(landed.debugLanding).toEqual(body.landing);
      expect(landed.offer?.state).toBe('confirmed');
      expect(landed.offer?.confirmedById).toBe(fx.ownerId);
      const thread = await planChangeSessionsService.getById(owner(), sessionId);
      expect(thread.turns).toHaveLength(turnsBefore);
    },
  );
});

describe('an anchored triage bug', () => {
  it(
    "adds the diagnosis BENEATH the person's own text, filling only empty fields, as Motir",
    T,
    async () => {
      const triaged = await triageBug();
      // A field the person set is theirs — it must survive the diagnosis.
      await workItemsService.updateWorkItem(triaged.id, { estimateMinutes: 15 }, fx.ctx);
      const { sessionId, offerTurnId } = await offered(
        owner(),
        { kind: 'anchored', key: triaged.identifier },
        triaged.identifier,
      );
      const before = await frozenFacts();
      const itemsBefore = await itemCount();

      const res = await press(owner(), sessionId, offerTurnId);
      expect(res.status).toBe(200);
      expect((res.body as { landing: unknown }).landing).toEqual({
        outcome: 'diagnose',
        workItemKey: triaged.identifier,
        title: 'Mention disappears',
        createdInTriage: false,
      });

      const row = await adminDb.workItem.findUniqueOrThrow({ where: { id: triaged.id } });
      expect(
        row.descriptionMd!.startsWith('Type @someone, save — the mention is gone.\n\n---\n\n'),
      ).toBe(true);
      expect(row.descriptionMd).toContain(DEBUG_DIAGNOSIS_DIVIDER);
      expect(row.descriptionMd).toContain(`\`${BUG_REF}\``);
      expect(row.title).toBe('Mention disappears');
      expect(row.explanationMd).toBe('Mentioned people are never notified.');
      expect(row.type).toBe('code');
      expect(row.estimateMinutes).toBe(15);
      expect(row.triagedAt).not.toBeNull();

      // The diagnosis is Motir's revision; nothing else was filed or moved.
      const revisions = await adminDb.workItemRevision.findMany({
        where: { workItemId: triaged.id, changedById: motirId },
      });
      expect(revisions.length).toBeGreaterThan(0);
      expect(await itemCount()).toBe(itemsBefore);
      expect(await commentCount()).toBe(0);
      expect(await frozenFacts()).toEqual(before);
    },
  );
});

describe('an existing card that covers it', () => {
  it('gets exactly ONE comment by Motir, related to the anchor — nothing else', T, async () => {
    const covering = await task();
    const triaged = await triageBug();
    const { sessionId, offerTurnId } = await offered(
      owner(),
      { kind: 'existing', key: covering.identifier },
      triaged.identifier,
    );
    const before = await frozenFacts();
    const itemsBefore = await itemCount();

    const res = await press(owner(), sessionId, offerTurnId);
    expect(res.status).toBe(200);
    expect((res.body as { landing: unknown }).landing).toEqual({
      outcome: 'enrich_existing',
      workItemKey: covering.identifier,
      title: 'Comment save path',
      createdInTriage: false,
    });

    const comments = await adminDb.comment.findMany({
      where: { workItem: { projectId: fx.projectId } },
    });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.workItemId).toBe(covering.id);
    expect(comments[0]!.authorId).toBe(motirId);
    expect(comments[0]!.bodyMd).toContain(`\`${BUG_REF}\``);
    expect(comments[0]!.bodyMd).toContain(`[${triaged.identifier}](motir:${triaged.id})`);
    const links = await adminDb.workItemLink.findMany({ where: { kind: 'relates_to' } });
    expect(links.map((l) => [l.fromId, l.toId]).sort()).toEqual(
      [
        [covering.id, triaged.id],
        [triaged.id, covering.id],
      ].sort(),
    );
    expect(await itemCount()).toBe(itemsBefore);
    expect(await frozenFacts()).toEqual(before);
  });
});

// ── Both doors, exactly once ──────────────────────────────────────────────────

/** A typed agreement to the latest pending offer. */
async function typedYes(sessionId: string, seq: number, pctx = owner()) {
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

describe('a typed yes', () => {
  it('states the pending offer by its write and lands the identical write', T, async () => {
    const { sessionId, offerTurnId, answer } = await offered(owner());
    const calls = submitJobMock.mock.calls.length;

    await typedYes(sessionId, answer.seq);
    // The yes was sent with the pending offer stated by the write it agrees to.
    const context = submitJobMock.mock.calls[calls]![2] as Record<string, unknown>;
    expect(context['pendingPlanOffer']).toEqual({
      kind: 'log_bug',
      requestText: 'Log a new bug: Saving a comment drops the @mention',
      targetKey: null,
      seq: answer.seq,
    });

    const bugs = await adminDb.workItem.findMany({ where: { projectId: fx.projectId } });
    expect(bugs).toHaveLength(1);
    expect(bugs[0]!.reporterId).toBe(motirId);
    const landed = await offerTurn(sessionId, offerTurnId);
    expect(landed.debugLanding).toMatchObject({
      outcome: 'diagnose',
      workItemKey: bugs[0]!.identifier,
    });
    expect(landed.offer?.state).toBe('confirmed');
  });

  it(
    'a decline typed back writes nothing and the offer can no longer be confirmed',
    T,
    async () => {
      const { sessionId, offerTurnId, answer } = await offered(owner());
      await turn(
        owner(),
        {
          intent: 'ask',
          answer: 'Fine, I will not log it.',
          citations: [],
          offerReply: { seq: answer.seq, kind: 'log_bug', decision: 'decline' },
        },
        { sessionId, body: 'no' },
      );
      expect((await offerTurn(sessionId, offerTurnId)).offer?.state).toBe('declined');
      expect((await press(owner(), sessionId, offerTurnId)).status).toBe(409);
      expect(await itemCount()).toBe(0);
    },
  );
});

describe('exactly once', () => {
  it('Confirm twice answers the same landing and writes once', T, async () => {
    const { sessionId, offerTurnId } = await offered(owner());
    const first = await press(owner(), sessionId, offerTurnId);
    const second = await press(owner(), sessionId, offerTurnId);
    expect(second.status).toBe(200);
    expect((second.body as { landing: unknown }).landing).toEqual(
      (first.body as { landing: unknown }).landing,
    );
    expect(await itemCount()).toBe(1);
  });

  it('Confirm from two tabs at once files one bug', T, async () => {
    const { sessionId, offerTurnId } = await offered(owner());
    const results = await Promise.all([
      press(owner(), sessionId, offerTurnId),
      press(owner(), sessionId, offerTurnId),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await itemCount()).toBe(1);
    expect((results[0]!.body as { landing: unknown }).landing).toEqual(
      (results[1]!.body as { landing: unknown }).landing,
    );
  });

  it('Confirm then a typed yes writes once', T, async () => {
    const covering = await task();
    const { sessionId, offerTurnId, answer } = await offered(owner(), {
      kind: 'existing',
      key: covering.identifier,
    });
    expect((await press(owner(), sessionId, offerTurnId)).status).toBe(200);
    await typedYes(sessionId, answer.seq);
    expect(await commentCount()).toBe(1);
  });
});

// ── Refusals ──────────────────────────────────────────────────────────────────

describe('a target that changed is refused, nothing written, the claim released', () => {
  it('an existing card edited after the offer', T, async () => {
    const covering = await task();
    const { sessionId, offerTurnId } = await offered(owner(), {
      kind: 'existing',
      key: covering.identifier,
    });
    await workItemsService.updateWorkItem(covering.id, { title: 'Comment save path (v2)' }, fx.ctx);

    const res = await press(owner(), sessionId, offerTurnId);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'DEBUG_TARGET_CHANGED' });
    expect(await commentCount()).toBe(0);
    expect(await claimOf(offerTurnId)).toBeNull();
    expect((await offerTurn(sessionId, offerTurnId)).offer?.state).toBe('undecided');
  });

  it('an anchored triage bug edited after the offer', T, async () => {
    const triaged = await triageBug();
    const { sessionId, offerTurnId } = await offered(
      owner(),
      { kind: 'anchored', key: triaged.identifier },
      triaged.identifier,
    );
    await workItemsService.updateWorkItem(triaged.id, { descriptionMd: 'Edited.' }, fx.ctx);
    const rowBefore = await adminDb.workItem.findUniqueOrThrow({ where: { id: triaged.id } });

    const res = await press(owner(), sessionId, offerTurnId);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'DEBUG_TARGET_CHANGED' });
    const rowAfter = await adminDb.workItem.findUniqueOrThrow({ where: { id: triaged.id } });
    expect(rowAfter.descriptionMd).toBe('Edited.');
    expect(rowAfter.updatedAt).toEqual(rowBefore.updatedAt);
    expect(await claimOf(offerTurnId)).toBeNull();
  });

  it('an anchor that is no longer a triage bug', T, async () => {
    const triaged = await triageBug();
    const { sessionId, offerTurnId } = await offered(
      owner(),
      { kind: 'anchored', key: triaged.identifier },
      triaged.identifier,
    );
    await adminDb.workItem.update({ where: { id: triaged.id }, data: { triagedAt: null } });

    const res = await press(owner(), sessionId, offerTurnId);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'DEBUG_ANCHOR_NOT_TRIAGE_BUG' });
    expect(await claimOf(offerTurnId)).toBeNull();
  });

  it('a card the sender can no longer read', T, async () => {
    const covering = await task();
    const { sessionId, offerTurnId } = await offered(owner(), {
      kind: 'existing',
      key: covering.identifier,
    });
    await workItemsService.deleteWorkItem(covering.id, fx.ctx);

    const res = await press(owner(), sessionId, offerTurnId);
    expect(res.status).toBe(404);
    expect(await commentCount()).toBe(0);
    expect(await claimOf(offerTurnId)).toBeNull();
    expect((await offerTurn(sessionId, offerTurnId)).offer?.state).toBe('undecided');
  });

  it('an archived card is refused and nothing is written', T, async () => {
    const covering = await task();
    const { sessionId, offerTurnId } = await offered(owner(), {
      kind: 'existing',
      key: covering.identifier,
    });
    await workItemsService.archiveWorkItem(covering.id, fx.ctx);

    expect((await press(owner(), sessionId, offerTurnId)).status).toBe(409);
    expect(await commentCount()).toBe(0);
    expect(await claimOf(offerTurnId)).toBeNull();
  });
});

describe('an offer that is no longer open writes nothing', () => {
  it('declined on the rail', T, async () => {
    const { sessionId, offerTurnId } = await offered(owner());
    await planOfferService.declinePlanOffer(offerTurnId, owner(), { sessionId });
    const res = await press(owner(), sessionId, offerTurnId);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ reason: 'offer_not_open' });
    expect(await itemCount()).toBe(0);
  });

  it('replaced by a newer answer', T, async () => {
    const { sessionId, offerTurnId } = await offered(owner());
    await turn(
      owner(),
      { intent: 'ask', answer: 'Something else entirely.', citations: [] },
      { sessionId, body: 'what about the sprint?' },
    );
    const res = await press(owner(), sessionId, offerTurnId);
    expect(res.status).toBe(409);
    expect(await itemCount()).toBe(0);
  });
});

// ── Who writes ────────────────────────────────────────────────────────────────

describe('the write is Motir’s, never the person’s', () => {
  it('a sender without work_item:edit still lands it', T, async () => {
    const asker = await member('asker', ['project:browse', 'ai:plan']);
    const { sessionId, offerTurnId } = await offered(asker);
    const res = await press(asker, sessionId, offerTurnId);
    expect(res.status).toBe(200);
    const bugs = await adminDb.workItem.findMany({ where: { projectId: fx.projectId } });
    expect(bugs).toHaveLength(1);
    expect(bugs[0]!.reporterId).toBe(motirId);
  });

  it('a sender who lost ai:plan is refused with a 403 and nothing is written', T, async () => {
    const asker = await member('narrowed', ['project:browse', 'ai:plan']);
    const { sessionId, offerTurnId } = await offered(asker);
    const browseOnly = await createCustomRoleAs({
      projectId: fx.projectId,
      ctx: fx.ctx,
      name: 'Browse only',
      permissions: ['project:browse'],
    });
    await setProjectRoleAs({
      key: fx.project.identifier,
      actorUserId: fx.ownerId,
      ctx: fx.ctx,
      targetUserId: asker.userId,
      role: browseOnly.id,
    });
    const res = await press(asker, sessionId, offerTurnId);
    expect(res.status).toBe(403);
    expect(await itemCount()).toBe(0);
  });

  it('another member cannot confirm someone else’s offer', T, async () => {
    const { sessionId, offerTurnId } = await offered(owner());
    const other = await member('other', ['project:browse', 'ai:plan']);
    const res = await press(other, sessionId, offerTurnId);
    expect(res.status).toBe(404);
    expect(await itemCount()).toBe(0);
  });
});

describe('the confirm reads no code and calls no model', () => {
  it('submits no job and reads no job', T, async () => {
    const { sessionId, offerTurnId } = await offered(owner());
    submitJobMock.mockClear();
    getJobMock.mockClear();
    expect((await press(owner(), sessionId, offerTurnId)).status).toBe(200);
    expect(submitJobMock).not.toHaveBeenCalled();
    expect(getJobMock).not.toHaveBeenCalled();
  });
});
