'use client';

import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { ISSUE_TYPE_META } from '@/lib/issues/issueTypes';
import { ISSUE_TYPES, type IssueType } from '@/lib/issues/parentRules';

// The issue-type picker (Subtask 2.3.4): a Combobox over the five types from
// 2.1.1's ISSUE_TYPE_META, each row showing the type's lucide icon (tinted with
// its design-system color token) + label. Consumed by the create-issue modal
// (2.3.3) and the edit form (2.3.6). Not searchable — five fixed options.

const TYPE_OPTIONS: ComboboxOption<IssueType>[] = ISSUE_TYPES.map((type) => {
  const meta = ISSUE_TYPE_META[type];
  const Icon = meta.icon;
  return {
    value: type,
    label: meta.label,
    icon: <Icon className="h-4 w-4" style={{ color: `var(--color-${meta.colorToken})` }} />,
  };
});

export interface TypePickerProps {
  value: IssueType;
  onChange: (value: IssueType) => void;
  id?: string;
  disabled?: boolean;
}

export function TypePicker({ value, onChange, id, disabled }: TypePickerProps) {
  return (
    <Combobox
      options={TYPE_OPTIONS}
      value={value}
      onChange={onChange}
      label="Type"
      id={id}
      disabled={disabled}
    />
  );
}
