import type {
  MonitorEvidenceFrameDto,
  MonitorIssueEvidenceDto,
  MonitorIssueLinkDto,
} from '@/lib/dto/monitorIssueLink';
import type { MonitorIssue } from '@/generated/prisma/client';
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

/** The stored frames, re-validated on the way out: a JSON column is trusted to
 *  be well-formed only as far as each field's type, and a frame naming no file
 *  is dropped exactly as the adapter drops one. */
function readFrames(value: unknown): MonitorEvidenceFrameDto[] {
  if (!Array.isArray(value)) return [];
  const frames: MonitorEvidenceFrameDto[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const frame = raw as Record<string, unknown>;
    if (typeof frame['filePath'] !== 'string' || !frame['filePath']) continue;
    frames.push({
      filePath: frame['filePath'],
      function: typeof frame['function'] === 'string' ? frame['function'] : null,
      lineNumber: typeof frame['lineNumber'] === 'number' ? frame['lineNumber'] : null,
      inApp: typeof frame['inApp'] === 'boolean' ? frame['inApp'] : null,
    });
  }
  return frames;
}

/** The stored tags, re-validated the same way. */
function readTags(value: unknown): { key: string; value: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (tag): tag is { key: string; value: string } =>
        !!tag &&
        typeof tag === 'object' &&
        typeof (tag as { key?: unknown }).key === 'string' &&
        typeof (tag as { value?: unknown }).value === 'string',
    )
    .map((tag) => ({ key: tag.key, value: tag.value }));
}

/**
 * The link's EVIDENCE and its display state (Story MOTIR-5975 · Subtask
 * MOTIR-5979). The ONE derivation every surface reads:
 *
 * - `never_read` ⇔ `evidence_read_at IS NULL`;
 * - `no_exception` ⇔ read, with no exception type or message and no frames;
 * - `present` otherwise;
 * - `stale` ⇔ `evidence_checked_at > evidence_read_at`, both present — a
 *   never-read link has nothing old to be stale ABOUT, so it stays `never_read`
 *   however many checks have failed.
 */
export function toMonitorIssueEvidenceDto(row: MonitorIssue): MonitorIssueEvidenceDto {
  const frames = readFrames(row.frames);
  const exception =
    row.exceptionType !== null || row.exceptionMessage !== null
      ? { type: row.exceptionType, message: row.exceptionMessage }
      : null;
  const readAt = row.evidenceReadAt;
  const checkedAt = row.evidenceCheckedAt;
  const stale = readAt !== null && checkedAt !== null && checkedAt.getTime() > readAt.getTime();
  return {
    state:
      readAt === null
        ? 'never_read'
        : exception === null && frames.length === 0
          ? 'no_exception'
          : 'present',
    stale,
    exception,
    frames,
    tags: readTags(row.tags),
    request: row.requestPath !== null ? { method: row.requestMethod, path: row.requestPath } : null,
    eventId: row.eventId,
    eventAt: row.eventAt?.toISOString() ?? null,
    readAt: readAt?.toISOString() ?? null,
    lastFailedAt: stale ? checkedAt!.toISOString() : null,
  };
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
    evidence: toMonitorIssueEvidenceDto(row),
  };
}
