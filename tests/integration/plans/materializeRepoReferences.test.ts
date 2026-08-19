import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY the motir-ai boundary client — the `server-only` pre-plan read the
// repo-set derivation's secondary signal arrives over. Every project, plan, work
// item and set row below is real Postgres, per the repo's no-mocks convention.
vi.mock('@/lib/ai/motirAiClient', () => ({ getPreplanState: vi.fn() }));

import { db } from '@/lib/db';
import { getPreplanState } from '@/lib/ai/motirAiClient';
import { plansService } from '@/lib/services/plansService';
import { workItemsService } from '@/lib/services/workItemsService';
import { projectRepoSetService } from '@/lib/services/projectRepoSetService';
import { workItemRepoRepository } from '@/lib/repositories/workItemRepoRepository';
import type { ProposalInput } from '@/lib/dto/plans';
import type { RawPreplanStateResponse } from '@/lib/ai/types';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// `plansService.materialize` writes the repository REFERENCES it never wrote
// (Story MOTIR-2732 · MOTIR-3033, ADR `work-item-repository-set.md` "Amendment
// 2026-08-18" §A3 / §A6), over real Postgres.
//
// This is the path that creates MOST work items, and it builds its create-input
// by hand and calls the repository directly — bypassing `workItemsService`. That
// is why the repository set was never written here at all: two writers existed
// for one fact and only one of them was exercised by the work-item tests. So the
// whole point of this file is that it drives MATERIALIZE, never the service path.
//
// Four things only this path can answer:
//
//   1. A materialized leaf lands WITH its repository — through materialize.
//   2. A materialized STORY carries the union of its subtasks', in set order.
//   3. The container recompute runs ONCE PER CONTAINER, not once per child.
//   4. A `modify` that re-pins an existing leaf moves the leaf AND its ancestors.

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

async function plannedPlan(fx: WorkItemFixture, proposals: ProposalInput[]): Promise<string> {
  const plan = await plansService.createPlan(fx.projectId, { title: 'Build it' }, fx.ctx);
  await plansService.addProposals(plan.id, proposals, fx.ctx);
  await plansService.markPlanned(plan.id, fx.ctx);
  return plan.id;
}

async function itemsByTitle(fx: WorkItemFixture) {
  const rows = await adminDb.workItem.findMany({ where: { projectId: fx.projectId } });
  return new Map(rows.map((r) => [r.title, r]));
}

/** An item's stored references, in set order, as repository NAMES. */
async function repoNames(workItemId: string): Promise<string[]> {
  const rows = await adminDb.workItemRepo.findMany({
    where: { workItemId },
    orderBy: { position: 'asc' },
    include: { projectRepo: true },
  });
  return rows.map((r) => r.projectRepo.name);
}

describe('a materialized LEAF lands with its repository', () => {
  it('resolves a ROLE pin to a reference — the onboarding case', async () => {
    // The case §A3 changed. At generation the repositories DO NOT EXIST, so a
    // plan pins a ROLE; the rows are proposed BEFORE materialize now, so the card
    // can point at one from birth instead of carrying a role for a later pass.
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'The web app', kind: 'task', targetRepoRole: 'web' } },
      { op: 'add', proposedFields: { title: 'The API', kind: 'task', targetRepoRole: 'api' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    // The rows were proposed by the approve itself — a `web` + `api` plan.
    const set = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    expect(set.map((r) => r.role).sort()).toEqual(['api', 'web']);

    const items = await itemsByTitle(fx);
    const web = items.get('The web app')!;
    const api = items.get('The API')!;
    // …and each item points at the row for its own role.
    expect(await repoNames(web.id)).toEqual([set.find((r) => r.role === 'web')!.name]);
    expect(await repoNames(api.id)).toEqual([set.find((r) => r.role === 'api')!.name]);
  });

  it('leaves an UNPINNED proposal with no reference — unchanged, and not a guess', async () => {
    const fx = await makeWorkItemFixture();
    const planId = await plannedPlan(fx, [
      { op: 'add', proposedFields: { title: 'No repository', kind: 'task' } },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const items = await itemsByTitle(fx);
    expect(await repoNames(items.get('No repository')!.id)).toEqual([]);
  });
});

describe('a materialized CONTAINER carries the UNION of its children', () => {
  it('rolls two differently-pinned subtasks up onto their story', async () => {
    const fx = await makeWorkItemFixture();
    // The STORY is a real work item, so the subtasks can name it as a parent —
    // an intra-plan temp-ref needs the plan-item id, which only exists after the
    // proposals are appended. What matters here is that the LEAVES go through
    // MATERIALIZE, which is the path this card is about.
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Spans both' },
      fx.ctx,
    );
    const planId = await plannedPlan(fx, [
      {
        op: 'add',
        parentRef: story.id,
        proposedFields: { title: 'Web half', kind: 'subtask', targetRepoRole: 'web' },
      },
      {
        op: 'add',
        parentRef: story.id,
        proposedFields: { title: 'API half', kind: 'subtask', targetRepoRole: 'api' },
      },
    ]);

    await plansService.approvePlan(planId, fx.ctx);

    const set = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    const items = await itemsByTitle(fx);

    // The story derives BOTH — the state the completion gate was built for and
    // could never reach, because nothing put a second repository on a container.
    const expected = set.filter((r) => r.role === 'web' || r.role === 'api').map((r) => r.name);
    expect((await repoNames(story.id)).sort()).toEqual(expected.sort());
    // …and each leaf still carries exactly its own.
    expect(await repoNames(items.get('Web half')!.id)).toHaveLength(1);
    expect(await repoNames(items.get('API half')!.id)).toHaveLength(1);
  });

  it('derives each container ONCE, not once per child', async () => {
    // AC 5. A plan creates a whole tree in one transaction and a parent is
    // created BEFORE its children, so a per-insert recompute would be both
    // quadratic and wrong-order. Counted at the derivation itself.
    const spy = vi.spyOn(workItemRepoRepository, 'listDerivedRefsForContainer');
    try {
      const fx = await makeWorkItemFixture();
      const story = await workItemsService.createWorkItem(
        { projectId: fx.projectId, kind: 'story', title: 'One story' },
        fx.ctx,
      );
      const planId = await plannedPlan(fx, [
        {
          op: 'add',
          parentRef: story.id,
          proposedFields: { title: 'a', kind: 'subtask', targetRepoRole: 'web' },
        },
        {
          op: 'add',
          parentRef: story.id,
          proposedFields: { title: 'b', kind: 'subtask', targetRepoRole: 'web' },
        },
        {
          op: 'add',
          parentRef: story.id,
          proposedFields: { title: 'c', kind: 'subtask', targetRepoRole: 'api' },
        },
      ]);

      spy.mockClear();
      await plansService.approvePlan(planId, fx.ctx);

      const containers = new Set(spy.mock.calls.map((c) => c[0]));
      // THREE children under ONE story: the story is derived once, not three
      // times. (The story is the only container — the subtasks are leaves and a
      // leaf's set is authored, never derived.)
      expect(containers.size).toBe(1);
      expect(spy.mock.calls).toHaveLength(containers.size);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('a `modify` that RE-PINS moves the leaf and its ancestors', () => {
  it('moves the reference and the story’s union with it', async () => {
    const fx = await makeWorkItemFixture();
    const story = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Owner story' },
      fx.ctx,
    );
    const firstPlan = await plannedPlan(fx, [
      {
        op: 'add',
        parentRef: story.id,
        proposedFields: { title: 'Moves', kind: 'subtask', targetRepoRole: 'web' },
      },
    ]);
    await plansService.approvePlan(firstPlan, fx.ctx);

    const set = await projectRepoSetService.listByProject(fx.projectId, fx.ctx);
    const webName = set.find((r) => r.role === 'web')!.name;
    let items = await itemsByTitle(fx);
    const leaf = items.get('Moves')!;
    expect(await repoNames(leaf.id)).toEqual([webName]);
    expect(await repoNames(story.id)).toEqual([webName]);

    // A second row to move TO — added by hand, because this project's set is
    // already established and the proposer refuses to touch one that has rows.
    const other = await adminDb.projectRepo.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        role: 'infra',
        name: 'acme-infra',
        seedSource: 'blank',
        state: 'connected',
        position: 'zz',
      },
    });
    expect(other.id).toBeTruthy();

    const secondPlan = await plannedPlan(fx, [
      { op: 'modify', workItemId: leaf.id, patch: { targetRepo: 'acme-infra' } },
    ]);
    await plansService.approvePlan(secondPlan, fx.ctx);

    items = await itemsByTitle(fx);
    // The LEAF moved…
    expect(await repoNames(leaf.id)).toEqual(['acme-infra']);
    // …and the story's union moved with it, in the same transaction.
    expect(await repoNames(story.id)).toEqual(['acme-infra']);
  });
});
