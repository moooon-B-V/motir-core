'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Calendar, ChevronDown } from 'lucide-react';
import type { CustomFieldWithValueDto } from '@/lib/dto/customFieldValues';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';
import type { Locale } from '@/lib/i18n/locales';
import { cn } from '@/lib/utils/cn';
import { Input } from '@/components/ui/Input';
import { DatePicker } from '@/components/ui/DatePicker';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { formatDate } from '@/lib/utils/datetime';
import { useProjectAccess } from '../../../_components/ProjectAccessProvider';
import { Avatar, FieldCard } from './FieldCard';
import { setCustomFieldValueAction } from '../customFieldActions';

// Custom-field values on the detail rail (Story 5.3 · Subtask 5.3.7), per
// design/work-items/custom-fields.mock.html: each field renders as a FieldCard
// below the built-ins — fields WITH values as visible cards, empty ones behind
// the "Show more fields (N)" disclosure (the verified Jira hide-when-empty
// rule). The chevron toggles the per-type inline editor (Input / DatePicker /
// Combobox / member Combobox); commits go through the dedicated
// setCustomFieldValueAction, a 422 keeps the editor open with the rose-tint
// inline error, and a success refreshes the route (the rail's pattern). With
// no definitions the section renders nothing — the rail is byte-identical to
// a pre-5.3 build.

const NONE = '__none__';
// Long option sets get the type-ahead filter; a short set opens straight to
// the list (the ParentPicker precedent — custom-fields.mock.html panel 2).
const SEARCHABLE_AT = 8;

export interface CustomFieldsSectionProps {
  workItemId: string;
  fields: CustomFieldWithValueDto[];
  members: WorkspaceMemberDTO[];
}

// The 2.4.9-family inline error: hue in the tint background, strong text
// (finding #35), announced via role="alert". Rendered below the open editor;
// the Input editors render the same box through their own error slot.
function ErrorBox({ children }: { children: string }) {
  return (
    <p
      role="alert"
      className="bg-(--el-tint-rose) text-(--el-text-strong) mt-1.5 rounded-(--radius-control) px-(--spacing-tooltip-x) py-(--spacing-tooltip-y) font-sans text-xs"
    >
      {children}
    </p>
  );
}

export function CustomFieldsSection({ workItemId, fields, members }: CustomFieldsSectionProps) {
  const router = useRouter();
  const t = useTranslations('issueViews');
  const locale = useLocale() as Locale;
  const { canEdit } = useProjectAccess();
  const readOnly = !canEdit;
  const [isPending, startTransition] = useTransition();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const numberFormat = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 10 }),
    [locale],
  );

  if (fields.length === 0) return null;

  const valued = fields.filter((f) => f.value !== null);
  const empty = fields.filter((f) => f.value === null);

  function openEditor(field: CustomFieldWithValueDto) {
    setError(null);
    setDraft(
      field.fieldType === 'text'
        ? (field.value?.text ?? '')
        : field.value?.number != null
          ? String(field.value.number)
          : '',
    );
    setEditingId(field.id);
  }

  function closeEditor() {
    setEditingId(null);
    setError(null);
  }

  // One commit path for every type: null clears, a string carries the raw
  // input (the service is the validation authority — a bad number or an
  // archived option comes back as the inline 422, with the editor kept open).
  function commit(field: CustomFieldWithValueDto, next: string | null) {
    setError(null);
    startTransition(async () => {
      const res = await setCustomFieldValueAction({ workItemId, fieldId: field.id, value: next });
      if (res.ok) {
        closeEditor();
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  // text / number commit on blur or chevron collapse (the Estimate grammar);
  // an unchanged draft just closes, an emptied one clears.
  function commitDraft(field: CustomFieldWithValueDto) {
    const current =
      field.fieldType === 'text'
        ? (field.value?.text ?? '')
        : field.value?.number != null
          ? String(field.value.number)
          : '';
    const next = draft.trim();
    if (next === current.trim()) {
      closeEditor();
      return;
    }
    commit(field, next === '' ? null : next);
  }

  // date commits as soon as the DatePicker fires (a day picked or cleared) —
  // the Due-date card's grammar; an unchanged pick just closes.
  function commitDate(field: CustomFieldWithValueDto, next: string | null) {
    const current = field.value?.date ? field.value.date.slice(0, 10) : null;
    if (next === current) {
      closeEditor();
      return;
    }
    commit(field, next);
  }

  // select / user commit on pick; the None row clears.
  function commitPick(field: CustomFieldWithValueDto, picked: string, current: string | null) {
    const next = picked === NONE ? null : picked;
    if (next === current) {
      closeEditor();
      return;
    }
    commit(field, next);
  }

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

  function renderEditor(field: CustomFieldWithValueDto) {
    switch (field.fieldType) {
      case 'text':
      case 'number':
        return (
          <Input
            aria-label={field.label}
            inputMode={field.fieldType === 'number' ? 'decimal' : undefined}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => commitDraft(field)}
            disabled={isPending}
            autoFocus
            error={error ?? undefined}
            errorVariant="box"
          />
        );
      case 'date':
        return (
          <>
            <DatePicker
              aria-label={field.label}
              value={field.value?.date ? field.value.date.slice(0, 10) : null}
              onChange={(next) => commitDate(field, next)}
              disabled={isPending}
              autoOpen
            />
            {error ? <ErrorBox>{error}</ErrorBox> : null}
          </>
        );
      case 'select': {
        const currentOption = field.value?.option ?? null;
        // Archived options are excluded from new selection; a CURRENT archived
        // value stays visible on the trigger (via the placeholder slot, with
        // its archived mark) without re-entering the menu.
        const options: ComboboxOption<string>[] = [
          { value: NONE, label: t('none') },
          ...field.options.filter((o) => !o.archived).map((o) => ({ value: o.id, label: o.label })),
        ];
        return (
          <>
            <Combobox
              options={options}
              // A current ARCHIVED value is not in the menu, so it can't be the
              // Combobox `value`; it stays visible on the trigger through the
              // placeholder slot, carrying its archived mark.
              value={currentOption ? (currentOption.archived ? null : currentOption.id) : NONE}
              onChange={(v) => commitPick(field, v, currentOption?.id ?? null)}
              label={field.label}
              placeholder={
                currentOption?.archived
                  ? `${currentOption.label} ${t('customFields.archivedMark')}`
                  : t('customFields.selectOption')
              }
              searchable={options.length - 1 >= SEARCHABLE_AT}
              searchPlaceholder={t('customFields.searchOptions')}
              emptyText={t('customFields.noOptions')}
              disabled={isPending}
              autoOpen
            />
            {error ? <ErrorBox>{error}</ErrorBox> : null}
          </>
        );
      }
      case 'user': {
        const currentUserId = field.value?.user?.id ?? null;
        const options: ComboboxOption<string>[] = [
          { value: NONE, label: t('none') },
          ...members.map((m) => ({
            value: m.userId,
            label: m.name,
            secondary: m.email,
            keywords: m.email,
          })),
        ];
        return (
          <>
            <Combobox
              options={options}
              value={currentUserId ?? NONE}
              onChange={(v) => commitPick(field, v, currentUserId)}
              label={field.label}
              placeholder={t('customFields.selectMember')}
              searchable
              searchPlaceholder={t('customFields.searchMembers')}
              emptyText={t('customFields.noMembers')}
              disabled={isPending}
              autoOpen
            />
            {error ? <ErrorBox>{error}</ErrorBox> : null}
          </>
        );
      }
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
        onToggle={() => {
          if (!editing) {
            openEditor(field);
          } else if (field.fieldType === 'text' || field.fieldType === 'number') {
            // The chevron collapse commits free-text fields (the Estimate
            // grammar); picker types commit on pick, so collapse just closes.
            commitDraft(field);
          } else {
            closeEditor();
          }
        }}
      >
        {editing ? renderEditor(field) : renderValue(field)}
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
