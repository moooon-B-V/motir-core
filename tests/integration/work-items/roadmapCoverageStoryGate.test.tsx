import { readFileSync } from 'node:fs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { workItemsService } from '@/lib/services/workItemsService';
import { plansService } from '@/lib/services/plansService';
import { planReviewService } from '@/lib/services/planReviewService';
import { buildWorkItemLevel } from '@/components/planning/workItemLevel';
import { mergePlanLevel, withProjectedCoverage } from '@/components/planning/planLevel';
import { isCrossLevelEdgeAdvisory } from '@/lib/dto/workItems';
import type { RoadmapLevelData } from '@/lib/planning/roadmapClient';
import type { ProjectRoadmapDto } from '@/lib/dto/workItems';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';
import {
  makeWorkItemFixture as makeFixture,
  createTestWorkItem as createWorkItem,
  type WorkItemFixture,
} from '../../fixtures';

// MOTIR-6373 — Story MOTIR-6352's motir-core gate. The units (MOTIR-6359,
// MOTIR-6362) feed hand-made DTOs; this drives the REAL roadmap read and the REAL
// plan-review read into the level builder, and checks that the canvas flags
// exactly the edges the validator calls invalid. Real Postgres, no mocked read.

async function truncateAll(): Promise<void> {
  await adminDb.$executeRawUnsafe(
    'TRUNCATE TABLE "work_item_revision", "work_item_link", "work_item" RESTART IDENTITY CASCADE',
  );
  await truncateAuthTables();
}
beforeEach(truncateAll);
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function link(fx: WorkItemFixture, blockedId: string, blockerId: string) {
  await adminDb.workItemLink.create({
    data: {
      fromId: blockedId,
      toId: blockerId,
      kind: 'is_blocked_by',
      workspaceId: fx.workspaceId,
      createdById: fx.ctx.userId,
    },
  });
}

/** The roadmap read's DTO in the client's `RoadmapLevelData` shape. */
function levelData(dto: ProjectRoadmapDto): RoadmapLevelData {
  return {
    items: dto.nodes.map((n) => ({
      id: n.id,
      parentId: n.parentId,
      identifier: n.identifier,
      title: n.title,
      kind: n.kind,
      status: n.status,
      hasChildren: n.hasChildren,
      progress: n.progress ?? null,
    })),
    edges: dto.edges,
    offLevelBlockers: dto.offLevelBlockers,
    levelMemberBlockers: dto.levelMemberBlockers,
  };
}

/** The `blocked blocker` id pairs a built level FLAGS — its `cross` deps. */
function flagged(level: ReturnType<typeof buildWorkItemLevel>): string[] {
  return level.deps.filter((d) => d.variant === 'cross').map((d) => `${d.to} ${d.from}`);
}

describe('Story MOTIR-6352 gate — the canvas flags exactly what the validator calls invalid', () => {
  it('AGREEMENT: over one epic subtree, flagged edges == invalidEdges ∪ cross-level edges', async () => {
    const fx = await makeFixture();
    const E1 = await createWorkItem(fx, { kind: 'epic', title: 'Checkout' });
    const E2 = await createWorkItem(fx, { kind: 'epic', title: 'Payments platform' });
    const A = await createWorkItem(fx, { kind: 'story', title: 'Cart', parentId: E1.id });
    const B = await createWorkItem(fx, { kind: 'story', title: 'Checkout flow', parentId: E1.id });
    const C = await createWorkItem(fx, { kind: 'story', title: 'Payments API', parentId: E2.id });
    const a1 = await createWorkItem(fx, { kind: 'subtask', title: 'a1', parentId: A.id });
    const a2 = await createWorkItem(fx, { kind: 'subtask', title: 'a2', parentId: A.id });
    const b1 = await createWorkItem(fx, { kind: 'subtask', title: 'b1', parentId: B.id });
    const b2 = await createWorkItem(fx, { kind: 'subtask', title: 'b2', parentId: B.id });
    const c1 = await createWorkItem(fx, { kind: 'subtask', title: 'c1', parentId: C.id });

    await link(fx, b1.id, a1.id); // UNCOVERED: B is not blocked_by A
    await link(fx, E1.id, E2.id); // the epics carry B → C …
    await link(fx, B.id, C.id); //   … so this story edge is COVERED
    await link(fx, b2.id, c1.id); // COVERED by B → C
    await link(fx, a2.id, C.id); //  CROSS-LEVEL (a subtask blocked by a story)

    // Every level of the E1 subtree, each built from the real roadmap read.
    const canvasFlags = new Set<string>();
    for (const parentId of [E1.id, A.id, B.id]) {
      const dto = await workItemsService.getProjectRoadmap(fx.projectId, parentId, fx.ctx);
      for (const pair of flagged(buildWorkItemLevel(levelData(dto)))) canvasFlags.add(pair);
    }

    const verdict = await workItemsService.validateWorkItem(fx.projectId, E1.identifier, fx.ctx);
    const idOf = new Map(
      [E1, E2, A, B, C, a1, a2, b1, b2, c1].map((w) => [w.identifier, w.id] as const),
    );
    const invalid = new Set([
      ...verdict.invalidEdges.map((e) => `${idOf.get(e.item)} ${idOf.get(e.blockedBy)}`),
      ...verdict.advisories
        .filter(isCrossLevelEdgeAdvisory)
        .map((a) => `${idOf.get(a.item)} ${idOf.get(a.blockedBy)}`),
    ]);

    expect([...canvasFlags].sort()).toEqual([...invalid].sort());
    // …and the set is the one the seed intends, so the equality is not vacuous.
    expect([...canvasFlags].sort()).toEqual([`${a2.id} ${C.id}`, `${b1.id} ${a1.id}`].sort());
  });

  it('ROADMAP READ → builder: the story level flags X until the stories carry the edge', async () => {
    const fx = await makeFixture();
    const E = await createWorkItem(fx, { kind: 'epic', title: 'E' });
    const A = await createWorkItem(fx, { kind: 'story', title: 'A', parentId: E.id });
    const B = await createWorkItem(fx, { kind: 'story', title: 'B', parentId: E.id });
    const Y = await createWorkItem(fx, { kind: 'subtask', title: 'Y', parentId: A.id });
    const X = await createWorkItem(fx, { kind: 'subtask', title: 'X', parentId: B.id });
    await link(fx, X.id, Y.id);

    const before = buildWorkItemLevel(
      levelData(await workItemsService.getProjectRoadmap(fx.projectId, B.id, fx.ctx)),
    );
    expect(flagged(before)).toEqual([`${X.id} ${Y.id}`]);

    await link(fx, B.id, A.id);
    const after = buildWorkItemLevel(
      levelData(await workItemsService.getProjectRoadmap(fx.projectId, B.id, fx.ctx)),
    );
    expect(flagged(after)).toEqual([]);
    expect(after.nodes.some((n) => n.id === Y.id)).toBe(false);
  });

  async function reviewLevel(fx: WorkItemFixture, planId: string, parentId: string) {
    const review = await planReviewService.getPlanReview(planId, fx.ctx);
    const dto = await workItemsService.getProjectRoadmap(fx.projectId, parentId, fx.ctx);
    const override = new Map(
      (review.edgeCoverage ?? []).map((e) => [`${e.blockedId} ${e.blockerId}`, e.coverage]),
    );
    const committed = buildWorkItemLevel(withProjectedCoverage(levelData(dto), override));
    return mergePlanLevel(committed, review.items, parentId);
  }

  it('PLAN PROJECTION → builder: a plan wiring the stories previews X unflagged', async () => {
    const fx = await makeFixture();
    const E = await createWorkItem(fx, { kind: 'epic', title: 'E' });
    const A = await createWorkItem(fx, { kind: 'story', title: 'A', parentId: E.id });
    const B = await createWorkItem(fx, { kind: 'story', title: 'B', parentId: E.id });
    const Y = await createWorkItem(fx, { kind: 'subtask', title: 'Y', parentId: A.id });
    const X = await createWorkItem(fx, { kind: 'subtask', title: 'X', parentId: B.id });
    await link(fx, X.id, Y.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Wire' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: B.id, patch: { blockedByAdd: [A.id] } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const level = await reviewLevel(fx, plan.id, B.id);
    expect(level.deps.filter((d) => d.variant === 'cross')).toEqual([]);
  });

  it('PLAN PROJECTION → builder: a plan removing the stories’ edge previews X flagged', async () => {
    const fx = await makeFixture();
    const E = await createWorkItem(fx, { kind: 'epic', title: 'E' });
    const A = await createWorkItem(fx, { kind: 'story', title: 'A', parentId: E.id });
    const B = await createWorkItem(fx, { kind: 'story', title: 'B', parentId: E.id });
    const Y = await createWorkItem(fx, { kind: 'subtask', title: 'Y', parentId: A.id });
    const X = await createWorkItem(fx, { kind: 'subtask', title: 'X', parentId: B.id });
    await link(fx, X.id, Y.id);
    await link(fx, B.id, A.id);

    const plan = await plansService.createPlan(fx.projectId, { title: 'Unwire' }, fx.ctx);
    await plansService.addProposals(
      plan.id,
      [{ op: 'modify', workItemId: B.id, patch: { blockedByRemove: [A.id] } }],
      fx.ctx,
    );
    await plansService.markPlanned(plan.id, fx.ctx);

    const level = await reviewLevel(fx, plan.id, B.id);
    expect(level.deps).toContainEqual({ from: Y.id, to: X.id, variant: 'cross' });
  });

  it('ARCHITECTURE: the builders compute no coverage; the reads import the shared rule', () => {
    const read = (p: string) => readFileSync(p, 'utf8');
    for (const builder of [
      'components/planning/workItemLevel.tsx',
      'components/planning/planLevel.tsx',
    ]) {
      const src = read(builder);
      expect(src).not.toMatch(/from '@\/lib\/workItems\/(crossParentCoverage|edgeLevel)'/);
      expect(src).not.toMatch(/import \{[^}]*edgeDisposition[^}]*\} from/);
    }
    expect(read('lib/services/workItemsService.ts')).toMatch(
      /import \{ edgeDisposition \} from '@\/lib\/workItems\/edgeDisposition'/,
    );
    expect(read('lib/services/planProjectionService.ts')).toMatch(
      /from '@\/lib\/workItems\/edgeDisposition'/,
    );
  });
});
