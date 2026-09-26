import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope } from '@/lib/planChange/scope';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { toGateRefusal } from '@/lib/approvalGates/refusals';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { createTestProject } from '../../fixtures/projectFixtures';
import { shaFor } from '../../helpers/commitShaFixtures';
import { makeWorkWaitOn } from '../../helpers/designWaits';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// STORY GATE — A DESIGN SENT BACK IS A VERDICT (Story MOTIR-6070 · Subtask MOTIR-6428;
// `docs/decisions/design-refusal-verdict.md`, ADR `approval-gates.md` §10c–§10h).
//
// The builder cards each prove their own half: the door's verdict rule
// (`tests/approvalGates/refusalVerdict.test.ts`, `tests/integration/approvals/
// refusalVerdictSeam.test.ts`), the return to To do (`tests/approvalGates/
// designRefusalReturnsToTodo.test.ts`), the latest-refusal read and prompt section
// (`tests/dispatch/changesRequested*.test.ts`), and the Re-plan seed
// (`tests/planning/refusalSeed.test.ts`, `tests/api/approval-gate-planning-seed-route.test.ts`)
// — each over a gate row it wrote ITSELF. This file holds the CHAIN between them, on
// real Postgres, where every artifact is the previous step's real output:
//
//   a design PUBLISHED through the evidence service raises the gate →
//   a person refuses it through a real door (the item page's server action, the REST
//   route) with a verdict → the card is at To do, every OTHER waiting approval
//   withdrawn `pulled_back` and the deciding gate `changes_requested` →
//   `list_ready` offers the card and the claim takes it →
//   the run's republish is accepted and asks a FRESH question →
//   the dispatched prompt carries CHANGES REQUESTED with the reason →
//   (Re-plan) the planning-seed ROUTE anchors on the parent, names the waiting cards,
//   and a session started from it is stamped `seedGateId`.
//
// Stubbed: only what a Vitest process cannot supply (the session, the active project
// and workspace resolvers, the request locale, the blob store's HEAD, the motir-ai
// boundary a seeded session's first turn would reach, and Next's cache/event hooks).

const store = new Map<string, { contentType: string; size: number }>();
vi.mock('@/lib/blob/uploader', () => ({
  putAttachment: vi.fn(),
  putPrivateAttachment: vi.fn(),
  signedDownloadUrl: vi.fn(),
  deleteAttachmentBlob: vi.fn(),
  headPrivateBlob: vi.fn(async (pathname: string) => store.get(pathname) ?? null),
  mintPrivateUploadToken: vi.fn(async (pathname: string) => `token-for:${pathname}`),
}));
const signedIn = { current: null as { userId: string; workspaceId: string } | null };
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () => signedIn.current,
}));
const session = { current: null as { user: { id: string; email: string; name: string } } | null };
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  getSession: async () => session.current,
}));
const activeProject = { current: null as ProjectContext | null };
vi.mock('@/lib/projects', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/projects')>()),
  getActiveProject: async () => activeProject.current,
}));
vi.mock('next-intl/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next-intl/server')>()),
  getLocale: async () => 'en',
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/jobs/sendEvent', () => ({ sendEvent: async () => {} }));
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

const { designEvidenceService, designPrefix } =
  await import('@/lib/services/designEvidenceService');
const { approvalGatesService } = await import('@/lib/services/approvalGatesService');
const { workItemsService } = await import('@/lib/services/workItemsService');
const { dispatchPromptService } = await import('@/lib/services/dispatchPromptService');
const { planningSeedService } = await import('@/lib/services/planningSeedService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');
const { approvalGateRepository } = await import('@/lib/repositories/approvalGateRepository');
const { workItemLinkRepository } = await import('@/lib/repositories/workItemLinkRepository');
const { withWorkspaceContext } = await import('@/lib/workspaces/context');
const { runListReady } = await import('@/lib/mcp/tools/listReady');
const { runGetWorkItem } = await import('@/lib/mcp/tools/getWorkItem');
const { DEFAULT_TRANSITIONS } = await import('@/lib/workflows/defaultWorkflow');
const { IllegalTransitionError } = await import('@/lib/workItems/errors');
const { PlanningSeedNotFoundError, PlanSeedNotApplicableError } =
  await import('@/lib/planChange/errors');
const { POST: decideRoute } = await import('@/app/api/approval-gates/[id]/decide/route');
const { GET: seedRoute } = await import('@/app/api/approval-gates/[id]/planning-seed/route');
const { decideApprovalGateAction } = await import('@/app/(authed)/items/[key]/approvalGateActions');

const VERDICTS = ['revise', 're_plan'] as const;
type Verdict = (typeof VERDICTS)[number];
const REASON = 'The empty state is missing, and the toolbar crowds the title.';
const VERDICT_LINE: Record<Verdict, string> = {
  revise: '    verdict: Revise — the reviewer asked for this work to be revised.',
  re_plan: '    verdict: Re-plan — the reviewer judged the plan around this work wrong.',
};

let fx: WorkItemFixture;
let story: WorkItem;
let card: WorkItem;
/** The card that is `blocked_by` the design — what a Re-plan seed must name. */
let waiting: { id: string; key: string };

function signIn(on: WorkItemFixture) {
  signedIn.current = { userId: on.ownerId, workspaceId: on.workspaceId };
  session.current = { user: { id: on.ownerId, email: on.owner.email, name: on.owner.name } };
  activeProject.current = {
    ...on.ctx,
    projectId: on.projectId,
    project: on.project,
  } as unknown as ProjectContext;
}

beforeEach(async () => {
  store.clear();
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  signIn(fx);
  const s = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'story', title: 'Exports list' },
    fx.ctx,
  );
  story = await adminDb.workItem.findUniqueOrThrow({ where: { id: s.id } });
  const c = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'subtask',
      parentId: story.id,
      type: 'design',
      title: 'Design the exports list',
    },
    fx.ctx,
  );
  card = await adminDb.workItem.findUniqueOrThrow({ where: { id: c.id } });
  waiting = await makeWorkWaitOn(card.id, fx, {
    kind: 'subtask',
    parentId: story.id,
    title: 'Build the exports list',
  });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

// ── the chain's steps, each through the shipped door ────────────────────────────────

async function moveTo(status: 'in_review' | 'implemented') {
  await workItemsService.updateStatus(card.id, 'in_progress', fx.ctx);
  await workItemsService.updateStatus(card.id, status, fx.ctx);
}

/** A design publish through the evidence service — the door a run's upload reaches. */
async function publish(label: string) {
  const pathname = `${designPrefix(fx.workspaceId, card.id)}${label}.mock.html`;
  store.set(pathname, { contentType: 'text/html', size: 2048 });
  const notePathname = `${designPrefix(fx.workspaceId, card.id)}${label}.design-notes.md`;
  store.set(notePathname, { contentType: 'text/markdown', size: 512 });
  const evidence = await designEvidenceService.recordFromPathnames(
    {
      workItemId: card.id,
      assets: [
        { kind: 'mock', sourcePath: `design/work-items/${label}.mock.html`, pathname },
        {
          kind: 'note_file',
          sourcePath: 'design/work-items/design-notes.md',
          pathname: notePathname,
        },
      ],
      commitSha: shaFor(label),
    },
    fx.ctx,
  );
  const gate = await adminDb.approvalGate.findFirstOrThrow({
    where: { subjectId: evidence.id, kind: 'design_result' },
  });
  return { evidence, gate };
}

/** The stamp the item page / overlay would have shown the person who presses. */
async function readerStamp() {
  const read = await approvalGatesService.getForWorkItem(
    { workItemId: card.id, kind: 'design_result' },
    fx.ctx,
  );
  expect(read.stamp).toBeTruthy();
  return read.stamp!;
}

/** Workflow A's door: the item page's server action (source `ui`). */
async function refuseViaAction(gateId: string, verdict: Verdict) {
  const result = await decideApprovalGateAction({
    gateId,
    decision: 'request_changes',
    identifier: card.identifier,
    noteMd: REASON,
    refusalVerdict: verdict,
    stamp: await readerStamp(),
  });
  expect(result).toMatchObject({ ok: true, gate: { state: 'changes_requested' } });
}

/** Workflow B's door: the REST route (source `api`). */
async function refuseViaRoute(gateId: string, verdict: Verdict) {
  const res = await decideRoute(
    new Request(`http://localhost/api/approval-gates/${gateId}/decide`, {
      method: 'POST',
      body: JSON.stringify({
        decision: 'request_changes',
        noteMd: REASON,
        refusalVerdict: verdict,
        stamp: await readerStamp(),
      }),
    }),
    { params: Promise.resolve({ id: gateId }) },
  );
  expect(res.status).toBe(200);
}

async function readSeed(gateId: string) {
  return seedRoute(
    new Request(`http://localhost:3000/api/approval-gates/${gateId}/planning-seed`),
    { params: Promise.resolve({ id: gateId }) },
  );
}

const promptFor = async (key: string, on: WorkItemFixture = fx) =>
  (await dispatchPromptService.getDispatchPrompt(on.projectId, key, on.ctx)).prompt;
const gateRow = (id: string) => adminDb.approvalGate.findUniqueOrThrow({ where: { id } });
const statusOf = async (id: string) =>
  (await adminDb.workItem.findUniqueOrThrow({ where: { id } })).status;
const readyKeys = async () => {
  const res = await runListReady({ projectKey: fx.project.identifier }, fx.ctx);
  return (res.structuredContent as { items: { key: string }[] }).items.map((i) => i.key);
};

/** WORKFLOW B — an OPEN linked pull request and its awaiting approve-to-merge gate. */
async function openPullRequestWithMergeGate() {
  const installation = await adminDb.githubInstallation.create({
    data: {
      workspaceId: fx.workspaceId,
      installationId: `inst-6428-${card.id}`,
      accountLogin: 'acme',
      accountType: 'Organization',
      provider: 'github',
    },
  });
  const repo = await adminDb.githubRepo.create({
    data: {
      workspaceId: fx.workspaceId,
      organizationId: fx.workspace.organizationId,
      installationId: installation.id,
      repoId: `repo-6428-${card.id}`,
      owner: 'acme',
      name: 'web',
      defaultBranch: 'main',
      provider: 'github',
    },
  });
  const pr = await adminDb.githubPullRequest.create({
    data: {
      repoId: repo.id,
      number: 12,
      title: 'design the exports list',
      state: 'open',
      headRef: 'design/exports',
      baseRef: 'main',
      provider: 'github',
    },
  });
  await adminDb.workItemDelivery.create({
    data: {
      workspaceId: fx.workspaceId,
      workItemId: card.id,
      githubPullRequestId: pr.id,
      repoId: repo.id,
    },
  });
  return withWorkspaceContext(fx.ctx, (tx) =>
    approvalGateRepository.create(
      {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        workItemId: card.id,
        kind: 'pull_request_approval',
        subjectId: card.id,
        subjectVersion: `acme/web#12@${shaFor('head')}`,
      },
      tx,
    ),
  );
}

/**
 * Everything after the refusal, common to both workflows and both verdicts: the card
 * is work again, the republish asks afresh, and the next run is handed the reason.
 */
async function assertTheCardIsWorkAgain(
  refused: { id: string; subjectVersion: string | null },
  verdict: Verdict,
) {
  // The refused version is the published evidence's own version, never blank.
  expect(refused.subjectVersion).toBeTruthy();

  // CLAIMABLE: offered by `list_ready`, and the claim takes it off To do.
  expect(await readyKeys()).toContain(card.identifier);
  const claim = await workItemsService.claimWorkItem(fx.projectId, card.identifier, fx.ctx);
  expect(claim.outcome).toBe('claimed');
  expect(await statusOf(card.id)).toBe('in_progress');

  // The run's revised publish is ACCEPTED (not refused as a settled design) and asks
  // a FRESH question over the new version; the refusal stands as the record.
  const v2 = await publish('v2');
  expect(v2.gate.id).not.toBe(refused.id);
  expect(v2.gate).toMatchObject({ state: 'awaiting', supersededCause: null });
  expect((await gateRow(refused.id)).state).toBe('changes_requested');

  // THE NEXT RUN IS HANDED THE REASON — the prompt built before the new decision.
  const prompt = await promptFor(card.identifier);
  expect(prompt).toContain('CHANGES REQUESTED — the last attempt was sent back, and why');
  expect(prompt).toContain(`  ${card.identifier} — its design_result gate was refused`);
  expect(prompt).toContain(`    refused version: ${refused.subjectVersion}`);
  expect(prompt).toContain(VERDICT_LINE[verdict]);
  expect(prompt).toContain(`      ${REASON}`);
  expect(prompt.indexOf('CHANGES REQUESTED')).toBeLessThan(prompt.indexOf('CARD DESCRIPTION'));

  // …and `get_work_item` carries the same refusal the prompt was built from.
  const tool = await runGetWorkItem({ key: card.identifier }, fx.ctx);
  expect((tool.structuredContent as { latestRefusal: unknown }).latestRefusal).toMatchObject({
    gateId: refused.id,
    kind: 'design_result',
    noteMd: REASON,
    refusalVerdict: verdict,
    subjectVersion: refused.subjectVersion,
  });
  return v2;
}

// ── the seams ────────────────────────────────────────────────────────────────────────

describe('Workflow A — refused in Motir → To do → claimable → republish → fresh gate → prompt', () => {
  for (const verdict of VERDICTS) {
    it(`${verdict}: the whole chain, through the item page's server action`, async () => {
      await moveTo('in_review');
      const v1 = await publish('v1');
      expect(v1.gate.state).toBe('awaiting');

      await refuseViaAction(v1.gate.id, verdict);

      // The verdict is stored on the decided row, which names the status it wrote.
      expect(await gateRow(v1.gate.id)).toMatchObject({
        state: 'changes_requested',
        decisionSource: 'ui',
        noteMd: REASON,
        refusalVerdict: verdict,
        outcomeRef: 'todo',
        supersededCause: null,
      });
      // The card is at To do, with a history row written by the person who refused.
      expect(await statusOf(card.id)).toBe('todo');
      const [latest] = await adminDb.workItemRevision.findMany({
        where: { workItemId: card.id },
        orderBy: { changedAt: 'desc' },
        take: 1,
      });
      expect(latest).toMatchObject({
        changedById: fx.ownerId,
        diff: { status: { from: 'in_review', to: 'todo' } },
      });

      await assertTheCardIsWorkAgain(v1.gate, verdict);
    });
  }
});

describe('Workflow B — an open pull request: the merge gate is withdrawn, never the deciding gate', () => {
  for (const verdict of VERDICTS) {
    it(`${verdict}: merge gate pulled_back, design gate changes_requested, card claimable, fresh gate`, async () => {
      await moveTo('in_review');
      const v1 = await publish('v1');
      const merge = await openPullRequestWithMergeGate();

      await refuseViaRoute(v1.gate.id, verdict);

      expect(await statusOf(card.id)).toBe('todo');
      expect(await gateRow(merge.id)).toMatchObject({
        state: 'superseded',
        supersededCause: 'pulled_back',
        decidedById: null,
      });
      expect(await gateRow(v1.gate.id)).toMatchObject({
        state: 'changes_requested',
        supersededCause: null,
        decisionSource: 'api',
        refusalVerdict: verdict,
        outcomeRef: 'todo',
      });
      // Nothing on the card still waits for a person — so nothing holds the claim.
      expect(
        await adminDb.approvalGate.count({ where: { workItemId: card.id, state: 'awaiting' } }),
      ).toBe(0);

      await assertTheCardIsWorkAgain(v1.gate, verdict);
    });
  }

  it('re_plan: the seed route anchors on the PARENT and names the waiting card; a session from it is stamped', async () => {
    await moveTo('in_review');
    const v1 = await publish('v1');
    await openPullRequestWithMergeGate();
    await refuseViaRoute(v1.gate.id, 're_plan');

    const res = await readSeed(v1.gate.id);
    expect(res.status).toBe(200);
    const { seed } = (await res.json()) as {
      seed: { gateId: string; gateKind: string; anchorKey: string; firstTurn: string };
    };
    expect(seed).toMatchObject({
      gateId: v1.gate.id,
      gateKind: 'design_result',
      anchorKey: story.identifier,
      seededSessionId: null,
    });
    expect(seed.firstTurn).toContain(`${card.identifier} · ${card.title}`);
    expect(seed.firstTurn).toContain(`“${REASON}”`);
    expect(seed.firstTurn).toContain(`The work items waiting on this design: ${waiting.key}`);
    expect(seed.firstTurn).toContain(`Re-plan ${story.identifier} from that reason`);

    // A planner session opened FROM that seed, on the anchor it named, is stamped.
    const started = await planChangeSessionsService.startSeededWithFirstTurn(
      activeProject.current!,
      buildScope([seed.anchorKey]),
      seed.firstTurn,
      seed.gateId,
    );
    const row = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: started.id } });
    expect(row.seedGateId).toBe(v1.gate.id);
    // …and the seed read now answers with the viewer's session.
    const again = (await (await readSeed(v1.gate.id)).json()) as {
      seed: { seededSessionId: string | null };
    };
    expect(again.seed.seededSessionId).toBe(started.id);
  });

  it('revise: there is NO seed — the route answers the identical 404', async () => {
    await moveTo('in_review');
    const v1 = await publish('v1');
    await openPullRequestWithMergeGate();
    await refuseViaRoute(v1.gate.id, 'revise');

    const res = await readSeed(v1.gate.id);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('a GitHub-sourced refusal on a design gate', () => {
  it('writes no status, withdraws nothing, seeds nothing — and the prompt still quotes the review body', async () => {
    await moveTo('in_review');
    const v1 = await publish('v1');
    const merge = await openPullRequestWithMergeGate();
    const body = 'Header spacing is off on mobile.';

    const result = await approvalGatesService.decide(
      {
        stamp: DECIDED_WITHOUT_A_READER,
        gateId: v1.gate.id,
        decision: 'request_changes',
        source: 'github',
        noteMd: body,
      },
      fx.ctx,
      { synced: { reviewerGithubUserId: '999001', reviewerLogin: 'octo-reviewer' } },
    );

    expect(result.effect).toEqual({
      statusWritten: null,
      statusDeferredReason: 'request_changes_moves_nothing',
    });
    expect(await statusOf(card.id)).toBe('in_review');
    expect(await gateRow(v1.gate.id)).toMatchObject({
      state: 'changes_requested',
      refusalVerdict: null,
      outcomeRef: null,
    });
    expect((await gateRow(merge.id)).state).toBe('awaiting');
    expect((await readSeed(v1.gate.id)).status).toBe(404);

    const prompt = await promptFor(card.identifier);
    expect(prompt).toContain('CHANGES REQUESTED — the last attempt was sent back, and why');
    expect(prompt).toContain('in a GitHub review');
    expect(prompt).toContain(`      ${body}`);
    expect(prompt).not.toContain('    verdict:');
  });
});

describe('approval after the refusal', () => {
  it('the fresh gate approved → the prompt section and latestRefusal are gone', async () => {
    await moveTo('in_review');
    const v1 = await publish('v1');
    await refuseViaAction(v1.gate.id, 'revise');
    const v2 = await assertTheCardIsWorkAgain(v1.gate, 'revise');

    const approved = await decideApprovalGateAction({
      gateId: v2.gate.id,
      decision: 'approve',
      identifier: card.identifier,
      stamp: await readerStamp(),
    });
    expect(approved).toMatchObject({ ok: true, gate: { state: 'approved' } });

    expect(await promptFor(card.identifier)).not.toContain('CHANGES REQUESTED');
    expect(await approvalGatesService.latestRefusalFor(card.id, fx.ctx)).toBeNull();
    const tool = await runGetWorkItem({ key: card.identifier }, fx.ctx);
    expect((tool.structuredContent as { latestRefusal: unknown }).latestRefusal).toBeNull();
  });
});

// ── the guards ───────────────────────────────────────────────────────────────────────

describe('guards', () => {
  it('another workspace reads neither the latest refusal nor the seed', async () => {
    await moveTo('in_review');
    const v1 = await publish('v1');
    await refuseViaRoute(v1.gate.id, 're_plan');
    expect(await approvalGatesService.latestRefusalFor(card.id, fx.ctx)).not.toBeNull();

    const other = await makeWorkItemFixture({ name: 'Other tenant' });
    expect(other.workspaceId).not.toBe(fx.workspaceId);
    expect(await approvalGatesService.latestRefusalFor(card.id, other.ctx)).toBeNull();

    const otherPctx = {
      ...other.ctx,
      projectId: other.projectId,
      project: other.project,
    } as unknown as ProjectContext;
    await expect(
      planningSeedService.getPlanningSeed(v1.gate.id, otherPctx, 'en'),
    ).rejects.toBeInstanceOf(PlanningSeedNotFoundError);
    signIn(other);
    expect((await readSeed(v1.gate.id)).status).toBe(404);
  });

  it('no DEFAULT_TRANSITIONS edge leads back to To do — a person’s move is still refused', async () => {
    for (const from of ['in_review', 'implemented', 'approved']) {
      expect(DEFAULT_TRANSITIONS.some(([a, b]) => a === from && b === 'todo')).toBe(false);
    }
    for (const status of ['in_review', 'implemented'] as const) {
      await adminDb.workItem.update({ where: { id: card.id }, data: { status: 'todo' } });
      await moveTo(status);
      await expect(workItemsService.updateStatus(card.id, 'todo', fx.ctx)).rejects.toBeInstanceOf(
        IllegalTransitionError,
      );
      expect(await statusOf(card.id)).toBe(status);
    }
  });

  it('refusal_verdict is immutable on a decided row — even to the table owner', async () => {
    await moveTo('in_review');
    const v1 = await publish('v1');
    await refuseViaAction(v1.gate.id, 'revise');

    await expect(
      adminDb.approvalGate.update({
        where: { id: v1.gate.id },
        data: { refusalVerdict: 're_plan' },
      }),
    ).rejects.toThrow(/AG_DECIDED_IMMUTABLE/);
    await expect(
      adminDb.approvalGate.update({ where: { id: v1.gate.id }, data: { refusalVerdict: null } }),
    ).rejects.toThrow(/AG_DECIDED_IMMUTABLE/);
    expect((await gateRow(v1.gate.id)).refusalVerdict).toBe('revise');
  });
});

describe('coverage floor — the refusal band reads its own reasons off the door', () => {
  it('VERB_NOT_OFFERED keeps a band reason, and drops any other (or none) to the bare tag', () => {
    for (const reason of [
      'request_changes_needs_a_note',
      'refusal_verdict_required',
      'refusal_verdict_not_offered',
    ] as const) {
      expect(toGateRefusal('APPROVAL_GATE_VERB_NOT_OFFERED', { reason })).toEqual({
        tag: 'APPROVAL_GATE_VERB_NOT_OFFERED',
        reason,
      });
    }
    expect(toGateRefusal('APPROVAL_GATE_VERB_NOT_OFFERED', { reason: 'kind_not_offered' })).toEqual(
      { tag: 'APPROVAL_GATE_VERB_NOT_OFFERED' },
    );
    expect(toGateRefusal('APPROVAL_GATE_VERB_NOT_OFFERED')).toEqual({
      tag: 'APPROVAL_GATE_VERB_NOT_OFFERED',
    });
  });
});

describe('coverage floor — the story’s reads outside the chain’s own call shapes', () => {
  it('the two new repository reads, inside the caller’s transaction', async () => {
    await moveTo('in_review');
    const v1 = await publish('v1');
    await refuseViaRoute(v1.gate.id, 're_plan');

    const [latest, dependents] = await withWorkspaceContext(fx.ctx, (tx) =>
      Promise.all([
        approvalGateRepository.findLatestDecidedByWorkItem(card.id, tx),
        workItemLinkRepository.findDependentKeys(card.id, tx),
      ]),
    );
    expect(latest?.id).toBe(v1.gate.id);
    expect(dependents.map((d) => d.identifier)).toEqual([waiting.key]);
  });

  it('a seeded session is refused when the refused card has since MOVED to another project', async () => {
    await moveTo('in_review');
    const v1 = await publish('v1');
    await refuseViaRoute(v1.gate.id, 're_plan');
    const elsewhere = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      name: 'Elsewhere',
      identifier: 'ELSE',
    });
    await adminDb.workItem.update({
      where: { id: card.id },
      data: { projectId: elsewhere.id, parentId: null, kind: 'task' },
    });

    await expect(
      planChangeSessionsService.startSeededWithFirstTurn(
        activeProject.current!,
        buildScope([story.identifier]),
        'Re-plan it',
        v1.gate.id,
      ),
    ).rejects.toBeInstanceOf(PlanSeedNotApplicableError);
    expect(await adminDb.planChangeSession.count()).toBe(0);
  });
});
