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

/**
 * What recording an occurrence against a lesson answers with (Subtask
 * MOTIR-3553 · Bug MOTIR-3547).
 *
 * Deliberately NOT `ProjectLessonDTO`. That one is the LIBRARY row an admin
 * reads, carrying the whole lifecycle a settings screen renders; this answers a
 * WRITE made by an agent, and the only questions it has are "which lesson did I
 * just reinforce" and "did this call count". Returning the library row here
 * would ship a lifecycle nobody asked about to a caller that cannot act on it.
 */
export interface ReinforcedLessonDTO {
  id: string;
  /** The takeaway, so a caller can name what it reinforced without a re-read. */
  title: string;
  /** `global` (the shared corpus) or `tenant` (this project's own). */
  scope: string;
  /** The clock, as it now stands. */
  lastOccurredAt: string;
  /** How many occurrences this lesson has, including this one if it counted. */
  recurrenceCount: number;
  /**
   * Whether THIS call is the one that counted.
   *
   * ⚠️ `false` is a NORMAL answer and must stay readable as one: the occurrence
   * was already on the lesson's ledger, so nothing was written and both counters
   * are unchanged. A caller that cannot tell "recorded" from "already recorded"
   * will either re-try forever or report a recurrence that did not happen.
   */
  counted: boolean;
}

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

// ── The TEACHING read's shapes (Subtask MOTIR-3478 · Story MOTIR-3466) ───────

/**
 * One lesson as the teaching read returns it — PROSE, plus the axes it is tagged
 * on so a caller can see WHY it came back and re-narrow.
 *
 * ⚠️ IT IS NOT `ProjectLessonDTO`, and the difference is deliberate rather than
 * an oversight. That one is the LIBRARY row an admin reads: it carries the
 * lifecycle a settings screen renders — `injected`, `injectionBlock`,
 * `humanOverride`, `recurrenceCount`, `retentionDays` — and none of that is a
 * question the caller of a search is asking. This one carries `scope`, which
 * `ProjectLessonDTO` deliberately DROPS because an inspection row is always
 * `tenant`; here both scopes arrive and which one a lesson came from is part of
 * the answer.
 */
export interface RankedLessonDTO {
  id: string;
  /** The takeaway. */
  title: string;
  /** What happened. */
  body: string;
  /** The actionable rule. */
  howToApply: string;
  /** `global` (the shared corpus) or `tenant` (this project's own). */
  scope: string;
  /** Which card KIND / WORK TYPE / PLAN PHASE it applies to; empty = any. */
  kinds: string[];
  types: string[];
  phases: string[];
  /** Cosine distance to the query; lower is nearer. */
  distance: number;
}

/**
 * The result of a lesson search — THREE outcomes a caller can tell apart.
 *
 * ⚠️ THIS IS THE WHOLE REASON THE TYPE IS A UNION RATHER THAN AN ARRAY, and it
 * is the one place this seam deliberately parts company with `listLessons`.
 * That read DEGRADES: a motir-ai outage renders as `{ available: false,
 * lessons: [] }` and the settings page stays usable, which is right for a page
 * with three working groups on it that has no dependency on motir-ai being up.
 *
 * **That posture is wrong here.** The caller is an agent deciding whether a past
 * mistake applies to the work in front of it, and *"nothing matched your
 * question"* and *"the corpus could not be reached"* are OPPOSITE answers. The
 * first says the corpus has been consulted and has nothing; the second says it
 * has not been consulted at all. Rendering the second as the first is a search
 * that reports "nothing exists" truthfully and wrongly — and the agent proceeds
 * believing it checked.
 *
 * So the outcomes are named, the way `search_work_items_semantic` names its own,
 * and an outage is never an empty result set.
 */
export type LessonSearchResult =
  | { outcome: 'matched'; lessons: RankedLessonDTO[] }
  | { outcome: 'nothing-matched'; lessons: [] }
  | { outcome: 'unavailable'; lessons: [] };
