import type { MonitorAssigneeSyncNote, MonitorResolveState } from '@/lib/monitors/syncStates';

// The work-item page's ERROR LINKS (Story MOTIR-4932 · Subtask MOTIR-5730) —
// one row per monitor issue linked to a card, carrying ONLY what the reconciler
// and the sync have already stored. Nothing here is read from the provider on
// page load: the section renders the store, and trusts it.

/** One monitor issue linked to a work item. */
export interface MonitorIssueLinkDto {
  /** `monitor_issue.id` — what an unlink addresses. */
  id: string;
  title: string;
  /**
   * The provider's level, VERBATIM. A string rather than a union because the
   * ingestion store lets an unknown level through deliberately (MOTIR-5576); the
   * section decides how to show one it does not recognise.
   */
  level: string | null;
  culprit: string | null;
  permalink: string | null;
  eventCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  /** The latest event's environment and release (MOTIR-5729); `null` = none
   *  carried, or never read. */
  environment: string | null;
  release: string | null;
  /** The connection the link came from, by its STORED labels — never resolved
   *  live (the MOTIR-5258 column comment's reason). */
  connection: {
    id: string;
    orgSlug: string | null;
    projectSlug: string;
  };
  /** The resolve-back record (MOTIR-5701). `state: null` = never attempted.
   *  `attemptedAt` is when the current or last attempt was taken — the failed
   *  line's "Tried <when>" (the design's §14 TAKES on this card). */
  resolve: {
    state: MonitorResolveState | null;
    attemptedAt: string | null;
    resolvedAt: string | null;
    error: string | null;
  };
  /** Why the monitor's assignee was NOT applied, or `null` (MOTIR-5705). */
  assigneeNote: MonitorAssigneeSyncNote | null;
}
