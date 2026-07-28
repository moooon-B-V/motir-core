import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures/workItemFixtures';
import { truncateAuthTables } from '../../helpers/db';

// Story 7.12 (MOTIR-812) — the per-repo INTEGRATION + CONTRACT gate for
// CONTEXTUAL planning and its confirm-before-write guarantee (7.12.6 ·
// MOTIR-912), against a real Postgres.
//
// Each of the story's subtasks ships its own units: MOTIR-909 proves the
// anchored session mechanics, MOTIR-1745 proves the submit echoes a planId,
// MOTIR-911 proves the persist gate's verdict, MOTIR-1746 proves the rail reads
// and confirms a Plan. What NO unit sees — because each asserts against its own
// fixture of the next one's shape — is the JOINT: whether the planId a
// contextual submit hands back actually addresses the plan the rail reads, and
// whether what that read returns is the thing approve materializes. So every
// stage here is driven through the NEXT stage's REAL consumer:
//
//   POST /api/work-items/[id]/ai/plan   (the anchored entrance, real route)
//     → the engine's proposal callback   (plansService.addProposals/markPlanned)
//     → readPendingProposal()            (the rail's REAL client, over the real
//                                         GET /api/plans/[id])
//     → approvePlanRequest()             (the rail's REAL confirm, over the real
//                                         POST /api/plans/[id]/approve)
//     → summarizePlanApproval()          (what the rail says back)
//     → the work-item rows               (the fact, read from the database)
//
// and the second half asserts the confirm-before-write INVARIANTS a coverage
// number cannot see: no-approve-no-write, exactly one persist path,
// trigger-agnosticism, rejection-writes-nothing, and cross-tenant 404-not-403.
//
// The delta path this card once asserted is dead and gone (MOTIR-1747): nothing
// here reads a `planDelta` or calls a delta approve, and a guard below keeps it
// that way for the test tree too.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', () => ({ getSession: async () => session.current }));
vi.mock('@/lib/projects', () => ({ getActiveProject: async () => activeCtx.current }));
// The plan read/approve routes resolve the WORKSPACE (not the active project);
// the node test env has no cookies to resolve one from, so it is stubbed to the
// same tenant the session is in — `getSession`'s sibling, no more.
vi.mock('@/lib/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspaces')>()),
  getWorkspaceContext: async () =>
    activeCtx.current
      ? { userId: activeCtx.current.userId, workspaceId: activeCtx.current.workspaceId }
      : null,
}));

// The motir-ai BOUNDARY — the one mock the convention allows. A real engine is
// absent from CI; everything on THIS side of the boundary runs for real.
const submitJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: 'job-contextual-1' }));
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
  streamJob: vi.fn(),
  getJob: vi.fn(),
  getConvention: vi.fn(),
  getCodeAudit: vi.fn(),
  refreshCodeAudit: vi.fn(),
  saveDesignChoice: vi.fn(),
  indexCodeGraph: vi.fn(),
  getPreplanState: vi.fn(),
  getOrgUsage: vi.fn(),
  getOrgSubscription: vi.fn(),
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
  setSeatQuantity: vi.fn(),
  parseSseFrame: vi.fn(),
}));

// next-intl's server helper needs a request-scoped i18n config the node env has
// no request for; echo the key so a copy assertion is impossible by construction
// (this file asserts WIRING, never strings).
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => key,
}));

const { POST: contextualPlanRoute, GET: resumeRoute } =
  await import('@/app/api/work-items/[id]/ai/plan/route');
const { GET: planReadRoute } = await import('@/app/api/plans/[id]/route');
const { POST: approvePlanRoute } = await import('@/app/api/plans/[id]/approve/route');
const { POST: declinePlanRoute } = await import('@/app/api/plans/[id]/decline/route');
const { PATCH: patchProposalRoute } = await import('@/app/api/plans/[id]/items/[itemId]/route');
const { readPendingProposal, summarizePlanApproval, planDecisionErrorCode } =
  await import('@/lib/planning/planReview');
const { approvePlanRequest, declinePlanRequest, updateProposalRequest, PlanRequestError } =
  await import('@/lib/planning/planReviewClient');
const { aiPlanEditsService } = await import('@/lib/services/aiPlanEditsService');

const BASE = 'http://localhost:3000';

/**
 * Route the rail's REAL client calls into the REAL route handlers.
 *
 * `planReviewClient` fetches relative URLs, which a node test env cannot serve.
 * Stubbing `fetch` to DISPATCH into the shipped handlers keeps the product's
 * client, the product's URLs and the product's routes all in the path — the
 * point of a seam test. Anything else 404s loudly rather than silently
 * resolving, so a typo in a URL fails here instead of passing vacuously.
 */
function installRailFetch(): void {
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const raw =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const path = raw.startsWith('http') ? new URL(raw).pathname : (raw.split('?')[0] ?? '');

      const approve = /^\/api\/plans\/([^/]+)\/approve$/.exec(path);
      if (approve) {
        const id = decodeURIComponent(approve[1]!);
        return approvePlanRoute(new Request(`${BASE}${path}`, { method: 'POST' }), {
          params: Promise.resolve({ id }),
        });
      }
      const decline = /^\/api\/plans\/([^/]+)\/decline$/.exec(path);
      if (decline) {
        const id = decodeURIComponent(decline[1]!);
        return declinePlanRoute(new Request(`${BASE}${path}`, { method: 'POST' }), {
          params: Promise.resolve({ id }),
        });
      }
      const item = /^\/api\/plans\/([^/]+)\/items\/([^/]+)$/.exec(path);
      if (item) {
        return patchProposalRoute(
          new Request(`${BASE}${path}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: (init?.body as string | undefined) ?? '{}',
          }),
          {
            params: Promise.resolve({
              id: decodeURIComponent(item[1]!),
              itemId: decodeURIComponent(item[2]!),
            }),
          },
        );
      }
      const read = /^\/api\/plans\/([^/]+)$/.exec(path);
      if (read) {
        const id = decodeURIComponent(read[1]!);
        return planReadRoute(new Request(`${BASE}${path}`), { params: Promise.resolve({ id }) });
      }
      throw new Error(`the rail fetched an endpoint this seam does not serve: ${raw}`);
    },
  );
}

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  vi.unstubAllGlobals();
  submitJobMock.mockClear();
  submitJobMock.mockResolvedValue({ jobId: 'job-contextual-1' });
  fx = await makeWorkItemFixture();
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
  installRailFetch();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await db.$disconnect();
});

const svcCtx = () => ({ userId: fx.ownerId, workspaceId: fx.workspaceId });

/** Seed through the SERVICE, not the raw fixture helper: approve appends
 *  siblings with `generateKeyBetween`, which rejects the fixture's zero-padded
 *  stand-in positions. Only real fractional positions make the "approve into a
 *  tree that already has items" case run at all. */
async function seedItem(input: {
  kind: 'epic' | 'story' | 'task' | 'bug' | 'subtask';
  title: string;
  parentId?: string | null;
}) {
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: input.kind,
      title: input.title,
      parentId: input.parentId ?? null,
    },
    svcCtx(),
  );
}

/** A contextual turn through the REAL anchored entrance — the route the panel
 *  posts to. Returns exactly what the rail holds afterwards. */
async function planFromItem(
  anchorId: string,
  prompt: string,
  targetKeys?: string[],
): Promise<{ jobId: string; planId: string; sessionId: string }> {
  const res = await contextualPlanRoute(
    new Request(`${BASE}/api/work-items/${anchorId}/ai/plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt, ...(targetKeys ? { targetKeys } : {}) }),
    }),
    { params: Promise.resolve({ id: anchorId }) },
  );
  expect(res.status, 'the contextual submit must be accepted').toBe(200);
  return (await res.json()) as { jobId: string; planId: string; sessionId: string };
}

/** Play back what motir-ai does with an accepted job: append the run's proposals
 *  to the Plan the submit opened, then close the frontier. These are the SAME
 *  calls `aiGenerationService` makes on the engine's callback — only the network
 *  hop is elided. */
async function engineProposes(
  planId: string,
  proposals: Parameters<typeof plansService.addProposals>[1],
): Promise<void> {
  await plansService.addProposals(planId, proposals, svcCtx());
  await plansService.markPlanned(planId, svcCtx());
}

/** Everything an approve could touch, for a byte-identical no-write check. */
async function treeSnapshot(): Promise<unknown> {
  const items = await db.workItem.findMany({
    where: { projectId: fx.projectId },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      title: true,
      kind: true,
      parentId: true,
      status: true,
      descriptionMd: true,
      priority: true,
      archivedAt: true,
      updatedAt: true,
    },
  });
  const links = await db.workItemLink.findMany({
    where: { workspaceId: fx.workspaceId },
    orderBy: { id: 'asc' },
    select: { fromId: true, toId: true, kind: true },
  });
  const revisions = await db.workItemRevision.count({
    where: { workItem: { projectId: fx.projectId } },
  });
  return { items, links, revisions };
}

// ───────── Seam · the anchored run's planId addresses what approve writes ─────────

describe('seam · contextual submit → the run’s proposals → the rail’s read → the tree', () => {
  it('runs the whole anchored loop, each stage read through the next stage’s real consumer', async () => {
    const story = await seedItem({ kind: 'story', title: 'Checkout' });

    // 1. The anchored entrance. The panel gets back the job to stream AND the
    //    plan to confirm — the pair MOTIR-1745 threads through this seam.
    const { jobId, planId } = await planFromItem(story.id, 'Break this story into subtasks');
    expect(planId).toBeTruthy();

    // The submit really did anchor the turn (the contextual half) and really did
    // open the run's plan bound to that job (the confirm half).
    const submitted = submitJobMock.mock.calls[0]![2] as { targetKeys?: string[] };
    expect(submitted.targetKeys).toEqual([story.identifier]);
    const opened = await db.plan.findUnique({ where: { id: planId } });
    expect(opened?.sourceJobId).toBe(jobId);
    expect(opened?.status).toBe('generating');
    expect(opened?.origin).toBe('user');

    // 2. The engine proposes into THAT plan — an add under the anchor, a second
    //    add hanging off the first by intra-plan temp-ref, and a modify of the
    //    anchor itself (the neighborhood a contextual turn legitimately reaches).
    const first = await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'Card form', kind: 'subtask', priority: 'high' },
          parentRef: story.id,
        },
      ],
      svcCtx(),
    );
    const cardFormItemId = first.items[0]!.id;
    await engineProposes(planId, [
      {
        op: 'add',
        proposedFields: { title: 'Validate the PAN', kind: 'subtask', estimateMinutes: 30 },
        parentRef: story.id,
        blockedByRefs: [`${TEMP_REF_PREFIX}${cardFormItemId}`],
      },
      { op: 'modify', workItemId: story.id, patch: { title: 'Checkout & payment' } },
    ]);

    // 3. The RAIL's read — the product's own client, over the product's route.
    //    This is the joint: if the submit's planId did not address the plan the
    //    proposals landed in, this returns null and the user sees "nothing was
    //    proposed" while the proposals sit unread (exactly the MOTIR-1747 bug).
    const pending = await readPendingProposal(planId);
    expect(pending, 'the rail must find the anchored run’s proposals').not.toBeNull();
    expect(pending!.status).toBe('planned');
    expect(pending!.items).toHaveLength(3);

    // …and the read model resolves refs to CANVAS node ids, which is what the
    // rail draws with. The modify shares the target's node id (not a ghost copy);
    // the adds hang off the anchor.
    const byTitle = new Map(pending!.items.map((i) => [i.title, i]));
    // A `modify` renders under the target's LIVE title, with the proposed value
    // carried as the diff the rail overlays — not as a second node called
    // "Checkout & payment". That distinction is the whole reason the read model
    // exists, so assert the shape rather than assuming it.
    const modify = byTitle.get('Checkout')!;
    expect(modify.op).toBe('modify');
    expect(modify.nodeId).toBe(story.id);
    expect(modify.changes).toContainEqual({
      field: 'title',
      from: 'Checkout',
      to: 'Checkout & payment',
    });
    expect(byTitle.get('Card form')!.parentNodeId).toBe(story.id);
    expect(byTitle.get('Validate the PAN')!.blockedByNodeIds).toEqual([cardFormItemId]);
    // Nothing is materialized yet — the read is a review, not a write.
    expect(byTitle.get('Card form')!.identifier).toBeNull();
    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(1);

    // 4. The rail's CONFIRM — the same client the four entrances share.
    const approved = await approvePlanRequest(planId);
    expect(approved.status).toBe('approved');

    // 5. What the rail says back, through its real summarizer…
    const summary = summarizePlanApproval(approved);
    expect(summary.created).toHaveLength(2);
    expect(summary.updated).toEqual([story.id]);
    expect(summary.removed).toEqual([]);

    // 6. …and what actually happened, read from the database. The response is the
    //    claim; the rows are the fact.
    const rows = await db.workItem.findMany({ where: { projectId: fx.projectId } });
    const items = new Map(rows.map((r) => [r.title, r]));
    expect(rows).toHaveLength(3);
    expect(items.get('Checkout & payment')!.id).toBe(story.id);
    const cardForm = items.get('Card form')!;
    const pan = items.get('Validate the PAN')!;
    expect(cardForm.parentId).toBe(story.id);
    expect(cardForm.priority).toBe('high');
    expect(pan.parentId).toBe(story.id);
    expect(pan.estimateMinutes).toBe(30);
    // The summarizer named the rows that exist — the ids it reports are real.
    expect(new Set(summary.created)).toEqual(new Set([cardForm.id, pan.id]));
    // The intra-plan blocked-by ref resolved to the sibling created in the SAME
    // approve — the edge the rail drew, now a real link.
    const link = await db.workItemLink.findFirstOrThrow({
      where: { fromId: pan.id, toId: cardForm.id, kind: 'is_blocked_by' },
    });
    expect(link.toId).toBe(cardForm.id);

    // The run is DECIDED: nothing left `planned` for the rail to re-offer.
    expect(await readPendingProposal(planId)).toBeNull();
  });

  it('a RESUMED thread confirms the same plan it was resumed with', async () => {
    // The one path where the rail cannot already hold the id: the user closed the
    // workspace mid-proposal and came back. Resume resolves the pending plan from
    // the thread's own last job — and that id must address the same proposals.
    const story = await seedItem({ kind: 'story', title: 'Search' });
    const { planId } = await planFromItem(story.id, 'Expand this');
    await engineProposes(planId, [
      {
        op: 'add',
        proposedFields: { title: 'Indexing', kind: 'subtask' },
        parentRef: story.id,
      },
    ]);

    const res = await resumeRoute(new Request(`${BASE}/api/work-items/${story.id}/ai/plan`), {
      params: Promise.resolve({ id: story.id }),
    });
    expect(res.status).toBe(200);
    const { planId: resumedPlanId } = (await res.json()) as { planId: string | null };
    expect(resumedPlanId).toBe(planId);

    const pending = await readPendingProposal(resumedPlanId!);
    expect(pending!.items.map((i) => i.title)).toEqual(['Indexing']);

    await approvePlanRequest(resumedPlanId!);
    expect(await db.workItem.count({ where: { title: 'Indexing' } })).toBe(1);
  });
});

// ───────────────── The confirm-before-write invariants ─────────────────

describe('no approve ⇒ no write — a completed run leaves the tree byte-identical', () => {
  it('a finished contextual run proposes everything and persists nothing', async () => {
    const story = await seedItem({ kind: 'story', title: 'Untouched' });
    const doomed = await seedItem({ kind: 'task', title: 'Never archived' });
    const before = await treeSnapshot();

    // All THREE ops in one run — a remove is the op a delta contract had no room
    // for (MOTIR-1746), and it is the one whose "no write" is easiest to get
    // wrong, because archiving is a soft delete rather than an insert.
    const { planId } = await planFromItem(story.id, 'Restructure this');
    await engineProposes(planId, [
      { op: 'add', proposedFields: { title: 'Never built', kind: 'subtask' }, parentRef: story.id },
      { op: 'modify', workItemId: story.id, patch: { title: 'Never renamed' } },
      { op: 'remove', workItemId: doomed.id },
    ]);

    // The run is COMPLETE and fully reviewable — this is not "nothing happened",
    // it is "everything happened except the write".
    const pending = await readPendingProposal(planId);
    expect(pending!.items).toHaveLength(3);
    expect(pending!.status).toBe('planned');

    expect(await treeSnapshot()).toEqual(before);
    expect((await db.plan.findUnique({ where: { id: planId } }))?.status).toBe('planned');
    expect(await db.workItem.count({ where: { title: 'Never built' } })).toBe(0);

    // …and it is the APPROVE, not the run, that writes.
    await approvePlanRequest(planId);
    expect(await treeSnapshot()).not.toEqual(before);
  });

  it('declining a contextual run decides it with the tree still untouched', async () => {
    const story = await seedItem({ kind: 'story', title: 'Kept as-is' });
    const before = await treeSnapshot();
    const { planId } = await planFromItem(story.id, 'Try something');
    await engineProposes(planId, [
      { op: 'add', proposedFields: { title: 'Discarded', kind: 'subtask' }, parentRef: story.id },
    ]);

    // Through the rail's REAL Discard, not the service behind it — a run the user
    // rejected must end DECIDED, not orphaned at `planned` where the auto-plan
    // pause (MOTIR-1740) would keep reading it as awaiting review.
    const declined = await declinePlanRequest(planId);
    expect(declined.status).toBe('declined');

    expect(await treeSnapshot()).toEqual(before);
    expect(await readPendingProposal(planId)).toBeNull();
    expect((await db.plan.findUnique({ where: { id: planId } }))?.status).toBe('declined');

    // Discarding twice is a no-op the surface can explain, not a crash.
    const again = await declinePlanRequest(planId).catch((e: unknown) => e);
    expect(planDecisionErrorCode(again)).toBe('decided');
  });

  it('a reviewer’s EDIT is what gets built — the proposal is not trusted, the confirmed set is', async () => {
    // The review surface can rewrite an `add` before confirming (MOTIR-1370).
    // That edit is only meaningful if the APPROVE materializes the edited value
    // rather than the generated one — the seam between the rail's inline edit and
    // the persist path, which each side's units assert against its own fixture of.
    const story = await seedItem({ kind: 'story', title: 'Reports' });
    const { planId } = await planFromItem(story.id, 'Expand this');
    await engineProposes(planId, [
      {
        op: 'add',
        proposedFields: { title: 'Generated title', kind: 'subtask', priority: 'low' },
        parentRef: story.id,
      },
    ]);

    const pending = await readPendingProposal(planId);
    const proposalId = pending!.items[0]!.planItemId;
    const edited = await updateProposalRequest(planId, proposalId, {
      title: 'The title the reviewer wants',
      priority: 'high',
    });
    expect(edited.items[0]!.proposedFields?.title).toBe('The title the reviewer wants');
    // Still a proposal — an edit is not a write either.
    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(1);

    await approvePlanRequest(planId);
    const built = await db.workItem.findFirstOrThrow({
      where: { projectId: fx.projectId, parentId: story.id },
    });
    expect(built.title).toBe('The title the reviewer wants');
    expect(built.priority).toBe('high');
    expect(await db.workItem.count({ where: { title: 'Generated title' } })).toBe(0);
  });

  it('an edit that would break the proposal is refused, and the run stays reviewable', async () => {
    const story = await seedItem({ kind: 'story', title: 'Docs' });
    const { planId } = await planFromItem(story.id, 'Expand this');
    await engineProposes(planId, [
      {
        op: 'add',
        proposedFields: { title: 'Keeps its title', kind: 'subtask' },
        parentRef: story.id,
      },
    ]);
    const pending = await readPendingProposal(planId);
    const proposalId = pending!.items[0]!.planItemId;

    const err = await updateProposalRequest(planId, proposalId, { title: '   ' }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PlanRequestError);
    expect((err as InstanceType<typeof PlanRequestError>).status).toBe(422);

    // Unharmed: the original proposal is still there to confirm.
    const still = await readPendingProposal(planId);
    expect(still!.items[0]!.title).toBe('Keeps its title');
  });
});

describe('the gate is TRIGGER-AGNOSTIC — same predicate, same confirm', () => {
  /** The proposal set both triggers get, so only the trigger differs. */
  const proposalsFor = (storyId: string): Parameters<typeof plansService.addProposals>[1] => [
    { op: 'add', proposedFields: { title: 'Proposed leaf', kind: 'subtask' }, parentRef: storyId },
  ];

  it('a user turn and the cadence watcher review and materialize identically', async () => {
    const userStory = await seedItem({ kind: 'story', title: 'User-triggered' });
    const cadenceStory = await seedItem({ kind: 'story', title: 'Cadence-triggered' });

    // The user turn: the real anchored entrance.
    const { planId: userPlanId } = await planFromItem(userStory.id, 'Expand this');
    // The cadence watcher: the SAME shipped submit the auto-plan sweep calls,
    // differing only in the origin it stamps (`autoPlanCadenceService`).
    submitJobMock.mockResolvedValue({ jobId: 'job-cadence-1' });
    const { planId: cadencePlanId } = await aiPlanEditsService.submitExpand(
      cadenceStory.identifier,
      activeCtx.current!,
      { origin: 'cadence' },
    );

    // The provenance really does differ — otherwise this asserts nothing.
    expect((await db.plan.findUnique({ where: { id: userPlanId } }))?.origin).toBe('user');
    expect((await db.plan.findUnique({ where: { id: cadencePlanId } }))?.origin).toBe('cadence');

    await engineProposes(userPlanId, proposalsFor(userStory.id));
    await engineProposes(cadencePlanId, proposalsFor(cadenceStory.id));

    // Same rail predicate: a cadence plan is reviewable on exactly the same terms.
    for (const planId of [userPlanId, cadencePlanId]) {
      const pending = await readPendingProposal(planId);
      expect(pending, `plan ${planId} must be reviewable`).not.toBeNull();
      expect(pending!.items).toHaveLength(1);
    }

    // Same confirm: neither is materialized until approved, and both then are.
    expect(await db.workItem.count({ where: { title: 'Proposed leaf' } })).toBe(0);
    await approvePlanRequest(userPlanId);
    await approvePlanRequest(cadencePlanId);
    const created = await db.workItem.findMany({ where: { title: 'Proposed leaf' } });
    expect(created).toHaveLength(2);
    expect(new Set(created.map((r) => r.parentId))).toEqual(
      new Set([userStory.id, cadenceStory.id]),
    );
  });

  it('rejects an illegal proposal identically whoever triggered the plan', async () => {
    // The mirror case: the gate must not be softer on a plan the machine opened
    // than on one the user did. A subtask may not hang off an epic.
    const epic = await seedItem({ kind: 'epic', title: 'The epic' });
    const story = await seedItem({ kind: 'story', title: 'Anchor' });

    const { planId: userPlanId } = await planFromItem(story.id, 'Add a subtask to the epic');
    submitJobMock.mockResolvedValue({ jobId: 'job-cadence-2' });
    const { planId: cadencePlanId } = await aiPlanEditsService.submitExpand(
      story.identifier,
      activeCtx.current!,
      { origin: 'cadence' },
    );

    const illegal: Parameters<typeof plansService.addProposals>[1] = [
      {
        op: 'add',
        proposedFields: { title: 'Illegal child', kind: 'subtask' },
        parentRef: epic.id,
      },
    ];
    await engineProposes(userPlanId, illegal);
    await engineProposes(cadencePlanId, illegal);

    const before = await treeSnapshot();
    for (const planId of [userPlanId, cadencePlanId]) {
      const err = await approvePlanRequest(planId).catch((e: unknown) => e);
      expect(err, `plan ${planId} must be refused`).toBeInstanceOf(PlanRequestError);
      expect((err as InstanceType<typeof PlanRequestError>).status).toBe(400);
      expect((err as InstanceType<typeof PlanRequestError>).code).toBe('PLAN_GRAMMAR_VIOLATION');
    }
    expect(await treeSnapshot()).toEqual(before);
    expect(await db.workItem.count({ where: { title: 'Illegal child' } })).toBe(0);
  });
});

describe('every rejection class leaves the database untouched — through the anchored entrance', () => {
  /**
   * Propose `proposals` on a real contextual run, confirm through the rail, and
   * assert the refusal carried `status`/`code` to the surface while the tree and
   * the plan stayed exactly as they were (so the user can fix and retry).
   */
  async function expectRefused(
    proposals: Parameters<typeof plansService.addProposals>[1],
    expected: { status: number; code: string },
    anchorId: string,
  ): Promise<void> {
    const before = await treeSnapshot();
    const { planId } = await planFromItem(anchorId, 'Do the thing');
    await engineProposes(planId, proposals);

    const err = await approvePlanRequest(planId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanRequestError);
    const failure = err as InstanceType<typeof PlanRequestError>;
    expect(failure.status).toBe(expected.status);
    expect(failure.code).toBe(expected.code);

    expect(await treeSnapshot()).toEqual(before);
    // Still `planned`, and still offered by the rail — a refusal is recoverable
    // in place, not a run the user has to start over.
    expect((await db.plan.findUnique({ where: { id: planId } }))?.status).toBe('planned');
    expect(await readPendingProposal(planId)).not.toBeNull();
  }

  it('an illegal kind-parent edge — 400, nothing written', async () => {
    const epic = await seedItem({ kind: 'epic', title: 'Epic' });
    const anchor = await seedItem({ kind: 'story', title: 'Anchor' });
    await expectRefused(
      [{ op: 'add', proposedFields: { title: 'Bad child', kind: 'subtask' }, parentRef: epic.id }],
      { status: 400, code: 'PLAN_GRAMMAR_VIOLATION' },
      anchor.id,
    );
  });

  it('a DANGLING intra-plan parentRef — 400, nothing written', async () => {
    const anchor = await seedItem({ kind: 'story', title: 'Anchor' });
    await expectRefused(
      [
        {
          op: 'add',
          proposedFields: { title: 'Orphan', kind: 'task' },
          parentRef: `${TEMP_REF_PREFIX}missing`,
        },
      ],
      { status: 400, code: 'INVALID_PLAN_REF_GRAPH' },
      anchor.id,
    );
  });

  it('a DUPLICATE blocker — 400, nothing written', async () => {
    const anchor = await seedItem({ kind: 'story', title: 'Anchor' });
    const blocker = await seedItem({ kind: 'task', title: 'Blocker' });
    await expectRefused(
      [
        {
          op: 'add',
          proposedFields: { title: 'Blocked twice', kind: 'task' },
          blockedByRefs: [blocker.id, blocker.id],
        },
      ],
      { status: 400, code: 'INVALID_PLAN_REF_GRAPH' },
      anchor.id,
    );
  });

  it('a modify targeting DONE work — 409, nothing written', async () => {
    const anchor = await seedItem({ kind: 'story', title: 'Anchor' });
    const shipped = await seedItem({ kind: 'task', title: 'Shipped' });
    for (const status of ['in_progress', 'in_review', 'done'] as const) {
      await workItemsService.updateStatus(shipped.id, status, svcCtx());
    }
    await expectRefused(
      [{ op: 'modify', workItemId: shipped.id, patch: { title: 'Rewritten' } }],
      { status: 409, code: 'PLAN_TARGET_IMMUTABLE' },
      anchor.id,
    );
  });

  it('a remove targeting CANCELLED work — 409, nothing written', async () => {
    const anchor = await seedItem({ kind: 'story', title: 'Anchor' });
    const dropped = await seedItem({ kind: 'task', title: 'Dropped' });
    await workItemsService.updateStatus(dropped.id, 'cancelled', svcCtx());
    await expectRefused(
      [{ op: 'remove', workItemId: dropped.id }],
      { status: 409, code: 'PLAN_TARGET_IMMUTABLE' },
      anchor.id,
    );
  });

  it('a CYCLE among intra-plan parent refs — 400, nothing written', async () => {
    const anchor = await seedItem({ kind: 'story', title: 'Anchor' });
    const before = await treeSnapshot();
    const { planId } = await planFromItem(anchor.id, 'Restructure');
    const a = await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'A', kind: 'story' } }],
      svcCtx(),
    );
    const aId = a.items[0]!.id;
    const b = await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'B', kind: 'story' },
          parentRef: `${TEMP_REF_PREFIX}${aId}`,
        },
      ],
      svcCtx(),
    );
    const bId = b.items.find((i) => i.proposedFields?.title === 'B')!.id;
    await db.planItem.update({
      where: { id: aId },
      data: { parentRef: `${TEMP_REF_PREFIX}${bId}` },
    });
    await plansService.markPlanned(planId, svcCtx());

    const err = await approvePlanRequest(planId).catch((e: unknown) => e);
    expect((err as InstanceType<typeof PlanRequestError>).status).toBe(400);
    expect(await treeSnapshot()).toEqual(before);
  });

  it('the rail can EXPLAIN each refusal — a raw server code never reaches the screen', async () => {
    // The refusals above are only useful if the surface can say what happened.
    // `planDecisionErrorCode` is the rail's real translator; assert it over the
    // real errors rather than over hand-built ones.
    const anchor = await seedItem({ kind: 'story', title: 'Anchor' });
    const shipped = await seedItem({ kind: 'task', title: 'Shipped' });
    for (const status of ['in_progress', 'in_review', 'done'] as const) {
      await workItemsService.updateStatus(shipped.id, status, svcCtx());
    }
    const { planId } = await planFromItem(anchor.id, 'Redo it');
    await engineProposes(planId, [
      { op: 'modify', workItemId: shipped.id, patch: { title: 'Rewritten' } },
    ]);
    const immutable = await approvePlanRequest(planId).catch((e: unknown) => e);
    expect(planDecisionErrorCode(immutable)).toBe('immutable');

    // …and a plan someone else already decided reads as `decided`, not as a crash.
    const other = await seedItem({ kind: 'story', title: 'Other' });
    const { planId: decidedId } = await planFromItem(other.id, 'Expand');
    await engineProposes(decidedId, [
      { op: 'add', proposedFields: { title: 'Once', kind: 'subtask' }, parentRef: other.id },
    ]);
    await approvePlanRequest(decidedId);
    const twice = await approvePlanRequest(decidedId).catch((e: unknown) => e);
    expect(planDecisionErrorCode(twice)).toBe('decided');
    // The second confirm changed nothing — one approve, one materialize.
    expect(await db.workItem.count({ where: { title: 'Once' } })).toBe(1);
  });
});

describe('the confirm client degrades safely when the failure is not a typed one', () => {
  it('a non-JSON error body still surfaces the STATUS, with a null code', async () => {
    // Every shipped route answers JSON, so this arm is only reachable when
    // something in front of the app answers instead — an edge proxy 502, a
    // gateway timeout page. It must still raise a typed `PlanRequestError` the
    // rail can explain, never a JSON parse crash inside the confirm handler.
    // (Stubbed directly: a real route cannot produce the shape under test.)
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response('<html>502 Bad Gateway</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const err = await approvePlanRequest('plan_x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanRequestError);
    expect((err as InstanceType<typeof PlanRequestError>).status).toBe(502);
    expect((err as InstanceType<typeof PlanRequestError>).code).toBeNull();
    // …and it falls to the generic recoverable line rather than claiming the plan
    // was decided or that a target moved.
    expect(planDecisionErrorCode(err)).toBe('APPROVE_ERROR');
    expect(planDecisionErrorCode(err, 'DISCARD_ERROR')).toBe('DISCARD_ERROR');

    // Same for a JSON error that simply carries no `code` — the status is still
    // what the surface reasons from, and `code` is null rather than undefined.
    vi.stubGlobal('fetch', async () =>
      Response.json({ error: 'something went wrong' }, { status: 500 }),
    );
    const uncoded = await approvePlanRequest('plan_x').catch((e: unknown) => e);
    expect((uncoded as InstanceType<typeof PlanRequestError>).status).toBe(500);
    expect((uncoded as InstanceType<typeof PlanRequestError>).code).toBeNull();
  });

  it('a thrown transport error is not swallowed into a fake verdict', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('network down');
    });
    await expect(approvePlanRequest('plan_x')).rejects.toBeInstanceOf(TypeError);
    // Not a PlanRequestError, so the rail reports the generic line — it must not
    // read a dropped connection as "someone else already decided this".
    expect(planDecisionErrorCode(new TypeError('network down'))).toBe('APPROVE_ERROR');
  });
});

describe('tenancy — a plan outside the actor’s workspace is 404, never 403', () => {
  it('hides a rival tenant’s plan from BOTH the review read and the confirm', async () => {
    // The rival runs a real contextual plan in their own tenant…
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const theirStory = await workItemsService.createWorkItem(
      { projectId: rival.projectId, kind: 'story', title: 'Theirs' },
      rival.ctx,
    );
    const rivalPlan = await plansService.createPlan(
      rival.projectId,
      { title: 'Rival plan', sourceJobId: 'job-rival-1' },
      rival.ctx,
    );
    await plansService.addProposals(
      rivalPlan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Their work', kind: 'subtask' },
          parentRef: theirStory.id,
        },
      ],
      rival.ctx,
    );
    await plansService.markPlanned(rivalPlan.id, rival.ctx);

    // …and OUR actor (whose workspace context is the fixture's) may not see it.
    // 404, never 403: a 403 would confirm the plan exists.
    const read = await planReadRoute(new Request(`${BASE}/api/plans/${rivalPlan.id}`), {
      params: Promise.resolve({ id: rivalPlan.id }),
    });
    expect(read.status).toBe(404);
    expect(read.status).not.toBe(403);

    const confirm = await approvePlanRoute(
      new Request(`${BASE}/api/plans/${rivalPlan.id}/approve`, { method: 'POST' }),
      { params: Promise.resolve({ id: rivalPlan.id }) },
    );
    expect(confirm.status).toBe(404);
    expect(confirm.status).not.toBe(403);

    // And the refusal is real, not cosmetic: the rival's tree is untouched.
    expect(await db.workItem.count({ where: { projectId: rival.projectId } })).toBe(1);
    expect((await db.plan.findUnique({ where: { id: rivalPlan.id } }))?.status).toBe('planned');
  });

  it('the rail’s own client reports a cross-tenant plan as `decided`, not as an error dump', async () => {
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const rivalPlan = await plansService.createPlan(rival.projectId, {}, rival.ctx);
    const err = await approvePlanRequest(rivalPlan.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanRequestError);
    expect((err as InstanceType<typeof PlanRequestError>).status).toBe(404);
    expect(planDecisionErrorCode(err)).toBe('decided');
  });

  it('a work item in another tenant is not a usable anchor — the run never starts', async () => {
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const theirs = await workItemsService.createWorkItem(
      { projectId: rival.projectId, kind: 'story', title: 'Theirs' },
      rival.ctx,
    );
    const res = await contextualPlanRoute(
      new Request(`${BASE}/api/work-items/${theirs.id}/ai/plan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'plan against your item' }),
      }),
      { params: Promise.resolve({ id: theirs.id }) },
    );
    expect(res.status).toBe(404);
    expect(submitJobMock).not.toHaveBeenCalled();
    expect(await db.plan.count()).toBe(0);
  });
});

// ───────────── The structural guard the coverage % cannot see ─────────────

describe('EXACTLY ONE proposal→tree write path — asserted structurally', () => {
  const ROOT = process.cwd();

  function collect(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...collect(full));
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  /** Source with block + line comments stripped: a prose mention is the RECORD
   *  of why the path died, an actual call is the regression. */
  function code(file: string): string {
    return readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/[^\n]*$/gm, '');
  }

  // Assembled from fragments rather than written as a literal, so this file does
  // not match its own guard — a self-match would have to be excused with an
  // exclusion, and an exclusion is exactly how a guard stops guarding.
  const DEAD_WRITE_PATH = new RegExp(
    ['approve' + 'Delta', 'approve' + 'PlanDelta', 'plan-delta' + '\\/approve'].join('|'),
  );

  it('no TEST drives the retired delta approve (MOTIR-1747)', () => {
    // `planChangeArchitecture` guards the app tree. The TEST tree needs its own
    // guard, and for the opposite reason: a test is exactly where a dead path
    // gets resurrected as a fixture and then quietly re-adopted as a contract.
    // (A wire-body fixture that merely CARRIES motir-ai's still-sent `planDelta`
    // key is fine — what may not come back is a call to the delta write path.)
    const offenders = collect(join(ROOT, 'tests'))
      .filter((file) => DEAD_WRITE_PATH.test(code(file)))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('the dead-path guard actually matches the dead path', () => {
    // Without this, a typo in the pattern above turns the scan into a no-op that
    // reports "clean" forever.
    // Same fragment trick as the pattern, for the same reason.
    expect(DEAD_WRITE_PATH.test(`await fetch('/api/ai/plan-delta` + `/approve')`)).toBe(true);
    expect(DEAD_WRITE_PATH.test('aiPlanEditsService.approve' + 'Delta(x)')).toBe(true);
    expect(DEAD_WRITE_PATH.test('approvePlanRequest(planId)')).toBe(false);
  });

  it('this suite itself confirms only through the shipped plans approve route', () => {
    // A guard on the guard: if this file ever materialized a plan by calling the
    // service directly, every "no write without approve" assertion above would
    // still pass while testing a path the product does not have.
    const self = code(
      join(ROOT, 'tests/integration/planning/contextualPlanningConfirmGate.test.ts'),
    );
    expect(self).not.toMatch(/plansService\.approvePlan\(/);
    expect(self).toMatch(/approvePlanRequest\(/);
  });

  it('the scan is not vacuous', () => {
    expect(collect(join(ROOT, 'tests')).length).toBeGreaterThan(100);
  });
});
