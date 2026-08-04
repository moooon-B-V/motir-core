'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { planningWorkspaceHref } from '@/lib/planning/launcher';
import { planEntranceFace } from '@/lib/planning/planEntranceVisibility';
import type { StatusCategoryDto } from '@/lib/dto/workflows';
import type { WorkItemKindDto } from '@/lib/dto/workItems';

// The PER-ITEM Plan / Re-plan entrance (Subtask MOTIR-910; design
// `design/work-items/plan-replan-entrance.mock.html` panels 1–4). The contextual
// door that sits ON a work item — the detail page header's right cluster and the
// quick-view / peek modal's header bar — opening the SHIPPED universal planning
// workspace scoped to that item.
//
// It is deliberately NOT a second `PlanWithAILauncher`: the launcher is the
// GLOBAL hero pill in `TopNav` ("plan something"), while this is a quiet,
// per-item affordance sitting among the item's own controls. Both resolve their
// href through the same `planningWorkspaceHref`, so there is exactly one entry
// path into the workspace and one place that decides the mode.
//
// TWO FACES (design "Modes"), and WHICH one it wears is decided by the shared
// Plan / Re-plan rule (`planEntranceFace`, MOTIR-2097) — for a CONTAINER by
// whether it has children, for a LEAF by whether it has a description:
//   * Plan    — nothing to re-plan yet. Accent-outlined pill; the workspace
//               opens and the AI starts from the item's own description. No
//               opening reason.
//   * Re-plan — there IS an existing plan (a container's children, a leaf's
//               description). Subdued pill (it is an EDIT of existing work); the
//               workspace opens with the composer asking what's wrong, and the
//               user's first chat turn IS the reason (MOTIR-908 classifies the
//               intent from it — there is no reason param).
//
// Colour flows through `--el-*` and shape through the element-semantic tokens, so
// the pill re-skins with `data-palette` and re-shapes with `data-style`. It is a
// real `<Link>`: keyboard-reachable, middle/⌘-clickable, and (from the peek)
// `onActivate` hands off by closing the modal first.
//
// BOTH decisions — whether it renders and which face it wears — are made HERE
// from the item state its host hands it, by the shared rule (`planEntranceFace`,
// MOTIR-2084 + MOTIR-2097). The component applies the rule itself, so it travels
// with the component instead of being re-derived — and re-missed — at each call
// site. The state props are REQUIRED for exactly that reason: a new host cannot
// mount the door without stating the item's plannability.

export interface WorkItemPlanEntranceProps {
  /** The item's human identifier (e.g. `MOTIR-42`) — the workspace's anchor. */
  itemKey: string;
  /** Does the item have children? The CONTAINER face (rule 3). */
  hasChildren: boolean;
  /**
   * The item's kind — decides whether the face comes from the children
   * (container) or the description (leaf). Required — see `planEntranceFace`.
   */
  kind: WorkItemKindDto;
  /** Does the item have a non-empty description? The LEAF face (rule 2). */
  hasDescription: boolean;
  /**
   * May this actor open the planning workspace on the item (the project's
   * `canEdit`)? Required — see `planEntranceFace`.
   */
  canPlan: boolean;
  /** Is the item archived (`archivedAt != null`)? Required — see `planEntranceFace`. */
  archived: boolean;
  /**
   * The item's status CATEGORY (not its status key) — a `done`-category item is
   * finished work the engine refuses to re-plan. Required — see
   * `planEntranceFace`.
   */
  statusCategory: StatusCategoryDto | null;
  /**
   * Fired just before navigating — the quick-view passes its close so the modal
   * is dismissed as the workspace opens (design panel 3: "clicking it closes the
   * modal — a handoff to the planning surface"). The detail page passes nothing.
   */
  onActivate?: () => void;
  className?: string;
}

export function WorkItemPlanEntrance({
  itemKey,
  hasChildren,
  kind,
  hasDescription,
  canPlan,
  archived,
  statusCategory,
  onActivate,
  className,
}: WorkItemPlanEntranceProps) {
  const t = useTranslations('aiPlanning.entrance');
  // After the hook (rules of hooks), before anything else: a door onto work the
  // actor may not plan, or that the engine will not re-plan, is simply not drawn.
  const face = planEntranceFace({
    canPlan,
    archived,
    statusCategory,
    kind,
    hasChildren,
    hasDescription,
  });
  if (face === null) return null;

  const isReplan = face === 'replan';
  const label = isReplan ? t('replan') : t('plan');
  // The accessible name NAMES THE ITEM, so the door is unambiguous when several
  // planning affordances share a screen (the global "Plan with AI" pill is
  // always in the nav). The visible text is contained in it (WCAG 2.5.3).
  const ariaLabel = isReplan
    ? t('replanAria', { item: itemKey })
    : t('planAria', { item: itemKey });

  return (
    <Link
      href={planningWorkspaceHref({ kind: 'work-item', itemKey, hasPlan: isReplan })}
      aria-label={ariaLabel}
      data-testid="work-item-plan-entrance"
      data-mode={face}
      onClick={onActivate}
      className={cn(
        'inline-flex h-(--height-btn-sm) shrink-0 items-center gap-1.5 rounded-(--radius-badge) border px-(--spacing-btn-x-sm)',
        'font-sans text-xs font-semibold whitespace-nowrap transition-colors',
        'focus-visible:ring-(--focus-ring-color) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        isReplan
          ? // Re-plan — subdued: it edits work that already exists.
            'border-(--el-border-strong) text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text)'
          : // Plan — accent-outlined on a transparent fill (accent AS text, so
            // `--el-accent-on-surface`, never the accent FILL token).
            'border-(--el-accent) text-(--el-accent-on-surface) hover:bg-(--el-tint-lavender)',
        className,
      )}
    >
      <Sparkles className="size-3.5 shrink-0" aria-hidden />
      {label}
    </Link>
  );
}
