// The browser-facing shapes for a project's LESSON LIBRARY (Subtask MOTIR-3337 ·
// Story MOTIR-3329) — what an admin reads in Settings → Project → AI planning.
//
// A DTO rather than motir-ai's raw row, per the boundary rule: the raw shape is
// the closed service's, this one is the product's, and the mapping is where a
// field the surface has no use for stops travelling.

/** Why a lesson is not currently being injected into the planner's prompt. */
export type LessonInjectionBlock = 'disabled' | 'not_recurred';

/**
 * A person's standing decision about a lesson, which the retention clock may not
 * override (Story MOTIR-3330). Null means nobody has decided and the clock rules.
 */
export type LessonHumanOverride = 'retired' | 'exempt';

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
  /**
   * WHO decided this, and WHEN — the audit behind the `Not applied` badge
   * (Story MOTIR-3330).
   *
   * `humanOverride` is `retired` (somebody switched it off) or `exempt`
   * (somebody kept it despite the clock), else null. The other two are null
   * exactly when it is: a decision that has been undone leaves no actor behind.
   *
   * ⚠️ The SURFACE does not branch on `humanOverride` to pick a badge —
   * `injectionBlock` already answers that, and it deliberately reports a
   * retired lesson as `disabled` because to a reader it is the same fact. This
   * field is here so the row and the detail can SAY who and when.
   */
  humanOverride: LessonHumanOverride | null;
  /** ISO-8601, or null when no decision stands. */
  humanOverrideAt: string | null;
  /** The acting user's id, or null when no decision stands. */
  humanOverrideBy: string | null;
  /**
   * The retire-by-non-recurrence window, in days, that THIS lesson's label was
   * computed against — so a row reading "Not seen in {n} days" quotes the number
   * that produced it, and the DETAIL screen (which has no page to read it from)
   * renders the same label without a second request.
   */
  retentionDays: number;
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
  /**
   * The LIBRARY's size and its applied subset — not this page's.
   *
   * Separate fields because they are not derivable from `lessons`: the surface
   * says "{total} lessons · {applied} applied" (design §L9) and a client
   * counting the page would tell a project of fifty that it has one page.
   */
  total: number;
  applied: number;
  /** The instant every row on this page was labelled against (ISO-8601). */
  staleCutoff: string | null;
  /** The retire-by-non-recurrence window in days, so the surface can explain it. */
  retentionDays: number | null;
}
