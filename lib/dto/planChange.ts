// DTO types for the plan-change CONVERSATION (Story 7.30 · MOTIR-1728) — the
// shape that crosses the API boundary. No Prisma row leaks: the
// `PlanChangeTurnRole` enum becomes a string union and every `Date` becomes an
// ISO string. The conversational rail (MOTIR-1730) binds to these.

/** Wire form of the Prisma `PlanChangeTurnRole` enum. `user` turns are what the
 *  person typed (and what the accumulated intent is built from); `system` turns
 *  are thread markers Motir wrote — today, "these turns were submitted", carrying
 *  the resulting job id. */
export type PlanChangeTurnRoleDto = 'user' | 'system';

/** One turn on the thread, in `seq` order (0-based, gapless). `jobId` is set only
 *  on a `system` submission marker; `authorId` only on a `user` turn (and null
 *  once that user is deleted). */
export interface PlanChangeTurnDto {
  id: string;
  seq: number;
  role: PlanChangeTurnRoleDto;
  body: string;
  jobId: string | null;
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
  turnCount: number;
  lastJobId: string | null;
  lastSubmittedAt: string | null;
  createdAt: string;
  updatedAt: string;
  turns: PlanChangeTurnDto[];
}

/**
 * The result of submitting a conversation's accumulated intent: the motir-ai
 * `augment` job the SHIPPED contract created (the rail streams it via
 * `GET /api/ai/augment/[jobId]` and approves via the existing approve route —
 * this card adds no job kind and no new stream/approve surface), plus the
 * session as it now stands (its new `system` marker turn included).
 */
export interface PlanChangeSubmitResultDto {
  jobId: string;
  session: PlanChangeSessionDto;
}
