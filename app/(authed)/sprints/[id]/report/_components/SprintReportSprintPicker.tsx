'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import type { ReportPickerSprint } from '@/lib/reports/sprintPicker';

// The Sprint report's sprint picker (Story MOTIR-8919), per
// design/reports/reports--refined.mock.html panel 6(a): the same grouped list
// and order Burndown offers (`pickReportSprints`). The sprint is a PATH segment,
// so a pick navigates to `/sprints/<id>/report` — a copied address reopens the
// same sprint, and the page stays path-addressed with no query parameter.

export function SprintReportSprintPicker({
  sprints,
  selectedSprintId,
}: {
  /** Active first, then completed newest → oldest. */
  sprints: ReportPickerSprint[];
  selectedSprintId: string;
}) {
  const t = useTranslations('backlog.sprintReport');
  const router = useRouter();

  const options = useMemo<ComboboxOption<string>[]>(
    () =>
      sprints.map((s) => ({
        value: s.id,
        label: s.name,
        group: s.state === 'active' ? t('activeGroup') : t('completedGroup'),
      })),
    [sprints, t],
  );

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-(--el-text-secondary)">{t('sprintLabel')}</span>
      <Combobox
        label={t('sprintLabel')}
        options={options}
        value={selectedSprintId}
        onChange={(id) => router.push(`/sprints/${id}/report`)}
        searchable={sprints.length > 6}
        searchPlaceholder={t('sprintSearch')}
      />
    </div>
  );
}
