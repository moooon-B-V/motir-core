import type { WorkItemRefMap } from '@/lib/dto/workItems';

// DTO types for the plan-change CONVERSATION (Story 7.30 · MOTIR-1728) — the
// shape that crosses the API boundary. No Prisma row leaks: the
// `PlanChangeTurnRole` enum becomes a string union and every `Date` becomes an
// ISO string. The conversational rail (MOTIR-1730) binds to these.

/** Wire form of the Prisma `PlanChangeTurnRole` enum. `user` turns are what the
 *  person typed (and what the accumulated intent is built from); `system` turns
 *  are thread markers Motir wrote — today, "these turns were submitted", carrying
 *  the resulting job id; `assistant` turns are the PLANNER speaking (MOTIR-2226)
 *  — its findings report, and the one question it asks when the request was not
 *  determinate. */
export type PlanChangeTurnRoleDto = 'user' | 'system' | 'assistant';

/** One turn on the thread, in `seq` order (0-based, gapless). `jobId` is set on a
 *  `system` submission marker and on an `assistant` turn (the job that produced
 *  it); `authorId` only on a `user` turn (and null once that user is deleted). */
export interface PlanChangeTurnDto {
  id: string;
  seq: number;
  role: PlanChangeTurnRoleDto;
  body: string;
  jobId: string | null;
  /**
   * The ONE clarifying question an `assistant` turn asked, or null when it only
   * reported. Null on every other role. This is what makes the awaiting state
   * DERIVED from the thread rather than stored on the client — see
   * `lib/planning/planChangeThread.ts`.
   */
  question: string | null;
  /**
   * A `user` turn that REPLIED to the pending question (sent through the answer
   * bar), as opposed to one that changed the subject and superseded it. The two
   * render different markers — design states C and E.
   */
  isAnswer: boolean;
  authorId: string | null;
  createdAt: string;
}

/**
 * The project's plan-change conversation as the rail renders it. `turns` is the
 * FULL ordered thread (the resume payload — re-opening the workspace re-reads
 * this and the conversation continues where it stopped). `lastJobId` /
 * `lastSubmittedAt` describe the most recent submission, so a resumed rail can
 * re-attach to that job's stream / diff review; both are null on a thread that
 * has accumulated turns but never submitted.
 */
export interface PlanChangeSessionDto {
  id: string;
  projectId: string;
  /**
   * The work items this thread is ANCHORED at, as identifiers, in canonical
   * (deduped + sorted) order — 7.12.3 · MOTIR-909. Empty on the project-wide
   * conversation; one or more entries on a contextual planning thread, which is
   * what the embedded panel labels itself with and what a resumed thread
   * re-submits as motir-ai's anchor set. The `scopeKey` these derive from is a
   * server-side storage detail and deliberately does NOT cross the boundary.
   */
  targetKeys: string[];
  turnCount: number;
  lastJobId: string | null;
  lastSubmittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  turns: PlanChangeTurnDto[];
  /**
   * Resolved work-item reference summaries for the `[KEY](motir:<id>)` tokens the
   * thread's `assistant` bodies carry (MOTIR-2226), keyed by id — the SAME map
   * the detail page and comments thread into `renderMarkdown`, so a findings
   * report's references render as the shipped `WorkItemRefChip` and never as a
   * second inline treatment. Empty when nothing resolved.
   */
  workItemRefs: WorkItemRefMap;
}

/**
 * The result of submitting a conversation's accumulated intent: the motir-ai
 * `augment` job the SHIPPED contract created (the rail streams it via
 * `GET /api/ai/augment/[jobId]` and approves via the existing approve route —
 * this card adds no job kind and no new stream/approve surface), plus the
 * session as it now stands (its new `system` marker turn included).
 *
 * `planId` is the `generating` `Plan` that submit OPENED for the job (bound to
 * it by `sourceJobId` — MOTIR-1743), which the job's proposals append into. It
 * is carried here (MOTIR-1745) so the rail can name the Plan it must confirm
 * instead of re-resolving it from the job id; the same `{ jobId, planId }` pair
 * the three REST plan-edit submits already return. Nothing is opened twice: the
 * value is the one `aiPlanEditsService` produced, previously discarded.
 */
export interface PlanChangeSubmitResultDto {
  jobId: string;
  planId: string;
  session: PlanChangeSessionDto;
}

/**
 * What the ITEM-ANCHORED contextual endpoints return (7.12.3 · MOTIR-909) — the
 * submit result plus the thread's own id, which the anchored caller needs
 * because it did not open the session in a separate call. The wire shape of
 * `contextualPlanningService`'s result; named here so the client (MOTIR-910) and
 * the route agree on it without importing across the service boundary.
 */
export interface ContextualPlanResultDto extends PlanChangeSubmitResultDto {
  sessionId: string;
}

/**
 * What the anchored RESUME returns (the `GET` half of the contextual endpoint) —
 * the item's thread, or `null` when it was never planned.
 *
 * `planId` (MOTIR-1745) is the thread's still-UNDECIDED proposal, resolved from
 * its last submission's job. It matters because a resume is exactly the case the
 * submit response cannot cover: the user closed the workspace while a proposal
 * was pending and came back, so the rail has a thread but no in-memory job — and
 * without this it could not address the Plan awaiting confirmation. `null` when
 * there is no thread, when the thread never submitted, or when its plan was
 * already approved / declined (a decided plan is history, not a pending review).
 */
export interface ContextualSessionResumeDto {
  session: PlanChangeSessionDto | null;
  planId: string | null;
}
