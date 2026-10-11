import type { Prisma, SharpenSession, SharpenTurn } from '@/generated/prisma/client';
import { isMotirAiConfigured } from '@/lib/ai/availability';
import { MotirAiConfigError } from '@/lib/ai/errors';
import { getJob, submitJob } from '@/lib/ai/motirAiClient';
import { parseSharpenTurn, type SharpenTurnResult } from '@/lib/ai/sharpenTurn';
import { resolveTenantOrg } from '@/lib/ai/tenantOrg';
import type {
  SettledAnswer,
  SharpenAction,
  SharpenAssumption,
  SharpenJobContext,
  SharpenQuestion,
} from '@/lib/ai/types';
import type { SharpenDoorResult, SharpenSessionDto, SharpenSettleResult } from '@/lib/dto/sharpen';
import { inFlightTurn, isFailedRecord, toSharpenSessionDto } from '@/lib/mappers/sharpenMappers';
import { PlanNotFoundError } from '@/lib/plans/errors';
import { sqlStateOf } from '@/lib/prisma/sqlstate';
import type { ProjectContext } from '@/lib/projects';
import { ProjectAccessDeniedError, ProjectNotFoundError } from '@/lib/projects/errors';
import { planRepository } from '@/lib/repositories/planRepository';
import {
  sharpenSessionRepository,
  type SharpenTargetRef,
} from '@/lib/repositories/sharpenSessionRepository';
import { sharpenTurnRepository } from '@/lib/repositories/sharpenTurnRepository';
import { workItemRepository } from '@/lib/repositories/workItemRepository';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { workflowsService } from '@/lib/services/workflowsService';
import { workItemsService } from '@/lib/services/workItemsService';
import {
  SharpenActionInvalidError,
  SharpenSessionEndedError,
  SharpenSessionNotFoundError,
  SharpenTargetClosedError,
  SharpenTargetNotAvailableError,
  SharpenTurnInFlightError,
  SharpenTurnNotFoundError,
} from '@/lib/sharpening/errors';
import { WorkItemNotFoundError } from '@/lib/workItems/errors';
import type { ServiceContext } from '@/lib/workItems/serviceContext';
import { withWorkspaceContext } from '@/lib/workspaces/context';

// The SHARPEN session door (Task MOTIR-1101 · Subtask MOTIR-8181) — the motir-core
// side of a Sharpen grilling session on a plan or one committed work item. It is
// the Guide me through door's shape (`aiGuideService` + `guideLandingService`):
// ONE `sharpen_turn` job per person action, submitted OUTSIDE the write
// transaction and then bound to its turn, and a replay-safe `settle` the client
// calls once the job ends. It takes no plan target lock and parks nothing.
//
// ── GATES, ALL BEFORE ANY WRITE OR JOB ────────────────────────────────────────
//  1. the target resolves in the ACTIVE project and the caller may browse it —
//     else {@link SharpenTargetNotAvailableError} (404, no existence leak);
//  2. `ai:plan`;
//  3. plan: `ai:view_plan` + `work_item:edit`; item: `work_item:edit` — the
//     answers are written back onto the target, so a viewer cannot sharpen;
//  4. the target is open — a `planned` or `stale` plan; an item neither archived
//     nor in a `done`-category status — else {@link SharpenTargetClosedError};
//  5. Motir AI is configured.
//
// ── STATE IS THE SERVER'S ─────────────────────────────────────────────────────
// Every job's settled answers and assumptions come from the session's STORED
// state, never from a client body, so a client cannot inject an answer. motir-ai
// echoes the full cumulative set on every turn and core replaces its copy.
//
// ── STOP ──────────────────────────────────────────────────────────────────────
// Stop is accepted even while a turn is in flight, and carries the settled set as
// it stood BEFORE that turn. The in-flight turn's late result is kept in the
// transcript and changes nothing about the session's state.
//
// Core never writes the requirement itself: motir-ai's handler writes back through
// `PUT /api/internal/ai/plan-sharpening` at the end, and core stores the
// `writeBack` outcome it reports.

/** What a door call is about, as the client names it. */
export type SharpenTargetInput = { planId: string } | { itemKey: string };

/** A target resolved and browse-gated in the active project. */
type Target =
  | { kind: 'plan'; planId: string; ref: string; state: string }
  | { kind: 'work_item'; workItemId: string; ref: string; state: string };

const OPEN_PLAN_STATUSES = new Set(['planned', 'stale']);
const ENDING_KINDS = new Set(['nothing_to_ask', 'finished', 'stopped']);
const UNIQUE_VIOLATION = '23505';

/** The words a person turn is stored with, by action. */
const ACTION_BODIES: Record<Exclude<SharpenAction, 'answer' | 'own_words'>, string> = {
  start: 'Sharpen this.',
  skip: 'Skip this question.',
  you_decide: 'You decide.',
  stop: 'Stop.',
};

function actorOf(ctx: ProjectContext): ServiceContext {
  return { userId: ctx.userId, workspaceId: ctx.workspaceId };
}

function bindCtx(ctx: ProjectContext) {
  return { userId: ctx.userId, workspaceId: ctx.workspaceId, projectId: ctx.projectId };
}

function targetRef(target: Target): SharpenTargetRef {
  return target.kind === 'plan' ? { planId: target.planId } : { workItemId: target.workItemId };
}

function isNotAvailable(err: unknown): boolean {
  return (
    err instanceof WorkItemNotFoundError ||
    err instanceof PlanNotFoundError ||
    err instanceof ProjectAccessDeniedError ||
    err instanceof ProjectNotFoundError
  );
}

async function resolvePlan(planId: string, ctx: ProjectContext): Promise<Target> {
  const plan = await withWorkspaceContext(bindCtx(ctx), (tx) =>
    planRepository.findById(planId, ctx.workspaceId, tx),
  );
  if (!plan || plan.projectId !== ctx.projectId) throw new SharpenTargetNotAvailableError();
  await projectAccessService.assertCanBrowse(plan.projectId, actorOf(ctx));
  return { kind: 'plan', planId: plan.id, ref: plan.id, state: plan.status };
}

async function resolveItem(itemKey: string, ctx: ProjectContext): Promise<Target> {
  const item = await workItemsService.getWorkItemByIdentifier(
    ctx.projectId,
    itemKey.trim().toUpperCase(),
    actorOf(ctx),
  );
  if (item.projectId !== ctx.projectId) throw new SharpenTargetNotAvailableError();
  let state = 'open';
  if (item.archivedAt) state = 'archived';
  else {
    const terminal = await workflowsService.getTerminalStatusKeys(ctx.projectId, ctx.workspaceId);
    if (terminal.has(item.status)) state = item.status;
  }
  return { kind: 'work_item', workItemId: item.id, ref: item.identifier, state };
}

/** Gate 1: resolve and browse-gate the target. */
async function resolveTarget(input: SharpenTargetInput, ctx: ProjectContext): Promise<Target> {
  try {
    return 'planId' in input
      ? await resolvePlan(input.planId, ctx)
      : await resolveItem(input.itemKey, ctx);
  } catch (err) {
    if (isNotAvailable(err)) throw new SharpenTargetNotAvailableError();
    throw err;
  }
}

/** Gates 2–5. `forStop` skips gate 4: a session may always be stopped. */
async function assertSharpenable(target: Target, ctx: ProjectContext, forStop = false) {
  const actor = actorOf(ctx);
  await projectAccessService.assertPermission(ctx.projectId, actor, 'ai:plan');
  if (target.kind === 'plan') {
    await projectAccessService.assertPermission(ctx.projectId, actor, 'ai:view_plan');
  }
  await projectAccessService.assertPermission(ctx.projectId, actor, 'work_item:edit');
  const open =
    target.kind === 'plan' ? OPEN_PLAN_STATUSES.has(target.state) : target.state === 'open';
  if (!open && !forStop) throw new SharpenTargetClosedError(target.ref, target.state);
  if (!isMotirAiConfigured()) {
    throw new MotirAiConfigError('MOTIR_AI_URL / MOTIR_AI_SERVICE_TOKEN are not set');
  }
}

/** The caller's own session in the active project, under the given tx. */
async function ownSession(
  sessionId: string,
  ctx: ProjectContext,
  tx: Prisma.TransactionClient,
): Promise<SharpenSession> {
  const row = await sharpenSessionRepository.findByIdInProject(
    sessionId,
    ctx.projectId,
    ctx.workspaceId,
    tx,
  );
  if (!row || row.createdById !== ctx.userId) throw new SharpenSessionNotFoundError(sessionId);
  return row;
}

/** The target a stored session is about, re-resolved (and browse-gated) now. */
async function targetOfSession(row: SharpenSession, ctx: ProjectContext): Promise<Target> {
  if (row.planId) return resolveTarget({ planId: row.planId }, ctx);
  const item = await withWorkspaceContext(bindCtx(ctx), (tx) =>
    workItemRepository.findById(row.workItemId!, tx),
  );
  if (!item) throw new SharpenTargetNotAvailableError();
  return resolveTarget({ itemKey: item.identifier }, ctx);
}

async function readDto(
  sessionId: string,
  ctx: ProjectContext,
  tx: Prisma.TransactionClient,
): Promise<SharpenSessionDto> {
  const row = await ownSession(sessionId, ctx, tx);
  const turns = await sharpenTurnRepository.listTurns(row.id, tx);
  const item = row.workItemId ? await workItemRepository.findById(row.workItemId, tx) : null;
  return toSharpenSessionDto(row, turns, item?.identifier ?? null);
}

function loadDto(sessionId: string, ctx: ProjectContext): Promise<SharpenSessionDto> {
  return withWorkspaceContext(bindCtx(ctx), (tx) => readDto(sessionId, ctx, tx));
}

/** The `context.sharpen` a job reads — built from STORED state only. */
function jobContext(
  target: Target,
  row: SharpenSession,
  before: readonly SharpenTurn[],
  turn: SharpenTurn,
): SharpenJobContext {
  const action = turn.action ?? 'start';
  return {
    scope: { kind: target.kind, ref: target.ref },
    turns: before
      .filter((t) => !(t.role === 'planner' && isFailedRecord(t.record)))
      .map((t) => ({ role: t.role, action: t.action, body: t.body })),
    settled: row.settled as unknown as SettledAnswer[],
    assumptions: row.assumptions as unknown as SharpenAssumption[],
    pendingQuestion:
      action === 'start' ? null : ((row.pendingQuestion as SharpenQuestion | null) ?? null),
    action,
    ...(action === 'answer' && turn.readingId ? { readingId: turn.readingId } : {}),
    ...(action === 'own_words' ? { text: turn.body } : {}),
  };
}

/** Submit ONE `sharpen_turn` job, then bind it to its person turn. */
async function submitAndBind(
  context: SharpenJobContext,
  turnId: string,
  ctx: ProjectContext,
): Promise<string> {
  const { organizationId, isMeta, internalBilling } = await resolveTenantOrg(actorOf(ctx));
  const { jobId } = await submitJob(
    'sharpen_turn',
    {
      organizationId,
      isMeta,
      internalBilling,
      workspaceId: ctx.workspaceId,
      projectId: ctx.projectId,
      projectKey: ctx.project.identifier,
    },
    { sharpen: context },
    { userId: ctx.userId },
  );
  await withWorkspaceContext(bindCtx(ctx), (tx) =>
    sharpenTurnRepository.setTurnJob(turnId, jobId, tx),
  );
  return jobId;
}

/** Append one person turn under the session's row lock. */
async function appendPersonTurn(
  row: SharpenSession,
  turn: { action: SharpenAction; body: string; readingId?: string | null },
  ctx: ProjectContext,
  tx: Prisma.TransactionClient,
): Promise<SharpenTurn> {
  const seq = await sharpenTurnRepository.nextSeq(row.id, tx);
  const appended = await sharpenTurnRepository.appendTurn(
    row.id,
    seq,
    {
      workspaceId: ctx.workspaceId,
      role: 'person',
      action: turn.action,
      body: turn.body,
      readingId: turn.readingId ?? null,
      authorId: ctx.userId,
    },
    tx,
  );
  await sharpenSessionRepository.updateState(row.id, { lastActivityAt: new Date() }, tx);
  return appended;
}

type OpenWrite =
  | { resumed: true; sessionId: string }
  | { resumed: false; row: SharpenSession; turn: SharpenTurn };

async function openWrite(target: Target, ctx: ProjectContext): Promise<OpenWrite> {
  return withWorkspaceContext(bindCtx(ctx), async (tx) => {
    const ref = targetRef(target);
    const existing = await sharpenSessionRepository.findOpenForUser(
      ref,
      ctx.userId,
      ctx.workspaceId,
      tx,
    );
    if (existing) return { resumed: true, sessionId: existing.id };
    const row = await sharpenSessionRepository.create(
      {
        workspaceId: ctx.workspaceId,
        projectId: ctx.projectId,
        createdById: ctx.userId,
        scopeKind: target.kind,
        ...ref,
      },
      tx,
    );
    const turn = await appendPersonTurn(
      row,
      { action: 'start', body: ACTION_BODIES.start },
      ctx,
      tx,
    );
    return { resumed: false, row, turn };
  });
}

/** The winner of a lost open race. */
async function openWinner(target: Target, ctx: ProjectContext): Promise<string> {
  const winner = await withWorkspaceContext(bindCtx(ctx), (tx) =>
    sharpenSessionRepository.findOpenForUser(targetRef(target), ctx.userId, ctx.workspaceId, tx),
  );
  if (!winner) throw new SharpenTargetNotAvailableError();
  return winner.id;
}

/** Judge an action against the pending question; returns the turn to store. */
function validateAction(
  row: SharpenSession,
  action: SharpenAction,
  opts: { readingId?: string; text?: string },
): { action: SharpenAction; body: string; readingId?: string | null } {
  if (action === 'stop') return { action, body: ACTION_BODIES.stop };
  if (action === 'start') throw new SharpenActionInvalidError('`start` only opens a session.');
  const pending = row.pendingQuestion as SharpenQuestion | null;
  if (!pending) throw new SharpenActionInvalidError('There is no question waiting for an answer.');
  if (action === 'answer') {
    const reading = pending.readings.find((r) => r.id === opts.readingId);
    if (!reading) {
      throw new SharpenActionInvalidError('`readingId` must name a reading of the question.');
    }
    return { action, body: reading.label, readingId: reading.id };
  }
  if (action === 'own_words') {
    const text = opts.text?.trim() ?? '';
    if (!text) throw new SharpenActionInvalidError('Your own words cannot be empty.');
    return { action, body: text };
  }
  return { action, body: ACTION_BODIES[action] };
}

async function actWrite(
  sessionId: string,
  action: SharpenAction,
  opts: { readingId?: string; text?: string },
  ctx: ProjectContext,
): Promise<{ row: SharpenSession; before: SharpenTurn[]; turn: SharpenTurn }> {
  return withWorkspaceContext(bindCtx(ctx), async (tx) => {
    await sharpenSessionRepository.lockById(sessionId, tx);
    const row = await ownSession(sessionId, ctx, tx);
    if (row.status === 'ended') throw new SharpenSessionEndedError(sessionId);
    const before = await sharpenTurnRepository.listTurns(row.id, tx);
    if (before.some((t) => t.role === 'person' && t.action === 'stop')) {
      throw new SharpenSessionEndedError(sessionId);
    }
    const inFlight = inFlightTurn(before);
    if (inFlight && action !== 'stop') throw new SharpenTurnInFlightError(inFlight.id);
    const turn = await appendPersonTurn(row, validateAction(row, action, opts), ctx, tx);
    return { row, before, turn };
  });
}

/** True when a later STOP has superseded this job's turn — its result is
 *  transcript only. */
function supersededByStop(row: SharpenSession, turns: SharpenTurn[], turn: SharpenTurn): boolean {
  if (turn.action === 'stop') return false;
  if (row.status === 'ended') return true;
  return turns.some((t) => t.role === 'person' && t.action === 'stop' && t.seq > turn.seq);
}

function plannerBody(result: SharpenTurnResult): string {
  if (result.kind === 'question' && result.question) return result.question.text;
  return {
    question: 'Asked a question.',
    nothing_to_ask: 'Nothing to ask.',
    finished: 'Finished.',
    stopped: 'Stopped.',
    unavailable: 'The planner could not ask a question.',
  }[result.kind];
}

/** Store the planner turn for a settled job and apply its state. */
async function land(
  sessionId: string,
  jobId: string,
  outcome: { result: SharpenTurnResult } | { failure: string },
  ctx: ProjectContext,
): Promise<'settled' | 'failed'> {
  return withWorkspaceContext(bindCtx(ctx), async (tx) => {
    await sharpenSessionRepository.lockById(sessionId, tx);
    const row = await ownSession(sessionId, ctx, tx);
    const existing = await sharpenTurnRepository.findTurnByJob(row.id, jobId, 'planner', tx);
    if (existing) return isFailedRecord(existing.record) ? 'failed' : 'settled';
    const turns = await sharpenTurnRepository.listTurns(row.id, tx);
    const person = turns.find((t) => t.role === 'person' && t.jobId === jobId);
    const failed = 'failure' in outcome;
    await sharpenTurnRepository.appendTurn(
      row.id,
      await sharpenTurnRepository.nextSeq(row.id, tx),
      {
        workspaceId: ctx.workspaceId,
        role: 'planner',
        body: failed ? 'The planner could not answer this turn.' : plannerBody(outcome.result),
        jobId,
        record: failed ? { failed: true, reason: outcome.failure } : outcome.result,
      },
      tx,
    );
    // A person turn re-bound to a newer job since leaves this result transcript only.
    if (failed || !person || supersededByStop(row, turns, person)) {
      await sharpenSessionRepository.updateState(row.id, { lastActivityAt: new Date() }, tx);
      return failed ? 'failed' : 'settled';
    }
    const r = outcome.result;
    const ends = ENDING_KINDS.has(r.kind);
    await sharpenSessionRepository.updateState(
      row.id,
      {
        pendingQuestion: r.question,
        settled: r.settled,
        assumptions: r.assumptions,
        lastActivityAt: new Date(),
        ...(ends
          ? {
              status: 'ended' as const,
              endReason: r.kind as 'nothing_to_ask' | 'finished' | 'stopped',
              writeBack: r.writeBack,
            }
          : {}),
      },
      tx,
    );
    return 'settled';
  });
}

/** The result a settled job carries, or why it is a failed turn. */
async function readResult(
  jobId: string,
  ctx: ProjectContext,
): Promise<{ pending: true } | { result: SharpenTurnResult } | { failure: string }> {
  const job = await getJob(jobId, ctx.projectId);
  if (job.status === 'queued' || job.status === 'running') return { pending: true };
  if (job.status !== 'succeeded') return { failure: `job ${job.status}` };
  const result = parseSharpenTurn(job.result?.sharpenTurn);
  if (!result) return { failure: 'unreadable result' };
  if (result.kind === 'unavailable') return { failure: 'planner unavailable' };
  return { result };
}

export const aiSharpenService = {
  /**
   * OPEN a Sharpen session on a plan or a work item. The caller's open session
   * on that target is RESUMED and nothing is sent; otherwise a session and its
   * `start` turn are stored and the first job runs, so the planner asks first.
   */
  async open(input: SharpenTargetInput, ctx: ProjectContext): Promise<SharpenDoorResult> {
    const target = await resolveTarget(input, ctx);
    await assertSharpenable(target, ctx);
    let written: OpenWrite;
    try {
      written = await openWrite(target, ctx);
    } catch (err) {
      // Two opens raced; the partial unique index let one through.
      if (sqlStateOf(err) !== UNIQUE_VIOLATION) throw err;
      written = { resumed: true, sessionId: await openWinner(target, ctx) };
    }
    if (written.resumed) {
      const session = await loadDto(written.sessionId, ctx);
      return { outcome: 'resumed', jobId: null, turnId: null, session };
    }
    const { row, turn } = written;
    const jobId = await submitAndBind(jobContext(target, row, [], turn), turn.id, ctx);
    return { outcome: 'sharpening', jobId, turnId: turn.id, session: await loadDto(row.id, ctx) };
  },

  /**
   * ACT on the pending question: pick a reading, answer in your own words,
   * skip, say "you decide", or stop. One person turn, one job.
   */
  async act(
    sessionId: string,
    action: SharpenAction,
    opts: { readingId?: string; text?: string },
    ctx: ProjectContext,
  ): Promise<SharpenDoorResult> {
    const stored = await withWorkspaceContext(bindCtx(ctx), (tx) => ownSession(sessionId, ctx, tx));
    const target = await targetOfSession(stored, ctx);
    await assertSharpenable(target, ctx, action === 'stop');
    const { row, before, turn } = await actWrite(sessionId, action, opts, ctx);
    const jobId = await submitAndBind(jobContext(target, row, before, turn), turn.id, ctx);
    return { outcome: 'sharpening', jobId, turnId: turn.id, session: await loadDto(row.id, ctx) };
  },

  /**
   * RE-RUN a person turn: one whose submit failed (no job), or whose job failed
   * and was recorded as a failed planner turn. A turn with a live or answered
   * job returns that job and submits nothing.
   */
  async resubmit(sessionId: string, turnId: string, ctx: ProjectContext) {
    const { row, turns } = await withWorkspaceContext(bindCtx(ctx), async (tx) => {
      const r = await ownSession(sessionId, ctx, tx);
      return { row: r, turns: await sharpenTurnRepository.listTurns(r.id, tx) };
    });
    const turn = turns.find((t) => t.id === turnId && t.role === 'person');
    if (!turn) throw new SharpenTurnNotFoundError(turnId);
    const reply = turn.jobId
      ? turns.find((t) => t.role === 'planner' && t.jobId === turn.jobId)
      : undefined;
    if (turn.jobId && !(reply && isFailedRecord(reply.record))) {
      const session = await loadDto(row.id, ctx);
      return { outcome: 'sharpening', jobId: turn.jobId, turnId, session } as SharpenDoorResult;
    }
    if (row.status === 'ended') throw new SharpenSessionEndedError(sessionId);
    const target = await targetOfSession(row, ctx);
    await assertSharpenable(target, ctx, turn.action === 'stop');
    const before = turns.filter((t) => t.seq < turn.seq);
    const jobId = await submitAndBind(jobContext(target, row, before, turn), turn.id, ctx);
    const session = await loadDto(row.id, ctx);
    return { outcome: 'sharpening', jobId, turnId, session } as SharpenDoorResult;
  },

  /**
   * SETTLE a job once it has ended — replay-safe. A job that is not one of this
   * session's, or is still running, is `pending` and writes nothing; a job
   * already settled returns as it was.
   */
  async settle(
    sessionId: string,
    jobId: string,
    ctx: ProjectContext,
  ): Promise<SharpenSettleResult> {
    const before = await loadDto(sessionId, ctx);
    if (!before.turns.some((t) => t.role === 'person' && t.jobId === jobId)) {
      return { outcome: 'pending', session: before };
    }
    const reply = before.turns.find((t) => t.role === 'planner' && t.jobId === jobId);
    if (reply) return { outcome: reply.failed ? 'failed' : 'settled', session: before };
    const read = await readResult(jobId, ctx);
    if ('pending' in read) return { outcome: 'pending', session: before };
    try {
      const outcome = await land(sessionId, jobId, read, ctx);
      return { outcome, session: await loadDto(sessionId, ctx) };
    } catch (err) {
      // A concurrent settle stored the planner turn first.
      if (sqlStateOf(err) !== UNIQUE_VIOLATION) throw err;
      return aiSharpenService.settle(sessionId, jobId, ctx);
    }
  },

  /** One of the caller's sessions in the active project. */
  async get(sessionId: string, ctx: ProjectContext): Promise<SharpenSessionDto> {
    return loadDto(sessionId, ctx);
  },

  /** The caller's OPEN session on a target, or null. */
  async getOpenFor(
    input: SharpenTargetInput,
    ctx: ProjectContext,
  ): Promise<SharpenSessionDto | null> {
    const target = await resolveTarget(input, ctx);
    const row = await withWorkspaceContext(bindCtx(ctx), (tx) =>
      sharpenSessionRepository.findOpenForUser(targetRef(target), ctx.userId, ctx.workspaceId, tx),
    );
    return row ? loadDto(row.id, ctx) : null;
  },
};
