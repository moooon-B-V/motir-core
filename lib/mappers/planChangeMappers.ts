import type {
  PlanChangeRunPause,
  PlanChangeSession,
  PlanChangeTurn,
} from '@/generated/prisma/client';
import type {
  DebugLandingDto,
  PlanChangeRunPauseDto,
  PlanChangeSessionDto,
  PlanChangeTurnConfirmDto,
  PlanChangeTurnDto,
  PlanChangeTurnIntentDto,
  PlanChangeTurnRoleDto,
} from '@/lib/dto/planChange';
import type { WorkItemRefMap } from '@/lib/dto/workItems';
import { readGuideTurnRecord } from '@/lib/ai/guideWorkItem';

// Prisma rows → API DTOs for the plan-change conversation (Story 7.30 ·
// MOTIR-1728). The single place the persisted enum narrows to its string union
// and Dates become ISO strings, so no Prisma row leaks past the service boundary
// (the 4-layer rule). `workspaceId` is deliberately NOT carried across the
// boundary — the client never needs the tenant id, and omitting it keeps the
// tenancy an entirely server-side concern.

const DEBUG_OUTCOMES: ReadonlySet<string> = new Set(['enrich_existing', 'diagnose', 'ungrounded']);

/**
 * The persisted `debug_landing` JSON → its DTO (MOTIR-7064). The column is
 * written only by `debugLandingService` from a `DebugLandingDto`, so this is a
 * NARROWING, not a repair: anything that is not that shape reads as null — the
 * turn then renders as the ordinary answer it would have been — rather than as
 * an outcome line built from a guess.
 */
function toDebugLandingDto(value: unknown): DebugLandingDto | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.outcome !== 'string' || !DEBUG_OUTCOMES.has(v.outcome)) return null;
  return {
    outcome: v.outcome as DebugLandingDto['outcome'],
    workItemKey: typeof v.workItemKey === 'string' ? v.workItemKey : null,
    title: typeof v.title === 'string' ? v.title : null,
    createdInTriage: v.createdInTriage === true,
  };
}

/** A run pause row → its DTO (MOTIR-8007). The delivery state is derived: an answer
 *  with a mailbox entry is `delivered`, one with a refusal code is `refused`, anything
 *  else (open, or claimed and not yet delivered) is `pending`. */
export function toPlanChangeRunPauseDto(
  row: PlanChangeRunPause,
  entryRead?: boolean,
): PlanChangeRunPauseDto {
  return {
    id: row.id,
    jobId: row.jobId,
    kind: row.kind as PlanChangeRunPauseDto['kind'],
    changeTurnIds: row.changeTurnIds,
    reason: row.reason,
    question: row.question,
    createdAt: row.createdAt.toISOString(),
    answer: row.answer as PlanChangeRunPauseDto['answer'],
    answeredAt: row.answeredAt ? row.answeredAt.toISOString() : null,
    replyText: row.answer === 'replied' ? row.replyText : null,
    delivery: row.mailboxEntryId ? 'delivered' : row.deliveryRefusedCode ? 'refused' : 'pending',
    refusedCode: row.deliveryRefusedCode,
    mailboxEntryId: row.mailboxEntryId,
    ...(entryRead === undefined ? {} : { entryRead }),
  };
}

export function toPlanChangeTurnDto(row: PlanChangeTurn): PlanChangeTurnDto {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role as PlanChangeTurnRoleDto,
    body: row.body,
    jobId: row.jobId,
    question: row.question,
    isAnswer: row.isAnswer,
    intent: (row.intent as PlanChangeTurnIntentDto | null) ?? null,
    intentCorrected: row.intentCorrected,
    citations: row.citations,
    anchorKey: row.anchorKey,
    debugLanding: toDebugLandingDto(row.debugLanding),
    guide: readGuideTurnRecord(row.guideTurn),
    attachmentIds: row.attachmentIds,
    confirm: (row.confirm as PlanChangeTurnConfirmDto | null) ?? null,
    runJobId: row.runJobId,
    forwardOffer: row.forwardOffer,
    forwarded: row.forwardedEntryId ? { mailboxEntryId: row.forwardedEntryId } : null,
    revisedLate: row.revisedLateJobId ? { revisionJobId: row.revisedLateJobId } : null,
    authorId: row.authorId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The session plus its FULL ordered thread — the resume payload. `turns` MUST
 *  already be in `seq` order (the repository read orders them); the mapper does
 *  not re-sort, so a caller passing an unordered list gets an unordered DTO. */
export function toPlanChangeSessionDto(
  row: PlanChangeSession,
  turns: PlanChangeTurn[],
  workItemRefs: WorkItemRefMap = {},
  runPause: PlanChangeRunPause | null = null,
): PlanChangeSessionDto {
  return {
    id: row.id,
    projectId: row.projectId,
    // The anchor set crosses the boundary; the derived `scopeKey` it is stored
    // under does not (the client never needs the discriminator, only the items).
    targetKeys: row.targetKeys,
    turnCount: row.turnCount,
    lastJobId: row.lastJobId,
    lastSubmittedAt: row.lastSubmittedAt ? row.lastSubmittedAt.toISOString() : null,
    lastActivityAt: row.lastActivityAt.toISOString(),
    origin: row.origin,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    turns: turns.map(toPlanChangeTurnDto),
    workItemRefs,
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    endReason: row.endReason ?? null,
    copiedFromSessionId: row.copiedFromSessionId ?? null,
    runPause: runPause ? toPlanChangeRunPauseDto(runPause) : null,
  };
}
