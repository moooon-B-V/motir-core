import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { workItemsService } from '@/lib/services/workItemsService';
import { foldersService } from '@/lib/services/foldersService';
import { folderRepository } from '@/lib/repositories/folderRepository';
import { runGetPlan } from '@/lib/mcp/tools/getPlan';
import { presentPlan, planTargetKeyResolver } from '@/lib/api/v1/workLoop/schema';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// A plan READS its folder placements (Story MOTIR-5310 · Subtask MOTIR-5415).
// Real Postgres, per CLAUDE.md. The append (MOTIR-5414) stores `folder:<id>`
// verbatim in `parentRef` / `patch.parentRef`; this suite pins what the READ
// side makes of it — the review model the canvas renders
// (`design/ai-planning/design-notes.md` Part XVII §17.8), `get_plan`'s text and
// structured payload, and the `/api/v1` plan proposal.

beforeEach(async () => {
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "folder" RESTART IDENTITY CASCADE');
  await truncateAuthTables();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function seed(
  fx: WorkItemFixture,
  kind: 'epic' | 'story' | 'task',
  title: string,
  parentId?: string,
): Promise<{ id: string; identifier: string }> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...(parentId ? { parentId } : {}) },
    fx.ctx,
  );
  return { id: dto.id, identifier: dto.identifier };
}

/** Parked ▸ 2025, the path the design draws. */
async function parkedTree(fx: WorkItemFixture): Promise<{ parked: string; y2025: string }> {
  const parked = await foldersService.createFolder(
    { projectId: fx.projectId, parentFolderId: null, name: 'Parked' },
    fx.ctx,
  );
  const y2025 = await foldersService.createFolder(
    { projectId: fx.projectId, parentFolderId: parked.id, name: '2025' },
    fx.ctx,
  );
  return { parked: parked.id, y2025: y2025.id };
}

/** The card's AC fixture: an `add` in Parked ▸ 2025, a `modify` filing a
 *  committed story into Parked, and an `add` under an epic. */
async function mixedPlan(fx: WorkItemFixture) {
  const { parked, y2025 } = await parkedTree(fx);
  const epic = await seed(fx, 'epic', 'Payments');
  const story = await seed(fx, 'story', 'Old refunds flow', epic.id);
  const plan = await plansService.createPlan(fx.projectId, { title: 'Tidy' }, fx.ctx);
  await plansService.addProposals(
    plan.id,
    [
      {
        op: 'add',
        proposedFields: { title: 'Idea for later', kind: 'story' },
        parentRef: `folder:${y2025}`,
      },
      { op: 'modify', workItemId: story.id, patch: { parentRef: `folder:${parked}` } },
      { op: 'add', proposedFields: { title: 'Card payouts', kind: 'story' }, parentRef: epic.id },
    ],
    fx.ctx,
  );
  return { plan, parked, y2025, epic, story };
}

describe('planReviewService.getPlanReview — folder placements', () => {
  it('reads a folder path for a filed add, both typed sides for a filing modify, and leaves a work-item placement alone', async () => {
    const fx = await makeWorkItemFixture();
    const { plan, parked, y2025, epic } = await mixedPlan(fx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const [filedAdd, filingModify, underEpic] = review.items;

    // The filed add: a ROOT on the canvas, filed in Parked ▸ 2025.
    expect(filedAdd).toMatchObject({
      folderId: y2025,
      folderPath: ['Parked', '2025'],
      folderMissing: false,
      parentNodeId: null,
      parentIdentifier: null,
      parentTrail: [],
    });

    // The modify: it arrives at the folder, and its placement row is TYPED on
    // both sides — the epic it leaves, the folder it joins — and LEADS the list.
    expect(filingModify).toMatchObject({
      folderId: parked,
      folderPath: ['Parked'],
      folderMissing: false,
      parentNodeId: null,
    });
    expect(filingModify!.changes[0]).toEqual({
      field: 'parent',
      from: epic.identifier,
      to: 'Parked',
      placement: {
        from: { kind: 'workItem', id: epic.id, identifier: epic.identifier },
        to: { kind: 'folder', folderId: parked, folderPath: ['Parked'], folderMissing: false },
      },
    });

    // The add under an epic is exactly the work-item placement it always was.
    expect(underEpic).toMatchObject({
      folderId: null,
      folderPath: null,
      folderMissing: false,
      parentNodeId: epic.id,
      parentIdentifier: epic.identifier,
    });
  });

  it('marks ONLY the proposal whose folder was deleted after the append as folderMissing', async () => {
    const fx = await makeWorkItemFixture();
    const { plan, parked, y2025 } = await mixedPlan(fx);

    await foldersService.deleteFolder({ projectId: fx.projectId, folderId: y2025 }, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const [filedAdd, filingModify, underEpic] = review.items;
    expect(filedAdd).toMatchObject({ folderId: y2025, folderPath: null, folderMissing: true });
    expect(filingModify).toMatchObject({
      folderId: parked,
      folderPath: ['Parked'],
      folderMissing: false,
    });
    expect(underEpic).toMatchObject({ folderId: null, folderMissing: false });
  });

  it('resolves every folder path in ONE read, however many proposals are folder-placed', async () => {
    const fx = await makeWorkItemFixture();
    const { parked, y2025 } = await parkedTree(fx);
    const plan = await plansService.createPlan(fx.projectId, { title: 'Many' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      Array.from({ length: 6 }, (_, i) => ({
        op: 'add' as const,
        proposedFields: { title: `Idea ${i}`, kind: 'story' as const },
        parentRef: `folder:${i % 2 === 0 ? parked : y2025}`,
      })),
      fx.ctx,
    );

    // MOTIR-5798 moved the review onto the id-carrying twin: the ONE-read
    // guarantee is restated against it, and the names-only read is not called.
    const batched = vi.spyOn(folderRepository, 'findTrailsByIds');
    const namesOnly = vi.spyOn(folderRepository, 'findPathsByIds');
    const single = vi.spyOn(folderRepository, 'findPathNames');
    try {
      const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
      expect(review.items.map((i) => i.folderPath)).toEqual([
        ['Parked'],
        ['Parked', '2025'],
        ['Parked'],
        ['Parked', '2025'],
        ['Parked'],
        ['Parked', '2025'],
      ]);
      expect(batched).toHaveBeenCalledTimes(1);
      expect(namesOnly).not.toHaveBeenCalled();
      expect(single).not.toHaveBeenCalled();
    } finally {
      batched.mockRestore();
      namesOnly.mockRestore();
      single.mockRestore();
    }
  });

  it('types a move OUT of a folder — the filed target’s folder on the old side — and places a modify that does not move it in its folder', async () => {
    const fx = await makeWorkItemFixture();
    const { parked } = await parkedTree(fx);
    const epic = await seed(fx, 'epic', 'Payments');
    const moving = await seed(fx, 'story', 'Filed story that moves');
    const staying = await seed(fx, 'story', 'Filed story that stays');
    await foldersService.fileWorkItem(moving.id, { folderId: parked }, fx.ctx);
    await foldersService.fileWorkItem(staying.id, { folderId: parked }, fx.ctx);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Unfile' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'modify',
          workItemId: moving.id,
          patch: { title: 'Story, now under payments', parentRef: epic.id },
        },
        { op: 'modify', workItemId: staying.id, patch: { title: 'Renamed in place' } },
      ],
      fx.ctx,
    );

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const [out, inPlace] = review.items;

    expect(out).toMatchObject({ folderId: null, folderPath: null, parentNodeId: epic.id });
    // The folder side LEADS, ahead of the title change pushed before it.
    // ⚠️ The resting-status row is dropped: a plan PARKS its committed targets, so
    // every `modify` now carries `status → To Do or Blocked (returned when this
    // plan is approved)` in addition to the fields the patch touched
    // (MOTIR-5646). This case is about those other fields, and its exact-set
    // assertion is the point.
    expect(out!.changes.map((c) => c.field).filter((f) => f !== 'status')).toEqual([
      'parent',
      'title',
    ]);
    expect(out!.changes[0]!.placement).toEqual({
      from: { kind: 'folder', folderId: parked, folderPath: ['Parked'], folderMissing: false },
      to: { kind: 'workItem', id: epic.id, identifier: epic.identifier },
    });
    expect(out!.changes[0]!.from).toBe('Parked');

    // Not moved: it sits in its target's folder, and no placement row appears.
    expect(inPlace).toMatchObject({ folderId: parked, folderPath: ['Parked'], parentNodeId: null });
    // The resting-status row is dropped — see the note above (MOTIR-5646).
    expect(inPlace!.changes.map((c) => c.field).filter((f) => f !== 'status')).toEqual(['title']);
  });

  it('keeps a work-item → work-item re-parent row exactly as before, typed but not reordered', async () => {
    const fx = await makeWorkItemFixture();
    const from = await seed(fx, 'epic', 'From epic');
    const to = await seed(fx, 'epic', 'To epic');
    const card = await seed(fx, 'story', 'Card', from.id);
    const plan = await plansService.createPlan(fx.projectId, { title: 'Move' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: card.id, patch: { title: 'Card moved', parentRef: to.id } }],
      fx.ctx,
    );

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const item = review.items[0]!;
    // ⚠️ The resting-status row is dropped: a plan PARKS its committed targets, so
    // every `modify` now carries `status → To Do or Blocked (returned when this
    // plan is approved)` in addition to the fields the patch touched
    // (MOTIR-5646). This case is about those other fields, and its exact-set
    // assertion is the point.
    expect(item.changes.map((c) => c.field).filter((f) => f !== 'status')).toEqual([
      'title',
      'parent',
    ]);
    expect(item.changes[1]).toMatchObject({ from: from.identifier, to: to.identifier });
    expect(item.folderId).toBeNull();
  });
});

describe('get_plan and the /api/v1 plan proposal — folder placements', () => {
  it('groups folder-placed proposals under a Folder heading, and carries folderId + folderPath in the structured payload', async () => {
    const fx = await makeWorkItemFixture();
    const { plan, parked, y2025 } = await mixedPlan(fx);

    const result = await runGetPlan({ planId: plan.id }, fx.ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Folder: Parked ▸ 2025:');
    expect(text).toContain('Folder: Parked:');
    const heading = text.indexOf('Folder: Parked ▸ 2025:');
    expect(text.indexOf('Idea for later')).toBeGreaterThan(heading);

    const items = (result.structuredContent as { items: Record<string, unknown>[] }).items;
    expect(items.map((i) => [i['folderId'], i['folderPath']])).toEqual([
      [y2025, ['Parked', '2025']],
      [parked, ['Parked']],
      [null, null],
    ]);
  });

  it('marks a deleted folder in get_plan’s text', async () => {
    const fx = await makeWorkItemFixture();
    const { plan, y2025 } = await mixedPlan(fx);
    await foldersService.deleteFolder({ projectId: fx.projectId, folderId: y2025 }, fx.ctx);

    const result = await runGetPlan({ planId: plan.id }, fx.ctx);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(`Folder: (deleted — folder:${y2025})`);
    const items = (result.structuredContent as { items: Record<string, unknown>[] }).items;
    expect(items[0]).toMatchObject({ folderId: y2025, folderPath: null });
  });

  it('presents folderId + folderPath on a v1 PlanProposal, with no parentKey for a folder ref', async () => {
    const fx = await makeWorkItemFixture();
    const { plan, parked, y2025, epic } = await mixedPlan(fx);
    const withItems = await plansService.getPlan(plan.id, fx.ctx);
    const folders = await planReviewService.resolveProposalFolders(withItems, fx.ctx);

    const v1 = presentPlan(
      withItems,
      planTargetKeyResolver({ [epic.id]: { accessible: true, identifier: epic.identifier } }),
      folders,
    );
    expect(
      v1.proposals.map((p) => ({
        folderId: p.folderId,
        folderPath: p.folderPath,
        parentKey: p.parentKey,
      })),
    ).toEqual([
      { folderId: y2025, folderPath: ['Parked', '2025'], parentKey: null },
      { folderId: parked, folderPath: ['Parked'], parentKey: null },
      { folderId: null, folderPath: null, parentKey: epic.identifier },
    ]);
  });
});

// ── The FOLDER TRAIL (Bug MOTIR-5782 · MOTIR-5798; design Part XVIII §18.7) ──
// The planning canvases draw a folder as a LEVEL, so the review read carries each
// proposal's folder chain WITH IDS — root first — for its own folder, else its
// root-most committed ancestor's, else its root-most proposed ancestor's.
describe('planReviewService.getPlanReview — folderTrail', () => {
  it('carries the chain for a filed add, a modify moving into a folder, an add under a filed committed epic, and an add under a filed PROPOSED story', async () => {
    const fx = await makeWorkItemFixture();
    const { parked, y2025 } = await parkedTree(fx);
    const filedEpic = await seed(fx, 'epic', 'Parked epic');
    const storyUnderFiledEpic = await seed(fx, 'story', 'Story under a filed epic', filedEpic.id);
    await foldersService.fileWorkItem(filedEpic.id, { folderId: parked }, fx.ctx);
    const loose = await seed(fx, 'story', 'Loose story');

    const plan = await plansService.createPlan(fx.projectId, { title: 'Trails' }, fx.ctx);
    const first = await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Filed story', kind: 'story' },
          parentRef: `folder:${y2025}`,
        },
        { op: 'modify', workItemId: loose.id, patch: { parentRef: `folder:${parked}` } },
        {
          op: 'add',
          proposedFields: { title: 'Subtask under a filed epic’s story', kind: 'subtask' },
          parentRef: storyUnderFiledEpic.id,
        },
        { op: 'add', proposedFields: { title: 'Unfiled root', kind: 'task' } },
      ],
      fx.ctx,
    );
    const filedStoryRef = `planItem:${first.items[0]!.id}`;
    await plansService.addProposals(
      plan.id,
      [
        {
          op: 'add',
          proposedFields: { title: 'Subtask under the proposed filed story', kind: 'subtask' },
          parentRef: filedStoryRef,
        },
      ],
      fx.ctx,
    );

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    const [filedAdd, movingIn, underFiledEpic, unfiled, underProposed] = review.items;
    const both = [
      { id: parked, name: 'Parked' },
      { id: y2025, name: '2025' },
    ];

    expect(filedAdd!.folderTrail).toEqual(both);
    expect(movingIn!.folderTrail).toEqual([{ id: parked, name: 'Parked' }]);
    expect(underFiledEpic!.folderTrail).toEqual([{ id: parked, name: 'Parked' }]);
    expect(unfiled!.folderTrail).toEqual([]);
    expect(underProposed!.folderTrail).toEqual(both);

    // The names ARE the path for every folder-placed proposal — one read, one source.
    for (const item of review.items.filter((i) => i.folderId !== null)) {
      expect(item.folderTrail.map((t) => t.name)).toEqual(item.folderPath);
    }
  });

  it('reads [] for a proposal whose folder was deleted — there is no chain left to walk', async () => {
    const fx = await makeWorkItemFixture();
    const { plan, y2025 } = await mixedPlan(fx);
    await foldersService.deleteFolder({ projectId: fx.projectId, folderId: y2025 }, fx.ctx);

    const review = await planReviewService.getPlanReview(plan.id, fx.ctx);
    expect(review.items[0]).toMatchObject({ folderMissing: true, folderTrail: [] });
  });

  it('does not grow its folder reads with the size of the plan — the same count for 1 and 10 filed proposals', async () => {
    const fx = await makeWorkItemFixture();
    const { parked, y2025 } = await parkedTree(fx);
    const filedEpic = await seed(fx, 'epic', 'Parked epic');
    await foldersService.fileWorkItem(filedEpic.id, { folderId: y2025 }, fx.ctx);

    const readsFor = async (n: number): Promise<number> => {
      const plan = await plansService.createPlan(fx.projectId, { title: `Plan ${n}` }, fx.ctx);
      await plansService.addProposals(
        plan.id,
        Array.from({ length: n }, (_, i) =>
          i % 2 === 0
            ? {
                op: 'add' as const,
                proposedFields: { title: `Filed ${i}`, kind: 'story' as const },
                parentRef: `folder:${parked}`,
              }
            : {
                op: 'add' as const,
                proposedFields: { title: `Under the filed epic ${i}`, kind: 'story' as const },
                parentRef: filedEpic.id,
              },
        ),
        fx.ctx,
      );
      const spy = vi.spyOn(folderRepository, 'findTrailsByIds');
      try {
        await planReviewService.getPlanReview(plan.id, fx.ctx);
        return spy.mock.calls.length;
      } finally {
        spy.mockRestore();
      }
    };

    const one = await readsFor(1);
    const ten = await readsFor(10);
    expect(ten).toBe(await readsFor(2));
    expect(one).toBeLessThanOrEqual(2);
    expect(ten).toBeLessThanOrEqual(2);
  });
});

describe('folderRepository.findTrailsByIds', () => {
  it('returns root-first id + name trails for many folders in one read, and nothing for a deleted one', async () => {
    const fx = await makeWorkItemFixture();
    const { parked, y2025 } = await parkedTree(fx);
    const gone = await foldersService.createFolder(
      { projectId: fx.projectId, parentFolderId: null, name: 'Gone' },
      fx.ctx,
    );
    await foldersService.deleteFolder({ projectId: fx.projectId, folderId: gone.id }, fx.ctx);

    const rows = await adminDb.$transaction((tx) =>
      folderRepository.findTrailsByIds([y2025, parked, gone.id], fx.workspaceId, tx),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(y2025)).toEqual({
      id: y2025,
      projectId: fx.projectId,
      trail: [
        { id: parked, name: 'Parked' },
        { id: y2025, name: '2025' },
      ],
    });
    expect(byId.get(parked)!.trail).toEqual([{ id: parked, name: 'Parked' }]);
    expect(byId.has(gone.id)).toBe(false);
  });
});
