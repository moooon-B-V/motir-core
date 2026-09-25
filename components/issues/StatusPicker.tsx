'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { GitMerge, Lock } from 'lucide-react';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { statusDotColor } from '@/lib/workflows/statusColor';
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

function statusDot(s: WorkflowStatusDto) {
  // The dot hue routes through the swap layer via the shared `statusDotColor`
  // (per-status el-status token, full strength), so it re-skins with the palette
  // and differentiates in_review / blocked / cancelled. This dropped the old
  // Tier-0 raw-token path — the only true swap-layer violation (MOTIR-1273).
  return (
    <span
      aria-hidden
      className="border-(--el-border) h-2.5 w-2.5 shrink-0 rounded-full border"
      style={{ backgroundColor: statusDotColor(s) }}
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
  /** Open the picker immediately on mount (inline-edit cells — Subtask 2.5.5). */
  autoOpen?: boolean;
  /** Fired when the picker menu closes without/after a pick (Subtask 2.5.5). */
  onClose?: () => void;
  /**
   * The targets an approval HOLDS (MOTIR-5528; ADR `approval-gates.md` §6d rules 1
   * and 2b). Each stays in the list, locked, tagged *needs approval* (waiting on a
   * decision) or *moves on merge* (waiting on the merge) — shown so the reader
   * learns the move exists and why it is held, and never committable. Every other
   * target is unchanged.
   *
   * A PLAN hold (MOTIR-6267; `agent-authored-plans.md` AMENDMENT 21) locks every
   * target but the current one, each tagged *held by plan*.
   */
  held?: ReadonlyArray<{ statusKey: string; waitingOn: 'decision' | 'merge' | 'plan' }>;
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
  autoOpen,
  onClose,
  held,
}: StatusPickerProps) {
  const t = useTranslations('ui');
  const tHeld = useTranslations('approvalGate.statusHeld');
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
    return allowed.map((s) => {
      const hold = held?.find((h) => h.statusKey === s.key);
      if (!hold) return { value: s.key, label: s.label, icon: statusDot(s) };
      const Glyph = hold.waitingOn === 'merge' ? GitMerge : Lock;
      return {
        value: s.key,
        label: s.label,
        icon: statusDot(s),
        disabled: true,
        trailing: (
          <span
            data-held-tag={hold.waitingOn}
            className="inline-flex items-center gap-1 text-xs text-(--el-text-secondary)"
          >
            <Glyph aria-hidden className="h-3 w-3" />
            {tHeld(
              hold.waitingOn === 'merge'
                ? 'movesOnMerge'
                : hold.waitingOn === 'plan'
                  ? 'planHeldOption'
                  : 'needsApproval',
            )}
          </span>
        ),
      };
    });
  }, [statuses, transitions, policyMode, value, held, tHeld]);

  return (
    <div className="flex flex-col gap-1">
      <Combobox
        options={options}
        value={value}
        onChange={onChange}
        label={t('statusPicker.label')}
        id={id}
        disabled={disabled}
        autoOpen={autoOpen}
        onClose={onClose}
      />
      {error ? (
        <p className="text-(--el-danger) text-xs" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
