'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { planningWorkspaceHref } from '@/lib/planning/launcher';

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
// TWO FACES, gated on whether the item already has children (design "Modes"):
//   * Plan    — no children yet. Accent-outlined pill; the workspace opens and
//               the AI starts from the item's own description. No opening reason.
//   * Re-plan — the item HAS children. Subdued pill (it is an EDIT of existing
//               work); the workspace opens with the composer asking what's wrong,
//               and the user's first chat turn IS the reason (MOTIR-908
//               classifies the intent from it — there is no reason param).
//
// Colour flows through `--el-*` and shape through the element-semantic tokens, so
// the pill re-skins with `data-palette` and re-shapes with `data-style`. It is a
// real `<Link>`: keyboard-reachable, middle/⌘-clickable, and (from the peek)
// `onActivate` hands off by closing the modal first.

export interface WorkItemPlanEntranceProps {
  /** The item's human identifier (e.g. `MOTIR-42`) — the workspace's anchor. */
  itemKey: string;
  /** Does the item already have children? Decides Plan vs Re-plan. */
  hasChildren: boolean;
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
  onActivate,
  className,
}: WorkItemPlanEntranceProps) {
  const t = useTranslations('aiPlanning.entrance');
  const label = hasChildren ? t('replan') : t('plan');
  // The accessible name NAMES THE ITEM, so the door is unambiguous when several
  // planning affordances share a screen (the global "Plan with AI" pill is
  // always in the nav). The visible text is contained in it (WCAG 2.5.3).
  const ariaLabel = hasChildren
    ? t('replanAria', { item: itemKey })
    : t('planAria', { item: itemKey });

  return (
    <Link
      href={planningWorkspaceHref({ kind: 'work-item', itemKey, hasPlan: hasChildren })}
      aria-label={ariaLabel}
      data-testid="work-item-plan-entrance"
      data-mode={hasChildren ? 'replan' : 'plan'}
      onClick={onActivate}
      className={cn(
        'inline-flex h-(--height-btn-sm) shrink-0 items-center gap-1.5 rounded-(--radius-badge) border px-(--spacing-btn-x-sm)',
        'font-sans text-xs font-semibold whitespace-nowrap transition-colors',
        'focus-visible:ring-(--focus-ring-color) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        hasChildren
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
