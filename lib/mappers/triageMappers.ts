import type { TriageQueueRow } from '@/lib/repositories/workItemRepository';
import type { TriageQueueItemDto, TriageSubmitterDto } from '@/lib/dto/triage';

// Prisma/projection → DTO converters for the triage inbox (Subtask 6.11.3). The
// service calls these just before returning so no Prisma row shape (Date
// objects, raw columns) leaks across the API boundary. Mirrors the shape of
// lib/mappers/workItemMappers.ts.

/** The bounded length of the queue-row body snippet (never the full blob). */
export const TRIAGE_SNIPPET_LENGTH = 200;

function snippet(md: string | null): string | null {
  if (md === null) return null;
  const trimmed = md.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > TRIAGE_SNIPPET_LENGTH
    ? `${trimmed.slice(0, TRIAGE_SNIPPET_LENGTH).trimEnd()}…`
    : trimmed;
}

/**
 * Resolve a triage row's submitter (ADR §3, the 2026-06-14 signed-in-only
 * revision — Subtask 6.11.10). Intake is signed-in only, so the submitter is the
 * real `submittedByUserId` account (joined into the row as `submitter*`); the
 * `kind` is `member` when that account is a member of the item's workspace
 * (`submitterIsMember`) and `public` for a signed-in non-member (Story 6.12).
 */
function toSubmitterDto(row: TriageQueueRow): TriageSubmitterDto {
  return {
    kind: row.submitterIsMember ? 'member' : 'public',
    userId: row.submittedByUserId,
    name: row.submitterName,
    email: row.submitterEmail,
    image: row.submitterImage,
  };
}

/**
 * Triage-queue row → DTO. The `triagedAt` marker is always non-null for a queue
 * row (the read filters `triagedAt IS NOT NULL`), so it maps to a required ISO
 * string; the nullable `snoozedUntil` / `descriptionMd` normalize to wire-safe
 * forms.
 */
export function toTriageQueueItemDto(row: TriageQueueRow): TriageQueueItemDto {
  return {
    id: row.id,
    kind: row.kind,
    key: row.key,
    identifier: row.identifier,
    title: row.title,
    descriptionSnippet: snippet(row.descriptionMd),
    status: row.status,
    priority: row.priority,
    submitter: toSubmitterDto(row),
    // Non-null by the read's `triagedAt IS NOT NULL` filter; `!` asserts that
    // invariant for the type (the row's column is nullable in general).
    triagedAt: row.triagedAt!.toISOString(),
    snoozedUntil: row.snoozedUntil ? row.snoozedUntil.toISOString() : null,
    voteCount: row.voteCount,
    createdAt: row.createdAt.toISOString(),
  };
}
