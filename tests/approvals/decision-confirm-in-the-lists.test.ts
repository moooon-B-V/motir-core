import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { DECIDED_WITHOUT_A_READER } from '@/lib/approvalGates/stamp';
import { approvalGatesService } from '@/lib/services/approvalGatesService';
import { workItemsService } from '@/lib/services/workItemsService';
import { workspacesService } from '@/lib/services/workspacesService';
import type { HomeActorContext } from '@/lib/services/homeService';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures';
import { createTestUser } from '../fixtures/userFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// A DECISION TO CONFIRM IN THE LISTS (Story MOTIR-5871 · Subtask MOTIR-5961), on real
// Postgres. Routing is unchanged for the sixth kind: the question reaches exactly ONE
// person's To-approve tab — `assigneeId ?? reporterId` — and once it is confirmed or
// overturned it leaves that tab and reads DECIDED in the Approvals room, with its state.

let fx: WorkItemFixture;
let meCtx: HomeActorContext;
let otherCtx: HomeActorContext;

beforeEach(async () => {
  await truncateAuthTables();
  await adminDb.$executeRawUnsafe('TRUNCATE TABLE "approval_gate" RESTART IDENTITY CASCADE');
  fx = await makeWorkItemFixture();
  meCtx = { ...fx.ctx, projectId: fx.projectId };
  const other = await createTestUser({ email: 'other@ex.com', name: 'Other' });
  await workspacesService.addMember({ userId: other.id, workspaceId: fx.workspaceId });
  otherCtx = { userId: other.id, workspaceId: fx.workspaceId, projectId: fx.projectId };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const BODY = [
  '## Decision',
  'Exports move to managed object storage.',
  '## What changed',
  '**Change:** less requirement',
  'Before and after.',
  '## Supersedes',
  'MOTIR-6 and MOTIR-7',
  '## Resulting direction',
  'Every export is written to the bucket.',
].join('\n');

async function waitingDecision(title: string) {
  return workItemsService.createWorkItem(
    {
      projectId: fx.projectId,
      kind: 'task',
      title,
      type: 'decision',
      executor: 'human',
      assigneeId: fx.ownerId,
      descriptionMd: BODY,
    },
    fx.ctx,
  );
}

describe('the confirm gate in To approve and the Approvals room', () => {
  it('reaches its routed person only, and moves to the room’s decided section once decided', async () => {
    const confirmed = await waitingDecision('Confirm me');
    const overturned = await waitingDecision('Overturn me');

    const mine = await approvalGatesService.listAwaitingMe(meCtx);
    expect(mine.items.map((row) => row.kind)).toEqual([
      'decision_confirmation',
      'decision_confirmation',
    ]);
    expect(mine.items[0]!.subject).toEqual({
      kind: 'decision_confirmation',
      decision: 'Exports move to managed object storage.',
      changes: ['less_requirement'],
      supersedesCount: 2,
    });
    // Not routed to anybody else in the workspace.
    expect((await approvalGatesService.listAwaitingMe(otherCtx)).total).toBe(0);

    for (const [item, decision] of [
      [confirmed, 'approve'],
      [overturned, 'overturn'],
    ] as const) {
      const read = await approvalGatesService.getForWorkItem(
        { workItemId: item.id, kind: 'decision_confirmation' },
        fx.ctx,
      );
      await approvalGatesService.decide(
        {
          gateId: read.gate!.id,
          decision,
          source: 'ui',
          stamp: read.stamp ?? DECIDED_WITHOUT_A_READER,
          ...(decision === 'overturn' ? { noteMd: 'Not what we agreed.' } : {}),
        },
        fx.ctx,
      );
    }

    // Neither is on To approve any more.
    expect((await approvalGatesService.listAwaitingMe(meCtx)).total).toBe(0);

    const room = await approvalGatesService.listRecords(meCtx, { limit: 100 });
    const decided = room.sections.decided.items;
    expect(decided.map((row) => [row.workItem.title, row.state]).sort()).toEqual([
      ['Confirm me', 'approved'],
      ['Overturn me', 'overturned'],
    ]);
    const confirmedRow = decided.find((row) => row.workItem.title === 'Confirm me')!;
    expect(confirmedRow.confirmedRecord).toEqual({ kind: 'none' });
    expect(confirmedRow.decidedByLabel).toBeTruthy();
  });
});
