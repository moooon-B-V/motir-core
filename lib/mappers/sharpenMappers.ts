import type { SharpenSession, SharpenTurn } from '@/generated/prisma/client';
import type { SettledAnswer, SharpenAssumption, SharpenQuestion } from '@/lib/ai/types';
import type { SharpenSessionDto, SharpenTurnDto } from '@/lib/dto/sharpen';

// Sharpen session rows → DTO (Task MOTIR-1101 · Subtask MOTIR-8181). The store's
// JSON columns are opaque to the repository; this is where they are typed. Every
// value in them was written by `aiSharpenService` from a `parseSharpenTurn`
// result, so the shapes are the parsed ones.

/** The record a planner turn stores when its job failed. */
export interface SharpenFailedRecord {
  failed: true;
  reason: string;
}

export function isFailedRecord(record: unknown): record is SharpenFailedRecord {
  return (
    typeof record === 'object' &&
    record !== null &&
    (record as { failed?: unknown }).failed === true
  );
}

export function toSharpenTurnDto(row: SharpenTurn): SharpenTurnDto {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    action: row.action,
    body: row.body,
    readingId: row.readingId,
    jobId: row.jobId,
    failed: row.role === 'planner' && isFailedRecord(row.record),
    createdAt: row.createdAt.toISOString(),
  };
}

/** The person turn whose job has not produced a planner turn yet. Only the
 *  LATEST person turn can be in flight; an earlier one was answered or failed. */
export function inFlightTurn(turns: readonly SharpenTurn[]): SharpenTurn | null {
  const latest = [...turns].reverse().find((t) => t.role === 'person');
  if (!latest) return null;
  if (latest.jobId === null) return latest;
  const answered = turns.some((t) => t.role === 'planner' && t.jobId === latest.jobId);
  return answered ? null : latest;
}

export function toSharpenSessionDto(
  row: SharpenSession,
  turns: readonly SharpenTurn[],
  itemKey: string | null,
): SharpenSessionDto {
  const inFlight = inFlightTurn(turns);
  return {
    id: row.id,
    scope:
      row.scopeKind === 'plan'
        ? { kind: 'plan', planId: row.planId ?? undefined }
        : { kind: 'work_item', itemKey: itemKey ?? undefined },
    status: row.status,
    endReason: row.endReason,
    pendingQuestion: (row.pendingQuestion as SharpenQuestion | null) ?? null,
    settled: (row.settled as unknown as SettledAnswer[]) ?? [],
    assumptions: (row.assumptions as unknown as SharpenAssumption[]) ?? [],
    writeBack: (row.writeBack as SharpenSessionDto['writeBack']) ?? null,
    inFlight: inFlight ? { turnId: inFlight.id, jobId: inFlight.jobId } : null,
    turns: turns.map(toSharpenTurnDto),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
  };
}
