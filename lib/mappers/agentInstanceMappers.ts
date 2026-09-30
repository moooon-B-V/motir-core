import type { AgentInstance, AgentInstanceInterval } from '@/generated/prisma/client';
import type { AgentInstanceDto, AgentInstanceIntervalDto } from '@/lib/dto/agentInstances';

// Prisma rows → AGENT INSTANCE DTOs (Story MOTIR-6860 · MOTIR-6870).
//
// Pure functions. They serialize `Date` to ISO strings and DROP what no client
// is owed: the tenancy columns, the owner (the reader IS the owner — §8), the
// Fly handle, `deletedAt` (a deleted row is never returned) and the charge's
// internals (reference, attempts, detail).

export function toAgentInstanceDto(row: AgentInstance): AgentInstanceDto {
  return {
    id: row.id,
    name: row.name,
    projectId: row.projectId,
    profileId: row.profileId,
    imageTag: row.imageTag,
    imageDigest: row.imageDigest,
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
