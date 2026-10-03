'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { BrandMark } from '@/components/brand/BrandMark';
import { useOpenGuide } from '@/lib/hooks/useOpenPlanningWorkspace';
import { ContentSectionCard } from './ContentSectionCard';

// GUIDE ME THROUGH (Story MOTIR-7459 · MOTIR-7467; design MOTIR-7462,
// `design/runs/run-section--guide-door.mock.html`) — the section a MANUAL card's
// page draws in the Run section's slot. A manual card is never run, so its Run
// section could only ever say *Nothing has run yet*; this door opens the Motir AI
// overlay's guide mode on the card instead (`plan=guide&planItem=<KEY>`).
//
// The page decides WHETHER it renders (the manual predicate and the door's four
// absences, A2.7); this component only draws it. Pressing the door writes
// nothing, claims nothing and moves no status.

export interface GuideMeThroughProgress {
  done: number;
  total: number;
  /** 1-based position of the first unticked row — where the walk resumes —
   *  or null when every row is ticked. */
  next: number | null;
}

export interface GuideMeThroughSectionProps {
  itemKey: string;
  /** The card's to-do progress, or null when it has no rows (panel b: no
   *  progress block, never *0 of 0*). */
  progress: GuideMeThroughProgress | null;
}

export function GuideMeThroughSection({ itemKey, progress }: GuideMeThroughSectionProps) {
  const t = useTranslations('runs.guide');
  const { href, openGuide } = useOpenGuide(itemKey);
  const hasRows = progress !== null && progress.total > 0;
  const pct = hasRows ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <ContentSectionCard title={t('title')} subtitle={t('gloss')}>
      <div data-testid="guide-door-section" className="flex flex-col gap-3">
        <p className="font-sans text-[13.5px] text-(--el-text)">
          {hasRows ? t('lead') : t('leadNoList')}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {hasRows ? (
            <div
              className="flex min-w-[12rem] flex-1 flex-col gap-1.5"
              data-testid="guide-door-progress"
            >
              <span className="font-mono text-[11px] text-(--el-text-secondary)">
                {progress.next === null
                  ? t('progressAllDone', { total: progress.total })
                  : t('progress', {
                      done: progress.done,
                      total: progress.total,
                      next: progress.next,
                    })}
              </span>
              <div
                role="img"
                aria-label={t('progressAria', { done: progress.done, total: progress.total })}
                className="h-1 w-full overflow-hidden rounded-full bg-(--el-muted)"
              >
                <span
                  className="block h-full rounded-full bg-(--el-accent)"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          ) : null}
          <Button
            variant="primary"
            size="md"
            className="ml-auto"
            data-testid="guide-door"
            data-href={href}
            leftIcon={<BrandMark variant="mark" tone="inverted" size={14} />}
            onClick={(event) => openGuide(event)}
          >
            {t('door')}
          </Button>
        </div>
      </div>
    </ContentSectionCard>
  );
}
