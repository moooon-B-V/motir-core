'use client';

import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { WorkItemTypeIcon } from '@/components/issues/WorkItemTypeIcon';
import { WORK_ITEM_TYPE_GROUP } from '@/lib/issues/workItemTypeMeta';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
import type { WorkItemTypeDto } from '@/lib/dto/workItems';

// The work-item TYPE picker (Story 2.7 · Subtask 2.7.4) — a Combobox over the
// fixed `WorkItemType` members, each row the type's saturated `--el-type-*`
// glyph (via WorkItemTypeIcon, mirroring the kind `TypePicker`) + its i18n
// label. NOT searchable: a fixed, closed set (no type-ahead), exactly
// like the kind picker. `value` is NULLABLE — the trigger shows the "Set a
// type" placeholder when unset (design panel 2c). Consumed by the create modal
// (2.3.3) and the detail rail inline-edit cell (the 2.5.5 `autoOpen`/`onClose`
// pattern). Because the create modal is a `role="dialog"`, the Combobox renders
// its menu inline (its in-dialog branch) automatically.
//
// ── GROUPED at fourteen (MOTIR-2633, to MOTIR-2631's measurement) ───────────
// The set grew from ten to fourteen (ADR Amendment 1 / MOTIR-2629), and the
// design MEASURED what that does rather than guessing: the Combobox listbox is
// capped at 256px in BOTH hosts (`max-h-64`, and `Math.min(256, avail - 12)` on
// the in-dialog branch), so the list length cannot raise it. Ten rows already
// overflowed by 32px; at fourteen the visible window is still 8 rows while the
// hidden fraction goes 14% -> 51%.
//
// So NO scroll container is added — there already is one, and a second would be
// a bug. What the row count justifies is the GROUPING: `ComboboxOption.group`
// already renders a non-interactive `role="presentation"` header at each group
// transition, and keyboard nav is unaffected because a header is not an option
// row. The four groups are CONTIGUOUS RUNS of the amendment's single canonical
// order, never a second ordering — a consumer that ignored `group` entirely
// would still render the same sequence, which is why the order below is just
// `WORK_ITEM_TYPES` walked start to finish.

export interface WorkItemTypePickerProps {
  value: WorkItemTypeDto | null;
  onChange: (value: WorkItemTypeDto) => void;
  id?: string;
  disabled?: boolean;
  /** Open the picker immediately on mount (inline-edit cells — Subtask 2.5.5). */
  autoOpen?: boolean;
  /** Fired when the picker menu closes without/after a pick (Subtask 2.5.5). */
  onClose?: () => void;
}

export function WorkItemTypePicker({
  value,
  onChange,
  id,
  disabled,
  autoOpen,
  onClose,
}: WorkItemTypePickerProps) {
  const tl = useTranslations('labels');
  const tu = useTranslations('ui');
  const options: ComboboxOption<WorkItemTypeDto>[] = WORK_ITEM_TYPES.map((type) => ({
    value: type,
    label: tl(`workItemType.${type}`),
    icon: <WorkItemTypeIcon type={type} className="h-4 w-4" />,
    group: tl(`workItemTypeGroup.${WORK_ITEM_TYPE_GROUP[type]}`),
  }));
  return (
    <Combobox
      options={options}
      value={value}
      onChange={onChange}
      label={tu('workItemTypePicker.label')}
      placeholder={tu('workItemTypePicker.placeholder')}
      id={id}
      disabled={disabled}
      autoOpen={autoOpen}
      onClose={onClose}
    />
  );
}
