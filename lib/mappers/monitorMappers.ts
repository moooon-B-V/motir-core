import type { MonitorConnectionDto } from '@/lib/dto/monitors';
import type { MonitorConnectionWithGrant } from '@/lib/repositories/monitorConnectionRepository';

// Prisma → DTO for the monitor connection surface (Story MOTIR-4926 ·
// MOTIR-5260). Called by the service just before returning, per CLAUDE.md.

/** The Sentry organisation slug the grant recorded, if it recorded one. Read
 *  defensively: `metadata` is a provider-shaped `Json?` and a row written by a
 *  different provider need not carry this key at all. */
export function readOrgSlug(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null;
  const slug = (metadata as Record<string, unknown>)['orgSlug'];
  return typeof slug === 'string' && slug.length > 0 ? slug : null;
}

/** Whether a grant was stored before its install was VERIFIED and its
 *  organisation read (MOTIR-6008) — the marker `completeGrant` writes when a
 *  follow-up call fails, and `completePendingInstall` clears. */
export function readInstallPending(metadata: unknown): boolean {
  if (typeof metadata !== 'object' || metadata === null) return false;
  return (metadata as Record<string, unknown>)['installPending'] === true;
}

/** The stored poll status, narrowed to the two values the poll writes. A value
 *  it never writes reads as "never polled" rather than as a status the room
 *  has no copy for. */
function toPollStatus(value: string | null): 'ok' | 'failed' | null {
  return value === 'ok' || value === 'failed' ? value : null;
}

export function toMonitorConnectionDto(row: MonitorConnectionWithGrant): MonitorConnectionDto {
  return {
    id: row.id,
    provider: row.installation.provider,
    externalProjectId: row.externalProjectId,
    externalProjectSlug: row.externalProjectSlug,
    health: row.installation.health,
    // Passed through unaltered — the credential-lifecycle card stores the
    // provider's own words and this is where a person finally reads them.
    healthReason: row.installation.healthReason,
    healthCheckedAt: row.installation.healthCheckedAt?.toISOString() ?? null,
    orgSlug: readOrgSlug(row.installation.metadata),
    createdAt: row.createdAt.toISOString(),
    minimumLevel: row.minimumLevel,
    lastPolledAt: row.lastPolledAt?.toISOString() ?? null,
    lastPollStatus: toPollStatus(row.lastPollStatus),
    lastPollError: row.lastPollError,
    lastPollFiledCount: row.lastPollFiledCount,
    lastPollSucceededAt: row.lastPollSucceededAt?.toISOString() ?? null,
    resolveOnDone: row.resolveOnDone,
    syncAssignee: row.syncAssignee,
    lastSyncError: row.lastSyncError,
    lastSyncErrorAt: row.lastSyncErrorAt?.toISOString() ?? null,
    lastSyncErrorWorkItemIdentifier: row.lastSyncErrorWorkItemIdentifier,
  };
}
