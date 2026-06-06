'use client';

import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { PRIORITY_OPTIONS } from '@/lib/issues/priority';
import { PRIORITY_META } from '@/lib/issues/priorityMeta';
import type { WorkItemPriorityDto } from '@/lib/dto/workItems';

// The priority picker — a Combobox over the five priorities in canonical order
// (highest → lowest), each row showing its direction icon (PRIORITY_META) +
// label. Mirrors TypePicker so the priority field matches the other field
// dropdowns (status / type / assignee / parent) instead of rendering a native
// <select>. Five fixed options → not searchable.

export interface PriorityPickerProps {
  value: WorkItemPriorityDto;
  onChange: (value: WorkItemPriorityDto) => void;
  id?: string;
  disabled?: boolean;
  /** Open the picker immediately on mount (inline-edit cells — Subtask 2.5.5). */
  autoOpen?: boolean;
  /** Fired when the picker menu closes without/after a pick (Subtask 2.5.5). */
  onClose?: () => void;
}

export function PriorityPicker({
  value,
  onChange,
  id,
  disabled,
  autoOpen,
  onClose,
}: PriorityPickerProps) {
  const t = useTranslations('labels');
  const tu = useTranslations('ui');
  // PRIORITY_OPTIONS supplies the canonical order; the label is translated.
  const options: ComboboxOption<WorkItemPriorityDto>[] = PRIORITY_OPTIONS.map(({ value }) => {
    const Icon = PRIORITY_META[value].icon;
    return { value, label: t(`priority.${value}`), icon: <Icon className="h-4 w-4" /> };
  });
  return (
    <Combobox
      options={options}
      value={value}
      onChange={onChange}
      label={tu('priorityPicker.label')}
      id={id}
      disabled={disabled}
      autoOpen={autoOpen}
      onClose={onClose}
    />
  );
}
