'use client';

import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { Pill } from '@/components/ui/Pill';
import type { SprintDto } from '@/lib/dto/sprints';
import { SPRINT_STATE_TONE } from './backlogShared';

// The "Move to sprint ▸" submenu body (Story 4.2 · Subtask 4.2.5), shared by the
// multi-select bulk bar AND the per-row `⋯` menu (design/backlog panel 5). One
// row per planning sprint: name + the state `Pill` (dot + label, AA-safe — never
// colour-alone, finding #35); the issue's CURRENT sprint is check-marked and
// inert. Renders inside a `Popover.Content` (p-0); the rows are the shipped menu
// idiom — a padded inner container so a glyph never sits in the clipped corner.
//
// (The design panel also sketches a "New sprint…" foot item; the Story-4.2 AC
// enumerates only move targets, and the prominent Create-sprint affordance below
// the stack already owns sprint creation, so it is not duplicated here.)

export function SprintMenuList({
  sprints,
  currentSprintId,
  onPick,
}: {
  sprints: SprintDto[];
  /** The issue's current sprint (check-marked + inert), or null when in the backlog. */
  currentSprintId: string | null;
  onPick: (sprintId: string) => void;
}) {
  const t = useTranslations('backlog');

  if (sprints.length === 0) {
    return (
      <div className="p-1">
        <p className="px-(--spacing-control-x) py-(--spacing-control-y) text-sm text-(--el-text-muted)">
          {t('noSprintsToMove')}
        </p>
      </div>
    );
  }

  return (
    <div className="p-1" role="menu" aria-label={t('moveToSprint')}>
      <div className="px-(--spacing-control-x) py-1 text-[11px] font-semibold tracking-wide text-(--el-text-faint) uppercase">
        {t('moveToSprint')}
      </div>
      {sprints.map((sprint) => {
        const isCurrent = sprint.id === currentSprintId;
        return (
          <button
            key={sprint.id}
            type="button"
            role="menuitem"
            disabled={isCurrent}
            onClick={() => onPick(sprint.id)}
            data-testid={`move-to-sprint-${sprint.id}`}
            className="flex h-(--height-control) w-full items-center gap-2 rounded-(--radius-control) px-(--spacing-control-x) text-left text-sm text-(--el-text) hover:bg-(--el-muted) focus-visible:bg-(--el-muted) focus-visible:outline-none disabled:cursor-default disabled:opacity-100"
          >
            <span className="min-w-0 flex-1 truncate">{sprint.name}</span>
            {isCurrent ? (
              <Check className="h-4 w-4 shrink-0 text-(--el-accent-on-surface)" aria-hidden />
            ) : (
              <Pill status={SPRINT_STATE_TONE[sprint.state]}>
                {t(`sprintState.${sprint.state}`)}
              </Pill>
            )}
          </button>
        );
      })}
    </div>
  );
}
