import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { ProjectDTO } from '@/lib/dto/projects';
import type { PlanChangeSessionDto } from '@/lib/dto/planChange';
import { mintJobToken } from '@/lib/ai/jobToken';
import { PROJECT_SCOPE } from '@/lib/planChange/scope';
import {
  GUIDE_BUGS_PER_CONVERSATION,
  parseGuideTurn,
  readGuideTurnRecord,
} from '@/lib/ai/guideWorkItem';
import { PLANNER_BUG_FILED_CHANGE_KIND, PLANNER_BUGS_PER_JOB } from '@/lib/ai/plannerTenantBug';
import { bugDestinationService } from '@/lib/services/bugDestinationService';
import { plansService } from '@/lib/services/plansService';
import { workItemTodosService } from '@/lib/services/workItemTodosService';
import { workItemsService } from '@/lib/services/workItemsService';
import { manualWorkGateService } from '@/lib/services/manualWorkGateService';
import { planRevisionRepository } from '@/lib/repositories/planRevisionRepository';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { POST as logBugPOST } from '@/app/api/internal/ai/log-bug/route';
import { createTestWorkItem, makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestProject } from '../../fixtures/projectFixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// STORY MOTIR-7797's motir-core INTEGRATION GATE (MOTIR-7806).
//
// The story lets a CONFIRMED defect be filed the moment it is confirmed. On
// motir-core's side it comes in by exactly two doors, and this file drives each
// the way production does — never the way a fixture would:
//
//   1. a planning run's JOB TOKEN → `POST /api/internal/ai/log-bug`, on a job
//      submitted through `planChangeSessionsService.submit` (the conversation
//      surface's own submit) — NOT a plan seeded by hand;
//   2. a GUIDE TURN landed as the person → `guideLandingService.land` on a turn
//      carrying `file_bug`, opened and continued through `aiGuideService` —
//      NOT `guideBugFilingService.fileGuideBug` called directly.
//
// Each subtask ships its own units and its own real-concurrency test; this file
// does not repeat them. It holds the cross-cutting properties no single
// subtask's units own: the filing end to end, the planless REFUSAL, the SIXTH
// filing refused with the surrounding work carrying on, no cross-project filing,
// and the guide's duplicate citing rather than filing.
//
// ⚠️ THE PLANLESS CASE ASSERTS THE REFUSAL (decision MOTIR-7798 Q2). There is
// no planless arm: the job token carries no job id, so a counter keyed on a
// caller-written `jobId` would be no bound at all, and every run that opens
// PART 1 has its plan before the model can call `log_bug`. A job with no plan
// stays 404 `NO_PLAN_FOR_JOB` — and writes nothing.
//
// Real Postgres throughout. The ONE mock is motir-ai's boundary client
// (`submitJob`), the pattern `tests/integration/planning/planningSessionsGate.test.ts`
// uses; its other exports are inert stubs no path here reaches.

const SERVICE_SECRET = 'core-callback-secret-test';

let jobSeq = 0;
const submitJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: `job-gate-${++jobSeq}` }));

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...args),
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
const { aiGuideService } = await import('@/lib/services/aiGuideService');
const { guideLandingService } = await import('@/lib/services/guideLandingService');

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockClear();
  vi.stubEnv('CORE_CALLBACK_SECRET', SERVICE_SECRET);
  vi.stubEnv('MOTIR_AI_URL', 'http://motir-ai.test');
  vi.stubEnv('MOTIR_AI_SERVICE_TOKEN', 'test-service-token');
  fx = await makeWorkItemFixture();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ─── shared seams ──────────────────────────────────────────────────────────

function pctxOf(project: ProjectDTO): ProjectContext {
  return { userId: fx.ownerId, workspaceId: fx.workspaceId, projectId: project.id, project };
}

const pctx = (): ProjectContext => pctxOf(fx.project);

/** Another project in the SAME workspace, owned by the same person — so the
 *  workspace (tenant) gate alone separates nothing, and the project bound must. */
async function projectB(): Promise<ProjectDTO> {
  return createTestProject({
    workspaceId: fx.workspaceId,
    actorUserId: fx.ownerId,
    identifier: 'OTHR',
    name: 'Other',
  });
}

async function bugFolderOf(projectId: string): Promise<string | null> {
  return (
    await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      bugDestinationService.resolve(projectId, tx),
    )
  ).folderId;
}

const countItems = (projectId: string) => adminDb.workItem.count({ where: { projectId } });
const countFiledRows = () =>
  adminDb.planRevision.count({ where: { changeKind: PLANNER_BUG_FILED_CHANGE_KIND } });

// ─── door 1: the job token ─────────────────────────────────────────────────

/** Submit the way the conversation surface submits: a session with a first
 *  turn, then `planChangeSessionsService.submit` — which binds the Plan by
 *  `sourceJobId` before it returns. */
async function submitConversation(
  ctx: ProjectContext = pctx(),
): Promise<{ jobId: string; planId: string }> {
  const convo = await planChangeSessionsService.startWithFirstTurn(
    ctx,
    PROJECT_SCOPE,
    'the export drops its last row — and plan the fix',
  );
  const { jobId, planId } = await planChangeSessionsService.submit(ctx, { sessionId: convo.id });
  return { jobId, planId };
}

/** POST the route as motir-ai would from inside the job. */
function fileFromJob(
  jobId: string,
  body: Record<string, unknown>,
  tokenProjectId: string = fx.projectId,
): Promise<Response> {
  return logBugPOST(
    new Request('http://core/api/internal/ai/log-bug', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${SERVICE_SECRET}`,
        'x-motir-job-token': mintJobToken({
          userId: fx.ownerId,
          workspaceId: fx.workspaceId,
          projectId: tokenProjectId,
        }),
      },
      body: JSON.stringify({ jobId, descriptionMd: 'Confirmed in the run.', ...body }),
    }),
  );
}

function filedRowsOn(planId: string) {
  return withWorkspaceServiceContext(fx.workspaceId, (tx) =>
    planRevisionRepository.countByPlanAndKind(planId, PLANNER_BUG_FILED_CHANGE_KIND, tx),
  );
}

// ─── door 2: the guide turn ────────────────────────────────────────────────

/** A manual, human card on a workflow status — what Guide me through opens on. */
async function manualCard(opts: { title?: string; parentId?: string } = {}) {
  const item = await createTestWorkItem(fx, {
    kind: 'task',
    title: opts.title ?? 'Rotate the signing key',
    type: 'manual',
    executor: 'human',
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
  });
  // The fixture writes the legacy `open`; a real card sits on a workflow status.
  return adminDb.workItem.update({ where: { id: item.id }, data: { status: 'todo' } });
}

/** A guided task under a story whose status is `storyStatus`. */
async function cardUnderStory(storyStatus: string) {
  const story = await createTestWorkItem(fx, { kind: 'story', title: 'Key rotation' });
  await adminDb.workItem.update({ where: { id: story.id }, data: { status: storyStatus } });
  const card = await manualCard({ parentId: story.id });
  return { story, card };
}

interface GuideTurnHandle {
  jobId: string;
  turnId: string;
  session: PlanChangeSessionDto;
}

/** The guide door (`aiGuideService.open`), which submits the opening turn. */
async function openGuide(itemKey: string): Promise<GuideTurnHandle> {
  const r = await aiGuideService.open(itemKey, pctx());
  expect(r.jobId).not.toBeNull();
  return { jobId: r.jobId!, turnId: r.turnId!, session: r.session };
}

/** The person's next turn in the same conversation. */
async function nextTurn(sessionId: string, text: string): Promise<GuideTurnHandle> {
  const r = await aiGuideService.submitTurn(text, pctx(), { sessionId });
  return { jobId: r.jobId!, turnId: r.turnId!, session: r.session };
}

/** Land the guide turn motir-ai would settle with — through the SAME parse the
 *  settle door applies, then `guideLandingService.land` as the person. */
async function landTurn(h: GuideTurnHandle, actions: unknown[], messageMd = 'Done that.') {
  const turn = h.session.turns.find((t) => t.id === h.turnId)!;
  const result = parseGuideTurn({ messageMd, actions });
  const landed = await guideLandingService.land(
    { jobId: h.jobId, turn, result },
    h.session,
    pctx(),
  );
  expect(landed.outcome).toBe('guided');
  if (landed.outcome !== 'guided') throw new Error('unreachable');
  const reply = landed.session.turns.find((t) => t.role === 'assistant' && t.jobId === h.jobId)!;
  // The turn's record as STORED, read back through the reader every surface uses.
  const stored = await adminDb.planChangeTurn.findUniqueOrThrow({ where: { id: reply.id } });
  return { record: landed.record, reply, stored: readGuideTurnRecord(stored.guideTurn) };
}

const fileBug = (title: string, extra: Record<string, unknown> = {}) => ({
  type: 'file_bug',
  title,
  descriptionMd: `Saving a rotated key returns HTTP 500 (${title}).`,
  ...extra,
});

const bugsIn = (projectId: string) =>
  adminDb.workItem.findMany({ where: { projectId, kind: 'bug' }, orderBy: { createdAt: 'asc' } });

async function linkKinds(fromId: string, toId: string): Promise<string[]> {
  return (await adminDb.workItemLink.findMany({ where: { fromId, toId } }))
    .map((l) => l.kind)
    .sort();
}

const guideCounter = async (sessionId: string) =>
  (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } })).guideBugsFiled;

// ─── the six properties ────────────────────────────────────────────────────

describe('a CONVERSATION-submitted job files, end to end', () => {
  it('201 with a key → a `bug` in the bug destination, one `bug_filed` trail row, and the key is usable as a blocker on that same plan', async () => {
    const { jobId, planId } = await submitConversation();
    expect(submitJobMock).toHaveBeenCalledTimes(1);

    const res = await fileFromJob(jobId, { title: 'The export drops the last row' });
    expect(res.status).toBe(201);
    const filed = (await res.json()) as { id: string; key: string };
    expect(filed.key).toMatch(/^PROD-\d+$/);

    const bug = await adminDb.workItem.findUniqueOrThrow({ where: { id: filed.id } });
    expect(bug.kind).toBe('bug');
    expect(bug.projectId).toBe(fx.projectId);
    expect(bug.identifier).toBe(filed.key);
    // No parent named → the project's bug destination.
    expect(bug.parentId).toBeNull();
    expect(bug.folderId).toBe(await bugFolderOf(fx.projectId));

    const trail = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planRevisionRepository.listByPlan(planId, tx),
    );
    const rows = trail.filter((r) => r.changeKind === PLANNER_BUG_FILED_CHANGE_KIND);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.diff).toMatchObject({ workItemId: filed.id, workItemKey: filed.key });

    // "Usable as a blocker later in the same run", at the core seam: a proposal
    // appended to THIS plan names the filed bug in `blockedByRefs` (a real id,
    // exactly as motir-ai's `propose_node` sends it once the key resolves) and
    // is accepted.
    const appended = await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'Rebuild the export on the streaming reader', kind: 'story' },
          blockedByRefs: [filed.id],
        },
      ],
      fx.ctx,
    );
    expect(appended.appendedItemIds).toHaveLength(1);
    const item = appended.items.find((i) => i.id === appended.appendedItemIds[0])!;
    expect(item.blockedByRefs).toEqual([filed.id]);
  });
});

describe('a PLANLESS job is refused and writes nothing (decision MOTIR-7798 Q2)', () => {
  it('a `jobId` bound to no plan → 404 NO_PLAN_FOR_JOB; the work-item count and every trail are unchanged', async () => {
    // A real plan with a real filing exists beside it, so "every trail
    // unchanged" is a claim about rows that exist, not about an empty table.
    const { jobId, planId } = await submitConversation();
    expect((await fileFromJob(jobId, { title: 'A real one' })).status).toBe(201);
    const itemsBefore = await countItems(fx.projectId);
    const revisionsBefore = await adminDb.planRevision.count();

    const res = await fileFromJob('job-never-submitted', { title: 'Filed with no plan' });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NO_PLAN_FOR_JOB');

    expect(await countItems(fx.projectId)).toBe(itemsBefore);
    expect(await adminDb.planRevision.count()).toBe(revisionsBefore);
    expect(await filedRowsOn(planId)).toBe(1);
    expect(
      await adminDb.workItem.count({ where: { title: 'Filed with no plan' } }),
      'no row by that title anywhere',
    ).toBe(0);
  });
});

describe('a GUIDE turn files, end to end', () => {
  it('[file_bug, tick] → the bug as the person, Found-while, `relates_to`, in Bugs; the tick lands; reply and record carry the key', async () => {
    const card = await manualCard();
    const { todo } = await workItemTodosService.addTodo(
      card.id,
      { text: 'Open the console' },
      fx.ctx,
    );
    const h = await openGuide(card.identifier);

    const { record, reply, stored } = await landTurn(
      h,
      [fileBug('The console 500s on save'), { type: 'tick', rowId: todo.id }],
      'That is a defect — I have filed it.',
    );

    expect(record.outcomes.map((o) => [o.type, o.outcome])).toEqual([
      ['file_bug', 'landed'],
      ['tick', 'landed'],
    ]);
    const bugs = await bugsIn(fx.projectId);
    expect(bugs).toHaveLength(1);
    const bug = bugs[0]!;
    // Created by the turn's person, with no planning provenance.
    expect(bug.reporterId).toBe(fx.ownerId);
    expect(bug.planningSource).toBeNull();
    // Opens with the Found-while line naming the guided card (the create
    // canonicalises a bare key into its mention link).
    expect(bug.descriptionMd!.split('\n')[0]).toMatch(/^\*\*Found while:\*\* guiding /);
    expect(bug.descriptionMd!.split('\n')[0]).toContain(card.identifier);
    // `relates_to` the guided card, both directions; NOT blocking it.
    expect(await linkKinds(bug.id, card.id)).toEqual(['relates_to']);
    expect(await linkKinds(card.id, bug.id)).toEqual(['relates_to']);
    // `blocksGuidedCard: false` → the Bugs folder, never a parent.
    expect(bug.parentId).toBeNull();
    expect(bug.folderId).toBe(await bugFolderOf(fx.projectId));
    // The ordinary action landed too.
    const rows = (await workItemTodosService.listTodos(card.id, fx.ctx)).items;
    expect(rows[0]!.done).toBe(true);

    // The reply names the key (`guideFiledNote`); the stored record returns it.
    expect(reply.body).toContain(`${bug.identifier}: The console 500s on save`);
    expect(stored!.outcomes[0]).toMatchObject({
      type: 'file_bug',
      outcome: 'landed',
      workItemKey: bug.identifier,
    });
    expect(await guideCounter(h.session.id)).toBe(1);
  });

  it('`blocksGuidedCard: true` under a NOT-done story → the bug’s parent is that story, and the guided card is `blocked_by` it', async () => {
    const { story, card } = await cardUnderStory('todo');
    const h = await openGuide(card.identifier);
    const { record } = await landTurn(h, [fileBug('Blocks it', { blocksGuidedCard: true })]);
    expect(record.outcomes[0]).toMatchObject({ outcome: 'landed' });

    const [bug] = await bugsIn(fx.projectId);
    expect(bug!.parentId).toBe(story.id);
    expect(bug!.folderId).toBeNull();
    expect(await linkKinds(card.id, bug!.id)).toEqual(['is_blocked_by', 'relates_to']);
  });

  it('`blocksGuidedCard: true` under a DONE parent → the bug goes to Bugs, and the parent is NOT re-opened', async () => {
    const { story, card } = await cardUnderStory('done');
    const h = await openGuide(card.identifier);
    await landTurn(h, [fileBug('Blocks it', { blocksGuidedCard: true })]);

    const [bug] = await bugsIn(fx.projectId);
    expect(bug!.parentId).toBeNull();
    expect(bug!.folderId).toBe(await bugFolderOf(fx.projectId));
    expect((await adminDb.workItem.findUniqueOrThrow({ where: { id: story.id } })).status).toBe(
      'done',
    );
    // The placement moved; the edge did not.
    expect(await linkKinds(card.id, bug!.id)).toContain('is_blocked_by');
  });
});

describe('the SIXTH filing is refused on BOTH doors, and the work carries on', () => {
  it(`route: ${PLANNER_BUGS_PER_JOB} × 201 on one conversation-submitted job, then 409 PLANNER_BUG_CAP_EXCEEDED — the plan stays generating and still takes an append`, async () => {
    const { jobId, planId } = await submitConversation();
    for (let i = 1; i <= PLANNER_BUGS_PER_JOB; i += 1) {
      expect((await fileFromJob(jobId, { title: `defect ${i}` })).status, `filing ${i}`).toBe(201);
    }
    const itemsAtCap = await countItems(fx.projectId);

    const over = await fileFromJob(jobId, { title: 'one too many' });
    expect(over.status).toBe(409);
    const body = await over.json();
    expect(body.code).toBe('PLANNER_BUG_CAP_EXCEEDED');
    expect(body.cap).toBe(PLANNER_BUGS_PER_JOB);
    expect(body.filed).toBe(PLANNER_BUGS_PER_JOB);
    expect(await countItems(fx.projectId)).toBe(itemsAtCap);
    expect(await filedRowsOn(planId)).toBe(PLANNER_BUGS_PER_JOB);

    // The refusal stops nothing: the plan is still generating and still
    // accepts the run's next proposal.
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: planId } })).status).toBe(
      'generating',
    );
    const appended = await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'Carry on planning', kind: 'story' } }],
      fx.ctx,
    );
    expect(appended.appendedItemIds).toHaveLength(1);
  });

  it(`guide: ${GUIDE_BUGS_PER_CONVERSATION} file_bugs across ${GUIDE_BUGS_PER_CONVERSATION} turns, then [file_bug, tick] → file_bug skipped with the cap reason, the tick lands`, async () => {
    const card = await manualCard();
    const { todo } = await workItemTodosService.addTodo(
      card.id,
      { text: 'Open the console' },
      fx.ctx,
    );
    let h = await openGuide(card.identifier);
    for (let i = 1; i <= GUIDE_BUGS_PER_CONVERSATION; i += 1) {
      if (i > 1) h = await nextTurn(h.session.id, `And another defect (${i}).`);
      const { record } = await landTurn(h, [fileBug(`Defect ${i}`)]);
      expect(record.outcomes[0]!.outcome, `filing ${i}`).toBe('landed');
    }
    expect(await guideCounter(h.session.id)).toBe(GUIDE_BUGS_PER_CONVERSATION);

    h = await nextTurn(h.session.id, 'One more, and I opened the console.');
    const { record, reply } = await landTurn(h, [
      fileBug('Defect over the cap'),
      { type: 'tick', rowId: todo.id },
    ]);
    expect(record.outcomes.map((o) => [o.type, o.outcome])).toEqual([
      ['file_bug', 'skipped'],
      ['tick', 'landed'],
    ]);
    expect(record.outcomes[0]!.reason).toBe(
      `this conversation has already filed ${GUIDE_BUGS_PER_CONVERSATION} bugs, the most one guide conversation may file`,
    );
    // A cap refusal carries no key — there is nothing to follow.
    expect(record.outcomes[0]!.workItemKey).toBeUndefined();
    expect(reply.body).toContain('the most one guide conversation may file');
    expect(await guideCounter(h.session.id)).toBe(GUIDE_BUGS_PER_CONVERSATION);
    expect(await bugsIn(fx.projectId)).toHaveLength(GUIDE_BUGS_PER_CONVERSATION);
    expect((await workItemTodosService.listTodos(card.id, fx.ctx)).items[0]!.done).toBe(true);
  });
});

describe('NO cross-project filing, on BOTH doors', () => {
  it('route: an A token on a job whose plan is B’s (submitted through `submit` in B) → 404 NO_PLAN_FOR_JOB, nothing written in A or B', async () => {
    const b = await projectB();
    const { jobId: jobOfB, planId: planOfB } = await submitConversation(pctxOf(b));
    const inA = await countItems(fx.projectId);
    const inB = await countItems(b.id);

    const res = await fileFromJob(jobOfB, { title: 'Across the line' }, fx.projectId);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('NO_PLAN_FOR_JOB');
    expect(await countItems(fx.projectId)).toBe(inA);
    expect(await countItems(b.id)).toBe(inB);
    expect(await filedRowsOn(planOfB)).toBe(0);
    expect(await countFiledRows()).toBe(0);
  });

  it('route: an A token on A’s own job, with a `parentKey` naming a B card → 404 WORK_ITEM_NOT_FOUND, nothing written', async () => {
    const b = await projectB();
    const foreign = await workItemsService.createWorkItem(
      { projectId: b.id, kind: 'story', title: 'Elsewhere' },
      fx.ctx,
    );
    const { jobId, planId } = await submitConversation();
    const inA = await countItems(fx.projectId);
    const inB = await countItems(b.id);

    const res = await fileFromJob(jobId, { title: 'Under B', parentKey: foreign.identifier });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('WORK_ITEM_NOT_FOUND');
    expect(await countItems(fx.projectId)).toBe(inA);
    expect(await countItems(b.id)).toBe(inB);
    expect(await filedRowsOn(planId)).toBe(0);
  });

  it('guide: a person in both A and B, guided on an A card → the bug lands in A’s bug destination, never B’s, and no B bug relates to it', async () => {
    const b = await projectB();
    const bBug = await workItemsService.createWorkItem(
      { projectId: b.id, kind: 'bug', title: 'A bug that lives in B' },
      fx.ctx,
    );
    const inB = await countItems(b.id);
    const card = await manualCard();
    const h = await openGuide(card.identifier);
    await landTurn(h, [fileBug('Filed from A')]);

    const filed = await adminDb.workItem.findFirstOrThrow({ where: { title: 'Filed from A' } });
    expect(filed.projectId).toBe(fx.projectId);
    expect(filed.folderId).toBe(await bugFolderOf(fx.projectId));
    expect(filed.folderId).not.toBe(await bugFolderOf(b.id));
    expect(await countItems(b.id)).toBe(inB);
    expect(await adminDb.workItem.count({ where: { folderId: await bugFolderOf(b.id) } })).toBe(0);
    // No B bug gained an edge to the A filing, in either direction.
    expect(
      await adminDb.workItemLink.count({
        where: {
          OR: [
            { fromId: bBug.id, toId: filed.id },
            { fromId: filed.id, toId: bBug.id },
          ],
        },
      }),
    ).toBe(0);
  });
});

describe('a DUPLICATE guide filing cites rather than files', () => {
  it('a second `file_bug` with the same title (case- and edge-whitespace-insensitive) → skipped with the FIRST bug’s key, count unchanged', async () => {
    const card = await manualCard();
    let h = await openGuide(card.identifier);
    await landTurn(h, [fileBug('The console 500s on save')]);
    const [first] = await bugsIn(fx.projectId);
    expect(first).toBeDefined();

    h = await nextTurn(h.session.id, 'It happened again.');
    const { record, reply, stored } = await landTurn(h, [fileBug('  the CONSOLE 500s ON SAVE  ')]);
    expect(record.outcomes[0]).toEqual({
      type: 'file_bug',
      outcome: 'skipped',
      reason: `already filed as ${first!.identifier}`,
      workItemKey: first!.identifier,
    });
    expect(stored!.outcomes[0]).toMatchObject({ workItemKey: first!.identifier });
    expect(reply.body).toContain(`already filed as ${first!.identifier}`);
    expect(await bugsIn(fx.projectId)).toHaveLength(1);
    expect(await guideCounter(h.session.id)).toBe(1);
  });
});

// ⚠️ THE TURN AROUND A FILING. A `file_bug` never travels alone: the guide may
// keep it beside a stop (`cannot_do`), beside the list's writes, and beside a
// close. Each case below files FIRST and then lands one of those actions in the
// SAME turn, asserting that the filing landed and that the other action came out
// exactly as it would without it — landed, or refused with its own reason.
//
// They are here, rather than only in `tests/ai/guideLandingService.test.ts`,
// because this story's per-file floor (`vitest.coverage.bug-filing.config.ts`)
// sits on `lib/services/guideLandingService.ts`, and the card that set the floor
// requires a branch under 90 to be met by a case in THIS file rather than by a
// lower number. Every branch named here was unexercised by the merged suite.
describe('a filing’s TURN carries on — every other action the landing takes beside it', () => {
  async function tickedCard(texts: string[] = ['Open the console', 'Rotate the key']) {
    const card = await manualCard();
    for (const text of texts) {
      const { todo } = await workItemTodosService.addTodo(card.id, { text }, fx.ctx);
      await workItemTodosService.setTodoDone(todo.id, true, fx.ctx);
    }
    return card;
  }
  const outcomesOf = (r: Awaited<ReturnType<typeof landTurn>>) =>
    r.record.outcomes.map((o) => [o.type, o.outcome, o.reason ?? null]);
  const NO_PATH = 'the workflow has no way from here to Done';
  const statusOf = async (id: string) =>
    (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;

  it('[current_step (a step no longer on the card), file_bug, cannot_do] → the bug files and the stop comments with no step', async () => {
    const card = await manualCard();
    await workItemTodosService.addTodo(card.id, { text: 'Open the console' }, fx.ctx);
    const h = await openGuide(card.identifier);
    const r = await landTurn(h, [
      { type: 'current_step', rowId: 'a-row-that-is-gone' },
      fileBug('The console 500s on save'),
      { type: 'cannot_do', reason: 'The console refuses every save.' },
    ]);
    expect(outcomesOf(r)).toEqual([
      ['current_step', 'recorded', null],
      ['file_bug', 'landed', null],
      ['cannot_do', 'landed', null],
    ]);
    const comments = await adminDb.comment.findMany({ where: { workItemId: card.id } });
    expect(comments).toHaveLength(1);
    expect(comments[0]!.bodyMd).not.toContain('Stopped at:');
    expect(comments[0]!.bodyMd).toContain('Reason: The console refuses every save.');
    expect(await bugsIn(fx.projectId)).toHaveLength(1);
  });

  it('[file_bug, write_todos] on a card with no list → the bug files and the rows are saved with their executor', async () => {
    const card = await manualCard();
    const h = await openGuide(card.identifier);
    const r = await landTurn(h, [
      fileBug('The smoke test is missing'),
      {
        type: 'write_todos',
        rows: [
          { fromId: 'tmp-1', text: 'Run the smoke test', executor: 'coding_agent', done: false },
        ],
      },
    ]);
    expect(outcomesOf(r)).toEqual([
      ['file_bug', 'landed', null],
      ['write_todos', 'landed', null],
    ]);
    const rows = (await workItemTodosService.listTodos(card.id, fx.ctx)).items;
    expect(rows.map((x) => [x.text, x.executor])).toEqual([['Run the smoke test', 'coding_agent']]);
  });

  it('[file_bug, add_step after the last row, add_step after a gone row] → appended in place, and the second refused', async () => {
    const card = await manualCard();
    await workItemTodosService.addTodo(card.id, { text: 'One' }, fx.ctx);
    const { todo: last } = await workItemTodosService.addTodo(card.id, { text: 'Two' }, fx.ctx);
    const h = await openGuide(card.identifier);
    const r = await landTurn(h, [
      fileBug('Step two is wrong'),
      { type: 'add_step', afterRowId: last.id, text: 'Three', reason: 'It was missing.' },
      { type: 'add_step', afterRowId: 'a-row-that-is-gone', text: 'Four', reason: 'Also.' },
    ]);
    expect(outcomesOf(r)).toEqual([
      ['file_bug', 'landed', null],
      ['add_step', 'landed', null],
      ['add_step', 'skipped', 'the step it was to follow is no longer on the list'],
    ]);
    const rows = (await workItemTodosService.listTodos(card.id, fx.ctx)).items;
    expect(rows.map((x) => x.text)).toEqual(['One', 'Two', 'Three']);
  });

  it('[file_bug, propose_todos, close] on a card with no list → the close reads the proposed walk and refuses', async () => {
    const card = await manualCard();
    const h = await openGuide(card.identifier);
    const r = await landTurn(h, [
      fileBug('The runbook is missing'),
      { type: 'propose_todos', rows: [{ id: 'p-1', text: 'Write the runbook' }] },
      { type: 'close' },
    ]);
    expect(outcomesOf(r)).toEqual([
      ['file_bug', 'landed', null],
      ['propose_todos', 'recorded', null],
      ['close', 'skipped', 'not every step is ticked'],
    ]);
    expect(await statusOf(card.id)).toBe('todo');
  });

  it('[file_bug, close] under an OPEN workflow policy → moves straight to Done', async () => {
    const card = await tickedCard();
    await adminDb.project.update({
      where: { id: fx.projectId },
      data: { workflowPolicyMode: 'open' },
    });
    const h = await openGuide(card.identifier);
    const r = await landTurn(h, [fileBug('Found on the way out'), { type: 'close' }]);
    expect(outcomesOf(r)).toEqual([
      ['file_bug', 'landed', null],
      ['close', 'landed', null],
    ]);
    expect(await statusOf(card.id)).toBe('done');
  });

  it('[file_bug, close] on a card already at Done → nothing to walk, the close still lands', async () => {
    const card = await tickedCard();
    const h = await openGuide(card.identifier);
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'done' } });
    const r = await landTurn(h, [fileBug('Found after the fact'), { type: 'close' }]);
    expect(outcomesOf(r)).toEqual([
      ['file_bug', 'landed', null],
      ['close', 'landed', null],
    ]);
    expect(await statusOf(card.id)).toBe('done');
  });

  it('[file_bug, close] when the workflow has NO done status but Cancelled → the close is refused, the bug still files', async () => {
    const card = await tickedCard();
    const h = await openGuide(card.identifier);
    await adminDb.workflowStatus.update({
      where: { projectId_key: { projectId: fx.projectId, key: 'done' } },
      data: { category: 'in_progress' },
    });
    const r = await landTurn(h, [fileBug('No way to finish'), { type: 'close' }]);
    expect(outcomesOf(r)).toEqual([
      ['file_bug', 'landed', null],
      ['close', 'skipped', NO_PATH],
    ]);
  });

  it('[file_bug, close] when the card’s status is not on the workflow → refused', async () => {
    const card = await tickedCard();
    const h = await openGuide(card.identifier);
    await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'open' } });
    const r = await landTurn(h, [fileBug('A status from elsewhere'), { type: 'close' }]);
    expect(outcomesOf(r)).toEqual([
      ['file_bug', 'landed', null],
      ['close', 'skipped', NO_PATH],
    ]);
  });

  it('[file_bug, close] when no transition reaches Done → refused', async () => {
    const card = await tickedCard();
    const h = await openGuide(card.identifier);
    const done = await adminDb.workflowStatus.findUniqueOrThrow({
      where: { projectId_key: { projectId: fx.projectId, key: 'done' } },
    });
    await adminDb.workflowTransition.deleteMany({ where: { toStatusId: done.id } });
    const r = await landTurn(h, [fileBug('Done is unreachable'), { type: 'close' }]);
    expect(outcomesOf(r)).toEqual([
      ['file_bug', 'landed', null],
      ['close', 'skipped', NO_PATH],
    ]);
    expect(await statusOf(card.id)).toBe('todo');
  });

  it('[file_bug, close] while another kind of approval holds the card → the close defers to it, the bug still files', async () => {
    const card = await tickedCard();
    await withWorkspaceContext(fx.ctx, (tx) =>
      manualWorkGateService.raise(card.id, { createdById: fx.ownerId }, fx.workspaceId, tx),
    );
    // The same awaiting gate, re-kinded: a design result is decided on the card,
    // never by the guide's close.
    await adminDb.approvalGate.updateMany({
      where: { workItemId: card.id, kind: 'manual_work' },
      data: { kind: 'design_result' },
    });
    const h = await openGuide(card.identifier);
    const r = await landTurn(h, [fileBug('Found while waiting'), { type: 'close' }]);
    expect(outcomesOf(r)).toEqual([
      ['file_bug', 'landed', null],
      [
        'close',
        'skipped',
        'an approval waiting on this card owns its status — decide it on the card',
      ],
    ]);
    expect(await statusOf(card.id)).not.toBe('done');
  });

  it('[file_bug, close] when the only road to Done runs through a claim rung the card cannot take (an open child) → the close is refused as the card’s own, the bug still files', async () => {
    const card = await tickedCard();
    const h = await openGuide(card.identifier);
    // Take away the direct edges into Done, so the walk must go through
    // `in_review` / `implemented` — rungs a card with an open child may not claim.
    const byKey = async (key: string) =>
      adminDb.workflowStatus.findUniqueOrThrow({
        where: { projectId_key: { projectId: fx.projectId, key } },
      });
    const done = await byKey('done');
    const direct = await Promise.all(['todo', 'in_progress'].map(byKey));
    await adminDb.workflowTransition.deleteMany({
      where: { toStatusId: done.id, fromStatusId: { in: direct.map((x) => x.id) } },
    });
    await createTestWorkItem(fx, { kind: 'subtask', title: 'Still open', parentId: card.id });

    const r = await landTurn(h, [fileBug('Found with a child open'), { type: 'close' }]);
    expect(outcomesOf(r)).toEqual([
      ['file_bug', 'landed', null],
      ['close', 'skipped', 'the card refused the change'],
    ]);
    expect(await statusOf(card.id)).not.toBe('done');
    expect(await bugsIn(fx.projectId)).toHaveLength(1);
  });

  it('a later turn files even when an earlier reply’s stored record no longer reads', async () => {
    const card = await manualCard();
    let h = await openGuide(card.identifier);
    const first = await landTurn(h, [fileBug('First defect')]);
    await adminDb.planChangeTurn.update({
      where: { id: first.reply.id },
      data: { guideTurn: { unreadable: true } },
    });
    h = await nextTurn(h.session.id, 'Another one.');
    const r = await landTurn(h, [fileBug('Second defect')]);
    expect(outcomesOf(r)).toEqual([['file_bug', 'landed', null]]);
    expect(await guideCounter(h.session.id)).toBe(2);
  });
});
