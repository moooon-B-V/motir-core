'use client';

import { useMemo } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { ReportBurndownSection } from '@/app/(authed)/backlog/_components/ReportBurndownSection';
import type { BurndownSeriesDto } from '@/lib/dto/reports';
import type { SprintStateDto } from '@/lib/dto/sprints';

// The standalone /reports/burndown page body (bug-reports-hub-agile-cards-collapse) —
// the focused, project-level burndown report Jira's Reports menu lists separately
// (mirror-product rung 1). Mirrors the created-vs-resolved page split: the Server
// Component reads the sprint list + the picked sprint's series, this client body
// owns the URL-driven SPRINT PICKER (each pick NAVIGATES, so the report is
// shareable / reloads to the picked sprint), and mounts the FULL 4.6.5 burndown
// via `ReportBurndownSection` (server-fed `burndown` prop → no client refetch).
// The chart is referenced, never redrawn — the 4.6 seam rule.

export interface BurndownPickerSprint {
  id: string;
  name: string;
  state: SprintStateDto;
}

export function BurndownReport({
  sprints,
  selectedSprintId,
  burndown,
}: {
  /** The project's STARTED sprints (active + completed), active first. */
  sprints: BurndownPickerSprint[];
  selectedSprintId: string;
  /** The server-fetched series for the picked sprint (undefined → client-fetch fallback). */
  burndown?: BurndownSeriesDto;
}) {
  const t = useTranslations('reports');
  const router = useRouter();
  const pathname = usePathname();

  const options = useMemo<ComboboxOption<string>[]>(
    () =>
      sprints.map((s) => ({
        value: s.id,
        label: s.name,
        group: s.state === 'active' ? t('burndown.activeGroup') : t('burndown.completedGroup'),
      })),
    [sprints, t],
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium text-(--el-text-muted)">
            {t('burndown.sprintLabel')}
          </span>
          <Combobox
            label={t('burndown.sprintLabel')}
            options={options}
            value={selectedSprintId}
            onChange={(id) => router.push(`${pathname}?sprint=${id}`)}
            searchable={sprints.length > 6}
            searchPlaceholder={t('burndown.sprintSearch')}
          />
        </div>
      </div>

      <ReportBurndownSection sprintId={selectedSprintId} burndown={burndown} />
    </div>
  );
}
