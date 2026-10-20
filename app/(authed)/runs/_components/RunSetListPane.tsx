'use client';

import { useTranslations } from 'next-intl';
import { RunTonePill } from '@/components/runs/RunTonePill';
import type { DispatchRunDto } from '@/lib/dto/dispatchRuns';
import type { RoadmapLevelItem } from '@/lib/planning/roadmapClient';
import { runLegLabel } from '@/lib/runs/legLabel';

// THE RUN'S SET AS A LIST (MOTIR-9074) — the plain-reading twin of the canvas.
// One full-row button per leg, in the run's OWN stored order; clicking one is the
// same selection a canvas node click makes, and clicking the selected row clears it.

export interface RunSetListPaneProps {
  run: DispatchRunDto;
  byId: Map<string, RoadmapLevelItem>;
  selectedWorkItemId: string | null;
  onSelectWorkItem: (workItemId: string | null) => void;
}

export function RunSetListPane({
  run,
  byId,
  selectedWorkItemId,
  onSelectWorkItem,
}: RunSetListPaneProps) {
  const t = useTranslations('runs');
  return (
    <ul className="h-full overflow-y-auto" data-testid="run-set-list">
      {run.cards.map((leg) => {
        const { tone, label } = runLegLabel(t, leg);
        const title = leg.workItemId ? (byId.get(leg.workItemId)?.title ?? null) : null;
        const body = (
          <>
            <span className="font-mono text-xs text-(--el-text-identifier)">{leg.key}</span>
            {title ? (
              <span className="min-w-0 flex-1 truncate text-sm text-(--el-text)">{title}</span>
            ) : (
              <span className="flex-1" />
            )}
            <RunTonePill tone={tone} compact>
              {label}
            </RunTonePill>
          </>
        );
        const row =
          'flex w-full items-center gap-2 px-(--spacing-card-padding) py-2 text-left border-b border-(--el-border-soft)';
        return (
          <li key={leg.id}>
            {leg.workItemId === null ? (
              <div className={row} data-testid="run-set-row">
                {body}
              </div>
            ) : (
              <button
                type="button"
                data-testid="run-set-row"
                aria-pressed={selectedWorkItemId === leg.workItemId}
                onClick={() =>
                  onSelectWorkItem(selectedWorkItemId === leg.workItemId ? null : leg.workItemId)
                }
                className={`${row} hover:bg-(--el-surface) aria-pressed:bg-(--el-tint-sky)`}
              >
                {body}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
