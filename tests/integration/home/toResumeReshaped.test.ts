import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import { dispatchRunService } from '@/lib/services/dispatchRunService';
import { homeService } from '@/lib/services/homeService';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// TO RESUME SHOWS THE STORY A RESUME WOULD CARRY (Bug MOTIR-8458; `design/workbench/
// design-notes.md` § 39), against a REAL Postgres and under RLS. A gated SCOPE run's entry
// lists the scope's live, not-done children — not only the cards whose own latest run is the
// gated run — marks the ones the run never touched as added, marks the touched ones a
// later-approved plan changed as re-scoped, and names each plan approved after the stop.

let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture({ identifier: 'RSH' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const hctx = () => ({ ...fx.ctx, projectId: fx.projectId });

async function card(
  title: string,
  extra: { parentId?: string; kind?: 'epic' | 'story' | 'subtask'; status?: string } = {},
): Promise<WorkItem> {
  const created = await workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: extra.kind ?? 'subtask',
      title,
      ...(extra.parentId ? { parentId: extra.parentId } : {}),
    },
    fx.ctx,
  );
  return adminDb.workItem.update({
    where: { id: created.id },
    data: { status: extra.status ?? 'in_progress', assigneeId: fx.ownerId },
  });
}

/** A story whose scope run touched `design` and `code`, then stopped `gated` at the design. */
async function gatedStory() {
  const story = await card('the story', { kind: 'story' });
  const design = await card('the design', { parentId: story.id });
  const code = await card('the code', { parentId: story.id });
  const { run } = await dispatchRunService.open(
    {
      projectKey: fx.projectIdentifier,
      command: 'run_scope',
      reportedBy: 'cli',
      scopeKey: story.identifier,
      cards: [design, code].map((c) => ({ key: c.identifier, disposition: 'queued' as const })),
    },
    fx.ctx,
  );
  await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: design.id,
      kind: 'design_result',
      subjectId: `ev-${design.id}`,
      state: 'awaiting',
    },
  });
  await dispatchRunService.close(run.id, { stopReason: 'gated' }, fx.ctx);
  const closed = await adminDb.dispatchRun.findUniqueOrThrow({ where: { id: run.id } });
  return { story, design, code, runId: run.id, endedAt: closed.endedAt! };
}

/** An approved plan, decided at `decidedAt`, carrying the given proposals. */
async function approvedPlan(
  title: string,
  decidedAt: Date,
  items: { op: 'add' | 'modify' | 'remove'; workItemId?: string; parentRef?: string }[],
) {
  const plan = await adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      status: 'approved',
      title,
      createdById: fx.ownerId,
      decidedAt,
      decidedById: fx.ownerId,
    },
  });
  for (const item of items) {
    await adminDb.planItem.create({
      data: {
        workspaceId: fx.workspaceId,
        planId: plan.id,
        op: item.op,
        workItemId: item.workItemId ?? null,
        parentRef: item.parentRef ?? null,
        blockedByRefs: [],
      },
    });
  }
  return plan;
}

const after = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000);

describe('a gated scope run, then a plan approved after it stopped', () => {
  it('lists the live children, marks the added and the re-scoped, and names the plan', async () => {
    const { story, design, code, endedAt } = await gatedStory();
    // The plan adds a child under the story and re-scopes the code card.
    const added = await card('added by the plan', { parentId: story.id, status: 'todo' });
    const plan = await approvedPlan('Second pass', after(endedAt, 5), [
      { op: 'add', parentRef: story.id, workItemId: added.id },
      { op: 'modify', workItemId: code.id },
    ]);

    const page = await homeService.listToResume(hctx());
    expect(page.total).toBe(1);
    const [entry] = page.items;
    expect(entry!.id).toBe(story.id);

    const members = new Map(entry!.resumeMembers.map((m) => [m.id, m.resumeChange]));
    expect([...members.keys()].sort()).toEqual([design.id, code.id, added.id].sort());
    expect(members.get(added.id)).toBe('added');
    expect(members.get(code.id)).toBe('rescoped');
    expect(members.get(design.id)).toBeNull();

    expect(entry!.resumeReshapedBy).toEqual([
      {
        planId: plan.id,
        title: 'Second pass',
        approvedAt: after(endedAt, 5).toISOString(),
        added: 1,
        changed: 1,
        removed: 0,
      },
    ]);
  });

  it('a plan approved BEFORE the stop re-shaped nothing the run did not already see', async () => {
    const { story, code, endedAt } = await gatedStory();
    await approvedPlan('Earlier pass', after(endedAt, -5), [{ op: 'modify', workItemId: code.id }]);

    const [entry] = (await homeService.listToResume(hctx())).items;
    expect(entry!.id).toBe(story.id);
    expect(entry!.resumeReshapedBy).toEqual([]);
    expect(entry!.resumeMembers.every((m) => m.resumeChange === null)).toBe(true);
  });

  it('a done child is not a member, and a child added without a plan still reads added', async () => {
    const { story, design, code, endedAt } = await gatedStory();
    await workItemsService.updateStatus(code.id, 'done', fx.ctx);
    const loose = await card('filed by hand', { parentId: story.id, status: 'todo' });

    const [entry] = (await homeService.listToResume(hctx())).items;
    const ids = entry!.resumeMembers.map((m) => m.id).sort();
    expect(ids).toEqual([design.id, loose.id].sort());
    expect(entry!.resumeMembers.find((m) => m.id === loose.id)!.resumeChange).toBe('added');
    expect(entry!.resumeReshapedBy).toEqual([]);

    // Two plans after the stop arrive oldest first; a remove counts on the banner only.
    const first = await approvedPlan('First', after(endedAt, 1), [
      { op: 'remove', workItemId: loose.id },
    ]);
    const second = await approvedPlan('Second', after(endedAt, 2), [
      { op: 'add', parentRef: story.id },
      { op: 'add', parentRef: story.id },
    ]);
    const [again] = (await homeService.listToResume(hctx())).items;
    expect(again!.resumeReshapedBy!.map((p) => [p.planId, p.added, p.changed, p.removed])).toEqual([
      [first.id, 0, 0, 1],
      [second.id, 2, 0, 0],
    ]);
  });
  it('over an epic, a story the run reached through its subtask is not added', async () => {
    const epic = await card('the epic', { kind: 'epic' });
    const story = await card('a reached story', { kind: 'story', parentId: epic.id });
    const leaf = await card('its subtask', { parentId: story.id });
    const fresh = await card('a story filed later', { kind: 'story', parentId: epic.id });
    const { run } = await dispatchRunService.open(
      {
        projectKey: fx.projectIdentifier,
        command: 'run_scope',
        reportedBy: 'cli',
        scopeKey: epic.identifier,
        cards: [{ key: leaf.identifier, disposition: 'queued' as const }],
      },
      fx.ctx,
    );
    await dispatchRunService.close(run.id, { stopReason: 'gated' }, fx.ctx);

    const [entry] = (await homeService.listToResume(hctx())).items;
    expect(entry!.id).toBe(epic.id);
    const change = new Map(entry!.resumeMembers.map((m) => [m.id, m.resumeChange]));
    expect(change.get(story.id)).toBeNull();
    expect(change.get(fresh.id)).toBe('added');
  });
});
