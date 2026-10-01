import type { AgentInstance, AgentInstanceInterval } from '@/generated/prisma/client';
import type {
  AgentInstanceActiveRunDto,
  AgentInstanceDto,
  AgentInstanceImageFields,
  AgentInstanceIntervalDto,
  AgentInstanceLastRunDto,
} from '@/lib/dto/agentInstances';
import type {
  DispatchRunTargetCard,
  LatestDispatchRunInAgent,
  RunningDispatchRunInAgent,
} from '@/lib/repositories/dispatchRunRepository';

// Prisma rows → AGENT INSTANCE DTOs (Story MOTIR-6860 · MOTIR-6870).
//
// Pure functions. They serialize `Date` to ISO strings and DROP what no client
// is owed: the tenancy columns, the owner (the reader IS the owner — §8), the
// Fly handle, `deletedAt` (a deleted row is never returned) and the charge's
// internals (reference, attempts, detail).

export function toAgentInstanceDto(
  row: AgentInstance,
  image: AgentInstanceImageFields,
): AgentInstanceDto {
  return {
    id: row.id,
    name: row.name,
    projectId: row.projectId,
    profileId: row.profileId,
    imageTag: row.imageTag,
    imageDigest: row.imageDigest,
    imageVersion: row.imageVersion ?? image.imageVersion,
    update: image.update,
    pendingImageVersion: row.targetImageDigest ? row.targetImageVersion : null,
    updateFailureReason: row.updateFailureReason,
    region: row.region,
    state: row.state,
    failureReason: row.failureReason,
    terminalServer: row.terminalServer,
    stateChangedAt: row.stateChangedAt.toISOString(),
    lastActivityAt: row.lastActivityAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toAgentInstanceIntervalDto(row: AgentInstanceInterval): AgentInstanceIntervalDto {
  return {
    id: row.id,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    endReason: row.endReason,
    billableSeconds: row.billableSeconds,
    credits: row.credits,
    chargeOutcome: row.chargeOutcome,
  };
}

/** The run working in an agent → the panel's run line (MOTIR-7029). */
export function toAgentInstanceActiveRunDto(
  run: Pick<RunningDispatchRunInAgent, 'id' | 'startedAt'>,
  target: DispatchRunTargetCard | null,
): AgentInstanceActiveRunDto {
  return {
    id: run.id,
    workItemKey: target?.workItemKey ?? null,
    title: target?.title ?? null,
    startedAt: run.startedAt.toISOString(),
  };
}

/** A latest run that has CLOSED — the only kind the "Last run" line shows. */
export type ClosedDispatchRunInAgent = LatestDispatchRunInAgent & {
  status: AgentInstanceLastRunDto['status'];
};

/** Narrow an agent's latest run to a closed one (a running one is the active run's). */
export function isClosedRunInAgent(run: LatestDispatchRunInAgent): run is ClosedDispatchRunInAgent {
  return run.status !== 'running';
}

/**
 * An agent's latest CLOSED run → its "Last run" line (MOTIR-7029). The recorded
 * reason is kept only on a run that did not succeed: a success needs no reason,
 * and the line shows the title instead.
 */
export function toAgentInstanceLastRunDto(
  run: ClosedDispatchRunInAgent,
  target: DispatchRunTargetCard | null,
  reason: string | null,
): AgentInstanceLastRunDto {
  return {
    id: run.id,
    workItemKey: target?.workItemKey ?? null,
    title: target?.title ?? null,
    status: run.status,
    endedAt: run.endedAt?.toISOString() ?? null,
    reason: run.status === 'succeeded' ? null : reason,
  };
}

/** The recorded reason an end line carries (`data.message`), or null. */
export function endLineReason(data: unknown): string | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const message = (data as Record<string, unknown>)['message'];
  return typeof message === 'string' && message.trim() !== '' ? message : null;
}
