// DTOs for the AI sprint-planning REVIEW read (Story 7.13 · Subtask MOTIR-1750).
//
// MOTIR-918 shipped submit / stream / approve; what it never shipped is the read
// the REVIEW surface needs. A `SprintAssignmentDelta` carries only work-item
// KEYS, so a browser holding the raw job result cannot render a row (no title, no
// kind, no estimate, no status) and cannot draw the "after MOTIR-1749" caption
// (the `is_blocked_by` edges among the packed items). Both are SERVER facts, so
// they are resolved server-side and cross the boundary as this DTO rather than
// being guessed in the client (design/ai-planning/design-notes.md Part II §4).

import type { SprintAssignmentDelta } from '@/lib/ai/types';
import type { WorkItemSummaryDto } from '@/lib/dto/workItems';

/** One packed work item, resolved for render. */
export interface SprintPlanReviewItemDto {
  /** The same summary shape the backlog / sprint rows already bind. */
  item: WorkItemSummaryDto;
  /**
   * The keys of this item's `is_blocked_by` blockers that are ALSO in this
   * packing — the caption's source. Edges pointing outside the packing are
   * dropped: the packing cannot order what it does not contain (the same rule
   * `aiSprintPlanningService.validatePacking` applies). Empty → no caption.
   */
  blockedByKeys: string[];
}

/**
 * What the review surface reads for a `plan_sprint` job.
 *
 * `proposal` is `null` whenever the job carries no sprint assignment yet (still
 * running) or produced none — a legitimate "nothing to schedule" outcome, never
 * an error (`aiSprintPlanningService.approveSprintPlan` treats an empty packing
 * as a no-op too).
 *
 * `items` is keyed by work-item identifier and covers EVERY key in the proposal;
 * a key that no longer resolves to a live item of this project is simply absent
 * (the packing may have gone stale between the run and the review — the approve
 * path is what refuses it, with nothing written).
 */
export interface SprintPlanReviewDto {
  jobStatus: string;
  proposal: SprintAssignmentDelta | null;
  items: Record<string, SprintPlanReviewItemDto>;
}
