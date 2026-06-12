'use client';

import { useFormatter, useTranslations } from 'next-intl';
import type { FilterAst, FilterCondition } from '@/lib/filters/ast';
import { DEFAULT_STATUS_KEYS } from '@/lib/workflows/defaultWorkflow';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';
import { useAdvancedFilterPopover } from './AdvancedFilterContext';
import { advancedFieldLabel, advancedOperatorLabel } from './advancedFilterLabels';

// The applied advanced-filter readout (Subtask 6.1.4), per
// design/work-items/filter-builder.mock.html panel 5: a compact, READ-ONLY
// row of condition chips under the toolbar — a lavender "Match any" chip
// (only on OR) followed by one neutral chip per condition (**Field** operator
// values). Clicking any chip opens the builder (editing happens in ONE
// surface — the design's recorded rule); there is no inline chip editing.
//
// Value text resolves through the same vocabularies the editors use (status
// labels, member/sprint names, type/priority translations); an id that no
// longer resolves renders verbatim — it matches nothing server-side (the
// stale grammar proper lands with 6.1.5).

export interface AdvancedFilterSummaryProps {
  ast: FilterAst;
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  sprints: SprintDto[];
}

export function AdvancedFilterSummary({
  ast,
  statuses,
  members,
  sprints,
}: AdvancedFilterSummaryProps) {
  const t = useTranslations('issueViews');
  const tType = useTranslations('labels.issueType');
  const tStatus = useTranslations('labels.defaultStatus');
  const tPriority = useTranslations('labels.priority');
  const format = useFormatter();
  const setOpen = useAdvancedFilterPopover()?.setOpen ?? (() => {});

  function valueId(condition: FilterCondition, id: string): string {
    switch (condition.field) {
      case 'kind':
        return tType(id);
      case 'status': {
        const status = statuses.find((s) => s.key === id);
        if (!status) return id;
        return DEFAULT_STATUS_KEYS.has(status.key) ? tStatus(status.key) : status.label;
      }
      case 'priority':
        return tPriority(id);
      case 'assignee':
      case 'reporter': {
        if (id === 'unassigned') return t('unassigned');
        return members.find((m) => m.userId === id)?.name ?? id;
      }
      case 'sprint': {
        if (id === 'backlog') return t('advancedBacklog');
        return sprints.find((s) => s.id === id)?.name ?? id;
      }
      default:
        return id;
    }
  }

  function date(iso: string): string {
    return format.dateTime(new Date(`${iso}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });
  }

  function valueText(condition: FilterCondition): string | null {
    const { operator, value } = condition;
    if (value === null) return null;
    if (Array.isArray(value)) {
      if (operator === 'between' && value.length === 2) {
        const [from, to] = value as [string, string];
        return t('advancedBetweenValues', { from: date(from), to: date(to) });
      }
      return (value as string[]).map((id) => valueId(condition, id)).join(', ');
    }
    if (typeof value === 'number') {
      return operator === 'in_last_days' || operator === 'in_next_days'
        ? t('advancedDaysValue', { count: value })
        : String(value);
    }
    return condition.field === 'created' ||
      condition.field === 'updated' ||
      condition.field === 'due'
      ? date(value)
      : value;
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label={t('advancedSummaryAria')}>
      {ast.combinator === 'or' ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center rounded-(--radius-badge) bg-(--el-tint-lavender) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs font-medium text-(--el-text-strong) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
        >
          {t('advancedMatchAnyChip')}
        </button>
      ) : null}
      {ast.conditions.map((condition, i) => {
        const values = valueText(condition);
        return (
          <button
            key={i}
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex max-w-full items-center gap-1 rounded-(--radius-badge) border border-(--el-border) bg-(--el-surface) px-(--spacing-chip-x) py-(--spacing-chip-y) font-sans text-xs text-(--el-text-secondary) hover:bg-(--el-muted) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            <strong className="font-semibold text-(--el-text-strong)">
              {advancedFieldLabel(t, condition.field)}
            </strong>
            <span className="min-w-0 truncate">
              {advancedOperatorLabel(t, condition.operator)}
              {values !== null ? ` ${values}` : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}
