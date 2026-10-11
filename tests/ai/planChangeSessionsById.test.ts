import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { buildScope, PROJECT_SCOPE } from '@/lib/planChange/scope';
import { PlanSessionNotFoundError, PlanTargetLockedError } from '@/lib/planChange/errors';
import { planSessionEndService } from '@/lib/services/planSessionEndService';
import { usersService } from '@/lib/services/usersService';
import { workItemsService } from '@/lib/services/workItemsService';
import { createTestProject } from '../fixtures/projectFixtures';
import { makeWorkItemFixture, type WorkItemFixture } from '../fixtures/workItemFixtures';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
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
const { contextualPlanningService } = await import('@/lib/services/contextualPlanningService');

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
    data: { userId: u.id, workspaceId: fx.workspaceId, workspaceRole: 'member' },
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

async function endIt(sessionId: string) {
  await planSessionEndService.endSession(sessionId, 'idle', { workspaceId: fx.workspaceId });
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

describe('findResumable — your own OPEN session in the scope, at any age', () => {
  // AMENDMENT 23 §3 (MOTIR-7639): the 2-hour window is retired. Openness decides.
  it('resumes an open session however old, and never an ended one however recent', async () => {
    const me = pctxFor(fx.ownerId);
    const started = await planChangeSessionsService.startWithFirstTurn(me, PROJECT_SCOPE, 'hi');

    await setActivity(started.id, new Date(Date.now() - 48 * 60 * MINUTE));
    expect((await planChangeSessionsService.findResumable(me, ''))?.id).toBe(started.id);

    await adminDb.planChangeSession.update({
      where: { id: started.id },
      data: { endedAt: new Date(), endReason: 'failed' },
    });
    await setActivity(started.id, new Date());
    expect(await planChangeSessionsService.findResumable(me, '')).toBeNull();
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

  it('starts FRESH once the member’s session has ENDED (AMENDMENT 23 §3)', async () => {
    const me = pctxFor(fx.ownerId);
    const old = await planChangeSessionsService.startWithFirstTurn(me, PROJECT_SCOPE, 'old');
    await endIt(old.id);

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
    // A NEWER open sibling of the same scope. The resume rule never makes one for
    // the same member any more (it returns their open session at any age), so the
    // row is written directly — what is under test is the by-id address, not how
    // the sibling came to exist.
    const newer = await adminDb.planChangeSession.create({
      data: {
        workspaceId: fx.workspaceId,
        projectId: fx.projectId,
        createdById: fx.ownerId,
        scopeKey: (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: older.id } }))
          .scopeKey,
        targetKeys: [],
        turnCount: 1,
      },
    });
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

  it('a member’s ENDED older session gave the card back, so the new one takes it', async () => {
    // AMENDMENT 23 §3 retires the §6 hand-over: an open session is resumed at any
    // age, and an ended one released its leases when it ended — so there is no
    // live lease left to hand.
    const me = pctxFor(fx.ownerId);
    const key = await anchor();
    const scope = buildScope([key]);
    const older = await planChangeSessionsService.startWithFirstTurn(me, scope, 'first');
    await endIt(older.id);

    const fresh = await planChangeSessionsService.startWithFirstTurn(me, scope, 'second');

    expect(fresh.id).not.toBe(older.id);
    const lock = await adminDb.planTargetLock.findFirstOrThrow({
      where: { workItem: { identifier: key } },
    });
    expect(lock.sessionId).toBe(fresh.id);
    const item = await adminDb.workItem.findFirstOrThrow({ where: { identifier: key } });
    expect(item.status).toBe('planning');
  });

  it('TAKES BACK: a first turn on a card the member’s own open session holds returns THAT session (AMENDMENT 23 §3)', async () => {
    const me = pctxFor(fx.ownerId);
    const key = await anchor();
    const other = await anchor();
    const mine = await planChangeSessionsService.startWithFirstTurn(me, buildScope([key]), 'first');

    // A DIFFERENT scope that includes the held card: no new session, no take-over.
    const back = await planChangeSessionsService.startWithFirstTurn(
      me,
      buildScope([key, other]),
      'again',
    );

    expect(back.id).toBe(mine.id);
    expect(back.turns.map((t) => t.body)).toEqual(['first', 'again']);
    expect(await adminDb.planChangeSession.count()).toBe(1);
  });

  it('the item’s resume NAMES another member’s hold on open, before anything is typed (MOTIR-7643)', async () => {
    const key = await anchor();
    const mate = await teammate();
    const theirs = await planChangeSessionsService.startWithFirstTurn(
      mate,
      buildScope([key]),
      'theirs',
    );
    const item = await adminDb.workItem.findFirstOrThrow({ where: { identifier: key } });
    const lock = await adminDb.planTargetLock.findFirstOrThrow({ where: { workItemId: item.id } });

    const read = await contextualPlanningService.getSessionForWorkItem(
      { anchorId: item.id },
      pctxFor(fx.ownerId),
    );

    // Nothing of theirs is resumed — it is named, with when it frees.
    expect(read.session).toBeNull();
    expect(read.heldBy).toEqual({
      target: key,
      holder: 'Teammate ' + seq,
      freesBy: new Date(lock.expiresAt!.getTime() + 5 * MINUTE).toISOString(),
      holderSessionId: theirs.id,
      // A plain hold is not a waiting one (MOTIR-7912).
      sessionWaiting: false,
      waitingCause: null,
    });
    // Looking created nothing.
    expect(await adminDb.planChangeSession.count()).toBe(1);

    // Once their session ENDS the card is free, and the read says nothing is held.
    await endIt(theirs.id);
    const after = await contextualPlanningService.getSessionForWorkItem(
      { anchorId: item.id },
      pctxFor(fx.ownerId),
    );
    expect(after.heldBy).toBeNull();
  });

  it('refuses another member with WHO and FREES BY (AMENDMENT 23 §4)', async () => {
    const key = await anchor();
    const scope = buildScope([key]);
    await planChangeSessionsService.startWithFirstTurn(await teammate(), scope, 'theirs');
    const lock = await adminDb.planTargetLock.findFirstOrThrow({
      where: { workItem: { identifier: key } },
    });

    const err = (await planChangeSessionsService
      .startWithFirstTurn(pctxFor(fx.ownerId), scope, 'mine')
      .catch((e: unknown) => e)) as PlanTargetLockedError;

    expect(err).toBeInstanceOf(PlanTargetLockedError);
    expect(err.holderSessionId).toBe(lock.sessionId);
    expect(err.freesBy).toEqual(new Date(lock.expiresAt!.getTime() + 5 * MINUTE));
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

describe('the end and the scope notice, read by id (AMENDMENT 23 §1; MOTIR-6024)', () => {
  it('names who ENDED a person-ended session, and nobody for an unknown id', async () => {
    const started = await planChangeSessionsService.startWithFirstTurn(
      pctxFor(fx.ownerId),
      PROJECT_SCOPE,
      'Split the import story.',
    );
    await planSessionEndService.endSession(started.id, 'declined', {
      workspaceId: fx.workspaceId,
      endedById: fx.ownerId,
    });
    const owner = await adminDb.user.findUniqueOrThrow({ where: { id: fx.ownerId } });

    const read = await planChangeSessionsService.getById(pctxFor(fx.ownerId), started.id);
    expect(read.endReason).toBe('declined');
    expect(read.endedBy).toEqual({ id: owner.id, name: owner.name });

    await expect(
      withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        planChangeSessionRepository.findEnder('pcs_missing', fx.workspaceId, tx),
      ),
    ).resolves.toBeNull();
  });

  it('the scope notice skips the session it was asked to exclude', async () => {
    const older = await planChangeSessionsService.startWithFirstTurn(
      pctxFor(fx.ownerId),
      PROJECT_SCOPE,
      'First conversation.',
    );
    await endIt(older.id);
    const newer = await planChangeSessionsService.startWithFirstTurn(
      pctxFor(fx.ownerId),
      PROJECT_SCOPE,
      'Second conversation.',
    );

    const latest = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planChangeSessionRepository.findLatestConversationInScope(
        fx.projectId,
        PROJECT_SCOPE.scopeKey,
        fx.workspaceId,
        newer.id,
        tx,
      ),
    );
    expect(latest?.id).toBe(older.id);
  });

  it('an empty hidden set withholds no plan and reads nothing', async () => {
    await expect(
      withWorkspaceServiceContext(fx.workspaceId, (tx) =>
        planChangeSessionRepository.isPlanWithheld('plan_any', [], tx),
      ),
    ).resolves.toBe(false);
  });
});
