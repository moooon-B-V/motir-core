/**
 * Typed shape of the Prodect build plan — the data the `pnpm db:seed` loader
 * (scripts/plan-seed/seed.ts) turns into the `moooon` / `prodect` work-item
 * tree. This is the NEW source of truth for planning (PRODECT.md): planning
 * edits the per-story modules under `data/`, NOT the frozen `prodect_plan/`
 * HTML archive.
 *
 * The tree mirrors the plan's own grammar: Epic → Story → leaf (subtask / bug /
 * task). It maps onto `work_item` via the kind-parent matrix
 * (prisma/sql/work_item_triggers.sql): epic = root, story → epic,
 * subtask → {story, task, bug}. Leaf depth is therefore 3 (≤ the 4-level cap).
 */

/**
 * Plan-level status — the four states a plan card carries.
 *
 * `blocked` is set at expansion time when a freshly-planned subtask has at
 * least one `dependsOn` entry whose own status is NOT yet `done` (the
 * dependency is unmerged or still being planned). It maps onto the runtime
 * `workflow_status.key = 'blocked'` row from `lib/workflows/defaultWorkflow.ts`
 * (category `'todo'`, with allowed transitions `todo ↔ blocked` and
 * `in_progress ↔ blocked`). When every blocker reaches `done`, flip the
 * status to `planned` so the subtask enters the ready set.
 */
export type PlanStatus = 'planned' | 'blocked' | 'in_progress' | 'done';

/** Work-item kind a plan LEAF maps to (epics/stories get their kind implicitly). */
export type PlanLeafKind = 'subtask' | 'bug' | 'task';

/** A leaf plan card (the historical "Subtask" — a story's unit of execution). */
export interface PlanItem {
  /** Dotted plan id, e.g. "2.5.16". Carried into the work-item title prefix. */
  id: string;
  /** Defaults to 'subtask' when omitted. Use 'bug' for defect cards. */
  kind?: PlanLeafKind;
  title: string;
  status: PlanStatus;
  /** Plan card type: code / design / test / copy / content / manual / review / … */
  type?: string;
  executor?: 'coding_agent' | 'human';
  /** Agent/CI or human-work estimate, minutes → work_item.estimateMinutes. */
  estimateMinutes?: number;
  /** Full card prose as Markdown — description + acceptance criteria + context refs. */
  descriptionMd?: string;
  /** The card's "why this matters", when distinct → work_item.explanationMd. */
  explanationMd?: string;
  /** Dotted ids this card depends on → `is_blocked_by` links (this is_blocked_by dep). */
  dependsOn?: string[];
}

/** A story — parent of leaf items, child of an epic. */
export interface PlanStory {
  /** Dotted id, e.g. "2.5" (or "1.0.5"). */
  id: string;
  title: string;
  status: PlanStatus;
  /** Long-lived feature branch (story-level metadata, informational). */
  gitBranch?: string;
  /** Story overview prose (Markdown). */
  descriptionMd?: string;
  /** What the user does to accept the story (Markdown) — appended to the description. */
  verificationRecipeMd?: string;
  items: PlanItem[];
}

/** An epic — a top-level (root) work item. */
export interface PlanEpic {
  /** Numeric id, "1".."8". */
  id: string;
  title: string;
  status: PlanStatus;
  descriptionMd?: string;
  stories: PlanStory[];
  /**
   * Epic-direct leaf items — typically standalone **bugs** parented to the
   * Epic (Jira shape: a Bug is a sibling of Stories, not nested under one).
   * `bug.parent ∈ {epic, story, task}` so an epic parent is legal.
   */
  items?: PlanItem[];
}

/** Epic metadata as authored in `data/epics.ts` (stories attached in `index.ts`). */
export type EpicMeta = Omit<PlanEpic, 'stories'>;

/** Plan status → the project's default workflow_status key (lib/workflows/defaultWorkflow.ts). */
export const PLAN_STATUS_MAP: Record<PlanStatus, string> = {
  planned: 'todo',
  blocked: 'blocked',
  in_progress: 'in_progress',
  done: 'done',
};

/** The epic a dotted id belongs to: "1.0.5" → "1", "2.5" → "2". */
export function epicIdOf(dottedId: string): string {
  return dottedId.split('.')[0]!;
}
