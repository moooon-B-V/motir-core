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
// Two deliberate scope decisions, both per the Story 2.1 card:
//
//  1. FOUR product types, not five kinds. The v1 user-facing issue types are
//     `epic`, `story`, `task`, `bug`. The schema's fifth `kind` value,
//     `subtask`, is a structural kind governed by the DB constraint but is NOT
//     a v1 product-facing issue type, so it is intentionally absent here and
//     `canParent` does not range over it. If product surfaces ever expose
//     sub-tasks as a first-class type, add it to ISSUE_TYPES and the matrix
//     below — this is the one place that grows.
//
//  2. A typed in-code map, not a DB table. The type set is small, fixed for
//     v1, and read on nearly every render. A typed constant gives compile-time
//     safety and zero query cost. If per-project custom issue types ever become
//     a requirement, THIS module is the single seam that grows into a
//     table-backed lookup — YAGNI for v1 (the durable shape is a typed
//     constant, not a premature config table).
//
// `allowedChildTypes` is the product-readable form of the DB kind-parent
// matrix, restricted to the four product types. It is the parent→children
// inverse of the trigger's child→allowed-parents rule and must stay in lockstep
// with it:
//   DB (child → allowed parents)        →  this map (parent → allowed children)
//   epic    : root only                    epic  → [story, task, bug]
//   story   : {epic}                       story → [task, bug]
//   task    : {epic, story}                task  → [bug]
//   bug     : {epic, story, task}          bug   → []
// The service layer (Subtask 2.1.2) validates against `canParent` BEFORE any
// write so the API returns a clean typed 422 instead of leaning on the DB
// trigger's raw 23514; the trigger remains the defense-in-depth backstop.
//
// `icon` is the lucide component reference (not a string name): it is
// type-safe (a typo is a compile error), renders directly anywhere
// (`<meta.icon />`), and matches the existing `icon: <Comp />` convention used
// across the app shell (e.g. app/(authed)/_components/AppCommandPalette.tsx).
// `colorToken` is a design-system color token, consumed by callers as the CSS
// custom property `--color-{colorToken}` (e.g. Tailwind `text-(--color-accent)`
// / `bg-(--color-accent)`), matching how components/ui/Pill.tsx wires tones.

import { BookOpen, Bug, SquareCheckBig, Zap, type LucideIcon } from 'lucide-react';

/** The four v1 user-facing issue types, in display order (broadest → narrowest). */
export const ISSUE_TYPES = ['epic', 'story', 'task', 'bug'] as const;

export type IssueType = (typeof ISSUE_TYPES)[number];

/**
 * Design-system color tokens used by the issue types. Each maps to a
 * `--color-*` custom property declared in app/globals.css; callers reference it
 * as `--color-{IssueColorToken}`.
 */
export type IssueColorToken = 'accent' | 'accent-green' | 'info' | 'destructive';

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
    allowedChildTypes: ['story', 'task', 'bug'],
  },
  story: {
    type: 'story',
    label: 'Story',
    icon: BookOpen,
    colorToken: 'accent-green',
    allowedChildTypes: ['task', 'bug'],
  },
  task: {
    type: 'task',
    label: 'Task',
    icon: SquareCheckBig,
    colorToken: 'info',
    allowedChildTypes: ['bug'],
  },
  bug: {
    type: 'bug',
    label: 'Bug',
    icon: Bug,
    colorToken: 'destructive',
    allowedChildTypes: [],
  },
};

/** Narrowing guard: true when `value` is one of the four product issue types. */
export function isIssueType(value: unknown): value is IssueType {
  return typeof value === 'string' && (ISSUE_TYPES as readonly string[]).includes(value);
}

/**
 * True when an issue of `parentType` may directly parent an issue of
 * `childType`. The service layer (Subtask 2.1.2) calls this before any
 * create/move write; the DB trigger is the defense-in-depth backstop.
 */
export function canParent(parentType: IssueType, childType: IssueType): boolean {
  return ISSUE_TYPE_META[parentType].allowedChildTypes.includes(childType);
}
