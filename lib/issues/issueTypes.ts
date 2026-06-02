// Issue-type metadata + the kind→type rule layer (Story 2.1 · Subtask 2.1.1).
//
// Story 1.4's `work_item.kind` column already holds the structural kinds
// (epic / story / task / bug / subtask) and the DB triggers in
// prisma/sql/work_item_triggers.sql enforce the kind-parent matrix as the
// integrity backstop. This module is the PRODUCT-FACING layer on top: the
// single source of truth mapping each user-facing issue TYPE to its display
// metadata (label, icon, color token) and the set of allowed child types that
// every later issue-tracking surface (pickers, icons, validation) reads.
//
// Two deliberate decisions:
//
//  1. FIVE types, total over the schema's `kind` enum. The user-facing issue
//     types are `epic`, `story`, `task`, `bug`, `subtask` — the same five Jira
//     ships by default, and exactly the five values Story 1.4's `WorkItemKind`
//     enum + DB triggers already enforce. Keeping this map TOTAL over the kind
//     enum matters: a `subtask` row is a legal DB state (the trigger permits
//     `subtask.parentId ∈ {story, task, bug}`), so any picker / icon /
//     validation doing `ISSUE_TYPE_META[item.kind]` must resolve for every
//     kind. A four-type map would leave a partial-function hole on subtask
//     rows. (`subtask` was added here after review — the original Story 2.1
//     card under-scoped it to four; see the card's amended note.)
//
//  2. A typed in-code map, not a DB table. The type set is small, fixed for
//     v1, and read on nearly every render. A typed constant gives compile-time
//     safety and zero query cost. If per-project custom issue types ever become
//     a requirement, THIS module is the single seam that grows into a
//     table-backed lookup — YAGNI for v1 (the durable shape is a typed
//     constant, not a premature config table).
//
// `allowedChildTypes` is the product-readable form of the DB kind-parent
// matrix. The authoritative encoding of that matrix — plus the `canParent`
// predicate, the `isIssueType` guard, the `IssueType` union / `ISSUE_TYPES`
// tuple, and the service-layer `assertValidParent` gate — now lives in the
// UI-free module `lib/issues/parentRules.ts` (Subtask 2.1.2's
// single-source-of-truth reconciliation: the rule used to be duplicated
// between this file and workItemsService's private `ALLOWED_PARENT_KINDS`
// table). This file sources the matrix from there (`ALLOWED_CHILD_TYPES`) and
// re-exports the predicates/types so 2.1.1's public surface is unchanged, while
// keeping the icon/color presentation metadata — and the `lucide-react` import
// it needs — out of the server-side service module graph.
// Note bug is NOT a leaf — a subtask may be parented to a bug. The single leaf
// is `subtask` (nothing may parent to it). The service layer (Subtask 2.1.2)
// validates via `assertValidParent` (which delegates to `canParent`) BEFORE any
// write so the API returns a clean typed 422 instead of leaning on the DB
// trigger's raw 23514; the trigger remains the defense-in-depth backstop.
//
// DELIBERATE DEVIATION FROM JIRA (planner decision, PRODECT_FINDINGS #41).
// Default Jira keeps Story / Task / Bug as strict siblings (Epic → standard
// issue → Sub-task only). This matrix is deeper — it also allows story→task,
// story→bug, and task→bug. That is an intentional, justified deviation, NOT an
// oversight: Prodect is AI-native and the work-item tree IS the execution DAG,
// so scoping finer work under coarser work earns rollup (a task isn't done
// while it has open child bugs) and coding-agent context inheritance. Prodect
// already plans itself this way (Epic → Story → typed sub-work). Per the
// justified-deviation rule, the richer shape ships only because a concrete use
// case earns its complexity.
//
// `icon` is the lucide component reference (not a string name): it is
// type-safe (a typo is a compile error), renders directly anywhere
// (`<meta.icon />`), and matches the existing `icon: <Comp />` convention used
// across the app shell (e.g. app/(authed)/_components/AppCommandPalette.tsx).
// `colorToken` is a design-system color token, consumed by callers as the CSS
// custom property `--color-{colorToken}` (e.g. Tailwind `text-(--color-accent)`
// / `bg-(--color-accent)`), matching how components/ui/Pill.tsx wires tones.

import { BookOpen, Bug, ListChecks, SquareCheckBig, Zap, type LucideIcon } from 'lucide-react';
import { ALLOWED_CHILD_TYPES, type IssueType } from '@/lib/issues/parentRules';

// Re-export the rule-layer primitives so 2.1.1's public surface
// (`@/lib/issues/issueTypes`) is unchanged for existing importers/tests.
export { ISSUE_TYPES, canParent, isIssueType } from '@/lib/issues/parentRules';
export type { IssueType } from '@/lib/issues/parentRules';

/**
 * Design-system color tokens used by the issue types. Each maps to a
 * `--color-*` custom property declared in app/globals.css; callers reference it
 * as `--color-{IssueColorToken}`.
 */
export type IssueColorToken = 'accent' | 'accent-green' | 'info' | 'destructive' | 'accent-teal';

export interface IssueTypeMeta {
  /** The type itself, so a meta object is self-describing when passed around. */
  type: IssueType;
  /** Human-facing singular label (e.g. "Epic"). */
  label: string;
  /** lucide-react component reference; render as `<meta.icon />`. */
  icon: LucideIcon;
  /** Design-system color token; consume as `--color-{colorToken}`. */
  colorToken: IssueColorToken;
  /** Issue types this type may directly parent (product-readable kind-parent matrix). */
  allowedChildTypes: readonly IssueType[];
}

/**
 * The single source of truth for issue-type metadata. Keyed by IssueType so a
 * lookup is total and type-checked (`ISSUE_TYPE_META[type]` can never miss).
 */
export const ISSUE_TYPE_META: Record<IssueType, IssueTypeMeta> = {
  epic: {
    type: 'epic',
    label: 'Epic',
    icon: Zap,
    colorToken: 'accent',
    allowedChildTypes: ALLOWED_CHILD_TYPES.epic,
  },
  story: {
    type: 'story',
    label: 'Story',
    icon: BookOpen,
    colorToken: 'accent-green',
    allowedChildTypes: ALLOWED_CHILD_TYPES.story,
  },
  task: {
    type: 'task',
    label: 'Task',
    icon: SquareCheckBig,
    colorToken: 'info',
    allowedChildTypes: ALLOWED_CHILD_TYPES.task,
  },
  bug: {
    type: 'bug',
    label: 'Bug',
    icon: Bug,
    colorToken: 'destructive',
    allowedChildTypes: ALLOWED_CHILD_TYPES.bug,
  },
  subtask: {
    type: 'subtask',
    label: 'Sub-task',
    icon: ListChecks,
    colorToken: 'accent-teal',
    allowedChildTypes: ALLOWED_CHILD_TYPES.subtask,
  },
};
