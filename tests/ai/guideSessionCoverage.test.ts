import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope, PROJECT_SCOPE } from '@/lib/planChange/scope';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addressOf, openTestSession } from '../helpers/planSession';

// The per-file COVERAGE GATE's residual for the guide arms of the conversation's
// persistence layer (Story MOTIR-7459 · MOTIR-7464 / MOTIR-7470). The guide
// suites (`aiGuideService.test.ts`, `guideLandingService.test.ts`) drive these
// methods through the routes, where the door's own gates stop the inputs below
// before they arrive; this file reaches the service's own refusals directly.
// Real Postgres; only the motir-ai boundary client is mocked.

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: vi.fn(async () => ({ jobId: 'job-1' })),
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
const { EmptyPlanChangeTurnError, PlanChangeTurnNotFoundError } =
  await import('@/lib/planChange/errors');

let fx: WorkItemFixture;
let pctx: ProjectContext;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
  pctx = {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

async function guideOn(identifier: string) {
  return planChangeSessionsService.openGuideWithFirstTurn(
    pctx,
    buildScope([identifier]),
    `Guide me through ${identifier}.`,
    { resume: false },
  );
}

describe('findGuide', () => {
  it('answers null before a guide conversation exists, and the conversation after', async () => {
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Rotate' });
    const scope = buildScope([card.identifier]);
    expect(await planChangeSessionsService.findGuide(pctx, scope)).toBeNull();
    const { session } = await guideOn(card.identifier);
    expect((await planChangeSessionsService.findGuide(pctx, scope))?.id).toBe(session.id);
  });
});

describe('openGuideWithFirstTurn', () => {
  it('refuses an empty opening turn and a scope that is not exactly one card', async () => {
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Rotate' });
    await expect(
      planChangeSessionsService.openGuideWithFirstTurn(pctx, buildScope([card.identifier]), '  ', {
        resume: false,
      }),
    ).rejects.toBeInstanceOf(EmptyPlanChangeTurnError);
    await expect(
      planChangeSessionsService.openGuideWithFirstTurn(pctx, PROJECT_SCOPE, 'Guide me.', {
        resume: false,
      }),
    ).rejects.toThrow('exactly one card');
  });
});

describe('claimGuideLanding', () => {
  it('claims a guide turn once, refuses an assistant turn, and answers false for another intent', async () => {
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Rotate' });
    const { session } = await guideOn(card.identifier);
    const address = addressOf(session);
    const userTurn = session.turns.find((t) => t.role === 'user')!;

    expect(await planChangeSessionsService.claimGuideLanding(userTurn.id, pctx, address)).toBe(
      true,
    );
    expect(await planChangeSessionsService.claimGuideLanding(userTurn.id, pctx, address)).toBe(
      false,
    );

    const replied = await planChangeSessionsService.appendGuideReplyTurn(
      {
        jobId: 'job-x',
        body: 'Step one.',
        record: { actions: [], outcomes: [], temporary: false },
      },
      pctx,
      address,
    );
    const reply = replied.turns.find((t) => t.role === 'assistant')!;
    await expect(
      planChangeSessionsService.claimGuideLanding(reply.id, pctx, address),
    ).rejects.toBeInstanceOf(PlanChangeTurnNotFoundError);

    // A plain planning conversation's user turn did not run as guide.
    const plain = await openTestSession(pctx);
    const plainTurn = plain.turns.find((t) => t.role === 'user');
    const planAddress = addressOf(plain);
    const appended =
      plainTurn ??
      (await planChangeSessionsService.appendTurn('Split it.', pctx, planAddress)).turns.at(-1)!;
    expect(await planChangeSessionsService.claimGuideLanding(appended.id, pctx, planAddress)).toBe(
      false,
    );
  });
});

describe('appendGuideReplyTurn', () => {
  it('refuses an empty reply', async () => {
    const card = await createTestWorkItem(fx, { kind: 'task', title: 'Rotate' });
    const { session } = await guideOn(card.identifier);
    await expect(
      planChangeSessionsService.appendGuideReplyTurn(
        { jobId: 'job-y', body: ' ', record: { actions: [], outcomes: [], temporary: false } },
        pctx,
        addressOf(session),
      ),
    ).rejects.toBeInstanceOf(EmptyPlanChangeTurnError);
  });
});
