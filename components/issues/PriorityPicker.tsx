'use client';

import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { PRIORITY_OPTIONS } from '@/lib/issues/priority';
import { PRIORITY_META } from '@/lib/issues/priorityMeta';
import type { WorkItemPriorityDto } from '@/lib/dto/workItems';

// The priority picker — a Combobox over the five priorities in canonical order
// (highest → lowest), each row showing its direction icon (PRIORITY_META) +
// label. Mirrors TypePicker so the priority field matches the other field
// dropdowns (status / type / assignee / parent) instead of rendering a native
// <select>. Five fixed options → not searchable.

const PRIORITY_PICKER_OPTIONS: ComboboxOption<WorkItemPriorityDto>[] = PRIORITY_OPTIONS.map(
  ({ value, label }) => {
    const Icon = PRIORITY_META[value].icon;
    return { value, label, icon: <Icon className="h-4 w-4" /> };
  },
);

export interface PriorityPickerProps {
  value: WorkItemPriorityDto;
  onChange: (value: WorkItemPriorityDto) => void;
  id?: string;
  disabled?: boolean;
}

export function PriorityPicker({ value, onChange, id, disabled }: PriorityPickerProps) {
  return (
    <Combobox
      options={PRIORITY_PICKER_OPTIONS}
      value={value}
      onChange={onChange}
      label="Priority"
      id={id}
      disabled={disabled}
    />
  );
}
