'use client';

import { useMemo } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import {
  customFieldIdOfFilterField,
  type FilterAst,
  type FilterCondition,
} from '@/lib/filters/ast';
import { DEFAULT_STATUS_KEYS } from '@/lib/workflows/defaultWorkflow';
import type { WorkflowStatusDto } from '@/lib/dto/workflows';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { SprintDto } from '@/lib/dto/sprints';
import type { CustomFieldDefinitionDTO } from '@/lib/dto/customFields';
import type { ComponentDto } from '@/lib/dto/components';
import type { LabelDto } from '@/lib/dto/labels';
import { customFieldFilterFieldId } from '@/lib/filters/ast';
import { useAdvancedFilterPopover } from './AdvancedFilterContext';
import {
  advancedFieldLabel,
  advancedOperatorLabel,
  type DynamicFieldLabels,
} from './advancedFilterLabels';

// The applied advanced-filter readout (Subtasks 6.1.4 + 6.1.5), per
// design/work-items/filter-builder.mock.html panel 5: a compact, READ-ONLY
// row of condition chips under the toolbar — a lavender "Match any" chip
// (only on OR) followed by one neutral chip per condition (**Field** operator
// values). Clicking any chip opens the builder (editing happens in ONE
// surface — the design's recorded rule); there is no inline chip editing.
//
// Value text resolves through the same vocabularies the editors use (status
// labels, member/sprint names, type/priority translations, AND the Epic-5
// referents — custom-field options, labels, components — 6.1.5); an id that no
// longer resolves renders the "unknown value" text (it matches nothing
// server-side, the stale grammar).

export interface AdvancedFilterSummaryProps {
  ast: FilterAst;
  statuses: WorkflowStatusDto[];
  members: WorkspaceMemberDTO[];
  sprints: SprintDto[];
  customFields: CustomFieldDefinitionDTO[];
  components: ComponentDto[];
  referencedLabels: LabelDto[];
}

export function AdvancedFilterSummary({
  ast,
  statuses,
  members,
  sprints,
  customFields,
  components,
  referencedLabels,
}: AdvancedFilterSummaryProps) {
  const t = useTranslations('issueViews');
  const tType = useTranslations('labels.issueType');
  const tStatus = useTranslations('labels.defaultStatus');
  const tPriority = useTranslations('labels.priority');
  const tWorkType = useTranslations('labels.workItemType');
  const format = useFormatter();
  const setOpen = useAdvancedFilterPopover()?.setOpen ?? (() => {});

  const cfById = useMemo(() => new Map(customFields.map((f) => [f.id, f])), [customFields]);
  const componentsById = useMemo(
    () => new Map(components.map((c) => [c.id, c.name])),
    [components],
  );
  const labelsById = useMemo(
    () => new Map(referencedLabels.map((l) => [l.id, l.name])),
    [referencedLabels],
  );
  const dynamicLabels = useMemo<DynamicFieldLabels>(
    () => new Map(customFields.map((f) => [customFieldFilterFieldId(f.id), f.label])),
    [customFields],
  );

  /** A select custom-field option's display label (archived marked), or null
   * when the id no longer resolves (stale). */
  function cfOptionLabel(cf: CustomFieldDefinitionDTO, id: string): string | null {
    const option = cf.options.find((o) => o.id === id);
    if (!option) return null;
    return option.archived ? t('advancedArchivedOption', { label: option.label }) : option.label;
  }

  function valueId(condition: FilterCondition, id: string): string {
    const cfId = customFieldIdOfFilterField(condition.field);
    if (cfId !== null) {
      const cf = cfById.get(cfId);
      if (!cf) return t('advancedStaleValue');
      if (cf.fieldType === 'select') return cfOptionLabel(cf, id) ?? t('advancedStaleValue');
      if (cf.fieldType === 'user') return members.find((m) => m.userId === id)?.name ?? id;
      return id;
    }
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
      case 'type':
        return tWorkType(id);
      case 'assignee':
      case 'reporter': {
        if (id === 'unassigned') return t('unassigned');
        return members.find((m) => m.userId === id)?.name ?? id;
      }
      case 'sprint': {
        if (id === 'backlog') return t('advancedBacklog');
        return sprints.find((s) => s.id === id)?.name ?? id;
      }
      case 'lbl':
        return labelsById.get(id) ?? t('advancedStaleValue');
      case 'cmp':
        return componentsById.get(id) ?? t('advancedStaleValue');
      default:
        return id;
    }
  }

  function date(iso: string): string {
    return format.dateTime(new Date(`${iso}T00:00:00Z`), { dateStyle: 'medium', timeZone: 'UTC' });
  }

  /** A scalar date condition — the built-in date columns, or a date custom
   * field — whose ISO value renders formatted (not raw). */
  function isDateField(condition: FilterCondition): boolean {
    if (
      condition.field === 'created' ||
      condition.field === 'updated' ||
      condition.field === 'due'
    ) {
      return true;
    }
    const cfId = customFieldIdOfFilterField(condition.field);
    return cfId !== null && cfById.get(cfId)?.fieldType === 'date';
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
    return isDateField(condition) ? date(value) : value;
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
              {advancedFieldLabel(t, condition.field, dynamicLabels)}
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
