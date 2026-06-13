'use client';

import { useTranslations } from 'next-intl';
import { Combobox, type ComboboxOption } from '@/components/ui/Combobox';
import { WorkItemTypeIcon } from '@/components/issues/WorkItemTypeIcon';
import { WORK_ITEM_TYPES } from '@/lib/issues/executorDefaults';
import type { WorkItemTypeDto } from '@/lib/dto/workItems';

// The work-item TYPE picker (Story 2.7 · Subtask 2.7.4) — a Combobox over the
// ten fixed `WorkItemType` members, each row the type's saturated `--el-type-*`
// glyph (via WorkItemTypeIcon, mirroring the kind `TypePicker`) + its i18n
// label. NOT searchable: a fixed, closed set of ten (no type-ahead), exactly
// like the kind picker. `value` is NULLABLE — the trigger shows the "Set a
// type" placeholder when unset (design panel 2c). Consumed by the create modal
// (2.3.3) and the detail rail inline-edit cell (the 2.5.5 `autoOpen`/`onClose`
// pattern). Because the create modal is a `role="dialog"`, the Combobox renders
// its menu inline (its in-dialog branch) automatically.

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
