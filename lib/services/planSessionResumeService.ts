import type { ProjectContext } from '@/lib/projects';
import type { PlanChangeSubmitResultDto } from '@/lib/dto/planChange';
import {
  NotSessionOwnerError,
  PlanNotResumableError,
  PlanSessionEndedError,
  PlanSessionNotFoundError,
  ResumeAlreadyStartedError,
  SessionNotFailedError,
  GuideSessionNotPlannableError,
} from '@/lib/planChange/errors';
import { sessionWaitingState } from '@/lib/planChange/sessionWaitingState';
import { planChangeSessionRepository } from '@/lib/repositories/planChangeSessionRepository';
import { planRepository } from '@/lib/repositories/planRepository';
import { aiPlanEditsService } from '@/lib/services/aiPlanEditsService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { planTargetLockService } from '@/lib/services/planTargetLockService';
import { projectAccessService } from '@/lib/services/projectAccessService';
import { withWorkspaceContext, withWorkspaceServiceContext } from '@/lib/workspaces/context';

// RESUMING A FAILED PLANNING SESSION (Story MOTIR-7905 · MOTIR-7916; `agent-authored-plans.md`
// AMENDMENT 23's 2026-10-09 sub-amendment).
//
// A failed hosted attempt keeps its session, its `generating` plan and its held cards
// (`settleFailedJob`, MOTIR-7912). Resume starts a NEW motir-ai attempt on the SAME plan in the
// SAME session — it does not open a plan — and from the moment it binds the session is no
// longer failed: it is running again, so it leaves To resume and its cards stay held.
//
// ORDER IS `submitRevise`'s, AND FOR ITS REASON. The job id does not exist until motir-ai
// answers, so the SUBMIT comes first (outside any transaction — a metered side effect) and the
// BIND second. A bind that loses a race leaves an orphan job that resolves no plan by
// `sourceJobId` and fails its first callback writing nothing: one wasted call on a genuine
// simultaneous double-click, and the cheaper end of the trade — the alternative holds a bind
// over a job that may never exist.
//
// THE BIND is one transaction under the existing lock order (PLAN, then SESSION) and every
// write in it is conditional, so the events that can reach the session at once — a person's
// end, `settleFailedJob` for the OLD job, and a second Resume — each find a state they were
// written for. No turn is appended: a resume adds no words, and the planner's own turn for the
// resumed job is recorded by the ordinary planner-turn door keyed on its job id.

/** What the cheap pre-check proved, handed to the submit and re-proved under the locks. */
interface ResumeTarget {
  sessionId: string;
  planId: string;
  failedJobId: string;
}

/**
 * Pre-check, in a read transaction under the caller's workspace context: refuse before a job
 * is spent. The bind re-checks everything under the locks; this exists so the refusals a
 * person actually hits cost nothing.
 */
async function precheck(pctx: ProjectContext, sessionId: string): Promise<ResumeTarget> {
  return withWorkspaceServiceContext(pctx.workspaceId, async (tx) => {
    const session = await planChangeSessionRepository.findByIdInProject(
      sessionId,
      pctx.projectId,
      pctx.workspaceId,
      tx,
    );
    if (!session) throw new PlanSessionNotFoundError(sessionId);
    if (session.origin === 'guide') throw new GuideSessionNotPlannableError(session.id);
    if (session.endedAt) throw new PlanSessionEndedError(session.id);
    if (session.createdById !== pctx.userId) throw new NotSessionOwnerError(session.id);
    if (sessionWaitingState(session) !== 'failed' || !session.failedJobId) {
      throw new SessionNotFailedError(session.id);
    }
    const plan = await planRepository.findLatestForResume(session.id, tx);
    if (!plan || plan.status !== 'generating' || plan.sourceJobId !== session.failedJobId) {
      throw new PlanNotResumableError(session.id);
    }
    return { sessionId: session.id, planId: plan.id, failedJobId: session.failedJobId };
  });
}

/**
 * BIND the new job: re-point the plan, record the attempt on the session, clear the failure and
 * heartbeat the targets — in ONE transaction, plan lock then session lock.
 */
async function bind(pctx: ProjectContext, target: ResumeTarget, jobId: string): Promise<void> {
  await withWorkspaceContext(
    { userId: pctx.userId, workspaceId: pctx.workspaceId, projectId: pctx.projectId },
    async (tx) => {
      if (!(await planRepository.lockById(target.planId, tx))) {
        throw new PlanNotResumableError(target.sessionId);
      }
      if (!(await planChangeSessionRepository.lockById(target.sessionId, tx))) {
        throw new PlanSessionNotFoundError(target.sessionId);
      }
      const fresh = await planChangeSessionRepository.findById(
        target.sessionId,
        pctx.workspaceId,
        tx,
      );
      if (!fresh) throw new PlanSessionNotFoundError(target.sessionId);
      if (fresh.endedAt) throw new PlanSessionEndedError(fresh.id);
      if (sessionWaitingState(fresh) !== 'failed') {
        // The failure is already cleared: a concurrent Resume won. Name ITS job.
        throw new ResumeAlreadyStartedError(fresh.id, fresh.lastJobId);
      }
      if (fresh.failedJobId !== target.failedJobId) throw new PlanNotResumableError(fresh.id);
      const plan = await planRepository.findById(target.planId, pctx.workspaceId, tx);
      if (!plan || plan.status !== 'generating' || plan.sourceJobId !== target.failedJobId) {
        throw new PlanNotResumableError(fresh.id);
      }
      const now = new Date();
      if (!(await planRepository.repointSourceJob(target.planId, jobId, tx))) {
        throw new PlanNotResumableError(fresh.id);
      }
      if (
        !(await planChangeSessionRepository.recordResumedAttempt(fresh.id, { jobId, at: now }, tx))
      ) {
        throw new PlanSessionEndedError(fresh.id);
      }
      await planChangeSessionRepository.clearFailure(fresh.id, tx);
      await planTargetLockService.refreshForSessionWithin(fresh.id, now, tx);
    },
  );
}

export const planSessionResumeService = {
  /**
   * RESUME the caller's own failed-waiting session. Returns the new job to stream, the SAME
   * plan, and the session as it now stands (no longer failed).
   */
  async resume(pctx: ProjectContext, sessionId: string): Promise<PlanChangeSubmitResultDto> {
    await projectAccessService.assertPermission(
      pctx.projectId,
      { userId: pctx.userId, workspaceId: pctx.workspaceId },
      'ai:plan',
    );
    const target = await precheck(pctx, sessionId);
    // Side effect OUTSIDE any transaction. Its typed errors (out of credits, unreachable, a
    // motir-ai refusal of the resume) propagate with nothing written: the failure record and the
    // plan are exactly as they were.
    const { jobId } = await aiPlanEditsService.submitResume(
      target.planId,
      target.failedJobId,
      pctx,
    );
    await bind(pctx, target, jobId);
    const session = await planChangeSessionsService.getById(pctx, target.sessionId);
    return { jobId, planId: target.planId, session };
  },
};
