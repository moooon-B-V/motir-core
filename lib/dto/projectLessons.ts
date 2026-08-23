// The browser-facing shapes for a project's LESSON LIBRARY (Subtask MOTIR-3337 ·
// Story MOTIR-3329) — what an admin reads in Settings → Project → AI planning.
//
// A DTO rather than motir-ai's raw row, per the boundary rule: the raw shape is
// the closed service's, this one is the product's, and the mapping is where a
// field the surface has no use for stops travelling.

/** Why a lesson is not currently being injected into the planner's prompt. */
export type LessonInjectionBlock = 'disabled' | 'not_recurred';

export interface ProjectLessonDTO {
  id: string;
  /** The takeaway — the one line a row shows. */
  title: string;
  /** What happened. */
  body: string;
  /** Why it matters. Not embedded upstream, and the reason the detail exists. */
  why: string;
  /** The actionable rule. */
  howToApply: string;
  /** Which card KIND / WORK TYPE / PLAN PHASE it applies to; empty = any. */
  kinds: string[];
  types: string[];
  phases: string[];
  /** Where it came from — a work-item key for a lesson captured after the freeze. */
  sourceRef: string | null;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601 — when the mistake last occurred (created, or last reinforced). */
  lastOccurredAt: string;
  /** How many times the mistake has been observed; 1 at creation. */
  recurrenceCount: number;
  /** Is the planner being told this today? */
  injected: boolean;
  /** Why not, when it is not. Null exactly when `injected` is true. */
  injectionBlock: LessonInjectionBlock | null;
}

/**
 * One page of the library, or the DEGRADED answer.
 *
 * ⚠️ `available: false` is a first-class value, not an error shape. The lessons
 * read is a cross-service call added to a settings page that has three working
 * groups on it and no dependency on motir-ai being up; a throw here would mean
 * an unrelated outage costs a customer the ability to change their sprint
 * length. The section going quiet is the correct failure.
 */
export interface ProjectLessonsPageDTO {
  available: boolean;
  lessons: ProjectLessonDTO[];
  nextCursor: string | null;
  /** The instant every row on this page was labelled against (ISO-8601). */
  staleCutoff: string | null;
  /** The retire-by-non-recurrence window in days, so the surface can explain it. */
  retentionDays: number | null;
}
