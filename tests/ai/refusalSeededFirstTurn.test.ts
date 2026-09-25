import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalGateKind, ApprovalGateState, WorkItem } from '@/generated/prisma/client';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';

// MOTIR-6210 — the SEEDED first turn on the wire (story MOTIR-6068), against a
// REAL Postgres: the seed read the overlay opens with, then
// `POST /api/work-items/[id]/ai/plan` carrying `seedGateId` once. Only the context
// resolvers a Vitest process cannot supply through cookies (the session, the
// active project, the request locale) and the motir-ai boundary client are
// stubbed; route → service → repository → Postgres runs for real.

const session = { current: null as { user: { id: string; email: string; name: string } } | null };
const activeCtx = { current: null as ProjectContext | null };

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return { ...actual, getSession: async () => session.current };
});
vi.mock('@/lib/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects')>();
  return { ...actual, getActiveProject: async () => activeCtx.current };
});
vi.mock('next-intl/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next-intl/server')>();
  return { ...actual, getLocale: async () => 'en' };
});

const submitJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: 'job-seeded-1' }));
vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
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

const { POST: plan } = await import('@/app/api/work-items/[id]/ai/plan/route');
const { GET: seedRoute } = await import('@/app/api/approval-gates/[id]/planning-seed/route');

const REASON = 'Keep the download page for large files.\nOnly the retention rule should change.';

let fx: WorkItemFixture;
let card: WorkItem;
let seq = 0;

function planReq(id: string, body: unknown): Request {
  return new Request(`http://localhost:3000/api/work-items/${id}/ai/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function readSeed(gateId: string): Promise<Response> {
  return seedRoute(
    new Request(`http://localhost:3000/api/approval-gates/${gateId}/planning-seed`),
    {
      params: Promise.resolve({ id: gateId }),
    },
  );
}

/** A gate row written in its FINAL state (the decided-immutable trigger fires on
 *  UPDATE, so a decided fixture is one INSERT). */
async function gate(
  item: { id: string; workspaceId: string; projectId: string },
  kind: ApprovalGateKind,
  state: ApprovalGateState,
): Promise<string> {
  seq += 1;
  const decided = state !== 'awaiting' && state !== 'superseded';
  const row = await adminDb.approvalGate.create({
    data: {
      workspaceId: item.workspaceId,
      projectId: item.projectId,
      workItemId: item.id,
      kind,
      subjectId: `subject-${seq}`,
      state,
      ...(decided
        ? {
            decidedById: fx.ownerId,
            decidedAt: new Date(),
            decidedByLabel: 'Owner',
            noteMd: REASON,
          }
        : {}),
    },
  });
  return row.id;
}

async function counts() {
  return {
    sessions: await adminDb.planChangeSession.count(),
    turns: await adminDb.planChangeTurn.count(),
    jobs: submitJobMock.mock.calls.length,
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockClear();
  submitJobMock.mockResolvedValue({ jobId: 'job-seeded-1' });
  fx = await makeWorkItemFixture();
  card = await createTestWorkItem(fx, { kind: 'story', title: 'Where exports live' });
  session.current = { user: { id: fx.ownerId, email: 'owner@example.com', name: 'Owner' } };
  activeCtx.current = {
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

describe('open → Send → return: the seeded re-plan on the wire', () => {
  it('opening writes NOTHING; Send posts the seed once; the session remembers the gate; the door returns to it', async () => {
    const gateId = await gate(card, 'decision_approval', 'changes_requested');

    // OPEN — the overlay's read. No session, no turn, no job until Send.
    const opened = await readSeed(gateId);
    expect(opened.status).toBe(200);
    const { seed } = (await opened.json()) as {
      seed: { anchorKey: string; firstTurn: string; seededSessionId: string | null };
    };
    expect(seed.anchorKey).toBe(card.identifier);
    expect(seed.seededSessionId).toBeNull();
    expect(await counts()).toEqual({ sessions: 0, turns: 0, jobs: 0 });

    // SEND — the first turn carries the seed.
    const first = await plan(
      planReq(card.id, { prompt: seed.firstTurn, isAnswer: false, seedGateId: gateId }),
      params(card.id),
    );
    expect(first.status).toBe(200);
    const sent = (await first.json()) as { sessionId: string };
    const row = await adminDb.planChangeSession.findUniqueOrThrow({
      where: { id: sent.sessionId },
    });
    expect(row.seedGateId).toBe(gateId);
    expect((await counts()).jobs).toBe(1);
    const turns = await adminDb.planChangeTurn.findMany({
      where: { sessionId: sent.sessionId, role: 'user' },
    });
    expect(turns.map((t) => t.body)).toEqual([seed.firstTurn]);

    // A SECOND turn names the session and carries no seed — and a stray seed on a
    // continuing turn is ignored: same session, nothing new.
    const second = await plan(
      planReq(card.id, {
        prompt: 'Also keep the audit log.',
        sessionId: sent.sessionId,
        seedGateId: gateId,
      }),
      params(card.id),
    );
    expect(second.status).toBe(200);
    expect(((await second.json()) as { sessionId: string }).sessionId).toBe(sent.sessionId);
    expect(await adminDb.planChangeSession.count()).toBe(1);

    // RETURN — the door reads the seed again and is pointed at that session.
    const back = (await (await readSeed(gateId)).json()) as {
      seed: { seededSessionId: string | null };
    };
    expect(back.seed.seededSessionId).toBe(sent.sessionId);
  });

  it('a seeded first turn does NOT land on the caller’s recent UNSEEDED conversation on the card', async () => {
    const gateId = await gate(card, 'decision_confirmation', 'overturned');
    const ordinary = await plan(planReq(card.id, { prompt: 'Split this.' }), params(card.id));
    const ordinaryId = ((await ordinary.json()) as { sessionId: string }).sessionId;

    const seeded = await plan(
      planReq(card.id, { prompt: 'Re-plan from the overturn.', seedGateId: gateId }),
      params(card.id),
    );
    expect(seeded.status).toBe(200);
    const seededId = ((await seeded.json()) as { sessionId: string }).sessionId;
    expect(seededId).not.toBe(ordinaryId);
    const rows = await adminDb.planChangeSession.findMany({ orderBy: { createdAt: 'asc' } });
    expect(rows.map((r) => r.seedGateId)).toEqual([null, gateId]);
  });

  it('a gate that may not seed this card answers 422 SEED_NOT_APPLICABLE and writes nothing', async () => {
    const other = await createTestWorkItem(fx, { kind: 'story', title: 'Another card' });
    const cases = [
      await gate(card, 'decision_approval', 'approved'), // not a refusal
      await gate(other, 'decision_approval', 'changes_requested'), // another card
      'cmg-no-such-gate',
    ];
    for (const seedGateId of cases) {
      const res = await plan(planReq(card.id, { prompt: 'x', seedGateId }), params(card.id));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ code: 'SEED_NOT_APPLICABLE' });
    }
    expect(await counts()).toEqual({ sessions: 0, turns: 0, jobs: 0 });
  });

  it('a non-string or blank seedGateId is absent — the turn is an ordinary one', async () => {
    for (const seedGateId of [42, '', '   ', null]) {
      const res = await plan(planReq(card.id, { prompt: 'x', seedGateId }), params(card.id));
      expect(res.status).toBe(200);
    }
    const rows = await adminDb.planChangeSession.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.seedGateId).toBeNull();
  });
});
