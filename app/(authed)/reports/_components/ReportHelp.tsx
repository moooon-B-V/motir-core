'use client';

import { ChevronDown, ChevronUp, Info } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { useReportHelpHidden } from '@/lib/hooks/useReportHelpHidden';

// The per-report help text and its toggle (Story MOTIR-8919), per
// design/reports/reports--refined.mock.html panel 3: a ghost small Button at the
// header's right edge ("Hide help text" / "Show help text", `aria-expanded`,
// `aria-controls`) and an `--el-tint-lavender` callout with two paragraphs, "What
// it shows" then "How to read it". The preference is ONE value for the reader,
// shared by every report (`useReportHelpHidden`), so the toggle and the region
// are two components over the same store: the chrome places them apart, the Sprint
// report mounts both through `ReportHelp`.

/** The eight reports that carry help text — a closed, code-defined set. */
export type ReportHelpId =
  | 'burndown'
  | 'velocity'
  | 'sprintReport'
  | 'createdVsResolved'
  | 'distribution'
  | 'averageAge'
  | 'resolutionTime'
  | 'workload';

const regionId = (report: ReportHelpId) => `report-help-${report}`;

export function ReportHelpToggle({ report }: { report: ReportHelpId }) {
  const t = useTranslations('reports.help');
  const [hidden, toggle] = useReportHelpHidden();
  return (
    <Button
      variant="ghost"
      size="sm"
      type="button"
      aria-expanded={!hidden}
      aria-controls={regionId(report)}
      onClick={toggle}
      className="shrink-0 gap-1.5 text-(--el-text-secondary)"
    >
      <Info className="h-[15px] w-[15px]" aria-hidden />
      <span>{hidden ? t('show') : t('hide')}</span>
      {hidden ? (
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <ChevronUp className="h-3.5 w-3.5" aria-hidden />
      )}
    </Button>
  );
}

export function ReportHelpRegion({ report }: { report: ReportHelpId }) {
  const t = useTranslations('reports.help');
  const [hidden] = useReportHelpHidden();
  // Hidden = removed from layout, not just visually hidden.
  if (hidden) return null;
  return (
    <section
      id={regionId(report)}
      aria-label={t('regionLabel')}
      className="flex flex-col gap-1.5 rounded-(--radius-card) bg-(--el-tint-lavender) px-(--spacing-card-padding-16) py-(--spacing-card-padding-12)"
    >
      <p className="text-[13px] leading-relaxed text-(--el-text-strong)">
        <b className="font-semibold">{t('whatLabel')}</b> {t(`${report}.what`)}
      </p>
      <p className="text-[13px] leading-relaxed text-(--el-text-strong)">
        <b className="font-semibold">{t('howLabel')}</b> {t(`${report}.how`)}
      </p>
    </section>
  );
}

/** Toggle then region, stacked — for a page that has no chrome header to split them across. */
export function ReportHelp({ report }: { report: ReportHelpId }) {
  return (
    <div className="flex flex-col items-start gap-3">
      <ReportHelpToggle report={report} />
      <div className="w-full">
        <ReportHelpRegion report={report} />
      </div>
    </div>
  );
}
