import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalGateState, WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope, PROJECT_SCOPE, type PlanChangeScope } from '@/lib/planChange/scope';
import { PlanSeedNotApplicableError } from '@/lib/planChange/errors';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-6434 — a PICK seeds a planning session (story MOTIR-6069;
// `picked-option-planning.md` §4). The seed guard accepts a chosen
// `decision_choice` only in a session scoped on the ANCHOR the seed read
// resolves — the choice's nearest not-done ancestor, else the project — and the
// three refusals keep checking their own card (planChangeSeededSession.test.ts,
// unedited). Real Postgres; only the motir-ai boundary client is mocked.

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

const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');

const STAMP = {
  optionId: 'managed-object-storage',
  label: 'Managed object storage',
  bestFor: 'less to operate',
  followUp: 'Report exports — the storage adapter, the retention rule and the download page.',
  situation: 'better_than_your_decision',
};

let fx: WorkItemFixture;
let parent: WorkItem;
let seq = 0;

const pctx = (): ProjectContext => ({
  userId: fx.ownerId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
  project: fx.project,
});
const scopeOf = (item: { identifier: string }) => buildScope([item.identifier]);

async function choiceUnder(parentId: string | null): Promise<WorkItem> {
  return createTestWorkItem(fx, {
    kind: parentId ? 'subtask' : 'task',
    type: 'choice',
    title: 'Choose where exports live',
    parentId,
  });
}

/** A decided choice gate, written in its final state in one INSERT. */
async function choiceGate(
  item: WorkItem,
  state: ApprovalGateState,
  chosenOption: Record<string, string> | null = STAMP,
): Promise<string> {
  seq += 1;
  const decided = state !== 'awaiting' && state !== 'superseded';
  const row = await adminDb.approvalGate.create({
    data: {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      workItemId: item.id,
      kind: 'decision_choice',
      subjectId: `subject-${seq}`,
      state,
      ...(decided
        ? { decidedById: fx.ownerId, decidedAt: new Date(), decidedByLabel: 'Owner' }
        : {}),
      ...(chosenOption ? { chosenOption } : {}),
    },
  });
  return row.id;
}

async function setStatus(id: string, status: string) {
  await adminDb.workItem.update({ where: { id }, data: { status } });
}

async function counts() {
  return {
    sessions: await adminDb.planChangeSession.count(),
    turns: await adminDb.planChangeTurn.count(),
  };
}

async function send(gateId: string, scope: PlanChangeScope) {
  return planChangeSessionsService.startSeededWithFirstTurn(pctx(), scope, 'the pick turn', gateId);
}

async function expectRefused(gateId: string, scope: PlanChangeScope) {
  await expect(send(gateId, scope)).rejects.toBeInstanceOf(PlanSeedNotApplicableError);
  expect(await counts()).toEqual({ sessions: 0, turns: 0 });
}

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  parent = await createTestWorkItem(fx, { kind: 'story', title: 'Reporting' });
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('startSeededWithFirstTurn — a PICK seeds a session on its ANCHOR', () => {
  it('stamps a session scoped on the open PARENT, and a second first turn resumes it', async () => {
    const gateId = await choiceGate(await choiceUnder(parent.id), 'approved');
    const first = await send(gateId, scopeOf(parent));
    const row = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.seedGateId).toBe(gateId);
    const again = await send(gateId, scopeOf(parent));
    expect(again.id).toBe(first.id);
    expect(await counts()).toEqual({ sessions: 1, turns: 2 });
  });

  it('walks past a DONE parent to the grandparent', async () => {
    const epic = await createTestWorkItem(fx, { kind: 'epic', title: 'Exports' });
    const story = await createTestWorkItem(fx, {
      kind: 'story',
      title: 'Done story',
      parentId: epic.id,
    });
    await setStatus(story.id, 'done');
    const gateId = await choiceGate(await choiceUnder(story.id), 'approved');
    await expectRefused(gateId, scopeOf(story));
    const s = await send(gateId, scopeOf(epic));
    expect(
      (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: s.id } })).seedGateId,
    ).toBe(gateId);
  });

  it('a ROOT choice seeds the PROJECT scope, and no card scope', async () => {
    const gateId = await choiceGate(await choiceUnder(null), 'approved');
    await expectRefused(gateId, scopeOf(parent));
    const s = await send(gateId, PROJECT_SCOPE);
    expect(
      (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: s.id } })).seedGateId,
    ).toBe(gateId);
  });
});

describe('startSeededWithFirstTurn — a pick off its anchor, or not a pick, is refused and writes nothing', () => {
  it('a session scoped on the CHOICE card itself', async () => {
    const choice = await choiceUnder(parent.id);
    await expectRefused(await choiceGate(choice, 'approved'), scopeOf(choice));
  });

  it('a session scoped on an unrelated card', async () => {
    const other = await createTestWorkItem(fx, { kind: 'story', title: 'Elsewhere' });
    await expectRefused(await choiceGate(await choiceUnder(parent.id), 'approved'), scopeOf(other));
  });

  it('the project scope when the choice HAS an open container', async () => {
    await expectRefused(await choiceGate(await choiceUnder(parent.id), 'approved'), PROJECT_SCOPE);
  });

  it('an AWAITING choice, even on its parent', async () => {
    await expectRefused(
      await choiceGate(await choiceUnder(parent.id), 'awaiting', null),
      scopeOf(parent),
    );
  });

  it('a chosen gate whose stamp is missing', async () => {
    await expectRefused(
      await choiceGate(await choiceUnder(parent.id), 'approved', null),
      scopeOf(parent),
    );
  });

  it('a chosen gate whose stamp is malformed', async () => {
    await expectRefused(
      await choiceGate(await choiceUnder(parent.id), 'approved', { label: 'only a label' }),
      scopeOf(parent),
    );
  });

  it('None of these (a refusal) still anchors on the CHOICE card, not the parent', async () => {
    const choice = await choiceUnder(parent.id);
    const gateId = await choiceGate(choice, 'changes_requested', null);
    await expectRefused(gateId, scopeOf(parent));
    const s = await send(gateId, scopeOf(choice));
    expect(
      (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: s.id } })).seedGateId,
    ).toBe(gateId);
  });
});
