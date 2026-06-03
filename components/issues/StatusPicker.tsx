'use client';

import { useMemo } from 'react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import type {
  WorkflowStatusDto,
  WorkflowTransitionDto,
  WorkflowPolicyModeDto,
} from '@/lib/dto/workflows';

// The status picker (Subtask 2.3.6): a Combobox over the project's workflow
// statuses, scoped to the LEGAL targets from the current status — `open` policy
// allows any status; `restricted` allows the current status plus those reachable
// by a `workflow_transition` edge. So an illegal transition isn't selectable;
// `changeStatusAction` → `updateStatus` re-validates server-side (defense in
// depth) and surfaces an inline error if a forged value slips through.

const CATEGORY_VAR: Record<string, string> = {
  todo: '--color-muted-foreground',
  in_progress: '--color-info',
  done: '--color-accent-green',
};

function statusDot(s: WorkflowStatusDto) {
  const color = s.color ?? `var(${CATEGORY_VAR[s.category] ?? '--color-muted-foreground'})`;
  return (
    <span
      aria-hidden
      className="border-border h-2.5 w-2.5 shrink-0 rounded-full border"
      style={{ backgroundColor: color }}
    />
  );
}

export interface StatusPickerProps {
  statuses: WorkflowStatusDto[];
  transitions: WorkflowTransitionDto[];
  policyMode: WorkflowPolicyModeDto;
  /** Current status key. */
  value: string;
  onChange: (statusKey: string) => void;
  error?: string | null;
  id?: string;
  disabled?: boolean;
}

export function StatusPicker({
  statuses,
  transitions,
  policyMode,
  value,
  onChange,
  error,
  id,
  disabled,
}: StatusPickerProps) {
  const options = useMemo<ComboboxOption<string>[]>(() => {
    const byKey = new Map(statuses.map((s) => [s.key, s]));
    const current = byKey.get(value);
    let allowed: WorkflowStatusDto[];
    if (policyMode === 'open') {
      allowed = statuses;
    } else {
      const currentId = current?.id;
      const reachableIds = new Set(
        transitions.filter((t) => t.fromStatusId === currentId).map((t) => t.toStatusId),
      );
      allowed = statuses.filter((s) => s.key === value || reachableIds.has(s.id));
    }
    return allowed.map((s) => ({ value: s.key, label: s.label, icon: statusDot(s) }));
  }, [statuses, transitions, policyMode, value]);

  return (
    <div className="flex flex-col gap-1">
      <Combobox
        options={options}
        value={value}
        onChange={onChange}
        label="Status"
        id={id}
        disabled={disabled}
      />
      {error ? (
        <p className="text-(--color-destructive) text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
