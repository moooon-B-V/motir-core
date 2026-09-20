import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY the motir-ai boundary client — the pre-plan read the repository-set
// derivation's secondary signal arrives over. Every project, folder, plan and
// work item below is real Postgres, per the repo's no-mocks convention.
vi.mock('@/lib/ai/motirAiClient', () => ({ getPreplanState: vi.fn() }));

import { db } from '@/lib/db';
import { getPreplanState } from '@/lib/ai/motirAiClient';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { foldersService } from '@/lib/services/foldersService';
import { TEMP_REF_PREFIX } from '@/lib/plans/refs';
import { PlanRefGraphError } from '@/lib/plans/errors';
import type { ProposalInput } from '@/lib/dto/plans';
import type { RawPreplanStateResponse } from '@/lib/ai/types';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { contentRevisions } from '../../helpers/planTargetRevisions';
import { truncateAuthTables } from '../../helpers/db';

// Approve MATERIALIZES folder placements (Story MOTIR-5310 · MOTIR-5423).
//
// MOTIR-5414 lets a proposal name `folder:<id>` where a parent goes. These are the
// checks the APPROVE owes it: an `add` born filed, a `modify` that files or
// unfiles a committed card — writing BOTH placement columns, because
// `work_item_parent_xor_folder` admits one or the other — and a folder deleted
// between the append and the approve refusing the whole approve by a typed error.

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

beforeEach(async () => {
  await truncateAuthTables();
  vi.mocked(getPreplanState).mockResolvedValue({
    session: null,
    docs: [],
    catalog: null,
  } as RawPreplanStateResponse);
});

async function makeFolder(fx: WorkItemFixture, name: string): Promise<string> {
  const folder = await foldersService.createFolder(
    { projectId: fx.projectId, parentFolderId: null, name },
    fx.ctx,
  );
  return folder.id;
}

async function seed(
  fx: WorkItemFixture,
  title: string,
  kind: 'epic' | 'story' | 'task' | 'subtask',
  placement: { parentId?: string; folderId?: string } = {},
): Promise<string> {
  const dto = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind, title, ...placement },
    fx.ctx,
  );
  return dto.id;
}

async function openPlan(fx: WorkItemFixture): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'File it' }, fx.ctx);
  return plan.id;
}

async function approveOne(fx: WorkItemFixture, proposals: ProposalInput[]): Promise<void> {
  const planId = await openPlan(fx);
  await plansService.addProposals(planId, proposals, fx.ctx);
  await plansService.markPlanned(planId, fx.ctx);
  await plansService.approvePlan(planId, fx.ctx);
}

async function row(id: string) {
  return adminDb.workItem.findUniqueOrThrow({ where: { id } });
}

async function byTitle(fx: WorkItemFixture, title: string) {
  return adminDb.workItem.findFirstOrThrow({ where: { projectId: fx.projectId, title } });
}

/** CONTENT revisions only — a plan parks its target at `planning` and rests it
 *  afterwards, so two pure status moves now sit either side of the modify's own
 *  entry (MOTIR-5646). What these cases measure is the modify landing as ONE
 *  entry, which is unchanged. */
async function updatedRevisions(workItemId: string) {
  return contentRevisions(workItemId);
}

async function repoNames(workItemId: string): Promise<string[]> {
  const rows = await adminDb.workItemRepo.findMany({
    where: { workItemId },
    orderBy: { position: 'asc' },
    include: { projectRepo: true },
  });
  return rows.map((r) => r.projectRepo.name);
}

describe('an `add` placed `folder:<id>` is created FILED', () => {
  it('files the epic at the folder level’s last position, and its `planItem:` child hangs under it', async () => {
    const fx = await makeWorkItemFixture();
    const parked = await makeFolder(fx, 'Parked');
    // Something already filed there, so "last position" is a real comparison.
    const earlier = await seed(fx, 'Already parked', 'epic', { folderId: parked });

    const planId = await openPlan(fx);
    const first = await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'Filed epic', kind: 'epic' },
          parentRef: `folder:${parked}`,
        },
      ],
      fx.ctx,
    );
    const epicItem = first.items.find((i) => i.proposedFields?.title === 'Filed epic')!;
    await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'Its story', kind: 'story' },
          parentRef: `${TEMP_REF_PREFIX}${epicItem.id}`,
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);

    const epic = await byTitle(fx, 'Filed epic');
    expect(epic.folderId).toBe(parked);
    expect(epic.parentId).toBeNull();
    expect(epic.position > (await row(earlier)).position).toBe(true);

    const story = await byTitle(fx, 'Its story');
    expect(story.parentId).toBe(epic.id);
    expect(story.folderId).toBeNull();

    const created = await adminDb.workItemRevision.findFirstOrThrow({
      where: { workItemId: epic.id, changeKind: 'created' },
    });
    expect((created.diff as Record<string, unknown>).folderId).toEqual({ from: null, to: parked });
  });

  it('admits a filed SUBTASK — a folder is a legal root for any kind', async () => {
    const fx = await makeWorkItemFixture();
    const parked = await makeFolder(fx, 'Parked');

    await approveOne(fx, [
      {
        op: 'add',
        proposedFields: { title: 'Filed subtask', kind: 'subtask' },
        parentRef: `folder:${parked}`,
      },
    ]);

    const subtask = await byTitle(fx, 'Filed subtask');
    expect(subtask.folderId).toBe(parked);
    expect(subtask.parentId).toBeNull();
  });
});

describe('a `modify` re-parent writes BOTH placement columns', () => {
  it('moving a FILED story under an epic clears its folder (the CHECK this used to trip)', async () => {
    const fx = await makeWorkItemFixture();
    const parked = await makeFolder(fx, 'Parked');
    const epic = await seed(fx, 'The epic', 'epic');
    const story = await seed(fx, 'The filed story', 'story', { folderId: parked });

    await approveOne(fx, [{ op: 'modify', workItemId: story, patch: { parentRef: epic } }]);

    const after = await row(story);
    expect(after.parentId).toBe(epic);
    expect(after.folderId).toBeNull();
    const revisions = await updatedRevisions(story);
    expect(revisions).toHaveLength(1);
    const diff = revisions[0]!.diff as Record<string, unknown>;
    expect(diff.parentId).toEqual({ from: null, to: epic });
    expect(diff.folderId).toEqual({ from: parked, to: null });
  });

  it('`folder:<id>` files a committed story out of its epic, and recomputes the epic it left', async () => {
    const fx = await makeWorkItemFixture();
    const parked = await makeFolder(fx, 'Parked');

    // An epic whose derived repository set comes ONLY from the story — so the
    // rollup on the parent the story leaves is observable as that set emptying.
    const planId = await openPlan(fx);
    const first = await plansService.addProposals(
      planId,
      [{ op: 'add', proposedFields: { title: 'The epic', kind: 'epic' } }],
      fx.ctx,
    );
    const epicItem = first.items.find((i) => i.proposedFields?.title === 'The epic')!;
    await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'The story', kind: 'story', targetRepoRole: 'web' },
          parentRef: `${TEMP_REF_PREFIX}${epicItem.id}`,
        },
      ],
      fx.ctx,
    );
    await plansService.markPlanned(planId, fx.ctx);
    await plansService.approvePlan(planId, fx.ctx);
    const epic = await byTitle(fx, 'The epic');
    const story = await byTitle(fx, 'The story');
    expect(await repoNames(epic.id)).toHaveLength(1);

    await approveOne(fx, [
      { op: 'modify', workItemId: story.id, patch: { parentRef: `folder:${parked}` } },
    ]);

    const after = await row(story.id);
    expect(after.folderId).toBe(parked);
    expect(after.parentId).toBeNull();
    const diff = (await updatedRevisions(story.id)).at(-1)!.diff as Record<string, unknown>;
    expect(diff.folderId).toEqual({ from: null, to: parked });
    expect(diff.parentId).toEqual({ from: epic.id, to: null });
    expect(await repoNames(epic.id)).toEqual([]);
  });

  it('moves a filed story from one folder to another, appended at the new folder’s level', async () => {
    const fx = await makeWorkItemFixture();
    const parked = await makeFolder(fx, 'Parked');
    const archive = await makeFolder(fx, 'Archive');
    const resident = await seed(fx, 'Already archived', 'story', { folderId: archive });
    const story = await seed(fx, 'The story', 'story', { folderId: parked });

    await approveOne(fx, [
      { op: 'modify', workItemId: story, patch: { parentRef: `folder:${archive}` } },
    ]);

    const after = await row(story);
    expect(after.folderId).toBe(archive);
    expect(after.position > (await row(resident)).position).toBe(true);
  });

  it('`null` on a filed item takes it to the project ROOT — both columns null', async () => {
    const fx = await makeWorkItemFixture();
    const parked = await makeFolder(fx, 'Parked');
    const story = await seed(fx, 'The filed story', 'story', { folderId: parked });

    await approveOne(fx, [{ op: 'modify', workItemId: story, patch: { parentRef: null } }]);

    const after = await row(story);
    expect(after.folderId).toBeNull();
    expect(after.parentId).toBeNull();
    const diff = (await updatedRevisions(story))[0]!.diff as Record<string, unknown>;
    expect(diff.folderId).toEqual({ from: parked, to: null });
    expect(diff.parentId).toBeUndefined();
  });

  it('filing an item already in that folder writes nothing', async () => {
    const fx = await makeWorkItemFixture();
    const parked = await makeFolder(fx, 'Parked');
    const story = await seed(fx, 'The filed story', 'story', { folderId: parked });
    const before = await row(story);

    await approveOne(fx, [
      { op: 'modify', workItemId: story, patch: { parentRef: `folder:${parked}` } },
    ]);

    const after = await row(story);
    expect(after.folderId).toBe(parked);
    expect(after.position).toBe(before.position);
  });
});

describe('a folder DELETED since the append refuses the whole approve', () => {
  it('throws the typed refusal naming the folder and the proposal; nothing materializes and the plan stays planned', async () => {
    const fx = await makeWorkItemFixture();
    const parked = await makeFolder(fx, 'Parked');
    const committed = await seed(fx, 'A committed story', 'story');

    const planId = await openPlan(fx);
    const appended = await plansService.addProposals(
      planId,
      [
        {
          op: 'add',
          proposedFields: { title: 'Would be filed', kind: 'epic' },
          parentRef: `folder:${parked}`,
        },
        { op: 'add', proposedFields: { title: 'An unrelated add', kind: 'task' } },
        { op: 'modify', workItemId: committed, patch: { title: 'Renamed by the plan' } },
      ],
      fx.ctx,
    );
    const filedItem = appended.items.find((i) => i.proposedFields?.title === 'Would be filed')!;
    await plansService.markPlanned(planId, fx.ctx);

    await foldersService.deleteFolder({ projectId: fx.projectId, folderId: parked }, fx.ctx);

    let thrown: unknown;
    try {
      await plansService.approvePlan(planId, fx.ctx);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PlanRefGraphError);
    const refusal = thrown as PlanRefGraphError;
    expect(refusal.code).toBe('INVALID_PLAN_REF_GRAPH');
    expect(refusal.reason).toBe('dangling');
    expect(refusal.planItemId).toBe(filedItem.id);
    expect(refusal.message).toContain(`folder:${parked}`);
    // The PROPOSAL is named by its id — the folder's name went with its row.
    expect(refusal.message).toContain(filedItem.id);

    expect(
      await adminDb.workItem.count({
        where: { projectId: fx.projectId, title: { in: ['Would be filed', 'An unrelated add'] } },
      }),
    ).toBe(0);
    expect((await row(committed)).title).toBe('A committed story');
    const plan = await adminDb.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.status).toBe('planned');
  });
});
