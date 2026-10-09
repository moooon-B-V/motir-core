import type { PlanChangeSessionDto } from '@/lib/dto/planChange';

// THE CARRY'S FACE RULE (Story MOTIR-7928 · MOTIR-7932; AMENDMENT 23 §6 as amended
// by MOTIR-7931). Pure, so the hook (which routes the send) and the rail (which
// draws the composer) read the same predicate off the same server row.

/**
 * Whether an ENDED session's next message CARRIES its waiting plan into a new
 * session: a `conversation` session, to its starter, who may plan, while its plan
 * is still undecided. Keyed on the PLAN, never the end reason, so every reason
 * that leaves a plan waiting gets the same face — and a session whose plan was
 * decided (or that never made one) keeps today's face.
 */
export function carriesWaitingPlan(
  session: PlanChangeSessionDto | null | undefined,
  readOnly: boolean,
): boolean {
  return (
    Boolean(session?.endedAt) &&
    session?.origin === 'conversation' &&
    session.startedByViewer !== false &&
    !readOnly &&
    Boolean(session.pendingPlanId)
  );
}
