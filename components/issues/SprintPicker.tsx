'use client';

import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import type { SprintDto } from '@/lib/dto/sprints';

// The sprint picker (Subtask 2.4.14) — the work-item detail rail's inline Sprint
// editor, modelled on AssigneePicker. A searchable Combobox over the project's
// sprints with a **Backlog** sentinel FIRST (the clear / move-home path — the
// filter's sprint-select Backlog-first precedent, NOT a generic "None"; see
// design/work-items/sprint-field.mock.html). The active sprint and PLANNED
// sprints are assignable; COMPLETED sprints are excluded from the menu, but a
// current completed value stays selected in the trigger with a "(completed)"
// secondary (the archived-option precedent). The route + service re-validate the
// sprint on write (same-project guard), so a forged id can't cross projects.

const BACKLOG = '__backlog__';

export interface SprintPickerProps {
  /** The project's sprints (the page's `sprintsService.listByProject`). */
  sprints: SprintDto[];
  /** The item's current sprintId, or null for the backlog. */
  value: string | null;
  onChange: (sprintId: string | null) => void;
  id?: string;
  disabled?: boolean;
  /** Open the picker immediately on mount (the inline-edit cell — 2.5.5). */
  autoOpen?: boolean;
  /** Fired when the picker menu closes without/after a pick (2.5.5). */
  onClose?: () => void;
  /**
   * Label for the empty / null sentinel — the FIRST row and the trigger when no
   * sprint is set. Defaults to "Backlog". The detail rail passes "None" for a
   * DONE/cancelled item (it is excluded from the backlog, so "Backlog" would be
   * inconsistent), keeping the picker value identical to the read-mode value.
   */
  emptyLabel?: string;
}

export function SprintPicker({
  sprints,
  value,
  onChange,
  id,
  disabled,
  autoOpen,
  onClose,
  emptyLabel,
}: SprintPickerProps) {
  const t = useTranslations('ui');
  // The null sentinel's label — "Backlog" by default, "None" for a terminal item
  // (the rail passes it so the picker and the read value never disagree).
  const backlogLabel = emptyLabel ?? t('sprintPicker.backlog');

  // Assignable = active + planned. A COMPLETED sprint is excluded UNLESS it is
  // the current value (so the trigger can still show it) — the archived-option
  // rule. Order: active first, then planned by sequence, then the current
  // completed one (if any) last.
  const selectable = sprints
    .filter((s) => s.state !== 'complete' || s.id === value)
    .sort((a, b) => {
      const rank = (s: SprintDto) => (s.state === 'active' ? 0 : s.state === 'planned' ? 1 : 2);
      return rank(a) - rank(b) || a.sequence - b.sequence;
    });

  const secondaryFor = (s: SprintDto): string =>
    t(
      s.state === 'active'
        ? 'sprintPicker.active'
        : s.state === 'planned'
          ? 'sprintPicker.planned'
          : 'sprintPicker.completed',
    );

  const options: ComboboxOption<string>[] = [
    { value: BACKLOG, label: backlogLabel },
    ...selectable.map((s) => ({
      value: s.id,
      label: s.name,
      secondary: secondaryFor(s),
      keywords: s.name,
    })),
  ];

  // ≥8 sprints turns the type-ahead filter on (the custom-field select / 5.3.7
  // precedent); a small set opens straight to the list.
  const searchable = options.length >= 8;

  return (
    <Combobox
      options={options}
      value={value ?? BACKLOG}
      onChange={(v) => onChange(v === BACKLOG ? null : v)}
      label={t('sprintPicker.label')}
      placeholder={backlogLabel}
      searchable={searchable}
      searchPlaceholder={t('sprintPicker.searchPlaceholder')}
      emptyText={t('sprintPicker.emptyText')}
      id={id}
      disabled={disabled}
      autoOpen={autoOpen}
      onClose={onClose}
    />
  );
}
