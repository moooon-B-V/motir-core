'use client';

import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import type { WorkspaceMemberDTO } from '@/lib/dto/workspaces';

// The assignee picker (Subtask 2.3.6): a searchable Combobox over the
// workspace's members + an "Unassigned" first option. Resolves finding #51's
// assignee deferral. The service re-checks membership on write
// (assertAssigneeMember), so a forged id can't assign a non-member.

const NONE = '__none__';

export interface AssigneePickerProps {
  members: WorkspaceMemberDTO[];
  /** Selected assignee userId, or null for Unassigned. */
  value: string | null;
  onChange: (userId: string | null) => void;
  id?: string;
  disabled?: boolean;
}

export function AssigneePicker({ members, value, onChange, id, disabled }: AssigneePickerProps) {
  const options: ComboboxOption<string>[] = [
    { value: NONE, label: 'Unassigned' },
    ...members.map((m) => ({
      value: m.userId,
      label: m.name,
      secondary: m.email,
      keywords: m.email,
    })),
  ];

  return (
    <Combobox
      options={options}
      value={value ?? NONE}
      onChange={(v) => onChange(v === NONE ? null : v)}
      label="Assignee"
      placeholder="Unassigned"
      searchable
      searchPlaceholder="Search members…"
      emptyText="No members"
      id={id}
      disabled={disabled}
    />
  );
}
