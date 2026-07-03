'use client';

import { useCallback, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Goal, LayoutGrid, RefreshCw, Target } from 'lucide-react';
import { Button } from '@/components/ui/Button';
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
// Scope is URL-addressable (MOTIR-1541) AND a client-island interaction, with the URL
// as the SINGLE SOURCE OF TRUTH (MOTIR-1549): `scope` is DERIVED from
// `useSearchParams()` (`?scope=sprint` → sprint, anything else → the default project
// scope) — never a one-shot `useState`. Switching scope writes the URL with
// `router.push` (`scroll:false`, a clean `/roadmap` for the default scope), which
// stacks a genuine browser-history entry AND re-renders this island with the new
// `?scope=` — so a deep-link, a reload, AND browser Back/forward all resolve the right
// scope (Back after a toggle returns to the previous scope's URL and view). The scope
// change drives the refetch by REMOUNTING the canvas (its React `key={scope}`) so the
// root re-loads in the new scope. It is NEVER a `router.refresh()` (the page-state
// contract: the canvas is a client island seeded from its own fetch; the navigation
// only moves the URL, the `key` drives the refetch). `router.push` is chosen over
// `router.replace` deliberately: each toggle is a distinct history entry so Back works
// — the standard behaviour for URL-addressable view state (the MOTIR-1549 fix). With
// no active sprint, the Active-sprint option renders the design's "No active sprint"
// empty state in place; the toggle stays available and the default scope is unaffected.

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
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The URL is the single source of truth for scope (MOTIR-1549): derive it from
  // `?scope=` on every render, so a deep-link, reload, AND browser Back/forward all
  // resolve the right scope. `?scope=sprint` → sprint; anything else (absent /
  // `scope=project` / garbage) → the default whole-project scope — the same rule the
  // server page applies, so first-paint SSR and client hydration agree.
  const scope: RoadmapScope = searchParams.get('scope') === 'sprint' ? 'sprint' : 'project';

  // Mirror the chosen scope into the URL so the sprint roadmap is addressable:
  // `?scope=sprint` for the sprint scope, a clean `/roadmap` (no param) for the
  // default project scope. A shallow `router.push` (`scroll:false`) — pushing a
  // distinct history entry is what makes Back/forward restore the prior scope
  // (MOTIR-1549); the resulting `?scope=` re-render both re-derives `scope` and (via
  // the `key={scope}` remount below) drives the canvas refetch, not this navigation.
  // A MANUAL REFRESH (MOTIR-1542): the header refresh control bumps `refreshSignal`,
  // which `WorkItemRoadmap` watches to drop its level cache and re-run the canvas's
  // per-level load IN PLACE (drill / breadcrumb / zoom preserved) — never the
  // `key={scope}` remount. `refreshing` drives the control's loading state and clears
  // on the real fetch-completion signal (`onRefreshSettled`), not a timer.
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const changeScope = (next: RoadmapScope) => {
    // A scope switch remounts the canvas and supersedes any in-flight refresh, so
    // clear the loading state (the remounted canvas won't fire onRefreshSettled).
    setRefreshing(false);
    // Push (not replace) so the toggle is a distinct history entry — Back/forward then
    // restores the prior scope (MOTIR-1549). The new `?scope=` re-derives `scope`; no
    // local state to set (the URL is the source of truth).
    router.push(next === 'sprint' ? `${pathname}?scope=sprint` : pathname, {
      scroll: false,
    });
  };

  const handleRefresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshSignal((n) => n + 1);
  };
  const handleRefreshSettled = useCallback(() => setRefreshing(false), []);

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
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Segmented<RoadmapScope>
            options={options}
            value={scope}
            onChange={changeScope}
            label={t('scopeAriaLabel')}
          />
          {/* Manual refresh (MOTIR-1542): re-fetches the roadmap in place, no full
              page reload. Icon-only Button (secondary) — its own `loading` shows the
              Spinner + disables + aria-busy. Disabled when no canvas is mounted (the
              no-active-sprint empty state), so a click can't hang the spinner. */}
          <Button
            variant="secondary"
            size="md"
            className="w-(--height-btn-md) gap-0 px-0"
            aria-label={t('refresh')}
            title={t('refresh')}
            loading={refreshing}
            disabled={noActiveSprint}
            leftIcon={<RefreshCw className="h-4 w-4" aria-hidden />}
            onClick={handleRefresh}
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
            refreshSignal={refreshSignal}
            onRefreshSettled={handleRefreshSettled}
          />
        )}
      </div>
    </div>
  );
}
