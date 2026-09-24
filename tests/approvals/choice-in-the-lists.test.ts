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

// A CHOICE IN THE LISTS (Story MOTIR-4914 · Subtask MOTIR-5897), on real Postgres.
// Routing is unchanged for the fifth kind: the question reaches exactly ONE person's
// To-approve tab — `assigneeId ?? reporterId` — and once it is answered it leaves
// that tab and reads DECIDED in the Approvals room, naming the option picked.

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
  '## Question',
  'Where do exported reports live?',
  '## Why this is a choice',
  '**Situation:** two workflows',
  'The requirement names a download and a shared link.',
  '## Options',
  '### Managed object storage',
  '**Best if you want:** less to operate',
  'The provider runs it.',
  '### Our own Postgres',
  '**Best if you want:** more cost-effective',
  'No new vendor.',
  '## What this choice gates',
  'The export story.',
].join('\n');

describe('the choice gate in To approve and the Approvals room', () => {
  it('reaches its routed person only, and moves to the room’s decided section once chosen', async () => {
    const item = await workItemsService.createWorkItem(
      {
        projectId: fx.projectId,
        kind: 'task',
        title: 'Choose where exports live',
        type: 'choice',
        executor: 'human',
        assigneeId: fx.ownerId,
        descriptionMd: BODY,
      },
      fx.ctx,
    );

    const mine = await approvalGatesService.listAwaitingMe(meCtx);
    expect(mine.items.map((row) => row.kind)).toEqual(['decision_choice']);
    expect(mine.items[0]!.subject).toEqual({
      kind: 'decision_choice',
      optionCount: 2,
      question: 'Where do exported reports live?',
    });
    // Not routed to anybody else in the workspace.
    expect((await approvalGatesService.listAwaitingMe(otherCtx)).total).toBe(0);

    await approvalGatesService.decide(
      {
        gateId: mine.items[0]!.gateId,
        decision: 'choose',
        optionId: 'managed-object-storage',
        source: 'ui',
        stamp: DECIDED_WITHOUT_A_READER,
      },
      fx.ctx,
    );

    expect((await approvalGatesService.listAwaitingMe(meCtx)).total).toBe(0);
    const room = await approvalGatesService.listRecords(meCtx);
    const decided = room.sections.decided.items.find((row) => row.workItem?.id === item.id);
    expect(decided).toMatchObject({
      kind: 'decision_choice',
      state: 'approved',
      chosenOption: {
        optionId: 'managed-object-storage',
        label: 'Managed object storage',
        bestFor: 'less to operate',
      },
    });
  });
});
