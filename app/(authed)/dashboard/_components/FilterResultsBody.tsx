'use client';

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, User } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { IssueTypeIcon } from '@/components/issues/IssueTypeIcon';
import { Pill } from '@/components/ui/Pill';
import { PRIORITY_META } from '@/lib/issues/priorityMeta';
import type { DashboardWidgetSourceDto } from '@/lib/dto/dashboards';
import type { FilterResultsConfig } from '@/lib/dashboards/widgetRegistry';
import type { PagedIssueListDto, WorkItemListItemDto } from '@/lib/dto/workItems';
import { sourceParams, useWidgetData } from './useWidgetData';
import {
  WidgetEmpty,
  WidgetError,
  WidgetLoading,
  WidgetNoAccess,
  WidgetStale,
} from './WidgetStateView';

// The filter-results widget body (6.3.5 · rendererKind `issue_table`): the
// compact 2.5-row vocabulary (key · type glyph + summary · priority Pill ·
// assignee) + a pager, capped at the widget's configured page size (≤50, the
// verified gadget cap). Rides the 6.3.2 `/api/reports/filter-results` read —
// a widget page exactly matches the /items List for the same source.

function PriorityCell({ priority }: { priority: WorkItemListItemDto['priority'] }) {
  const tp = useTranslations('labels.priority');
  const meta = PRIORITY_META[priority];
  const Icon = meta.icon;
  return (
    <Pill {...meta.pill}>
      <Icon className="size-3" aria-hidden />
      {tp(priority)}
    </Pill>
  );
}

export function FilterResultsBody({
  source,
  config,
  onReconfigure,
}: {
  source: DashboardWidgetSourceDto;
  config: FilterResultsConfig;
  onReconfigure?: () => void;
}) {
  const t = useTranslations('dashboards');
  const [page, setPage] = useState(1);

  const search = useMemo(() => {
    const params = sourceParams(source);
    if (!params) return null;
    params.set('page', String(page));
    params.set('pageSize', String(config.pageSize));
    return params.toString();
  }, [source, page, config.pageSize]);

  const { state, reload } = useWidgetData<PagedIssueListDto>('/api/reports/filter-results', search);

  if (source.kind === 'stale') return <WidgetStale onReconfigure={onReconfigure} />;
  if (state.phase === 'loading') return <WidgetLoading shape="table" />;
  if (state.phase === 'error') return <WidgetError onRetry={reload} />;
  if (state.result.state === 'no_access') return <WidgetNoAccess />;
  if (state.result.state === 'stale') return <WidgetStale onReconfigure={onReconfigure} />;

  const data = state.result.data;
  if (data.total === 0) return <WidgetEmpty />;

  const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize));
  const from = (data.page - 1) * data.pageSize + 1;
  const to = Math.min(data.page * data.pageSize, data.total);

  return (
    <div className="flex flex-col">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="border-b border-(--el-border)">
            <th className="px-3 py-2 text-left font-semibold text-(--el-text-muted)">
              {t('colKey')}
            </th>
            <th className="px-1 py-2 text-left font-semibold text-(--el-text-muted)">
              {t('colSummary')}
            </th>
            <th className="px-3 py-2 text-right font-semibold text-(--el-text-muted)">
              {t('colPriority')}
            </th>
            <th className="px-2 py-2">
              <span className="sr-only">{t('colAssignee')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((item) => (
            <tr key={item.id} className="border-b border-(--el-border-soft) last:border-0">
              <td className="px-3 py-2 font-mono text-[11.5px] whitespace-nowrap text-(--el-text-muted)">
                {item.identifier}
              </td>
              <td className="px-1 py-2">
                <span className="flex items-center gap-1.5">
                  <IssueTypeIcon type={item.kind} className="size-3.5 shrink-0" aria-hidden />
                  <span className="truncate text-(--el-text)">{item.title}</span>
                </span>
              </td>
              <td className="px-3 py-2 text-right">
                <PriorityCell priority={item.priority} />
              </td>
              <td className="px-2 py-2">
                <span
                  title={item.assigneeId ? t('assigned') : t('unassigned')}
                  className={`inline-flex size-5 items-center justify-center rounded-full ${
                    item.assigneeId
                      ? 'bg-(--el-tint-lavender) text-(--el-text-strong)'
                      : 'bg-(--el-muted) text-(--el-text-faint)'
                  }`}
                >
                  <User className="size-3" aria-hidden />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center justify-between gap-3 border-t border-(--el-border) px-3 py-2 text-[11.5px] text-(--el-text-muted)">
        <span className="tabular-nums">{t('pagerRange', { from, to, total: data.total })}</span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            aria-label={t('pagerPrev')}
            disabled={data.page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="inline-flex size-6 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-muted) disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
          >
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t('pagerNext')}
            disabled={data.page >= pageCount}
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            className="inline-flex size-6 items-center justify-center rounded-(--radius-control) text-(--el-text-muted) hover:bg-(--el-muted) disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring-color)"
          >
            <ChevronRight className="size-4" aria-hidden />
          </button>
        </span>
      </div>
    </div>
  );
}
