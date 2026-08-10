'use client';

import { useMemo, useState } from 'react';
import type { CustomFieldWithValueDto } from '@/lib/dto/customFieldValues';
import { useLocale, useTranslations } from 'next-intl';
import { Calendar, ChevronDown } from 'lucide-react';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { Locale } from '@/lib/i18n/locales';
import { cn } from '@/lib/utils/cn';
import { formatDate } from '@/lib/utils/datetime';
import { useProjectAccess } from '../../../_components/ProjectAccessProvider';
import { Avatar, FieldCard } from './FieldCard';
import { useCustomFieldEditing } from '../../_components/customFieldEditing';

// Custom-field values on the detail rail (Story 5.3 · Subtask 5.3.7), per
// design/work-items/custom-fields.mock.html: each field renders as a FieldCard
// below the built-ins — fields WITH values as visible cards, empty ones behind
// the "Show more fields (N)" disclosure (the verified Jira hide-when-empty
// rule). The chevron toggles the per-type inline editor (Input / DatePicker /
// Combobox / member Combobox); commits go through the dedicated
// setCustomFieldValueAction. The commit is OPTIMISTIC: the picked value is
// shown at once via a per-field override and the success response is taken as
// the confirmation — the card KEEPS the optimistic value, with no
// router.refresh() (a field-update success path must not whole-tree-refresh,
// or the re-read reverts the cell before the write has propagated — the
// inline-edit revert bug, `bug-inline-status-revert-on-second-edit`). A 422
// snaps the override back and reopens the editor with the rose-tint inline
// error. With no definitions the section renders nothing — the rail is
// byte-identical to a pre-5.3 build.

export interface CustomFieldsSectionProps {
  workItemId: string;
  fields: CustomFieldWithValueDto[];
  members: WorkspaceMemberDTO[];
}

export function CustomFieldsSection({ workItemId, fields, members }: CustomFieldsSectionProps) {
  const t = useTranslations('issueViews');
  const locale = useLocale() as Locale;
  // MOTIR-2473 — the key this control's own write asserts:
  // `projectAccessService.assertCanEdit` resolves `work_item:edit`.
  const { can } = useProjectAccess();
  const readOnly = !can('work_item:edit');
  const [showAll, setShowAll] = useState(false);
  // The editors, the commits and the optimistic overrides are SHARED with the
  // quick-view peek's rail (MOTIR-2599). This component keeps only its own
  // chrome — the FieldCards, the disclosure — and its own read-mode value
  // grammar, which is deliberately denser in the peek.
  const cf = useCustomFieldEditing({ workItemId, fields, members });
  const { valued, empty, editingId } = cf;

  const numberFormat = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 10 }),
    [locale],
  );

  if (fields.length === 0) return null;

  const muted = (text: string) => <span className="text-(--el-text-secondary) italic">{text}</span>;
  const archivedMark = (
    <span className="text-(--el-text-secondary) italic">{t('customFields.archivedMark')}</span>
  );

  function renderValue(field: CustomFieldWithValueDto) {
    const v = field.value;
    if (!v) return muted(t('none'));
    switch (field.fieldType) {
      case 'text':
        return (
          <span className="block truncate" title={v.text ?? undefined}>
            {v.text}
          </span>
        );
      case 'number':
        return v.number != null ? numberFormat.format(v.number) : muted(t('none'));
      case 'date':
        return v.date ? (
          <span className="flex items-center gap-1.5">
            <Calendar className="h-4 w-4 text-(--el-text-secondary)" aria-hidden />
            {formatDate(v.date, locale)}
          </span>
        ) : (
          muted(t('none'))
        );
      case 'select':
        return v.option ? (
          <span className="truncate">
            {v.option.label} {v.option.archived ? archivedMark : null}
          </span>
        ) : (
          muted(t('none'))
        );
      case 'user':
        return v.user ? (
          <span className="flex items-center gap-2">
            <Avatar name={v.user.name} />
            <span className="truncate">{v.user.name}</span>
          </span>
        ) : (
          muted(t('none'))
        );
    }
  }

  function renderCard(field: CustomFieldWithValueDto) {
    const editing = editingId === field.id;
    return (
      <FieldCard
        key={field.id}
        label={field.label}
        editable={!readOnly}
        editing={editing}
        onToggle={() => cf.onToggle(field, editing)}
      >
        {editing ? cf.renderEditor(field) : renderValue(field)}
      </FieldCard>
    );
  }

  return (
    <>
      {valued.map(renderCard)}
      {empty.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={showAll}
            onClick={() => setShowAll((s) => !s)}
            className="flex w-full items-center gap-1.5 rounded-(--radius-control) px-(--spacing-control-x) py-(--spacing-control-y) text-left font-sans text-[13px] text-(--el-text-secondary) hover:bg-(--el-surface) focus-visible:ring-2 focus-visible:ring-(--focus-ring-color) focus-visible:outline-none"
          >
            <ChevronDown
              className={cn('h-4 w-4 shrink-0 transition-transform', showAll && 'rotate-180')}
              aria-hidden
            />
            {showAll
              ? t('customFields.showFewer')
              : t('customFields.showMore', { count: empty.length })}
          </button>
          {showAll ? empty.map(renderCard) : null}
        </>
      ) : null}
    </>
  );
}
