import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope } from '@/lib/planChange/scope';
import { workItemsService } from '@/lib/services/workItemsService';
import { makeWorkItemFixture, type WorkItemFixture } from '../../fixtures';
import { adminDb } from '../../helpers/adminDb';
import { truncateAuthTables } from '../../helpers/db';

// WHICH FAILED-WAITING SHAPE THE SESSION READ SAYS IT IS (Story MOTIR-7905 · MOTIR-7941), against
// a REAL Postgres: the overlay draws Resume or the open composer from these fields and never
// re-derives them, so the mapper has to answer exactly as the submit door's classifier does.
//   · a failure beside a `planned` plan → 'reply' (the next turn continues), waitingPlan = it;
//   · a failed walk → 'resume', no waiting plan; and with an OLDER `planned` plan → 'resume'
//     with that plan named; a `stale` plan reads `stale`;
//   · a session that is not failed carries neither field.

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

const T = { timeout: 120_000 };
let fx: WorkItemFixture;

beforeEach(async () => {
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});
afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

const me = (): ProjectContext => ({
  userId: fx.ownerId,
  workspaceId: fx.workspaceId,
  projectId: fx.projectId,
  project: fx.project,
});

async function session(opts: { failed: boolean }) {
  const card = await workItemsService.createWorkItem(
    { projectId: fx.projectId, kind: 'task', title: 'The card' },
    fx.ctx,
  );
  const s = await planChangeSessionsService.startWithFirstTurn(
    me(),
    buildScope([card.identifier]),
    'Split it',
  );
  if (opts.failed) {
    await adminDb.planChangeSession.update({
      where: { id: s.id },
      data: {
        lastJobId: 'job-1',
        failedAt: new Date(),
        failedJobId: 'job-1',
        failureReason: 'rate_limited',
        failureStopPhase: 'author',
        failureStopRef: 'planItem:abc',
        failureStopTitle: 'Export',
      },
    });
  }
  return s.id;
}

let tick = 0;
const plan = (
  sessionId: string,
  status: 'generating' | 'planned' | 'stale',
  extra: { sourceJobId?: string | null; title?: string } = {},
) =>
  adminDb.plan.create({
    data: {
      workspaceId: fx.workspaceId,
      projectId: fx.projectId,
      sessionId,
      status,
      title: extra.title ?? null,
      sourceJobId: extra.sourceJobId ?? null,
      createdById: fx.ownerId,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, ++tick)),
    },
  });

describe('failed beside a waiting plan → the NEXT TURN continues (situation 2)', () => {
  it("reads 'reply', names the waiting plan, and is not resumable", T, async () => {
    const id = await session({ failed: true });
    const waiting = await plan(id, 'planned', { title: 'Export plan', sourceJobId: 'job-0' });
    const dto = await planChangeSessionsService.getById(me(), id);
    expect(dto.failedWaiting).toBe('reply');
    expect(dto.failure?.resumable).toBe(false);
    expect(dto.waitingPlan).toEqual({
      planId: waiting.id,
      title: 'Export plan',
      status: 'planned',
    });
  });

  it('a STALE waiting plan reads stale', T, async () => {
    const id = await session({ failed: true });
    const waiting = await plan(id, 'stale', { sourceJobId: 'job-0' });
    const dto = await planChangeSessionsService.getById(me(), id);
    expect(dto.failedWaiting).toBe('reply');
    expect(dto.waitingPlan).toMatchObject({ planId: waiting.id, status: 'stale' });
  });
});

describe('a failed WALK → only Resume continues it', () => {
  it("reads 'resume' with no waiting plan", T, async () => {
    const id = await session({ failed: true });
    await plan(id, 'generating', { sourceJobId: 'job-1' });
    const dto = await planChangeSessionsService.getById(me(), id);
    expect(dto.failedWaiting).toBe('resume');
    expect(dto.failure?.resumable).toBe(true);
    expect(dto.waitingPlan).toBeNull();
  });

  it(
    "with an OLDER waiting plan beside it still reads 'resume', and names that plan",
    T,
    async () => {
      const id = await session({ failed: true });
      const older = await plan(id, 'planned', { sourceJobId: 'job-0' });
      await plan(id, 'generating', { sourceJobId: 'job-1' });
      const dto = await planChangeSessionsService.getById(me(), id);
      expect(dto.failedWaiting).toBe('resume');
      expect(dto.waitingPlan).toMatchObject({ planId: older.id, status: 'planned' });
    },
  );
});

describe('a session that is not failed', () => {
  it('carries neither field', T, async () => {
    const id = await session({ failed: false });
    await plan(id, 'planned', { sourceJobId: 'job-0' });
    const dto = await planChangeSessionsService.getById(me(), id);
    expect(dto.failure ?? null).toBeNull();
    expect(dto.failedWaiting ?? null).toBeNull();
    expect(dto.waitingPlan ?? null).toBeNull();
  });
});
