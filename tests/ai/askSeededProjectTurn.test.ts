import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { PROJECT_SCOPE } from '@/lib/planChange/scope';
import { PlanSeedNotApplicableError } from '@/lib/planChange/errors';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-6435 — a PICK anchored at the PROJECT sends its first turn through the
// project's one door (`POST /api/ai/ask` → `aiAskService.submitTurn`), so that
// door carries the seed too. Found by the story's integration gate (MOTIR-6437):
// without it the turn was sent unstamped, and joined the caller's resumable
// project conversation instead of starting the pick's own. Real Postgres; only the
// motir-ai boundary client is mocked.

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async () => ({ jobId: 'job-seeded-ask' })),
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

const { aiAskService } = await import('@/lib/services/aiAskService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');

const STAMP = {
  optionId: 'managed-object-storage',
  label: 'Managed object storage',
  bestFor: 'less to operate',
  followUp: 'Report exports.',
  situation: 'better_than_your_decision',
};

let fx: WorkItemFixture;
let seq = 0;

const pctx = (): ProjectContext => ({
  userId: fx.ownerId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
  project: fx.project,
});

async function pickGate(choice: WorkItem): Promise<string> {
  seq += 1;
  const row = await adminDb.approvalGate.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      workItemId: choice.id,
      kind: 'decision_choice',
      subjectId: `subject-${seq}`,
      state: 'approved',
      decidedById: fx.ownerId,
      decidedAt: new Date(),
      decidedByLabel: 'Owner',
      chosenOption: STAMP,
    },
  });
  return row.id;
}

const rootChoice = () =>
  createTestWorkItem(fx, { kind: 'task', type: 'choice', title: 'Choose where exports live' });

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('aiAskService.submitTurn — a pick seeded at the PROJECT', () => {
  it('starts the pick’s OWN stamped session, even when an unrelated project conversation is resumable', async () => {
    const unrelated = await planChangeSessionsService.startWithFirstTurn(
      pctx(),
      PROJECT_SCOPE,
      'An earlier question about the roadmap.',
    );
    const gateId = await pickGate(await rootChoice());

    const result = await aiAskService.submitTurn('The pick’s first turn.', pctx(), {
      seedGateId: gateId,
    });

    const sessionId = (result as { session: { id: string } }).session.id;
    expect(sessionId).not.toBe(unrelated.id);
    const row = await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.seedGateId).toBe(gateId);
    expect(row.targetKeys).toEqual([]);
    // The unrelated conversation was not touched.
    expect(await adminDb.planChangeTurn.count({ where: { sessionId: unrelated.id } })).toBe(1);
  });

  it('a second seeded first turn resumes the pick’s session rather than starting another', async () => {
    const gateId = await pickGate(await rootChoice());
    const first = await aiAskService.submitTurn('Turn one.', pctx(), { seedGateId: gateId });
    const again = await aiAskService.submitTurn('Turn one, again.', pctx(), { seedGateId: gateId });
    expect((again as { session: { id: string } }).session.id).toBe(
      (first as { session: { id: string } }).session.id,
    );
    expect(await adminDb.planChangeSession.count({ where: { seedGateId: gateId } })).toBe(1);
  });

  it('a gate that may not seed the project scope (a choice with an open container) is refused and writes nothing', async () => {
    const story = await createTestWorkItem(fx, { kind: 'story', title: 'Reporting' });
    const gateId = await pickGate(
      await createTestWorkItem(fx, {
        kind: 'subtask',
        type: 'choice',
        title: 'Choose',
        parentId: story.id,
      }),
    );
    await expect(
      aiAskService.submitTurn('The pick’s first turn.', pctx(), { seedGateId: gateId }),
    ).rejects.toBeInstanceOf(PlanSeedNotApplicableError);
    expect(await adminDb.planChangeSession.count()).toBe(0);
    expect(await adminDb.planChangeTurn.count()).toBe(0);
  });

  it('with no seed, the door still resumes the caller’s project conversation (unchanged)', async () => {
    const earlier = await planChangeSessionsService.startWithFirstTurn(
      pctx(),
      PROJECT_SCOPE,
      'An earlier question.',
    );
    const result = await aiAskService.submitTurn('A follow-up question.', pctx());
    expect((result as { session: { id: string } }).session.id).toBe(earlier.id);
  });
});
