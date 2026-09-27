import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import type { AiAccessDTO } from '@/lib/dto/aiAccess';
import { db } from '@/lib/db';
import { getGitProvider } from '@/lib/git';
import type { GitProvider } from '@/lib/git/provider';
import type { ProjectContext } from '@/lib/projects';
import { buildScope } from '@/lib/planChange/scope';
import en from '@/messages/en.json';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import { connectRepairRepo, deliveredPr } from '../../helpers/repairFixtures';

// STORY GATE — AN ACCEPTANCE SENT BACK IS A VERDICT, AND NOTHING RETURNS TO TO DO
// (Story MOTIR-6071 · Subtask MOTIR-6507; `docs/decisions/acceptance-refusal-verdict.md`).
//
// The builder cards each prove their own half over rows they wrote themselves: the
// verdict offer (`tests/approvalGates/verdictOffer.test.ts`, `refusalVerdict.test.ts`),
// the withdraw + hold (`tests/approvalGates/acceptanceRefusalWithdraws.test.ts`), the
// repair class (`tests/ready/claimWorkItemRepairAcceptanceRerun.test.ts`) and the seed
// (`tests/api/approval-gate-planning-seed-route.test.ts`). This file holds the CHAIN, on
// real Postgres, where every step reads the previous step's real output:
//
//   a receipt PUBLISHED through the MCP tool raises the acceptance gate and the merge
//   gate beside it → a person refuses it through the decide door with a verdict →
//   NO status moves (story and both children), the merge gate is `pulled_back` →
//   (Re-run) `claimRepair` hands the story's open pull request over as
//   `acceptance_rerun` → the gate set HOLDS the merge through every green and every
//   press → a republished receipt releases it, asking the acceptance and the merge
//   together, acceptance leading → the repair class is over;
//   (Re-plan) no repair, the same hold, and the seed read anchors on the story.
//
// Mirrors MOTIR-6428's `designVerdictStoryGate.test.ts`, except that NOTHING returns to
// To do here: a story run's refusal writes no status on any verdict.
//
// Stubbed: only what a Vitest process cannot supply — the blob store's mint and HEAD, the
// billing entitlement (a paid plan, so the project switch alone decides eligibility) and
// the motir-ai boundary a seeded session's first turn would reach. The database, the decide
// door, the handlers, the gate set and the repair service are all real.

const store = new Map<string, { size: number; contentType: string }>();
const minted = new Map<string, { contentType: string; maxBytes: number }>();

vi.mock('@/lib/blob/uploader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/blob/uploader')>()),
  mintPrivateUploadToken: vi.fn(
    async (pathname: string, opts: { contentType: string; maxBytes: number }) => {
      minted.set(pathname, { contentType: opts.contentType, maxBytes: opts.maxBytes });
      return `https://store.example/signed/${encodeURIComponent(pathname)}`;
    },
  ),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  signedDownloadUrl: vi.fn(async (pathname: string) => `https://store.example/get/${pathname}`),
  deleteAttachmentBlob: vi.fn(async () => {}),
}));

const aiAccess = vi.hoisted(() => ({ current: null as AiAccessDTO | null }));
vi.mock('@/lib/services/billingService', () => ({
  billingService: { getAiAccessForContext: vi.fn(async () => aiAccess.current) },
}));

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(),
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

const { runCreateAcceptanceUpload, runPublishAcceptanceResult } =
  await import('@/lib/mcp/tools/publishAcceptanceResult');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { pullRequestMergeService } = await import('@/lib/services/pullRequestMergeService');
const { workItemRepairService } = await import('@/lib/services/workItemRepairService');
const { planningSeedService } = await import('@/lib/services/planningSeedService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { reconcileGatesFor, gateSetFor } = await import('@/lib/services/gateSetFor');
const { acceptanceResultHoldsMerge } = await import('@/lib/services/mergeGates');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { ApprovalGatePrimaryPendingError, ApprovalGateVerbNotOfferedError } =
  await import('@/lib/approvalGates/errors');
const { PlanningSeedNotFoundError } = await import('@/lib/planChange/errors');
const { runGetApprovalGate } = await import('@/lib/mcp/tools/getApprovalGate');

const github = getGitProvider('github') as Required<GitProvider>;

const REASON = 'The empty board should say how to add the first card.';

let fx: WorkItemFixture;
let pctx: ProjectContext;

beforeEach(async () => {
  store.clear();
  minted.clear();
  await truncateAuthTables();
  // The suite-wide lock order — see `acceptanceOnePress.test.ts`'s note and MOTIR-3066.
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "acceptance_evidence", "attachment", "approval_gate" RESTART IDENTITY CASCADE',
  );
  fx = await makeWorkItemFixture();
  pctx = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  } as unknown as ProjectContext;
  await adminDb.project.update({
    where: { id: fx.projectId },
    data: { prMergeMode: 'manual', acceptanceVideoEnabled: true },
  });
  aiAccess.current = {
    applicable: true,
    organizationId: fx.workspace.organizationId,
    organizationName: 'Acme',
    canManageBilling: true,
    hasPaidAiPlan: true,
    balance: 100,
    tierName: 'Pro',
    tierAllotment: 100,
    renewsAt: null,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── fixtures ────────────────────────────────────────────────────────────────

async function item(kind: 'story' | 'subtask', title: string, parentId?: string) {
  return workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
}

async function moveThrough(id: string, ...statuses: string[]) {
  for (const status of statuses) await workItemsService.updateStatus(id, status, fx.ctx);
}

/** The run's HOW TO TEST record — what makes a card its run's TARGET (`runTarget.ts`). */
async function runTargetRecord(workItemId: string) {
  await adminDb.testInstructions.create({
    data: { workspaceId: fx.workspaceId, projectId: fx.projectId, workItemId, bodyMd: '## Run it' },
  });
}

/** A receipt published the way an agent publishes one: mint, PUT, publish — by `key`. */
async function publishVia(key: string, commitSha: string) {
  const grant = await runCreateAcceptanceUpload({ key }, fx.ctx);
  expect(grant.isError, JSON.stringify(grant)).toBeFalsy();
  const video = (grant.structuredContent as { video: { pathname: string } }).video;
  const g = minted.get(video.pathname)!;
  store.set(video.pathname, { contentType: g.contentType, size: 4096 });
  const published = await runPublishAcceptanceResult(
    { key, videoPathname: video.pathname, commitSha, producedByKey: key },
    fx.ctx,
  );
  expect(published.isError, JSON.stringify(published)).toBeFalsy();
  return published;
}

interface StoryRun {
  story: WorkItem | { id: string; identifier: string };
  children: { id: string; identifier: string }[];
  pr: { id: string; number: number };
  repoName: string;
}

/**
 * A STORY RUN at review: the story (`in_review`) is its run's target and delivers ONE
 * open, green pull request of its own; TWO children sit at `implemented` beneath it. The
 * receipt is published by the E2E child, which raises the story's awaiting acceptance gate
 * AND its paired approve-to-merge gate.
 */
async function waitingStoryRun(): Promise<StoryRun> {
  const story = await item('story', 'Accept a story from its recording');
  const e2e = await item('subtask', 'Story E2E + acceptance video', story.id);
  const empty = await item('subtask', 'The empty board', story.id);
  // A container reaches review only over built children.
  await moveThrough(e2e.id, 'in_progress', 'implemented');
  await moveThrough(empty.id, 'in_progress', 'implemented');
  await moveThrough(story.id, 'in_progress', 'in_review');
  await runTargetRecord(story.id);
  const repo = await connectRepairRepo(fx, 'web');
  const pr = await deliveredPr(fx, story.id, repo, {
    headRef: 'parent/accept-a-story',
    checks: { Vitest: 'success', Lint: 'success' },
  });
  await publishVia(e2e.identifier, 'c0ffee1');
  expect(await gatesOn(story.id)).toEqual([
    ['acceptance_result', 'awaiting'],
    ['pull_request_approval', 'awaiting'],
  ]);
  return { story, children: [e2e, empty], pr, repoName: repo.name };
}

// Gates raised in ONE transaction share `createdAt`, so the kind NAME breaks the tie.
const gatesOn = async (workItemId: string) =>
  (await adminDb.approvalGate.findMany({ where: { workItemId } }))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.kind.localeCompare(b.kind))
    .map((g) => [g.kind, g.state] as const);

const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });

async function awaitingGate(
  workItemId: string,
  kind: 'acceptance_result' | 'pull_request_approval',
) {
  return adminDb.approvalGate.findFirstOrThrow({ where: { workItemId, kind, state: 'awaiting' } });
}

/** Every status and every history row of the given items — what "nothing moved" compares. */
async function snapshot(ids: string[]) {
  const rows = await adminDb.workItem.findMany({ where: { id: { in: ids } } });
  return {
    statuses: Object.fromEntries(rows.map((r) => [r.id, r.status])),
    revisions: await adminDb.workItemRevision.count({ where: { workItemId: { in: ids } } }),
  };
}

const idsOf = (run: StoryRun) => [run.story.id, ...run.children.map((c) => c.id)];

async function reconcile(workItemId: string) {
  return withWorkspaceContext(fx.ctx, async (tx) =>
    reconcileGatesFor(await tx.workItem.findUniqueOrThrow({ where: { id: workItemId } }), tx),
  );
}

const awaitingKinds = async (workItemId: string) =>
  (await adminDb.approvalGate.findMany({ where: { workItemId, state: 'awaiting' } }))
    .map((g) => g.kind)
    .sort();

const holds = (workItemId: string) =>
  withWorkspaceContext(fx.ctx, (tx) => acceptanceResultHoldsMerge(workItemId, tx));

/** Refuse the story's awaiting acceptance through the ONE decide door. */
async function refuse(
  storyId: string,
  opts: { verdict?: 'revise' | 're_plan'; source?: 'ui' | 'api' | 'github' } = {},
) {
  const gate = await awaitingGate(storyId, 'acceptance_result');
  const source = opts.source ?? 'ui';
  return approvalGatesService.decide(
    {
      gateId: gate.id,
      decision: 'request_changes',
      source,
      noteMd: REASON,
      ...(opts.verdict ? { refusalVerdict: opts.verdict } : {}),
      stamp: DECIDED_WITHOUT_A_READER,
    },
    fx.ctx,
    ...(source === 'github'
      ? [{ synced: { reviewerGithubUserId: '999001', reviewerLogin: 'octo' } }]
      : []),
  );
}

/** What an agent reads through `get_approval_gate` — the prose and the offer flag. */
async function mcpAcceptanceRead(key: string) {
  const res = await runGetApprovalGate({ key, kind: 'acceptance_result' }, fx.ctx);
  const text = (res.content[0] as { text: string }).text;
  const gate = (res.structuredContent as { gate: { offersRefusalVerdict: boolean } | null }).gate;
  return { text, offers: gate?.offersRefusalVerdict ?? null };
}
const VERDICT_LINE = 'a refusal of this gate must carry a verdict: revise or re_plan';

const claim = (key: string) => workItemRepairService.claimRepair(fx.projectId, key, fx.ctx);

/**
 * A press on a merge gate the story still has a row for — a stale page, the REST route —
 * through BOTH shipped doors (the approve-and-merge press and the plain decide door). Each
 * is refused naming the acceptance, the row stays awaiting, and no host merge is called.
 */
async function assertMergePressRefused(storyId: string, subjectVersion: string) {
  const stale = await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: storyId,
      kind: 'pull_request_approval',
      subjectId: storyId,
      subjectVersion,
      state: 'awaiting',
    },
  });
  const merge = vi.spyOn(github, 'mergeChangeRequest');

  const pressed = await pullRequestMergeService
    .approveAndMerge({ gateId: stale.id, source: 'ui', stamp: DECIDED_WITHOUT_A_READER }, fx.ctx)
    .catch((err: unknown) => err);
  expect(pressed).toBeInstanceOf(ApprovalGatePrimaryPendingError);
  expect(pressed).toMatchObject({ primary: 'acceptance', workItemId: storyId });

  const decided = await approvalGatesService
    .decide(
      { gateId: stale.id, decision: 'approve', source: 'api', stamp: DECIDED_WITHOUT_A_READER },
      fx.ctx,
    )
    .catch((err: unknown) => err);
  expect(decided).toBeInstanceOf(ApprovalGatePrimaryPendingError);
  expect(decided).toMatchObject({ primary: 'acceptance', workItemId: storyId });

  expect((await gateRow(stale.id)).state).toBe('awaiting');
  expect(merge).not.toHaveBeenCalled();
  // Tidy the stale row away so the next reconcile sees only what the gate set raised.
  await adminDb.approvalGate.delete({ where: { id: stale.id } });
}

/**
 * The refusal as the decide door records it on a story run, for either verdict: nothing
 * moves anywhere, the merge gate is withdrawn, the acceptance carries the verdict.
 */
async function assertRefusedNothingMoved(
  run: StoryRun,
  before: Awaited<ReturnType<typeof snapshot>>,
  decided: Awaited<ReturnType<typeof refuse>>,
  verdict: 'revise' | 're_plan',
) {
  expect(decided.effect).toEqual({
    statusWritten: null,
    statusDeferredReason: 'acceptance_refusal_withdraws_merge_only',
  });
  expect(await snapshot(idsOf(run))).toEqual(before);
  expect(before.statuses).toEqual({
    [run.story.id]: 'in_review',
    [run.children[0]!.id]: 'implemented',
    [run.children[1]!.id]: 'implemented',
  });
  expect(await gateRow(decided.gate.id)).toMatchObject({
    kind: 'acceptance_result',
    state: 'changes_requested',
    refusalVerdict: verdict,
    noteMd: REASON,
    decisionSource: 'ui',
    outcomeRef: null,
  });
  const merge = await adminDb.approvalGate.findFirstOrThrow({
    where: { workItemId: run.story.id, kind: 'pull_request_approval' },
  });
  expect(merge).toMatchObject({
    state: 'superseded',
    supersededCause: 'pulled_back',
    decidedById: null,
  });
  // Nothing on the story is waiting for a person.
  expect(await awaitingKinds(run.story.id)).toEqual([]);
  return merge;
}

/** THE HOLD at the same green set, and after a newer head goes green with no new receipt. */
async function assertTheHoldHolds(run: StoryRun, headSha: string) {
  // The same green set: the reconcile a status write, the sweep or `ciPromotion` makes.
  expect(await reconcile(run.story.id)).toEqual([]);
  expect(await awaitingKinds(run.story.id)).toEqual([]);
  expect(await holds(run.story.id)).toBe(true);

  // The fix's push: the member's head moves and goes green, no video yet.
  await adminDb.githubCheckRun.createMany({
    data: ['Vitest', 'Lint'].map((checkName) => ({
      pullRequestId: run.pr.id,
      commitSha: headSha,
      checkName,
      conclusion: 'success',
    })),
  });
  expect(await reconcile(run.story.id)).toEqual([]);
  expect(await awaitingKinds(run.story.id)).toEqual([]);
  expect(await holds(run.story.id)).toBe(true);
}

// ── the chain ───────────────────────────────────────────────────────────────

describe('Story run → Re-run: nothing moves, the merge is withdrawn and HELD, motir fix takes it', () => {
  it('the whole chain, from the decide door to the release by a republished receipt', async () => {
    const run = await waitingStoryRun();
    const before = await snapshot(idsOf(run));

    const decided = await refuse(run.story.id, { verdict: 'revise' });
    const withdrawn = await assertRefusedNothingMoved(run, before, decided, 'revise');

    // THE REPAIR CLAIM — the Re-run class hands over the reason and the open member.
    const claimed = await claim(run.story.identifier);
    expect(claimed).toMatchObject({
      outcome: 'claimed',
      reason: null,
      repairClass: 'acceptance_rerun',
      acceptanceRefusal: { reasonMd: REASON },
    });
    expect(claimed.pullRequests).toEqual([
      expect.objectContaining({
        repo: `acme/${run.repoName}`,
        number: run.pr.number,
        headRef: 'parent/accept-a-story',
        ci: 'passing',
        failingChecks: [],
      }),
    ]);
    // Still nothing moved: the claim is a `fix` run, never a status write.
    expect(await snapshot(idsOf(run))).toEqual(before);

    // THE HOLD — it fails against a handler that only withdraws: the reconcile would ask
    // the merge question again, alone.
    await assertTheHoldHolds(run, 'd'.repeat(40));
    // …and a press on a merge gate is refused through every door.
    await assertMergePressRefused(run.story.id, withdrawn.subjectVersion!);

    // THE RELEASE — the fix republishes; once the set is green it asks the acceptance and
    // the merge together, the acceptance leading.
    await publishVia(run.children[0]!.identifier, 'c0ffee2');
    await reconcile(run.story.id);
    expect(await awaitingKinds(run.story.id)).toEqual([
      'acceptance_result',
      'pull_request_approval',
    ]);
    const fresh = await awaitingGate(run.story.id, 'acceptance_result');
    expect(fresh.id).not.toBe(decided.gate.id);
    expect((await gateRow(decided.gate.id)).state).toBe('changes_requested');
    const set = await withWorkspaceContext(fx.ctx, async (tx) =>
      gateSetFor(await tx.workItem.findUniqueOrThrow({ where: { id: run.story.id } }), tx),
    );
    expect(set.primary).toBe('acceptance_result');
    expect(await holds(run.story.id)).toBe(false);

    // THE CLASS IS OVER: the refusal was about a recording that is no longer current.
    expect(await claim(run.story.identifier)).toMatchObject({
      outcome: 'not_repairable',
      reason: 'not_failing',
      repairClass: 'ci',
      acceptanceRefusal: null,
    });
    // Across the whole chain, no status was written anywhere.
    expect(await snapshot(idsOf(run))).toEqual(before);
  });
});

describe('Story run → Re-plan: nothing moves, the merge is held, the planner is seeded', () => {
  it('no repair, the same hold, and the seed read anchors on the story', async () => {
    const run = await waitingStoryRun();
    const before = await snapshot(idsOf(run));

    const decided = await refuse(run.story.id, { verdict: 're_plan' });
    const withdrawn = await assertRefusedNothingMoved(run, before, decided, 're_plan');

    await assertTheHoldHolds(run, 'e'.repeat(40));
    await assertMergePressRefused(run.story.id, withdrawn.subjectVersion!);

    // A Re-plan is the planner's, never `motir fix`'s.
    expect(await claim(run.story.identifier)).toMatchObject({
      outcome: 'not_repairable',
      reason: 'not_failing',
      repairClass: 'ci',
      acceptanceRefusal: null,
      pullRequests: [],
    });
    expect(
      await adminDb.dispatchRun.count({
        where: { command: 'fix', cards: { some: { workItemId: run.story.id } } },
      }),
    ).toBe(0);

    // THE SEED — anchored on the story, the re-plan-all turn quoting the reason.
    const seed = await planningSeedService.getPlanningSeed(decided.gate.id, pctx, 'en');
    expect(seed).toMatchObject({
      gateId: decided.gate.id,
      gateKind: 'acceptance_result',
      anchorKey: run.story.identifier,
      seededSessionId: null,
    });
    expect(seed.firstTurn).toContain(REASON);
    expect(seed.firstTurn).toContain(en.planningWorkspace.refusalSeed.verb.acceptanceReplan);
    expect(seed.firstTurn).toContain(`Re-plan ${run.story.identifier} from that reason.`);

    // The refusal, the hold and the seed read wrote no status anywhere.
    expect(await snapshot(idsOf(run))).toEqual(before);

    // A planner session started from it is stamped with the gate.
    const started = await planChangeSessionsService.startSeededWithFirstTurn(
      pctx,
      buildScope([run.story.identifier]),
      seed.firstTurn,
      seed.gateId,
    );
    const row = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: started.id } });
    expect(row.seedGateId).toBe(decided.gate.id);
    expect(
      (await planningSeedService.getPlanningSeed(decided.gate.id, pctx, 'en')).seededSessionId,
    ).toBe(started.id);
    // The one move is the PLANNER's, not the refusal's: opening the session takes the
    // story's planning-target lock (MOTIR-5643's `in_review → planning` edge). The
    // children are untouched.
    const after = await snapshot(idsOf(run));
    expect(after.statuses[run.story.id]).toBe('planning');
    expect(after.statuses[run.children[0]!.id]).toBe('implemented');
    expect(after.statuses[run.children[1]!.id]).toBe('implemented');
  });
});

describe('the verdict rule on a story run', () => {
  it('a Motir press WITHOUT a verdict → refusal_verdict_required, nothing written', async () => {
    const run = await waitingStoryRun();
    const before = await snapshot(idsOf(run));
    const gate = await awaitingGate(run.story.id, 'acceptance_result');
    // The door asks for the verdict it will require — and an agent reads the same offer.
    const read = await mcpAcceptanceRead(run.story.identifier);
    expect(read.offers).toBe(true);
    expect(read.text).toContain(VERDICT_LINE);

    const refused = await refuse(run.story.id).catch((err: unknown) => err);

    expect(refused).toBeInstanceOf(ApprovalGateVerbNotOfferedError);
    expect(refused).toMatchObject({ reason: 'refusal_verdict_required' });
    expect(await gateRow(gate.id)).toMatchObject({ state: 'awaiting', refusalVerdict: null });
    expect(await awaitingKinds(run.story.id)).toEqual([
      'acceptance_result',
      'pull_request_approval',
    ]);
    expect(await snapshot(idsOf(run))).toEqual(before);
  });

  it('a GitHub refusal WITH a verdict → refusal_verdict_not_offered; WITHOUT one it moves nothing and admits no repair', async () => {
    const run = await waitingStoryRun();
    const before = await snapshot(idsOf(run));
    const gate = await awaitingGate(run.story.id, 'acceptance_result');

    const refused = await refuse(run.story.id, { source: 'github', verdict: 'revise' }).catch(
      (err: unknown) => err,
    );
    expect(refused).toBeInstanceOf(ApprovalGateVerbNotOfferedError);
    expect(refused).toMatchObject({ reason: 'refusal_verdict_not_offered' });
    expect((await gateRow(gate.id)).state).toBe('awaiting');

    const decided = await refuse(run.story.id, { source: 'github' });
    expect(decided.effect).toEqual({
      statusWritten: null,
      statusDeferredReason: 'request_changes_moves_nothing',
    });
    expect(await gateRow(gate.id)).toMatchObject({
      state: 'changes_requested',
      decisionSource: 'github',
      refusalVerdict: null,
    });
    // The merge gate is left waiting, and nothing holds it.
    expect(await awaitingKinds(run.story.id)).toEqual(['pull_request_approval']);
    expect(await holds(run.story.id)).toBe(false);
    expect(await snapshot(idsOf(run))).toEqual(before);
    // No repair: a GitHub refusal carries no verdict.
    expect(await claim(run.story.identifier)).toMatchObject({
      outcome: 'not_repairable',
      reason: 'not_failing',
      repairClass: 'ci',
    });
    // …and no seed.
    await expect(planningSeedService.getPlanningSeed(gate.id, pctx, 'en')).rejects.toBeInstanceOf(
      PlanningSeedNotFoundError,
    );
  });
});

describe('a FINISHED story — every child merged, no delivery of its own', () => {
  async function finishedStory() {
    const story = await item('story', 'Accept a finished story');
    const e2e = await item('subtask', 'Story E2E + acceptance video', story.id);
    const other = await item('subtask', 'The empty board', story.id);
    await moveThrough(story.id, 'in_progress');
    await moveThrough(other.id, 'in_progress', 'done');
    await runTargetRecord(e2e.id);
    const repo = await connectRepairRepo(fx, 'web-finished');
    const pr = await deliveredPr(fx, e2e.id, repo, {
      headRef: 'story/e2e',
      checks: { Vitest: 'success' },
    });
    await publishVia(e2e.identifier, 'c0ffee1');
    await moveThrough(e2e.id, 'in_progress', 'implemented');
    await adminDb.githubPullRequest.update({
      where: { id: pr.id },
      data: { state: 'closed', merged: true },
    });
    await workItemsService.updateStatus(e2e.id, 'done', fx.ctx, { keepPendingQuestions: true });
    const gate = await awaitingGate(story.id, 'acceptance_result');
    return { story, ids: [story.id, e2e.id, other.id], gate };
  }

  it('a verdict is not offered; without one nothing moves, nothing is withdrawn, and the seed asks for a remedy', async () => {
    const { story, ids, gate } = await finishedStory();
    const before = await snapshot(ids);
    // A finished story asks for a reason only — the agent's read says no verdict.
    const read = await mcpAcceptanceRead(story.identifier);
    expect(read.offers).toBe(false);
    expect(read.text).not.toContain(VERDICT_LINE);
    const gatesBefore = await adminDb.approvalGate.findMany({
      where: { workItemId: { in: ids }, id: { not: gate.id } },
      orderBy: { id: 'asc' },
    });

    const refused = await refuse(story.id, { verdict: 're_plan' }).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ApprovalGateVerbNotOfferedError);
    expect(refused).toMatchObject({ reason: 'refusal_verdict_not_offered' });
    expect((await gateRow(gate.id)).state).toBe('awaiting');

    const decided = await refuse(story.id);
    expect(decided.gate).toMatchObject({ state: 'changes_requested', refusalVerdict: null });
    expect(decided.effect).toEqual({
      statusWritten: null,
      statusDeferredReason: 'request_changes_moves_nothing',
    });
    expect(await snapshot(ids)).toEqual(before);
    // No gate is withdrawn — every other row is exactly as it was.
    expect(
      await adminDb.approvalGate.findMany({
        where: { workItemId: { in: ids }, id: { not: gate.id } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(gatesBefore);
    expect(
      await adminDb.approvalGate.count({
        where: { workItemId: { in: ids }, supersededCause: 'pulled_back' },
      }),
    ).toBe(0);
    expect(await holds(story.id)).toBe(false);

    const seed = await planningSeedService.getPlanningSeed(gate.id, pctx, 'en');
    expect(seed).toMatchObject({
      gateId: gate.id,
      gateKind: 'acceptance_result',
      anchorKey: story.identifier,
    });
    expect(seed.firstTurn).toContain(REASON);
    expect(seed.firstTurn).toContain(en.planningWorkspace.refusalSeed.verb.acceptanceRemedy);
    expect(seed.firstTurn).toContain(`Plan a remedy under ${story.identifier} from that reason`);
  });
});
