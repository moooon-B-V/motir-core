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

// ── THE HAND-MADE LINK (Story MOTIR-4932 · Subtask MOTIR-5731) ───────────────

/** Who holds a search candidate today: nobody, THIS work item, or another one
 *  (by its key) — what lets the picker say *Linked to KEY-n* before a click. */
export type MonitorIssueHolderDto = null | 'this' | { identifier: string };

/** One issue a person can pick from the link search. */
export interface MonitorIssueCandidateDto {
  connectionId: string;
  /** The connection's organisation slug, stored on its grant (`null` when the
   *  grant recorded none) — the picker's `<org> / <project>` line (MOTIR-5744). */
  orgSlug: string | null;
  /** The monitored project's slug — how a result says where it came from when
   *  the project binds more than one. */
  projectSlug: string;
  externalIssueId: string;
  title: string;
  level: string | null;
  eventCount: number;
  lastSeenAt: string;
  permalink: string | null;
  linkedTo: MonitorIssueHolderDto;
}

/** One connection whose search failed, with the PROVIDER's own words. The
 *  other connections' results still stand. */
export interface MonitorIssueSearchFailureDto {
  connectionId: string;
  orgSlug: string | null;
  projectSlug: string;
  reason: string;
}

export interface MonitorIssueSearchResultDto {
  candidates: MonitorIssueCandidateDto[];
  failures: MonitorIssueSearchFailureDto[];
  /** The project binds no monitored project: nothing was searched. */
  noConnection: boolean;
  /** The project binds more monitored projects than one search fans out to;
   *  the first ones by creation were searched. */
  truncated: boolean;
}

/** What a link did. `already_linked_here` is a success — a double click is not
 *  an error. */
export type MonitorIssueLinkOutcome = 'linked' | 'already_linked_here' | 'moved';

export interface MonitorIssueLinkResultDto {
  outcome: MonitorIssueLinkOutcome;
  /** The card's links AFTER the write, through the same read the section renders
   *  from, so the two can never disagree about shape. */
  links: MonitorIssueLinkDto[];
}
