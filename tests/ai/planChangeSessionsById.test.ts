import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope, PROJECT_SCOPE } from '@/lib/planChange/scope';
import { PLAN_SESSION_RESUME_WINDOW_MS } from '@/lib/planChange/sessionWindow';
import { PlanSessionNotFoundError, PlanTargetLockedError } from '@/lib/planChange/errors';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestProject } from '../fixtures/projectFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { truncateAuthTables } from '../helpers/db';
import { addToProjectAs } from '../helpers/workspaceRoleFixtures';

// MOTIR-6021 — SESSIONS ADDRESSED BY ID (story MOTIR-6011;
// `agent-authored-plans.md` AMENDMENT 17 §1–§3, §6), against a REAL Postgres.
// Only the motir-ai boundary client is mocked, as in every AI service test; the
// advisory lock, the row locks, the resume read and the target lock all run for
// real.

const submitJobMock = vi.fn(async () => ({ jobId: 'job-by-id-1' }));

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

const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');

const MINUTE = 60 * 1000;

let fx: WorkItemFixture;
let seq = 0;

function pctxFor(userId: string, f: WorkItemFixture = fx): ProjectContext {
  return { userId, workspaceId: f.workspaceId, projectId: f.projectId, project: f.project };
}

/** A second member of the project holding `ai:plan` (project role `member`). */
async function teammate(): Promise<ProjectContext> {
  seq += 1;
  const u = await usersService.createUser({
    email: `teammate-${seq}@example.com`,
    password: 'correct-horse-battery-staple-9',
    name: `Teammate ${seq}`,
  });
  await adminDb.workspaceMembership.create({
    data: { userId: u.id, workspaceId: fx.workspaceId, role: 'member' },
  });
  await addToProjectAs({
    key: fx.project.identifier,
    actorUserId: fx.ownerId,
    ctx: fx.ctx,
    targetUserId: u.id,
    role: 'member',
  });
  return pctxFor(u.id);
}

async function setActivity(sessionId: string, at: Date) {
  await adminDb.planChangeSession.update({
    where: { id: sessionId },
    data: { lastActivityAt: at },
  });
}

async function counts() {
  return {
    sessions: await adminDb.planChangeSession.count(),
    turns: await adminDb.planChangeTurn.count(),
  };
}

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockClear();
  submitJobMock.mockResolvedValue({ jobId: 'job-by-id-1' });
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('findResumable — your own session in the scope, active within the window', () => {
  it('resumes a session active 1h59m ago and not one active 2h01m ago', async () => {
    const me = pctxFor(fx.ownerId);
    const started = await planChangeSessionsService.startWithFirstTurn(me, PROJECT_SCOPE, 'hi');
    const now = new Date();

    await setActivity(started.id, new Date(now.getTime() - 119 * MINUTE));
    expect((await planChangeSessionsService.findResumable(me, '', now))?.id).toBe(started.id);

    await setActivity(started.id, new Date(now.getTime() - 121 * MINUTE));
    expect(await planChangeSessionsService.findResumable(me, '', now)).toBeNull();
    expect(PLAN_SESSION_RESUME_WINDOW_MS).toBe(120 * MINUTE);
  });

  it('never resumes ANOTHER member’s session, however recent', async () => {
    const other = await teammate();
    await planChangeSessionsService.startWithFirstTurn(other, PROJECT_SCOPE, 'theirs');

    expect(await planChangeSessionsService.findResumable(pctxFor(fx.ownerId), '')).toBeNull();
  });

  it('writes nothing — and neither does getById', async () => {
    const me = pctxFor(fx.ownerId);
    const started = await planChangeSessionsService.startWithFirstTurn(me, PROJECT_SCOPE, 'hi');
    const before = await counts();
    const activityBefore = (
      await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: started.id } })
    ).lastActivityAt;

    await planChangeSessionsService.findResumable(me, '');
    await planChangeSessionsService.findResumable(me, 'NO-SUCH-SCOPE');
    const read = await planChangeSessionsService.getById(me, started.id);

    expect(read.id).toBe(started.id);
    expect(await counts()).toEqual(before);
    expect(
      (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: started.id } }))
        .lastActivityAt,
    ).toEqual(activityBefore);
  });

  it('lets any member READ another member’s session by id, and refuses an id from another project', async () => {
    const other = await teammate();
    const theirs = await planChangeSessionsService.startWithFirstTurn(other, PROJECT_SCOPE, 'x');
    expect((await planChangeSessionsService.getById(pctxFor(fx.ownerId), theirs.id)).id).toBe(
      theirs.id,
    );

    const elsewhere = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'ELSE',
    });
    await expect(
      planChangeSessionsService.getById(
        { ...pctxFor(fx.ownerId), projectId: elsewhere.id, project: elsewhere },
        theirs.id,
      ),
    ).rejects.toBeInstanceOf(PlanSessionNotFoundError);
  });
});

describe('startWithFirstTurn — a session exists from its first turn', () => {
  it('creates exactly one conversation session carrying the turn', async () => {
    const before = Date.now();
    const s = await planChangeSessionsService.startWithFirstTurn(
      pctxFor(fx.ownerId),
      PROJECT_SCOPE,
      'Split the billing epic',
    );

    expect(s.turnCount).toBe(1);
    expect(s.turns.map((t) => t.body)).toEqual(['Split the billing epic']);
    expect(s.origin).toBe('conversation');
    expect(new Date(s.lastActivityAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await adminDb.planChangeSession.count()).toBe(1);
  });

  it('APPENDS to the member’s recent session instead of starting a second', async () => {
    const me = pctxFor(fx.ownerId);
    const first = await planChangeSessionsService.startWithFirstTurn(me, PROJECT_SCOPE, 'one');
    const second = await planChangeSessionsService.startWithFirstTurn(me, PROJECT_SCOPE, 'two');

    expect(second.id).toBe(first.id);
    expect(second.turns.map((t) => t.body)).toEqual(['one', 'two']);
  });

  it('starts FRESH once the member’s session has gone quiet past the window', async () => {
    const me = pctxFor(fx.ownerId);
    const old = await planChangeSessionsService.startWithFirstTurn(me, PROJECT_SCOPE, 'old');
    await setActivity(old.id, new Date(Date.now() - 3 * 60 * MINUTE));

    const fresh = await planChangeSessionsService.startWithFirstTurn(me, PROJECT_SCOPE, 'new');

    expect(fresh.id).not.toBe(old.id);
    expect(fresh.turns.map((t) => t.body)).toEqual(['new']);
    expect(await adminDb.planChangeSession.count()).toBe(2);
  });

  it('TWO TABS racing a first turn, truly in parallel, land on ONE session holding both turns', async () => {
    const me = pctxFor(fx.ownerId);
    const [a, b] = await Promise.all([
      planChangeSessionsService.startWithFirstTurn(me, PROJECT_SCOPE, 'tab A'),
      planChangeSessionsService.startWithFirstTurn(me, PROJECT_SCOPE, 'tab B'),
    ]);

    // The loser observes the winner's session id.
    expect(a.id).toBe(b.id);
    const rows = await adminDb.planChangeSession.findMany({ where: { projectId: fx.projectId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.turnCount).toBe(2);
    const bodies = (
      await adminDb.planChangeTurn.findMany({ where: { sessionId: a.id }, orderBy: { seq: 'asc' } })
    ).map((t) => t.body);
    expect(bodies.sort()).toEqual(['tab A', 'tab B']);
  });

  it('refuses an empty first turn and creates nothing', async () => {
    await expect(
      planChangeSessionsService.startWithFirstTurn(pctxFor(fx.ownerId), PROJECT_SCOPE, '   '),
    ).rejects.toThrow();
    expect(await adminDb.planChangeSession.count()).toBe(0);
  });
});

describe('by-id writes', () => {
  it('refuse a session id from another project with PLAN_SESSION_NOT_FOUND', async () => {
    const me = pctxFor(fx.ownerId);
    const s = await planChangeSessionsService.startWithFirstTurn(me, PROJECT_SCOPE, 'hi');
    const elsewhere = await createTestProject({
      workspaceId: fx.workspaceId,
      actorUserId: fx.ownerId,
      identifier: 'OTHR',
    });
    const there: ProjectContext = { ...me, projectId: elsewhere.id, project: elsewhere };

    const err = await planChangeSessionsService
      .appendTurn('stray', there, { sessionId: s.id })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanSessionNotFoundError);
    expect((err as PlanSessionNotFoundError).code).toBe('PLAN_SESSION_NOT_FOUND');
    await expect(
      planChangeSessionsService.submit(there, { sessionId: s.id }),
    ).rejects.toBeInstanceOf(PlanSessionNotFoundError);
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('land on the ADDRESSED session — never on a sibling of the same scope — and move its lastActivityAt', async () => {
    const me = pctxFor(fx.ownerId);
    const older = await planChangeSessionsService.startWithFirstTurn(me, PROJECT_SCOPE, 'older');
    const stale = new Date(Date.now() - 3 * 60 * MINUTE);
    await setActivity(older.id, stale);
    const newer = await planChangeSessionsService.startWithFirstTurn(me, PROJECT_SCOPE, 'newer');
    expect(newer.id).not.toBe(older.id);

    // Address the OLDER one by id: the scope's most recent is `newer`.
    await setActivity(older.id, stale);
    const appended = await planChangeSessionsService.appendTurn('more', me, {
      sessionId: older.id,
    });
    expect(appended.id).toBe(older.id);
    expect(appended.turns.map((t) => t.body)).toEqual(['older', 'more']);
    expect(new Date(appended.lastActivityAt).getTime()).toBeGreaterThan(stale.getTime());

    // Intent correction and submit are by-id too, and both move the clock.
    await setActivity(older.id, stale);
    const turnId = appended.turns[1]!.id;
    const corrected = await planChangeSessionsService.recordTurnIntent(
      turnId,
      'plan_change',
      me,
      { corrected: true },
      { sessionId: older.id },
    );
    expect(new Date(corrected.lastActivityAt).getTime()).toBeGreaterThan(stale.getTime());

    await setActivity(older.id, stale);
    const { session } = await planChangeSessionsService.submit(me, { sessionId: older.id });
    expect(session.id).toBe(older.id);
    expect(session.lastJobId).toBe('job-by-id-1');
    expect(new Date(session.lastActivityAt).getTime()).toBeGreaterThan(stale.getTime());

    const untouched = await adminDb.planChangeSession.findUniqueOrThrow({
      where: { id: newer.id },
    });
    expect(untouched.turnCount).toBe(1);
    expect(untouched.lastJobId).toBeNull();
  });
});

describe('the target lock between sessions of one scope (AMENDMENT 17 §6)', () => {
  async function anchor() {
    const item = await workItemsService.createWorkItem(
      { projectId: fx.projectId, kind: 'story', title: 'Anchor story', parentId: null },
      fx.ctx,
    );
    return item.identifier;
  }

  it('HANDS a live lease from the member’s own older session to the new one', async () => {
    const me = pctxFor(fx.ownerId);
    const key = await anchor();
    const scope = buildScope([key]);
    const older = await planChangeSessionsService.startWithFirstTurn(me, scope, 'first');
    // The session goes quiet past the resume window while its lease is still
    // live — the case where the member would otherwise be refused by their own
    // earlier conversation.
    await setActivity(older.id, new Date(Date.now() - 3 * 60 * MINUTE));

    const fresh = await planChangeSessionsService.startWithFirstTurn(me, scope, 'second');

    expect(fresh.id).not.toBe(older.id);
    const lock = await adminDb.planTargetLock.findFirstOrThrow({
      where: { workItem: { identifier: key } },
    });
    expect(lock.sessionId).toBe(fresh.id);
    const item = await adminDb.workItem.findFirstOrThrow({ where: { identifier: key } });
    expect(item.status).toBe('planning');
  });

  it('still REFUSES a different member whose session holds a live lease', async () => {
    const key = await anchor();
    const scope = buildScope([key]);
    const other = await teammate();
    await planChangeSessionsService.startWithFirstTurn(other, scope, 'theirs');

    await expect(
      planChangeSessionsService.startWithFirstTurn(pctxFor(fx.ownerId), scope, 'mine'),
    ).rejects.toBeInstanceOf(PlanTargetLockedError);
    // Refused whole: no session of mine was left behind holding nothing.
    expect(await adminDb.planChangeSession.count({ where: { createdById: fx.ownerId } })).toBe(0);
  });
});
