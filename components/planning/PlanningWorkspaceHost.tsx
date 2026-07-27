'use client';

import { useCallback, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Map, X } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { PlanningWorkspace } from '@/components/planning/PlanningWorkspace';
import { WorkItemRoadmap } from '@/components/planning/WorkItemRoadmap';
import { PlanChangeRail } from '@/components/planning/PlanChangeRail';
import type { PlanningLaunch } from '@/lib/planning/launcher';

// The client island of the established-project planning HOST (Subtask
// MOTIR-1729; design `plan-change-conversation.mock.html` panel 2). It COMPOSES
// the shipped pieces — `PlanningWorkspace` (the two-pane frame),
// `WorkItemRoadmap` → `ProjectRoadmapCanvas` (the canvas, seeded with the
// project's EXISTING tree) — and adds only what the host owns: the exit chrome
// and the mode/context wiring. It rebuilds none of them.
//
// The exit chrome is the shell's own (it has no app nav to leave through): a
// Close control naming the origin plus `Esc`, both returning to the surface the
// launcher was invoked from (`planningLaunchBackHref`). The design's overlay
// keeps the origin screen mounted behind it; this host is a ROUTE (the card's
// deliverable — `planningWorkspaceHref` stays the single entry href), so
// "returns you to where you launched from" is a navigation back to that route.
//
// The chat pane is `PlanChangeRail`, which renders the mode + context honestly
// and says the conversation itself is not wired up here yet — MOTIR-1730 owns
// the multi-turn rail and replaces that one import.

export interface PlanningWorkspaceHostProps {
  /** The project's `MOTIR`-style key — the canvas's per-level read source. */
  projectKey: string;
  projectName: string;
  /** Whether the project's tree has anything to draw (the server root read). */
  hasItems: boolean;
  /** The launcher's context, parsed off the query by the page. */
  launch: PlanningLaunch;
  /** Where Close / `Esc` return to. */
  backHref: string;
}

export function PlanningWorkspaceHost({
  projectKey,
  projectName,
  hasItems,
  launch,
  backHref,
}: PlanningWorkspaceHostProps) {
  const t = useTranslations('planningWorkspace');
  const router = useRouter();

  const close = useCallback(() => router.push(backHref), [router, backHref]);

  // `Esc` closes the workspace (design sheet 6). It must not steal the key from
  // the surfaces that own it FIRST: the canvas's full-screen mode exits on Esc,
  // and a dialog/menu closes on Esc — so skip when something already handled it,
  // when the canvas is full-screen, and when focus sits in a text field.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (typeof document !== 'undefined' && document.fullscreenElement) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      close();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [close]);

  const backLabel =
    launch.from === 'work-item' && launch.itemKey
      ? t('backToItem', { item: launch.itemKey })
      : launch.from === 'convention-refine'
        ? t('backToCodeHealth')
        : t('backToRoadmap');

  return (
    <PlanningWorkspace
      canvas={
        <div className="flex h-full min-h-0 flex-col bg-(--el-canvas)">
          {/* The shell's own exit chrome + project crumb. The canvas keeps its
              own top-left breadcrumb and top-right search/zoom overlays, so this
              sits ABOVE the canvas rather than over them. */}
          <div className="flex items-center gap-3 border-b border-(--el-border-soft) bg-(--el-surface) px-4 py-2">
            <Link
              href={backHref}
              className="inline-flex items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-sm font-medium text-(--el-text-secondary) hover:bg-(--el-surface-soft) hover:text-(--el-text) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
            >
              <X className="h-4 w-4 shrink-0" aria-hidden />
              {backLabel}
              <kbd className="ml-1 rounded-(--radius-kbd) border border-(--el-border) px-(--spacing-kbd-x) py-(--spacing-kbd-y) font-mono text-[0.6875rem] text-(--el-text-muted)">
                {t('escKey')}
              </kbd>
            </Link>
            <span className="truncate text-sm font-semibold text-(--el-text)">{projectName}</span>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {hasItems ? (
              <WorkItemRoadmap
                projectKey={projectKey}
                ariaLabel={t('canvasAria', { project: projectName })}
              />
            ) : (
              <div className="flex h-full items-center justify-center p-6">
                <EmptyState
                  icon={<Map className="h-12 w-12" aria-hidden />}
                  title={t('emptyCanvasTitle')}
                  description={t('emptyCanvasDescription')}
                />
              </div>
            )}
          </div>
        </div>
      }
      chat={<PlanChangeRail launch={launch} projectName={projectName} />}
    />
  );
}
