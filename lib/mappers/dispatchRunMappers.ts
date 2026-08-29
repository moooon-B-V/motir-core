import type { DispatchRun, DispatchRunCard, DispatchRunEvent } from '@/generated/prisma/client';
import type {
  DispatchRunCardDto,
  DispatchRunDto,
  DispatchRunEventDto,
} from '@/lib/dto/dispatchRuns';

// Prisma rows → DISPATCH RUN DTOs (Story MOTIR-1789 · MOTIR-1792).
//
// Pure functions, called by `dispatchRunService` just before it returns. They do
// two things and nothing else: serialize `Date` to ISO strings, and DROP the
// columns no client is owed (`workspaceId`, `updatedAt`, `idempotencyKey`).
//
// ⚠️ `idempotencyKey` IS DELIBERATELY NOT ON THE WIRE. It is a value the CALLER
// supplied and already holds; echoing it back adds nothing and turns a
// caller-chosen string into a published field this contract would then owe
// stability to. `created` on the open result answers the only question the
// caller actually has about it.

export function toDispatchRunCardDto(row: DispatchRunCard): DispatchRunCardDto {
  return {
    id: row.id,
    key: row.workItemKey,
    workItemId: row.workItemId,
    position: row.position,
    disposition: row.disposition,
    skipReason: row.skipReason,
    sessionBranch: row.sessionBranch,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    exitCode: row.exitCode,
  };
}

export function toDispatchRunEventDto(row: DispatchRunEvent): DispatchRunEventDto {
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    cardId: row.dispatchRunCardId,
    data: row.data ?? null,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The run with its SET.
 *
 * `cards` arrives in `position` order from the repository's `include`, and this
 * mapper does NOT re-sort it — the order is the run's own stored fact, and a
 * mapper that sorted would be a second opinion about it.
 */
export function toDispatchRunDto(
  row: DispatchRun & { cards: DispatchRunCard[] },
  seq: number,
): DispatchRunDto {
  return {
    id: row.id,
    projectId: row.projectId,
    command: row.command,
    origin: row.origin,
    scopeWorkItemId: row.scopeWorkItemId,
    scopeLabel: row.scopeLabel,
    status: row.status,
    stopReason: row.stopReason,
    agent: row.agent,
    model: row.model,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    createdById: row.createdById,
    cards: row.cards.map(toDispatchRunCardDto),
    seq,
  };
}
