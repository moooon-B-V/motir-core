import type {
  DispatchCardDisposition,
  DispatchRun,
  DispatchRunCard,
  DispatchRunEvent,
} from '@/generated/prisma/client';
import type {
  DispatchRunCardDto,
  DispatchRunDto,
  DispatchRunEventDto,
  DispatchRunLegCountsDto,
  DispatchRunListItemDto,
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

/**
 * Every disposition at zero — the base a run's leg counts are added onto.
 *
 * ⚠️ WRITTEN OUT RATHER THAN DERIVED, and `satisfies` is what makes that safe:
 * the generated client exports the enum as a TYPE here, and a runtime list of
 * its members would be a second copy of a closed set to keep total. Spelling the
 * keys makes adding a disposition to the ADR a compile error in this file, which
 * is exactly where a new value needs to be noticed — the index renders these
 * counts, so a member missing here renders as nothing at all.
 */
const NO_LEGS = {
  queued: 0,
  running: 0,
  integrated: 0,
  implemented: 0,
  failed: 0,
  replanned: 0,
  skipped: 0,
  not_reached: 0,
} as const satisfies Record<DispatchCardDisposition, number>;

/** The run's legs COUNTED by disposition, total over the enum. */
export function toDispatchRunLegCounts(cards: DispatchRunCard[]): DispatchRunLegCountsDto {
  const counts: DispatchRunLegCountsDto = { ...NO_LEGS };
  for (const card of cards) counts[card.disposition] += 1;
  return counts;
}

/**
 * One row of the RUNS INDEX (MOTIR-3922): the header, and the set as COUNTS.
 *
 * The counts are derived from the `cards` the query already included, so a page
 * of fifty runs costs the same one query a page of one does. Nothing here reads
 * a leg's key: the index says how a run came out, and the run view says which
 * cards it came out that way on.
 */
export function toDispatchRunListItemDto(
  row: DispatchRun & { cards: DispatchRunCard[] },
): DispatchRunListItemDto {
  return {
    id: row.id,
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
    cardCount: row.cards.length,
    legs: toDispatchRunLegCounts(row.cards),
  };
}
