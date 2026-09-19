import type { MonitorIssueLinkDto } from '@/lib/dto/monitorIssueLink';
import { readOrgSlug } from '@/lib/mappers/monitorMappers';
import {
  MONITOR_ASSIGNEE_SYNC_NOTES,
  isMonitorResolveState,
  type MonitorAssigneeSyncNote,
} from '@/lib/monitors/syncStates';
import type { MonitorIssueWithConnection } from '@/lib/repositories/monitorIssueRepository';

// Prisma → DTO for the work-item page's error links (Story MOTIR-4932 ·
// Subtask MOTIR-5730). Called by `monitorIssueService` just before returning.

/** The stored note, narrowed to the closed vocabulary. A value the sync never
 *  writes reads as "no note" rather than as a note the section has no copy for. */
function toAssigneeNote(value: string | null): MonitorAssigneeSyncNote | null {
  return value !== null && (MONITOR_ASSIGNEE_SYNC_NOTES as readonly string[]).includes(value)
    ? (value as MonitorAssigneeSyncNote)
    : null;
}

export function toMonitorIssueLinkDto(row: MonitorIssueWithConnection): MonitorIssueLinkDto {
  return {
    id: row.id,
    title: row.title,
    level: row.level,
    culprit: row.culprit,
    permalink: row.permalink,
    eventCount: row.eventCount,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    environment: row.environment,
    release: row.release,
    connection: {
      id: row.connection.id,
      orgSlug: readOrgSlug(row.connection.installation.metadata),
      projectSlug: row.connection.externalProjectSlug,
    },
    resolve: {
      // The closed union is IMPORTED, never re-declared — a stored value outside
      // it (none is written) reads as "never attempted".
      state: isMonitorResolveState(row.resolveState) ? row.resolveState : null,
      attemptedAt: row.resolveAttemptedAt?.toISOString() ?? null,
      resolvedAt: row.resolvedByMotirAt?.toISOString() ?? null,
      error: row.resolveError,
    },
    assigneeNote: toAssigneeNote(row.assigneeSyncNote),
  };
}
