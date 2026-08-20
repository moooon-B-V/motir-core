import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { withWorkspaceServiceContext } from '@/lib/workspaces/context';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { EmptyPlanChangeTurnError, PlanChangeTurnNotFoundError } from '@/lib/planChange/errors';
import { PROJECT_SCOPE_KEY } from '@/lib/planChange/scope';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { adminDb } from '../helpers/adminDb';
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
    const session = await planChangeSessionRepository.findByProjectAndScope(
      fx.projectId,
      PROJECT_SCOPE_KEY,
      fx.workspaceId,
      tx,
    );
    return planChangeTurnRepository.listBySessionId(session!.id, fx.workspaceId, tx);
  });
}

let fx: WorkItemFixture;

beforeEach(async () => {
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
    await planChangeSessionsService.getOrCreateForProject(ctx);

    // The shipped plan-change append passes no intent — its turns stay null,
    // exactly as every turn written before the model existed does. That is why
    // the migration back-fills nothing: a back-fill would assert a
    // classification that never ran.
    await planChangeSessionsService.appendTurn('Split the billing epic', ctx);
    // The ask path passes what motir-ai resolved.
    await planChangeSessionsService.appendTurn('Why is MOTIR-1342 blocked?', ctx, undefined, {
      intent: 'ask',
    });

    const rows = await threadRows(fx);
    expect(rows.map((r) => r.intent)).toEqual([null, 'ask']);
    expect(rows.every((r) => r.intentCorrected === false)).toBe(true);
    expect(rows.every((r) => r.citations.length === 0)).toBe(true);
  });

  it('surfaces the intent on the DTO so the rail can follow the latest turn', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);
    const dto = await planChangeSessionsService.appendTurn(
      'Which stories are blocked?',
      ctx,
      undefined,
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
    await planChangeSessionsService.getOrCreateForProject(ctx);
    const cited = await createTestWorkItem(fx, { kind: 'story', title: 'Billing' });

    await planChangeSessionsService.appendTurn('Which stories are blocked?', ctx, undefined, {
      intent: 'ask',
    });
    const dto = await planChangeSessionsService.appendAnswerTurn(
      { jobId: 'job-ask-1', body: 'One story is blocked.', citations: [cited.identifier] },
      ctx,
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
    await planChangeSessionsService.getOrCreateForProject(ctx);

    await planChangeSessionsService.appendAnswerTurn(
      { jobId: 'job-ask-1', body: 'The first answer.' },
      ctx,
    );
    const second = await planChangeSessionsService.appendAnswerTurn(
      { jobId: 'job-ask-1', body: 'The first answer.' },
      ctx,
    );

    expect(second.turns.filter((t) => t.role === 'assistant')).toHaveLength(1);
    expect(second.turnCount).toBe(1);
  });

  it('refuses an empty body — an answer with nothing in it is not an answer', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);
    await expect(
      planChangeSessionsService.appendAnswerTurn({ jobId: 'job-ask-1', body: '   ' }, ctx),
    ).rejects.toBeInstanceOf(EmptyPlanChangeTurnError);
  });

  it('records an honest NO-ANSWER with no citations rather than citing loosely', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);
    const dto = await planChangeSessionsService.appendAnswerTurn(
      {
        jobId: 'job-ask-1',
        body: 'The plan and the code graph do not answer that.',
        citations: [],
      },
      ctx,
    );
    expect(dto.turns.at(-1)!.citations).toEqual([]);
  });
});

describe('citations are validated before they persist', () => {
  it('drops a key that names no work item, and keeps the ones that do — in citation order', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);
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
    );

    expect(dto.turns.at(-1)!.citations).toEqual([b.identifier, a.identifier]);
  });

  it('drops a citation that resolves in ANOTHER project — a chip must never cross a tenant', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);
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
    );

    expect(dto.turns.at(-1)!.citations).toEqual([mine.identifier]);
  });
});

describe('a correction re-runs the SAME turn', () => {
  it('moves the intent, latches `intentCorrected`, and appends no second user turn', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);
    const asked = await planChangeSessionsService.appendTurn(
      'Split the billing epic',
      ctx,
      undefined,
      {
        intent: 'ask',
      },
    );
    const turnId = asked.turns.at(-1)!.id;

    const corrected = await planChangeSessionsService.recordTurnIntent(turnId, 'plan_change', ctx, {
      corrected: true,
    });

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
    await planChangeSessionsService.getOrCreateForProject(ctx);
    const asked = await planChangeSessionsService.appendTurn(
      'Split the billing epic',
      ctx,
      undefined,
      {
        intent: 'ask',
      },
    );
    const turnId = asked.turns.at(-1)!.id;

    // The ask job classified the turn as a plan change before anyone saw an
    // answer. The disposition moves; nothing was corrected, because nothing was
    // ever shown to be wrong.
    const redirected = await planChangeSessionsService.recordTurnIntent(turnId, 'plan_change', ctx);
    expect(redirected.turns.at(-1)).toMatchObject({
      intent: 'plan_change',
      intentCorrected: false,
    });
  });

  it('LATCHES the flag — a later redirect does not un-record an earlier correction', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);
    const asked = await planChangeSessionsService.appendTurn('Split it', ctx, undefined, {
      intent: 'ask',
    });
    const turnId = asked.turns.at(-1)!.id;

    await planChangeSessionsService.recordTurnIntent(turnId, 'plan_change', ctx, {
      corrected: true,
    });
    const again = await planChangeSessionsService.recordTurnIntent(turnId, 'ask', ctx);

    expect(again.turns.at(-1)).toMatchObject({ intent: 'ask', intentCorrected: true });
  });

  it('refuses a turn id that is not on this thread', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);
    await expect(
      planChangeSessionsService.recordTurnIntent('no-such-turn', 'ask', ctx),
    ).rejects.toBeInstanceOf(PlanChangeTurnNotFoundError);
  });

  it('refuses a turn belonging to ANOTHER tenant, as absent rather than forbidden', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);

    const other = await makeWorkItemFixture({ name: 'Other', identifier: 'OTHR' });
    const otherCtx = projectCtx(other);
    await planChangeSessionsService.getOrCreateForProject(otherCtx);
    const theirs = await planChangeSessionsService.appendTurn('Their turn', otherCtx);
    const theirTurnId = theirs.turns.at(-1)!.id;

    // The lookup is scoped by session AND workspace, so a foreign turn is simply
    // absent — the no-existence-leak posture, not a 403.
    await expect(
      planChangeSessionsService.recordTurnIntent(theirTurnId, 'ask', ctx),
    ).rejects.toBeInstanceOf(PlanChangeTurnNotFoundError);
  });
});

describe('the answer append shares the SHIPPED row-locked allocation', () => {
  it('SERIALIZES a concurrent user append and answer append into two ordered turns', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);

    // Both read the same `turnCount` before either commits. Without the
    // `SELECT … FOR UPDATE` + re-read they would both allocate seq 0, and the
    // `(session_id, seq)` unique would surface as a raw Prisma error rather than
    // as two turns. This is the criterion that would fail if the answer append
    // grew a SECOND, unlocked path of its own.
    await Promise.all([
      planChangeSessionsService.appendTurn('Which stories are blocked?', ctx, undefined, {
        intent: 'ask',
      }),
      planChangeSessionsService.appendAnswerTurn({ jobId: 'job-ask-1', body: 'One is.' }, ctx),
    ]);

    const rows = await threadRows(fx);
    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
    expect(rows.map((r) => r.role).sort()).toEqual(['assistant', 'user']);

    const session = await withWorkspaceServiceContext(fx.workspaceId, (tx) =>
      planChangeSessionRepository.findByProjectAndScope(
        fx.projectId,
        PROJECT_SCOPE_KEY,
        fx.workspaceId,
        tx,
      ),
    );
    expect(session!.turnCount).toBe(2);
  });

  it('SERIALIZES two concurrent answer appends for DIFFERENT jobs', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);

    await Promise.all([
      planChangeSessionsService.appendAnswerTurn({ jobId: 'job-a', body: 'A' }, ctx),
      planChangeSessionsService.appendAnswerTurn({ jobId: 'job-b', body: 'B' }, ctx),
    ]);

    const rows = await threadRows(fx);
    expect(rows.map((r) => r.seq)).toEqual([0, 1]);
    expect(rows.map((r) => r.body).sort()).toEqual(['A', 'B']);
  });

  it('lets two concurrent REPLAYS of one job through as a single turn (the skip is under the lock)', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);

    await Promise.all([
      planChangeSessionsService.appendAnswerTurn({ jobId: 'job-same', body: 'Once' }, ctx),
      planChangeSessionsService.appendAnswerTurn({ jobId: 'job-same', body: 'Once' }, ctx),
    ]);

    const rows = await threadRows(fx);
    expect(rows).toHaveLength(1);
  });
});

describe('the shipped plan-change path is behaviourally unchanged', () => {
  it('appends and accumulates exactly as before, with a null intent throughout', async () => {
    const ctx = projectCtx(fx);
    const opened = await planChangeSessionsService.getOrCreateForProject(ctx);
    expect(opened.turns).toEqual([]);

    await planChangeSessionsService.appendTurn('Add auth to the billing epic', ctx);
    const after = await planChangeSessionsService.appendTurn('Make them smaller', ctx);

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
