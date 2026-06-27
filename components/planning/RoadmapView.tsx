'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Goal, LayoutGrid, Target } from 'lucide-react';
import { Segmented, type SegmentedOption } from '@/components/ui/Segmented';
import { EmptyState } from '@/components/ui/EmptyState';
import { WorkItemRoadmap } from '@/components/planning/WorkItemRoadmap';
import type { RoadmapScope } from '@/lib/planning/roadmapClient';

// The roadmap page's CLIENT shell (Subtask MOTIR-1382 / Story MOTIR-1379) — it owns
// the SCOPE state and renders the header scope toggle, because the page is a Server
// Component but the toggle + the canvas are a client island. It composes the shipped
// `Segmented` control (design `design/roadmap/scope-toggle.*`, MOTIR-1380) in the
// header and feeds the chosen scope to `WorkItemRoadmap`, which threads it to every
// per-level fetch (`&scope=sprint`, the scoped read MOTIR-1381).
//
// Scope is a client-island interaction (no server mutation): switching scope drives
// the refetch by REMOUNTING the canvas (its React `key={scope}`) so the root
// re-loads in the new scope — NEVER `router.refresh()` (the page-state contract:
// the canvas is a client island seeded from its own fetch). With no active sprint,
// the Active-sprint option renders the design's "No active sprint" empty state in
// place; the toggle stays available and the default scope is unaffected.

export interface RoadmapViewProps {
  /** The project's `PROD`/`MOTIR` key — the per-level roadmap read source. */
  projectKey: string;
  /** The project's display name (the whole-project subtitle). */
  projectName: string;
  /** The canvas `aria-label`. */
  ariaLabel: string;
  /** Whether the project has an active sprint (server-resolved via getActiveSprint). */
  hasActiveSprint: boolean;
  /** The active sprint's name + goal, for the sprint-scope subtitle (null when none). */
  sprintName: string | null;
  sprintGoal: string | null;
  /** Pin the planning-origin cluster at the root (MOTIR-1013) — gated on the
   *  project's onboarding-ran marker (MOTIR-1264); forwarded to the canvas. */
  showPlanningOrigin: boolean;
}

export function RoadmapView({
  projectKey,
  projectName,
  ariaLabel,
  hasActiveSprint,
  sprintName,
  sprintGoal,
  showPlanningOrigin,
}: RoadmapViewProps) {
  const t = useTranslations('roadmap');
  const [scope, setScope] = useState<RoadmapScope>('project');

  const sprintScopeActive = scope === 'sprint' && hasActiveSprint;
  const noActiveSprint = scope === 'sprint' && !hasActiveSprint;
  const subtitle = sprintScopeActive
    ? sprintGoal
      ? `${sprintName} · ${sprintGoal}`
      : (sprintName ?? t('subtitle', { project: projectName }))
    : t('subtitle', { project: projectName });

  const options: SegmentedOption<RoadmapScope>[] = [
    {
      value: 'project',
      label: t('scopeWholeProject'),
      icon: <LayoutGrid className="h-3.5 w-3.5" aria-hidden />,
    },
    {
      value: 'sprint',
      label: t('scopeActiveSprint'),
      icon: <Target className="h-3.5 w-3.5" aria-hidden />,
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="font-serif text-2xl font-semibold text-(--el-text)">{t('heading')}</h1>
          <p className="flex items-center gap-2 text-sm text-(--el-text-muted)">
            <span className="truncate">{subtitle}</span>
            {sprintScopeActive ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-(--radius-badge) bg-(--el-tint-lavender) px-(--spacing-chip-x) py-(--spacing-chip-y) text-xs font-semibold text-(--el-text-strong)">
                <Target className="h-3 w-3 text-(--el-accent-on-surface)" aria-hidden />
                {t('scopeChip')}
              </span>
            ) : null}
          </p>
        </div>
        <div className="ml-auto shrink-0">
          <Segmented<RoadmapScope>
            options={options}
            value={scope}
            onChange={setScope}
            label={t('scopeAriaLabel')}
          />
        </div>
      </header>

      <div className="h-[calc(100dvh-13rem)] min-h-[28rem] overflow-hidden rounded-(--radius-card) border border-(--el-border) bg-(--el-canvas)">
        {noActiveSprint ? (
          <div className="flex h-full items-center justify-center p-6">
            <EmptyState
              icon={<Goal className="h-12 w-12" aria-hidden />}
              title={t('noActiveSprintTitle')}
              description={t('noActiveSprintDescription')}
            />
          </div>
        ) : (
          // Remount on scope change (key) so the canvas re-loads the ROOT in the new
          // scope — the client-island refetch, not router.refresh (page-state contract).
          <WorkItemRoadmap
            key={scope}
            projectKey={projectKey}
            scope={scope}
            showPlanningOrigin={showPlanningOrigin}
            ariaLabel={ariaLabel}
          />
        )}
      </div>
    </div>
  );
}
