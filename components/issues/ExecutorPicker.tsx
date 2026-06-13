'use client';

import { useTranslations } from 'next-intl';
import { Bot, User } from 'lucide-react';
import { Segmented, type SegmentedOption } from '@/components/ui/Segmented';
import type { ExecutorDto } from '@/lib/dto/workItems';

// The executor control (Story 2.7 · Subtask 2.7.4) — a two-option `Segmented`
// (`coding_agent | human`), per design/work-items/type-executor-picker.mock.html
// panels 1–2. The pressed option raises with `--el-page-bg` + `--shadow-subtle`
// and its leading glyph takes `--el-accent` (the Segmented contract). Choosing
// a type SEEDS this control from the `defaultExecutorForType` helper (the single
// source — the seeding lives in the parent surfaces, not here); the seed is not
// a lock, so the user flips it freely and the override sticks. Rendered only
// once a type is chosen (the executor follows the type).

export interface ExecutorPickerProps {
  value: ExecutorDto;
  onChange: (value: ExecutorDto) => void;
  disabled?: boolean;
  className?: string;
}

export function ExecutorPicker({ value, onChange, disabled, className }: ExecutorPickerProps) {
  const tl = useTranslations('labels');
  const tu = useTranslations('ui');
  const options: SegmentedOption<ExecutorDto>[] = [
    {
      value: 'coding_agent',
      label: tl('executor.coding_agent'),
      icon: <Bot className="h-3.5 w-3.5" aria-hidden />,
    },
    {
      value: 'human',
      label: tl('executor.human'),
      icon: <User className="h-3.5 w-3.5" aria-hidden />,
    },
  ];
  return (
    <Segmented
      options={options}
      value={value}
      onChange={onChange}
      label={tu('executorPicker.label')}
      disabled={disabled}
      className={className}
    />
  );
}
