import type { FleetLastStopDTO } from '@/lib/dto/platformFleetStop';
import type { PlatformAuditLogWithActor } from '@/lib/repositories/platformAuditLogRepository';

/** A count out of the row's JSON metadata — 0 for anything that is not a number. */
function countOf(metadata: unknown, key: string): number {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 0;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The `fleet.stop` audit row → the Fleet card's last-stop line (MOTIR-7320).
 * The counts are the ones `platformFleetStopService.stop` wrote into the row's
 * metadata; the row is the record, so the card reads it rather than recomputing.
 */
export function toFleetLastStopDTO(row: PlatformAuditLogWithActor): FleetLastStopDTO {
  return {
    at: row.createdAt.toISOString(),
    actorEmail: row.actor?.email ?? null,
    reason: row.reason,
    runsCancelled: countOf(row.metadata, 'runsCancelled'),
    ciContainersStopped: countOf(row.metadata, 'ciContainersStopped'),
    hostedRunsEnded: countOf(row.metadata, 'hostedRunsEnded'),
    agentInstancesHibernated: countOf(row.metadata, 'agentInstancesHibernated'),
  };
}
