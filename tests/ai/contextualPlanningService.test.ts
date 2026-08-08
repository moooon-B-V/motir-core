import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import type { ProjectContext } from '@/lib/projects';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planChangeTurnRepository } from '@/lib/repositories/planChangeTurnRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { TooManyPlanChangeTargetsError } from '@/lib/planChange/errors';
import { buildScope, MAX_SCOPE_TARGETS, PROJECT_SCOPE_KEY } from '@/lib/planChange/scope';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import { ProjectAccessDeniedError } from '@/lib/projects/errors';
import {
  createTestWorkItem,
  makeWorkItemFixture,
  type WorkItemFixture,
} from '../fixtures/workItemFixtures';
import { truncateAuthTables } from '../helpers/db';

// contextualPlanningService — the motir-core side of CONTEXTUAL PLANNING
// (7.12.3 · MOTIR-909) against a REAL Postgres. Only the motir-ai BOUNDARY client
// is mocked (the standing exception for AI service tests); the work-item
// resolution, the 6.4 permission gate, the session rows, the scope unique and the
// turn ordering all run for real.
//
// What these prove, per the card's acceptance criteria:
//   * the turn resolves its target(s), opens/continues a chat session and submits
//     the contextual job, returning `{ jobId, sessionId }`;
//   * the route contract is MULTI-TARGET — one or more ids, single-target being
//     the 1-element case — and EVERY target is permission-checked (cross-tenant
//     and non-browsable resolve as 404-shaped, never 403);
//   * the session is scoped BY the target set: the same set resumes the SAME
//     thread (in any order), a different set is a different thread, and neither
//     touches the project-wide 7.30 conversation;
//   * it reuses the shipped chat substrate — no parallel stack, no new job kind:
//     the submit is an ordinary `augment` carrying `context.targetKeys`;
//   * NO plan write happens (persist is the 7.13.5 gate).

const submitJobMock = vi.fn(async (..._args: unknown[]) => ({ jobId: 'job-contextual-1' }));
const streamJobMock = vi.fn();
const getJobMock = vi.fn();

vi.mock('@/lib/ai/motirAiClient', () => ({
  submitJob: (...args: unknown[]) => submitJobMock(...(args as [])),
  streamJob: (...args: unknown[]) => streamJobMock(...(args as [])),
  getJob: (...args: unknown[]) => getJobMock(...(args as [])),
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

const { contextualPlanningService } = await import('@/lib/services/contextualPlanningService');
const { planChangeSessionsService } = await import('@/lib/services/planChangeSessionsService');

function projectCtx(fx: WorkItemFixture): ProjectContext {
  return {
    userId: fx.ownerId,
    workspaceId: fx.workspaceId,
    projectId: fx.projectId,
    project: fx.project,
  };
}

/** The context bag of the Nth `submitJob` call — where `targetKeys` rides. */
function submittedContext(call = 0): Record<string, unknown> {
  return submitJobMock.mock.calls[call]![2] as Record<string, unknown>;
}
function submittedKind(call = 0): string {
  return submitJobMock.mock.calls[call]![0] as string;
}

let fx: WorkItemFixture;
let story: Awaited<ReturnType<typeof createTestWorkItem>>;

beforeEach(async () => {
  await truncateAuthTables();
  submitJobMock.mockClear();
  streamJobMock.mockClear();
  getJobMock.mockReset();
  submitJobMock.mockResolvedValue({ jobId: 'job-contextual-1' });
  fx = await makeWorkItemFixture();
  story = await createTestWorkItem(fx, { kind: 'story', title: 'Billing' });
});

afterAll(async () => {
  await db.$disconnect();
});

// ───────────────────────── scope canonicalization (pure) ─────────────────────────

describe('buildScope — the anchor set is the thread’s identity', () => {
  it('is order- and case-insensitive, and dedupes', () => {
    // The point of a CANONICAL key: two users naming the same items differently
    // must land on the SAME conversation, not fork a second one.
    const a = buildScope(['MOTIR-9', 'MOTIR-4']);
    const b = buildScope(['motir-4', 'MOTIR-9', ' MOTIR-4 ']);
    expect(a.scopeKey).toBe(b.scopeKey);
    expect(a.targetKeys).toEqual(['MOTIR-4', 'MOTIR-9']);
  });

  it('an empty set is the PROJECT-wide scope — the shipped 7.30 thread', () => {
    expect(buildScope([]).scopeKey).toBe(PROJECT_SCOPE_KEY);
    expect(buildScope(['', '  ']).targetKeys).toEqual([]);
  });
});

// ───────────────────────── submit + session ─────────────────────────

describe('contextualPlanningService.planFromWorkItem', () => {
  it('opens a session scoped to the item and submits the contextual job', async () => {
    const ctx = projectCtx(fx);
    const result = await contextualPlanningService.planFromWorkItem(
      { anchorId: story.id, prompt: 'Break this into subtasks' },
      ctx,
    );

    expect(result.jobId).toBe('job-contextual-1');
    expect(result.sessionId).toBeTruthy();
    // The session the panel resumes on is the one anchored at this item.
    expect(result.session.targetKeys).toEqual([story.identifier]);

    const row = await planChangeSessionRepository.findByProjectAndScope(
      fx.projectId,
      story.identifier,
      fx.workspaceId,
    );
    expect(row?.id).toBe(result.sessionId);
    expect(row?.targetKeys).toEqual([story.identifier]);
  });

  it('submits a SHIPPED 7.11 kind carrying context.targetKeys — no new job kind', async () => {
    // The whole contract with motir-ai (7.12.2 · MOTIR-908): the anchor set is
    // what makes the submit contextual. `augment` is the additions-only FLOOR the
    // engine falls back to when the turn text carries no signal — core does not
    // pre-classify, so it must not send anything else.
    await contextualPlanningService.planFromWorkItem(
      { anchorId: story.id, prompt: 'Re-plan this because the API changed' },
      projectCtx(fx),
    );

    expect(submitJobMock).toHaveBeenCalledTimes(1);
    expect(submittedKind()).toBe('augment');
    expect(submittedContext()['targetKeys']).toEqual([story.identifier]);
    // The re-plan REASON is the turn text itself — there is no separate param.
    expect(submittedContext()['prompt']).toBe('Re-plan this because the API changed');
    expect(submittedContext()).not.toHaveProperty('reason');
  });

  it('accepts a target SET and anchors the thread at all of them', async () => {
    const other = await createTestWorkItem(fx, { kind: 'story', title: 'Auth' });
    const result = await contextualPlanningService.planFromWorkItem(
      { anchorId: story.id, targetKeys: [other.identifier], prompt: 'Merge these' },
      projectCtx(fx),
    );

    const expected = [story.identifier, other.identifier].sort();
    expect(result.session.targetKeys).toEqual(expected);
    expect(submittedContext()['targetKeys']).toEqual(expected);
  });

  it('ignores blank entries in the target set rather than resolving them', async () => {
    // A picker that emits an empty chip must not become a lookup for "" (which
    // would 404 the whole turn); it is simply not a target.
    const result = await contextualPlanningService.planFromWorkItem(
      { anchorId: story.id, targetKeys: ['', '   '], prompt: 'x' },
      projectCtx(fx),
    );
    expect(result.session.targetKeys).toEqual([story.identifier]);
  });

  it('RESUMES the same thread for the same set, whichever member it is opened from', async () => {
    const other = await createTestWorkItem(fx, { kind: 'story', title: 'Auth' });
    const ctx = projectCtx(fx);

    const first = await contextualPlanningService.planFromWorkItem(
      { anchorId: story.id, targetKeys: [other.identifier], prompt: 'one' },
      ctx,
    );
    // Same SET, opened from the other member and listed in the other order.
    const second = await contextualPlanningService.planFromWorkItem(
      { anchorId: other.id, targetKeys: [story.identifier], prompt: 'two' },
      ctx,
    );

    expect(second.sessionId).toBe(first.sessionId);
    // …and the thread ACCUMULATED — that is what makes it a conversation.
    const turns = await planChangeTurnRepository.listBySessionId(first.sessionId, fx.workspaceId);
    expect(turns.filter((t) => t.role === 'user').map((t) => t.body)).toEqual(['one', 'two']);
    expect(submittedContext(1)['prompt']).toContain('one');
    expect(submittedContext(1)['prompt']).toContain('two');
  });

  it('a DIFFERENT set is a different thread, and neither is the project-wide one', async () => {
    const other = await createTestWorkItem(fx, { kind: 'story', title: 'Auth' });
    const ctx = projectCtx(fx);

    const one = await contextualPlanningService.planFromWorkItem(
      { anchorId: story.id, prompt: 'a' },
      ctx,
    );
    const two = await contextualPlanningService.planFromWorkItem(
      { anchorId: other.id, prompt: 'b' },
      ctx,
    );
    const projectWide = await planChangeSessionsService.getOrCreateForProject(ctx);

    expect(new Set([one.sessionId, two.sessionId, projectWide.id]).size).toBe(3);
    expect(projectWide.targetKeys).toEqual([]);
  });

  it('the project-wide thread still submits WITHOUT targetKeys — 7.30 is untouched', async () => {
    const ctx = projectCtx(fx);
    await planChangeSessionsService.getOrCreateForProject(ctx);
    await planChangeSessionsService.appendTurn('Add auth to the billing epic', ctx);
    await planChangeSessionsService.submit(ctx);

    expect(submittedKind()).toBe('augment');
    expect(submittedContext()).not.toHaveProperty('targetKeys');
  });

  it('writes NO work item — this card submits and streams only', async () => {
    const before = await db.workItem.count({ where: { projectId: fx.projectId } });
    await contextualPlanningService.planFromWorkItem(
      { anchorId: story.id, prompt: 'Add three subtasks' },
      projectCtx(fx),
    );
    expect(await db.workItem.count({ where: { projectId: fx.projectId } })).toBe(before);
  });
});

// ───────────────────────── the per-target permission gate ─────────────────────────

describe('every target is permission-checked before it becomes planning context', () => {
  it('a CROSS-TENANT anchor is 404-shaped, never 403 (no existence leak)', async () => {
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const theirs = await createTestWorkItem(rival, { kind: 'story', title: 'Theirs' });

    await expect(
      contextualPlanningService.planFromWorkItem(
        { anchorId: theirs.id, prompt: 'x' },
        projectCtx(fx),
      ),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('a cross-tenant EXTRA target is rejected too — not silently dropped', async () => {
    // The failure mode this guards: filtering an unreadable target out would let a
    // multi-target turn quietly plan against a smaller set than the user asked for.
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const theirs = await createTestWorkItem(rival, { kind: 'story', title: 'Theirs' });

    await expect(
      contextualPlanningService.planFromWorkItem(
        { anchorId: story.id, targetKeys: [theirs.identifier], prompt: 'x' },
        projectCtx(fx),
      ),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('a NON-BROWSABLE project denies with the browse verdict (→ 404 at the route)', async () => {
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const theirs = await createTestWorkItem(rival, { kind: 'story', title: 'Theirs' });
    // A stranger inside the RIGHT tenant: the row resolves, the project does not.
    const ctx: ProjectContext = {
      userId: fx.ownerId,
      workspaceId: rival.workspaceId,
      projectId: rival.projectId,
      project: rival.project,
    };
    await expect(
      contextualPlanningService.planFromWorkItem({ anchorId: theirs.id, prompt: 'x' }, ctx),
    ).rejects.toBeInstanceOf(ProjectAccessDeniedError);
    expect(submitJobMock).not.toHaveBeenCalled();
  });

  it('an anchor from ANOTHER project in the same tenant is treated as absent', async () => {
    // Adopting it would silently plan against a different tree than the context
    // the turn was submitted under.
    const sibling = await makeWorkItemFixture({ name: 'Acme', identifier: 'OTHR' });
    const elsewhere = await createTestWorkItem(sibling, { kind: 'story', title: 'Elsewhere' });
    const ctx: ProjectContext = {
      userId: sibling.ownerId,
      workspaceId: sibling.workspaceId,
      projectId: fx.projectId,
      project: fx.project,
    };
    await expect(
      contextualPlanningService.planFromWorkItem({ anchorId: elsewhere.id, prompt: 'x' }, ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });

  it('bounds the anchor set BEFORE resolving it', async () => {
    const tooMany = Array.from(
      { length: MAX_SCOPE_TARGETS },
      (_, i) => `${fx.projectIdentifier}-${i + 50}`,
    );
    await expect(
      contextualPlanningService.planFromWorkItem(
        { anchorId: story.id, targetKeys: tooMany, prompt: 'x' },
        projectCtx(fx),
      ),
    ).rejects.toBeInstanceOf(TooManyPlanChangeTargetsError);
  });
});

// ───────────────────────── the stream channel ─────────────────────────

describe('streamPlanJob — the browser streams from CORE', () => {
  it('re-gates the anchor on subscribe, then relays the job stream', async () => {
    const sentinel = (async function* () {})();
    streamJobMock.mockReturnValue(sentinel);

    const relayed = await contextualPlanningService.streamPlanJob(
      story.id,
      'job-contextual-1',
      projectCtx(fx),
    );
    expect(relayed).toBe(sentinel);
    expect(streamJobMock).toHaveBeenCalledWith('job-contextual-1', expect.any(String));
  });

  it('refuses to stream against an anchor the actor cannot see', async () => {
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const theirs = await createTestWorkItem(rival, { kind: 'story', title: 'Theirs' });

    await expect(
      contextualPlanningService.streamPlanJob(theirs.id, 'job-contextual-1', projectCtx(fx)),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    expect(streamJobMock).not.toHaveBeenCalled();
  });

  it('refuses to stream against an anchor from ANOTHER project in the same tenant', async () => {
    // Same guard as the submit path: the stream is scoped to the context the turn
    // ran under, so an anchor outside it is absent rather than adopted.
    const sibling = await makeWorkItemFixture({ name: 'Acme', identifier: 'OTHR' });
    const elsewhere = await createTestWorkItem(sibling, { kind: 'story', title: 'Elsewhere' });
    const ctx: ProjectContext = {
      userId: sibling.ownerId,
      workspaceId: sibling.workspaceId,
      projectId: fx.projectId,
      project: fx.project,
    };
    await expect(
      contextualPlanningService.streamPlanJob(elsewhere.id, 'job-contextual-1', ctx),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
    expect(streamJobMock).not.toHaveBeenCalled();
  });
});

// ─────────── resume + resubmit — the entrance's two non-appending hops ───────────
//
// MOTIR-910's per-item entrance needs the conversation to SURVIVE a close (open
// the door again → the thread is still there) and a failed run (Retry re-sends
// what was already said). Both are anchored reads/writes that must NOT append.

describe('getSessionForWorkItem — resuming the item’s thread (MOTIR-910)', () => {
  it('returns null for an item that was never planned — and writes NO session row', async () => {
    const result = await contextualPlanningService.getSessionForWorkItem(
      { anchorId: story.id },
      projectCtx(fx),
    );
    expect(result.session).toBeNull();
    // Opening the door is not starting a conversation.
    expect(
      await planChangeSessionRepository.findByProjectAndScope(
        fx.projectId,
        buildScope([story.identifier]).scopeKey,
        fx.workspaceId,
      ),
    ).toBeNull();
  });

  it('returns the SAME thread a turn created, with its turns in order', async () => {
    await contextualPlanningService.planFromWorkItem(
      { anchorId: story.id, prompt: 'Break this up' },
      projectCtx(fx),
    );

    const { session } = await contextualPlanningService.getSessionForWorkItem(
      { anchorId: story.id },
      projectCtx(fx),
    );
    expect(session).not.toBeNull();
    expect(session!.targetKeys).toEqual([story.identifier]);
    expect(session!.turns.map((t) => t.role)).toEqual(['user', 'system']);
    expect(session!.turns[0]!.body).toBe('Break this up');
  });

  it('resumes by the CANONICAL anchor set — a multi-target thread resumes from either item', async () => {
    const other = await createTestWorkItem(fx, { kind: 'story', title: 'Auth' });
    await contextualPlanningService.planFromWorkItem(
      { anchorId: story.id, targetKeys: [other.identifier], prompt: 'Merge these' },
      projectCtx(fx),
    );

    const fromOther = await contextualPlanningService.getSessionForWorkItem(
      { anchorId: other.id, targetKeys: [story.identifier] },
      projectCtx(fx),
    );
    expect(fromOther.session?.targetKeys).toEqual([story.identifier, other.identifier].sort());
    // …while the SINGLE-item thread is a different conversation entirely.
    const single = await contextualPlanningService.getSessionForWorkItem(
      { anchorId: story.id },
      projectCtx(fx),
    );
    expect(single.session).toBeNull();
  });

  it('never resolves an anchor from another tenant — 404-shaped, not an empty read', async () => {
    const rival = await makeWorkItemFixture({ name: 'Rival', identifier: 'RIVL' });
    const theirs = await createTestWorkItem(rival, { kind: 'story', title: 'Theirs' });
    await expect(
      contextualPlanningService.getSessionForWorkItem({ anchorId: theirs.id }, projectCtx(fx)),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});

describe('resubmitFromWorkItem — Retry re-sends, it does not re-say (MOTIR-910)', () => {
  it('re-submits the accumulated intent WITHOUT appending a turn', async () => {
    await contextualPlanningService.planFromWorkItem(
      { anchorId: story.id, prompt: 'Break this up' },
      projectCtx(fx),
    );
    const before = await contextualPlanningService.getSessionForWorkItem(
      { anchorId: story.id },
      projectCtx(fx),
    );
    const userTurnsBefore = before.session!.turns.filter((t) => t.role === 'user');

    submitJobMock.mockResolvedValueOnce({ jobId: 'job-contextual-2' });
    const again = await contextualPlanningService.resubmitFromWorkItem(
      { anchorId: story.id },
      projectCtx(fx),
    );

    expect(again.jobId).toBe('job-contextual-2');
    expect(again.sessionId).toBe(before.session!.id);
    // The user said nothing new — the second run carries the SAME intent, and the
    // transcript does not duplicate their words.
    const userTurnsAfter = again.session.turns.filter((t) => t.role === 'user');
    expect(userTurnsAfter.map((t) => t.body)).toEqual(userTurnsBefore.map((t) => t.body));
    expect(submittedKind(1)).toBe(submittedKind(0));
    expect(submittedContext(1)['targetKeys']).toEqual([story.identifier]);
  });

  it('rejects a resubmit on an item with no thread yet — there is nothing to re-send', async () => {
    await expect(
      contextualPlanningService.resubmitFromWorkItem({ anchorId: story.id }, projectCtx(fx)),
    ).rejects.toThrow();
    expect(submitJobMock).not.toHaveBeenCalled();
  });
});

describe('recordPlannerTurnForWorkItem — the planner speaks on an ANCHORED thread (MOTIR-2226)', () => {
  it('files the utterance on the ITEM’s thread, resolved from its anchor set', async () => {
    const run = await contextualPlanningService.planFromWorkItem(
      { anchorId: story.id, prompt: 'add payments' },
      projectCtx(fx),
    );
    getJobMock.mockResolvedValue({
      jobId: run.jobId,
      status: 'succeeded',
      result: {
        turn: { action: 'ask', message: 'Which direction?', question: 'in, or out?' },
      },
      error: null,
    });

    const dto = await contextualPlanningService.recordPlannerTurnForWorkItem(
      { anchorId: story.id, jobId: run.jobId },
      projectCtx(fx),
    );

    // The anchored thread, NOT the project-wide one: the scope key is the
    // service's to compute, which is the whole reason this method exists.
    expect(dto.id).toBe(run.sessionId);
    const asked = dto.turns.filter((t) => t.role === 'assistant');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.question).toBe('in, or out?');
    expect(asked[0]!.jobId).toBe(run.jobId);
  });

  it('is idempotent per job here too — a replay adds nothing', async () => {
    const run = await contextualPlanningService.planFromWorkItem(
      { anchorId: story.id, prompt: 'add payments' },
      projectCtx(fx),
    );
    getJobMock.mockResolvedValue({
      jobId: run.jobId,
      status: 'succeeded',
      result: { turn: { action: 'draft', message: 'a report', question: null } },
      error: null,
    });

    await contextualPlanningService.recordPlannerTurnForWorkItem(
      { anchorId: story.id, jobId: run.jobId },
      projectCtx(fx),
    );
    const dto = await contextualPlanningService.recordPlannerTurnForWorkItem(
      { anchorId: story.id, jobId: run.jobId },
      projectCtx(fx),
    );

    expect(dto.turns.filter((t) => t.role === 'assistant')).toHaveLength(1);
  });

  it('VIEW-GATES the anchor set exactly as a turn does', async () => {
    const outsider = await makeWorkItemFixture({ name: 'Other', identifier: 'OTH' });
    await expect(
      contextualPlanningService.recordPlannerTurnForWorkItem(
        { anchorId: story.id, jobId: 'job-contextual-1' },
        projectCtx(outsider),
      ),
    ).rejects.toThrow();
  });
});

// ───────────────────── the planId seam (MOTIR-1745) ─────────────────────
//
// MOTIR-1743 made every plan-edit submit OPEN a `generating` Plan bound to the
// job by `sourceJobId`, and grew the submit result to `{ jobId, planId }` — but
// the contextual/session path dropped the `planId` on the floor, so the anchored
// rail could not name the Plan it must confirm. These assert the whole carry:
// the submit echoes the plan actually opened, the RESUME re-establishes it for a
// user who came back to an undecided proposal, and a failed submit yields
// neither a plan nor an id.
//
// The Plan rows here are REAL (only the motir-ai boundary is mocked), so
// "echoes the planId the Plan was opened with" is checked against the row, not
// against a stub of the layer under test.

describe('the contextual seam carries the job’s planId (MOTIR-1745)', () => {
  it('submit echoes the planId of the Plan actually opened for the job', async () => {
    const result = await contextualPlanningService.planFromWorkItem(
      { anchorId: story.id, prompt: 'Break this into subtasks' },
      projectCtx(fx),
    );

    expect(result.planId).toBeTruthy();
    const plan = await planRepository.findBySourceJobId(result.jobId, fx.workspaceId);
    // The id is the one bound to THIS job — not merely some plan that exists.
    expect(plan?.id).toBe(result.planId);
    expect(plan?.status).toBe('generating');
    expect(plan?.projectId).toBe(fx.projectId);
  });

  it('opens exactly ONE Plan per submit — the seam passes the id through, it does not re-open', async () => {
    // The regression this guards: "carry the planId" implemented by resolving or
    // creating a plan in the session service would double-open per turn.
    await contextualPlanningService.planFromWorkItem(
      { anchorId: story.id, prompt: 'Break this up' },
      projectCtx(fx),
    );

    expect(await db.plan.count({ where: { projectId: fx.projectId } })).toBe(1);

    submitJobMock.mockResolvedValueOnce({ jobId: 'job-contextual-2' });
    const again = await contextualPlanningService.resubmitFromWorkItem(
      { anchorId: story.id },
      projectCtx(fx),
    );

    // A SECOND run is a second proposal, so a second plan — bound to its own job.
    expect(await db.plan.count({ where: { projectId: fx.projectId } })).toBe(2);
    expect(again.planId).not.toBe(undefined);
    expect((await planRepository.findBySourceJobId('job-contextual-2', fx.workspaceId))?.id).toBe(
      again.planId,
    );
  });

  it('a RESUMED thread whose proposal is still undecided reports that plan', async () => {
    // The case the submit response cannot cover: the user closed the workspace
    // mid-review and came back holding neither the job nor the plan.
    const submitted = await contextualPlanningService.planFromWorkItem(
      { anchorId: story.id, prompt: 'Break this up' },
      projectCtx(fx),
    );

    const resumed = await contextualPlanningService.getSessionForWorkItem(
      { anchorId: story.id },
      projectCtx(fx),
    );

    expect(resumed.session).not.toBeNull();
    expect(resumed.planId).toBe(submitted.planId);
  });

  it('reports the LATEST submission’s plan when a thread submitted twice', async () => {
    await contextualPlanningService.planFromWorkItem(
      { anchorId: story.id, prompt: 'Break this up' },
      projectCtx(fx),
    );
    submitJobMock.mockResolvedValueOnce({ jobId: 'job-contextual-2' });
    const second = await contextualPlanningService.resubmitFromWorkItem(
      { anchorId: story.id },
      projectCtx(fx),
    );

    const resumed = await contextualPlanningService.getSessionForWorkItem(
      { anchorId: story.id },
      projectCtx(fx),
    );
    // The thread's `lastJobId` is what resolves — a retry supersedes the run it
    // replaced, so the rail confirms the newest proposal, never a stale one.
    expect(resumed.planId).toBe(second.planId);
  });

  it('reports NO plan once the proposal has been decided', async () => {
    const submitted = await contextualPlanningService.planFromWorkItem(
      { anchorId: story.id, prompt: 'Break this up' },
      projectCtx(fx),
    );

    // A decided plan is history, not a pending review — surfacing it would invite
    // a confirm of something already settled.
    for (const status of ['approved', 'declined'] as const) {
      await db.plan.update({ where: { id: submitted.planId }, data: { status } });
      const resumed = await contextualPlanningService.getSessionForWorkItem(
        { anchorId: story.id },
        projectCtx(fx),
      );
      expect(resumed.session).not.toBeNull();
      expect(resumed.planId).toBeNull();
    }
  });

  it('reports NO plan for a thread that exists but never submitted', async () => {
    const scope = buildScope([story.identifier]);
    await planChangeSessionsService.getOrCreateForScope(projectCtx(fx), scope);
    await planChangeSessionsService.appendTurn('Just typing', projectCtx(fx), scope.scopeKey);

    const resumed = await contextualPlanningService.getSessionForWorkItem(
      { anchorId: story.id },
      projectCtx(fx),
    );
    expect(resumed.session!.turns).toHaveLength(1);
    expect(resumed.planId).toBeNull();
  });

  it('reports NO plan for an item never planned at all', async () => {
    const resumed = await contextualPlanningService.getSessionForWorkItem(
      { anchorId: story.id },
      projectCtx(fx),
    );
    expect(resumed.session).toBeNull();
    expect(resumed.planId).toBeNull();
  });

  it('a FAILED submit yields no Plan and no planId', async () => {
    // The Plan is opened only AFTER motir-ai accepts the job (the 1743 ordering),
    // so a refused submit leaves the thread retryable and no orphan row behind.
    submitJobMock.mockRejectedValueOnce(new Error('motir-ai unreachable'));

    await expect(
      contextualPlanningService.planFromWorkItem(
        { anchorId: story.id, prompt: 'Break this up' },
        projectCtx(fx),
      ),
    ).rejects.toThrow('motir-ai unreachable');

    expect(await db.plan.count({ where: { projectId: fx.projectId } })).toBe(0);
    const resumed = await contextualPlanningService.getSessionForWorkItem(
      { anchorId: story.id },
      projectCtx(fx),
    );
    expect(resumed.planId).toBeNull();
  });
});
