import type { PlanChangeConversationState } from '@/lib/hooks/usePlanChangeConversation';

/**
 * Which half of a PLAN RUN is in flight (MOTIR-8203): `conversation` while
 * PART 1 settles the target, the entry and the requirement (and may still come
 * back with a question), `planning` once the run's `target_settled` frame has
 * arrived, and `null` when no plan run is in flight. The ONE definition of the
 * boundary: the hand-off bubble reads it, and so does anything else that shows
 * only during the conversation phase.
 *
 * Two viewers see a run. The LIVE one streams it (`streaming` with a plan id);
 * a REOPENED one watches the `generating` plan a Motir run is writing, and
 * settles from the replay of that run's frames ({@link reopenedPlanJobId}).
 * Both answer from the same `settledJobId`, so they agree.
 */
export type PlanRunPhase = 'conversation' | 'planning';

export function planRunPhase(
  state: Pick<
    PlanChangeConversationState,
    'phase' | 'planId' | 'jobId' | 'settledJobId' | 'liveReview' | 'session'
  >,
): PlanRunPhase | null {
  const job =
    state.phase === 'streaming'
      ? state.planId !== null
        ? state.jobId
        : undefined
      : reopenedPlanJobId(state);
  if (job === undefined) return null;
  return job !== null && (state.settledJobId ?? null) === job ? 'planning' : 'conversation';
}

/**
 * The job a REOPENED viewer is watching (MOTIR-8203): the session's latest job,
 * while the plan on screen is a `generating` plan Motir itself is writing.
 * `undefined` when there is no such run — an agent writing over MCP has no job
 * and no conversation phase.
 */
export function reopenedPlanJobId(
  state: Pick<PlanChangeConversationState, 'phase' | 'planId' | 'liveReview' | 'session'>,
): string | undefined {
  if (state.phase === 'streaming') return undefined;
  const live = state.liveReview;
  if (!live || live.status !== 'generating' || live.authorSource !== 'native') return undefined;
  if (state.planId !== null && live.id !== state.planId) return undefined;
  return state.session?.lastJobId ?? undefined;
}
