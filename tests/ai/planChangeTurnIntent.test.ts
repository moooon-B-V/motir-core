import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeScope } from '@/lib/planChange/scope';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { EmptyPlanChangeTurnError, PlanChangeTurnNotFoundError } from '@/lib/planChange/errors';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
import { addressOf, openTestSession } from '../helpers/planSession';
import { truncateAuthTables } from '../helpers/db';

// The conversation store's INTENT + CITATION extension (Story MOTIR-1343 ·
// MOTIR-1818), against a REAL Postgres — the motir-core convention. Only the
// motir-ai boundary client is mocked, the same exception every AI service test
// takes; the rows, the row lock, the `(session_id, seq)` unique, the workspace
// scoping and the citation resolve all run for real.
//
// The contract under test is `docs/decisions/conversation-turn-intent.md`
// (decided by MOTIR-1816). What these prove, per the card's criteria:
//
//   * `intent` is SERVER-RESOLVED — the append writes what its CALLER decided,
//     and the shipped plan-change append (which decides nothing) leaves it null;
//   * the ANSWER turn appends through the SAME row-locked, `turnCount`-re-reading
//     transaction as the user append — asserted by driving two simultaneous
//     appends and requiring two ordered turns, not a `seq` collision;
//   * the answer append is IDEMPOTENT on its job id, so a replayed settle is a
//     no-op rather than a duplicate bubble;
//   * citations are VALIDATED against this project's work items before they
//     persist — an invented key and a cross-PROJECT key are both dropped;
//   * a correction re-runs the SAME turn: the intent moves, `intentCorrected`
//     latches, and no second `user` turn appears;
//   * the shipped plan-change path is behaviourally unchanged.

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

// The session each case works on (MOTIR-6028). Every write names its session by
// id now that the scope-keyed wrappers are gone; `openCurrent` opens (or resumes)
// it the way the public `open` doors do and remembers its address.
let current: { sessionId: string } = { sessionId: '' };
async function openCurrent(pctx: ProjectContext, scope?: PlanChangeScope) {
  const session = await openTestSession(pctx, scope);
  current = addressOf(session);
  return session;
}

function projectCtx(fx: WorkItemFixture): ProjectContext {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

/** The thread's rows, straight from the repository — the persisted truth, not
 *  the DTO's view of it. Bound, because `work_item`/`plan_change_turn` are
 *  workspace-keyed and an unbound read under `motir_app` returns an empty list
 *  with no error (MOTIR-2846's shape). */
async function threadRows(fx: WorkItemFixture) {
  return withWorkspaceServiceContext(fx.workspaceId, async (tx) => {
    const session = await planChangeSessionRepository.findByIdInProject(
      current.sessionId,
      fx.projectId,
      fx.workspaceId,
      tx,
    );
    return planChangeTurnRepository.listBySessionId(session!.id, fx.workspaceId, tx);
  });
}

let fx: WorkItemFixture;

beforeEach(async () => {
  current = { sessionId: '' };
  await truncateAuthTables();
  fx = await makeWorkItemFixture();
});

afterAll(async () => {
  await db.$disconnect();
  await adminDb.$disconnect();
});

describe('a user turn carries the SERVER-RESOLVED intent', () => {
  it('writes the intent its caller resolved, and defaults to null when nobody did', async () => {
    const ctx = projectCtx(fx);
    await openCurrent(ctx);

    // The shipped plan-change append passes no intent — its turns stay null,
    // exactly as every turn written before the model existed does. That is why
    // the migration back-fills nothing: a back-fill would assert a
    // classification that never ran.
    await planChangeSessionsService.appendTurn('Split the billing epic', ctx, current);
    // The ask path passes what motir-ai resolved.
    await planChangeSessionsService.appendTurn('Why is MOTIR-1342 blocked?', ctx, current, {
      intent: 'ask',
    });

    const rows = await threadRows(fx);
    expect(rows.map((r) => r.intent)).toEqual([null, 'ask']);
    expect(rows.every((r) => r.intentCorrected === false)).toBe(true);
    expect(rows.every((r) => r.citations.length === 0)).toBe(true);
  });

  it('surfaces the intent on the DTO so the rail can follow the latest turn', async () => {
    const ctx = projectCtx(fx);
    await openCurrent(ctx);
    const dto = await planChangeSessionsService.appendTurn(
      'Which stories are blocked?',
      ctx,
      current,
      {
        intent: 'ask',
      },
    );
    expect(dto.turns.at(-1)).toMatchObject({
      role: 'user',
      intent: 'ask',
      intentCorrected: false,
      citations: [],
    });
  });
});

describe('the ANSWER turn', () => {
  it('appends as an `assistant` turn carrying its citations', async () => {
    const ctx = projectCtx(fx);
    await openCurrent(ctx);
    const cited = await createTestWorkItem(fx, { kind: 'story', title: 'Billing' });

    await planChangeSessionsService.appendTurn('Which stories are blocked?', ctx, current, {
      intent: 'ask',
    });
    const dto = await planChangeSessionsService.appendAnswerTurn(
      { jobId: 'job-ask-1', body: 'One story is blocked.', citations: [cited.identifier] },
      ctx,
      current,
    );

    const answer = dto.turns.at(-1)!;
    expect(answer.role).toBe('assistant');
    expect(answer.jobId).toBe('job-ask-1');
    expect(answer.citations).toEqual([cited.identifier]);
    // An answer has no intent of its own — the intent belongs to the turn that
    // ASKED, the same way `authorId` belongs only to a user turn.
    expect(answer.intent).toBeNull();
    // Resolved once for the whole thread, so the rail renders a citation through
    // the shipped `WorkItemRefChip` path rather than a second treatment.
    expect(
      Object.values(dto.workItemRefs)
        .filter((r) => r.accessible)
        .map((r) => r.identifier),
    ).toContain(cited.identifier);
  });

  it('is IDEMPOTENT on the job id — a replayed settle appends nothing', async () => {
    const ctx = projectCtx(fx);
    await openCurrent(ctx);

    await planChangeSessionsService.appendAnswerTurn(
      { jobId: 'job-ask-1', body: 'The first answer.' },
      ctx,
      current,
    );
    const second = await planChangeSessionsService.appendAnswerTurn(
      { jobId: 'job-ask-1', body: 'The first answer.' },
      ctx,
      current,
    );

    expect(second.turns.filter((t) => t.role === 'assistant')).toHaveLength(1);
    expect(second.turnCount).toBe(1);
  });

  it('refuses an empty body — an answer with nothing in it is not an answer', async () => {
    const ctx = projectCtx(fx);
    await openCurrent(ctx);
    await expect(
      planChangeSessionsService.appendAnswerTurn({ jobId: 'job-ask-1', body: '   ' }, ctx, current),
    ).rejects.toBeInstanceOf(EmptyPlanChangeTurnError);
  });

  it('records an honest NO-ANSWER with no citations rather than citing loosely', async () => {
    const ctx = projectCtx(fx);
    await openCurrent(ctx);
    const dto = await planChangeSessionsService.appendAnswerTurn(
      {
        jobId: 'job-ask-1',
        body: 'The plan and the code graph do not answer that.',
        citations: [],
      },
      ctx,
      current,
    );
    expect(dto.turns.at(-1)!.citations).toEqual([]);
  });
});

describe('citations are validated before they persist', () => {
  it('drops a key that names no work item, and keeps the ones that do — in citation order', async () => {
    const ctx = projectCtx(fx);
    await openCurrent(ctx);
    const a = await createTestWorkItem(fx, { kind: 'story', title: 'A' });
    const b = await createTestWorkItem(fx, { kind: 'story', title: 'B' });

    const dto = await planChangeSessionsService.appendAnswerTurn(
      {
        jobId: 'job-ask-1',
        body: 'Two stories.',
        // A model-invented key sits between two real ones, and a duplicate
        // follows: the survivor list must keep the ANSWER's order and dedupe.
        citations: [b.identifier, `${fx.projectIdentifier}-99999`, a.identifier, b.identifier],
      },
      ctx,
      current,
    );

    expect(dto.turns.at(-1)!.citations).toEqual([b.identifier, a.identifier]);
  });

  it('drops a citation that resolves in ANOTHER project — a chip must never cross a tenant', async () => {
    const ctx = projectCtx(fx);
    await openCurrent(ctx);
    const mine = await createTestWorkItem(fx, { kind: 'story', title: 'Mine' });

    // A second, independent tenant with an item of its own. The resolve is
    // `projectId`-scoped, so its identifier simply does not come back — the
    // citation is dropped rather than persisted as a chip that opens nothing (or,
    // worse, something belonging to somebody else).
    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const theirs = await createTestWorkItem(other, { kind: 'story', title: 'Theirs' });

    const dto = await planChangeSessionsService.appendAnswerTurn(
      { jobId: 'job-ask-1', body: 'One story.', citations: [theirs.identifier, mine.identifier] },
      ctx,
      current,
    );

    expect(dto.turns.at(-1)!.citations).toEqual([mine.identifier]);
  });
});

describe('a correction re-runs the SAME turn', () => {
  it('moves the intent, latches `intentCorrected`, and appends no second user turn', async () => {
    const ctx = projectCtx(fx);
    await openCurrent(ctx);
    const asked = await planChangeSessionsService.appendTurn(
      'Split the billing epic',
      ctx,
      current,
      {
        intent: 'ask',
      },
    );
    const turnId = asked.turns.at(-1)!.id;

    const corrected = await planChangeSessionsService.recordTurnIntent(
      turnId,
      'plan_change',
      ctx,
      {
        corrected: true,
      },
      current,
    );

    // The person said one thing once: one turn, re-run, not two.
    expect(corrected.turns.filter((t) => t.role === 'user')).toHaveLength(1);
    expect(corrected.turnCount).toBe(1);
    expect(corrected.turns.at(-1)).toMatchObject({
      id: turnId,
      body: 'Split the billing epic',
      intent: 'plan_change',
      intentCorrected: true,
    });
  });

  it('records a REDIRECT without claiming a correction — the two are different facts', async () => {
    const ctx = projectCtx(fx);
    await openCurrent(ctx);
    const asked = await planChangeSessionsService.appendTurn(
      'Split the billing epic',
      ctx,
      current,
      {
        intent: 'ask',
      },
    );
    const turnId = asked.turns.at(-1)!.id;

    // The ask job classified the turn as a plan change before anyone saw an
    // answer. The disposition moves; nothing was corrected, because nothing was
    // ever shown to be wrong.
    const redirected = await planChangeSessionsService.recordTurnIntent(
      turnId,
      'plan_change',
      ctx,
      {},
      current,
    );
    expect(redirected.turns.at(-1)).toMatchObject({
      intent: 'plan_change',
      intentCorrected: false,
    });
  });

  it('LATCHES the flag — a later redirect does not un-record an earlier correction', async () => {
    const ctx = projectCtx(fx);
    await openCurrent(ctx);
    const asked = await planChangeSessionsService.appendTurn('Split it', ctx, current, {
      intent: 'ask',
    });
    const turnId = asked.turns.at(-1)!.id;

    await planChangeSessionsService.recordTurnIntent(
      turnId,
      'plan_change',
      ctx,
      {
        corrected: true,
      },
      current,
    );
    const again = await planChangeSessionsService.recordTurnIntent(turnId, 'ask', ctx, {}, current);

    expect(again.turns.at(-1)).toMatchObject({ intent: 'ask', intentCorrected: true });
  });

  it('refuses a turn id that is not on this thread', async () => {
    const ctx = projectCtx(fx);
    await openCurrent(ctx);
    await expect(
      planChangeSessionsService.recordTurnIntent('no-such-turn', 'ask', ctx, {}, current),
    ).rejects.toBeInstanceOf(PlanChangeTurnNotFoundError);
  });

  it('refuses a turn belonging to ANOTHER tenant, as absent rather than forbidden', async () => {
    const ctx = projectCtx(fx);
    const mine = addressOf(await openCurrent(ctx));

    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const otherCtx = projectCtx(other);
    await openCurrent(otherCtx);
    const theirs = await planChangeSessionsService.appendTurn('Their turn', otherCtx, current);
    const theirTurnId = theirs.turns.at(-1)!.id;

    // The lookup is scoped by session AND workspace, so a foreign turn is simply
    // absent from OUR session — the no-existence-leak posture, not a 403.
    await expect(
      planChangeSessionsService.recordTurnIntent(theirTurnId, 'ask', ctx, {}, mine),
    ).rejects.toBeInstanceOf(PlanChangeTurnNotFoundError);
  });
});

describe('the answer append shares the SHIPPED row-locked allocation', () => {
  it('SERIALIZES a concurrent user append and answer append into two ordered turns', async () => {
    const ctx = projectCtx(fx);
    await openCurrent(ctx);

    // Both read the same `turnCount` before either commits. Without the
    // `SELECT … FOR UPDATE` + re-read they would both allocate seq 0, and the
    // `(session_id, seq)` unique would surface as a raw Prisma error rather than
    // as two turns. This is the criterion that would fail if the answer append
    // grew a SECOND, unlocked path of its own.
    await Promise.all([
      planChangeSessionsService.appendTurn('Which stories are blocked?', ctx, current, {
        intent: 'ask',
      }),
      planChangeSessionsService.appendAnswerTurn(
        { jobId: 'job-ask-1', body: 'One is.' },
        ctx,
        current,
      ),
    ]);

    const rows = await threadRows(fx);
    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
    expect(rows.map((r) => r.role).sort()).toEqual(['assistant', 'user']);

    const session = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planChangeSessionRepository.findByIdInProject(
        current.sessionId,
        fx.projectId,
        fx.workspaceId,
        tx,
      ),
    );
    expect(session!.turnCount).toBe(2);
  });

  it('SERIALIZES two concurrent answer appends for DIFFERENT jobs', async () => {
    const ctx = projectCtx(fx);
    await openCurrent(ctx);

    await Promise.all([
      planChangeSessionsService.appendAnswerTurn({ jobId: 'job-a', body: 'A' }, ctx, current),
      planChangeSessionsService.appendAnswerTurn({ jobId: 'job-b', body: 'B' }, ctx, current),
    ]);

    const rows = await threadRows(fx);
    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
    expect(rows.map((r) => r.body).sort()).toEqual(['A', 'B']);
  });

  it('lets two concurrent REPLAYS of one job through as a single turn (the skip is under the lock)', async () => {
    const ctx = projectCtx(fx);
    await openCurrent(ctx);

    await Promise.all([
      planChangeSessionsService.appendAnswerTurn({ jobId: 'job-same', body: 'Once' }, ctx, current),
      planChangeSessionsService.appendAnswerTurn({ jobId: 'job-same', body: 'Once' }, ctx, current),
    ]);

    const rows = await threadRows(fx);
    expect(rows).toHaveLength(1);
  });
});

describe('the shipped plan-change path is behaviourally unchanged', () => {
  it('appends and accumulates exactly as before, with a null intent throughout', async () => {
    const ctx = projectCtx(fx);
    const opened = await openCurrent(ctx);
    expect(opened.turns).toEqual([]);

    await planChangeSessionsService.appendTurn('Add auth to the billing epic', ctx, current);
    const after = await planChangeSessionsService.appendTurn('Make them smaller', ctx, current);

    expect(after.turnCount).toBe(2);
    expect(after.turns.map((t) => t.body)).toEqual([
      'Add auth to the billing epic',
      'Make them smaller',
    ]);
    expect(after.turns.every((t) => t.intent === null)).toBe(true);
    expect(after.turns.every((t) => t.intentCorrected === false)).toBe(true);
    expect(after.turns.every((t) => t.citations.length === 0)).toBe(true);
  });
});
