// DTOs for the triage inbox (Story 6.11). What crosses the HTTP / Server-Action
// boundary for the triage-queue read (Subtask 6.11.3) — no Prisma row shape
// leaks. Dates become ISO-8601 strings; the submitter is resolved to a single
// discriminated shape (member vs external) so the inbox UI (6.11.6) renders an
// avatar OR an "external" chip without re-deriving origin.

import type { WorkItemKindDto, WorkItemPriorityDto } from './workItems';

/**
 * Who submitted a triage item (ADR §3). `member` = an in-app submission whose
 * reporter IS the submitter (a real `User`); `external` = an unauthenticated
 * public-portal submission attributed to the per-project intake user, with the
 * real submitter captured as a name/email and NO tenant account. Origin is
 * derived from `externalSubmitterEmail IS NOT NULL` on the row — no redundant
 * column is stored.
 */
export type TriageSubmitterDto =
  | {
      kind: 'member';
      /** The submitting member's user id (the work item's reporter). */
      userId: string;
      name: string | null;
      email: string | null;
      image: string | null;
    }
  | {
      kind: 'external';
      /** External submissions have no account. */
      userId: null;
      name: string | null;
      email: string | null;
      image: null;
    };

/**
 * One row of the triage inbox queue. The lighter list shape (no full Markdown
 * body — a bounded `descriptionSnippet` instead) plus the triage-specific
 * fields: submitter attribution, the `triagedAt` age timestamp, and
 * `snoozedUntil` (always null for an item in the ACTIVE queue, carried for the
 * snoozed-variant view).
 */
export interface TriageQueueItemDto {
  id: string;
  /** A submission is born `bug` (bug report) or `task` (feature request). */
  kind: WorkItemKindDto;
  key: number;
  identifier: string;
  title: string;
  /** A bounded prefix of the submission body (never the full `@db.Text` blob). */
  descriptionSnippet: string | null;
  status: string;
  priority: WorkItemPriorityDto;
  submitter: TriageSubmitterDto;
  /** When the item entered triage (ISO-8601) — the inbox renders its age. */
  triagedAt: string;
  /** Snooze-until (ISO-8601), or null when active. */
  snoozedUntil: string | null;
  createdAt: string;
}

/**
 * One page of the triage queue. `nextCursor` is the opaque seek-after token for
 * the following page, or null when this is the last page (finding #57 — the
 * inbox is cursor-paginated, never load-all).
 */
export interface TriageQueuePageDto {
  items: TriageQueueItemDto[];
  nextCursor: string | null;
}

/**
 * What the intake path returns after creating a triage submission (Subtask
 * 6.11.4). A thin confirmation — the in-app widget (6.11.7) only needs to toast
 * success and may deep-link by `identifier`; the full body lives in the inbox
 * (the queue / detail reads). The created item is in the `triage` state, so it
 * is NOT yet in the tree / board / list / search.
 */
export interface TriageSubmissionResultDto {
  id: string;
  /** A submission is born `bug` (bug report) or `task` (feature request). */
  kind: WorkItemKindDto;
  /** The allocated work-item identifier (e.g. "PROD-42"). */
  identifier: string;
  title: string;
}
